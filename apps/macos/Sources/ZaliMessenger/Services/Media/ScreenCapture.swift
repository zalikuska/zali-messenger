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
            guard w.windowLayer == 0, w.isOnScreen,
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
        for (index, d) in content.displays.enumerated() {
            // Превью — как будет в захвате: окна мессенджера на экране тоже видны.
            let filter = SCContentFilter(display: d, excludingWindows: [])
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

    /// Фильтр захвата по id из списка.
    static func filter(for sourceId: String) async throws -> (SCContentFilter, String, CGSize) {
        try ensureAccess()
        let content = try await content()
        let parts = sourceId.split(separator: ":", maxSplits: 1).map(String.init)
        if sourceId.isEmpty || parts.first == "display" {
            let id = parts.count == 2 ? UInt32(parts[1]) : nil
            guard let d = (id.flatMap { id in content.displays.first { $0.displayID == id } }) ?? (sourceId.isEmpty ? content.displays.first : nil) else {
                throw MediaError.notFound("экран \(sourceId) не найден")
            }
            let filter = SCContentFilter(display: d, excludingWindows: [])
            return (filter, "Экран", pixelSize(filter: filter, fallback: CGSize(width: d.width, height: d.height)))
        }
        if parts.first == "window", parts.count == 2, let id = UInt32(parts[1]),
           let w = content.windows.first(where: { $0.windowID == id }) {
            let filter = SCContentFilter(desktopIndependentWindow: w)
            let title = (w.title ?? "").isEmpty ? (w.owningApplication?.applicationName ?? "Окно") : (w.title ?? "Окно")
            return (filter, title, pixelSize(filter: filter, fallback: w.frame.size))
        }
        throw MediaError.notFound("источник \(sourceId) не найден")
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
    private(set) var label = ""
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
        out["audio_tap"] = audioTap != nil
        return out
    }
    var onEnded: ((String) -> Void)?

    init(stream: UInt32, bridge: MediaBridgeServer) {
        self.stream = stream
        self.bridge = bridge
        self.sender = VideoStreamSender(stream: stream, bridge: bridge)
    }

    func start(sourceId: String, fps: Int, maxHeight: Int, audio: Bool, cursor: Bool) async throws {
        let (filter, title, px) = try await ScreenSources.filter(for: sourceId)
        label = title
        var (w, h) = fitVideoSize(sourceWidth: Int(px.width), sourceHeight: Int(px.height), maxWidth: 0, maxHeight: maxHeight)
        // Предел H.264 у VideoToolbox — 4096×2304.
        (w, h) = fitVideoSize(sourceWidth: w, sourceHeight: h, maxWidth: 4096, maxHeight: 2304)
        width = w
        height = h
        let rate = max(1, min(fps, 60))
        let encoder = try H264Encoder(width: w, height: h, fps: rate, bitsPerPixel: 0.12)
        self.encoder = encoder
        sender.encoder = encoder
        encoder.onOutput = { [weak self] out in self?.sender.deliver(out) }

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
        let isDisplay = sourceId.isEmpty || sourceId.hasPrefix("display:")
        var useTap = false
        if audio, isDisplay, #available(macOS 14.2, *) { useTap = true }
        audioExcludesApp = !(audio && isDisplay && !useTap)
        config.capturesAudio = audio && !useTap
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2

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
        mediaLog("screen: started stream=\(stream) source=\(sourceId) \(w)x\(h)@\(rate) audio=\(audio)\(useTap ? "(tap)" : "") cursor=\(cursor)")
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
            self.encoder?.encode(buffer, pts: pts)
        }
        t.resume()
        idleTimer = t
    }

    func requestKeyframe() { encoder?.requestKeyframe() }

    func stop() {
        guard !stopped else { return }
        stopped = true
        let s = scStream
        scStream = nil
        idleTimer?.cancel()
        idleTimer = nil
        encoder?.invalidate()
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
            if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
               let raw = attachments.first?[.status] as? Int,
               let status = SCFrameStatus(rawValue: raw), status != .complete {
                return
            }
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            lastPixelBuffer = pixelBuffer
            lastFrameHost = mach_absolute_time()
            capturedFrames += 1
            encoder?.encode(pixelBuffer, pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        case .audio:
            handleAudio(sampleBuffer)
        default:
            break
        }
    }

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
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
