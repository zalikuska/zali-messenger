import AppKit
import Foundation
import Network
import WebKit

/// Управление приложением из терминала (scripts/zali_ctl.py): локальный HTTP-вход на
/// 127.0.0.1 с токеном. Включается в Настройках → «Для разработчиков» → «Управление из
/// терминала» (CONTROL_REQUEST), по умолчанию выключен. Зеркало Windows —
/// apps/windows/src/native/control.rs; команды исполняет страница
/// (web/src/interface/control.js, `window.__zaliControl`).
///
/// Защита:
/// * слушаем только loopback (`acceptLocalOnly`, адрес 127.0.0.1);
/// * каждый запрос несёт `Authorization: Bearer <token>`; токен создаёт и хранит эта
///   оболочка (control.json рядом с остальными данными, права 0600), сравнение без
///   раннего выхода; «Новый токен» в настройках сразу отсекает прежних клиентов;
/// * запросы с заголовком `Origin` (любая веб-страница в браузере) и с чужим `Host`
///   (DNS rebinding) отклоняются до проверки токена.
///
/// Маршруты: `GET /ping`, `POST /cmd` `{cmd, args, timeoutMs?}` → JSON ответа страницы,
/// `GET /snapshot` → PNG окна, `POST /window` `{action: show|hide}`.
final class ControlServer {
    static let shared = ControlServer()

    /// Исполнитель команд страницы; ставит WebView.makeWebView. Вызывается на главном потоке.
    var runCommand: ((_ cmd: String, _ argsJSON: String, _ done: @escaping (String) -> Void) -> Void)?
    /// Снимок окна в PNG; ставит WebView.makeWebView. Главный поток.
    var snapshot: ((_ done: @escaping (Data?) -> Void) -> Void)?
    var log: ((String) -> Void)?

    private let queue = DispatchQueue(label: "com.zali.messenger.control", qos: .userInitiated)
    private var listener: NWListener?
    private var config = Config()
    private var running = false
    private var lastError = ""

    private struct Config: Codable {
        var enabled = false
        var token = ""
        var port: UInt16 = 0
    }

    private static var configURL: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("ZaliMessenger", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("control.json")
    }

    private func write(_ line: String) { log?("[CONTROL] \(line)") }

    /// При запуске приложения: поднять вход, если он был включён.
    func startIfEnabled() {
        queue.sync {
            loadConfig()
            if config.enabled { startLocked() }
        }
    }

    /// CONTROL_REQUEST из настроек. Возвращает состояние для карточки.
    func handle(op: String) -> [String: Any] {
        queue.sync {
            loadConfig()
            switch op {
            case "enable":
                config.enabled = true
                if config.token.isEmpty { config.token = Self.newToken() }
                saveConfig()
                if !running { startLocked() }
                write("enabled port=\(config.port)")
            case "disable":
                config.enabled = false
                saveConfig()
                stopLocked()
                write("disabled")
            case "rotate":
                config.token = Self.newToken()
                saveConfig()
                write("token rotated")
            default:
                break
            }
            return statusLocked()
        }
    }

    private func statusLocked() -> [String: Any] {
        var out: [String: Any] = [
            "enabled": config.enabled,
            "running": running,
            "port": Int(config.port),
            "platform": "macos",
        ]
        if config.enabled && running && !config.token.isEmpty {
            out["token"] = config.token
            out["url"] = "zalictl://\(config.token)@127.0.0.1:\(config.port)"
        }
        if !lastError.isEmpty { out["error"] = lastError }
        return out
    }

    private func loadConfig() {
        guard let url = Self.configURL, let data = try? Data(contentsOf: url),
              let parsed = try? JSONDecoder().decode(Config.self, from: data) else { return }
        config = parsed
    }

    private func saveConfig() {
        guard let url = Self.configURL, let data = try? JSONEncoder().encode(config) else { return }
        do {
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            write("config save failed: \(error.localizedDescription)")
        }
    }

    private static func newToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - Listener

    private func startLocked() {
        stopLocked()
        if config.token.isEmpty {
            config.token = Self.newToken()
            saveConfig()
        }
        // Порт постоянный, чтобы строка подключения пережила перезапуск; занят — новый.
        for attempt in 0..<2 {
            let port: NWEndpoint.Port = (attempt == 0 && config.port != 0) ? (NWEndpoint.Port(rawValue: config.port) ?? .any) : .any
            if let listener = makeListener(port: port) {
                self.listener = listener
                running = true
                lastError = ""
                if let actual = listener.port?.rawValue, actual != config.port {
                    config.port = actual
                    saveConfig()
                }
                write("listening on 127.0.0.1:\(config.port)")
                return
            }
        }
        running = false
        lastError = "не удалось открыть порт"
        write("listen failed")
    }

    private func makeListener(port: NWEndpoint.Port) -> NWListener? {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        params.acceptLocalOnly = true
        params.allowLocalEndpointReuse = true
        guard let listener = try? NWListener(using: params) else { return nil }
        let ready = DispatchSemaphore(value: 0)
        var ok = false
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ok = true; ready.signal()
            case .failed, .cancelled: ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.start(queue: DispatchQueue(label: "com.zali.messenger.control.listener"))
        if ready.wait(timeout: .now() + 2) == .timedOut || !ok {
            listener.cancel()
            return nil
        }
        listener.stateUpdateHandler = { [weak self] state in
            if case .failed(let error) = state { self?.write("listener failed: \(error)") }
        }
        return listener
    }

    private func stopLocked() {
        listener?.cancel()
        listener = nil
        running = false
    }

    // MARK: - HTTP

    private struct Request {
        var method = ""
        var path = ""
        var headers: [String: String] = [:]
        var body = Data()
    }

    private static let maxRequestBytes = 4 * 1024 * 1024

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { conn.cancel(); return }
            var buf = buffer
            if let data { buf.append(data) }
            if buf.count > Self.maxRequestBytes {
                self.respond(conn, status: 413, json: ["ok": false, "error": "request too large"])
                return
            }
            if let request = Self.parse(buf) {
                self.route(conn, request)
                return
            }
            if isComplete || error != nil { conn.cancel(); return }
            self.receive(conn, buffer: buf)
        }
    }

    /// nil — запрос ещё не дочитан.
    private static func parse(_ data: Data) -> Request? {
        guard let headEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = String(data: data[data.startIndex..<headEnd.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else { return Request(method: "BAD") }
        var req = Request(method: String(first[0]), path: String(first[1]))
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            req.headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(req.headers["content-length"] ?? "0") ?? 0
        let bodyStart = headEnd.upperBound
        if data.count - bodyStart < length { return nil }
        req.body = data[bodyStart..<(bodyStart + length)]
        return req
    }

    private static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = UInt8(x.count == y.count ? 0 : 1)
        for i in 0..<max(x.count, y.count) {
            diff |= (i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0)
        }
        return diff == 0 && !y.isEmpty
    }

    private func route(_ conn: NWConnection, _ req: Request) {
        if req.headers["origin"] != nil {
            respond(conn, status: 403, json: ["ok": false, "error": "browser requests are not allowed"])
            return
        }
        let host = (req.headers["host"] ?? "").lowercased()
        if host != "127.0.0.1:\(config.port)" && host != "localhost:\(config.port)" {
            respond(conn, status: 403, json: ["ok": false, "error": "bad host"])
            return
        }
        let auth = req.headers["authorization"] ?? ""
        let presented = auth.hasPrefix("Bearer ") ? String(auth.dropFirst(7)) : ""
        guard config.enabled, Self.constantTimeEqual(presented, config.token) else {
            write("rejected \(req.method) \(req.path): bad token")
            respond(conn, status: 401, json: ["ok": false, "error": "bad token"])
            return
        }
        let path = req.path.components(separatedBy: "?").first ?? req.path
        switch (req.method, path) {
        case ("GET", "/ping"):
            let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0"
            respond(conn, status: 200, json: ["ok": true, "platform": "macos", "version": version, "pid": Int(getpid())])
        case ("POST", "/cmd"):
            let body = (try? JSONSerialization.jsonObject(with: req.body)) as? [String: Any] ?? [:]
            let cmd = (body["cmd"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            let args = body["args"] ?? [String: Any]()
            let argsJSON = zaliJSONString(args, options: [.fragmentsAllowed]) ?? "{}"
            let timeout = min(max((body["timeoutMs"] as? NSNumber)?.doubleValue ?? 60000, 500), 600000) / 1000
            write("cmd \(cmd)")
            runOnPage(cmd: cmd, argsJSON: argsJSON, timeout: timeout) { [weak self] json in
                self?.respond(conn, status: 200, raw: Data(json.utf8), type: "application/json")
            }
        case ("GET", "/snapshot"):
            DispatchQueue.main.async { [weak self] in
                guard let snap = self?.snapshot else {
                    self?.respond(conn, status: 503, json: ["ok": false, "error": "no window"])
                    return
                }
                snap { png in
                    guard let self else { return }
                    if let png { self.respond(conn, status: 200, raw: png, type: "image/png") }
                    else { self.respond(conn, status: 500, json: ["ok": false, "error": "snapshot failed"]) }
                }
            }
        case ("POST", "/window"):
            let body = (try? JSONSerialization.jsonObject(with: req.body)) as? [String: Any] ?? [:]
            let action = body["action"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in
                switch action {
                case "show":
                    if NSApp.isHidden { NSApp.unhide(nil) }
                    NSApp.windows.first { $0.contentView != nil && $0.canBecomeMain }?.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                case "hide":
                    NSApp.hide(nil)
                default:
                    self?.respond(conn, status: 400, json: ["ok": false, "error": "action: show|hide"])
                    return
                }
                self?.respond(conn, status: 200, json: ["ok": true])
            }
        default:
            respond(conn, status: 404, json: ["ok": false, "error": "routes: GET /ping, POST /cmd, GET /snapshot, POST /window"])
        }
    }

    private func runOnPage(cmd: String, argsJSON: String, timeout: TimeInterval, done: @escaping (String) -> Void) {
        let lock = NSLock()
        var finished = false
        let finish: (String) -> Void = { json in
            lock.lock()
            let first = !finished
            finished = true
            lock.unlock()
            if first { done(json) }
        }
        queue.asyncAfter(deadline: .now() + timeout) {
            finish(#"{"ok":false,"error":"timeout"}"#)
        }
        DispatchQueue.main.async { [weak self] in
            guard let run = self?.runCommand else {
                finish(#"{"ok":false,"error":"page not ready"}"#)
                return
            }
            run(cmd, argsJSON, finish)
        }
    }

    private func respond(_ conn: NWConnection, status: Int, json: [String: Any]) {
        let data = zaliJSONData(json) ?? Data("{}".utf8)
        respond(conn, status: status, raw: data, type: "application/json")
    }

    private func respond(_ conn: NWConnection, status: Int, raw: Data, type: String) {
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large", 500: "Internal Server Error", 503: "Service Unavailable"][status] ?? "Status"
        var out = Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(raw.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
        out.append(raw)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}

extension WebView {
    /// Подключает ControlServer к этому вебвью (команды, снимок) и поднимает вход, если
    /// он включён в настройках.
    static func attachControlServer(to webView: WKWebView) {
        let control = ControlServer.shared
        control.log = { line in Coordinator.appendDebugLog(line) }
        control.runCommand = { [weak webView] cmd, argsJSON, done in
            guard let webView else { done(#"{"ok":false,"error":"no webview"}"#); return }
            let script = """
            const fn = window.__zaliControl;
            if (typeof fn !== 'function') return JSON.stringify({ ok: false, error: 'page not ready' });
            return JSON.stringify(await fn(cmd, JSON.parse(args)));
            """
            webView.callAsyncJavaScript(script, arguments: ["cmd": cmd, "args": argsJSON], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    done((value as? String) ?? #"{"ok":false,"error":"empty result"}"#)
                case .failure(let error):
                    let message = WebView.javascriptLiteral(error.localizedDescription)
                    done("{\"ok\":false,\"error\":\(message)}")
                }
            }
        }
        control.snapshot = { [weak webView] done in
            guard let webView else { done(nil); return }
            webView.takeSnapshot(with: nil) { image, _ in
                guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { done(nil); return }
                done(rep.representation(using: .png, properties: [:]))
            }
        }
        control.startIfEnabled()
    }
}
