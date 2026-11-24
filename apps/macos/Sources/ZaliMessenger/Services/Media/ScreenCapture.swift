import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Экраны и окна для своего окна выбора (web: openNativeScreenPicker) и их захват.
///
/// ScreenCaptureKit: список — `SCShareableContent` без окон самого приложения, превью —
/// `SCScreenshotManager` (macOS 14+; на 13 превью нет, только названия). Захват —
/// `SCStream` с курсором и стерео-звуком системы `excludesCurrentProcessAudio`, видео —
/// `H264Encoder`. id источника — `display:<CGDirectDisplayID>` / `window:<CGWindowID>`,
/// стабилен, пока источник жив.
enum ScreenSources {
    static func ensureAccess() throws {
        if CGPreflightScreenCaptureAccess() { return }
        // Один раз показывает системный запрос / открывает настройки; ответ придёт
        // только после перезапуска приложения, поэтому сейчас — отказ.
        _ = CGRequestScreenCaptureAccess()
        throw MediaError.permission("нет доступа к записи экрана (Системные настройки → Конфиденциальность → Запись экрана)")
    }

    static func content() async throws -> SCShareableContent {
        do {
            return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            let ns = error as NSError
            if ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.userDeclined.rawValue {
                throw MediaError.permission("нет доступа к записи экрана")
            }
            throw MediaError.failed("SCShareableContent: \(error.localizedDescription)")
        }
    }

    static func ownPID() -> pid_t { getpid() }

    /// Окна, которые имеет смысл показывать в списке. Окна самого мессенджера тоже
    /// (`own: true`) — их можно показать в звонке; звук для них собирает страница
    /// (звук приложения без звонка, web/src/interface/share_audio.js), не оболочка.
    static func pickableWindows(_ content: SCShareableContent) -> [SCWindow] {
        return content.windows.filter { w in
            // Скрытое окно «Общего браузера» (за пределами экранов) — не источник для показа.
            guard w.windowLayer == 0, w.isOnScreen, !SharedBrowser.isHiddenWindow(Int(w.windowID)),
                  w.frame.width >= 80, w.frame.height >= 60,
                  let app = w.owningApplication else { return false }
            if app.bundleIdentifier == "com.apple.WindowManager" || app.bundleIdentifier == "com.apple.dock" { return false }
            return !(w.title ?? "").isEmpty || !app.applicationName.isEmpty
        }
    }

    static func list(thumbWidth: Int) async throws -> [[String: Any]] {
        try ensureAccess()
        let content = try await content()
        var items: [(dict: [String: Any], filter: SCContentFilter, aspect: Double)] = []
        // Превью — как будет в захвате: приложения, скрытые плашкой, вырезаны и здесь.
        let privacy = ScreenPrivacy.shared.snapshot()
        let previewExcluded = Set(privacy.videoApps.filter { privacy.style(of: $0) == .plate }.map { $0.id })
        for (index, d) in content.displays.enumerated() {
            // Окна мессенджера на экране тоже видны.
            let filter = displayFilter(d, content: content, excludingBundles: previewExcluded)
            let px = pixelSize(filter: filter, fallback: CGSize(width: d.width, height: d.height))
            let title = content.displays.count > 1 ? "Экран \(index + 1)" : "Весь экран"
            items.append(([
                "id": "display:\(d.displayID)", "kind": "display", "title": title, "app": "",
                "width": Int(px.width), "height": Int(px.height),
            ], filter, Double(px.width) / Double(max(px.height, 1))))
        }
        for w in pickableWindows(content) {
            let filter = SCContentFilter(desktopIndependentWindow: w)
            let px = pixelSize(filter: filter, fallback: w.frame.size)
            let app = w.owningApplication?.applicationName ?? ""
            let title = (w.title ?? "").isEmpty ? app : (w.title ?? "")
            items.append(([
                "id": "window:\(w.windowID)", "kind": "window", "title": title, "app": app,
                "own": w.owningApplication?.processID == ownPID(),
                "width": Int(px.width), "height": Int(px.height),
            ], filter, Double(px.width) / Double(max(px.height, 1))))
        }
        guard #available(macOS 14.0, *), thumbWidth > 0 else { return items.map { $0.dict } }
        let tw = min(max(thumbWidth, 64), 1024)
        return await withTaskGroup(of: (Int, String?).self) { group in
            for (i, item) in items.enumerated() {
                group.addTask {
                    let config = SCStreamConfiguration()
                    config.width = tw
                    config.height = max(2, Int(Double(tw) / max(item.aspect, 0.1)))
                    config.showsCursor = false
                    config.scalesToFit = true
                    let image = try? await SCScreenshotManager.captureImage(contentFilter: item.filter, configuration: config)
                    return (i, image.flatMap { jpegDataURL($0) })
                }
            }
            var out = items.map { $0.dict }
            for await (i, thumb) in group {
                if let thumb { out[i]["thumb"] = thumb }
            }
            return out
        }
    }

    static func pixelSize(filter: SCContentFilter, fallback: CGSize) -> CGSize {
        if #available(macOS 14.0, *) {
            let r = filter.contentRect
            let s = CGFloat(filter.pointPixelScale)
            if r.width > 0, r.height > 0 { return CGSize(width: r.width * s, height: r.height * s) }
        }
        let scale = NSScreenScale.main
        return CGSize(width: fallback.width * scale, height: fallback.height * scale)
    }

    static func jpegDataURL(_ image: CGImage) -> String? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return "data:image/jpeg;base64," + (data as Data).base64EncodedString()
    }

    /// Что за источник захвата: экран (его границы в глобальных координатах CG — для
    /// скрытых окон) или окно (bundle id владельца — скрыт ли он целиком).
    struct SourceInfo {
        var displayBounds: CGRect?
        var ownerBundle: String?
    }

    /// Фильтр захвата по id из списка. `excludingBundles` — приложения, вырезаемые из
    /// захвата экрана целиком (скрытые плашкой и/или со звуком SCStream, ScreenPrivacy.swift).
    static func filter(for sourceId: String, excludingBundles: Set<String> = []) async throws -> (SCContentFilter, String, CGSize, SourceInfo) {
        try ensureAccess()
        let content = try await content()
        let parts = sourceId.split(separator: ":", maxSplits: 1).map(String.init)
        if sourceId.isEmpty || parts.first == "display" {
            let id = parts.count == 2 ? UInt32(parts[1]) : nil
            guard let d = (id.flatMap { id in content.displays.first { $0.displayID == id } }) ?? (sourceId.isEmpty ? content.displays.first : nil) else {
                throw MediaError.notFound("экран \(sourceId) не найден")
            }
            let filter = displayFilter(d, content: content, excludingBundles: excludingBundles)
            return (filter, "Экран", pixelSize(filter: filter, fallback: CGSize(width: d.width, height: d.height)),
                    SourceInfo(displayBounds: CGDisplayBounds(d.displayID), ownerBundle: nil))
        }
        if parts.first == "window", parts.count == 2, let id = UInt32(parts[1]),
           let w = content.windows.first(where: { $0.windowID == id }) {
            let filter = SCContentFilter(desktopIndependentWindow: w)
            let title = (w.title ?? "").isEmpty ? (w.owningApplication?.applicationName ?? "Окно") : (w.title ?? "Окно")
            return (filter, title, pixelSize(filter: filter, fallback: w.frame.size),
                    SourceInfo(displayBounds: nil, ownerBundle: w.owningApplication?.bundleIdentifier))
        }
        throw MediaError.notFound("источник \(sourceId) не найден")
    }

    static func displayFilter(_ d: SCDisplay, content: SCShareableContent, excludingBundles: Set<String>) -> SCContentFilter {
        guard !excludingBundles.isEmpty else { return SCContentFilter(display: d, excludingWindows: []) }
        let apps = content.applications.filter { excludingBundles.contains($0.bundleIdentifier) }
        return SCContentFilter(display: d, excludingApplications: apps, exceptingWindows: [])
    }

    /// Фильтр того же экрана с новым списком вырезаемых приложений (на лету).
    static func refreshedDisplayFilter(sourceId: String, excludingBundles: Set<String>) async throws -> SCContentFilter {
        let content = try await content()
        let parts = sourceId.split(separator: ":", maxSplits: 1).map(String.init)
        let id = parts.count == 2 ? UInt32(parts[1]) : nil
        guard let d = (id.flatMap { id in content.displays.first { $0.displayID == id } }) ?? (sourceId.isEmpty ? content.displays.first : nil) else {
            throw MediaError.notFound("экран \(sourceId) не найден")
        }
        return displayFilter(d, content: content, excludingBundles: excludingBundles)
    }
}

/// Масштаб основного экрана без AppKit (на macOS 13, где нет pointPixelScale).
enum NSScreenScale {
    static var main: CGFloat {
        let id = CGMainDisplayID()
        let points = CGDisplayBounds(id).width
        let pixels = CGFloat(CGDisplayPixelsWide(id))
        if let mode = CGDisplayCopyDisplayMode(id), points > 0 {
            return max(1, CGFloat(mode.pixelWidth) / points)
        }
        return points > 0 ? max(1, pixels / points) : 2
    }
}

/// Один поток захвата экрана/окна: видео H.264 + (по желанию) стерео-звук системы.
final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    let stream: UInt32
    private let bridge: MediaBridgeServer
    private let videoQueue = DispatchQueue(label: "com.zali.messenger.media.screen.video", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "com.zali.messenger.media.screen.audio", qos: .userInteractive)
    private var scStream: SCStream?
    private(set) var encoder: H264Encoder?
    let sender: VideoStreamSender
    /// Слой simulcast для отправки на SFU без перекодирования (options.sfu.layers): масштаб
    /// от размера захвата, частота и битрейт как доля бит на пиксель в пределах [min, max].
    /// Порядок — снизу вверх, последний — верхний.
    struct LayerSpec {
        let rid: String
        let scale: Double
        let fps: Int
        let bitsPerPixel: Double
        let minBps: Int
        let maxBps: Int
    }
    /// Кодировщики нижних слоёв (верхний — `encoder`). Пусто — поток без слоёв.
    private var lowerLayers: [H264Encoder] = []
    private(set) var layerCount = 0
    /// Фактические слои после старта (размер кадра известен только тогда).
    private(set) var layerInfo: [NativeSfuPublisher.Layer] = []
    /// Какой слой видит страница (превью своего экрана); остальные — только в издатель.
    private var previewLayer = 0
    /// Издатель ядра (core/src/sfu_publisher.rs): все слои уходят в сеть мимо WebView.
    private let publisherLock = NSLock()
    private var publisher: NativeSfuPublisher?
    /// Слои, выключенные бюджетом издателя: их не кодируем (кроме слоя превью — его
    /// кодируем для страницы, но в сеть не шлём). Меняется и читается на `videoQueue`.
    private var pausedLayers = Set<Int>()
    private(set) var label = ""
    /// `display:<id>` / `window:<id>` — к экрану привязывается удалённое управление.
    private(set) var sourceId = ""
    /// Звук системы в этом потоке не содержит звука самого приложения (tap без его
    /// процессов). false — SCStream (macOS < 14.2 или отказ тапа): процесс WebKit с
    /// голосами и уведомлениями там слышен, и страница не подмешивает звук приложения
    /// второй раз (`started.audioExcludesApp`).
    private(set) var audioExcludesApp = true
    private(set) var width = 0
    private(set) var height = 0
    private var audioSeq: UInt32 = 0
    private var interleaved: [Float] = []
    private var stopped = false
    private var audioTap: AnyObject?
    /// Последний полный кадр и таймер повтора: ScreenCaptureKit отдаёт кадры только при
    /// изменении картинки, а у каждого собеседника свой кодировщик WebRTC — новый
    /// участник на неподвижном экране не получил бы ни кадра. Повторяем раз в секунду.
    private var lastPixelBuffer: CVPixelBuffer?
    private var lastFrameHost: UInt64 = 0
    private var idleTimer: DispatchSourceTimer?
    private var idleRepeats = 0
    private var capturedFrames = 0
    // Скрытые приложения (ScreenPrivacy.swift).
    private var sourceInfo = ScreenSources.SourceInfo()
    private var isDisplaySource = true
    private var wantsAudio = false
    /// Звук идёт тапом Core Audio (исключение процессов — там), а не звуком SCStream.
    private var audioViaTap = false
    private var privacyObserver: UUID?
    private let privacyTracker = PrivacyWindowTracker()
    private lazy var privacyRenderer = PrivacyRenderer()
    /// Какие приложения сейчас вырезаны фильтром (меняется только в `applyPrivacy`).
    private var filterExcluded = Set<String>()
    private let privacyLock = NSLock()
    private var privacyTask: Task<Void, Never>?
    private var privacyMasked = 0

    /// Для `stats`: кадры от ScreenCaptureKit и повторы на неподвижном экране за окно.
    func takeStats() -> [String: Any] {
        var out = sender.takeStats()
        videoQueue.sync {
            out["captured"] = capturedFrames
            out["idle_repeats"] = idleRepeats
            capturedFrames = 0
            idleRepeats = 0
        }
        out["width"] = width
        out["height"] = height
        if layerCount > 0 {
            out["layers"] = layerCount
            out["preview_layer"] = previewLayer
            out["paused"] = videoQueue.sync { pausedLayers.sorted() }
        }
        out["audio_tap"] = audioTap != nil
        let snap = ScreenPrivacy.shared.snapshot()
        if snap.isActive {
            out["privacy_masked"] = videoQueue.sync { () -> Int in
                let n = privacyMasked
                privacyMasked = 0
                return n
            }
            out["privacy_excluded"] = privacyLock.withLock { filterExcluded.count }
        }
        return out
    }
    var onEnded: ((String) -> Void)?

    init(stream: UInt32, bridge: MediaBridgeServer) {
        self.stream = stream
        self.bridge = bridge
        self.sender = VideoStreamSender(stream: stream, bridge: bridge)
    }

    func start(sourceId: String, fps: Int, maxHeight: Int, maxSide: Int = 0, audio: Bool, cursor: Bool,
               layers: [LayerSpec] = [], previewLayer: Int = 0, codec: VideoCodecKind = .h264) async throws {
        let isDisplay = sourceId.isEmpty || sourceId.hasPrefix("display:")
        var useTap = false
        if audio, isDisplay, #available(macOS 14.2, *) { useTap = true }
        isDisplaySource = isDisplay
        wantsAudio = audio
        audioViaTap = useTap
        let excluded = isDisplay ? privacyExcludedBundles(ScreenPrivacy.shared.snapshot()) : []
        let (filter, title, px, info) = try await ScreenSources.filter(for: sourceId, excludingBundles: excluded)
        privacyLock.withLock { filterExcluded = excluded }
        sourceInfo = info
        label = title
        self.sourceId = sourceId
        var (w, h) = fitVideoSize(sourceWidth: Int(px.width), sourceHeight: Int(px.height), maxWidth: 0, maxHeight: maxHeight)
        // Предел H.264 у VideoToolbox — 4096×2304.
        (w, h) = fitVideoSize(sourceWidth: w, sourceHeight: h, maxWidth: 4096, maxHeight: 2304)
        // Потолок длинной стороны для SFU (страница: SFU_SCREEN_MAX_SIDE).
        if maxSide > 0 { (w, h) = fitVideoSize(sourceWidth: w, sourceHeight: h, maxWidth: maxSide, maxHeight: maxSide) }
        width = w
        height = h
        // До 240: 1440p@120 и выше на дисплеях ProMotion/высокой частоты (раньше — ≤ 60).
        // ScreenCaptureKit сам не отдаст чаще, чем обновляется экран.
        let rate = max(1, min(fps, 240))
        let encoder: H264Encoder
        if let top = layers.last {
            // Слои уходят в сеть как есть (издатель ядра → SFU): битрейт — по бюджету оценки
            // канала, ключевые кадры — по запросу SFU, по таймеру редко.
            func bps(_ spec: LayerSpec, _ lw: Int, _ lh: Int, _ lfps: Int) -> Int {
                let raw = Double(lw * lh * lfps) * spec.bitsPerPixel
                return max(spec.minBps, min(spec.maxBps, Int(raw)))
            }
            var info: [NativeSfuPublisher.Layer] = []
            for spec in layers.dropLast() {
                let lw = max(16, Int((Double(w) / max(spec.scale, 1)).rounded()) & ~1)
                let lh = max(16, Int((Double(h) / max(spec.scale, 1)).rounded()) & ~1)
                let lfps = max(1, min(spec.fps, rate))
                let lowerEncoder = try H264Encoder(width: lw, height: lh, fps: lfps, bitrate: bps(spec, lw, lh, lfps), keyframeSeconds: 10, codec: codec)
                let index = lowerLayers.count
                lowerEncoder.onOutput = { [weak self] out in self?.layerOutput(index, out) }
                lowerLayers.append(lowerEncoder)
                info.append(.init(rid: spec.rid, width: lw, height: lh, fps: lfps, maxBitrate: spec.maxBps))
            }
            let topFps = max(1, min(top.fps, rate))
            encoder = try H264Encoder(width: w, height: h, fps: topFps, bitrate: bps(top, w, h, topFps), keyframeSeconds: 10, codec: codec)
            info.append(.init(rid: top.rid, width: w, height: h, fps: topFps, maxBitrate: top.maxBps))
            layerCount = layers.count
            layerInfo = info
            self.previewLayer = max(0, min(previewLayer, layers.count - 1))
            let topIndex = layers.count - 1
            encoder.onOutput = { [weak self] out in self?.layerOutput(topIndex, out) }
            sender.encoder = self.previewLayer == topIndex ? encoder : lowerLayers[self.previewLayer]
        } else {
            encoder = try H264Encoder(width: w, height: h, fps: rate, bitsPerPixel: 0.12)
            sender.encoder = encoder
            encoder.onOutput = { [weak self] out in self?.sender.deliver(out) }
        }
        self.encoder = encoder

        let config = SCStreamConfiguration()
        config.width = w
        config.height = h
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(rate))
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.showsCursor = cursor
        config.queueDepth = 5
        config.scalesToFit = true
        if #available(macOS 14.0, *) { config.preservesAspectRatio = true }
        // Звук экрана целиком — Core Audio тапом без процессов приложения (ScreenAudioTap:
        // SCStream не исключает процесс WebKit GPU, где играют голоса собеседников). Звук
        // окна — SCStream: он берёт звук только приложения-владельца окна. macOS < 14.2 —
        // SCStream и для экрана (собеседники могут слышать себя).
        audioExcludesApp = !(audio && isDisplay && !useTap)
        config.capturesAudio = audio && !useTap
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2

        // Окна скрытых приложений — до первого кадра.
        if isDisplay { privacyTracker.configure(ScreenPrivacy.shared.snapshot(), generation: ScreenPrivacy.shared.generation()) }
        let s = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
            if audio && !useTap { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
        } catch {
            throw MediaError.failed("SCStream output: \(error.localizedDescription)")
        }
        scStream = s
        do {
            try await s.startCapture()
        } catch {
            scStream = nil
            let ns = error as NSError
            if ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.userDeclined.rawValue {
                throw MediaError.permission("нет доступа к записи экрана")
            }
            throw MediaError.failed("SCStream start: \(error.localizedDescription)")
        }
        if useTap, #available(macOS 14.2, *) {
            let tap = ScreenAudioTap(stream: stream, bridge: bridge)
            do {
                try tap.start()
                audioTap = tap
            } catch {
                mediaLog("screen: audio tap failed (\((error as? MediaError)?.message ?? "\(error)")), falling back to SCStream audio")
                audioExcludesApp = false
                // Звук теперь из SCStream: приложения с «не передавать звук» — фильтром.
                audioViaTap = false
                applyPrivacy()
                do {
                    try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
                    config.capturesAudio = true
                    try await s.updateConfiguration(config)
                } catch {
                    mediaLog("screen: SCStream audio fallback failed \(error)")
                }
            }
        }
        startIdleRepeat()
        privacyObserver = ScreenPrivacy.shared.observe { [weak self] in self?.applyPrivacy() }
        mediaLog("screen: started stream=\(stream) source=\(sourceId) \(w)x\(h)@\(rate) audio=\(audio)\(useTap ? "(tap)" : "") cursor=\(cursor) codec=\(layers.isEmpty ? "H264" : codec.rawValue)")
    }

    private func startIdleRepeat() {
        let t = DispatchSource.makeTimerSource(queue: videoQueue)
        t.schedule(deadline: .now() + 1, repeating: 0.5)
        t.setEventHandler { [weak self] in
            guard let self, !self.stopped, let buffer = self.lastPixelBuffer else { return }
            let now = mach_absolute_time()
            guard MediaClock.micros(hostTime: now &- self.lastFrameHost) >= 1_000_000 else { return }
            self.lastFrameHost = now
            self.idleRepeats += 1
            let pts = CMClockGetTime(CMClockGetHostTimeClock())
            self.encodeAll(buffer, pts: pts)
        }
        t.resume()
        idleTimer = t
    }

    /// Без `layer` — ключевой во всех слоях; иначе — в слое `layer` (0 — нижний).
    func requestKeyframe(layer: Int? = nil) {
        guard let layer, layerCount > 0 else {
            encoder?.requestKeyframe()
            lowerLayers.forEach { $0.requestKeyframe() }
            return
        }
        layerEncoder(layer)?.requestKeyframe()
    }

    private func layerEncoder(_ layer: Int) -> H264Encoder? {
        if layer == layerCount - 1 { return encoder }
        return layer >= 0 && layer < lowerLayers.count ? lowerLayers[layer] : nil
    }

    /// Бюджет слоёв снизу вверх, бит/с (из оценки канала издателя). 0 — слой выключить:
    /// не кодировать, пока бюджет не вернётся; включённый снова начинает с ключевого кадра.
    func setLayerBitrates(_ bitrates: [Int]) {
        guard layerCount > 0 else { return }
        for (i, bps) in bitrates.enumerated() where bps > 0 {
            layerEncoder(i)?.setBitrate(bps)
        }
        videoQueue.async { [self] in
            for (i, bps) in bitrates.enumerated() where i < layerCount {
                if bps == 0 {
                    pausedLayers.insert(i)
                } else if pausedLayers.remove(i) != nil {
                    layerEncoder(i)?.requestKeyframe()
                }
            }
        }
    }

    /// Подключить издателя ядра: с этого момента все слои уходят и в него.
    func attachPublisher(_ p: NativeSfuPublisher?) {
        publisherLock.lock()
        let old = publisher
        publisher = p
        publisherLock.unlock()
        if old !== p { old?.close() }
        if p != nil { requestKeyframe() }
    }

    /// Готовый кадр слоя: в издатель и странице — если это слой превью.
    private func layerOutput(_ index: Int, _ out: H264Encoder.Output) {
        publisherLock.lock()
        let p = publisher
        publisherLock.unlock()
        p?.push(layer: index, annexB: out.annexB, keyframe: out.keyframe, timestampMicros: out.timestampMicros)
        if index == previewLayer { sender.deliver(out) }
    }

    func openGates() {
        sender.openGate()
    }

    // MARK: - Скрытые приложения

    /// Кого вырезать из захвата экрана фильтром: скрытые плашкой (жёсткая гарантия), и
    /// все с «не передавать звук», если звук идёт из SCStream (macOS < 14.2) — у фильтра
    /// звук и картинка неразделимы.
    private func privacyExcludedBundles(_ snap: ScreenPrivacy.Snapshot) -> Set<String> {
        var out = Set(snap.videoApps.filter { snap.style(of: $0) == .plate }.map { $0.id })
        if wantsAudio && !audioViaTap { out.formUnion(snap.audioApps.map { $0.id }) }
        return out
    }

    /// Состояние скрытия поменялось (или скрытое приложение запустилось): фильтр, трекер
    /// окон и немедленный перекодированный кадр, чтобы неподвижный экран не ждал повтора.
    private func applyPrivacy() {
        // Наблюдатель зовётся с разных потоков — всё изменение состояния на главном.
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.applyPrivacy() }
            return
        }
        guard !stopped else { return }
        let snap = ScreenPrivacy.shared.snapshot()
        if isDisplaySource {
            privacyTracker.configure(snap, generation: ScreenPrivacy.shared.generation())
            let wanted = privacyExcludedBundles(snap)
            privacyTask?.cancel()
            privacyTask = Task { [weak self] in
                guard let self, let s = self.scStream else { return }
                do {
                    let filter = try await ScreenSources.refreshedDisplayFilter(sourceId: self.sourceId, excludingBundles: wanted)
                    guard !Task.isCancelled, !self.stopped else { return }
                    try await s.updateContentFilter(filter)
                    self.privacyLock.withLock { self.filterExcluded = wanted }
                    mediaLog("screen: privacy filter stream=\(self.stream) excluded=\(wanted.sorted())")
                } catch {
                    mediaLog("screen: privacy filter update failed \(error)")
                }
            }
        }
        videoQueue.async { [weak self] in
            guard let self, !self.stopped, let buffer = self.lastPixelBuffer else { return }
            self.lastFrameHost = mach_absolute_time()
            self.encodeAll(buffer, pts: CMClockGetTime(CMClockGetHostTimeClock()))
        }
    }

    /// Маска кадра `w×h` (пиксели, верх-лево), показанного на экране в `shownAt`
    /// (mach_absolute_time). Только на `videoQueue`.
    private func privacyMask(width w: Int, height h: Int, shownAt: UInt64) -> PrivacyMask {
        let snap = ScreenPrivacy.shared.snapshot()
        guard snap.enabled, let first = snap.videoApps.first else { return PrivacyMask() }
        let full = CGRect(x: 0, y: 0, width: w, height: h)
        if !isDisplaySource {
            // Показ окна скрытого приложения — закрыт весь кадр.
            guard let owner = sourceInfo.ownerBundle, let app = snap.videoApps.first(where: { $0.id == owner }) else { return PrivacyMask() }
            return .full(full, style: snap.style(of: app))
        }
        // Трекер ещё не опросил окна под нынешнее состояние (только что включили скрытие,
        // запустилось скрытое приложение) — закрыть весь кадр, а не пропустить открытым.
        let (tracked, trackedGeneration) = privacyTracker.refresh(notOlderThan: shownAt)
        guard trackedGeneration == ScreenPrivacy.shared.generation(),
              let bounds = sourceInfo.displayBounds, bounds.width > 0, bounds.height > 0 else {
            return .full(full, style: snap.style(of: first))
        }
        let sx = CGFloat(w) / bounds.width
        let sy = CGFloat(h) / bounds.height
        return tracked.mapped({ r in
            CGRect(x: (r.minX - bounds.minX) * sx, y: (r.minY - bounds.minY) * sy, width: r.width * sx, height: r.height * sy)
        }, radiusScale: sx)
    }

    /// `shownAt` — когда кадр был на экране (mach_absolute_time); по умолчанию — сейчас
    /// (повтор последнего кадра: окна с тех пор могли появиться).
    private func encodeAll(_ raw: CVPixelBuffer, pts: CMTime, shownAt: UInt64 = mach_absolute_time()) {
        let mask = privacyMask(width: CVPixelBufferGetWidth(raw), height: CVPixelBufferGetHeight(raw), shownAt: shownAt)
        let buffer = mask.isEmpty ? raw : privacyRenderer.process(raw, mask: mask)
        if !mask.isEmpty { privacyMasked += 1 }
        let top = layerCount - 1
        if layerCount == 0 || !pausedLayers.contains(top) || previewLayer == top { encoder?.encode(buffer, pts: pts) }
        for (i, layer) in lowerLayers.enumerated() where !pausedLayers.contains(i) || previewLayer == i {
            layer.encode(buffer, pts: pts)
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        let s = scStream
        scStream = nil
        idleTimer?.cancel()
        idleTimer = nil
        if let privacyObserver { ScreenPrivacy.shared.unobserve(privacyObserver) }
        privacyObserver = nil
        privacyTask?.cancel()
        privacyTracker.stop()
        encoder?.invalidate()
        lowerLayers.forEach { $0.invalidate() }
        attachPublisher(nil)
        if #available(macOS 14.2, *), let tap = audioTap as? ScreenAudioTap { tap.stop() }
        audioTap = nil
        if let s {
            s.stopCapture { _ in }
        }
        mediaLog("screen: stopped stream=\(stream)")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopped, CMSampleBufferIsValid(sampleBuffer) else { return }
        switch type {
        case .screen:
            let info = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
            if let raw = info?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete {
                return
            }
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            lastPixelBuffer = pixelBuffer
            let arrived = mach_absolute_time()
            lastFrameHost = arrived
            capturedFrames += 1
            // Когда кадр был на экране: маска — из опроса окон не раньше этого момента.
            let shown = (info?[.displayTime] as? NSNumber)?.uint64Value ?? arrived
            encodeAll(pixelBuffer, pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer), shownAt: min(shown, arrived))
        case .audio:
            handleAudio(sampleBuffer)
        default:
            break
        }
    }

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        // Показ окна приложения с «не передавать звук»: SCStream несёт звук только этого
        // приложения — его и не отдаём.
        if !isDisplaySource, let owner = sourceInfo.ownerBundle,
           ScreenPrivacy.shared.snapshot().audioApps.contains(where: { $0.id == owner }) { return }
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return }
        let asbd = asbdPtr.pointee
        guard asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return }
        var blockBuffer: CMBlockBuffer?
        var sizeNeeded = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil,
                                                                bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
                                                                flags: 0, blockBufferOut: nil)
        guard sizeNeeded > 0 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let ablPtr = raw.assumingMemoryBound(to: AudioBufferList.self)
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: ablPtr, bufferListSize: sizeNeeded,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer) == noErr else { return }
        let list = UnsafeMutableAudioBufferListPointer(ablPtr)
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0, list.count > 0 else { return }
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        if interleaved.count < frames * 2 { interleaved = [Float](repeating: 0, count: frames * 2) }
        if nonInterleaved {
            let left = list[0].mData?.assumingMemoryBound(to: Float.self)
            let right = (list.count > 1 ? list[1].mData : list[0].mData)?.assumingMemoryBound(to: Float.self)
            guard let left, let right else { return }
            for i in 0..<frames {
                interleaved[2 * i] = left[i]
                interleaved[2 * i + 1] = right[i]
            }
        } else {
            let ch = max(Int(asbd.mChannelsPerFrame), 1)
            guard let data = list[0].mData?.assumingMemoryBound(to: Float.self) else { return }
            for i in 0..<frames {
                interleaved[2 * i] = data[i * ch]
                interleaved[2 * i + 1] = data[i * ch + (ch > 1 ? 1 : 0)]
            }
        }
        var ts = MediaClock.micros(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        // По 10 мс на кадр, как у микрофона.
        var offset = 0
        interleaved.withUnsafeBufferPointer { all in
            while offset < frames {
                let n = min(480, frames - offset)
                audioSeq &+= 1
                let frame = MediaFrame.audio(stream: stream, timestampMicros: ts, seq: audioSeq, channels: 2,
                                             samples: UnsafeBufferPointer(rebasing: all[(offset * 2)..<((offset + n) * 2)]))
                bridge.send(frame)
                ts &+= UInt64(n) * 1_000_000 / 48_000
                offset += n
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard !stopped else { return }
        let ns = error as NSError
        let reason = (ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.userStopped.rawValue) ? "user-stopped" : "source-gone"
        mediaLog("screen: stream stopped stream=\(self.stream) reason=\(reason) error=\(ns.code)")
        onEnded?(reason)
    }
}
