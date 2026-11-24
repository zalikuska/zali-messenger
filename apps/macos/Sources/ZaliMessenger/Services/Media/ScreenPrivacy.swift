import AppKit
import CoreImage
import CoreVideo
import Metal

/// Скрытые приложения в трансляции экрана (страница — web/src/interface/screen_privacy.js).
///
/// Состояние приходит в `options.privacy` старта захвата и на лету — op `set_privacy`:
/// `{hidingEnabled, style: plate|blur, hiddenApps: [{id: bundleId, name, hideVideo, muteAudio, style?}]}`.
///
/// * Плашка — окна приложения вырезаются из захвата фильтром ScreenCaptureKit
///   (`excludingApplications`) — это жёсткая гарантия, — а поверх места окна рисуется плашка.
/// * Размытие — окно остаётся в кадре, его видимая часть перед кодированием уменьшается
///   до блоков ~1/32 высоты кадра и размывается гауссом на GPU (Core Image): текст
///   нечитаем, «развернуть» размытие нельзя — исходных пикселей в кадре больше нет. Шума
///   нет: шум, свой на каждый кадр, «кипел» и съедал битрейт.
/// * Звук — процессы скрытого приложения исключаются из тапа Core Audio
///   (`ScreenAudioTap`), при звуке `SCStream` (macOS < 14.2) — тем же фильтром.
///
/// Видимая часть окна = его прямоугольник минус окна выше по z-порядку
/// (`CGWindowListCopyWindowInfo`, 20 раз в секунду); между опросами окно могло сдвинуться,
/// поэтому закрывается объединение прошлого и нынешнего положения с полем 6 pt.
final class ScreenPrivacy {
    static let shared = ScreenPrivacy()

    enum Style: String {
        case plate
        case blur
    }

    struct App: Equatable {
        let id: String
        let name: String
        let hideVideo: Bool
        let muteAudio: Bool
        let style: Style?
    }

    struct Snapshot: Equatable {
        var enabled = true
        var style: Style = .plate
        var apps: [App] = []

        func style(of app: App) -> Style { app.style ?? style }
        /// Приложения, чью картинку надо закрыть сейчас (скрытие включено).
        var videoApps: [App] { enabled ? apps.filter { $0.hideVideo } : [] }
        var audioApps: [App] { enabled ? apps.filter { $0.muteAudio } : [] }
        var isActive: Bool { enabled && apps.contains { $0.hideVideo || $0.muteAudio } }
    }

    private let lock = NSLock()
    private var current = Snapshot()
    /// Растёт при каждом изменении состояния и запуске/выходе скрытого приложения: трекер
    /// окон помечает им свой опрос, и кадр с устаревшим опросом закрывается целиком.
    private var generationValue: UInt64 = 1
    private var observers: [UUID: () -> Void] = [:]
    private var workspaceObservers: [NSObjectProtocol] = []

    private init() {
        // Скрытое приложение запустилось/закрылось посреди трансляции — пересобрать фильтр.
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
                guard let self,
                      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                      let bundle = app.bundleIdentifier,
                      self.snapshot().apps.contains(where: { $0.id == bundle }) else { return }
                self.lock.lock(); self.generationValue &+= 1; self.lock.unlock()
                self.notify()
            })
        }
    }

    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    func generation() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        return generationValue
    }

    static func parse(_ dict: [String: Any]?) -> Snapshot? {
        guard let dict else { return nil }
        var s = Snapshot()
        s.enabled = dict["hidingEnabled"] as? Bool ?? true
        s.style = Style(rawValue: dict["style"] as? String ?? "") ?? .plate
        s.apps = ((dict["hiddenApps"] as? [[String: Any]]) ?? []).prefix(64).compactMap { a in
            guard let id = a["id"] as? String, !id.isEmpty else { return nil }
            return App(id: id, name: a["name"] as? String ?? id,
                       hideVideo: a["hideVideo"] as? Bool ?? true,
                       muteAudio: a["muteAudio"] as? Bool ?? true,
                       style: Style(rawValue: a["style"] as? String ?? ""))
        }
        return s
    }

    /// Новое состояние со страницы. Изменилось — идущие захваты перестраиваются на лету.
    func update(_ dict: [String: Any]?) {
        guard let next = ScreenPrivacy.parse(dict) else { return }
        lock.lock()
        let changed = next != current
        current = next
        if changed { generationValue &+= 1 }
        lock.unlock()
        guard changed else { return }
        mediaLog("privacy: enabled=\(next.enabled) style=\(next.style.rawValue) apps=\(next.apps.map { "\($0.id)[\($0.hideVideo ? "v" : "")\($0.muteAudio ? "a" : "")]" })")
        notify()
    }

    @discardableResult
    func observe(_ block: @escaping () -> Void) -> UUID {
        let id = UUID()
        lock.lock(); observers[id] = block; lock.unlock()
        return id
    }

    func unobserve(_ id: UUID) {
        lock.lock(); observers.removeValue(forKey: id); lock.unlock()
    }

    private func notify() {
        lock.lock()
        let blocks = Array(observers.values)
        lock.unlock()
        blocks.forEach { $0() }
    }

    /// pid запущенных экземпляров приложений с этими bundle id.
    static func pids(of bundleIds: Set<String>) -> Set<pid_t> {
        guard !bundleIds.isEmpty else { return [] }
        var out = Set<pid_t>()
        for app in NSWorkspace.shared.runningApplications {
            if let b = app.bundleIdentifier, bundleIds.contains(b) { out.insert(app.processIdentifier) }
        }
        return out
    }

    /// Запущенные приложения с окнами (Dock) — для «Добавить приложение». Главный поток.
    static func runningApps() -> [[String: Any]] {
        let own = getpid()
        var seen = Set<String>()
        var out: [[String: Any]] = []
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && app.processIdentifier != own {
            guard let bundle = app.bundleIdentifier, seen.insert(bundle).inserted else { continue }
            var item: [String: Any] = ["id": bundle, "name": app.localizedName ?? bundle]
            if let icon = app.icon, let url = iconDataURL(icon, side: 64) { item["icon"] = url }
            out.append(item)
        }
        return out
    }

    private static func iconDataURL(_ image: NSImage, side: Int) -> String? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}

// MARK: - Геометрия

/// Прямоугольники без пересечений: `a` минус `b` — до четырёх кусков.
enum RectMath {
    static func subtract(_ a: CGRect, _ b: CGRect) -> [CGRect] {
        let i = a.intersection(b)
        guard !i.isNull, i.width > 0, i.height > 0 else { return [a] }
        var out: [CGRect] = []
        if i.minY > a.minY { out.append(CGRect(x: a.minX, y: a.minY, width: a.width, height: i.minY - a.minY)) }
        if i.maxY < a.maxY { out.append(CGRect(x: a.minX, y: i.maxY, width: a.width, height: a.maxY - i.maxY)) }
        if i.minX > a.minX { out.append(CGRect(x: a.minX, y: i.minY, width: i.minX - a.minX, height: i.height)) }
        if i.maxX < a.maxX { out.append(CGRect(x: i.maxX, y: i.minY, width: a.maxX - i.maxX, height: i.height)) }
        return out
    }

    static func subtract(_ pieces: [CGRect], _ b: CGRect) -> [CGRect] {
        pieces.flatMap { subtract($0, b) }
    }
}

/// Слой маски: скруглённый прямоугольник, который закрашивается стилем (окно скрытого
/// приложения) или стирает закраску под собой (`style: nil` — обычное окно поверх).
/// Зеркало `MaskOp` из apps/windows/src/native/media/privacy.rs.
struct PrivacyMaskOp: Equatable {
    var rect: CGRect
    var radius: CGFloat
    var style: ScreenPrivacy.Style?
}

/// Маска: слои снизу вверх (как окна на экране) и места надписей плашки.
struct PrivacyMask: Equatable {
    var ops: [PrivacyMaskOp] = []
    var labels: [CGRect] = []

    var isEmpty: Bool { !ops.contains { $0.style != nil } }

    /// Весь кадр одним стилем (трекер ещё не опросил окна, показ окна скрытого приложения).
    static func full(_ rect: CGRect, style: ScreenPrivacy.Style) -> PrivacyMask {
        PrivacyMask(ops: [PrivacyMaskOp(rect: rect, radius: 0, style: style)], labels: style == .plate ? [rect] : [])
    }

    func mapped(_ map: (CGRect) -> CGRect, radiusScale: CGFloat) -> PrivacyMask {
        PrivacyMask(ops: ops.map { PrivacyMaskOp(rect: map($0.rect), radius: $0.radius * radiusScale, style: $0.style) },
                    labels: labels.map(map))
    }
}

/// Где на экране видны окна скрытых приложений (глобальные координаты CG, верх-лево).
///
/// Скругление: углы маски — 12 pt (с полем 6 pt она покрывает и окно с прямыми углами:
/// нужно радиус ≤ поле·3,4); окно поверх стирает маску с радиусом угла 28 pt — не меньше
/// настоящего у окон macOS, поэтому в уголках окна поверх скрытое не проглядывает.
///
/// Опрос — по кадрам (`refresh(notOlderThan:)`): маска кадра берётся из списка окон,
/// прочитанного не раньше, чем кадр показан на экране. Окно, появившееся на кадре, в этом
/// списке уже есть — первый кадр нового окна не уходит открытым. Таймер лишь держит
/// маску свежей, пока кадров нет (экран стоит).
final class PrivacyWindowTracker {
    private let queue = DispatchQueue(label: "com.zali.messenger.media.privacy.windows", qos: .userInteractive)
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var mask = PrivacyMask()
    /// Поколение состояния, для которого посчитана `mask` (0 — ещё ни разу).
    private var regionsGeneration: UInt64 = 0
    private var appsGeneration: UInt64 = 0
    private var previous: [CGWindowID: (CGRect, ScreenPrivacy.Style)] = [:]
    private var apps: [String: ScreenPrivacy.Style] = [:]
    /// pid → стиль его приложения (`nil` внутри — не скрыто). Свежий pid узнаётся в том же
    /// опросе, где появилось его окно: только что запущенное приложение закрыто с первого
    /// кадра. Кэш живёт пару секунд — pid переиспользуются.
    private var pidStyles: [pid_t: ScreenPrivacy.Style?] = [:]
    private var pidsRefreshed = Date.distantPast
    /// Когда начат последний опрос (mach_absolute_time).
    private var lastPollHost: UInt64 = 0
    private static let idlePoll = DispatchTimeInterval.milliseconds(100)
    private let margin: CGFloat = 6
    private let radius: CGFloat = 12
    private let occluderRadius: CGFloat = 28

    /// Окна, которые трекер не считает перекрывающими (наши плашки поверх всех окон:
    /// их нет в захвате, значит то, что под ними, в кадре есть).
    static var ignoredWindowNumbers: () -> Set<Int> = { DesktopOverlay.shared.numbersSnapshot() }

    /// Новое состояние. Первый опрос — сразу и синхронно: кадр, пришедший после этого
    /// вызова, уже видит окна (иначе в режиме размытия первые кадры ушли бы открытыми).
    func configure(_ snapshot: ScreenPrivacy.Snapshot, generation: UInt64) {
        var map: [String: ScreenPrivacy.Style] = [:]
        for app in snapshot.videoApps { map[app.id] = snapshot.style(of: app) }
        queue.sync { [self] in
            apps = map
            appsGeneration = generation
            pidsRefreshed = .distantPast
            if map.isEmpty {
                timer?.cancel()
                timer = nil
                previous = [:]
                lock.lock(); mask = PrivacyMask(); regionsGeneration = generation; lock.unlock()
                return
            }
            if timer == nil {
                let t = DispatchSource.makeTimerSource(queue: queue)
                t.schedule(deadline: .now() + PrivacyWindowTracker.idlePoll, repeating: PrivacyWindowTracker.idlePoll, leeway: .milliseconds(10))
                t.setEventHandler { [weak self] in
                    // Кадры идут — опрашивают сами; таймер нужен, только пока экран стоит.
                    guard let self, mach_absolute_time() &- self.lastPollHost > PrivacyWindowTracker.hostTicks(ms: 80) else { return }
                    self.poll()
                }
                t.resume()
                timer = t
            }
            poll()
        }
    }

    /// Маска для кадра, показанного на экране в `hostTime` (mach_absolute_time): если
    /// последний опрос был раньше — опросить сейчас, синхронно (~1 мс). Поток кадров.
    func refresh(notOlderThan hostTime: UInt64) -> (PrivacyMask, UInt64) {
        queue.sync { [self] in
            if timer != nil, lastPollHost < hostTime { poll() }
        }
        return current()
    }

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    private static func hostTicks(ms: UInt64) -> UInt64 {
        ms * 1_000_000 * UInt64(timebase.denom) / UInt64(max(timebase.numer, 1))
    }

    func stop() {
        queue.async { [self] in
            timer?.cancel()
            timer = nil
            lock.lock(); mask = PrivacyMask(); regionsGeneration = 0; lock.unlock()
        }
    }

    /// Маска и поколение состояния, для которого она посчитана.
    func current() -> (PrivacyMask, UInt64) {
        lock.lock(); defer { lock.unlock() }
        return (mask, regionsGeneration)
    }

    /// Стиль окна процесса `pid` или `nil`, если его приложение не скрыто.
    private func style(of pid: pid_t) -> ScreenPrivacy.Style? {
        if let known = pidStyles[pid] { return known }
        // NSRunningApplication(processIdentifier:) спрашивает LaunchServices напрямую;
        // NSWorkspace.runningApplications вне главного потока обновляется с опозданием.
        guard let app = NSRunningApplication(processIdentifier: pid) else { return nil }  // не кэшируем: спросим ещё
        let style = app.bundleIdentifier.flatMap { apps[$0] }
        pidStyles.updateValue(style, forKey: pid)
        return style
    }

    private func poll() {
        lastPollHost = mach_absolute_time()
        if Date().timeIntervalSince(pidsRefreshed) > 2 {
            pidsRefreshed = Date()
            pidStyles.removeAll(keepingCapacity: true)
        }
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return }
        let ignored = PrivacyWindowTracker.ignoredWindowNumbers()
        var above: [CGRect] = []  // окна выше текущего, которые видны в захвате
        var found: [CGWindowID: (CGRect, ScreenPrivacy.Style)] = [:]
        var opsFront: [PrivacyMaskOp] = []  // спереди назад, потом развернём
        var labels: [CGRect] = []
        for info in list {  // спереди назад
            guard let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  bounds.width > 0, bounds.height > 0 else { continue }
            let number = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0
            let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
            let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            let sharing = (info[kCGWindowSharingState as String] as? NSNumber)?.intValue ?? 1
            if let style = style(of: pid) {
                guard alpha > 0.01 else { continue }
                found[number] = (bounds, style)
                let current = bounds.insetBy(dx: -margin, dy: -margin)
                opsFront.append(PrivacyMaskOp(rect: current, radius: radius, style: style))
                // Между опросами окно было где-то посередине — закрыто и прошлое положение.
                if let prev = previous[number], prev.0 != bounds {
                    opsFront.append(PrivacyMaskOp(rect: prev.0.insetBy(dx: -margin, dy: -margin), radius: radius, style: style))
                }
                // Надпись плашки — в самом большом видимом куске окна.
                if style == .plate, let best = above.reduce([current], { RectMath.subtract($0, $1) }).max(by: { $0.width * $0.height < $1.width * $1.height }) {
                    labels.append(best)
                }
                continue
            }
            // Перекрывает только обычное непрозрачное окно, которое само попадает в захват.
            // Невидимые, исключённые из захвата (sharingState none, наши плашки) и окна
            // других уровней (оверлеи игр и записи, плавающие панели, меню-бар) под собой
            // ничего не прячут: лишняя плашка безопаснее окна, мелькнувшего сквозь оверлей.
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            guard layer == 0, alpha > 0.5, sharing != 0, !ignored.contains(Int(number)) else { continue }
            above.append(bounds)
            opsFront.append(PrivacyMaskOp(rect: bounds, radius: occluderRadius, style: nil))
        }
        // Окно исчезло между опросами (свернули/закрыли) — ещё один опрос закрываем, где
        // было: самым нижним слоем, окна поверх его стирают.
        var ops: [PrivacyMaskOp] = previous.filter { found[$0.key] == nil }.map {
            PrivacyMaskOp(rect: $0.value.0.insetBy(dx: -margin, dy: -margin), radius: radius, style: $0.value.1)
        }
        ops.append(contentsOf: opsFront.reversed())
        // Окна ниже всех скрытых в маске не нужны.
        if let first = ops.firstIndex(where: { $0.style != nil }) { ops.removeFirst(first) } else { ops = [] }
        previous = found
        lock.lock(); mask = PrivacyMask(ops: ops, labels: labels); regionsGeneration = appsGeneration; lock.unlock()
    }
}

// MARK: - Обработка кадра

/// Плашка и размытие поверх кадра NV12 на GPU. Пустой список — кадр как есть.
final class PrivacyRenderer {
    private let context: CIContext
    private var pool: CVPixelBufferPool?
    private var poolKey = (0, 0, OSType(0))
    private var labels: [Int: CIImage] = [:]
    static let plateText = "Владелец трансляции скрыл это приложение"

    init() {
        // Без управления цветом: незакрытые части кадра проходят YCbCr → RGB → YCbCr
        // одной матрицей, без гамма-преобразований и сдвига оттенков.
        let options: [CIContextOption: Any] = [.workingColorSpace: NSNull(), .outputColorSpace: NSNull(), .cacheIntermediates: false]
        if let device = MTLCreateSystemDefaultDevice() {
            context = CIContext(mtlDevice: device, options: options)
        } else {
            context = CIContext(options: options)
        }
    }

    /// `mask` — в пикселях кадра, начало сверху слева.
    func process(_ buffer: CVPixelBuffer, mask: PrivacyMask) -> CVPixelBuffer {
        guard !mask.isEmpty else { return buffer }
        let w = CVPixelBufferGetWidth(buffer)
        let h = CVPixelBufferGetHeight(buffer)
        let format = CVPixelBufferGetPixelFormatType(buffer)
        guard let dst = makeBuffer(width: w, height: h, format: format) else { return blackout(buffer) }
        let base = CIImage(cvPixelBuffer: buffer)
        let extent = base.extent
        let flip = { (r: CGRect) in CGRect(x: r.minX, y: CGFloat(h) - r.maxY, width: r.width, height: r.height) }
        var out = base
        for style in [ScreenPrivacy.Style.blur, .plate] where mask.ops.contains(where: { $0.style == style }) {
            guard let (maskImage, area) = coverage(mask, style: style, width: w, height: h) else {
                mediaLog("privacy: mask raster failed")
                return blackout(buffer)
            }
            let content: CIImage
            switch style {
            case .blur: content = blurred(base, area, frameHeight: h)
            case .plate: content = plate(area, labels: mask.labels.map(flip))
            }
            out = content.applyingFilter("CIBlendWithMask", parameters: [
                kCIInputBackgroundImageKey: out,
                kCIInputMaskImageKey: maskImage,
            ])
        }
        let destination = CIRenderDestination(pixelBuffer: dst)
        do {
            let task = try context.startTask(toRender: out.cropped(to: extent), to: destination)
            _ = try task.waitUntilCompleted()
        } catch {
            mediaLog("privacy: render failed \(error)")
            return blackout(buffer)
        }
        CVBufferPropagateAttachments(buffer, dst)
        return dst
    }

    /// Маска одного стиля, сглаженная по краям: слои снизу вверх, свой стиль — белым,
    /// чужой и окна поверх — чёрным (верхний слой побеждает). Растр — только на рамку
    /// слоёв этого стиля (вне её маска пустая, и смешивание оставляет кадр как есть).
    /// Возвращает маску и рамку (координаты Core Image, низ-лево).
    private func coverage(_ mask: PrivacyMask, style: ScreenPrivacy.Style, width w: Int, height h: Int) -> (CIImage, CGRect)? {
        let full = CGRect(x: 0, y: 0, width: w, height: h)
        // CGContext и Core Image — низ-лево, маска — верх-лево.
        let flip = { (r: CGRect) in CGRect(x: r.minX, y: CGFloat(h) - r.maxY, width: r.width, height: r.height) }
        let area = mask.ops.filter { $0.style == style }.reduce(CGRect.null) { $0.union(flip($1.rect)) }.intersection(full).integral
        guard !area.isNull, area.width >= 1, area.height >= 1 else { return nil }
        guard let ctx = CGContext(data: nil, width: Int(area.width), height: Int(area.height), bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        ctx.translateBy(x: -area.minX, y: -area.minY)
        ctx.setFillColor(gray: 0, alpha: 1)
        ctx.fill(area)
        for op in mask.ops {
            let r = flip(op.rect)
            guard r.width > 0, r.height > 0, r.intersects(area) else { continue }
            let corner = max(0, min(op.radius, r.width / 2, r.height / 2))
            ctx.setFillColor(gray: op.style == style ? 1 : 0, alpha: 1)
            ctx.addPath(CGPath(roundedRect: r, cornerWidth: corner, cornerHeight: corner, transform: nil))
            ctx.fillPath()
        }
        guard let image = ctx.makeImage() else { return nil }
        return (CIImage(cgImage: image).transformed(by: CGAffineTransform(translationX: area.minX, y: area.minY)), area)
    }

    /// Блоки 1/32 кадра по меньшей стороне, но не мельче 24 px: на 1080p — ~34 px, буква
    /// любого обычного размера целиком внутри одного блока.
    private func blurred(_ base: CIImage, _ rect: CGRect, frameHeight: Int) -> CIImage {
        let block = max(24, CGFloat(frameHeight) / 32)
        let source = base.clampedToExtent().cropped(to: rect.insetBy(dx: -block * 2, dy: -block * 2))
        let down = source.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: 1 / block, kCIInputAspectRatioKey: 1])
        let up = down.samplingLinear().transformed(by: CGAffineTransform(scaleX: block, y: block)
            .concatenating(CGAffineTransform(translationX: source.extent.minX - down.extent.minX * block, y: source.extent.minY - down.extent.minY * block)))
        // Статичное размытие: тот же кадр — те же пиксели, кодировщику нечего пересылать.
        let soft = up.clampedToExtent().applyingGaussianBlur(sigma: Double(block) * 0.6)
        return soft.cropped(to: rect)
    }

    /// Заливка рамки `area` и надписи по центрам видимых кусков окон (`labels`, низ-лево).
    private func plate(_ area: CGRect, labels places: [CGRect]) -> CIImage {
        var out = CIImage(color: CIColor(red: 0.075, green: 0.082, blue: 0.098)).cropped(to: area)
        for rect in places {
            let size = Int(min(30, max(11, min(rect.width / 30, rect.height / 4))).rounded())
            guard rect.width > 120, rect.height > 28, let label = label(size: size),
                  label.extent.width <= rect.width, label.extent.height <= rect.height else { continue }
            let lx = rect.midX - label.extent.width / 2
            let ly = rect.midY - label.extent.height / 2
            out = label.transformed(by: CGAffineTransform(translationX: lx.rounded(), y: ly.rounded())).composited(over: out)
        }
        return out.cropped(to: area)
    }

    private func label(size: Int) -> CIImage? {
        if let cached = labels[size] { return cached }
        let font = NSFont.systemFont(ofSize: CGFloat(size), weight: .semibold)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(white: 1, alpha: 0.82)]
        let text = NSAttributedString(string: PrivacyRenderer.plateText, attributes: attrs)
        let bounds = text.boundingRect(with: NSSize(width: 4000, height: 400), options: [.usesLineFragmentOrigin])
        let w = Int(ceil(bounds.width)) + 4
        let h = Int(ceil(bounds.height)) + 4
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        text.draw(at: NSPoint(x: 2, y: 2 - bounds.minY))
        NSGraphicsContext.restoreGraphicsState()
        guard let image = ctx.makeImage() else { return nil }
        let ci = CIImage(cgImage: image)
        if labels.count > 16 { labels.removeAll() }
        labels[size] = ci
        return ci
    }

    private func makeBuffer(width: Int, height: Int, format: OSType) -> CVPixelBuffer? {
        if pool == nil || poolKey != (width, height, format) {
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: format,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ]
            var p: CVPixelBufferPool?
            CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 4] as CFDictionary, attrs as CFDictionary, &p)
            pool = p
            poolKey = (width, height, format)
        }
        guard let pool else { return nil }
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        return out
    }

    /// Рендер не удался — лучше чёрный кадр, чем скрытое приложение в трансляции.
    private func blackout(_ buffer: CVPixelBuffer) -> CVPixelBuffer {
        let w = CVPixelBufferGetWidth(buffer)
        let h = CVPixelBufferGetHeight(buffer)
        guard let dst = makeBuffer(width: w, height: h, format: CVPixelBufferGetPixelFormatType(buffer)) else { return buffer }
        CVPixelBufferLockBaseAddress(dst, [])
        defer { CVPixelBufferUnlockBaseAddress(dst, []) }
        for plane in 0..<CVPixelBufferGetPlaneCount(dst) {
            guard let base = CVPixelBufferGetBaseAddressOfPlane(dst, plane) else { continue }
            let rows = CVPixelBufferGetHeightOfPlane(dst, plane)
            let bytes = CVPixelBufferGetBytesPerRowOfPlane(dst, plane)
            memset(base, plane == 0 ? 16 : 128, rows * bytes)
        }
        return dst
    }
}
