import Foundation
import CoreAudio

/// Перечисление устройств Core Audio (HAL) — только чтение свойств, без открытия IO.
enum AudioDevices {
    struct Device {
        let id: AudioObjectID
        let uid: String
        let name: String
    }

    static func address(_ selector: AudioObjectPropertySelector,
                        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                        element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }

    static func allDeviceIDs() -> [AudioObjectID] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
        var addr = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let v = value else { return "" }
        return v.takeRetainedValue() as String
    }

    static func inputChannelCount(_ id: AudioObjectID) -> Int {
        var addr = address(kAudioDevicePropertyStreamConfiguration, scope: kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func defaultInput() -> AudioObjectID {
        var addr = address(kAudioHardwarePropertyDefaultInputDevice)
        var id = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return id
    }

    static func isAlive(_ id: AudioObjectID) -> Bool {
        var addr = address(kAudioDevicePropertyDeviceIsAlive)
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &alive) == noErr else { return false }
        return alive != 0
    }

    static func nominalSampleRate(_ id: AudioObjectID) -> Double {
        var addr = address(kAudioDevicePropertyNominalSampleRate)
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &rate)
        return rate
    }

    /// Устройства ввода, кроме наших приватных агрегатов (process tap) и самих тапов.
    static func inputDevices() -> [Device] {
        allDeviceIDs().compactMap { id in
            guard inputChannelCount(id) > 0 else { return nil }
            let uid = string(id, kAudioDevicePropertyDeviceUID)
            if uid.isEmpty || uid.hasPrefix("com.zali.messenger.") { return nil }
            let name = string(id, kAudioObjectPropertyName)
            return Device(id: id, uid: uid, name: name.isEmpty ? uid : name)
        }
    }

    static func device(forUID uid: String) -> AudioObjectID? {
        inputDevices().first { $0.uid == uid }?.id
    }
}

/// Подписка на свойство объекта Core Audio с блоком; снимается в `cancel()`/deinit.
final class AudioPropertyListener {
    private let object: AudioObjectID
    private var addr: AudioObjectPropertyAddress
    private let queue: DispatchQueue
    private let block: AudioObjectPropertyListenerBlock
    private var active = false

    init(object: AudioObjectID, selector: AudioObjectPropertySelector, queue: DispatchQueue, handler: @escaping () -> Void) {
        self.object = object
        self.addr = AudioDevices.address(selector)
        self.queue = queue
        self.block = { _, _ in handler() }
        active = AudioObjectAddPropertyListenerBlock(object, &addr, queue, block) == noErr
    }

    func cancel() {
        guard active else { return }
        active = false
        AudioObjectRemovePropertyListenerBlock(object, &addr, queue, block)
    }

    deinit { cancel() }
}
