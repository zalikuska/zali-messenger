import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

/// Кодек кодировщика. H.265 — только для слоёв нативной демонстрации через SFU (2026-11-24):
/// при том же качестве экрана ~вдвое меньше битрейта; камера и «Общий браузер» — H.264.
enum VideoCodecKind: String {
    case h264 = "H264"
    case h265 = "H265"

    var cmType: CMVideoCodecType { self == .h264 ? kCMVideoCodecType_H264 : kCMVideoCodecType_HEVC }
    /// Номер кодека в заголовке кадра моста (MediaFrame, native_media.js).
    var frameCodec: UInt8 { self == .h264 ? MediaFrame.codecH264 : MediaFrame.codecH265 }

    /// Есть ли аппаратный кодировщик (программный HEVC на 4K60 положил бы процессор).
    var hardwareEncodeAvailable: Bool {
        if self == .h264 { return true }
        let spec: [CFString: Any] = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true]
        var probe: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil, width: 1920, height: 1080, codecType: cmType,
                                                encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil,
                                                compressedDataAllocator: nil, outputCallback: nil, refcon: nil,
                                                compressionSessionOut: &probe)
        if let probe { VTCompressionSessionInvalidate(probe) }
        return status == noErr && probe != nil
    }
}

/// H.264 (или H.265, `codec`) для страницы: VideoToolbox realtime, без B-кадров, Annex B,
/// параметры последовательности (SPS/PPS, у H.265 и VPS) перед каждым ключевым кадром,
/// ключевой раз в 2 с и по запросу (`requestKeyframe`).
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
    let codec: VideoCodecKind
    /// avc1.PPCCLL / hvc1.… — известен после первого ключевого кадра.
    private(set) var codecString: String = ""
    var onOutput: ((Output) -> Void)?

    private var session: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var scaledPool: CVPixelBufferPool?
    private let lock = NSLock()
    private var forceKey = true
    private var lastEncodeHost: UInt64 = 0
    private var encodeFailures = 0

    /// - bitrate: явный битрейт (слой для сети, его меняет `setBitrate`); 0 — по bitsPerPixel.
    /// - keyframeSeconds: ключевой кадр по таймеру. Для сети — реже: каждый ключевой кадр
    ///   слоя 4K — всплеск в мегабайты, а новым зрителям SFU сам просит ключевой (PLI).
    init(width: Int, height: Int, fps: Int, bitsPerPixel: Double = 0.1, bitrate explicitBitrate: Int = 0, keyframeSeconds: Double = 2,
         codec: VideoCodecKind = .h264) throws {
        self.codec = codec
        self.width = max(2, width & ~1)
        self.height = max(2, height & ~1)
        // До 240: «Общий браузер» и демонстрация идут с частотой экрана (120/144 Гц); камера ≤ 60.
        self.fps = max(1, min(fps, 240))
        let spec: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
        ]
        var created: VTCompressionSession?
        var status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(self.width), height: Int32(self.height),
            codecType: codec.cmType, encoderSpecification: spec as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &created)
        if status != noErr || created == nil {
            // Низколатентный режим есть не у всех кодировщиков — обычный realtime.
            status = VTCompressionSessionCreate(
                allocator: nil, width: Int32(self.width), height: Int32(self.height),
                codecType: codec.cmType, encoderSpecification: nil,
                imageBufferAttributes: nil, compressedDataAllocator: nil,
                outputCallback: nil, refcon: nil, compressionSessionOut: &created)
        }
        guard status == noErr, let session = created else {
            throw MediaError.failed("VTCompressionSessionCreate \(status)")
        }
        self.session = session
        let bitrate = explicitBitrate > 0 ? explicitBitrate : Int(Double(self.width * self.height * self.fps) * bitsPerPixel)
        let set: (CFString, Any) -> Void = { key, value in
            _ = VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
        }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!)
        if codec == .h265 {
            set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_HEVC_Main_AutoLevel)
        } else if VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel) != noErr {
            set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
        }
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, keyframeSeconds as NSNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, Int(Double(self.fps) * keyframeSeconds) as NSNumber)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, self.fps as NSNumber)
        // Явный битрейт — слой SFU: у нижнего потолок 400 кбит/с, пол 500 кбит/с был бы выше
        // него до первого `bitrates` от издателя. Пол — как у setBitrate.
        set(kVTCompressionPropertyKey_AverageBitRate, max(bitrate, explicitBitrate > 0 ? 100_000 : 500_000) as NSNumber)
        if codec == .h264 { set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CABAC) }
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

    /// Новый средний битрейт на лету (слой для сети: бюджет считает WebRTC по оценке канала)
    /// и потолок всплеска — полторы секунды бюджета за секунду.
    func setBitrate(_ bps: Int) {
        lock.lock()
        let s = session
        lock.unlock()
        guard let s else { return }
        let value = max(bps, 100_000)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: value as NSNumber)
        let limits = [NSNumber(value: value / 8 * 3 / 2), NSNumber(value: 1)] as CFArray
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
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
            let hevc = codec == .h265
            // Одна сигнатура у H.264- и HEVC-версии: (формат, индекс, указатель, размер, число, длина заголовка).
            let getSet: (CMFormatDescription, Int, UnsafeMutablePointer<UnsafePointer<UInt8>?>?, UnsafeMutablePointer<Int>?,
                         UnsafeMutablePointer<Int>?, UnsafeMutablePointer<Int32>?) -> OSStatus = hevc
                ? { CMVideoFormatDescriptionGetHEVCParameterSetAtIndex($0, parameterSetIndex: $1, parameterSetPointerOut: $2,
                                                                       parameterSetSizeOut: $3, parameterSetCountOut: $4, nalUnitHeaderLengthOut: $5) }
                : { CMVideoFormatDescriptionGetH264ParameterSetAtIndex($0, parameterSetIndex: $1, parameterSetPointerOut: $2,
                                                                       parameterSetSizeOut: $3, parameterSetCountOut: $4, nalUnitHeaderLengthOut: $5) }
            var count = 0
            var nalHeaderLength: Int32 = 0
            _ = getSet(format, 0, nil, nil, &count, &nalHeaderLength)
            for i in 0..<count {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                if getSet(format, i, &ptr, &size, nil, nil) == noErr, let ptr {
                    out.append(contentsOf: startCode)
                    out.append(ptr, count: size)
                    if !hevc, i == 0, size >= 4 {
                        let codec = String(format: "avc1.%02X%02X%02X", ptr[1], ptr[2], ptr[3])
                        lock.lock(); codecString = codec; lock.unlock()
                    }
                }
            }
            if hevc, let name = H264Encoder.hevcCodecString(format) {
                lock.lock(); codecString = name; lock.unlock()
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

    /// `hvc1.P.C.TL.B` (RFC 6381 / ISO 14496-15 E.3) из атома hvcC формата: профиль, флаги
    /// совместимости (в обратном порядке бит), ярус и уровень, байты ограничений.
    static func hevcCodecString(_ format: CMFormatDescription) -> String? {
        guard let atoms = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any],
              let hvcc = atoms["hvcC"] as? Data, hvcc.count >= 13 else { return nil }
        let b = [UInt8](hvcc.prefix(13))
        let space = (b[1] >> 6) & 0x3
        let tier = (b[1] >> 5) & 0x1
        let profile = b[1] & 0x1f
        var compat = UInt32(b[2]) << 24 | UInt32(b[3]) << 16 | UInt32(b[4]) << 8 | UInt32(b[5])
        var reversed: UInt32 = 0
        for _ in 0..<32 { reversed = (reversed << 1) | (compat & 1); compat >>= 1 }
        var constraints = Array(b[6...11])
        while let last = constraints.last, last == 0 { constraints.removeLast() }
        let prefix = ["", "A", "B", "C"][Int(space)]
        var out = "hvc1.\(prefix)\(profile).\(String(reversed, radix: 16, uppercase: true)).\(tier == 1 ? "H" : "L")\(b[12])"
        for c in constraints { out += "." + String(c, radix: 16, uppercase: true) }
        return out
    }
}

/// Отправка закодированного видео одного потока в мост: нумерация кадров, удержание
/// кадров до подтверждения `started` (страница должна знать codec до первого кадра)
/// и пропуск кадров при заторе с ключевым после него.
final class VideoStreamSender {
    let stream: UInt32
    /// Слой simulcast + 1 в заголовке кадра; 0 — поток без слоёв.
    var layer: UInt8 = 0
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
        let header = MediaFrame.Header(kind: MediaFrame.kindVideo, codec: encoder?.codec.frameCodec ?? MediaFrame.codecH264, stream: stream,
                                       timestampMicros: out.timestampMicros, width: UInt16(clamping: out.width),
                                       height: UInt16(clamping: out.height), keyframe: out.keyframe, channels: 0, seq: n,
                                       layer: layer)
        let data = MediaFrame.make(header, payloadBytes: out.annexB.count) { dst in
            out.annexB.withUnsafeBytes { src in dst.copyMemory(from: src) }
        }
        bridge.send(data)
    }
}
