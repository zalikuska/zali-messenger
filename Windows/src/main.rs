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

const INDEX_HTML: &str = include_str!("../../Web/index.html");
const STYLE_CSS: &str = include_str!("../../Web/style.css");
const APP_JS: &str = include_str!("../../Web/app.js");

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

    let native_state = Arc::new(Mutex::new(NativeState::load()));
    let init_script = {
        let guard = native_state.lock().expect("native state lock");
        guard.initialization_script()
    };

    let event_loop = tao::event_loop::EventLoopBuilder::<AppEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("Zali Messenger")
        .with_inner_size(tao::dpi::LogicalSize::new(900.0, 600.0))
        .build(&event_loop)
        .unwrap();

    let runtime = Arc::new(tokio::runtime::Runtime::new().expect("failed to create tokio runtime"));
    let voice_bridge = native::VoiceBridge::new(Arc::clone(&runtime), proxy.clone());
    {
        let guard = native_state.lock().expect("native state lock");
        voice_bridge.configure(
            guard.ws_base_url.clone(),
            Some(guard.api_base_url()),
            guard.auth_token.clone(),
        );
    }
    let native_state_for_ipc = Arc::clone(&native_state);
    let runtime_for_ipc = Arc::clone(&runtime);
    let voice_bridge_for_ipc = Arc::clone(&voice_bridge);
    let proxy_for_ipc = proxy.clone();

    let webview = WebViewBuilder::new(&window)
        .with_initialization_script(&init_script)
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
                Arc::clone(&runtime_for_ipc),
                proxy_for_ipc.clone(),
            );
        })
        .build()?;

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
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                info!("Closing application");
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    })
}
