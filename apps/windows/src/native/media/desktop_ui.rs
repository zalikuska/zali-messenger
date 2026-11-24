//! Глобальные горячие клавиши и плашки поверх всех окон (страница —
//! web/src/interface/screen_privacy.js; зеркало macOS — HotkeyManager.swift и
//! DesktopOverlay.swift).
//!
//! Один свой поток с циклом сообщений: `RegisterHotKey` без окна привязывает сочетание к
//! вызвавшему потоку, и `WM_HOTKEY` приходит в его очередь; там же живут окна-плашки.
//! Команды из потока окна приложения — через канал и `PostThreadMessageW(WM_APP)`.
//!
//! Плашки (`hud` — отклик клавиши, гаснет сам; `privacy-warning` — «скрытие выключено»):
//! WS_EX_LAYERED|TRANSPARENT|TOPMOST|TOOLWINDOW|NOACTIVATE — клики насквозь, фокус не
//! забирают; `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` — окно нашего процесса,
//! в захват (WGC и чужие трансляции) не попадает. Не удалось выставить (Windows старше
//! 10 2004) — плашка не показывается: в трансляцию она попасть не должна.

use super::hotkey_codes;
use super::EventSink;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
    GetDC, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, SetBkMode, SetTextColor, SetWindowRgn,
    ANTIALIASED_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DT_CALCRECT, DT_CENTER, DT_END_ELLIPSIS,
    DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FW_SEMIBOLD, MONITORINFO, MONITOR_DEFAULTTOPRIMARY, OUT_DEFAULT_PRECIS,
    PAINTSTRUCT, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::GetDpiForSystem;
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetMessageW, KillTimer, PostThreadMessageW,
    RegisterClassW, SetLayeredWindowAttributes, SetTimer, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
    TranslateMessage, CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST, LWA_ALPHA, MSG, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE,
    WDA_EXCLUDEFROMCAPTURE, WINDOW_EX_STYLE, WM_APP, WM_HOTKEY, WM_PAINT, WM_TIMER, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

const ERROR_HOTKEY_ALREADY_REGISTERED: u32 = 1409;
const HIDE_TIMER: usize = 1;

enum Command {
    SetHotkeys { bindings: HashMap<String, String>, events: EventSink, reply: Sender<HashMap<String, String>> },
    Overlay { id: String, text: String, visible: bool, timeout_ms: u32 },
}

struct Ui {
    tx: Sender<Command>,
    thread_id: u32,
}

fn ui() -> Option<&'static Ui> {
    static UI: OnceLock<Option<Ui>> = OnceLock::new();
    UI.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let spawned = std::thread::Builder::new().name("zali-desktop-ui".into()).spawn(move || run(rx, ready_tx));
        if spawned.is_err() {
            return None;
        }
        let thread_id = ready_rx.recv_timeout(Duration::from_secs(3)).ok()?;
        Some(Ui { tx, thread_id })
    })
    .as_ref()
}

fn post(command: Command) -> bool {
    let Some(ui) = ui() else { return false };
    if ui.tx.send(command).is_err() {
        return false;
    }
    unsafe { PostThreadMessageW(ui.thread_id, WM_APP, WPARAM(0), LPARAM(0)).is_ok() }
}

/// op `set_hotkeys`: снять прежние, занять новые; ответ `{event:'hotkeys', results}`.
pub fn set_hotkeys(options: &Value, request_id: Option<String>, events: EventSink) {
    let bindings: HashMap<String, String> = options
        .get("bindings")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).take(16).collect())
        .unwrap_or_default();
    let (reply_tx, reply_rx) = mpsc::channel();
    let ok = post(Command::SetHotkeys { bindings, events: events.clone(), reply: reply_tx });
    std::thread::spawn(move || {
        let results = if ok { reply_rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default() } else { HashMap::new() };
        let mut payload = json!({ "event": "hotkeys", "results": results });
        if let Some(id) = request_id {
            payload["requestId"] = json!(id);
        }
        events.emit(payload);
    });
}

/// op `overlay`: `{id: hud|privacy-warning, text, visible, timeoutMs?}`.
pub fn overlay(options: &Value) {
    let id = options.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id != "hud" && id != "privacy-warning" {
        return;
    }
    let text: String = options.get("text").and_then(Value::as_str).unwrap_or("").chars().take(200).collect();
    let visible = options.get("visible").and_then(Value::as_bool).unwrap_or(true) && !text.is_empty();
    let timeout_ms = options.get("timeoutMs").and_then(Value::as_u64).unwrap_or(0).min(10_000) as u32;
    post(Command::Overlay { id, text, visible, timeout_ms });
}

// --- поток интерфейса ------------------------------------------------------------------

struct State {
    hotkeys: HashMap<i32, String>,
    events: Option<EventSink>,
    overlays: HashMap<String, isize>,
}

/// Текст и вид плашки по HWND — для WM_PAINT (оконная процедура без контекста).
fn overlay_texts() -> &'static Mutex<HashMap<isize, (Vec<u16>, bool)>> {
    static TEXTS: OnceLock<Mutex<HashMap<isize, (Vec<u16>, bool)>>> = OnceLock::new();
    TEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn run(rx: Receiver<Command>, ready: Sender<u32>) {
    let mut state = State { hotkeys: HashMap::new(), events: None, overlays: HashMap::new() };
    unsafe {
        let instance: HINSTANCE = GetModuleHandleW(None).map(Into::into).unwrap_or_default();
        let class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(overlay_proc),
            hInstance: instance,
            lpszClassName: w!("ZaliDesktopOverlay"),
            ..Default::default()
        };
        RegisterClassW(&class);
        // Очередь сообщений потока создаётся первым вызовом функции окон — до ready.
        let mut msg = MSG::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::PeekMessageW(&mut msg, None, 0, 0, windows::Win32::UI::WindowsAndMessaging::PM_NOREMOVE);
        let _ = ready.send(GetCurrentThreadId());
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.hwnd.0.is_null() && msg.message == WM_APP {
                while let Ok(command) = rx.try_recv() {
                    handle(&mut state, command, instance);
                }
                continue;
            }
            if msg.hwnd.0.is_null() && msg.message == WM_HOTKEY {
                if let (Some(action), Some(events)) = (state.hotkeys.get(&(msg.wParam.0 as i32)), state.events.as_ref()) {
                    tracing::info!("[ZALI][WIN] hotkey fired {action}");
                    events.emit(json!({ "event": "hotkey", "action": action }));
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn handle(state: &mut State, command: Command, instance: HINSTANCE) {
    match command {
        Command::SetHotkeys { bindings, events, reply } => {
            unsafe {
                for id in state.hotkeys.keys() {
                    let _ = UnregisterHotKey(None, *id);
                }
            }
            state.hotkeys.clear();
            state.events = Some(events);
            let mut results = HashMap::new();
            let mut sorted: Vec<_> = bindings.into_iter().collect();
            sorted.sort();
            for (i, (action, accel)) in sorted.into_iter().enumerate() {
                let Some((mods, vk)) = hotkey_codes::parse(&accel) else {
                    results.insert(action, "invalid".to_string());
                    continue;
                };
                let id = 0x5A00 + i as i32;
                let registered = unsafe { RegisterHotKey(None, id, HOT_KEY_MODIFIERS(mods) | MOD_NOREPEAT, vk) };
                match registered {
                    Ok(()) => {
                        state.hotkeys.insert(id, action.clone());
                        results.insert(action, "ok".to_string());
                    }
                    Err(error) => {
                        // Код Win32 из HRESULT ошибки (0x8007xxxx), а не повторный GetLastError.
                        let code = (error.code().0 as u32) & 0xFFFF;
                        tracing::info!("[ZALI][WIN] hotkey {action}={accel} failed error={code}");
                        results.insert(action, if code == ERROR_HOTKEY_ALREADY_REGISTERED { "conflict" } else { "invalid" }.to_string());
                    }
                }
            }
            tracing::info!("[ZALI][WIN] hotkeys applied {results:?}");
            let _ = reply.send(results);
        }
        Command::Overlay { id, text, visible, timeout_ms } => unsafe {
            let hwnd = match state.overlays.get(&id) {
                Some(h) => HWND(*h as *mut _),
                None => {
                    let Some(h) = create_overlay(instance) else { return };
                    state.overlays.insert(id.clone(), h.0 as isize);
                    h
                }
            };
            let _ = KillTimer(Some(hwnd), HIDE_TIMER);
            if !visible {
                let _ = ShowWindow(hwnd, SW_HIDE);
                return;
            }
            let warning = id == "privacy-warning";
            let shown = if warning { format!("⚠  {text}") } else { text };
            let wide: Vec<u16> = shown.encode_utf16().collect();
            overlay_texts().lock().unwrap_or_else(|p| p.into_inner()).insert(hwnd.0 as isize, (wide.clone(), warning));
            place_overlay(hwnd, &wide, warning);
            if timeout_ms > 0 {
                SetTimer(Some(hwnd), HIDE_TIMER, timeout_ms, None);
            }
        },
    }
}

fn scale() -> f32 {
    (unsafe { GetDpiForSystem() } as f32 / 96.0).max(1.0)
}

unsafe fn font() -> windows::Win32::Graphics::Gdi::HFONT {
    let face: Vec<u16> = "Segoe UI".encode_utf16().chain(Some(0)).collect();
    CreateFontW(
        -((15.0 * scale()).round() as i32), 0, 0, 0, FW_SEMIBOLD.0 as i32, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY, DEFAULT_PITCH.0 as u32, PCWSTR(face.as_ptr()),
    )
}

unsafe fn create_overlay(instance: HINSTANCE) -> Option<HWND> {
    let ex = WINDOW_EX_STYLE(WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0);
    let hwnd = CreateWindowExW(ex, w!("ZaliDesktopOverlay"), w!(""), WS_POPUP, 0, 0, 10, 10, None, None, Some(instance), None).ok()?;
    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 235, LWA_ALPHA);
    if let Err(error) = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
        tracing::warn!("[ZALI][WIN] overlay: WDA_EXCLUDEFROMCAPTURE unavailable ({error}) — overlay disabled");
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd);
        return None;
    }
    Some(hwnd)
}

unsafe fn place_overlay(hwnd: HWND, text: &[u16], warning: bool) {
    let k = scale();
    let dc = GetDC(Some(hwnd));
    let f = font();
    let old = SelectObject(dc, f.into());
    let mut measure = RECT::default();
    let mut buf = text.to_vec();
    DrawTextW(dc, &mut buf, &mut measure, DT_CALCRECT | DT_SINGLELINE | DT_NOPREFIX);
    SelectObject(dc, old);
    let _ = DeleteObject(f.into());
    ReleaseDC(Some(hwnd), dc);
    let pad = (18.0 * k) as i32;
    let height = (40.0 * k) as i32;
    // Монитор с курсором — туда человек сейчас смотрит.
    let mut cursor = POINT::default();
    let _ = GetCursorPos(&mut cursor);
    let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let _ = GetMonitorInfoW(monitor, &mut info);
    let work = info.rcWork;
    let width = ((measure.right - measure.left) + pad * 2).min((work.right - work.left) - pad * 2).max(120);
    let x = work.left + ((work.right - work.left) - width) / 2;
    let y = if warning { work.top + (12.0 * k) as i32 } else { work.bottom - height - (72.0 * k) as i32 };
    let radius = (24.0 * k) as i32;
    let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius, radius);
    SetWindowRgn(hwnd, Some(region), true);
    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, width, height, SWP_NOACTIVATE);
    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    windows::Win32::Graphics::Gdi::InvalidateRect(Some(hwnd), None, true).ok().ok();
}

unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut ps);
            let mut rect = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect);
            let background = CreateSolidBrush(COLORREF(0x0018_1410));
            FillRect(dc, &rect, background);
            let _ = DeleteObject(background.into());
            let entry = overlay_texts().lock().unwrap_or_else(|p| p.into_inner()).get(&(hwnd.0 as isize)).cloned();
            if let Some((mut text, warning)) = entry {
                let f = font();
                let old = SelectObject(dc, f.into());
                SetBkMode(dc, TRANSPARENT);
                // COLORREF — 0x00BBGGRR: янтарный для предупреждения, белый для отклика.
                SetTextColor(dc, if warning { COLORREF(0x0066_D6FF) } else { COLORREF(0x00FF_FFFF) });
                let mut inner = RECT { left: rect.left + 12, top: rect.top, right: rect.right - 12, bottom: rect.bottom };
                DrawTextW(dc, &mut text, &mut inner, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
                SelectObject(dc, old);
                let _ = DeleteObject(f.into());
            }
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_TIMER if wparam.0 == HIDE_TIMER => {
            let _ = KillTimer(Some(hwnd), HIDE_TIMER);
            let _ = ShowWindow(hwnd, SW_HIDE);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
