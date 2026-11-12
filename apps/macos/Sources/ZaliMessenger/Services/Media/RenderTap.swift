import Foundation
import CoreAudio
import AudioToolbox
import AVFAudio

// Core Audio process taps (macOS 14.2+): опорный сигнал эхоподавителя (`RenderTap`) и
// звук системы при показе экрана (`ScreenAudioTap`). Оба — global tap в приватном
// агрегате, где тап — единственный вход. Проверено 2026-11-12: такой тап не приглушает
// другие приложения и не пересобирает устройство вывода (в отличие от VoiceProcessingIO).
// Нужен ключ `NSAudioCaptureUsageDescription` (build_app.sh) — система один раз
// спрашивает доступ «запись звука системы».

/// Процесс-объекты Core Audio (kAudioHardwarePropertyProcessObjectList).
enum AudioProcesses {
    struct Process {
        let object: AudioObjectID
        let pid: pid_t
        let bundleID: String
    }

    private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
    private static let responsibleFn: ResponsibleFn? = {
        guard let handle = dlopen(nil, RTLD_NOW),
              let sym = dlsym(handle, "responsibility_get_pid_responsible_for_pid") else { return nil }
        return unsafeBitCast(sym, to: ResponsibleFn.self)
    }()

    /// «Ответственный» процесс: для XPC-сервисов WebKit — приложение-хозяин (если оно
    /// запущено как приложение, а не из терминала). -1 — неизвестно.
    static func responsiblePID(_ pid: pid_t) -> pid_t { responsibleFn?(pid) ?? -1 }

    static func list() -> [Process] {
        var addr = AudioDevices.address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.map { id in
            var a = AudioDevices.address(kAudioProcessPropertyPID)
            var pid: pid_t = -1
            var sz = UInt32(MemoryLayout<pid_t>.size)
            AudioObjectGetPropertyData(id, &a, 0, nil, &sz, &pid)
            return Process(object: id, pid: pid, bundleID: AudioDevices.string(id, kAudioProcessPropertyBundleID))
        }
    }
}

/// Один process tap + приватный агрегат + IOProc. Отдаёт чередующиеся f32 на частоте тапа.
@available(macOS 14.2, *)
final class AudioTapIO {
    private let description: CATapDescription
    private let onAudio: (UnsafePointer<Float>, Int, Int) -> Void
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private(set) var sampleRate: Double = 48_000
    private(set) var channels = 2
    private var interleavedInput = false
    private var scratch = [Float](repeating: 0, count: 32_768)
    private let queue: DispatchQueue

    /// `onAudio(samples, frames, channels)` — на потоке IOProc.
    init(description: CATapDescription, label: String, onAudio: @escaping (UnsafePointer<Float>, Int, Int) -> Void) {
        self.description = description
        self.onAudio = onAudio
        self.queue = DispatchQueue(label: "com.zali.messenger.media.tap.\(label)", qos: .userInteractive)
        description.isPrivate = true
        description.muteBehavior = .unmuted
    }

    func start() throws {
        var tap = AudioObjectID(kAudioObjectUnknown)
        var err = AudioHardwareCreateProcessTap(description, &tap)
        guard err == noErr, tap != kAudioObjectUnknown else {
            throw MediaError.permission("AudioHardwareCreateProcessTap \(err)")
        }
        tapID = tap

        var addr = AudioDevices.address(kAudioTapPropertyFormat)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        err = AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd)
        guard err == noErr, asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else {
            stop()
            throw MediaError.failed("tap format err=\(err) id=\(asbd.mFormatID) flags=\(asbd.mFormatFlags)")
        }
        sampleRate = asbd.mSampleRate
        channels = Int(max(asbd.mChannelsPerFrame, 1))
        interleavedInput = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0

        let dict: [String: Any] = [
            kAudioAggregateDeviceNameKey: "ZaliMessenger \(description.name)",
            kAudioAggregateDeviceUIDKey: "com.zali.messenger.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true],
            ],
        ]
        var aggregate = AudioObjectID(kAudioObjectUnknown)
        err = AudioHardwareCreateAggregateDevice(dict as CFDictionary, &aggregate)
        guard err == noErr, aggregate != kAudioObjectUnknown else {
            stop()
            throw MediaError.failed("AudioHardwareCreateAggregateDevice \(err)")
        }
        aggregateID = aggregate

        var procID: AudioDeviceIOProcID?
        err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, inInputData, _, _, _ in
            self?.handle(inInputData)
        }
        guard err == noErr, let procID else {
            stop()
            throw MediaError.failed("AudioDeviceCreateIOProcIDWithBlock \(err)")
        }
        ioProcID = procID
        err = AudioDeviceStart(aggregateID, procID)
        guard err == noErr else {
            stop()
            throw MediaError.failed("AudioDeviceStart \(err)")
        }
    }

    /// Сменить список процессов тапа на ходу (kAudioTapPropertyDescription).
    func setProcesses(_ objects: [AudioObjectID]) {
        guard tapID != kAudioObjectUnknown else { return }
        description.processes = objects
        var addr = AudioDevices.address(kAudioTapPropertyDescription)
        var desc: CATapDescription = description
        let err = withUnsafeMutablePointer(to: &desc) { ptr in
            AudioObjectSetPropertyData(tapID, &addr, 0, nil, UInt32(MemoryLayout<CATapDescription>.size), ptr)
        }
        if err != noErr { mediaLog("tap: update processes failed \(err)") }
    }

    private func handle(_ input: UnsafePointer<AudioBufferList>) {
        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard list.count > 0 else { return }
        if interleavedInput {
            let buf = list[0]
            let ch = max(Int(buf.mNumberChannels), 1)
            let frames = Int(buf.mDataByteSize) / (4 * ch)
            guard frames > 0, let data = buf.mData?.assumingMemoryBound(to: Float.self) else { return }
            onAudio(data, frames, ch)
            return
        }
        let frames = Int(list[0].mDataByteSize) / 4
        let ch = list.count
        guard frames > 0, ch > 0 else { return }
        if scratch.count < frames * ch { scratch = [Float](repeating: 0, count: frames * ch) }
        for c in 0..<ch {
            guard let data = list[c].mData?.assumingMemoryBound(to: Float.self), Int(list[c].mDataByteSize) / 4 >= frames else {
                for i in 0..<frames { scratch[i * ch + c] = 0 }
                continue
            }
            for i in 0..<frames { scratch[i * ch + c] = data[i] }
        }
        scratch.withUnsafeBufferPointer { onAudio($0.baseAddress!, frames, ch) }
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown, let ioProcID {
            AudioDeviceStop(aggregateID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
        }
        ioProcID = nil
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}

/// Опорный сигнал для эхоподавителя: всё, что сейчас играет в системе, моно 48 кГц.
///
/// Именно глобальный тап, а не тап своего процесса: голос собеседников играет процесс
/// WebKit GPU. На macOS 13 и при отказе в доступе тапа нет — AEC без опорного сигнала
/// ничего не вычитает, NS и AGC работают как обычно.
final class RenderTap {
    static let shared = RenderTap()

    private let lock = NSLock()
    private var sinks: [ObjectIdentifier: ApmHandle] = [:]
    private var running = false
    private var status = "off"
    private var impl: AnyObject?
    private var mono = [Float](repeating: 0, count: 16_384)
    private var resampler: PCMResampler?

    /// Подключить обработчик к опорному сигналу (тап поднимается при первом).
    func attach(_ apm: ApmHandle) {
        lock.lock()
        sinks[ObjectIdentifier(apm)] = apm
        let needStart = !running
        if needStart { running = true }
        lock.unlock()
        if needStart { startTap() }
    }

    func detach(_ apm: ApmHandle) {
        lock.lock()
        sinks.removeValue(forKey: ObjectIdentifier(apm))
        let needStop = running && sinks.isEmpty
        if needStop { running = false }
        lock.unlock()
        if needStop { stopTap() }
    }

    private func deliver(_ samples: UnsafePointer<Float>, frames: Int, channels: Int, rate: Double) {
        if mono.count < frames { mono = [Float](repeating: 0, count: frames) }
        let scale = 1 / Float(channels)
        for i in 0..<frames {
            var s: Float = 0
            for c in 0..<channels { s += samples[i * channels + c] }
            mono[i] = s * scale
        }
        if resampler == nil || resampler!.inputRate != rate { resampler = PCMResampler(channels: 1, inputRate: rate) }
        mono.withUnsafeBufferPointer { all in
            resampler!.process(UnsafeBufferPointer(rebasing: all[0..<frames])) { out in
                guard let base = out.baseAddress else { return }
                lock.lock()
                for apm in sinks.values where apm.aec {
                    apm.pushRender(base, frames: out.count, channels: 1)
                }
                lock.unlock()
            }
        }
    }

    private func startTap() {
        guard #available(macOS 14.2, *) else {
            lock.lock(); status = "unsupported-os"; lock.unlock()
            mediaLog("render tap: macOS < 14.2, AEC without reference")
            return
        }
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "echo reference"
        weak var tapRef: AudioTapIO?
        let tap = AudioTapIO(description: description, label: "render") { [weak self] samples, frames, ch in
            self?.deliver(samples, frames: frames, channels: ch, rate: tapRef?.sampleRate ?? 48_000)
        }
        tapRef = tap
        do {
            try tap.start()
            lock.lock(); impl = tap; status = "tap"; lock.unlock()
            mediaLog("render tap: started rate=\(Int(tap.sampleRate)) ch=\(tap.channels)")
        } catch {
            let message = (error as? MediaError)?.message ?? "\(error)"
            lock.lock(); status = "failed: \(message)"; lock.unlock()
            mediaLog("render tap: start failed \(message)")
        }
    }

    private func stopTap() {
        lock.lock()
        let tap = impl
        impl = nil
        status = "off"
        lock.unlock()
        if #available(macOS 14.2, *), let tap = tap as? AudioTapIO {
            tap.stop()
            mediaLog("render tap: stopped")
        }
    }

    var currentStatus: String {
        lock.lock(); defer { lock.unlock() }
        return status
    }
}

/// Звук системы для показа экрана: всё, что играет, КРОМЕ процессов этого приложения.
///
/// Почему не звук `SCStream` с `excludesCurrentProcessAudio`: голоса собеседников играет
/// процесс WebKit GPU, а не наш, и ScreenCaptureKit его не исключает (стенд 2026-11-12:
/// тон, сыгранный страницей, приходил в захват на −16 дБ при фоне −39 дБ — собеседники
/// слышали бы себя). ScreenCaptureKit не видит этот процесс и как приложение, поэтому
/// исключить его фильтром нельзя. Core Audio видит: процесс-объекты нашего pid, pid из
/// `ownHelperPIDs` (WKWebView `_gpuProcessIdentifier`) и всех, за кого «отвечает» наше
/// приложение. Список обновляется на ходу — GPU-процесс WebKit поднимается лениво и
/// может перезапуститься.
@available(macOS 14.2, *)
final class ScreenAudioTap {
    /// pid вспомогательных процессов WebKit этого приложения (зовётся с любого потока).
    static var ownHelperPIDs: (() -> [pid_t])?

    private let stream: UInt32
    private let bridge: MediaBridgeServer
    private var tap: AudioTapIO?
    private var resampler: PCMResampler?
    private var seq: UInt32 = 0
    private var nextTimestamp: UInt64 = 0
    private var excluded: [AudioObjectID] = []
    private var listener: AudioPropertyListener?
    private let controlQueue = DispatchQueue(label: "com.zali.messenger.media.screenaudio")

    init(stream: UInt32, bridge: MediaBridgeServer) {
        self.stream = stream
        self.bridge = bridge
    }

    static func ownProcessObjects() -> [AudioObjectID] {
        let me = getpid()
        let helpers = Set(ownHelperPIDs?() ?? [])
        return AudioProcesses.list().filter { p in
            p.pid == me || helpers.contains(p.pid) || AudioProcesses.responsiblePID(p.pid) == me
        }.map { $0.object }
    }

    func start() throws {
        excluded = ScreenAudioTap.ownProcessObjects()
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        description.name = "screen audio"
        weak var tapRef: AudioTapIO?
        let tap = AudioTapIO(description: description, label: "screen") { [weak self] samples, frames, ch in
            self?.deliver(samples, frames: frames, channels: ch, rate: tapRef?.sampleRate ?? 48_000)
        }
        tapRef = tap
        try tap.start()
        self.tap = tap
        listener = AudioPropertyListener(object: AudioObjectID(kAudioObjectSystemObject),
                                         selector: kAudioHardwarePropertyProcessObjectList, queue: controlQueue) { [weak self] in
            self?.refreshExcluded()
        }
        mediaLog("screen audio tap: started stream=\(stream) rate=\(Int(tap.sampleRate)) excluded=\(excluded.count)")
    }

    private func refreshExcluded() {
        let now = ScreenAudioTap.ownProcessObjects()
        guard Set(now) != Set(excluded) else { return }
        excluded = now
        tap?.setProcesses(now)
        mediaLog("screen audio tap: excluded processes updated count=\(now.count)")
    }

    private func deliver(_ samples: UnsafePointer<Float>, frames: Int, channels: Int, rate: Double) {
        if resampler == nil || resampler!.inputRate != rate { resampler = PCMResampler(channels: 2, inputRate: rate) }
        // К стерео: моно — дублируем, больше двух — берём первые два.
        var stereo = [Float](repeating: 0, count: frames * 2)
        for i in 0..<frames {
            let l = samples[i * channels]
            stereo[2 * i] = l
            stereo[2 * i + 1] = channels > 1 ? samples[i * channels + 1] : l
        }
        if nextTimestamp == 0 { nextTimestamp = MediaClock.nowMicros() }
        stereo.withUnsafeBufferPointer { input in
            resampler!.process(input) { out in
                let total = out.count / 2
                var offset = 0
                while offset < total {
                    let n = min(480, total - offset)
                    seq &+= 1
                    let frame = MediaFrame.audio(stream: stream, timestampMicros: nextTimestamp, seq: seq, channels: 2,
                                                 samples: UnsafeBufferPointer(rebasing: out[(offset * 2)..<((offset + n) * 2)]))
                    bridge.send(frame)
                    nextTimestamp &+= UInt64(n) * 1_000_000 / 48_000
                    offset += n
                }
            }
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        tap?.stop()
        tap = nil
        mediaLog("screen audio tap: stopped stream=\(stream)")
    }
}
