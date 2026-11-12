import Foundation
import AVFAudio
import CoreBridge

/// Владелец обработчика `zali_apm_*` (core/src/audio_processing.rs): AEC3 → RNNoise →
/// AGC2, 48 кГц моно f32. Внутри мьютекс — опорный сигнал (поток process tap) и
/// микрофон (поток обработки) вызывают из разных потоков.
final class ApmHandle {
    private(set) var ptr: OpaquePointer?
    private(set) var aec: Bool
    private(set) var ns: Bool
    private(set) var agc: Bool

    init(aec: Bool, ns: Bool, agc: Bool) {
        self.aec = aec
        self.ns = ns
        self.agc = agc
        ptr = zali_apm_new(aec, ns, agc)
    }

    deinit {
        if let ptr { zali_apm_free(ptr) }
    }

    func setConfig(aec: Bool, ns: Bool, agc: Bool) {
        self.aec = aec
        self.ns = ns
        self.agc = agc
        if let ptr { zali_apm_set_config(ptr, aec, ns, agc) }
    }

    func pushRender(_ samples: UnsafePointer<Float>, frames: Int, channels: Int) {
        guard let ptr, frames > 0 else { return }
        zali_apm_push_render(ptr, samples, frames, UInt32(channels))
    }

    /// Обрабатывает `input`, готовые отсчёты дописывает в `out`.
    func process(_ input: UnsafeBufferPointer<Float>, into out: inout [Float]) {
        guard let ptr else {
            out.append(contentsOf: input)
            return
        }
        var scratch = [Float](repeating: 0, count: input.count + 960)
        var produced = scratch.withUnsafeMutableBufferPointer { dst in
            zali_apm_process_capture(ptr, input.baseAddress, input.count, dst.baseAddress, dst.count)
        }
        out.append(contentsOf: scratch[0..<produced])
        // Остаток (если выход оказался больше буфера) — забрать без нового входа.
        while produced == scratch.count {
            produced = scratch.withUnsafeMutableBufferPointer { dst in
                zali_apm_process_capture(ptr, nil, 0, dst.baseAddress, dst.count)
            }
            out.append(contentsOf: scratch[0..<produced])
        }
    }

    func statsJSON() -> [String: Any] {
        guard let ptr, let raw = zali_apm_stats_json(ptr) else { return [:] }
        defer { zali_bus_free_string(raw) }
        let text = String(cString: raw)
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
    }
}

/// Чередующиеся f32 (`channels` каналов) с частоты устройства на 48 кГц
/// (AVAudioConverter, потоковый — состояние фильтра живёт между вызовами). На 48 кГц —
/// без копий.
final class PCMResampler {
    let inputRate: Double
    let channels: Int
    private let converter: AVAudioConverter?
    private let inFormat: AVAudioFormat?
    private let outFormat: AVAudioFormat?
    private var inBuffer: AVAudioPCMBuffer?
    private var outBuffer: AVAudioPCMBuffer?

    init(channels: Int, inputRate: Double) {
        self.inputRate = inputRate
        self.channels = max(1, channels)
        if abs(inputRate - 48_000) < 1 {
            converter = nil
            inFormat = nil
            outFormat = nil
            return
        }
        let ch = AVAudioChannelCount(self.channels)
        inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: ch, interleaved: true)
        outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: ch, interleaved: true)
        if let i = inFormat, let o = outFormat {
            converter = AVAudioConverter(from: i, to: o)
            converter?.sampleRateConverterQuality = AVAudioQuality.high.rawValue
        } else {
            converter = nil
        }
    }

    var passthrough: Bool { converter == nil }

    /// `input` — чередующиеся отсчёты (кадров × каналов); `body` получает то же на 48 кГц.
    func process(_ input: UnsafeBufferPointer<Float>, _ body: (UnsafeBufferPointer<Float>) -> Void) {
        guard let converter, let inFormat, let outFormat, input.count >= channels else {
            body(input)
            return
        }
        let frames = input.count / channels
        let n = AVAudioFrameCount(frames)
        if inBuffer == nil || inBuffer!.frameCapacity < n {
            inBuffer = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: max(n, 4096))
        }
        let outCap = AVAudioFrameCount(Double(frames) * 48_000 / inputRate) + 64
        if outBuffer == nil || outBuffer!.frameCapacity < outCap {
            outBuffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: max(outCap, 4096))
        }
        guard let inBuf = inBuffer, let outBuf = outBuffer, let dst = inBuf.floatChannelData?[0] else { return }
        dst.update(from: input.baseAddress!, count: frames * channels)
        inBuf.frameLength = n
        outBuf.frameLength = 0
        var supplied = false
        var error: NSError?
        converter.convert(to: outBuf, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return inBuf
        }
        if let out = outBuf.floatChannelData?[0], outBuf.frameLength > 0 {
            body(UnsafeBufferPointer(start: out, count: Int(outBuf.frameLength) * channels))
        }
    }
}
