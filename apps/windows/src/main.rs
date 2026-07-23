mod native;

use native::{AppEvent, NativeState};
use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use tao::{
    event::{Event, WindowEvent},
    event_loop::ControlFlow,
    window::WindowBuilder,
};
use tracing::{error, info};
use wry::{http::Response, WebViewBuilder};

#[cfg(target_os = "windows")]
fn set_windows_app_user_model_id() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let app_id: Vec<u16> = OsStr::new("com.zali.messenger")
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }
}

/// Solid brand-lime (`--lime: #cbff00` in web/style.css) square — a placeholder tray
/// glyph. Generated in-process instead of shipping a `.ico`/pulling in an image-decode
/// crate just for one small icon; swap for a real multi-res `.ico` as a cosmetic
/// follow-up (see `tray_icon::Icon::from_path` if/when one exists in the repo).
#[cfg(target_os = "windows")]
fn tray_icon_image() -> tray_icon::Icon {
    const SIZE: u32 = 32;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for _ in 0..(SIZE * SIZE) {
        rgba.extend_from_slice(&[0xcb, 0xff, 0x00, 0xff]);
    }
    tray_icon::Icon::from_rgba(rgba, SIZE, SIZE).expect("valid solid-color tray icon")
}

/// Builds the tray icon + its context menu, and starts a background thread that
/// forwards tray/menu click events into the tao event loop via `proxy` — tray-icon's
/// events arrive on their own global channel (`TrayIconEvent`/`MenuEvent::receiver()`),
/// not through tao directly, so they need bridging the same way this codebase already
/// bridges async native work into the UI thread (`dispatch_ui_event`, `AppEvent::Quit`).
/// Returns the `TrayIcon` — like the macOS menu, it must be kept alive for the
/// lifetime of the process (dropping it removes the tray icon).
#[cfg(target_os = "windows")]
fn install_windows_tray(proxy: tao::event_loop::EventLoopProxy<AppEvent>) -> tray_icon::TrayIcon {
    use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem};

    let menu = Menu::new();
    let show_item = MenuItem::with_id("tray-show", "Открыть", true, None);
    let quit_item = MenuItem::with_id("tray-quit", "Выход", true, None);
    let _ = menu.append_items(&[
        &show_item,
        &PredefinedMenuItem::separator(),
        &quit_item,
    ]);

    let tray = tray_icon::TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_icon(tray_icon_image())
        .with_tooltip("Zali Messenger")
        .build()
        .expect("failed to create tray icon");

    let show_id = show_item.id().clone();
    let quit_id = quit_item.id().clone();
    std::thread::spawn(move || {
        let menu_rx = tray_icon::menu::MenuEvent::receiver();
        let tray_rx = tray_icon::TrayIconEvent::receiver();
        loop {
            crossbeam_channel::select! {
                recv(menu_rx) -> event => {
                    if let Ok(event) = event {
                        let id = event.id().clone();
                        if id == show_id {
                            let _ = proxy.send_event(AppEvent::TrayShow);
                        } else if id == quit_id {
                            let _ = proxy.send_event(AppEvent::Quit);
                        }
                    }
                }
                recv(tray_rx) -> event => {
                    if let Ok(tray_icon::TrayIconEvent::Click { .. }) = event {
                        let _ = proxy.send_event(AppEvent::TrayShow);
                    }
                }
            }
        }
    });

    tray
}

/// Standard shortcuts (Cmd+C/V/X/A/Q) inside WKWebView only work when the app has
/// a menu bar with the matching selectors, so install a minimal one. Returns the
/// menu because it must stay alive for the lifetime of the process.
#[cfg(target_os = "macos")]
fn install_macos_menu() -> muda::Menu {
    use muda::{Menu, PredefinedMenuItem, Submenu};

    let menu = Menu::new();
    let app_menu = Submenu::new("Zali Messenger", true);
    let _ = app_menu.append_items(&[
        &PredefinedMenuItem::hide(None),
        &PredefinedMenuItem::hide_others(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::quit(None),
    ]);
    let edit_menu = Submenu::new("Edit", true);
    let _ = edit_menu.append_items(&[
        &PredefinedMenuItem::undo(None),
        &PredefinedMenuItem::redo(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None),
        &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::select_all(None),
    ]);
    let window_menu = Submenu::new("Window", true);
    let _ = window_menu.append_items(&[
        &PredefinedMenuItem::minimize(None),
        &PredefinedMenuItem::close_window(None),
    ]);
    let _ = menu.append_items(&[&app_menu, &edit_menu, &window_menu]);
    menu.init_for_nsapp();
    menu
}

/// Зеркало инварианта Swift-клиента (`WebView.swift`, `requestMediaCapturePermissionFor`):
/// камеру/микрофон получает только главный фрейм собственного origin приложения.
/// wry 0.35 на macOS >= 14 не реализует этот метод WKUIDelegate, из-за чего WebKit
/// показывает отдельный диалог разрешения на каждый origin; отвечаем сами —
/// Grant для zali:// и localhost, Deny для всего остального. Системный TCC-запрос
/// на микрофон при первом использовании остаётся, это ожидаемо.
#[cfg(target_os = "macos")]
fn install_media_capture_policy(webview: &wry::WebView) {
    use objc::runtime::{Class, Object, Sel, BOOL, NO, YES};
    use objc::{msg_send, sel, sel_impl};
    use std::ffi::c_void;
    use std::os::raw::c_char;
    use wry::WebViewExtMacOS;

    type Id = *mut Object;

    unsafe fn ns_string(value: Id) -> String {
        if value.is_null() {
            return String::new();
        }
        let utf8: *const c_char = msg_send![value, UTF8String];
        if utf8.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned()
    }

    extern "C" fn request_media_capture_permission(
        _this: &Object,
        _sel: Sel,
        _webview: Id,
        origin: Id,
        frame: Id,
        _capture_type: isize,
        decision_handler: Id,
    ) {
        // WKPermissionDecision: 0 = Prompt, 1 = Grant, 2 = Deny
        let decision: isize = unsafe {
            let is_main_frame: BOOL = msg_send![frame, isMainFrame];
            let protocol = ns_string(msg_send![origin, protocol]);
            let host = ns_string(msg_send![origin, host]);
            let allowed = is_main_frame == YES
                && (protocol == "zali" || host == "localhost" || host == "127.0.0.1");
            if allowed {
                1
            } else {
                2
            }
        };
        unsafe {
            let handler = decision_handler as *mut block::Block<(isize,), c_void>;
            (*handler).call((decision,));
        }
    }

    unsafe {
        let wk: Id = webview.webview();
        if wk.is_null() {
            return;
        }
        let ui_delegate: Id = msg_send![wk, UIDelegate];
        if ui_delegate.is_null() {
            return;
        }
        let class: *mut Class = msg_send![ui_delegate, class];
        if class.is_null() {
            return;
        }
        let imp: objc::runtime::Imp = std::mem::transmute(
            request_media_capture_permission as extern "C" fn(&Object, Sel, Id, Id, Id, isize, Id),
        );
        let added = objc::runtime::class_addMethod(
            class,
            sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:),
            imp,
            c"v@:@@@q@?".as_ptr(),
        );
        if added == NO {
            // Метод уже есть — старый macOS, где wry сам добавляет грант. Тоже ок.
            info!("media capture delegate already present (wry builtin grant)");
        } else {
            info!("media capture policy installed: grant main frame zali:// only");
        }
    }
}

const INDEX_HTML: &str = include_str!("../../../web/index.html");
const STYLE_CSS: &str = include_str!("../../../web/style.css");
const APP_JS: &str = include_str!("../../../web/app.js");

fn response_for_asset(path: &str) -> Response<Cow<'static, [u8]>> {
    let (content_type, body) = match path {
        "" | "index.html" => (
            "text/html; charset=utf-8",
            Cow::Borrowed(INDEX_HTML.as_bytes()),
        ),
        "style.css" => (
            "text/css; charset=utf-8",
            Cow::Borrowed(STYLE_CSS.as_bytes()),
        ),
        "app.js" => (
            "application/javascript; charset=utf-8",
            Cow::Borrowed(APP_JS.as_bytes()),
        ),
        _ => ("application/octet-stream", Cow::Owned(Vec::new())),
    };

    Response::builder()
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())))
}

fn main() -> wry::Result<()> {
    tracing_subscriber::fmt::init();
    info!("Zali Messenger starting...");
    #[cfg(target_os = "windows")]
    set_windows_app_user_model_id();
    // Set by the installer's autostart registry entry (see apps/windows/installer/)
    // so a login-triggered launch doesn't flash a window before dropping to tray.
    let start_minimized = std::env::args().any(|arg| arg == "--start-minimized");

    let native_state = Arc::new(Mutex::new(NativeState::load()));
    let init_script = {
        let guard = native_state.lock().expect("native state lock");
        let mut script = guard.initialization_script();
        // Стартовая диагностика WebView-окружения (secure context, WebCrypto, WebRTC,
        // getUserMedia). Уходит в trace-лог шелла через ветку "IPC unknown type"
        // в handle_ipc_message — без расширения bridge-протокола.
        script.push_str(
            "\n;try{window.ipc&&window.ipc.postMessage(JSON.stringify({type:'DIAG_ENV;secure='+window.isSecureContext+';mediaDevices='+!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)+';subtle='+!!(window.crypto&&window.crypto.subtle)+';rtc='+(typeof RTCPeerConnection!=='undefined')}));}catch(e){}",
        );
        script
    };

    let event_loop = tao::event_loop::EventLoopBuilder::<AppEvent>::with_user_event().build();
    // NSApp exists once the event loop is built; the menu must be installed after that.
    #[cfg(target_os = "macos")]
    let _macos_menu = install_macos_menu();
    let proxy = event_loop.create_proxy();

    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut window_builder = WindowBuilder::new()
        .with_title("Zali Messenger")
        .with_inner_size(tao::dpi::LogicalSize::new(900.0, 600.0))
        .with_visible(!start_minimized);
    // Windows only: drop the native title bar in favor of the in-app titlebar
    // (minimize/maximize/close buttons + drag handled via IPC, see native.rs
    // NativeCapabilities::window_controls). macOS keeps native decorations —
    // both the Swift client and this experimental Rust shell rely on the real
    // traffic-light buttons via titlebarAppearsTransparent instead.
    #[cfg(target_os = "windows")]
    {
        window_builder = window_builder.with_decorations(false);
    }
    let window = window_builder.build(&event_loop).unwrap();

    #[cfg(target_os = "windows")]
    let _tray_icon = install_windows_tray(proxy.clone());

    let runtime = Arc::new(tokio::runtime::Runtime::new().expect("failed to create tokio runtime"));
    let voice_bridge = native::VoiceBridge::new(Arc::clone(&runtime), proxy.clone());
    let message_bridge = native::MessageBridge::new(Arc::clone(&runtime), proxy.clone());
    {
        let guard = native_state.lock().expect("native state lock");
        voice_bridge.configure(
            guard.ws_base_url.clone(),
            Some(guard.api_base_url()),
            guard.auth_token.clone(),
        );
        message_bridge.configure(&guard);
    }
    let native_state_for_ipc = Arc::clone(&native_state);
    let runtime_for_ipc = Arc::clone(&runtime);
    let voice_bridge_for_ipc = Arc::clone(&voice_bridge);
    let message_bridge_for_ipc = Arc::clone(&message_bridge);
    let proxy_for_ipc = proxy.clone();

    let webview = WebViewBuilder::new(&window)
        .with_initialization_script(&init_script)
        // Lets F12 / right-click → Inspect open WebView2 DevTools so JS-side
        // trace()/console logs (e.g. publishConversationKeyToPeer failures) are
        // visible without shipping a separate debug build. Local desktop app,
        // no remote attack surface added — same tradeoff as isInspectable on
        // WKWebView on the macOS client.
        .with_devtools(true)
        .with_custom_protocol("zali".into(), move |request| {
            let path = request.uri().path().trim_start_matches('/');
            response_for_asset(path)
        })
        .with_url("zali://localhost/index.html")?
        .with_ipc_handler(move |msg| {
            native::handle_ipc_message(
                msg,
                Arc::clone(&native_state_for_ipc),
                Arc::clone(&voice_bridge_for_ipc),
                Arc::clone(&message_bridge_for_ipc),
                Arc::clone(&runtime_for_ipc),
                proxy_for_ipc.clone(),
            );
        })
        .build()?;

    #[cfg(target_os = "macos")]
    install_media_capture_policy(&webview);

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::UserEvent(AppEvent::EvaluateScript(script)) => {
                if let Err(error) = webview.evaluate_script(&script) {
                    error!("Failed to evaluate JS: {}", error);
                }
            }
            Event::UserEvent(AppEvent::StartDrag) => {
                if let Err(error) = window.drag_window() {
                    error!("Failed to start window drag: {}", error);
                }
            }
            Event::UserEvent(AppEvent::MinimizeWindow) => {
                window.set_minimized(true);
            }
            Event::UserEvent(AppEvent::ToggleMaximizeWindow) => {
                window.set_maximized(!window.is_maximized());
            }
            Event::UserEvent(AppEvent::CloseWindowRequest) => {
                handle_close_request(&window, control_flow);
            }
            Event::UserEvent(AppEvent::Quit) => {
                info!("Quitting");
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(AppEvent::TrayShow) => {
                window.set_visible(true);
                window.set_focus();
            }
            Event::UserEvent(AppEvent::SetTaskbarBadge(count)) => {
                #[cfg(target_os = "windows")]
                {
                    use raw_window_handle::{HasRawWindowHandle, RawWindowHandle};
                    if let RawWindowHandle::Win32(handle) = window.raw_window_handle() {
                        native::set_unread_badge(handle.hwnd as isize, count);
                    }
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = count;
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                handle_close_request(&window, control_flow);
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(_),
                ..
            } => {
                // Windows only: native decorations are off (see WindowBuilder above), so
                // the in-app titlebar draws its own maximize/restore glyph — keep it in
                // sync with Aero-snap / double-click / our own toggle, all of which land
                // here as a resize with no dedicated "maximized changed" tao event.
                #[cfg(target_os = "windows")]
                {
                    let script = format!(
                        "document.getElementById('titlebar')?.classList.toggle('win-maximized', {});",
                        window.is_maximized()
                    );
                    if let Err(error) = webview.evaluate_script(&script) {
                        error!("Failed to sync maximized state: {}", error);
                    }
                }
            }
            _ => {}
        }
    })
}

/// Shared by the OS close button (when decorations are on) and the in-app close
/// button (Windows, decorations off) so both behave identically.
fn handle_close_request(window: &tao::window::Window, control_flow: &mut ControlFlow) {
    // Windows: hide to tray instead of exiting — the tray icon (and its "Выход"
    // item, which sends AppEvent::Quit) is the only way to actually quit, so local
    // notifications keep working while the window is closed. Other platforms have
    // no tray icon here (macOS quits via the menu bar's PredefinedMenuItem::quit
    // instead) and keep the old close-to-exit behavior.
    #[cfg(target_os = "windows")]
    {
        info!("Hiding to tray");
        window.set_visible(false);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        info!("Closing application");
        *control_flow = ControlFlow::Exit;
    }
}
