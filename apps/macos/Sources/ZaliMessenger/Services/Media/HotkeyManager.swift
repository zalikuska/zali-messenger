import AppKit
import Carbon.HIToolbox

/// Глобальные горячие клавиши звонка (страница — web/src/interface/screen_privacy.js).
///
/// `RegisterEventHotKey` (Carbon): не нужен «Универсальный доступ» и мониторинг ввода,
/// работает из любого приложения, в том числе полноэкранного. `CGEventTap` не нужен.
/// Сочетание — строка страницы: модификаторы Ctrl/Alt/Shift/Meta + `KeyboardEvent.code`.
/// Нажатие уходит странице `media_event {event: "hotkey", action}`. Только главный поток.
final class HotkeyManager {
    static let shared = HotkeyManager()

    var onHotkey: ((String) -> Void)?

    private var refs: [String: EventHotKeyRef] = [:]
    private var actions: [UInt32: String] = [:]
    private var nextId: UInt32 = 1
    private var handler: EventHandlerRef?
    private static let signature: OSType = 0x5A41_4C49  // 'ZALI'

    /// Снять прежние и занять новые. Ответ — `action → ok | conflict | invalid`.
    func apply(_ bindings: [String: String]) -> [String: String] {
        installHandlerIfNeeded()
        for (_, ref) in refs { UnregisterEventHotKey(ref) }
        refs.removeAll()
        actions.removeAll()
        let reserved = HotkeyManager.systemReserved()
        var results: [String: String] = [:]
        for (action, accel) in bindings.sorted(by: { $0.key < $1.key }) {
            guard let (code, mods) = HotkeyManager.parse(accel) else {
                results[action] = "invalid"
                continue
            }
            if reserved.contains(HotkeyManager.reservedKey(code, mods)) {
                results[action] = "conflict"
                continue
            }
            let id = nextId
            nextId &+= 1
            var ref: EventHotKeyRef?
            // Exclusive: если сочетание уже занято другим процессом — eventHotKeyExistsErr.
            let status = RegisterEventHotKey(code, mods, EventHotKeyID(signature: HotkeyManager.signature, id: id),
                                             GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &ref)
            if status == noErr, let ref {
                refs[action] = ref
                actions[id] = action
                results[action] = "ok"
            } else {
                results[action] = status == eventHotKeyExistsErr ? "conflict" : "invalid"
                mediaLog("hotkeys: \(action)=\(accel) status=\(status)")
            }
        }
        mediaLog("hotkeys: applied \(results)")
        return results
    }

    private func installHandlerIfNeeded() {
        guard handler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hk = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            guard status == noErr, hk.signature == HotkeyManager.signature else { return OSStatus(eventNotHandledErr) }
            HotkeyManager.shared.fire(hk.id)
            return noErr
        }, 1, &spec, nil, &handler)
    }

    private func fire(_ id: UInt32) {
        guard let action = actions[id] else { return }
        mediaLog("hotkeys: fired \(action)")
        onHotkey?(action)
    }

    // MARK: - Разбор сочетаний

    static func parse(_ accel: String) -> (UInt32, UInt32)? {
        var parts = accel.split(separator: "+").map(String.init)
        guard let code = parts.popLast(), let key = keyCodes[code] else { return nil }
        var mods: UInt32 = 0
        for p in parts {
            switch p {
            case "Ctrl": mods |= UInt32(controlKey)
            case "Alt": mods |= UInt32(optionKey)
            case "Shift": mods |= UInt32(shiftKey)
            case "Meta": mods |= UInt32(cmdKey)
            default: return nil
            }
        }
        if mods == 0 && !code.hasPrefix("F") && !code.hasPrefix("Numpad") { return nil }
        return (UInt32(key), mods)
    }

    private static func reservedKey(_ code: UInt32, _ mods: UInt32) -> UInt64 {
        (UInt64(code) << 32) | UInt64(mods & UInt32(controlKey | optionKey | shiftKey | cmdKey))
    }

    /// Включённые системные сочетания (Spotlight, переключение раскладки, снимки экрана…):
    /// RegisterEventHotKey их не видит и отвечает noErr, но нажатие забирает система.
    private static func systemReserved() -> Set<UInt64> {
        var out = Set<UInt64>()
        var unmanaged: Unmanaged<CFArray>?
        guard CopySymbolicHotKeys(&unmanaged) == noErr, let array = unmanaged?.takeRetainedValue() as? [[String: Any]] else { return out }
        for item in array {
            guard (item[kHISymbolicHotKeyEnabled as String] as? Bool) ?? false,
                  let code = (item[kHISymbolicHotKeyCode as String] as? NSNumber)?.uint32Value,
                  let mods = (item[kHISymbolicHotKeyModifiers as String] as? NSNumber)?.uint32Value else { continue }
            out.insert(reservedKey(code, mods))
        }
        return out
    }

    /// KeyboardEvent.code → виртуальный код клавиши (ANSI-раскладка, как у страницы).
    static let keyCodes: [String: Int] = {
        var m: [String: Int] = [
            "KeyA": kVK_ANSI_A, "KeyB": kVK_ANSI_B, "KeyC": kVK_ANSI_C, "KeyD": kVK_ANSI_D, "KeyE": kVK_ANSI_E,
            "KeyF": kVK_ANSI_F, "KeyG": kVK_ANSI_G, "KeyH": kVK_ANSI_H, "KeyI": kVK_ANSI_I, "KeyJ": kVK_ANSI_J,
            "KeyK": kVK_ANSI_K, "KeyL": kVK_ANSI_L, "KeyM": kVK_ANSI_M, "KeyN": kVK_ANSI_N, "KeyO": kVK_ANSI_O,
            "KeyP": kVK_ANSI_P, "KeyQ": kVK_ANSI_Q, "KeyR": kVK_ANSI_R, "KeyS": kVK_ANSI_S, "KeyT": kVK_ANSI_T,
            "KeyU": kVK_ANSI_U, "KeyV": kVK_ANSI_V, "KeyW": kVK_ANSI_W, "KeyX": kVK_ANSI_X, "KeyY": kVK_ANSI_Y,
            "KeyZ": kVK_ANSI_Z,
            "Digit0": kVK_ANSI_0, "Digit1": kVK_ANSI_1, "Digit2": kVK_ANSI_2, "Digit3": kVK_ANSI_3, "Digit4": kVK_ANSI_4,
            "Digit5": kVK_ANSI_5, "Digit6": kVK_ANSI_6, "Digit7": kVK_ANSI_7, "Digit8": kVK_ANSI_8, "Digit9": kVK_ANSI_9,
            "Numpad0": kVK_ANSI_Keypad0, "Numpad1": kVK_ANSI_Keypad1, "Numpad2": kVK_ANSI_Keypad2, "Numpad3": kVK_ANSI_Keypad3,
            "Numpad4": kVK_ANSI_Keypad4, "Numpad5": kVK_ANSI_Keypad5, "Numpad6": kVK_ANSI_Keypad6, "Numpad7": kVK_ANSI_Keypad7,
            "Numpad8": kVK_ANSI_Keypad8, "Numpad9": kVK_ANSI_Keypad9,
            "NumpadAdd": kVK_ANSI_KeypadPlus, "NumpadSubtract": kVK_ANSI_KeypadMinus, "NumpadMultiply": kVK_ANSI_KeypadMultiply,
            "NumpadDivide": kVK_ANSI_KeypadDivide, "NumpadDecimal": kVK_ANSI_KeypadDecimal,
            "Space": kVK_Space, "ArrowUp": kVK_UpArrow, "ArrowDown": kVK_DownArrow, "ArrowLeft": kVK_LeftArrow,
            "ArrowRight": kVK_RightArrow, "Home": kVK_Home, "End": kVK_End, "PageUp": kVK_PageUp, "PageDown": kVK_PageDown,
            "Insert": kVK_Help, "Delete": kVK_ForwardDelete,
            "Minus": kVK_ANSI_Minus, "Equal": kVK_ANSI_Equal, "BracketLeft": kVK_ANSI_LeftBracket,
            "BracketRight": kVK_ANSI_RightBracket, "Backslash": kVK_ANSI_Backslash, "Semicolon": kVK_ANSI_Semicolon,
            "Quote": kVK_ANSI_Quote, "Comma": kVK_ANSI_Comma, "Period": kVK_ANSI_Period, "Slash": kVK_ANSI_Slash,
            "Backquote": kVK_ANSI_Grave,
        ]
        let fkeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                     kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
        for (i, k) in fkeys.enumerated() { m["F\(i + 1)"] = k }
        return m
    }()
}
