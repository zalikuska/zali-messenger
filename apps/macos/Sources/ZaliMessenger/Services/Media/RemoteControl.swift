import AppKit
import ApplicationServices
import CoreGraphics

/// Удалённое управление компьютером по разрешению (веб — web/src/interface/remote_control.js).
///
/// Отдаёт управление сам пользователь кнопкой на странице, но подтверждает оболочка СВОИМ диалогом
/// (`requestGrant`), поэтому скомпрометированный JS не может выдать управление сам себе.
/// Разрешение привязано к живому потоку захвата всего экрана (`display:<id>`) и
/// снимается, когда поток кончился (`streamEnded`), страница перезагрузилась (мост кадров
/// закрылся → MediaController.stopAll) или страница сама его отозвала (`revoke`).
///
/// Ввод — CGEvent в `cghidEventTap`; для этого macOS требует «Универсальный доступ»
/// (Accessibility) для ZaliMessenger. Координаты приходят долями кадра [0..1] и
/// переводятся в точки монитора, который показывается.
final class RemoteControl {
    static let shared = RemoteControl()

    private struct Grant {
        let stream: UInt32
        let displayID: CGDirectDisplayID
        let peer: String
    }

    private let queue = DispatchQueue(label: "com.zali.messenger.remote-control", qos: .userInteractive)
    private var grant: Grant?
    private var dialogOpen = false
    private var source: CGEventSource?
    private var position = CGPoint.zero
    private var pressedButtons = Set<Int>()
    private var pressedKeys = Set<CGKeyCode>()
    private var modifiers = Set<String>()
    private var lastDown: (button: Int, at: TimeInterval, point: CGPoint, count: Int64)?
    private var events = 0

    // MARK: - Разрешение

    /// Подтверждение «отдать управление» (страница зовёт после клика пользователя). `done(nil)` — разрешено, иначе ошибка для страницы
    /// (`code`: denied / permission / busy / not_found).
    func requestGrant(stream: UInt32, sourceId: String, peer rawPeer: String, done: @escaping (MediaError?) -> Void) {
        guard sourceId.hasPrefix("display:"),
              let raw = UInt32(sourceId.dropFirst("display:".count)) else {
            return done(MediaError.notFound("управление доступно только при показе всего экрана"))
        }
        let displayID = CGDirectDisplayID(raw)
        // Имя — от страницы (а ей — от сервера, который может быть чужим, «Свой сервер»).
        // Только алфавит логинов сервера (util.rs is_valid_username): без RTL-override,
        // пробелов и кириллических двойников подписью диалога не подменить смысл.
        let peer = Self.safePeerName(rawPeer)
        queue.async {
            if self.dialogOpen { return done(MediaError.busy("уже открыто подтверждение передачи управления")) }
            if let g = self.grant, g.stream != stream || g.peer != peer {
                return done(MediaError.busy("компьютером уже управляет \(g.peer)"))
            }
            self.dialogOpen = true
            DispatchQueue.main.async {
                let allowed = Self.askUser(peer: peer)
                var error: MediaError?
                if !allowed {
                    error = MediaError(code: "denied", message: "пользователь отменил")
                } else if !AXIsProcessTrusted() {
                    // Открывает системный запрос «Универсальный доступ» с кнопкой в Настройки.
                    let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
                    _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
                    error = MediaError.permission("Чтобы отдать управление, включите ZaliMessenger в Системные настройки → Конфиденциальность и безопасность → Универсальный доступ и нажмите «Отдать управление» ещё раз")
                }
                self.queue.async {
                    self.dialogOpen = false
                    if error == nil {
                        self.grant = Grant(stream: stream, displayID: displayID, peer: peer)
                        self.source = CGEventSource(stateID: .hidSystemState)
                        // Без этого после каждого нашего события локальная мышь «замирает» на 0,25 с.
                        self.source?.localEventsSuppressionInterval = 0
                        self.position = CGEvent(source: nil)?.location ?? .zero
                        self.events = 0
                        mediaLog("remote control: granted stream=\(stream) display=\(displayID) peer=\(peer)")
                    } else {
                        mediaLog("remote control: not granted stream=\(stream) code=\(error!.code)")
                    }
                    done(error)
                }
            }
        }
    }

    static func safePeerName(_ raw: String) -> String {
        let allowed = raw.unicodeScalars.filter { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-") }
        return String(String.UnicodeScalarView(allowed).prefix(32))
    }

    /// Модальный диалог на главном потоке. Сам закрывается через 100 с — страница ждёт
    /// ответа 120 с, а позднее «Разрешить» выдало бы управление, о котором она не знает.
    private static func askUser(peer: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Отдать управление этим компьютером «\(peer.isEmpty ? "собеседнику" : peer)»?"
        alert.informativeText = "Пока идёт демонстрация экрана, он сможет делать на этом компьютере всё, что можете вы: открывать программы и файлы, "
            + "печатать, нажимать любые кнопки — в том числе на экранах, которых не видит. Отдавайте только тому, кому доверяете. "
            + "Забрать можно в любой момент: «Остановить» вверху окна ZaliMessenger, «Забрать управление» на демонстрации или конец демонстрации."
        // Первая кнопка — по Return: безопасный ответ по умолчанию.
        alert.addButton(withTitle: "Отмена")
        let allow = alert.addButton(withTitle: "Отдать управление")
        // Диалог крадёт фокус посреди набора текста: с «Навигацией с клавиатуры» Tab+пробел
        // нажали бы «Отдать управление» случайно. Первые 1,5 с кнопка неактивна (как в браузерах).
        allow.isEnabled = false
        let arm = Timer(timeInterval: 1.5, repeats: false) { _ in allow.isEnabled = true }
        RunLoop.main.add(arm, forMode: .modalPanel)
        NSApp.activate(ignoringOtherApps: true)
        let timeout = Timer(timeInterval: 100, repeats: false) { _ in NSApp.abortModal() }
        RunLoop.main.add(timeout, forMode: .modalPanel)
        let response = alert.runModal()
        timeout.invalidate()
        arm.invalidate()
        return response == .alertSecondButtonReturn
    }

    /// Страница отозвала разрешение (кнопка «Остановить», зритель отключился).
    func revoke(stream: UInt32, reason: String) {
        queue.async {
            guard let g = self.grant, g.stream == stream else { return }
            self.clear(reason: reason)
        }
    }

    /// Поток экрана закончился. `notify` — только если разрешение было и снято.
    func streamEnded(_ stream: UInt32, notify: @escaping () -> Void) {
        queue.async {
            guard let g = self.grant, g.stream == stream else { return }
            self.clear(reason: "stream-ended")
            notify()
        }
    }

    private func clear(reason: String) {
        releaseAll()
        mediaLog("remote control: revoked stream=\(grant?.stream ?? 0) reason=\(reason) events=\(events)")
        grant = nil
        source = nil
        lastDown = nil
    }

    // MARK: - Ввод

    func input(stream: UInt32, _ e: [String: Any]) {
        queue.async {
            guard let g = self.grant, g.stream == stream, AXIsProcessTrusted() else { return }
            self.events += 1
            switch e["t"] as? String ?? "" {
            case "move":
                guard let p = self.point(e, g) else { return }
                self.position = p
                self.postMouse(self.dragType() ?? .mouseMoved, button: self.pressedButtons.first ?? 0)
            case "down":
                guard let p = self.point(e, g), let b = self.button(e) else { return }
                self.position = p
                let now = ProcessInfo.processInfo.systemUptime
                var count: Int64 = 1
                if let last = self.lastDown, last.button == b, now - last.at < NSEvent.doubleClickInterval,
                   abs(last.point.x - p.x) < 5, abs(last.point.y - p.y) < 5 {
                    count = min(last.count + 1, 3)
                }
                self.lastDown = (b, now, p, count)
                self.pressedButtons.insert(b)
                self.postMouse(b == 0 ? .leftMouseDown : (b == 2 ? .rightMouseDown : .otherMouseDown), button: b, clicks: count)
            case "up":
                guard let b = self.button(e), self.pressedButtons.contains(b) else { return }
                if let p = self.point(e, g) { self.position = p }
                self.pressedButtons.remove(b)
                self.postMouse(b == 0 ? .leftMouseUp : (b == 2 ? .rightMouseUp : .otherMouseUp), button: b, clicks: self.lastDown?.count ?? 1)
            case "wheel":
                let dx = Int32(max(-2000, min(2000, (e["dx"] as? NSNumber)?.intValue ?? 0)))
                let dy = Int32(max(-2000, min(2000, (e["dy"] as? NSNumber)?.intValue ?? 0)))
                // У веба deltaY > 0 — прокрутка вниз, у CGEvent wheel1 > 0 — вверх.
                guard let ev = CGEvent(scrollWheelEvent2Source: self.source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) else { return }
                ev.flags = self.flags()
                ev.post(tap: .cghidEventTap)
            case "key":
                guard let code = e["code"] as? String, let key = Self.keyCodes[code] else { return }
                let down = ((e["d"] as? NSNumber)?.intValue ?? 0) != 0
                self.postKey(code: code, key: key, down: down)
            case "release":
                self.releaseAll()
            default:
                break
            }
        }
    }

    private func point(_ e: [String: Any], _ g: Grant) -> CGPoint? {
        guard let x = (e["x"] as? NSNumber)?.doubleValue, let y = (e["y"] as? NSNumber)?.doubleValue,
              x.isFinite, y.isFinite else { return nil }
        let b = CGDisplayBounds(g.displayID)
        guard b.width > 0, b.height > 0 else { return nil }
        let cx = min(1, max(0, x)), cy = min(1, max(0, y))
        // Правый/нижний край — последняя точка монитора, а не первая соседнего.
        return CGPoint(x: b.minX + min(cx * b.width, b.width - 1), y: b.minY + min(cy * b.height, b.height - 1))
    }

    private func button(_ e: [String: Any]) -> Int? {
        guard let b = (e["b"] as? NSNumber)?.intValue, (0...2).contains(b) else { return nil }
        return b
    }

    private func dragType() -> CGEventType? {
        if pressedButtons.contains(0) { return .leftMouseDragged }
        if pressedButtons.contains(2) { return .rightMouseDragged }
        if pressedButtons.contains(1) { return .otherMouseDragged }
        return nil
    }

    private func postMouse(_ type: CGEventType, button: Int, clicks: Int64 = 0) {
        let cgButton: CGMouseButton = button == 0 ? .left : (button == 2 ? .right : .center)
        guard let ev = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: position, mouseButton: cgButton) else { return }
        if clicks > 0 { ev.setIntegerValueField(.mouseEventClickState, value: clicks) }
        ev.flags = flags()
        ev.post(tap: .cghidEventTap)
    }

    private func postKey(code: String, key: CGKeyCode, down: Bool) {
        let modifier = Self.modifierFlag[code] != nil
        if modifier {
            if down { modifiers.insert(code) } else { modifiers.remove(code) }
        }
        if down { pressedKeys.insert(key) } else { pressedKeys.remove(key) }
        guard let ev = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { return }
        if modifier { ev.type = .flagsChanged }
        ev.flags = flags()
        ev.post(tap: .cghidEventTap)
    }

    private func flags() -> CGEventFlags {
        var f: CGEventFlags = []
        for code in modifiers { if let m = Self.modifierFlag[code] { f.insert(m) } }
        return f
    }

    /// Отпустить всё, что мы держим нажатым: иначе после отключения у человека «залип» бы Shift.
    private func releaseAll() {
        for b in pressedButtons {
            postMouse(b == 0 ? .leftMouseUp : (b == 2 ? .rightMouseUp : .otherMouseUp), button: b, clicks: 1)
        }
        pressedButtons.removeAll()
        for key in pressedKeys where !Self.modifierKeyCodes.contains(key) {
            CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)?.post(tap: .cghidEventTap)
        }
        for code in modifiers {
            if let key = Self.keyCodes[code], let ev = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) {
                ev.type = .flagsChanged
                ev.flags = []
                ev.post(tap: .cghidEventTap)
            }
        }
        pressedKeys.removeAll()
        modifiers.removeAll()
    }

    // MARK: - Таблицы

    private static let modifierFlag: [String: CGEventFlags] = [
        "ShiftLeft": .maskShift, "ShiftRight": .maskShift,
        "ControlLeft": .maskControl, "ControlRight": .maskControl,
        "AltLeft": .maskAlternate, "AltRight": .maskAlternate,
        "MetaLeft": .maskCommand, "MetaRight": .maskCommand,
    ]

    private static var modifierKeyCodes: Set<CGKeyCode> {
        Set(modifierFlag.keys.compactMap { keyCodes[$0] })
    }

    /// KeyboardEvent.code → виртуальный код клавиши macOS (kVK_*, Carbon HIToolbox/Events.h).
    static let keyCodes: [String: CGKeyCode] = [
        "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05,
        "KeyZ": 0x06, "KeyX": 0x07, "KeyC": 0x08, "KeyV": 0x09, "IntlBackslash": 0x0A, "KeyB": 0x0B,
        "KeyQ": 0x0C, "KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11,
        "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16, "Digit5": 0x17,
        "Equal": 0x18, "Digit9": 0x19, "Digit7": 0x1A, "Minus": 0x1B, "Digit8": 0x1C, "Digit0": 0x1D,
        "BracketRight": 0x1E, "KeyO": 0x1F, "KeyU": 0x20, "BracketLeft": 0x21, "KeyI": 0x22, "KeyP": 0x23,
        "Enter": 0x24, "KeyL": 0x25, "KeyJ": 0x26, "Quote": 0x27, "KeyK": 0x28, "Semicolon": 0x29,
        "Backslash": 0x2A, "Comma": 0x2B, "Slash": 0x2C, "KeyN": 0x2D, "KeyM": 0x2E, "Period": 0x2F,
        "Tab": 0x30, "Space": 0x31, "Backquote": 0x32, "Backspace": 0x33, "Escape": 0x35,
        "MetaRight": 0x36, "MetaLeft": 0x37, "ShiftLeft": 0x38, "CapsLock": 0x39, "AltLeft": 0x3A,
        "ControlLeft": 0x3B, "ShiftRight": 0x3C, "AltRight": 0x3D, "ControlRight": 0x3E,
        "F17": 0x40, "NumpadDecimal": 0x41, "NumpadMultiply": 0x43, "NumpadAdd": 0x45, "NumLock": 0x47,
        "AudioVolumeUp": 0x48, "AudioVolumeDown": 0x49, "AudioVolumeMute": 0x4A,
        "NumpadDivide": 0x4B, "NumpadEnter": 0x4C, "NumpadSubtract": 0x4E, "F18": 0x4F, "F19": 0x50,
        "NumpadEqual": 0x51, "Numpad0": 0x52, "Numpad1": 0x53, "Numpad2": 0x54, "Numpad3": 0x55,
        "Numpad4": 0x56, "Numpad5": 0x57, "Numpad6": 0x58, "Numpad7": 0x59, "F20": 0x5A,
        "Numpad8": 0x5B, "Numpad9": 0x5C, "IntlYen": 0x5D, "IntlRo": 0x5E, "NumpadComma": 0x5F,
        "F5": 0x60, "F6": 0x61, "F7": 0x62, "F3": 0x63, "F8": 0x64, "F9": 0x65, "Lang2": 0x66,
        "F11": 0x67, "Lang1": 0x68, "F13": 0x69, "F16": 0x6A, "F14": 0x6B, "F10": 0x6D,
        "ContextMenu": 0x6E, "F12": 0x6F, "F15": 0x71, "Insert": 0x72, "Help": 0x72, "Home": 0x73,
        "PageUp": 0x74, "Delete": 0x75, "F4": 0x76, "End": 0x77, "F2": 0x78, "PageDown": 0x79,
        "F1": 0x7A, "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
    ]
}
