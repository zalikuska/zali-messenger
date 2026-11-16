import AppKit
import CoreMedia
import CoreVideo
import Foundation
import WebKit

/// «Общий браузер» (web/src/interface/shared_browser.js): скрытый WKWebView со своим
/// профилем, кадры которого идут в звонок как демонстрация экрана, а ввод участников
/// подаётся в него напрямую — настоящий курсор и фокус окна мессенджера не трогаются.
///
/// Как это устроено и почему так (проверено стендом 2026-11-16):
/// - Окно без рамки за пределами экранов и никогда не ключевое для AppKit. Чтобы
///   спрятанная страница не «засыпала», отключено слежение за перекрытием окна
///   (`_setWindowOcclusionDetectionEnabled:`), а `isKeyWindow` подменён — иначе WebKit
///   считает страницу неактивной и не отдаёт ей движения мыши без кнопки (наведение).
/// - Кадры — `takeSnapshot` по таймеру (≈2 мс на кадр) → BGRA → `H264Encoder`. Разрешение
///   на запись экрана не нужно: снимается сам WKWebView, а не экран.
/// - Ввод — NSEvent прямо в WKWebView (`mouseDown`/`mouseDragged`/`keyDown`…); колесо —
///   из CGEvent, у которого «экранные» координаты равны координатам в окне (у NSEvent без
///   окна WebKit берёт `locationInWindow` как есть); наведение — `_simulateMouseMove:`. Вставка текста — `insertText`
///   в изолированном мире скриптов: буфер обмена запустившего не читается никогда.
/// - Профиль: «own» — свой постоянный набор данных приложения (macOS 14+:
///   `WKWebsiteDataStore(forIdentifier:)`; на 13 — временный + куки в файле),
///   «community» — временный набор с куками, пришедшими со страницы (сервер сообщества).
///   Ни тот, ни другой не общие ни с Safari, ни с профилем самого мессенджера.
/// - Ограничения: только http/https; локальная сеть и loopback закрыты и для страниц, и
///   для подзапросов (WKContentRuleList); загрузки, выбор файлов, камера/микрофон,
///   полноэкранный режим элементов, новые окна (открываются в том же) — запрещены.
///   Остаётся DNS-rebinding: имя, которое резолвится в 127.0.0.1, правилами по адресу
///   не ловится.
final class SharedBrowser: NSObject, WKNavigationDelegate, WKUIDelegate {
    let stream: UInt32
    let sender: VideoStreamSender
    private(set) var encoder: H264Encoder?
    private(set) var width = 0
    private(set) var height = 0
    private(set) var label = "Общий браузер"
    var onState: (([String: Any]) -> Void)?
    var onEnded: ((String) -> Void)?

    private let bridge: MediaBridgeServer
    private let frameQueue = DispatchQueue(label: "com.zali.messenger.media.browser.frames", qos: .userInteractive)
    private var window: NSWindow?
    private var webView: WKWebView?
    private var store: WKWebsiteDataStore?
    private var profile = "own"
    /// Частота кадров: по умолчанию — частота экрана запустившего (`displayRefreshRate`).
    private(set) var fps = 60
    private var timer: DispatchSourceTimer?
    private var snapshotInFlight = false
    /// Счётчики ровности кадров за окно `stats`: пропуски тика (снимок ещё не готов),
    /// время снимка, интервалы между кадрами (>1,5 периода — «опоздавший» кадр).
    /// Счётчики главного потока и «страница стоит» — под `statsLock`: их читают и
    /// пишут главный поток, очередь кадров и очередь MediaController (`takeStats`).
    private let statsLock = NSLock()
    private var busyTicks = 0
    private var snapshotMicros: UInt64 = 0
    private var snapshotMicrosMax: UInt64 = 0
    private var snapshots = 0
    private var inputEvents = 0
    /// Сколько кадров подряд совпали с предыдущим (очередь кадров пишет, главный читает).
    private var stillFrames = 0
    private var idleTicksSkipped = 0
    private var tick = 0
    /// Очередь кадров: последний закодированный кадр — с ним сравнивается новый.
    private var lastEncoded: CVPixelBuffer?
    private var lastEncodedHost: UInt64 = 0
    private var repeatsSkipped = 0
    private var lastFrameHost: UInt64 = 0
    private var lateFrames = 0
    private var maxGapMicros: UInt64 = 0
    private var pool: CVPixelBufferPool?
    private var observers: [NSKeyValueObservation] = []
    private var stopped = false
    private var pressedButtons: Set<Int> = []
    private var pressedKeys: [String: (UInt16, String)] = [:]
    private var capturedFrames = 0
    private var lastStateSent: [String: String] = [:]

    /// Постоянный профиль «own» на macOS 14+ — один на приложение.
    private static let ownStoreId = UUID(uuidString: "5A11B0E5-2C6E-4F0B-9B7C-0B5E0A11CE01")!

    init(stream: UInt32, bridge: MediaBridgeServer) {
        self.stream = stream
        self.bridge = bridge
        self.sender = VideoStreamSender(stream: stream, bridge: bridge)
    }

    func takeStats() -> [String: Any] {
        var out = sender.takeStats()
        frameQueue.sync {
            out["captured"] = capturedFrames
            out["late"] = lateFrames
            out["max_gap_ms"] = Double(maxGapMicros / 100) / 10
            out["repeats_skipped"] = repeatsSkipped
            capturedFrames = 0
            lateFrames = 0
            maxGapMicros = 0
            repeatsSkipped = 0
        }
        statsLock.lock()
        out["busy_ticks"] = busyTicks
        out["idle_ticks_skipped"] = idleTicksSkipped
        out["snapshot_ms"] = snapshots > 0 ? Double(snapshotMicros / UInt64(snapshots) / 100) / 10 : 0
        out["snapshot_ms_max"] = Double(snapshotMicrosMax / 100) / 10
        out["input_events"] = inputEvents
        busyTicks = 0; idleTicksSkipped = 0; snapshotMicros = 0; snapshotMicrosMax = 0; snapshots = 0; inputEvents = 0
        statsLock.unlock()
        out["width"] = width
        out["height"] = height
        return out
    }

    // MARK: - Запуск

    /// Только с главного потока. `cookies` — для «community» (и «own» на macOS 13 — из файла).
    func start(url: URL, profile: String, cookies: [[String: Any]], viewWidth: Int, viewHeight: Int, fps: Int) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        self.profile = profile == "community" ? "community" : "own"
        self.fps = fps > 0 ? max(5, min(fps, 240)) : Self.displayRefreshRate()
        let w = max(640, min(viewWidth, 1920)) & ~1
        let h = max(360, min(viewHeight, 1080)) & ~1
        width = w
        height = h
        // Выше 60 к/с — тот же битрейт, что на 60: кадры чаще, но каждый меньше меняется.
        let encoder = try H264Encoder(width: w, height: h, fps: self.fps, bitsPerPixel: 0.12 * min(1, 60 / Double(self.fps)))
        self.encoder = encoder
        sender.encoder = encoder
        encoder.onOutput = { [weak self] out in self?.sender.deliver(out) }

        let config = WKWebViewConfiguration()
        let store: WKWebsiteDataStore
        if self.profile == "own", #available(macOS 14.0, *) {
            store = WKWebsiteDataStore(forIdentifier: Self.ownStoreId)
        } else {
            store = .nonPersistent()
        }
        self.store = store
        config.websiteDataStore = store
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        if #available(macOS 12.3, *) { config.preferences.isElementFullscreenEnabled = false }
        // Видео в общем просмотре должно стартовать по клику любого участника.
        config.mediaTypesRequiringUserActionForPlayback = []
        // Без «Version/… Safari» часть сайтов отдаёт урезанную вёрстку для «неизвестного» WebKit.
        config.applicationNameForUserAgent = "Version/17.0 Safari/605.1.15"

        let frame = NSRect(x: -30000, y: -30000, width: w, height: h)
        let window = AlwaysActiveWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.ignoresCycle, .transient]
        window.isExcludedFromWindowsMenu = true
        window.hasShadow = false
        window.title = "Zali Shared Browser"
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h), configuration: config)
        Self.disableOcclusionDetection(webView)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        if #available(macOS 13.3, *) { webView.isInspectable = false }
        window.contentView = webView
        window.orderFrontRegardless()
        Self.registerHidden(window.windowNumber)
        self.window = window
        self.webView = webView
        observeState(webView)

        // Сначала правила и куки, потом первая загрузка — иначе первый запрос уйдёт без них.
        let group = DispatchGroup()
        group.enter()
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "zali-shared-browser-private-v1",
                                                               encodedContentRuleList: SharedBrowserPolicy.contentRules) { list, error in
            if let list { webView.configuration.userContentController.add(list) } else {
                mediaLog("browser: content rules failed \(error?.localizedDescription ?? "?") — navigation policy still applies")
            }
            group.leave()
        }
        var seed = cookies
        if self.profile == "own", !Self.hasPersistentOwnStore { seed = Self.loadOwnCookies() }
        for raw in seed.prefix(2000) {
            guard let cookie = Self.httpCookie(from: raw) else { continue }
            group.enter()
            store.httpCookieStore.setCookie(cookie) { group.leave() }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self, !self.stopped, let webView = self.webView else { return }
            webView.load(URLRequest(url: url))
            self.startFrames()
        }
        mediaLog("browser: started stream=\(stream) \(w)x\(h)@\(self.fps) profile=\(self.profile) cookies=\(seed.count)")
    }

    /// Частота экрана, на который смотрит запустивший (ProMotion — до 120), в пределах 30…240.
    static func displayRefreshRate() -> Int {
        let rate = NSScreen.main?.maximumFramesPerSecond ?? 60
        return max(30, min(rate > 0 ? rate : 60, 240))
    }

    /// Номера скрытых окон браузера: ScreenSources не показывает их в «Что показать».
    private static let hiddenLock = NSLock()
    private static var hiddenWindows: Set<Int> = []

    static func isHiddenWindow(_ number: Int) -> Bool {
        hiddenLock.lock(); defer { hiddenLock.unlock() }
        return hiddenWindows.contains(number)
    }

    private static func registerHidden(_ number: Int) {
        hiddenLock.lock(); hiddenWindows.insert(number); hiddenLock.unlock()
    }

    private static func unregisterHidden(_ number: Int) {
        hiddenLock.lock(); hiddenWindows.remove(number); hiddenLock.unlock()
    }

    private static var hasPersistentOwnStore: Bool {
        if #available(macOS 14.0, *) { return true }
        return false
    }

    private static func disableOcclusionDetection(_ webView: WKWebView) {
        let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        guard webView.responds(to: sel) else {
            mediaLog("browser: no occlusion SPI — hidden page may be throttled")
            return
        }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(webView.method(for: sel), to: Setter.self)(webView, sel, false)
    }

    private func observeState(_ webView: WKWebView) {
        let changed: (WKWebView) -> Void = { [weak self] _ in self?.emitState() }
        observers = [
            webView.observe(\.url, options: []) { w, _ in changed(w) },
            webView.observe(\.title, options: []) { w, _ in changed(w) },
            webView.observe(\.canGoBack, options: []) { w, _ in changed(w) },
            webView.observe(\.canGoForward, options: []) { w, _ in changed(w) },
            webView.observe(\.isLoading, options: []) { w, _ in changed(w) },
        ]
    }

    private func emitState() {
        guard let webView, !stopped else { return }
        let state: [String: Any] = [
            "url": webView.url?.absoluteString ?? "",
            "title": webView.title ?? "",
            "canBack": webView.canGoBack,
            "canForward": webView.canGoForward,
            "loading": webView.isLoading,
        ]
        let key = state.mapValues { "\($0)" }
        guard key != lastStateSent else { return }
        lastStateSent = key
        if let title = webView.title, !title.isEmpty { label = "Общий браузер — \(title)" }
        onState?(state)
    }

    // MARK: - Кадры

    private func startFrames() {
        // DispatchSourceTimer на главной очереди с допуском 1 мс: Timer в RunLoop
        // сдвигается на занятых циклах и даёт рваные 60 к/с.
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: .main)
        let period = DispatchTimeInterval.nanoseconds(Int(1_000_000_000 / fps))
        t.schedule(deadline: .now() + period, repeating: period, leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.snapshot() }
        t.resume()
        timer = t
    }

    private func snapshot() {
        guard !stopped, let webView, let window else { return }
        tick &+= 1
        statsLock.lock()
        if snapshotInFlight { busyTicks += 1; statsLock.unlock(); return }
        // Страница стоит полсекунды — снимаем каждый 4-й тик; ввод или первое же
        // изменение возвращают полную частоту (stillFrames = 0).
        if stillFrames >= max(fps / 2, 1) && tick % 4 != 0 { idleTicksSkipped += 1; statsLock.unlock(); return }
        statsLock.unlock()
        snapshotInFlight = true
        let began = mach_absolute_time()
        let config = WKSnapshotConfiguration()
        // Ширина в точках так, чтобы картинка вышла ровно `width` пикселей при любом масштабе.
        let scale = max(1, window.backingScaleFactor)
        config.snapshotWidth = NSNumber(value: Double(width) / Double(scale))
        config.afterScreenUpdates = false
        webView.takeSnapshot(with: config) { [weak self] image, _ in
            guard let self else { return }
            self.snapshotInFlight = false
            let took = MediaClock.micros(hostTime: mach_absolute_time() &- began)
            self.statsLock.lock()
            self.snapshots += 1
            self.snapshotMicros += took
            self.snapshotMicrosMax = max(self.snapshotMicrosMax, took)
            self.statsLock.unlock()
            guard !self.stopped, let image,
                  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
            self.frameQueue.async { self.encode(cg) }
        }
    }

    private func encode(_ image: CGImage) {
        guard !stopped, let encoder else { return }
        if pool == nil {
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey: width,
                kCVPixelBufferHeightKey: height,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            ]
            CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
        }
        guard let pool else { return }
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer else { return }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        capturedFrames += 1
        let now = mach_absolute_time()
        // Тот же кадр, что прошлый (точное сравнение, ~0,3 мс на 720p): не кодируем, кроме
        // повтора раз в секунду — у каждого собеседника свой кодировщик WebRTC, новому
        // участнику на неподвижной странице нужен хоть один кадр.
        let unchanged = lastEncoded.map { Self.samePixels(buffer, $0) } ?? false
        statsLock.lock()
        stillFrames = unchanged ? stillFrames + 1 : 0
        statsLock.unlock()
        if unchanged && MediaClock.micros(hostTime: now &- lastEncodedHost) < 1_000_000 {
            repeatsSkipped += 1
            lastFrameHost = 0
            return
        }
        lastEncoded = buffer
        lastEncodedHost = now
        if lastFrameHost != 0 && !unchanged {
            let gap = MediaClock.micros(hostTime: now &- lastFrameHost)
            maxGapMicros = max(maxGapMicros, gap)
            if gap > UInt64(1_500_000 / fps) { lateFrames += 1 }
        }
        lastFrameHost = now
        encoder.encode(buffer, pts: CMClockGetTime(CMClockGetHostTimeClock()))
    }

    /// Побайтовое сравнение двух BGRA-кадров одного размера (строки — без хвостов выравнивания).
    private static func samePixels(_ a: CVPixelBuffer, _ b: CVPixelBuffer) -> Bool {
        guard CVPixelBufferGetWidth(a) == CVPixelBufferGetWidth(b), CVPixelBufferGetHeight(a) == CVPixelBufferGetHeight(b) else { return false }
        CVPixelBufferLockBaseAddress(b, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(b, .readOnly) }
        guard let pa = CVPixelBufferGetBaseAddress(a), let pb = CVPixelBufferGetBaseAddress(b) else { return false }
        let rowA = CVPixelBufferGetBytesPerRow(a), rowB = CVPixelBufferGetBytesPerRow(b)
        let used = CVPixelBufferGetWidth(a) * 4
        for y in 0..<CVPixelBufferGetHeight(a) where memcmp(pa + y * rowA, pb + y * rowB, used) != 0 { return false }
        return true
    }

    func requestKeyframe() { encoder?.requestKeyframe() }

    // MARK: - Ввод (с главного потока)

    /// Событие из страницы, уже отфильтрованное `sanitizeSharedBrowserInput` — и здесь
    /// снова проверяется: оболочка не верит странице на слово.
    func input(_ e: [String: Any]) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !stopped, let webView, let window else { return }
        statsLock.lock()
        inputEvents += 1
        // Ввод почти всегда что-то меняет — сразу полная частота снимков.
        stillFrames = 0
        statsLock.unlock()
        let unit: (Any?) -> CGFloat? = { v in
            guard let n = (v as? NSNumber)?.doubleValue, n.isFinite else { return nil }
            return CGFloat(min(1, max(0, n)))
        }
        let point: () -> NSPoint? = {
            guard let x = unit(e["x"]), let y = unit(e["y"]) else { return nil }
            // WKWebView перевёрнут (начало сверху слева) — как доли кадра.
            return webView.convert(NSPoint(x: x * webView.bounds.width, y: y * webView.bounds.height), to: nil)
        }
        let t = e["t"] as? String ?? ""
        switch t {
        case "move":
            guard let p = point() else { return }
            if pressedButtons.contains(0) {
                webView.mouseDragged(with: mouseEvent(.leftMouseDragged, p, window: window))
            } else if pressedButtons.contains(2) {
                webView.rightMouseDragged(with: mouseEvent(.rightMouseDragged, p, window: window))
            } else if pressedButtons.contains(1) {
                webView.otherMouseDragged(with: mouseEvent(.otherMouseDragged, p, window: window))
            } else {
                // Наведение: обычный mouseMoved WebKit в таком окне не пропускает,
                // `_simulateMouseMove:` (тестовый вход WKWebView) — пропускает (стенд 2026-11-16).
                let ev = mouseEvent(.mouseMoved, p, window: window)
                if webView.responds(to: Self.simulateMouseMove) {
                    webView.perform(Self.simulateMouseMove, with: ev)
                } else {
                    webView.mouseMoved(with: ev)
                }
            }
        case "down", "up":
            guard let p = point(), let b = (e["b"] as? NSNumber)?.intValue, [0, 1, 2].contains(b) else { return }
            let n = max(1, min(3, (e["n"] as? NSNumber)?.intValue ?? 1))
            let down = t == "down"
            if down { pressedButtons.insert(b) } else { guard pressedButtons.remove(b) != nil else { return } }
            sendButton(b, down: down, at: p, clicks: n, webView: webView, window: window)
        case "wheel":
            guard let p = point() else { return }
            let clamp: (Any?) -> Int32 = { v in Int32(max(-2000, min(2000, (v as? NSNumber)?.intValue ?? 0))) }
            let dx = clamp(e["dx"]), dy = clamp(e["dy"])
            guard dx != 0 || dy != 0,
                  let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) else { return }
            // NSEvent из CGEvent без окна: WebKit берёт locationInWindow как есть — даём
            // «экранную» точку, равную точке в окне (ось Y у CG — сверху вниз).
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            cg.location = CGPoint(x: p.x, y: primaryHeight - p.y)
            if let ev = NSEvent(cgEvent: cg) { webView.scrollWheel(with: ev) }
        case "key":
            guard let code = e["code"] as? String, let keyCode = RemoteControl.keyCodes[code] else { return }
            let key = (e["key"] as? String ?? "").prefix(24)
            let m = (e["m"] as? NSNumber)?.intValue ?? 0
            var flags: NSEvent.ModifierFlags = []
            if m & 1 != 0 { flags.insert(.shift) }
            if m & 2 != 0 { flags.insert(.control) }
            if m & 4 != 0 { flags.insert(.option) }
            if m & 8 != 0 { flags.insert(.command) }
            // Те же запреты, что в странице: Cmd/Ctrl — только редактирование и навигация.
            if flags.contains(.command) || flags.contains(.control) {
                guard SharedBrowserPolicy.allowedShortcutCodes.contains(code) else { return }
            }
            if Self.modifierCodes.contains(code) { return }
            let down = (e["d"] as? NSNumber)?.intValue == 1
            let chars = Self.characters(code: code, key: String(key))
            if down { pressedKeys[code] = (UInt16(keyCode), chars) } else { guard pressedKeys.removeValue(forKey: code) != nil else { return } }
            sendKey(UInt16(keyCode), chars: chars, flags: flags, down: down, webView: webView, window: window)
        case "text":
            guard let s = e["s"] as? String, !s.isEmpty else { return }
            let text = String(s.prefix(2000))
            webView.callAsyncJavaScript("document.execCommand('insertText', false, s)", arguments: ["s": text],
                                        in: nil, in: .defaultClient) { _ in }
        case "release":
            releaseAll()
        default:
            break
        }
    }

    private func mouseEvent(_ type: NSEvent.EventType, _ p: NSPoint, window: NSWindow, clicks: Int = 1) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks,
                           pressure: type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp ? 0 : 1)!
    }

    private func sendButton(_ b: Int, down: Bool, at p: NSPoint, clicks: Int, webView: WKWebView, window: NSWindow) {
        switch (b, down) {
        case (0, true): webView.mouseDown(with: mouseEvent(.leftMouseDown, p, window: window, clicks: clicks))
        case (0, false): webView.mouseUp(with: mouseEvent(.leftMouseUp, p, window: window, clicks: clicks))
        case (2, true): webView.rightMouseDown(with: mouseEvent(.rightMouseDown, p, window: window, clicks: clicks))
        case (2, false): webView.rightMouseUp(with: mouseEvent(.rightMouseUp, p, window: window, clicks: clicks))
        case (_, true): webView.otherMouseDown(with: mouseEvent(.otherMouseDown, p, window: window, clicks: clicks))
        default: webView.otherMouseUp(with: mouseEvent(.otherMouseUp, p, window: window, clicks: clicks))
        }
    }

    private func sendKey(_ keyCode: UInt16, chars: String, flags: NSEvent.ModifierFlags, down: Bool, webView: WKWebView, window: NSWindow) {
        let charsIgnoring = flags.contains(.shift) ? chars : chars.lowercased()
        guard let ev = NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: flags,
                                        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                        context: nil, characters: chars, charactersIgnoringModifiers: charsIgnoring,
                                        isARepeat: false, keyCode: keyCode) else { return }
        if down {
            // Cmd+A/Z — эквиваленты клавиш: WKWebView обрабатывает их там, не в keyDown.
            if (flags.contains(.command) || flags.contains(.control)) && webView.performKeyEquivalent(with: ev) { return }
            webView.keyDown(with: ev)
        } else {
            webView.keyUp(with: ev)
        }
    }

    func releaseAll() {
        guard let webView, let window else { pressedButtons.removeAll(); pressedKeys.removeAll(); return }
        let center = webView.convert(NSPoint(x: webView.bounds.midX, y: webView.bounds.midY), to: nil)
        for b in pressedButtons { sendButton(b, down: false, at: center, clicks: 1, webView: webView, window: window) }
        pressedButtons.removeAll()
        for (_, key) in pressedKeys { sendKey(key.0, chars: key.1, flags: [], down: false, webView: webView, window: window) }
        pressedKeys.removeAll()
    }

    private static let simulateMouseMove = NSSelectorFromString("_simulateMouseMove:")

    private static let modifierCodes: Set<String> = ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
                                                     "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Fn"]

    /// Символы NSEvent для KeyboardEvent.key: печатный символ как есть, служебные — функциональные коды AppKit.
    static func characters(code: String, key: String) -> String {
        let named: [String: Int] = [
            "Enter": 0x0D, "NumpadEnter": 0x03, "Tab": 0x09, "Backspace": 0x7F, "Escape": 0x1B, "Space": 0x20,
            "Delete": NSDeleteFunctionKey, "ArrowUp": NSUpArrowFunctionKey, "ArrowDown": NSDownArrowFunctionKey,
            "ArrowLeft": NSLeftArrowFunctionKey, "ArrowRight": NSRightArrowFunctionKey, "Home": NSHomeFunctionKey,
            "End": NSEndFunctionKey, "PageUp": NSPageUpFunctionKey, "PageDown": NSPageDownFunctionKey,
        ]
        if let scalar = named[code], let u = Unicode.Scalar(scalar) { return String(Character(u)) }
        if code.hasPrefix("F"), let n = Int(code.dropFirst()), (1...20).contains(n), let u = Unicode.Scalar(NSF1FunctionKey + n - 1) {
            return String(Character(u))
        }
        return key.count == 1 ? key : ""
    }

    // MARK: - Навигация и куки

    func navigate(action: String, url raw: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !stopped, let webView else { return }
        switch action {
        case "go":
            guard let url = URL(string: raw), SharedBrowserPolicy.allows(url) else { return }
            webView.load(URLRequest(url: url))
        case "back": webView.goBack()
        case "forward": webView.goForward()
        case "reload": webView.reload()
        case "stop": webView.stopLoading()
        default: break
        }
    }

    func exportCookies(_ done: @escaping ([[String: Any]]) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let store else { return done([]) }
        store.httpCookieStore.getAllCookies { cookies in
            done(cookies.prefix(2000).map(Self.cookieDict))
        }
    }

    static func cookieDict(_ c: HTTPCookie) -> [String: Any] {
        var sameSite = c.isSecure ? "None" : "Lax"
        if #available(macOS 10.15, *) {
            if c.sameSitePolicy == .sameSiteStrict { sameSite = "Strict" } else if c.sameSitePolicy == .sameSiteLax { sameSite = "Lax" }
        }
        return [
            "name": c.name, "value": c.value, "domain": c.domain, "path": c.path,
            "expires": c.expiresDate?.timeIntervalSince1970 ?? -1,
            "httpOnly": c.isHTTPOnly, "secure": c.isSecure, "sameSite": sameSite,
        ]
    }

    static func httpCookie(from raw: [String: Any]) -> HTTPCookie? {
        guard let name = raw["name"] as? String, !name.isEmpty, name.count <= 256,
              let value = raw["value"] as? String, value.count <= 4096,
              let domain = raw["domain"] as? String, !domain.isEmpty, domain.count <= 255 else { return nil }
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: name, .value: value, .domain: domain,
            .path: (raw["path"] as? String).flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/",
        ]
        if let expires = (raw["expires"] as? NSNumber)?.doubleValue, expires > 0 {
            props[.expires] = Date(timeIntervalSince1970: expires)
        } else {
            props[.discard] = "TRUE"
        }
        if (raw["secure"] as? Bool) == true { props[.secure] = "TRUE" }
        if (raw["httpOnly"] as? Bool) == true { props[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        if #available(macOS 10.15, *) {
            switch raw["sameSite"] as? String {
            case "Strict": props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
            case "Lax": props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax
            default: break
            }
        }
        return HTTPCookie(properties: props)
    }

    /// macOS 13: у «own» нет постоянного набора данных — куки живут в файле.
    private static var ownCookiesURL: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("ZaliMessenger", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("shared_browser_cookies.json")
    }

    private static func loadOwnCookies() -> [[String: Any]] {
        guard let url = ownCookiesURL, let data = try? Data(contentsOf: url),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list
    }

    private static func saveOwnCookies(_ list: [[String: Any]]) {
        guard let url = ownCookiesURL, let data = zaliJSONData(list) else { return }
        try? data.write(to: url, options: .atomic)
        // Куки — это входы на сайты: читать их может только владелец.
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    // MARK: - Остановка

    func stop() {
        let finish = { [self] in
            guard !stopped else { return }
            stopped = true
            timer?.cancel()
            timer = nil
            observers.removeAll()
            encoder?.invalidate()
            let teardown = { [self] in
                webView?.stopLoading()
                webView?.navigationDelegate = nil
                webView?.uiDelegate = nil
                if let number = window?.windowNumber { Self.unregisterHidden(number) }
                window?.contentView = nil
                window?.orderOut(nil)
                window?.close()
                webView = nil
                window = nil
                store = nil
                mediaLog("browser: stopped stream=\(stream)")
            }
            if profile == "own", !Self.hasPersistentOwnStore, let store {
                store.httpCookieStore.getAllCookies { cookies in
                    Self.saveOwnCookies(cookies.prefix(2000).map(Self.cookieDict))
                    teardown()
                }
            } else {
                teardown()
            }
        }
        if Thread.isMainThread { finish() } else { DispatchQueue.main.async(execute: finish) }
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload { return decisionHandler(.cancel) }
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        // Вложенные фреймы могут быть about:blank/srcdoc/blob/data; верхний документ — только http(s).
        let isMain = navigationAction.targetFrame?.isMainFrame ?? true
        if ["about", "blob"].contains(scheme) || (!isMain && scheme == "data") { return decisionHandler(.allow) }
        decisionHandler(SharedBrowserPolicy.allows(url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // То, что WebKit не может показать, он бы скачал — загрузок на компьютер запустившего нет.
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Новое окно — в этом же браузере (его никто не увидит в отдельном окне).
        if let url = navigationAction.request.url, SharedBrowserPolicy.allows(url) {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        // Выбор файла открыл бы диалог на компьютере запустившего — файлы не отдаём.
        completionHandler(nil)
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(false)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        completionHandler(nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        mediaLog("browser: content process terminated stream=\(stream) — reloading")
        webView.reload()
    }
}

/// Окно, которое WebKit считает активным: иначе страница не получает движений мыши
/// без кнопки (наведение). Для AppKit оно не ключевое (`canBecomeKey` у окна без рамки
/// — false), клавиатура мессенджера остаётся у его окна.
private final class AlwaysActiveWindow: NSWindow {
    override var isKeyWindow: Bool { true }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Куда «Общему браузеру» можно. Общая логика с Windows (`shared_browser.rs`).
enum SharedBrowserPolicy {
    static let allowedShortcutCodes: Set<String> = ["KeyA", "KeyZ", "KeyY", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
                                                     "Backspace", "Delete", "Home", "End", "Enter", "Minus", "Equal", "Digit0"]

    /// http(s) и не локальная сеть/loopback.
    static func allows(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty else { return false }
        if url.user != nil || url.password != nil { return false }
        return !isPrivateHost(host)
    }

    static func isPrivateHost(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local")
            || host.hasSuffix(".internal") || host.hasSuffix(".lan") || host.hasSuffix(".home.arpa") { return true }
        // Числовые формы IPv4 без точек (2130706433, 0x7f000001) — не адрес сайта.
        if !host.contains("."), !host.contains(":"), host.allSatisfy({ $0.isHexDigit || $0 == "x" }) { return true }
        var v4 = in_addr()
        if inet_pton(AF_INET, host, &v4) == 1 {
            let b = withUnsafeBytes(of: v4.s_addr) { Array($0) }
            switch (b[0], b[1]) {
            case (0, _), (10, _), (127, _): return true
            case (169, 254), (192, 168): return true
            case (172, 16...31): return true
            case (100, 64...127): return true
            default: return b[0] >= 224
            }
        }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, host, &v6) == 1 {
            let b = withUnsafeBytes(of: v6) { Array($0) }
            if b.allSatisfy({ $0 == 0 }) { return true }                       // ::
            if b[0..<15].allSatisfy({ $0 == 0 }) && b[15] == 1 { return true }  // ::1
            if b[0] & 0xfe == 0xfc { return true }                             // fc00::/7
            if b[0] == 0xfe && b[1] & 0xc0 == 0x80 { return true }             // fe80::/10
            if b[0..<10].allSatisfy({ $0 == 0 }) && b[10] == 0xff && b[11] == 0xff {
                return isPrivateHost("\(b[12]).\(b[13]).\(b[14]).\(b[15])")    // ::ffff:a.b.c.d
            }
            return b[0] == 0xff
        }
        return false
    }

    /// WKContentRuleList: то же для подзапросов страницы (fetch, картинки, фреймы, WebSocket).
    /// Регулярки WebKit без «|» — по правилу на шаблон.
    static let contentRules: String = {
        let patterns = [
            "^[a-z]+://localhost[:/]", "^[a-z]+://[^/?#]*\\.localhost[:/]", "^[a-z]+://[^/?#]*\\.local[:/]",
            "^[a-z]+://[^/?#]*\\.internal[:/]", "^[a-z]+://[^/?#]*\\.lan[:/]",
            "^[a-z]+://127\\.", "^[a-z]+://10\\.", "^[a-z]+://0\\.", "^[a-z]+://192\\.168\\.", "^[a-z]+://169\\.254\\.",
            "^[a-z]+://172\\.1[6-9]\\.", "^[a-z]+://172\\.2[0-9]\\.", "^[a-z]+://172\\.3[01]\\.",
            "^[a-z]+://\\[", "^[a-z]+://[0-9]+[:/]", "^[a-z]+://0x", "^[a-z]+://[^/?#]*@",
            "^file:",
        ]
        let rules = patterns.map { ["trigger": ["url-filter": $0], "action": ["type": "block"]] }
        return zaliJSONString(rules) ?? "[]"
    }()
}
