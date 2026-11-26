//! «Общий браузер» (web/src/interface/shared_browser.js) — Windows-половина.
//! Зеркало `apps/macos/.../Media/SharedBrowser.swift`, но не 1:1.
//!
//! - Скрытое окно (WS_POPUP за пределами экранов, WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE —
//!   без кнопки на панели задач и без активации) с отдельным WebView2: свой каталог
//!   данных (`SharedBrowser/own` — постоянный профиль приложения; `SharedBrowser/session-*`
//!   — временный для профиля сообщества, удаляется при закрытии), свои аргументы Chromium
//!   (без расчёта перекрытия окна и «фонового» троттлинга — иначе спрятанная страница
//!   перестаёт рисоваться).
//! - Кадры — тем же Windows.Graphics.Capture, что демонстрация окна (`screen::run` с
//!   `window:<hwnd>`), — кадры уходят странице как у обычной демонстрации.
//! - Ввод — протокол DevTools (`Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`):
//!   события идут прямо в страницу, без фокуса окна и без настоящего курсора.
//!   Масштаб растеризации зафиксирован 1.0: CSS-пиксели = пиксели окна = доли × размер.
//! - Куки профиля сообщества — `Network.setCookies` до первой загрузки и
//!   `Network.getAllCookies` по запросу страницы (формат CDP — общий с macOS и сервером).
//! - Ограничения: только http/https; запросы в локальную сеть/loopback получают 403
//!   (`WebResourceRequested` по шаблонам `PRIVATE_URL_PATTERNS`, не на всё — обработчик
//!   идёт в потоке окна мессенджера), загрузки и новые окна запрещены (новое окно —
//!   в этом же браузере), разрешения (камера, микрофон, геолокация…) — отказ, выбор файла
//!   перехватывается (`Page.setInterceptFileChooserDialog`), контекстные меню и диалоги
//!   скриптов выключены. DNS-rebinding правилами по адресу не ловится.
//!
//! Чистые правила (адреса, клавиши, куки) собираются на любой платформе и проверяются
//! тестами; всё Win32 — в `imp`.

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use serde_json::{json, Map, Value};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Сочетания с Ctrl/Cmd, которые можно отправить в браузер (без вставки/копирования —
/// они трогали бы буфер обмена запустившего). То же в странице и на macOS.
pub(crate) const ALLOWED_SHORTCUT_CODES: &[&str] = &[
    "KeyA", "KeyZ", "KeyY", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete", "Home", "End",
    "Enter", "Minus", "Equal", "Digit0",
];

/// Шаблоны `AddWebResourceRequestedFilter`, под которые попадает любой адрес локальной
/// сети/loopback (с запасом — точное решение принимает `allows_url`).
pub(crate) const PRIVATE_URL_PATTERNS: &[&str] = &[
    "*://0*", "*://1*", "*://2*", "*://3*", "*://4*", "*://5*", "*://6*", "*://7*", "*://8*", "*://9*",
    "*://[*", "*://*@*", "*://localhost*", "*://*.localhost*", "*://*.local/*", "*://*.local:*", "*://*.local",
    "*://*.internal*", "*://*.lan/*", "*://*.lan:*", "*://*.lan", "*://*.home.arpa*", "file:*",
];

/// Хост локальной сети/loopback (или числовая запись IPv4 без точек).
pub(crate) fn is_private_host(raw: &str) -> bool {
    let host = raw.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if host.is_empty() {
        return true;
    }
    if host == "localhost"
        || [".localhost", ".local", ".internal", ".lan", ".home.arpa"].iter().any(|s| host.ends_with(s))
    {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_ip(ip);
    }
    // 2130706433 / 0x7f000001 — тот же 127.0.0.1 в обход разбора по точкам.
    !host.contains('.') && !host.contains(':') && host.chars().all(|c| c.is_ascii_hexdigit() || c == 'x')
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_v4(v4);
            }
            let s = v6.segments();
            v6 == Ipv6Addr::UNSPECIFIED
                || v6 == Ipv6Addr::LOCALHOST
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xff00) == 0xff00
        }
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 0
        || o[0] == 10
        || o[0] == 127
        || (o[0] == 169 && o[1] == 254)
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        || o[0] >= 224
}

/// Можно ли «Общему браузеру» на этот адрес: http(s), без логина в адресе, не локальная сеть.
pub(crate) fn allows_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw.trim()) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(d)) => !is_private_host(d),
        Some(url::Host::Ipv4(ip)) => !is_private_v4(ip),
        Some(url::Host::Ipv6(ip)) => !is_private_ip(IpAddr::V6(ip)),
        None => false,
    }
}

/// Навигация верхнего документа: about:blank для старта, остальное — по `allows_url`.
pub(crate) fn allows_navigation(raw: &str) -> bool {
    let lowered = raw.trim().to_ascii_lowercase();
    lowered == "about:blank" || allows_url(raw)
}

/// Виртуальный код клавиши Windows по `KeyboardEvent.code` (для `windowsVirtualKeyCode`).
pub(crate) fn virtual_key(code: &str) -> Option<u16> {
    if let Some(letter) = code.strip_prefix("Key") {
        let c = letter.chars().next()?;
        return (letter.len() == 1 && c.is_ascii_uppercase()).then_some(c as u16);
    }
    if let Some(d) = code.strip_prefix("Digit") {
        let n: u16 = d.parse().ok()?;
        return (n <= 9).then_some(0x30 + n);
    }
    if let Some(d) = code.strip_prefix("Numpad") {
        if let Ok(n) = d.parse::<u16>() {
            return (n <= 9).then_some(0x60 + n);
        }
    }
    if let Some(f) = code.strip_prefix('F') {
        if let Ok(n) = f.parse::<u16>() {
            return (1..=24).contains(&n).then_some(0x6F + n);
        }
    }
    Some(match code {
        "Enter" | "NumpadEnter" => 0x0D,
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Escape" => 0x1B,
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
        "NumpadMultiply" => 0x6A,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadDecimal" => 0x6E,
        "NumpadDivide" => 0x6F,
        _ => return None,
    })
}

const MODIFIER_CODES: &[&str] = &[
    "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock",
];

/// Доля кадра → [0..1].
fn unit(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n.clamp(0.0, 1.0))
}

/// Кнопки мыши, зажатые этим браузером (для `buttons` и «отпустить всё»).
#[derive(Default, Debug, Clone, PartialEq)]
pub(crate) struct InputState {
    pub buttons: u8,
    pub keys: Vec<(String, String, u16)>,
}

fn button_name(b: u64) -> &'static str {
    match b {
        0 => "left",
        1 => "middle",
        _ => "right",
    }
}

fn button_bit(b: u64) -> u8 {
    match b {
        0 => 1,
        1 => 4,
        _ => 2,
    }
}

/// Событие страницы (уже отфильтрованное в вебе — здесь проверяется ещё раз) →
/// вызовы CDP `(метод, параметры)`. `width`/`height` — размер вьюпорта в CSS-пикселях.
pub(crate) fn cdp_calls(event: &Value, width: f64, height: f64, state: &mut InputState) -> Vec<(&'static str, Value)> {
    let t = event.get("t").and_then(Value::as_str).unwrap_or("");
    let point = || Some((unit(event.get("x"))? * width, unit(event.get("y"))? * height));
    let pressed_name = |buttons: u8| {
        if buttons & 1 != 0 {
            "left"
        } else if buttons & 2 != 0 {
            "right"
        } else if buttons & 4 != 0 {
            "middle"
        } else {
            "none"
        }
    };
    match t {
        "move" => {
            let Some((x, y)) = point() else { return vec![] };
            vec![(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseMoved", "x": x, "y": y, "button": pressed_name(state.buttons), "buttons": state.buttons }),
            )]
        }
        "down" | "up" => {
            let Some((x, y)) = point() else { return vec![] };
            let Some(b) = event.get("b").and_then(Value::as_u64).filter(|b| *b <= 2) else { return vec![] };
            let n = event.get("n").and_then(Value::as_u64).unwrap_or(1).clamp(1, 3);
            let bit = button_bit(b);
            let down = t == "down";
            if down {
                state.buttons |= bit;
            } else {
                if state.buttons & bit == 0 {
                    return vec![];
                }
                state.buttons &= !bit;
            }
            vec![(
                "Input.dispatchMouseEvent",
                json!({
                    "type": if down { "mousePressed" } else { "mouseReleased" },
                    "x": x, "y": y, "button": button_name(b), "buttons": state.buttons, "clickCount": n,
                }),
            )]
        }
        "wheel" => {
            let Some((x, y)) = point() else { return vec![] };
            let clamp = |k: &str| event.get(k).and_then(Value::as_f64).unwrap_or(0.0).clamp(-2000.0, 2000.0).round();
            let (dx, dy) = (clamp("dx"), clamp("dy"));
            if dx == 0.0 && dy == 0.0 {
                return vec![];
            }
            vec![("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy }))]
        }
        "key" => {
            let code = event.get("code").and_then(Value::as_str).unwrap_or("");
            if code.is_empty() || code.len() > 24 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
                return vec![];
            }
            if MODIFIER_CODES.contains(&code) {
                return vec![];
            }
            let Some(vk) = virtual_key(code) else { return vec![] };
            let key: String = event.get("key").and_then(Value::as_str).unwrap_or("").chars().take(24).collect();
            if key.chars().any(|c| c.is_control()) {
                return vec![];
            }
            let m = event.get("m").and_then(Value::as_u64).unwrap_or(0) & 15;
            let ctrl_or_meta = m & (2 | 8) != 0;
            if ctrl_or_meta && !ALLOWED_SHORTCUT_CODES.contains(&code) {
                return vec![];
            }
            if code == "Insert" && m & 1 != 0 {
                return vec![];
            }
            // Наше: shift=1 ctrl=2 alt=4 meta=8; CDP: alt=1 ctrl=2 meta=4 shift=8.
            let modifiers = (if m & 4 != 0 { 1 } else { 0 })
                | (if m & 2 != 0 { 2 } else { 0 })
                | (if m & 8 != 0 { 4 } else { 0 })
                | (if m & 1 != 0 { 8 } else { 0 });
            let down = event.get("d").and_then(Value::as_u64) == Some(1);
            if down {
                if !state.keys.iter().any(|(c, _, _)| c == code) {
                    state.keys.push((code.to_string(), key.clone(), vk));
                }
                let text = match code {
                    "Enter" | "NumpadEnter" => Some("\r".to_string()),
                    _ if key.chars().count() == 1 && !ctrl_or_meta => Some(key.clone()),
                    _ => None,
                };
                let mut params = json!({
                    "type": if text.is_some() { "keyDown" } else { "rawKeyDown" },
                    "key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": modifiers,
                });
                if let Some(text) = text {
                    params["text"] = json!(text);
                    params["unmodifiedText"] = json!(text);
                }
                vec![("Input.dispatchKeyEvent", params)]
            } else {
                let Some(pos) = state.keys.iter().position(|(c, _, _)| c == code) else { return vec![] };
                state.keys.remove(pos);
                vec![(
                    "Input.dispatchKeyEvent",
                    json!({ "type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": modifiers }),
                )]
            }
        }
        "text" => {
            let text: String = event.get("s").and_then(Value::as_str).unwrap_or("").chars().take(2000).collect();
            if text.is_empty() {
                return vec![];
            }
            vec![("Input.insertText", json!({ "text": text }))]
        }
        "release" => release_calls(width, height, state),
        _ => vec![],
    }
}

/// Отпустить всё, что этот браузер считает зажатым.
pub(crate) fn release_calls(width: f64, height: f64, state: &mut InputState) -> Vec<(&'static str, Value)> {
    let mut out = Vec::new();
    for (bit, name) in [(1u8, "left"), (2, "right"), (4, "middle")] {
        if state.buttons & bit != 0 {
            state.buttons &= !bit;
            out.push((
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseReleased", "x": width / 2.0, "y": height / 2.0, "button": name, "buttons": state.buttons, "clickCount": 1 }),
            ));
        }
    }
    for (code, key, vk) in state.keys.drain(..) {
        out.push(("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": vk })));
    }
    out
}

/// Кука страницы → `Network.CookieParam` (сессионная — без `expires`).
pub(crate) fn cookie_param(raw: &Value) -> Option<Value> {
    let c = raw.as_object()?;
    let text = |k: &str, max: usize| c.get(k).and_then(Value::as_str).filter(|s| s.len() <= max);
    let name = text("name", 256).filter(|s| !s.is_empty())?;
    let value = text("value", 4096)?;
    let domain = text("domain", 255).filter(|s| !s.is_empty())?;
    let path = text("path", 1024).filter(|p| p.starts_with('/')).unwrap_or("/");
    let secure = c.get("secure").and_then(Value::as_bool).unwrap_or(false);
    let mut out = Map::new();
    out.insert("name".into(), json!(name));
    out.insert("value".into(), json!(value));
    out.insert("domain".into(), json!(domain));
    out.insert("path".into(), json!(path));
    out.insert("secure".into(), json!(secure));
    out.insert("httpOnly".into(), json!(c.get("httpOnly").and_then(Value::as_bool).unwrap_or(false)));
    match c.get("sameSite").and_then(Value::as_str) {
        Some("Strict") => {
            out.insert("sameSite".into(), json!("Strict"));
        }
        Some("Lax") => {
            out.insert("sameSite".into(), json!("Lax"));
        }
        // None без Secure Chromium отвергает — тогда без явного SameSite.
        Some("None") if secure => {
            out.insert("sameSite".into(), json!("None"));
        }
        _ => {}
    }
    if let Some(expires) = c.get("expires").and_then(Value::as_f64).filter(|e| e.is_finite() && *e > 0.0) {
        out.insert("expires".into(), json!(expires));
    }
    Some(Value::Object(out))
}

/// `Network.getAllCookies` → куки в формате страницы/сервера.
pub(crate) fn cookies_from_cdp(result: &Value) -> Vec<Value> {
    result
        .get("cookies")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(2000)
                .filter_map(|c| {
                    let session = c.get("session").and_then(Value::as_bool).unwrap_or(false);
                    Some(json!({
                        "name": c.get("name")?.as_str()?,
                        "value": c.get("value")?.as_str()?,
                        "domain": c.get("domain")?.as_str()?,
                        "path": c.get("path").and_then(Value::as_str).unwrap_or("/"),
                        "expires": if session { -1.0 } else { c.get("expires").and_then(Value::as_f64).unwrap_or(-1.0) },
                        "httpOnly": c.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
                        "secure": c.get("secure").and_then(Value::as_bool).unwrap_or(false),
                        "sameSite": c.get("sameSite").and_then(Value::as_str).unwrap_or("Lax"),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
pub(crate) use imp::*;

#[cfg(target_os = "windows")]
mod imp {
    use super::super::hub::StartContext;
    use super::super::{screen, EventSink};
    use super::*;
    use crate::native::AppEvent;
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::sync::{Mutex, OnceLock};
    use tao::event_loop::EventLoopProxy;
    use tracing::{info, warn};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, DocumentTitleChangedEventHandler, HistoryChangedEventHandler,
        NavigationCompletedEventHandler, NavigationStartingEventHandler, PermissionRequestedEventHandler,
        ScriptDialogOpeningEventHandler, SourceChangedEventHandler, WebResourceRequestedEventHandler,
    };
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, ShowWindow, SW_SHOWNOACTIVATE, WNDCLASSW,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    };
    use windows052::core::{ComInterface, HSTRING, PWSTR};
    use windows052::Win32::System::WinRT::EventRegistrationToken;
    use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

    /// Команды из `hub` (любой поток) — исполняются в потоке окна (`main.rs`).
    #[derive(Clone)]
    pub enum Command {
        Open(Box<OpenRequest>),
        Input { stream: u32, event: Value },
        Nav { stream: u32, action: String, url: String },
        Cookies { stream: u32, request_id: Option<String>, events: EventSink },
        Close { stream: u32 },
    }

    /// Без кук и адресов: AppEvent пишется в журнал через Debug.
    impl std::fmt::Debug for Command {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Command::Open(r) => write!(f, "SharedBrowser::Open(stream={})", r.ctx.stream),
                Command::Input { stream, .. } => write!(f, "SharedBrowser::Input(stream={stream})"),
                Command::Nav { stream, action, .. } => write!(f, "SharedBrowser::Nav(stream={stream}, {action})"),
                Command::Cookies { stream, .. } => write!(f, "SharedBrowser::Cookies(stream={stream})"),
                Command::Close { stream } => write!(f, "SharedBrowser::Close(stream={stream})"),
            }
        }
    }

    #[derive(Clone)]
    pub struct OpenRequest {
        pub ctx: StartContext,
        pub url: String,
        pub profile: String,
        pub cookies: Vec<Value>,
        pub width: u32,
        pub height: u32,
        pub fps: u64,
    }

    /// Потоки, за которыми стоит общий браузер: их конец закрывает окно.
    fn browser_streams() -> std::sync::MutexGuard<'static, HashSet<u32>> {
        static STREAMS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
        STREAMS.get_or_init(|| Mutex::new(HashSet::new())).lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn mark_browser_stream(stream: u32) {
        browser_streams().insert(stream);
    }

    pub(crate) fn is_browser_stream(stream: u32) -> bool {
        browser_streams().contains(&stream)
    }

    /// Поток закончился (страница остановила, захват оборвался) — закрыть его браузер.
    pub(crate) fn stream_finished(stream: u32, proxy: &EventLoopProxy<AppEvent>) {
        if browser_streams().remove(&stream) {
            let _ = proxy.send_event(AppEvent::SharedBrowser(Command::Close { stream }));
        }
    }

    /// Частота основного монитора (Гц) в пределах 30…240; не узнали — 60.
    pub(crate) fn display_refresh_rate() -> u64 {
        use windows::Win32::Graphics::Gdi::{EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS};
        let mut mode = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
        let ok = unsafe { EnumDisplaySettingsW(windows::core::PCWSTR::null(), ENUM_CURRENT_SETTINGS, &mut mode).as_bool() };
        // 0 и 1 — «по умолчанию у устройства».
        let hz = if ok && mode.dmDisplayFrequency > 1 { mode.dmDisplayFrequency as u64 } else { 60 };
        hz.clamp(30, 240)
    }

    pub(crate) fn close_all(proxy: &EventLoopProxy<AppEvent>) {
        let streams: Vec<u32> = browser_streams().drain().collect();
        for stream in streams {
            let _ = proxy.send_event(AppEvent::SharedBrowser(Command::Close { stream }));
        }
    }

    struct Browser {
        hwnd: HWND,
        webview: WebView,
        _context: WebContext,
        core: ICoreWebView2,
        width: f64,
        height: f64,
        input: InputState,
        temp_dir: Option<PathBuf>,
        inputs: u64,
        /// Главный процесс WebView2 этого браузера: по нему process loopback берёт звук страниц.
        pid: Option<u32>,
    }

    /// Все общие браузеры этого окна (обычно один). Живёт в потоке окна.
    #[derive(Default)]
    pub struct Browsers {
        open: HashMap<u32, Browser>,
    }

    impl Browsers {
        pub fn handle(&mut self, command: Command) {
            match command {
                Command::Open(request) => self.open(*request),
                Command::Input { stream, event } => {
                    if let Some(b) = self.open.get_mut(&stream) {
                        b.inputs += 1;
                        let calls = cdp_calls(&event, b.width, b.height, &mut b.input);
                        for (method, params) in calls {
                            cdp(&b.core, method, &params, |_| {});
                        }
                    }
                }
                Command::Nav { stream, action, url } => {
                    if let Some(b) = self.open.get(&stream) {
                        unsafe {
                            let _ = match action.as_str() {
                                "go" if allows_url(&url) => b.core.Navigate(&HSTRING::from(url.as_str())),
                                "back" => b.core.GoBack(),
                                "forward" => b.core.GoForward(),
                                "reload" => b.core.Reload(),
                                "stop" => b.core.Stop(),
                                _ => Ok(()),
                            };
                        }
                    }
                }
                Command::Cookies { stream, request_id, events } => {
                    let Some(b) = self.open.get(&stream) else {
                        events.error(request_id.as_deref(), None, "not_found", "общий браузер не открыт");
                        return;
                    };
                    cdp(&b.core, "Network.getAllCookies", &json!({}), move |result| {
                        let cookies = result.as_ref().map(cookies_from_cdp).unwrap_or_default();
                        let mut payload = json!({ "event": "browser_cookies", "stream": stream, "cookies": cookies });
                        if let Some(id) = &request_id {
                            payload["requestId"] = json!(id);
                        }
                        events.emit(payload);
                    });
                }
                Command::Close { stream } => {
                    if let Some(b) = self.open.remove(&stream) {
                        close_browser(stream, b);
                    }
                }
            }
        }

        fn open(&mut self, request: OpenRequest) {
            let OpenRequest { ctx, url, profile, cookies, width, height, fps } = request;
            let stream = ctx.stream;
            if ctx.stopped() {
                return;
            }
            if self.open.contains_key(&stream) {
                ctx.fail("busy", "общий браузер с этим потоком уже открыт");
                return;
            }
            if !allows_url(&url) {
                ctx.fail("failed", "недопустимый адрес");
                return;
            }
            match build(&ctx, stream, &url, &profile, &cookies, width, height) {
                Ok(browser) => {
                    let hwnd = browser.hwnd.0 as isize;
                    mark_browser_stream(stream);
                    self.open.insert(stream, browser);
                    // Кадры — обычный захват окна (screen.rs) без курсора. Звук — process
                    // loopback только по дереву процессов этого WebView2 (screen.rs, `audioPid`):
                    // «весь звук системы минус мессенджер» сюда не годится — браузер
                    // как раз часть мессенджера, и участники его не слышали. Без pid — без звука.
                    let audio_pid = self.open.get(&stream).and_then(|b| b.pid);
                    let mut capture = ctx.clone();
                    capture.source_id = format!("window:{hwnd}");
                    capture.options = match audio_pid {
                        Some(pid) => json!({ "fps": fps, "maxHeight": height, "audio": true, "audioPid": pid, "cursor": false }),
                        None => json!({ "fps": fps, "maxHeight": height, "audio": false, "cursor": false }),
                    };
                    let spawned = std::thread::Builder::new()
                        .name("zali-media-browser".into())
                        .spawn(move || screen::run(capture));
                    if let Err(error) = spawned {
                        ctx.fail("failed", format!("поток захвата браузера: {error}"));
                    }
                    info!("[ZALI][WIN] shared browser opened stream={stream} {width}x{height} profile={profile} cookies={}", cookies.len());
                }
                Err(message) => ctx.fail("failed", message),
            }
        }
    }

    fn close_browser(stream: u32, browser: Browser) {
        let Browser { hwnd, webview, _context, temp_dir, inputs, .. } = browser;
        drop(webview);
        drop(_context);
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        info!("[ZALI][WIN] shared browser closed stream={stream} inputs={inputs}");
        if let Some(dir) = temp_dir {
            // Процессы WebView2 отпускают каталог не сразу — удаляем с повторами.
            let _ = std::thread::Builder::new().name("zali-browser-cleanup".into()).spawn(move || {
                for _ in 0..20 {
                    if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                warn!("[ZALI][WIN] shared browser temp profile not removed: {}", dir.display());
            });
        }
    }

    fn profiles_root() -> PathBuf {
        crate::native::NativeState::app_data_dir().join("SharedBrowser")
    }

    /// Временные профили сообщества, оставшиеся от прошлых запусков (падение, выход).
    fn sweep_stale_sessions() {
        let Ok(entries) = std::fs::read_dir(profiles_root()) else { return };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("session-") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn create_window(width: u32, height: u32) -> Result<HWND, String> {
        static CLASS: OnceLock<bool> = OnceLock::new();
        unsafe {
            let instance = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandleW: {e}"))?;
            let registered = *CLASS.get_or_init(|| {
                let class = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: instance.into(),
                    lpszClassName: w!("ZaliSharedBrowser"),
                    ..Default::default()
                };
                RegisterClassW(&class) != 0
            });
            if !registered {
                return Err("RegisterClassW".into());
            }
            // За пределами экранов, но не -32000 (так Windows помечает свёрнутые окна).
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("ZaliSharedBrowser"),
                w!("Zali Shared Browser"),
                WS_POPUP,
                -12000,
                -12000,
                width as i32,
                height as i32,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .map_err(|e| format!("CreateWindowExW: {e}"))?;
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            Ok(hwnd)
        }
    }

    struct RawHwnd(isize);

    unsafe impl raw_window_handle::HasRawWindowHandle for RawHwnd {
        fn raw_window_handle(&self) -> raw_window_handle::RawWindowHandle {
            let mut handle = raw_window_handle::Win32WindowHandle::empty();
            handle.hwnd = self.0 as *mut std::ffi::c_void;
            raw_window_handle::RawWindowHandle::Win32(handle)
        }
    }

    fn build(
        ctx: &StartContext,
        stream: u32,
        url: &str,
        profile: &str,
        cookies: &[Value],
        width: u32,
        height: u32,
    ) -> Result<Browser, String> {
        let width = width.clamp(640, 1920) & !1;
        let height = height.clamp(360, 1080) & !1;
        let community = profile == "community";
        let root = profiles_root();
        if community {
            sweep_stale_sessions();
        }
        let dir = if community {
            root.join(format!("session-{}-{stream}", std::process::id()))
        } else {
            root.join("own")
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("каталог профиля: {e}"))?;
        let hwnd = create_window(width, height)?;
        let raw = RawHwnd(hwnd.0 as isize);
        let mut context = WebContext::new(Some(dir.clone()));
        let proxy = ctx.events.proxy().clone();
        let built = WebViewBuilder::new(&raw)
            .with_web_context(&mut context)
            .with_devtools(false)
            .with_hotkeys_zoom(false)
            .with_autoplay(true)
            .with_browser_accelerator_keys(false)
            // Свои аргументы заменяют аргументы wry целиком — его умолчания повторены.
            .with_additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
                 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
                 --autoplay-policy=no-user-gesture-required",
            )
            .with_navigation_handler(|url| allows_navigation(&url))
            // Загрузок на компьютер запустившего нет.
            .with_download_started_handler(|_, _| false)
            // Новое окно — в этом же браузере.
            .with_new_window_req_handler(move |url| {
                if allows_url(&url) {
                    let _ = proxy.send_event(AppEvent::SharedBrowser(Command::Nav { stream, action: "go".into(), url }));
                }
                false
            })
            .build();
        let webview = match built {
            Ok(webview) => webview,
            Err(error) => {
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
                return Err(format!("WebView2: {error}"));
            }
        };
        let core = match configure(&webview, ctx.events.clone(), stream) {
            Ok(core) => core,
            Err(error) => {
                drop(webview);
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
                return Err(format!("WebView2: {error}"));
            }
        };
        // Сначала перехват выбора файла и куки — потом первая загрузка.
        cdp(&core, "Page.enable", &json!({}), |_| {});
        cdp(&core, "Page.setInterceptFileChooserDialog", &json!({ "enabled": true }), |_| {});
        let params: Vec<Value> = if community { cookies.iter().take(2000).filter_map(cookie_param).collect() } else { Vec::new() };
        let target = HSTRING::from(url);
        let core_for_nav = core.clone();
        let navigate = move || unsafe {
            let _ = core_for_nav.Navigate(&target);
        };
        if params.is_empty() {
            navigate();
        } else {
            cdp(&core, "Network.setCookies", &json!({ "cookies": params }), move |result| {
                if result.is_none() {
                    warn!("[ZALI][WIN] shared browser: Network.setCookies failed");
                }
                navigate();
            });
        }
        let pid = unsafe {
            let mut pid = 0u32;
            core.cast::<ICoreWebView2_2>()
                .ok()
                .and_then(|c| c.BrowserProcessId(&mut pid).ok().map(|_| pid))
                .filter(|pid| *pid != 0)
        };
        Ok(Browser {
            hwnd,
            webview,
            _context: context,
            core,
            width: width as f64,
            height: height as f64,
            input: InputState::default(),
            temp_dir: community.then_some(dir),
            inputs: 0,
            pid,
        })
    }

    /// Настройки, запреты и события состояния. Возвращает ICoreWebView2.
    fn configure(webview: &WebView, events: EventSink, stream: u32) -> windows052::core::Result<ICoreWebView2> {
        unsafe {
            let controller = webview.controller();
            let _ = controller.SetIsVisible(true);
            if let Ok(c3) = controller.cast::<ICoreWebView2Controller3>() {
                // CSS-пиксели = пиксели окна при любом масштабе экрана.
                let _ = c3.SetShouldDetectMonitorScaleChanges(false);
                let _ = c3.SetRasterizationScale(1.0);
            }
            let core = controller.CoreWebView2()?;
            let settings = core.Settings()?;
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            let _ = settings.SetAreDefaultScriptDialogsEnabled(false);
            let _ = settings.SetIsStatusBarEnabled(false);
            let _ = settings.SetIsZoomControlEnabled(false);
            let _ = settings.SetAreDevToolsEnabled(false);
            let _ = settings.SetIsBuiltInErrorPageEnabled(true);
            let mut token = EventRegistrationToken::default();

            // Локальная сеть и loopback — 403 для любых запросов страницы.
            let env = core.cast::<ICoreWebView2_2>()?.Environment()?;
            // Не «*»: обработчик идёт в потоке окна мессенджера, а тяжёлая страница — это
            // сотни запросов. Шаблоны WebView2 (только «*») ловят всё, что может оказаться
            // локальным адресом: числовые хосты (начинаются с цифры), IPv6-литералы, логин
            // в адресе, локальные имена; окончательно решает `allows_url` в обработчике.
            for pattern in PRIVATE_URL_PATTERNS {
                core.AddWebResourceRequestedFilter(&HSTRING::from(*pattern), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
            }
            core.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let request = args.Request()?;
                    let mut raw = PWSTR::null();
                    request.Uri(&mut raw)?;
                    let uri = take_pwstr(raw);
                    let lowered = uri.to_ascii_lowercase();
                    let blocked = if lowered.starts_with("http://") || lowered.starts_with("https://") || lowered.starts_with("ws://") || lowered.starts_with("wss://") {
                        let as_http = lowered.replacen("ws", "http", 1);
                        url::Url::parse(if lowered.starts_with("ws") { &as_http } else { &uri })
                            .map(|u| !allows_url(u.as_str()))
                            .unwrap_or(true)
                    } else {
                        lowered.starts_with("file:")
                    };
                    if blocked {
                        let response = env.CreateWebResourceResponse(None, 403, windows052::core::w!("Blocked"), windows052::core::w!(""))?;
                        args.SetResponse(&response)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;

            // Камера, микрофон, геолокация, уведомления, буфер обмена… — отказ.
            core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            // Диалоги скриптов не показываются (их некому закрыть): обработчик без Accept — отмена.
            core.add_ScriptDialogOpening(&ScriptDialogOpeningEventHandler::create(Box::new(|_, _| Ok(()))), &mut token)?;

            // Состояние для страницы: адрес, заголовок, история, загрузка.
            let loading = Rc::new(RefCell::new(true));
            let emit = {
                let loading = Rc::clone(&loading);
                let core = core.clone();
                Rc::new(move || {
                    let mut back = windows052::Win32::Foundation::BOOL::default();
                    let mut forward = windows052::Win32::Foundation::BOOL::default();
                    let _ = core.CanGoBack(&mut back);
                    let _ = core.CanGoForward(&mut forward);
                    let mut source = PWSTR::null();
                    let _ = core.Source(&mut source);
                    let mut title = PWSTR::null();
                    let _ = core.DocumentTitle(&mut title);
                    events.emit(json!({
                        "event": "browser_state",
                        "stream": stream,
                        "url": take_pwstr(source),
                        "title": take_pwstr(title),
                        "canBack": back.as_bool(),
                        "canForward": forward.as_bool(),
                        "loading": *loading.borrow(),
                    }));
                })
            };
            {
                let emit = Rc::clone(&emit);
                let loading = Rc::clone(&loading);
                core.add_NavigationStarting(
                    &NavigationStartingEventHandler::create(Box::new(move |_, _| {
                        *loading.borrow_mut() = true;
                        emit();
                        Ok(())
                    })),
                    &mut token,
                )?;
            }
            {
                let emit = Rc::clone(&emit);
                let loading = Rc::clone(&loading);
                core.add_NavigationCompleted(
                    &NavigationCompletedEventHandler::create(Box::new(move |_, _| {
                        *loading.borrow_mut() = false;
                        emit();
                        Ok(())
                    })),
                    &mut token,
                )?;
            }
            {
                let emit = Rc::clone(&emit);
                core.add_SourceChanged(&SourceChangedEventHandler::create(Box::new(move |_, _| { emit(); Ok(()) })), &mut token)?;
            }
            {
                let emit = Rc::clone(&emit);
                core.add_HistoryChanged(&HistoryChangedEventHandler::create(Box::new(move |_, _| { emit(); Ok(()) })), &mut token)?;
            }
            {
                let emit = Rc::clone(&emit);
                core.add_DocumentTitleChanged(
                    &DocumentTitleChangedEventHandler::create(Box::new(move |_, _| { emit(); Ok(()) })),
                    &mut token,
                )?;
            }
            Ok(core)
        }
    }

    fn take_pwstr(raw: PWSTR) -> String {
        if raw.is_null() {
            return String::new();
        }
        unsafe {
            let text = raw.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(raw.0 as *const _));
            text
        }
    }

    /// Вызов протокола DevTools; `done` получает разобранный JSON ответа или None.
    fn cdp(core: &ICoreWebView2, method: &str, params: &Value, done: impl FnOnce(Option<Value>) + 'static) {
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            done(result.ok().and_then(|_| serde_json::from_str::<Value>(&json).ok()));
            Ok(())
        }));
        unsafe {
            let method = HSTRING::from(method);
            let params = HSTRING::from(params.to_string());
            if let Err(error) = core.CallDevToolsProtocolMethod(&method, &params, &handler) {
                warn!("[ZALI][WIN] shared browser CDP call failed: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_hosts_are_refused() {
        for url in [
            "http://localhost:3000/", "http://127.0.0.1/", "https://10.1.2.3/", "http://192.168.0.1/admin",
            "http://172.20.0.5/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://[fe80::1]/",
            "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f000001/", "http://router.local/",
            "http://user@example.com/", "file:///C:/Windows/win.ini", "javascript:alert(1)", "zali://localhost/index.html",
        ] {
            assert!(!allows_url(url), "{url} must be refused");
        }
        for url in ["https://www.youtube.com/watch?v=x", "http://example.com/", "https://8.8.8.8/", "https://[2606:4700::1111]/"] {
            assert!(allows_url(url), "{url} must be allowed");
        }
        assert!(allows_navigation("about:blank"));
        assert!(!allows_navigation("about:config"));
    }

    /// Упрощённое сопоставление шаблонов WebView2 (`*` — любые символы).
    fn wildcard(pattern: &str, text: &str) -> bool {
        let parts: Vec<&str> = pattern.split('*').collect();
        let mut rest = text;
        for (i, part) in parts.iter().enumerate() {
            if i == 0 {
                if !rest.starts_with(part) { return false; }
                rest = &rest[part.len()..];
            } else if i == parts.len() - 1 && !part.is_empty() {
                return rest.ends_with(part);
            } else if let Some(at) = rest.find(part) {
                rest = &rest[at + part.len()..];
            } else {
                return false;
            }
        }
        true
    }

    #[test]
    fn private_urls_reach_the_request_filter() {
        for url in [
            "http://localhost:3000/", "http://127.0.0.1/", "https://10.1.2.3/", "http://192.168.0.1/admin",
            "http://172.20.0.5/", "http://169.254.169.254/latest", "http://[::1]/", "http://2130706433/",
            "http://0x7f000001/", "http://router.local/", "http://nas.local:5000/", "http://user@example.com/",
            "ws://127.0.0.1:9000/media", "http://box.lan/", "http://printer.home.arpa/", "file:///C:/x",
        ] {
            assert!(PRIVATE_URL_PATTERNS.iter().any(|p| wildcard(p, url)), "{url} must hit a filter");
        }
        assert!(!PRIVATE_URL_PATTERNS.iter().any(|p| wildcard(p, "https://www.youtube.com/watch?v=x")));
    }

    #[test]
    fn mouse_and_keys_become_cdp_calls() {
        let mut state = InputState::default();
        let calls = cdp_calls(&json!({ "t": "down", "x": 0.5, "y": 0.25, "b": 0, "n": 2 }), 1280.0, 720.0, &mut state);
        assert_eq!(calls[0].1["type"], "mousePressed");
        assert_eq!(calls[0].1["x"], 640.0);
        assert_eq!(calls[0].1["y"], 180.0);
        assert_eq!(calls[0].1["clickCount"], 2);
        assert_eq!(state.buttons, 1);
        let drag = cdp_calls(&json!({ "t": "move", "x": 0.6, "y": 0.25 }), 1280.0, 720.0, &mut state);
        assert_eq!(drag[0].1["button"], "left");
        let up = cdp_calls(&json!({ "t": "up", "x": 0.6, "y": 0.25, "b": 0 }), 1280.0, 720.0, &mut state);
        assert_eq!(up[0].1["type"], "mouseReleased");
        assert!(cdp_calls(&json!({ "t": "up", "x": 0.6, "y": 0.25, "b": 0 }), 1280.0, 720.0, &mut state).is_empty());

        let typed = cdp_calls(&json!({ "t": "key", "code": "KeyS", "key": "ы", "d": 1, "m": 1 }), 1280.0, 720.0, &mut state);
        assert_eq!(typed[0].1["type"], "keyDown");
        assert_eq!(typed[0].1["text"], "ы");
        assert_eq!(typed[0].1["windowsVirtualKeyCode"], 0x53);
        assert_eq!(typed[0].1["modifiers"], 8);
        let enter = cdp_calls(&json!({ "t": "key", "code": "Enter", "key": "Enter", "d": 1, "m": 0 }), 1280.0, 720.0, &mut state);
        assert_eq!(enter[0].1["text"], "\r");
        let arrow = cdp_calls(&json!({ "t": "key", "code": "ArrowLeft", "key": "ArrowLeft", "d": 1, "m": 0 }), 1280.0, 720.0, &mut state);
        assert_eq!(arrow[0].1["type"], "rawKeyDown");
        // Вставка/копирование чужого буфера обмена — не отправляются.
        assert!(cdp_calls(&json!({ "t": "key", "code": "KeyV", "key": "v", "d": 1, "m": 2 }), 1280.0, 720.0, &mut state).is_empty());
        assert!(cdp_calls(&json!({ "t": "key", "code": "KeyC", "key": "c", "d": 1, "m": 8 }), 1280.0, 720.0, &mut state).is_empty());
        assert!(cdp_calls(&json!({ "t": "key", "code": "Insert", "key": "Insert", "d": 1, "m": 1 }), 1280.0, 720.0, &mut state).is_empty());
        let select_all = cdp_calls(&json!({ "t": "key", "code": "KeyA", "key": "a", "d": 1, "m": 2 }), 1280.0, 720.0, &mut state);
        assert_eq!(select_all[0].1["type"], "rawKeyDown");
        assert_eq!(select_all[0].1["modifiers"], 2);

        let released = release_calls(1280.0, 720.0, &mut state);
        assert_eq!(released.len(), 4, "ы, Enter, ArrowLeft, KeyA");
        assert!(state.keys.is_empty());
    }

    #[test]
    fn cookies_round_trip_through_cdp_format() {
        let param = cookie_param(&json!({ "name": "sid", "value": "v", "domain": ".ex.com", "path": "/", "expires": -1, "secure": false, "sameSite": "None" })).unwrap();
        assert!(param.get("expires").is_none(), "сессионная кука — без срока");
        assert!(param.get("sameSite").is_none(), "None без Secure не отправляется");
        assert!(cookie_param(&json!({ "name": "", "value": "v", "domain": "ex.com" })).is_none());
        let back = cookies_from_cdp(&json!({ "cookies": [
            { "name": "a", "value": "1", "domain": "ex.com", "path": "/", "expires": 1900000000.0, "session": false, "httpOnly": true, "secure": true, "sameSite": "Strict" },
            { "name": "b", "value": "2", "domain": "ex.com", "path": "/", "expires": -1, "session": true }
        ]}));
        assert_eq!(back.len(), 2);
        assert_eq!(back[0]["sameSite"], "Strict");
        assert_eq!(back[1]["expires"], -1.0);
    }
}
