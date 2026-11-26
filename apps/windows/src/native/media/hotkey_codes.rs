//! Сочетания горячих клавиш страницы (web/src/interface/screen_privacy.js) → коды Win32.
//! Строка: модификаторы Ctrl/Alt/Shift/Meta + `KeyboardEvent.code` ("Ctrl+Shift+KeyM").
//! Зеркало таблицы macOS — HotkeyManager.swift. Чистый код: тесты на любой машине.

pub const MOD_ALT: u32 = 0x1;
pub const MOD_CONTROL: u32 = 0x2;
pub const MOD_SHIFT: u32 = 0x4;
pub const MOD_WIN: u32 = 0x8;

fn virtual_key(code: &str) -> Option<u32> {
    if let Some(letter) = code.strip_prefix("Key") {
        let c = letter.chars().next()?;
        return (letter.len() == 1 && c.is_ascii_uppercase()).then_some(c as u32);
    }
    if let Some(d) = code.strip_prefix("Digit") {
        let n: u32 = d.parse().ok()?;
        return (n <= 9).then_some(0x30 + n);
    }
    if let Some(d) = code.strip_prefix("Numpad") {
        // Цифры — здесь; NumpadAdd/Subtract/… — в таблице ниже.
        if let Ok(n) = d.parse::<u32>() {
            return (n <= 9).then_some(0x60 + n);
        }
    }
    if let Some(f) = code.strip_prefix('F') {
        let n: u32 = f.parse().ok()?;
        return (1..=20).contains(&n).then_some(0x70 + n - 1);
    }
    Some(match code {
        "NumpadMultiply" => 0x6A,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadDecimal" => 0x6E,
        "NumpadDivide" => 0x6F,
        "Space" => 0x20,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "Semicolon" => 0xBA,
        "Equal" => 0xBB,
        "Comma" => 0xBC,
        "Minus" => 0xBD,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "Backquote" => 0xC0,
        "BracketLeft" => 0xDB,
        "Backslash" => 0xDC,
        "BracketRight" => 0xDD,
        "Quote" => 0xDE,
        _ => return None,
    })
}

/// `(модификаторы MOD_*, виртуальный код)` или None. Без модификатора — только F-клавиши.
pub fn parse(accel: &str) -> Option<(u32, u32)> {
    let mut parts: Vec<&str> = accel.split('+').map(str::trim).collect();
    let code = parts.pop()?;
    let vk = virtual_key(code)?;
    let mut mods = 0;
    for p in parts {
        mods |= match p {
            "Ctrl" => MOD_CONTROL,
            "Alt" => MOD_ALT,
            "Shift" => MOD_SHIFT,
            "Meta" => MOD_WIN,
            _ => return None,
        };
    }
    // Без модификатора — F-клавиши и цифровая клавиатура (0x60..=0x6F).
    if mods == 0 && !(0x70..=0x83).contains(&vk) && !(0x60..=0x6F).contains(&vk) {
        return None;
    }
    Some((mods, vk))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_page_accelerators() {
        assert_eq!(parse("Ctrl+Shift+KeyM"), Some((MOD_CONTROL | MOD_SHIFT, 0x4D)));
        assert_eq!(parse("Alt+Digit1"), Some((MOD_ALT, 0x31)));
        assert_eq!(parse("Meta+F5"), Some((MOD_WIN, 0x74)));
        assert_eq!(parse("F13"), Some((0, 0x7C)));
        assert_eq!(parse("Ctrl+Numpad0"), Some((MOD_CONTROL, 0x60)));
        assert_eq!(parse("Ctrl+BracketLeft"), Some((MOD_CONTROL, 0xDB)));
        assert_eq!(parse("Numpad5"), Some((0, 0x65)), "цифровая клавиатура без модификатора");
        assert_eq!(parse("NumpadAdd"), Some((0, 0x6B)));
        assert_eq!(parse("KeyM"), None, "буква без модификатора");
        assert_eq!(parse("Ctrl+Hyper+KeyM"), None);
        assert_eq!(parse("Ctrl+IntlRo"), None);
        assert_eq!(parse("Ctrl+Keym"), None);
    }
}
