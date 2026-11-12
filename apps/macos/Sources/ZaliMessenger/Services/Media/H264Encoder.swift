import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

/// H.264 для страницы: VideoToolbox realtime, без B-кадров, Annex B, SPS/PPS перед
/// каждым ключевым кадром, ключевой раз в 2 с и по запросу (`requestKeyframe`).
///
/// Страница декодирует это `VideoDecoder` (WebKit) и отдаёт в WebRTC, который кодирует
/// заново под сеть — поэтому битрейт здесь щедрый: путь до страницы — loopback, а
/// каждое лишнее поколение сжатия видно на тексте экрана.
final class H264Encoder {
    struct Output {
        let annexB: Data
        let keyframe: Bool
        let timestampMicros: UInt64
        let width: Int
        let height: Int
    }

    let width: Int
    let height: Int
    let fps: Int
    /// avc1.PPCCLL — известен после первого ключевого кадра.
    private(set) var codecString: String = ""
    var onOutput: ((Output) -> Void)?

    private var session: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var scaledPool: CVPixelBufferPool?
    private let lock = NSLock()
    private var forceKey = true
    private var lastEncodeHost: UInt64 = 0
    private var encodeFailures = 0

    init(width: Int, height: Int, fps: Int, bitsPerPixel: Double = 0.1) throws {
        self.width = max(2, width & ~1)
        self.height = max(2, height & ~1)
        self.fps = max(1, min(fps, 60))
        let spec: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
        ]
        var created: VTCompressionSession?
        var status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(self.width), height: Int32(self.height),
            codecType: kCMVideoCodecType_H264, encoderSpecification: spec as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &created)
        if status != noErr || created == nil {
            // Низколатентный режим есть не у всех кодировщиков — обычный realtime.
            status = VTCompressionSessionCreate(
                allocator: nil, width: Int32(self.width), height: Int32(self.height),
                codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
                imageBufferAttributes: nil, compressedDataAllocator: nil,
                outputCallback: nil, refcon: nil, compressionSessionOut: &created)
        }
        guard status == noErr, let session = created else {
            throw MediaError.failed("VTCompressionSessionCreate \(status)")
        }
        self.session = session
        let bitrate = Int(Double(self.width * self.height * self.fps) * bitsPerPixel)
        let set: (CFString, Any) -> Void = { key, value in
            _ = VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
        }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!)
        if VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel) != noErr {
            set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
        }
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 2.0 as NSNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (self.fps * 2) as NSNumber)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, self.fps as NSNumber)
        set(kVTCompressionPropertyKey_AverageBitRate, max(bitrate, 500_000) as NSNumber)
        set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CABAC)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit { invalidate() }

    func invalidate() {
        lock.lock()
        let s = session
        session = nil
        lock.unlock()
        if let s {
            VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(s)
        }
        lock.lock()
        if let t = transfer { VTPixelTransferSessionInvalidate(t) }
        transfer = nil
        scaledPool = nil
        lock.unlock()
    }

    func requestKeyframe() {
        lock.lock(); forceKey = true; lock.unlock()
    }

    /// Кодирует кадр. Чаще `fps` не кодирует (камера/экран могут отдавать больше).
    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
        lock.lock()
        guard let session else { lock.unlock(); return }
        let now = mach_absolute_time()
        // Источник чаще fps (экран 60 Гц, камера с другим форматом) — прореживаем;
        // 0.6 интервала, чтобы дрожание меток камеры на 30 к/с не съедало кадры.
        let minGapMicros = UInt64(1_000_000 / fps) * 6 / 10
        if lastEncodeHost != 0, MediaClock.micros(hostTime: now &- lastEncodeHost) < minGapMicros, !forceKey {
            lock.unlock()
            return
        }
        // Вход другого размера масштабируем сами: VideoToolbox на несовпадающем входе
        // (камера 1920×1080 → энкодер 1280×720) выдавал чёрные кадры (стенд 2026-11-12).
        guard let input = scaledIfNeeded(pixelBuffer) else { lock.unlock(); return }
        lastEncodeHost = now
        let key = forceKey
        forceKey = false
        lock.unlock()
        let props: CFDictionary? = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary : nil
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: input, presentationTimeStamp: pts,
                                                     duration: .invalid, frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sample in
            guard status == noErr, let sample, let self else { return }
            self.handle(sample)
        }
        if status != noErr {
            encodeFailures += 1
            if encodeFailures == 1 || encodeFailures % 100 == 0 {
                mediaLog("h264: encode failed \(status) (\(encodeFailures)x) \(width)x\(height)")
            }
            requestKeyframe()
        }
    }

    /// Под `lock`.
    private func scaledIfNeeded(_ buffer: CVPixelBuffer) -> CVPixelBuffer? {
        if CVPixelBufferGetWidth(buffer) == width && CVPixelBufferGetHeight(buffer) == height { return buffer }
        if transfer == nil {
            var t: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &t) == noErr, let t else { return nil }
            VTSessionSetProperty(t, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Letterbox)
            transfer = t
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey: width,
                kCVPixelBufferHeightKey: height,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            ]
            CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &scaledPool)
        }
        guard let transfer, let scaledPool else { return nil }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, scaledPool, &out) == kCVReturnSuccess, let out else { return nil }
        guard VTPixelTransferSessionTransferImage(transfer, from: buffer, to: out) == noErr else { return nil }
        return out
    }

    private func handle(_ sample: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sample), let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var keyframe = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
           let first = attachments.first,
           let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            keyframe = !notSync
        }
        var out = Data()
        let startCode: [UInt8] = [0, 0, 0, 1]
        if keyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            var count = 0
            var nalHeaderLength: Int32 = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                               nalUnitHeaderLengthOut: &nalHeaderLength)
            for i in 0..<count {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                      parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                      nalUnitHeaderLengthOut: nil) == noErr, let ptr {
                    out.append(contentsOf: startCode)
                    out.append(ptr, count: size)
                    if i == 0, size >= 4 {
                        let codec = String(format: "avc1.%02X%02X%02X", ptr[1], ptr[2], ptr[3])
                        lock.lock(); codecString = codec; lock.unlock()
                    }
                }
            }
        }
        // AVCC (4-байтные длины) → Annex B (стартовые коды).
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLength,
                                          dataPointerOut: &dataPointer) == kCMBlockBufferNoErr, let dataPointer else { return }
        var offset = 0
        dataPointer.withMemoryRebound(to: UInt8.self, capacity: totalLength) { bytes in
            while offset + 4 <= totalLength {
                let len = Int(UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16 | UInt32(bytes[offset + 2]) << 8 | UInt32(bytes[offset + 3]))
                offset += 4
                guard len > 0, offset + len <= totalLength else { break }
                out.append(contentsOf: startCode)
                out.append(bytes + offset, count: len)
                offset += len
            }
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        onOutput?(Output(annexB: out, keyframe: keyframe, timestampMicros: MediaClock.micros(pts), width: width, height: height))
    }

    var currentCodec: String {
        lock.lock(); defer { lock.unlock() }
        return codecString
    }
}

/// Отправка закодированного видео одного потока в мост: нумерация кадров, удержание
/// кадров до подтверждения `started` (страница должна знать codec до первого кадра)
/// и пропуск кадров при заторе с ключевым после него.
final class VideoStreamSender {
    let stream: UInt32
    private let bridge: MediaBridgeServer
    private let lock = NSLock()
    private var seq: UInt32 = 0
    private var gated = true
    private var held: [H264Encoder.Output] = []
    private var needKeyAfterDrop = false
    private var sentFrames = 0
    private var sentBytes = 0
    private var sentKeyframes = 0
    private var droppedFrames = 0
    private var windowStart = Date()
    weak var encoder: H264Encoder?

    /// Счётчики за окно с прошлого вызова (для `stats` раз в 10 с) и сброс окна.
    func takeStats() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let seconds = max(Date().timeIntervalSince(windowStart), 0.001)
        let out: [String: Any] = [
            "frames": sentFrames, "fps": (Double(sentFrames) / seconds * 10).rounded() / 10,
            "kbps": Int(Double(sentBytes) * 8 / seconds / 1000), "keyframes": sentKeyframes,
            "dropped": droppedFrames, "gated": gated, "codec": encoder?.currentCodec ?? "",
        ]
        sentFrames = 0; sentBytes = 0; sentKeyframes = 0; droppedFrames = 0
        windowStart = Date()
        return out
    }

    init(stream: UInt32, bridge: MediaBridgeServer) {
        self.stream = stream
        self.bridge = bridge
    }

    /// Первый ключевой кадр закодирован (codec известен) — вызывается один раз.
    var onFirstKeyframe: (() -> Void)?
    private var sawKeyframe = false

    /// Первый ключевой кадр уже был.
    var started: Bool {
        lock.lock(); defer { lock.unlock() }
        return sawKeyframe
    }

    func deliver(_ out: H264Encoder.Output) {
        lock.lock()
        if !sawKeyframe {
            guard out.keyframe else { lock.unlock(); return }
            sawKeyframe = true
            let cb = onFirstKeyframe
            onFirstKeyframe = nil
            held.append(out)
            lock.unlock()
            cb?()
            return
        }
        if gated {
            if held.count < 90 { held.append(out) }
            lock.unlock()
            return
        }
        lock.unlock()
        send(out)
    }

    /// Страница приняла `started` — выпускаем удержанные кадры.
    func openGate() {
        lock.lock()
        gated = false
        let frames = held
        held.removeAll()
        lock.unlock()
        for f in frames { send(f) }
    }

    private func send(_ out: H264Encoder.Output) {
        lock.lock()
        if needKeyAfterDrop && !out.keyframe { droppedFrames += 1; lock.unlock(); return }
        if bridge.congested && !out.keyframe {
            if !needKeyAfterDrop { mediaLog("video: stream=\(stream) transport congested, dropping until keyframe") }
            needKeyAfterDrop = true
            droppedFrames += 1
            lock.unlock()
            encoder?.requestKeyframe()
            return
        }
        needKeyAfterDrop = false
        sentFrames += 1
        sentBytes += out.annexB.count
        if out.keyframe { sentKeyframes += 1 }
        seq &+= 1
        let n = seq
        lock.unlock()
        let header = MediaFrame.Header(kind: MediaFrame.kindVideo, codec: MediaFrame.codecH264, stream: stream,
                                       timestampMicros: out.timestampMicros, width: UInt16(clamping: out.width),
                                       height: UInt16(clamping: out.height), keyframe: out.keyframe, channels: 0, seq: n)
        let data = MediaFrame.make(header, payloadBytes: out.annexB.count) { dst in
            out.annexB.withUnsafeBytes { src in dst.copyMemory(from: src) }
        }
        bridge.send(data)
    }
}
