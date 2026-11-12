import Foundation
import AVFoundation
import CoreAudio

/// Нативный захват микрофона, камеры и экрана для страницы
/// (.claude/skills/voice-calls/native-capture.md; веб — web/src/interface/native_media.js).
///
/// Управление — `MEDIA_REQUEST {op, requestId?, stream?, kind?, deviceId?, sourceId?, options?}`
/// из WKScriptMessageHandler, ответы и события — `media_event` на шине страницы
/// (`emit`). Кадры — `MediaBridgeServer` (WebSocket на 127.0.0.1).
///
/// Состояние живёт на `queue`; `emit` зовётся с любого потока, приложение само
/// переносит его на главный.
final class MediaController {
    static let shared = MediaController()

    let bridge = MediaBridgeServer()
    private(set) var bridgeReady = false

    /// Отправить `media_event` странице: JSON-текст объекта и (необязательно) блок,
    /// который надо вызвать, когда страница его обработала.
    var emit: ((String, (() -> Void)?) -> Void)?

    private let queue = DispatchQueue(label: "com.zali.messenger.media.controller", qos: .userInitiated)

    private enum Entry {
        case mic(MicCapture)
        case camera(CameraHub)
        case screen(ScreenCapture)
        case starting(String)
    }

    private var entries: [UInt32: Entry] = [:]
    private var hubs: [String: CameraHub] = [:]
    private var processing = (aec: true, ns: true, agc: true)
    private var statsTimer: DispatchSourceTimer?
    private var devicesListener: AudioPropertyListener?
    private var defaultInputListener: AudioPropertyListener?
    private var deviceObservers: [NSObjectProtocol] = []
    private var devicesChangedPending = false
    private var keyframeRequests = 0

    /// Поднимает транспорт кадров. Звать до создания WKWebView (порт уходит в user-скрипт).
    @discardableResult
    func startBridge() -> Bool {
        if bridgeReady { return true }
        bridgeReady = bridge.start()
        guard bridgeReady else { return false }
        bridge.onActiveLost = { [weak self] in
            self?.queue.async { self?.stopAll(reason: "transport-closed", notify: false) }
        }
        queue.async { self.watchDevices() }
        return true
    }

    /// `window.__ZALI_MEDIA_BRIDGE = {...}` для user-скрипта основного фрейма, или nil.
    var bridgeBootstrapScript: String? {
        guard bridgeReady,
              let json = zaliJSONString(["kind": "websocket", "url": bridge.url, "token": bridge.token]) else { return nil }
        return "window.__ZALI_MEDIA_BRIDGE = \(json);"
    }

    /// Флаги для `__ZALI_NATIVE_CAPS__` — только реализованное и только при живом мосте.
    var capabilities: [String: Bool] {
        guard bridgeReady else { return [:] }
        return ["nativeMic": true, "nativeCamera": true, "nativeScreen": true, "nativeScreenAudio": true]
    }

    // MARK: - Запросы

    func handle(_ dict: [String: Any]) {
        let op = dict["op"] as? String ?? ""
        let requestId = dict["requestId"] as? String
        let stream = (dict["stream"] as? NSNumber)?.uint32Value ?? 0
        let options = dict["options"] as? [String: Any] ?? [:]
        let deviceId = dict["deviceId"] as? String ?? ""
        let sourceId = dict["sourceId"] as? String ?? ""
        let kind = dict["kind"] as? String ?? ""
        if op != "request_keyframe" {
            // deviceId — укороченный: в журнале достаточно отличить устройства.
            mediaLog("request op=\(op) stream=\(stream) kind=\(kind) device=\(deviceId.prefix(12)) source=\(sourceId) options=\(options)")
        }
        queue.async { [self] in
            switch op {
            case "list_devices":
                listDevices(requestId: requestId)
            case "list_screen_sources":
                let thumb = (options["thumbWidth"] as? NSNumber)?.intValue ?? 320
                Task {
                    do {
                        let began = Date()
                        let sources = try await ScreenSources.list(thumbWidth: thumb)
                        let thumbs = sources.filter { $0["thumb"] != nil }.count
                        mediaLog("screen sources: \(sources.count) (thumbs \(thumbs)) in \(Int(Date().timeIntervalSince(began) * 1000)) ms")
                        self.reply(requestId, ["event": "screen_sources", "sources": sources])
                    } catch {
                        self.fail(requestId, stream: nil, error)
                    }
                }
            case "start":
                start(stream: stream, kind: kind, deviceId: deviceId, sourceId: sourceId, options: options, requestId: requestId)
            case "stop":
                stop(stream: stream, reason: "page", notify: false)
            case "set_processing":
                let aec = options["aec"] as? Bool ?? processing.aec
                let ns = options["ns"] as? Bool ?? processing.ns
                let agc = options["agc"] as? Bool ?? processing.agc
                processing = (aec, ns, agc)
                for case let .mic(mic) in entries.values { mic.setProcessing(aec: aec, ns: ns, agc: agc) }
                if let requestId { reply(requestId, ["event": "processing", "aec": aec, "ns": ns, "agc": agc]) }
            case "request_keyframe":
                keyframeRequests += 1
                switch entries[stream] {
                case .camera(let hub): hub.requestKeyframe(stream)
                case .screen(let screen): screen.requestKeyframe()
                default: break
                }
            default:
                fail(requestId, stream: nil, MediaError.unsupported("неизвестная операция \(op)"))
            }
        }
    }

    private func listDevices(requestId: String?) {
        let defaultInput = AudioDevices.defaultInput()
        let audio: [[String: Any]] = AudioDevices.inputDevices().map {
            ["id": $0.uid, "label": $0.name, "isDefault": $0.id == defaultInput]
        }
        let defaultVideo = AVCaptureDevice.default(for: .video)?.uniqueID
        let video: [[String: Any]] = CameraHub.videoDevices().map {
            ["id": $0.uniqueID, "label": $0.localizedName, "isDefault": $0.uniqueID == defaultVideo]
        }
        reply(requestId, ["event": "devices", "audioinput": audio, "videoinput": video])
    }

    private func start(stream: UInt32, kind: String, deviceId: String, sourceId: String, options: [String: Any], requestId: String?) {
        guard stream != 0 else { return fail(requestId, stream: nil, MediaError.failed("нет номера потока")) }
        guard entries[stream] == nil else { return fail(requestId, stream: stream, MediaError.busy("поток \(stream) уже открыт")) }
        entries[stream] = .starting(kind)
        switch kind {
        case "mic":
            authorize(.audio) { granted, late in
                self.queue.async {
                    guard case .starting = self.entries[stream] else { return }
                    if granted && late {
                        self.entries.removeValue(forKey: stream)
                        return self.fail(requestId, stream: stream, MediaError.failed("доступ к микрофону выдан после таймаута запроса"))
                    }
                    guard granted else {
                        self.entries.removeValue(forKey: stream)
                        return self.fail(requestId, stream: stream, MediaError.permission("нет доступа к микрофону (Системные настройки → Конфиденциальность → Микрофон)"))
                    }
                    self.startMic(stream: stream, deviceId: deviceId, options: options, requestId: requestId)
                }
            }
        case "camera":
            authorize(.video) { granted, late in
                self.queue.async {
                    guard case .starting = self.entries[stream] else { return }
                    if granted && late {
                        self.entries.removeValue(forKey: stream)
                        return self.fail(requestId, stream: stream, MediaError.failed("доступ к камере выдан после таймаута запроса"))
                    }
                    guard granted else {
                        self.entries.removeValue(forKey: stream)
                        return self.fail(requestId, stream: stream, MediaError.permission("нет доступа к камере (Системные настройки → Конфиденциальность → Камера)"))
                    }
                    self.startCamera(stream: stream, deviceId: deviceId, options: options, requestId: requestId)
                }
            }
        case "screen":
            startScreen(stream: stream, sourceId: sourceId, options: options, requestId: requestId)
        default:
            entries.removeValue(forKey: stream)
            fail(requestId, stream: stream, MediaError.unsupported("неизвестный вид \(kind)"))
        }
    }

    /// TCC-доступ. `late` — пользователь ответил на системный запрос позже, чем страница
    /// ждёт `started` (10 с): она уже закрыла поток и ушла в getUserMedia, и открывать
    /// устройство сейчас — значит оставить его включённым без хозяина.
    private func authorize(_ type: AVMediaType, _ done: @escaping (_ granted: Bool, _ late: Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized:
            done(true, false)
        case .notDetermined:
            let asked = Date()
            AVCaptureDevice.requestAccess(for: type) { granted in
                done(granted, Date().timeIntervalSince(asked) > 8)
            }
        default:
            done(false, false)
        }
    }

    private func startMic(stream: UInt32, deviceId: String, options: [String: Any], requestId: String?) {
        // options.processing: bool (вся обработка) или {aec, ns, agc}.
        var p = processing
        if let on = options["processing"] as? Bool {
            p = (on, on, on)
        } else if let obj = options["processing"] as? [String: Any] {
            p = (obj["aec"] as? Bool ?? p.aec, obj["ns"] as? Bool ?? p.ns, obj["agc"] as? Bool ?? p.agc)
        }
        let mic = MicCapture(stream: stream, deviceUID: deviceId, processing: p, bridge: bridge)
        mic.onEnded = { [weak self] reason in
            self?.queue.async { self?.stop(stream: stream, reason: reason, notify: true) }
        }
        do {
            try mic.start()
        } catch {
            entries.removeValue(forKey: stream)
            mic.stop()
            return fail(requestId, stream: stream, error)
        }
        entries[stream] = .mic(mic)
        ensureStatsTimer()
        reply(requestId, ["event": "started", "stream": stream, "codec": "pcm-f32-48000",
                          "label": mic.deviceName, "deviceId": mic.deviceUID])
    }

    private func startCamera(stream: UInt32, deviceId: String, options: [String: Any], requestId: String?) {
        let device: AVCaptureDevice?
        if deviceId.isEmpty {
            device = AVCaptureDevice.default(for: .video) ?? CameraHub.videoDevices().first
        } else {
            device = AVCaptureDevice(uniqueID: deviceId)
        }
        guard let device else {
            entries.removeValue(forKey: stream)
            return fail(requestId, stream: stream, MediaError.notFound("камера \(deviceId.isEmpty ? "по умолчанию" : deviceId) не найдена"))
        }
        let width = (options["width"] as? NSNumber)?.intValue ?? 1280
        let height = (options["height"] as? NSNumber)?.intValue ?? 720
        let fps = (options["fps"] as? NSNumber)?.intValue ?? 30
        let hub = hubs[device.uniqueID] ?? CameraHub(device: device)
        hubs[device.uniqueID] = hub
        do {
            let src = try hub.prepare(width: width, height: height, fps: fps)
            let (w, h) = fitVideoSize(sourceWidth: src.width, sourceHeight: src.height, maxWidth: width, maxHeight: height)
            let encoder = try H264Encoder(width: w, height: h, fps: fps, bitsPerPixel: 0.1)
            let sender = VideoStreamSender(stream: stream, bridge: bridge)
            sender.encoder = encoder
            // Отправителя держит энкодер (а энкодер — подписчик камеры); обратная ссылка
            // sender.encoder слабая, цикла нет.
            encoder.onOutput = { out in sender.deliver(out) }
            let label = device.localizedName
            let uid = device.uniqueID
            sender.onFirstKeyframe = { [weak self, weak encoder] in
                self?.queue.async {
                    guard let self, case .camera = self.entries[stream] else { return }
                    self.reply(requestId, ["event": "started", "stream": stream, "codec": encoder?.currentCodec ?? "",
                                           "label": label, "deviceId": uid, "width": w, "height": h]) {
                        sender.openGate()
                    }
                }
            }
            try hub.add(CameraHub.Subscriber(stream: stream, encoder: encoder, width: w, height: h, fps: fps, sender: sender) { [weak self] reason in
                self?.queue.async { self?.stop(stream: stream, reason: reason, notify: true) }
            })
            entries[stream] = .camera(hub)
            ensureStatsTimer()
            mediaLog("camera: stream=\(stream) device=\(label) encode \(w)x\(h)@\(fps) from \(src.width)x\(src.height)")
            failIfNoFrame(stream: stream, requestId: requestId, sender: sender, seconds: 8)
        } catch {
            entries.removeValue(forKey: stream)
            if hub.isEmpty { hub.remove(stream); hubs.removeValue(forKey: device.uniqueID) }
            fail(requestId, stream: stream, error)
        }
    }

    private func startScreen(stream: UInt32, sourceId: String, options: [String: Any], requestId: String?) {
        let fps = (options["fps"] as? NSNumber)?.intValue ?? 30
        let maxHeight = (options["maxHeight"] as? NSNumber)?.intValue ?? 0
        let audio = options["audio"] as? Bool ?? false
        let cursor = options["cursor"] as? Bool ?? true
        let capture = ScreenCapture(stream: stream, bridge: bridge)
        capture.onEnded = { [weak self] reason in
            self?.queue.async { self?.stop(stream: stream, reason: reason, notify: true) }
        }
        capture.sender.onFirstKeyframe = { [weak self, weak capture] in
            self?.queue.async {
                guard let self, let capture, case .screen = self.entries[stream] else { return }
                self.reply(requestId, ["event": "started", "stream": stream, "codec": capture.encoder?.currentCodec ?? "",
                                       "label": capture.label, "deviceId": sourceId,
                                       "audioExcludesApp": capture.audioExcludesApp,
                                       "width": capture.width, "height": capture.height]) { [weak capture] in
                    capture?.sender.openGate()
                }
            }
        }
        // Сразу .screen: первый ключевой кадр может прийти раньше, чем startCapture вернётся.
        entries[stream] = .screen(capture)
        ensureStatsTimer()
        let isCurrent = { [weak self] () -> Bool in
            if case .screen(let c) = self?.entries[stream], c === capture { return true }
            return false
        }
        Task {
            do {
                try await capture.start(sourceId: sourceId, fps: fps, maxHeight: maxHeight, audio: audio, cursor: cursor)
                self.queue.async {
                    guard isCurrent() else { capture.stop(); return }
                    self.failIfNoFrame(stream: stream, requestId: requestId, sender: capture.sender, seconds: 8)
                }
            } catch {
                capture.stop()
                self.queue.async {
                    guard isCurrent() else { return }
                    self.entries.removeValue(forKey: stream)
                    self.fail(requestId, stream: stream, error)
                }
            }
        }
    }

    private func failIfNoFrame(stream: UInt32, requestId: String?, sender: VideoStreamSender, seconds: Double) {
        queue.asyncAfter(deadline: .now() + seconds) { [weak self, weak sender] in
            guard let self, let sender, !sender.started, self.entries[stream] != nil else { return }
            self.stop(stream: stream, reason: "no-frames", notify: false)
            self.fail(requestId, stream: stream, MediaError.failed("нет кадров за \(Int(seconds)) с"))
        }
    }

    private func stop(stream: UInt32, reason: String, notify: Bool) {
        guard let entry = entries.removeValue(forKey: stream) else { return }
        switch entry {
        case .mic(let mic):
            mic.stop()
        case .camera(let hub):
            if hub.remove(stream) {
                hubs = hubs.filter { $0.value !== hub }
            }
        case .screen(let screen):
            screen.stop()
        case .starting:
            break
        }
        if entries.isEmpty {
            statsTimer?.cancel()
            statsTimer = nil
        }
        mediaLog("stream \(stream) ended reason=\(reason)")
        if notify { send(["event": "ended", "stream": stream, "reason": reason]) }
    }

    private func stopAll(reason: String, notify: Bool) {
        for stream in Array(entries.keys) { stop(stream: stream, reason: reason, notify: notify) }
    }

    // MARK: - События

    /// Раз в 10 с: обработка звука микрофона и счётчики видео (кадры, кбит/с, пропуски).
    /// В журнал оболочки и странице — она пишет их в журнал звонка.
    private func ensureStatsTimer() {
        guard statsTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 10, repeating: 10)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            for (stream, entry) in self.entries {
                switch entry {
                case .mic(let mic):
                    self.send(["event": "stats", "stream": stream, "processing": mic.stats()])
                case .camera(let hub):
                    var video = hub.takeStats(stream)
                    video["kind"] = "camera"
                    self.logVideoStats(stream, video)
                    self.send(["event": "stats", "stream": stream, "video": video])
                case .screen(let screen):
                    var video = screen.takeStats()
                    video["kind"] = "screen"
                    self.logVideoStats(stream, video)
                    self.send(["event": "stats", "stream": stream, "video": video])
                case .starting:
                    break
                }
            }
            if self.keyframeRequests > 0 {
                mediaLog("keyframe requests from page: \(self.keyframeRequests) in 10 s")
                self.keyframeRequests = 0
            }
        }
        t.resume()
        statsTimer = t
    }

    private func logVideoStats(_ stream: UInt32, _ video: [String: Any]) {
        let text = video.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        mediaLog("stats stream=\(stream) \(text)")
    }

    private func watchDevices() {
        let changed: () -> Void = { [weak self] in self?.devicesChanged() }
        devicesListener = AudioPropertyListener(object: AudioObjectID(kAudioObjectSystemObject),
                                                selector: kAudioHardwarePropertyDevices, queue: queue, handler: changed)
        defaultInputListener = AudioPropertyListener(object: AudioObjectID(kAudioObjectSystemObject),
                                                     selector: kAudioHardwarePropertyDefaultInputDevice, queue: queue, handler: changed)
        let nc = NotificationCenter.default
        deviceObservers.append(nc.addObserver(forName: .AVCaptureDeviceWasConnected, object: nil, queue: nil) { _ in changed() })
        deviceObservers.append(nc.addObserver(forName: .AVCaptureDeviceWasDisconnected, object: nil, queue: nil) { _ in changed() })
    }

    private func devicesChanged() {
        queue.async { [self] in
            guard !devicesChangedPending else { return }
            devicesChangedPending = true
            queue.asyncAfter(deadline: .now() + 0.4) { [self] in
                devicesChangedPending = false
                send(["event": "devices_changed"])
            }
        }
    }

    private func send(_ payload: [String: Any], completion: (() -> Void)? = nil) {
        guard let json = zaliJSONString(payload) else {
            mediaLog("event not serializable: \(payload["event"] ?? "?")")
            completion?()
            return
        }
        if let emit {
            emit(json, completion)
        } else {
            completion?()
        }
    }

    private func reply(_ requestId: String?, _ payload: [String: Any], completion: (() -> Void)? = nil) {
        var p = payload
        if let requestId { p["requestId"] = requestId }
        send(p, completion: completion)
    }

    private func fail(_ requestId: String?, stream: UInt32?, _ error: Error) {
        let e = error as? MediaError ?? MediaError.failed("\(error)")
        mediaLog("error code=\(e.code) stream=\(stream.map(String.init) ?? "-") \(e.message)")
        var p: [String: Any] = ["event": "error", "code": e.code, "message": e.message]
        if let stream { p["stream"] = stream }
        // Ошибка без requestId по живому потоку страница считает концом потока — для
        // запроса без requestId (start всегда с ним) потока ещё нет, так что безопасно.
        reply(requestId, p)
    }
}
