import Foundation
import AVFoundation
import CoreMedia

/// Камера: один `AVCaptureSession` на устройство, кадры раздаются всем потокам, которые
/// его открыли (превью в окне выбора + звонок) — AVFoundation отдаёт устройство одному
/// сеансу, второй сеанс на ту же камеру получил бы ошибку или отнял бы её у первого.
/// У каждого потока свой `H264Encoder` своего размера: VideoToolbox масштабирует сам.
final class CameraHub: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    struct Subscriber {
        let stream: UInt32
        let encoder: H264Encoder
        let width: Int
        let height: Int
        let fps: Int
        let sender: VideoStreamSender
        let onEnded: (String) -> Void
    }

    let device: AVCaptureDevice
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "com.zali.messenger.media.camera", qos: .userInteractive)
    private let lock = NSLock()
    private var subscribers: [UInt32: Subscriber] = [:]
    private var configured = (width: 0, height: 0, fps: 0)
    private var observers: [NSObjectProtocol] = []

    func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        dropCount += 1
        if dropCount == 1 || dropCount % 100 == 0 {
            let reason = CMGetAttachment(sampleBuffer, key: kCMSampleBufferAttachmentKey_DroppedFrameReason, attachmentModeOut: nil)
            mediaLog("camera: dropped #\(dropCount) reason=\(reason.map { "\($0)" } ?? "?")")
        }
    }
    private var dropCount = 0
    private var capturedFrames = 0
    private var statsWindowStart = Date()
    private var lastHubStats: [String: Any] = [:]

    /// Счётчики потока `stream` (его отправитель) + кадры от камеры за окно (общие для
    /// всех подписчиков: второй подписчик в том же тике получает те же цифры).
    func takeStats(_ stream: UInt32) -> [String: Any] {
        lock.lock()
        let sub = subscribers[stream]
        let hub = hubStatsLocked()
        lock.unlock()
        var out = sub?.sender.takeStats() ?? [:]
        out["width"] = sub?.width ?? 0
        out["height"] = sub?.height ?? 0
        for (k, v) in hub { out[k] = v }
        return out
    }

    private func hubStatsLocked() -> [String: Any] {
        let seconds = Date().timeIntervalSince(statsWindowStart)
        if seconds < 1, !lastHubStats.isEmpty { return lastHubStats }
        let out: [String: Any] = [
            "camera_fps": (Double(capturedFrames) / max(seconds, 0.001) * 10).rounded() / 10,
            "camera_dropped_total": dropCount,
            "camera_format": "\(configured.width)x\(configured.height)@\(configured.fps)",
            "subscribers": subscribers.count,
        ]
        capturedFrames = 0
        statsWindowStart = Date()
        lastHubStats = out
        return out
    }

    init(device: AVCaptureDevice) {
        self.device = device
        super.init()
    }

    static func videoDevices() -> [AVCaptureDevice] {
        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        if #available(macOS 14.0, *) {
            types.append(.external)
            types.append(.continuityCamera)
        } else {
            types.append(.externalUnknown)
        }
        return AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified).devices
    }

    static func authorize() throws {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return
        case .notDetermined:
            let sem = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .video) { ok in granted = ok; sem.signal() }
            _ = sem.wait(timeout: .now() + 120)
            if !granted { throw MediaError.permission("нет доступа к камере") }
        default:
            throw MediaError.permission("нет доступа к камере (Системные настройки → Конфиденциальность → Камера)")
        }
    }

    var isEmpty: Bool {
        lock.lock(); defer { lock.unlock() }
        return subscribers.isEmpty
    }

    /// Готовит формат устройства под ещё один поток `width`×`height`@`fps`; возвращает
    /// размер кадров, которые будет отдавать камера.
    func prepare(width: Int, height: Int, fps: Int) throws -> (width: Int, height: Int) {
        lock.lock()
        var wanted = wantedFormat()
        lock.unlock()
        wanted = (max(wanted.width, width), max(wanted.height, height), max(wanted.fps, fps))
        try configure(width: wanted.width, height: wanted.height, fps: wanted.fps)
        return (configured.width, configured.height)
    }

    func add(_ sub: Subscriber) throws {
        lock.lock()
        subscribers[sub.stream] = sub
        lock.unlock()
        if !session.isRunning {
            observe()
            // На macOS сеанс при старте применяет свой пресет и сбрасывает activeFormat;
            // устройство, запертое на конфигурацию на время startRunning, сохраняет наш.
            let locked = (try? device.lockForConfiguration()) != nil
            if locked { applyChosenFormat() }
            session.startRunning()
            if locked { device.unlockForConfiguration() }
            if !session.isRunning {
                lock.lock(); subscribers.removeValue(forKey: sub.stream); lock.unlock()
                throw MediaError.busy("камера занята или недоступна")
            }
            mediaLog("camera: session started device=\(device.localizedName) \(configured.width)x\(configured.height)@\(configured.fps)")
        }
        sub.encoder.requestKeyframe()
    }

    /// true — подписчиков не осталось, сеанс остановлен.
    @discardableResult
    func remove(_ stream: UInt32) -> Bool {
        lock.lock()
        let sub = subscribers.removeValue(forKey: stream)
        let empty = subscribers.isEmpty
        lock.unlock()
        sub?.encoder.invalidate()
        if empty {
            for o in observers { NotificationCenter.default.removeObserver(o) }
            observers.removeAll()
            if session.isRunning { session.stopRunning() }
            mediaLog("camera: session stopped device=\(device.localizedName)")
        }
        return empty
    }

    func requestKeyframe(_ stream: UInt32) {
        lock.lock(); let sub = subscribers[stream]; lock.unlock()
        sub?.encoder.requestKeyframe()
    }

    private func wantedFormat() -> (width: Int, height: Int, fps: Int) {
        var w = 0, h = 0, f = 0
        for s in subscribers.values {
            w = max(w, s.width); h = max(h, s.height); f = max(f, s.fps)
        }
        return (w, h, f)
    }

    /// Формат устройства: самый маленький, что не меньше запрошенного (иначе самый
    /// большой), с нужной частотой. Пересобирается, только если запрос вырос.
    private func configure(width: Int, height: Int, fps: Int) throws {
        let width = max(width, 320), height = max(height, 180), fps = max(fps, 15)
        if configured.width >= width && configured.height >= height && configured.fps >= fps { return }
        let formats = device.formats.filter { f in
            f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= Double(fps) - 0.5 }
        }
        let pool = formats.isEmpty ? device.formats : formats
        func dims(_ f: AVCaptureDevice.Format) -> (Int, Int) {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            return (Int(d.width), Int(d.height))
        }
        let bigEnough = pool.filter { let d = dims($0); return d.0 >= width && d.1 >= height }
        let chosen = bigEnough.min { let a = dims($0), b = dims($1); return a.0 * a.1 < b.0 * b.1 }
            ?? pool.max { let a = dims($0), b = dims($1); return a.0 * a.1 < b.0 * b.1 }
        guard let format = chosen else { throw MediaError.unsupported("у камеры нет подходящего формата") }

        session.beginConfiguration()
        var committed = false
        defer { if !committed { session.commitConfiguration() } }
        if session.inputs.isEmpty {
            let input: AVCaptureDeviceInput
            do { input = try AVCaptureDeviceInput(device: device) } catch {
                throw MediaError.busy("камера: \(error.localizedDescription)")
            }
            guard session.canAddInput(input) else { throw MediaError.busy("камера занята") }
            session.addInput(input)
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: queue)
            guard session.canAddOutput(output) else { throw MediaError.failed("камера: нельзя добавить выход") }
            session.addOutput(output)
        }
        chosenFormat = format
        let range = format.videoSupportedFrameRateRanges.max { $0.maxFrameRate < $1.maxFrameRate }
        let target = min(Double(fps), range?.maxFrameRate ?? Double(fps))
        chosenDuration = (range.map { target >= $0.minFrameRate } ?? false)
            ? CMTime(value: 1000, timescale: CMTimeScale(target * 1000)) : nil
        // Размер кадров задаёт выход (на macOS AVCaptureVideoDataOutput масштабирует сам):
        // пресет сеанса может перебить activeFormat — 2026-11-12 при запросе 1280×720 камера
        // отдавала 1920×1080.
        let d = dims(format)
        let (ow, oh) = fitVideoSize(sourceWidth: d.0, sourceHeight: d.1, maxWidth: width, maxHeight: height)
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: ow,
            kCVPixelBufferHeightKey as String: oh,
        ]
        if configured.width != 0 { mediaLog("camera: reconfigure \(configured.width)x\(configured.height)@\(configured.fps) -> \(ow)x\(oh)@\(fps)") }
        configured = (ow, oh, fps)
        // Идущий сеанс: формат и частоту — после commitConfiguration, иначе коммит
        // сбрасывает длительность кадра и камера в полутьме падает до ~17 к/с.
        if session.isRunning {
            session.commitConfiguration()
            committed = true
            do {
                try device.lockForConfiguration()
                applyChosenFormat()
                device.unlockForConfiguration()
            } catch {
                mediaLog("camera: lockForConfiguration failed \(error)")
            }
        }
    }

    private var chosenFormat: AVCaptureDevice.Format?
    private var chosenDuration: CMTime?

    /// Под замком конфигурации устройства.
    private func applyChosenFormat() {
        if let chosenFormat { device.activeFormat = chosenFormat }
        if let chosenDuration {
            device.activeVideoMinFrameDuration = chosenDuration
            device.activeVideoMaxFrameDuration = chosenDuration
        }
    }

    private func observe() {
        guard observers.isEmpty else { return }
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .AVCaptureDeviceWasDisconnected, object: device, queue: nil) { [weak self] _ in
            self?.endAll("device-lost")
        })
        observers.append(nc.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: nil) { [weak self] note in
            let err = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
            mediaLog("camera: runtime error \(err?.localizedDescription ?? "?")")
            self?.endAll("error")
        })
    }

    private func endAll(_ reason: String) {
        lock.lock()
        let subs = Array(subscribers.values)
        lock.unlock()
        for s in subs { s.onEnded(reason) }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        lock.lock()
        let subs = Array(subscribers.values)
        capturedFrames += 1
        lock.unlock()
        for s in subs { s.encoder.encode(pixelBuffer, pts: pts) }
    }
}

/// Размер кадра для энкодера: не больше запрошенного и не больше источника, с
/// сохранением пропорций источника, обе стороны чётные.
func fitVideoSize(sourceWidth: Int, sourceHeight: Int, maxWidth: Int, maxHeight: Int) -> (Int, Int) {
    guard sourceWidth > 0, sourceHeight > 0 else { return (max(2, maxWidth & ~1), max(2, maxHeight & ~1)) }
    var scale = 1.0
    if maxWidth > 0 { scale = min(scale, Double(maxWidth) / Double(sourceWidth)) }
    if maxHeight > 0 { scale = min(scale, Double(maxHeight) / Double(sourceHeight)) }
    let w = max(2, Int((Double(sourceWidth) * scale).rounded()) & ~1)
    let h = max(2, Int((Double(sourceHeight) * scale).rounded()) & ~1)
    return (w, h)
}
