import Foundation
import Network

/// Транспорт кадров нативного захвата к странице: WebSocket на 127.0.0.1:<случайный порт>.
///
/// Почему не JSON-мост WKScriptMessageHandler: кадры — это мегабайты в секунду бинарных
/// данных, а `evaluateJavaScript` гонит всё строкой через главный поток. WebSocket к
/// 127.0.0.1 в WKWebView держит 278+ МБ/с (проба 2026-11-12) и приходит в страницу
/// `ArrayBuffer`-ом без перекодирования.
///
/// Защита (сервер слушает только loopback, но к нему может постучаться любой локальный
/// процесс и любая открытая в браузере страница):
/// * `Origin` рукопожатия обязан быть `http://localhost` (документ приложения грузится
///   `loadHTMLString(baseURL: http://localhost)`) — чужие сайты в браузере отсекаются тут;
/// * первым сообщением страница шлёт `{"hello":"<token>"}` — токен случайный на запуск,
///   известен только user-скрипту основного фрейма (`window.__ZALI_MEDIA_BRIDGE`), в URL
///   и в журнал не попадает. Без верного токена за 5 с соединение закрывается;
/// * активное соединение одно. Новое вытесняет старое только после проверки токена
///   (перезагрузка страницы), до этого старое продолжает получать кадры.
final class MediaBridgeServer {
    static let expectedOrigin = "http://localhost"

    let token: String
    private(set) var port: UInt16 = 0

    /// Вызывается (на `queue`), когда активное соединение пропало: захваты надо гасить —
    /// страница без транспорта всё равно закрывает свои потоки.
    var onActiveLost: (() -> Void)?
    /// Новое активное соединение (после проверки токена).
    var onActiveReady: (() -> Void)?

    private let queue = DispatchQueue(label: "com.zali.messenger.media.bridge", qos: .userInteractive)
    private var listener: NWListener?
    private var active: NWConnection?
    private var pending: [ObjectIdentifier: NWConnection] = [:]
    private var inFlightBytes = 0
    private let inFlightLock = NSLock()

    /// Сколько байт может висеть неотправленными, прежде чем видео начнёт пропускать
    /// кадры (звук не пропускается никогда). 8 МБ — ~2 с 1080p-потока с запасом.
    static let congestionLimit = 8 * 1024 * 1024

    init() {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        token = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    var url: String { "ws://127.0.0.1:\(port)/media" }

    /// Поднимает слушатель синхронно (ждёт `.ready` не дольше 2 с) — порт нужен до
    /// создания WKWebView, он уходит в user-скрипт. false — моста не будет, веб
    /// останется на getUserMedia.
    func start() -> Bool {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 64 * 1024 * 1024
        ws.setClientRequestHandler(queue) { _, headers in
            let origin = headers.first { $0.name.lowercased() == "origin" }?.value ?? ""
            if origin != MediaBridgeServer.expectedOrigin {
                mediaLog("bridge: handshake rejected origin=\(origin.isEmpty ? "<none>" : origin)")
                return NWProtocolWebSocket.Response(status: .reject, subprotocol: nil)
            }
            return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
        }
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        params.acceptLocalOnly = true
        params.allowLocalEndpointReuse = true

        let listener: NWListener
        do {
            listener = try NWListener(using: params)
        } catch {
            mediaLog("bridge: listener create failed \(error)")
            return false
        }
        let ready = DispatchSemaphore(value: 0)
        var ok = false
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.port = listener.port?.rawValue ?? 0
                ok = (self?.port ?? 0) != 0
                ready.signal()
            case .failed(let error):
                mediaLog("bridge: listener failed \(error)")
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.start(queue: queue)
        self.listener = listener
        _ = ready.wait(timeout: .now() + 2)
        if !ok {
            listener.cancel()
            self.listener = nil
            return false
        }
        mediaLog("bridge: listening on 127.0.0.1:\(port)")
        return true
    }

    private func accept(_ conn: NWConnection) {
        // Только loopback: requiredLocalEndpoint уже это гарантирует, но удалённая
        // сторона тоже обязана быть локальной.
        if case let .hostPort(host, _) = conn.endpoint {
            let h = "\(host)"
            if !(h == "127.0.0.1" || h == "::1" || h.hasPrefix("127.")) {
                conn.cancel()
                return
            }
        }
        let id = ObjectIdentifier(conn)
        pending[id] = conn
        conn.stateUpdateHandler = { [weak self, weak conn] state in
            guard let self, let conn else { return }
            switch state {
            case .failed, .cancelled:
                self.pending.removeValue(forKey: ObjectIdentifier(conn))
                if self.active === conn {
                    self.active = nil
                    self.inFlightLock.lock(); self.inFlightBytes = 0; self.inFlightLock.unlock()
                    mediaLog("bridge: active connection closed")
                    self.onActiveLost?()
                }
            default:
                break
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 5) { [weak self, weak conn] in
            guard let self, let conn else { return }
            if self.pending[ObjectIdentifier(conn)] != nil {
                mediaLog("bridge: no hello within 5 s, closing")
                self.pending.removeValue(forKey: ObjectIdentifier(conn))
                conn.cancel()
            }
        }
        receive(conn)
    }

    private func receive(_ conn: NWConnection) {
        conn.receiveMessage { [weak self, weak conn] content, context, _, error in
            guard let self, let conn else { return }
            if error != nil { conn.cancel(); return }
            let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if meta?.opcode == .close { conn.cancel(); return }
            let id = ObjectIdentifier(conn)
            if self.pending[id] != nil {
                guard meta?.opcode == .text, let content, self.checkHello(content) else {
                    mediaLog("bridge: bad hello, closing")
                    self.pending.removeValue(forKey: id)
                    conn.cancel()
                    return
                }
                self.pending.removeValue(forKey: id)
                let previous = self.active
                self.active = conn
                self.inFlightLock.lock(); self.inFlightBytes = 0; self.inFlightLock.unlock()
                if let previous {
                    mediaLog("bridge: new page connection replaces the previous one")
                    previous.stateUpdateHandler = nil
                    previous.cancel()
                    self.onActiveLost?()
                }
                mediaLog("bridge: page connected")
                self.onActiveReady?()
            }
            // Дальше страница ничего не шлёт; читаем, чтобы заметить закрытие.
            self.receive(conn)
        }
    }

    private func checkHello(_ data: Data) -> Bool {
        guard data.count < 1024,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hello = obj["hello"] as? String else { return false }
        // Сравнение без раннего выхода.
        let a = Array(hello.utf8), b = Array(token.utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    var isConnected: Bool { queue.sync { active != nil } }

    /// Байт в очереди отправки — видео пропускает кадры выше `congestionLimit`.
    var congested: Bool {
        inFlightLock.lock(); defer { inFlightLock.unlock() }
        return inFlightBytes > MediaBridgeServer.congestionLimit
    }

    /// Отправить кадр. Потокобезопасно.
    func send(_ data: Data) {
        let size = data.count
        inFlightLock.lock(); inFlightBytes += size; inFlightLock.unlock()
        queue.async { [weak self] in
            guard let self else { return }
            guard let conn = self.active else {
                self.inFlightLock.lock(); self.inFlightBytes = max(0, self.inFlightBytes - size); self.inFlightLock.unlock()
                return
            }
            let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
            let ctx = NWConnection.ContentContext(identifier: "frame", metadata: [meta])
            conn.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { [weak self] _ in
                guard let self else { return }
                self.inFlightLock.lock(); self.inFlightBytes = max(0, self.inFlightBytes - size); self.inFlightLock.unlock()
            })
        }
    }

    func stop() {
        queue.sync {
            listener?.cancel()
            listener = nil
            active?.cancel()
            active = nil
            for c in pending.values { c.cancel() }
            pending.removeAll()
        }
    }
}
