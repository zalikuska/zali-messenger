//! Удалённое управление компьютером по разрешению (веб — web/src/interface/remote_control.js,
//! зеркало macOS — apps/macos/Sources/ZaliMessenger/Services/Media/RemoteControl.swift).
//!
//! Отдаёт управление сам пользователь кнопкой на странице, но подтверждает оболочка системным окном
//! «Да/Нет» (`request_grant`), поэтому скомпрометированный JS не может выдать управление
//! сам себе. Разрешение привязано к живому потоку захвата ВСЕГО экрана (`display:<HMONITOR>`)
//! и снимается, когда поток кончился (`stream_ended`), страница перезагрузилась
//! (`stop_all`) или страница сама его отозвала (`revoke`).
//!
//! Ввод — `SendInput`: мышь абсолютными координатами по виртуальному рабочему столу,
//! клавиши — скан-кодами (физическая клавиша, раскладка — у показывающего). Окна,
//! запущенные от администратора, ввод от обычного процесса не принимают (UIPI), а
//! Ctrl+Alt+Del (SAS) вообще не инъецируется — это ограничения Windows.

use serde_json::Value;

/// Окно согласия висит не дольше: страница ждёт ответа 120 с, и позднее «Да» выдало бы
/// управление, о котором она уже не знает (у MessageBoxW нет таймаута — поздний ответ
/// считается отказом).
pub const DIALOG_TIMEOUT_SECS: u64 = 100;

/// Ответ «разрешить» быстрее этого — скорее всего, случайная клавиша: окно крадёт фокус
/// посреди набора текста. Тогда окно показывается заново (до `CONSENT_ATTEMPTS` раз).
pub const MIN_ANSWER_MS: u128 = 1500;
pub const CONSENT_ATTEMPTS: usize = 3;

/// Имя для окна согласия: только алфавит логинов сервера (`util.rs is_valid_username`).
/// Имя приходит от страницы, а ей — от сервера, который может быть чужим («Свой сервер»):
/// без RTL-override, пробелов и двойников из других алфавитов подписью не подменить смысл.
pub fn safe_peer_name(raw: &str) -> String {
    raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(32).collect()
}

/// KeyboardEvent.code → (скан-код set 1, расширенная клавиша).
pub fn scan_code(code: &str) -> Option<(u16, bool)> {
    let plain = |s: u16| Some((s, false));
    let ext = |s: u16| Some((s, true));
    match code {
        "Escape" => plain(0x01),
        "Digit1" => plain(0x02), "Digit2" => plain(0x03), "Digit3" => plain(0x04), "Digit4" => plain(0x05),
        "Digit5" => plain(0x06), "Digit6" => plain(0x07), "Digit7" => plain(0x08), "Digit8" => plain(0x09),
        "Digit9" => plain(0x0A), "Digit0" => plain(0x0B), "Minus" => plain(0x0C), "Equal" => plain(0x0D),
        "Backspace" => plain(0x0E), "Tab" => plain(0x0F),
        "KeyQ" => plain(0x10), "KeyW" => plain(0x11), "KeyE" => plain(0x12), "KeyR" => plain(0x13),
        "KeyT" => plain(0x14), "KeyY" => plain(0x15), "KeyU" => plain(0x16), "KeyI" => plain(0x17),
        "KeyO" => plain(0x18), "KeyP" => plain(0x19), "BracketLeft" => plain(0x1A), "BracketRight" => plain(0x1B),
        "Enter" => plain(0x1C), "ControlLeft" => plain(0x1D),
        "KeyA" => plain(0x1E), "KeyS" => plain(0x1F), "KeyD" => plain(0x20), "KeyF" => plain(0x21),
        "KeyG" => plain(0x22), "KeyH" => plain(0x23), "KeyJ" => plain(0x24), "KeyK" => plain(0x25),
        "KeyL" => plain(0x26), "Semicolon" => plain(0x27), "Quote" => plain(0x28), "Backquote" => plain(0x29),
        "ShiftLeft" => plain(0x2A), "Backslash" => plain(0x2B),
        "KeyZ" => plain(0x2C), "KeyX" => plain(0x2D), "KeyC" => plain(0x2E), "KeyV" => plain(0x2F),
        "KeyB" => plain(0x30), "KeyN" => plain(0x31), "KeyM" => plain(0x32), "Comma" => plain(0x33),
        "Period" => plain(0x34), "Slash" => plain(0x35), "ShiftRight" => plain(0x36),
        "NumpadMultiply" => plain(0x37), "AltLeft" => plain(0x38), "Space" => plain(0x39), "CapsLock" => plain(0x3A),
        "F1" => plain(0x3B), "F2" => plain(0x3C), "F3" => plain(0x3D), "F4" => plain(0x3E), "F5" => plain(0x3F),
        "F6" => plain(0x40), "F7" => plain(0x41), "F8" => plain(0x42), "F9" => plain(0x43), "F10" => plain(0x44),
        "NumLock" => ext(0x45), "ScrollLock" => plain(0x46),
        "Numpad7" => plain(0x47), "Numpad8" => plain(0x48), "Numpad9" => plain(0x49), "NumpadSubtract" => plain(0x4A),
        "Numpad4" => plain(0x4B), "Numpad5" => plain(0x4C), "Numpad6" => plain(0x4D), "NumpadAdd" => plain(0x4E),
        "Numpad1" => plain(0x4F), "Numpad2" => plain(0x50), "Numpad3" => plain(0x51), "Numpad0" => plain(0x52),
        "NumpadDecimal" => plain(0x53), "IntlBackslash" => plain(0x56), "F11" => plain(0x57), "F12" => plain(0x58),
        "F13" => plain(0x64), "F14" => plain(0x65), "F15" => plain(0x66), "F16" => plain(0x67),
        "F17" => plain(0x68), "F18" => plain(0x69), "F19" => plain(0x6A), "F20" => plain(0x6B),
        "IntlRo" => plain(0x73), "IntlYen" => plain(0x7D),
        "NumpadEnter" => ext(0x1C), "ControlRight" => ext(0x1D), "NumpadDivide" => ext(0x35),
        "PrintScreen" => ext(0x37), "AltRight" => ext(0x38),
        "Home" => ext(0x47), "ArrowUp" => ext(0x48), "PageUp" => ext(0x49), "ArrowLeft" => ext(0x4B),
        "ArrowRight" => ext(0x4D), "End" => ext(0x4F), "ArrowDown" => ext(0x50), "PageDown" => ext(0x51),
        "Insert" => ext(0x52), "Delete" => ext(0x53), "MetaLeft" => ext(0x5B), "MetaRight" => ext(0x5C),
        "ContextMenu" => ext(0x5D),
        "AudioVolumeMute" => ext(0x20), "AudioVolumeDown" => ext(0x2E), "AudioVolumeUp" => ext(0x30),
        _ => None,
    }
}

/// Доля кадра [0..1] → абсолютная координата SendInput (0..65535 по виртуальному столу).
/// `mon` — (left, top, right, bottom) монитора, `desk` — (x, y, w, h) виртуального стола.
pub fn absolute_point(x: f64, y: f64, mon: (i32, i32, i32, i32), desk: (i32, i32, i32, i32)) -> Option<(i32, i32)> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let (l, t, r, b) = mon;
    let (dx, dy, dw, dh) = desk;
    if r <= l || b <= t || dw < 2 || dh < 2 {
        return None;
    }
    let px = l as f64 + x.clamp(0.0, 1.0) * (r - l - 1) as f64;
    let py = t as f64 + y.clamp(0.0, 1.0) * (b - t - 1) as f64;
    let nx = ((px - dx as f64) * 65535.0 / (dw - 1) as f64).round().clamp(0.0, 65535.0);
    let ny = ((py - dy as f64) * 65535.0 / (dh - 1) as f64).round().clamp(0.0, 65535.0);
    Some((nx as i32, ny as i32))
}

/// Монитор из id источника, только `display:` — окно двигается, его координаты не стабильны.
pub fn display_handle(source_id: &str) -> Option<isize> {
    match super::format::Source::parse(source_id)? {
        super::format::Source::Display(h) => Some(h),
        super::format::Source::Window(_) => None,
    }
}

fn unit(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

#[cfg(target_os = "windows")]
pub use imp::*;

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use crate::native::media::EventSink;
    use serde_json::json;
    use std::collections::HashSet;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use std::time::Instant;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, MessageBoxW, IDOK, MB_DEFBUTTON2, MB_ICONWARNING, MB_OKCANCEL, MB_SETFOREGROUND, MB_TOPMOST,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    struct Grant {
        stream: u32,
        monitor: isize,
        peer: String,
        buttons: HashSet<u8>,
        keys: HashSet<String>,
        events: u64,
    }

    #[derive(Default)]
    struct State {
        grant: Option<Grant>,
        dialog_open: bool,
    }

    fn state() -> MutexGuard<'static, State> {
        static STATE: OnceLock<Mutex<State>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(State::default())).lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Подтверждение «отдать управление» (страница зовёт после клика пользователя) в своём потоке; ответ странице — `rc_granted` или ошибка
    /// (`denied` / `busy` / `not_found`). `still_live` — идёт ли ещё этот поток экрана.
    pub fn request_grant(
        stream: u32,
        source_id: String,
        peer: String,
        request_id: Option<String>,
        events: EventSink,
        still_live: impl Fn(u32, &str) -> bool + Send + 'static,
    ) {
        let fail = |events: &EventSink, code: &str, msg: &str| events.error(request_id.as_deref(), None, code, msg);
        let Some(monitor) = display_handle(&source_id) else {
            return fail(&events, "not_found", "управление доступно только при показе всего экрана");
        };
        let peer = safe_peer_name(&peer);
        {
            let mut s = state();
            if s.dialog_open {
                return fail(&events, "busy", "уже открыто подтверждение передачи управления");
            }
            if let Some(g) = &s.grant {
                if g.stream != stream || g.peer != peer {
                    return fail(&events, "busy", "компьютером уже управляет другой собеседник");
                }
            }
            s.dialog_open = true;
        }
        let spawned = std::thread::Builder::new().name("zali-rc-consent".into()).spawn(move || {
            let who = if peer.is_empty() { "собеседнику".to_string() } else { peer.clone() };
            let text = format!(
                "Отдать управление этим компьютером «{who}»?\n\n\
                 Пока идёт демонстрация экрана, он сможет делать здесь всё, что можете вы: открывать \
                 программы и файлы, печатать, нажимать любые кнопки — в том числе на экранах, которых \
                 не видит. Отдавайте только тому, кому доверяете.\n\n\
                 Забрать можно в любой момент: «Остановить» вверху окна ZaliMessenger, «Забрать \
                 управление» на демонстрации или конец демонстрации.\n\n\
                 «ОК» — отдать управление, «Отмена» — не отдавать."
            );
            let asked = Instant::now();
            let mut allowed = false;
            for _ in 0..CONSENT_ATTEMPTS {
                let shown = Instant::now();
                if !confirm("ZaliMessenger — удалённое управление", &text) {
                    allowed = false;
                    break;
                }
                allowed = shown.elapsed().as_millis() >= MIN_ANSWER_MS;
                if allowed {
                    break;
                }
                tracing::info!("[ZALI][WIN] remote control consent answered too fast, asking again");
            }
            let late = asked.elapsed().as_secs() >= DIALOG_TIMEOUT_SECS;
            let mut s = state();
            s.dialog_open = false;
            if !allowed || late {
                drop(s);
                tracing::info!("[ZALI][WIN] remote control not granted stream={stream} late={late}");
                return events.error(request_id.as_deref(), None, "denied", "пользователь отменил");
            }
            if !still_live(stream, &source_id) {
                drop(s);
                return events.error(request_id.as_deref(), None, "not_found", "демонстрация экрана закончилась");
            }
            s.grant = Some(Grant { stream, monitor, peer: peer.clone(), buttons: HashSet::new(), keys: HashSet::new(), events: 0 });
            drop(s);
            tracing::info!("[ZALI][WIN] remote control granted stream={stream} monitor={monitor} peer={peer}");
            let mut payload = json!({ "event": "rc_granted", "stream": stream });
            if let Some(id) = &request_id {
                payload["requestId"] = json!(id);
            }
            events.emit(payload);
        });
        if spawned.is_err() {
            state().dialog_open = false;
        }
    }

    /// ОК/Отмена, а не Да/Нет: у «&Да»/«&Yes» есть мнемоника, и окно, укравшее фокус
    /// посреди набора текста, выдало бы управление первой же буквой «д»/«y». У «ОК»
    /// мнемоники нет; Enter и пробел по умолчанию жмут «Отмена» (MB_DEFBUTTON2).
    fn confirm(title: &str, message: &str) -> bool {
        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
        let text = wide(message);
        let caption = wide(title);
        let answer = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND,
            )
        };
        answer == IDOK
    }

    /// Страница отозвала разрешение.
    pub fn revoke(stream: u32, reason: &str) {
        let mut s = state();
        if s.grant.as_ref().map(|g| g.stream == stream).unwrap_or(false) {
            clear(&mut s, reason);
        }
    }

    /// Поток экрана закончился: снять разрешение и (если было) известить страницу.
    pub fn stream_ended(stream: u32, reason: &str, events: Option<&EventSink>) {
        let mut s = state();
        if !s.grant.as_ref().map(|g| g.stream == stream).unwrap_or(false) {
            return;
        }
        clear(&mut s, reason);
        drop(s);
        if let Some(events) = events {
            events.emit(json!({ "event": "rc_revoked", "stream": stream, "reason": reason }));
        }
    }

    /// Страница перезагрузилась — разрешение некому принадлежать.
    pub fn stop_all() {
        let mut s = state();
        if s.grant.is_some() {
            clear(&mut s, "page-reset");
        }
    }

    fn clear(s: &mut State, reason: &str) {
        if let Some(mut g) = s.grant.take() {
            release_all(&mut g);
            tracing::info!("[ZALI][WIN] remote control revoked stream={} reason={reason} events={}", g.stream, g.events);
        }
    }

    pub fn input(stream: u32, e: &Value) {
        let mut s = state();
        let Some(g) = s.grant.as_mut().filter(|g| g.stream == stream) else { return };
        g.events += 1;
        match e.get("t").and_then(Value::as_str).unwrap_or("") {
            "move" => {
                if let Some(p) = point(g.monitor, e) {
                    send(&[mouse(p, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0)]);
                }
            }
            kind @ ("down" | "up") => {
                let Some(b) = e.get("b").and_then(Value::as_u64).filter(|b| *b <= 2).map(|b| b as u8) else { return };
                let down = kind == "down";
                if !down && !g.buttons.contains(&b) {
                    return;
                }
                let Some(p) = point(g.monitor, e) else { return };
                if down { g.buttons.insert(b); } else { g.buttons.remove(&b); }
                let flag = button_flag(b, down);
                send(&[mouse(p, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | flag, 0)]);
            }
            "wheel" => {
                let clamp = |k: &str| e.get(k).and_then(Value::as_i64).unwrap_or(0).clamp(-2000, 2000) as i32;
                let (dx, dy) = (clamp("dx"), clamp("dy"));
                // У веба deltaY > 0 — вниз, у WHEEL положительное — от себя (вверх).
                let mut list = Vec::new();
                if dy != 0 { list.push(mouse((0, 0), MOUSEEVENTF_WHEEL, -dy)); }
                if dx != 0 { list.push(mouse((0, 0), MOUSEEVENTF_HWHEEL, dx)); }
                send(&list);
            }
            "key" => {
                let Some(code) = e.get("code").and_then(Value::as_str) else { return };
                let Some((scan, extended)) = scan_code(code) else { return };
                let down = e.get("d").and_then(Value::as_i64).unwrap_or(0) != 0;
                if down { g.keys.insert(code.to_string()); } else if !g.keys.remove(code) { return; }
                send(&[key(scan, extended, down)]);
            }
            "release" => release_all(g),
            _ => {}
        }
    }

    fn point(monitor: isize, e: &Value) -> Option<(i32, i32)> {
        let x = unit(e.get("x")?)?;
        let y = unit(e.get("y")?)?;
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !unsafe { GetMonitorInfoW(HMONITOR(monitor as *mut _), &mut info) }.as_bool() {
            return None;
        }
        let r = info.rcMonitor;
        let desk = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        absolute_point(x, y, (r.left, r.top, r.right, r.bottom), desk)
    }

    fn button_flag(b: u8, down: bool) -> u32 {
        match (b, down) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (2, true) => MOUSEEVENTF_RIGHTDOWN,
            (2, false) => MOUSEEVENTF_RIGHTUP,
            (_, true) => MOUSEEVENTF_MIDDLEDOWN,
            (_, false) => MOUSEEVENTF_MIDDLEUP,
        }
    }

    fn mouse((dx, dy): (i32, i32), flags: u32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx, dy, mouseData: data as _, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    fn key(scan: u16, extended: bool, down: bool) -> INPUT {
        let mut flags = KEYEVENTF_SCANCODE;
        if extended { flags |= KEYEVENTF_EXTENDEDKEY; }
        if !down { flags |= KEYEVENTF_KEYUP; }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    fn send(inputs: &[INPUT]) {
        if inputs.is_empty() {
            return;
        }
        unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    }

    /// Отпустить всё, что мы держим: иначе после отключения у человека «залип» бы Shift.
    fn release_all(g: &mut Grant) {
        let mut list = Vec::new();
        for b in g.buttons.drain() {
            list.push(mouse((0, 0), button_flag(b, false), 0));
        }
        for code in g.keys.drain() {
            if let Some((scan, ext)) = scan_code(&code) {
                list.push(key(scan, ext, false));
            }
        }
        send(&list);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_digits_and_navigation_have_scan_codes() {
        assert_eq!(scan_code("KeyA"), Some((0x1E, false)));
        assert_eq!(scan_code("Digit0"), Some((0x0B, false)));
        assert_eq!(scan_code("ArrowLeft"), Some((0x4B, true)));
        assert_eq!(scan_code("ControlRight"), Some((0x1D, true)));
        assert_eq!(scan_code("Unknown"), None);
    }

    #[test]
    fn corners_of_the_primary_monitor_map_to_desktop_edges() {
        let mon = (0, 0, 1920, 1080);
        let desk = (0, 0, 1920, 1080);
        assert_eq!(absolute_point(0.0, 0.0, mon, desk), Some((0, 0)));
        assert_eq!(absolute_point(1.0, 1.0, mon, desk), Some((65535, 65535)));
        // Выход за кадр прижимается к краю, а не уходит на соседний монитор.
        assert_eq!(absolute_point(2.0, -1.0, mon, desk), Some((65535, 0)));
        assert_eq!(absolute_point(f64::NAN, 0.5, mon, desk), None);
    }

    #[test]
    fn second_monitor_left_of_primary_stays_inside_its_own_rect() {
        // Виртуальный стол: второй монитор слева (-1280..0), основной 0..1920.
        let desk = (-1280, 0, 3200, 1080);
        let (x, _) = absolute_point(1.0, 0.5, (-1280, 0, 0, 1024), desk).unwrap();
        // Правый край второго монитора — x = -1, левее основного.
        let px = -1280.0 + x as f64 * 3199.0 / 65535.0;
        assert!(px < 0.0 && px > -2.0, "px={px}");
    }

    #[test]
    fn peer_names_in_the_consent_dialog_cannot_carry_spoofing_characters() {
        assert_eq!(safe_peer_name("bob_2-x"), "bob_2-x");
        // RTL override, пробелы, кириллица-двойник «о», перевод строки — выбрасываются.
        assert_eq!(safe_peer_name("b\u{202E}ob Сист\u{043E}ма\nOK"), "bobOK");
        assert_eq!(safe_peer_name(&"a".repeat(100)).len(), 32);
    }

    #[test]
    fn only_display_sources_can_be_controlled() {
        assert_eq!(display_handle("display:65537"), Some(65537));
        assert_eq!(display_handle("window:1234"), None);
        assert_eq!(display_handle(""), None);
    }
}
