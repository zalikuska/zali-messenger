import Foundation
import CoreBridge

/// Отправка демонстрации экрана на SFU сервера напрямую из оболочки — клиентом WebRTC в
/// Rust-ядре (core/src/sfu_publisher.rs). Слои VideoToolbox уходят в сеть как есть, без
/// второго кодирования в WebView. Сигналинг (оффер → `voice_sfu_publish` со `slot:
/// "native"` → ответ) ведёт страница, см. voice_sfu.js → startNativeSfuScreen.
final class NativeSfuPublisher {
    struct Layer {
        let rid: String
        let width: Int
        let height: Int
        let fps: Int
        let maxBitrate: Int
    }

    /// Событие ядра (JSON-объект), с потока издателя.
    private final class Sink {
        let handler: ([String: Any]) -> Void
        init(_ handler: @escaping ([String: Any]) -> Void) { self.handler = handler }
    }

    private var ptr: OpaquePointer?
    private let sink: Unmanaged<Sink>
    private let lock = NSLock()
    let offerSdp: String
    let mid: String

    init?(layers: [Layer], startBitrate: Int, codec: VideoCodecKind = .h264, onEvent: @escaping ([String: Any]) -> Void) {
        let config: [String: Any] = [
            "codec": codec.rawValue,
            "layers": layers.map { ["rid": $0.rid, "width": $0.width, "height": $0.height, "fps": $0.fps, "max_bitrate": $0.maxBitrate] },
            "start_bitrate": startBitrate,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: config),
              let json = String(data: data, encoding: .utf8) else { return nil }
        let sink = Unmanaged.passRetained(Sink(onEvent))
        let callback: ZaliSfuPubCallback = { ctx, text in
            guard let ctx, let text else { return }
            let sink = Unmanaged<Sink>.fromOpaque(ctx).takeUnretainedValue()
            guard let data = String(cString: text).data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
            sink.handler(obj)
        }
        guard let p = zali_sfu_pub_new(json, callback, sink.toOpaque()) else {
            sink.release()
            return nil
        }
        guard let offerPtr = zali_sfu_pub_offer_json(p) else {
            zali_sfu_pub_free(p)
            sink.release()
            return nil
        }
        let offerText = String(cString: offerPtr)
        zali_bus_free_string(offerPtr)
        guard let od = offerText.data(using: .utf8),
              let offer = (try? JSONSerialization.jsonObject(with: od)) as? [String: Any],
              let sdp = offer["sdp"] as? String, let mid = offer["mid"] as? String else {
            zali_sfu_pub_free(p)
            sink.release()
            return nil
        }
        self.ptr = p
        self.sink = sink
        self.offerSdp = sdp
        self.mid = mid
    }

    func answer(_ sdp: String) {
        lock.lock(); defer { lock.unlock() }
        guard let ptr else { return }
        _ = zali_sfu_pub_answer(ptr, sdp)
    }

    /// Кадр слоя (0 — нижний): Annex B, у ключевого параметры последовательности внутри.
    func push(layer: Int, annexB: Data, keyframe: Bool, timestampMicros: UInt64) {
        lock.lock(); defer { lock.unlock() }
        guard let ptr else { return }
        annexB.withUnsafeBytes { raw in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            zali_sfu_pub_push(ptr, UInt32(layer), base, raw.count, keyframe, Int64(clamping: timestampMicros))
        }
    }

    /// Останавливает поток издателя; колбэк после возврата не зовётся.
    func close() {
        lock.lock()
        let p = ptr
        ptr = nil
        lock.unlock()
        guard let p else { return }
        zali_sfu_pub_free(p)
        sink.release()
    }

    deinit { close() }
}
