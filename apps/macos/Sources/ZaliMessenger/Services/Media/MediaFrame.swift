import Foundation
import CoreMedia

// Кадр нативного захвата для страницы (формат — .claude/skills/voice-calls/native-capture.md,
// приёмник — web/src/interface/native_media.js, zaliParseMediaFrame).
//
// 32 байта заголовка, little-endian:
//   0 u8 0x5A | 1 u8 версия=1 | 2 u8 вид (1 звук, 2 видео) | 3 u8 кодек
//   4 u32 stream | 8 u64 метка, мкс | 16 u16 ширина | 18 u16 высота
//   20 u8 флаги (бит 0 — ключевой) | 21 u8 каналы | 22 u16 резерв
//   24 u32 длина данных | 28 u32 номер кадра
enum MediaFrame {
    static let headerSize = 32
    static let kindAudio: UInt8 = 1
    static let kindVideo: UInt8 = 2
    static let codecPCMF32: UInt8 = 1
    static let codecH264: UInt8 = 1

    struct Header {
        var kind: UInt8
        var codec: UInt8
        var stream: UInt32
        var timestampMicros: UInt64
        var width: UInt16 = 0
        var height: UInt16 = 0
        var keyframe: Bool = false
        var channels: UInt8 = 0
        var seq: UInt32 = 0
    }

    /// Заголовок + `payloadBytes` байт данных, которые дописывает `fill`.
    static func make(_ h: Header, payloadBytes: Int, fill: (UnsafeMutableRawBufferPointer) -> Void) -> Data {
        var data = Data(count: headerSize + payloadBytes)
        data.withUnsafeMutableBytes { raw in
            raw.storeBytes(of: UInt8(0x5A), toByteOffset: 0, as: UInt8.self)
            raw.storeBytes(of: UInt8(1), toByteOffset: 1, as: UInt8.self)
            raw.storeBytes(of: h.kind, toByteOffset: 2, as: UInt8.self)
            raw.storeBytes(of: h.codec, toByteOffset: 3, as: UInt8.self)
            raw.storeBytes(of: h.stream.littleEndian, toByteOffset: 4, as: UInt32.self)
            raw.storeBytes(of: h.timestampMicros.littleEndian, toByteOffset: 8, as: UInt64.self)
            raw.storeBytes(of: h.width.littleEndian, toByteOffset: 16, as: UInt16.self)
            raw.storeBytes(of: h.height.littleEndian, toByteOffset: 18, as: UInt16.self)
            raw.storeBytes(of: UInt8(h.keyframe ? 1 : 0), toByteOffset: 20, as: UInt8.self)
            raw.storeBytes(of: h.channels, toByteOffset: 21, as: UInt8.self)
            raw.storeBytes(of: UInt16(0), toByteOffset: 22, as: UInt16.self)
            raw.storeBytes(of: UInt32(payloadBytes).littleEndian, toByteOffset: 24, as: UInt32.self)
            raw.storeBytes(of: h.seq.littleEndian, toByteOffset: 28, as: UInt32.self)
            if payloadBytes > 0 {
                fill(UnsafeMutableRawBufferPointer(rebasing: raw[headerSize...]))
            }
        }
        return data
    }

    static func audio(stream: UInt32, timestampMicros: UInt64, seq: UInt32, channels: Int, samples: UnsafeBufferPointer<Float>) -> Data {
        let bytes = samples.count * MemoryLayout<Float>.size
        let header = Header(kind: kindAudio, codec: codecPCMF32, stream: stream, timestampMicros: timestampMicros, channels: UInt8(clamping: channels), seq: seq)
        return make(header, payloadBytes: bytes) { dst in
            if let base = samples.baseAddress {
                dst.copyMemory(from: UnsafeRawBufferPointer(start: base, count: bytes))
            }
        }
    }
}

/// Монотонные часы кадров: host time (mach_absolute_time) в микросекундах — на тех же
/// часах метки CMSampleBuffer из AVFoundation/ScreenCaptureKit и mHostTime Core Audio.
enum MediaClock {
    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    static func micros(hostTime: UInt64) -> UInt64 {
        let nanos = hostTime &* UInt64(timebase.numer) / UInt64(max(timebase.denom, 1))
        return nanos / 1000
    }

    static func nowMicros() -> UInt64 { micros(hostTime: mach_absolute_time()) }

    static func micros(_ time: CMTime) -> UInt64 {
        guard time.isValid, time.isNumeric else { return nowMicros() }
        let seconds = CMTimeGetSeconds(time)
        return seconds > 0 ? UInt64(seconds * 1_000_000) : nowMicros()
    }
}

/// Ошибка с кодом протокола: permission | not_found | busy | unsupported | failed.
struct MediaError: Error {
    let code: String
    let message: String

    static func permission(_ m: String) -> MediaError { MediaError(code: "permission", message: m) }
    static func notFound(_ m: String) -> MediaError { MediaError(code: "not_found", message: m) }
    static func busy(_ m: String) -> MediaError { MediaError(code: "busy", message: m) }
    static func unsupported(_ m: String) -> MediaError { MediaError(code: "unsupported", message: m) }
    static func failed(_ m: String) -> MediaError { MediaError(code: "failed", message: m) }
}

/// Журнал медиа-слоя: stdout + `mediaLogSink` (приложение направляет его в
/// zali-debug.log). Токен моста сюда никогда не пишется.
var mediaLogSink: ((String) -> Void)?

func mediaLog(_ text: String) {
    let line = "[ZALI][MEDIA] \(text)"
    print(line)
    mediaLogSink?(line)
}
