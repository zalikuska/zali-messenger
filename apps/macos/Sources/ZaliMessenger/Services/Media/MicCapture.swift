import Foundation
import CoreAudio
import AudioToolbox
import os

/// Микрофон без системной голосовой обработки.
///
/// AUHAL (`kAudioUnitSubType_HALOutput`) только на вход — обычный HAL-клиент устройства.
/// **Никакого `kAudioUnitSubType_VoiceProcessingIO` и `setVoiceProcessingEnabled`**: именно
/// VoiceProcessingIO на каждый вход в звонок приглушал все приложения на 15 дБ и
/// пересобирал устройство вывода (журнал macOS 2026-11-12, `AudioDeviceDuck`). Эхо, шум и
/// громкость — наш `ApmHandle` (core, AEC3 → RNNoise → AGC2) с опорным сигналом из
/// `RenderTap`.
///
/// Выход — 48 кГц моно f32 блоками по 10 мс. AUHAL на входе не меняет частоту, поэтому
/// при устройстве на 44.1/96 кГц — `PCMResampler`.
final class MicCapture {
    let stream: UInt32
    private let requestedUID: String
    private let bridge: MediaBridgeServer
    private let apm: ApmHandle
    private let processingQueue = DispatchQueue(label: "com.zali.messenger.media.mic", qos: .userInteractive)

    private var unit: AudioUnit?
    private(set) var deviceID = AudioObjectID(0)
    private(set) var deviceUID = ""
    private(set) var deviceName = ""
    private(set) var deviceRate: Double = 48_000
    private var resampler: PCMResampler?
    private var renderBuffer = [Float](repeating: 0, count: 8192)
    private var pending: [Float] = []
    private var seq: UInt32 = 0
    private var nextTimestamp: UInt64 = 0
    private var aliveListener: AudioPropertyListener?
    private var defaultListener: AudioPropertyListener?
    private var rateListener: AudioPropertyListener?
    private var stopped = false
    private let stateLock = NSLock()

    // Поток ввода Core Audio — реального времени: там нельзя ни выделять память, ни
    // ждать NSLock, ни ставить closure в очередь (каждое — риск не успеть за 10 мс и
    // потерять буфер, т. е. щелчок в голосе). Он только кладёт отсчёты в заранее
    // выделенное кольцо под os_unfair_lock (короткий, с передачей приоритета) и
    // дёргает DispatchSource (merge_data без выделений); разбор — на processingQueue.
    private static let ringCapacity = 1 << 16 // ≈1.4 с при 48 кГц
    private let ring = UnsafeMutablePointer<Float>.allocate(capacity: MicCapture.ringCapacity)
    private var ringRead = 0
    private var ringWrite = 0
    private var ringFirstHost: UInt64 = 0
    private var ringOverflows = 0
    private let rtLock: UnsafeMutablePointer<os_unfair_lock> = {
        let p = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        p.initialize(to: os_unfair_lock())
        return p
    }()
    /// AudioUnit для потока ввода — под rtLock (open/close меняют его на processingQueue).
    private var rtUnit: AudioUnit?
    private var drainSource: DispatchSourceUserDataAdd?
    private var drainScratch = [Float](repeating: 0, count: MicCapture.ringCapacity)

    /// Источник пропал (устройство отключили) — поток закончен.
    var onEnded: ((String) -> Void)?

    init(stream: UInt32, deviceUID: String, processing: (aec: Bool, ns: Bool, agc: Bool), bridge: MediaBridgeServer) {
        self.stream = stream
        self.requestedUID = deviceUID
        self.bridge = bridge
        self.apm = ApmHandle(aec: processing.aec, ns: processing.ns, agc: processing.agc)
    }

    var followsDefault: Bool { requestedUID.isEmpty }

    func start() throws {
        let id: AudioObjectID
        if requestedUID.isEmpty {
            id = AudioDevices.defaultInput()
            guard id != 0 else { throw MediaError.notFound("нет устройства ввода по умолчанию") }
        } else {
            guard let found = AudioDevices.device(forUID: requestedUID) else {
                throw MediaError.notFound("микрофон \(requestedUID) не найден")
            }
            id = found
        }
        let source = DispatchSource.makeUserDataAddSource(queue: processingQueue)
        source.setEventHandler { [weak self] in self?.drainRing() }
        source.resume()
        drainSource = source
        try open(device: id)
        if apm.aec { RenderTap.shared.attach(apm) }
        if followsDefault {
            defaultListener = AudioPropertyListener(object: AudioObjectID(kAudioObjectSystemObject),
                                                    selector: kAudioHardwarePropertyDefaultInputDevice,
                                                    queue: processingQueue) { [weak self] in
                self?.defaultInputChanged()
            }
        }
    }

    private func open(device id: AudioObjectID) throws {
        var desc = AudioComponentDescription(componentType: kAudioUnitType_Output,
                                             componentSubType: kAudioUnitSubType_HALOutput,
                                             componentManufacturer: kAudioUnitManufacturer_Apple,
                                             componentFlags: 0, componentFlagsMask: 0)
        guard let comp = AudioComponentFindNext(nil, &desc) else { throw MediaError.failed("AUHAL не найден") }
        var newUnit: AudioUnit?
        var err = AudioComponentInstanceNew(comp, &newUnit)
        guard err == noErr, let au = newUnit else { throw MediaError.failed("AudioComponentInstanceNew \(err)") }
        var ok = false
        defer { if !ok { AudioComponentInstanceDispose(au) } }

        var one: UInt32 = 1
        var zero: UInt32 = 0
        let u32 = UInt32(MemoryLayout<UInt32>.size)
        err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, u32)
        guard err == noErr else { throw MediaError.failed("EnableIO input \(err)") }
        err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &zero, u32)
        guard err == noErr else { throw MediaError.failed("EnableIO output \(err)") }
        var dev = id
        err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev,
                                   UInt32(MemoryLayout<AudioObjectID>.size))
        guard err == noErr else { throw MediaError.busy("CurrentDevice \(err)") }

        var hw = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        err = AudioUnitGetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hw, &size)
        guard err == noErr, hw.mSampleRate > 0 else { throw MediaError.failed("hw format \(err)") }

        var client = AudioStreamBasicDescription(
            mSampleRate: hw.mSampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1,
            mBitsPerChannel: 32, mReserved: 0)
        err = AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client,
                                   UInt32(MemoryLayout<AudioStreamBasicDescription>.size))
        guard err == noErr else { throw MediaError.failed("client format \(err)") }

        var maxFrames: UInt32 = 0
        size = u32
        if AudioUnitGetProperty(au, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, &size) == noErr,
           Int(maxFrames) > renderBuffer.count {
            renderBuffer = [Float](repeating: 0, count: Int(maxFrames))
        }

        var cb = AURenderCallbackStruct(inputProc: micInputProc, inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &cb,
                                   UInt32(MemoryLayout<AURenderCallbackStruct>.size))
        guard err == noErr else { throw MediaError.failed("SetInputCallback \(err)") }

        err = AudioUnitInitialize(au)
        guard err == noErr else { throw MediaError.busy("AudioUnitInitialize \(err)") }

        deviceID = id
        deviceUID = AudioDevices.string(id, kAudioDevicePropertyDeviceUID)
        deviceName = AudioDevices.string(id, kAudioObjectPropertyName)
        deviceRate = hw.mSampleRate
        let newResampler = PCMResampler(channels: 1, inputRate: hw.mSampleRate)
        stateLock.lock(); resampler = newResampler; stateLock.unlock()

        stateLock.lock(); unit = au; stateLock.unlock()
        os_unfair_lock_lock(rtLock); rtUnit = au; os_unfair_lock_unlock(rtLock)
        err = AudioOutputUnitStart(au)
        guard err == noErr else {
            stateLock.lock(); unit = nil; stateLock.unlock()
            os_unfair_lock_lock(rtLock); rtUnit = nil; os_unfair_lock_unlock(rtLock)
            AudioUnitUninitialize(au)
            throw MediaError.busy("AudioOutputUnitStart \(err)")
        }
        ok = true
        aliveListener = AudioPropertyListener(object: id, selector: kAudioDevicePropertyDeviceIsAlive, queue: processingQueue) { [weak self] in
            guard let self, !AudioDevices.isAlive(id) else { return }
            if self.followsDefault { return } // сменится устройство по умолчанию — переоткроемся там
            mediaLog("mic: device lost stream=\(self.stream)")
            self.onEnded?("device-lost")
        }
        rateListener = AudioPropertyListener(object: id, selector: kAudioDevicePropertyNominalSampleRate, queue: processingQueue) { [weak self] in
            guard let self, abs(AudioDevices.nominalSampleRate(id) - self.deviceRate) > 1 else { return }
            mediaLog("mic: device rate changed, reopening stream=\(self.stream)")
            self.reopen(device: id)
        }
        mediaLog("mic: started stream=\(stream) device=\(deviceName) rate=\(Int(hw.mSampleRate)) hwch=\(hw.mChannelsPerFrame) aec=\(apm.aec) ns=\(apm.ns) agc=\(apm.agc)")
    }

    private func closeUnit() {
        aliveListener?.cancel(); aliveListener = nil
        rateListener?.cancel(); rateListener = nil
        stateLock.lock()
        let au = unit
        unit = nil
        stateLock.unlock()
        os_unfair_lock_lock(rtLock); rtUnit = nil; os_unfair_lock_unlock(rtLock)
        if let au {
            AudioOutputUnitStop(au)
            AudioUnitUninitialize(au)
            AudioComponentInstanceDispose(au)
        }
    }

    private func reopen(device id: AudioObjectID) {
        guard !stopped else { return }
        closeUnit()
        do {
            try open(device: id)
        } catch {
            mediaLog("mic: reopen failed \(error)")
            onEnded?("device-lost")
        }
    }

    private func defaultInputChanged() {
        guard !stopped, followsDefault else { return }
        let id = AudioDevices.defaultInput()
        guard id != 0, id != deviceID else { return }
        mediaLog("mic: default input changed, switching stream=\(stream)")
        reopen(device: id)
    }

    fileprivate func render(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
                            _ ts: UnsafePointer<AudioTimeStamp>, _ bus: UInt32, _ frames: UInt32) -> OSStatus {
        os_unfair_lock_lock(rtLock)
        let au = rtUnit
        os_unfair_lock_unlock(rtLock)
        guard let au else { return noErr }
        let n = Int(frames)
        if n > renderBuffer.count { return kAudioUnitErr_TooManyFramesToProcess }
        let status: OSStatus = renderBuffer.withUnsafeMutableBufferPointer { buf in
            var abl = AudioBufferList(mNumberBuffers: 1,
                                      mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 4),
                                                            mData: UnsafeMutableRawPointer(buf.baseAddress)))
            let st = AudioUnitRender(au, flags, ts, bus, frames, &abl)
            guard st == noErr, let src = buf.baseAddress else { return st }
            let host = ts.pointee.mFlags.contains(.hostTimeValid) ? ts.pointee.mHostTime : mach_absolute_time()
            let cap = MicCapture.ringCapacity
            os_unfair_lock_lock(rtLock)
            if ringFirstHost == 0 { ringFirstHost = host }
            let free = cap - (ringWrite - ringRead)
            let count = min(n, free)
            if count < n { ringOverflows += 1 }
            for i in 0..<count { ring[(ringWrite + i) & (cap - 1)] = src[i] }
            ringWrite += count
            os_unfair_lock_unlock(rtLock)
            return noErr
        }
        guard status == noErr else { return status }
        drainSource?.add(data: 1)
        return noErr
    }

    /// processingQueue: забрать всё накопленное в кольце и обработать.
    private func drainRing() {
        let cap = MicCapture.ringCapacity
        os_unfair_lock_lock(rtLock)
        let count = ringWrite - ringRead
        for i in 0..<count { drainScratch[i] = ring[(ringRead + i) & (cap - 1)] }
        ringRead += count
        let host = ringFirstHost
        let overflows = ringOverflows
        ringOverflows = 0
        os_unfair_lock_unlock(rtLock)
        if overflows > 0 { mediaLog("mic: ring overflow x\(overflows) stream=\(stream) — обработка не успевает") }
        guard count > 0 else { return }
        drainScratch.withUnsafeBufferPointer { process(UnsafeBufferPointer(rebasing: $0[0..<count]), hostTime: host) }
    }

    private func process(_ chunk: UnsafeBufferPointer<Float>, hostTime: UInt64) {
        guard !stopped else { return }
        stateLock.lock(); let resampler = self.resampler; stateLock.unlock()
        let feed: (UnsafeBufferPointer<Float>) -> Void = { block in
            self.apm.process(block, into: &self.pending)
        }
        if let resampler, !resampler.passthrough {
            resampler.process(chunk, feed)
        } else {
            feed(chunk)
        }
        // Метки идут ровно по 10 мс от первого блока: страница кладёт звук в кольцевой
        // буфер и на метки не смотрит, а AudioData (Chromium) нужна монотонность.
        if nextTimestamp == 0 { nextTimestamp = MediaClock.micros(hostTime: hostTime) }
        // По 10 мс (480 отсчётов) на кадр.
        var offset = 0
        while pending.count - offset >= 480 {
            seq &+= 1
            let frame = pending.withUnsafeBufferPointer { all in
                MediaFrame.audio(stream: stream, timestampMicros: nextTimestamp, seq: seq, channels: 1,
                                 samples: UnsafeBufferPointer(rebasing: all[offset..<offset + 480]))
            }
            bridge.send(frame)
            nextTimestamp &+= 10_000
            offset += 480
        }
        if offset > 0 { pending.removeFirst(offset) }
    }

    func setProcessing(aec: Bool, ns: Bool, agc: Bool) {
        processingQueue.async { [self] in
            let hadAec = apm.aec
            apm.setConfig(aec: aec, ns: ns, agc: agc)
            if aec && !hadAec { RenderTap.shared.attach(apm) }
            if !aec && hadAec { RenderTap.shared.detach(apm) }
            mediaLog("mic: processing stream=\(stream) aec=\(aec) ns=\(ns) agc=\(agc)")
        }
    }

    func stats() -> [String: Any] {
        var s = apm.statsJSON()
        s["aec"] = apm.aec
        s["ns"] = apm.ns
        s["agc"] = apm.agc
        // Как у Windows: reference — есть ли опорный сигнал, подробность — reference_status.
        let refStatus = apm.aec ? RenderTap.shared.currentStatus : "off"
        s["reference"] = refStatus == "tap"
        s["reference_status"] = refStatus
        s["device_rate"] = Int(deviceRate)
        s["device"] = deviceName
        s["capture"] = "auhal"
        return s
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        defaultListener?.cancel(); defaultListener = nil
        closeUnit()
        drainSource?.cancel()
        RenderTap.shared.detach(apm)
        processingQueue.async { [self] in pending.removeAll() }
        mediaLog("mic: stopped stream=\(stream)")
    }

    deinit {
        if !stopped { stop() }
        ring.deallocate()
        rtLock.deinitialize(count: 1)
        rtLock.deallocate()
    }
}

private let micInputProc: AURenderCallback = { refCon, flags, ts, bus, frames, _ in
    let capture = Unmanaged<MicCapture>.fromOpaque(refCon).takeUnretainedValue()
    return capture.render(flags, ts, bus, frames)
}
