//! Разбор `MEDIA_REQUEST` и учёт идущих потоков. Вызывается из потока окна; всё,
//! что трогает устройства, уходит в свои потоки (COM MTA), поток окна не ждёт.

use super::format::Processing;
use super::{camera, desktop_ui, devices, mic, privacy, privacy_win, remote_control, screen, shared_browser, EventSink, FrameSink, MediaRequest};
use crate::native::AppEvent;
use tao::event_loop::EventLoopProxy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Всё, что нужно потоку захвата: куда отвечать, куда слать кадры, когда остановиться.
#[derive(Clone)]
pub struct StartContext {
    pub request_id: Option<String>,
    pub stream: u32,
    pub device_id: String,
    pub source_id: String,
    pub options: Value,
    pub events: EventSink,
    pub frames: FrameSink,
    stop: Arc<AtomicBool>,
}

impl StartContext {
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    pub fn stop_flag(&self) -> &AtomicBool {
        &self.stop
    }

    /// Ответ на `start`: `{event:'started', stream, requestId, ...extra}`.
    pub fn started(&self, extra: Value) {
        tracing::info!("[ZALI][WIN] media started stream={} {extra}", self.stream);
        let mut payload = json!({ "event": "started", "stream": self.stream });
        if let Some(id) = &self.request_id {
            payload["requestId"] = json!(id);
        }
        if let Value::Object(map) = extra {
            for (k, v) in map {
                payload[k] = v;
            }
        }
        self.events.emit(payload);
    }

    /// Счётчики видео раз в 10 с: в журнал оболочки и странице (`stats.video`).
    pub fn video_stats(&self, mut video: Value) {
        tracing::info!("[ZALI][WIN] media stats stream={} {video}", self.stream);
        if let Value::Object(map) = &mut video {
            map.retain(|_, v| !v.is_null());
        }
        self.events.emit(json!({ "event": "stats", "stream": self.stream, "video": video }));
    }

    /// Не открылось: ошибка на запрос, поток забыт.
    pub fn fail(&self, code: &str, message: impl Into<String>) {
        let message = message.into();
        tracing::warn!("[ZALI][WIN] media failed stream={} code={code} {message}", self.stream);
        self.events.error(self.request_id.as_deref(), Some(self.stream), code, message);
        self.finish();
    }

    pub fn fail_win(&self, error: &windows::core::Error, what: &str) {
        let (code, text) = super::com::describe(error);
        tracing::warn!("[ZALI][WIN] media {what} failed: {text}");
        self.fail(code, format!("{what}: {text}"));
    }

    /// Источник пропал сам (окно закрыли, устройство отключили). Страница гасит дорожку.
    pub fn ended(&self, reason: &str) {
        tracing::info!("[ZALI][WIN] media ended stream={} reason={reason} by_page={}", self.stream, self.stopped());
        if !self.stopped() {
            self.events.emit(json!({ "event": "ended", "stream": self.stream, "reason": reason }));
        }
        self.finish();
    }

    /// Поток захвата закончился — убрать из учёта (если его не заменили).
    pub fn finish(&self) {
        self.stop.store(true, Ordering::Release);
        let mut sessions = sessions();
        if sessions.get(&self.stream).map(|s| Arc::ptr_eq(s, &self.stop)).unwrap_or(false) {
            sessions.remove(&self.stream);
            drop(sessions);
            screen_sources().remove(&self.stream);
            // Нет экрана — нет удалённого управления.
            remote_control::stream_ended(self.stream, "stream-ended", Some(&self.events));
        }
        // Захват «Общего браузера» кончился (окно закрылось, страница остановила) — закрыть и браузер.
        shared_browser::stream_finished(self.stream, self.events.proxy());
    }
}

/// stream → флаг остановки его потока захвата.
fn sessions() -> std::sync::MutexGuard<'static, HashMap<u32, Arc<AtomicBool>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
    let lock = SESSIONS.get_or_init(|| Mutex::new(HashMap::new()));
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// stream → id источника идущей демонстрации (`display:…`/`window:…`) — к экрану
/// привязывается разрешение на удалённое управление (remote_control.rs).
fn screen_sources() -> std::sync::MutexGuard<'static, HashMap<u32, String>> {
    static SOURCES: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();
    let lock = SOURCES.get_or_init(|| Mutex::new(HashMap::new()));
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Прокси цикла событий для `stop_all` (у него нет запроса, через который он пришёл бы).
fn event_proxy() -> &'static Mutex<Option<EventLoopProxy<AppEvent>>> {
    static PROXY: OnceLock<Mutex<Option<EventLoopProxy<AppEvent>>>> = OnceLock::new();
    PROXY.get_or_init(|| Mutex::new(None))
}

pub fn stop_all() {
    remote_control::stop_all();
    if let Some(proxy) = event_proxy().lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        shared_browser::close_all(proxy);
    }
    screen_sources().clear();
    let stopped: Vec<Arc<AtomicBool>> = sessions().drain().map(|(_, stop)| stop).collect();
    for stop in stopped {
        stop.store(true, Ordering::Release);
    }
}

fn spawn(name: &str, job: impl FnOnce() + Send + 'static) {
    if let Err(error) = std::thread::Builder::new().name(name.to_string()).spawn(job) {
        tracing::error!("[ZALI][WIN] media thread {name} failed to start: {error}");
    }
}

fn with_request_id(mut payload: Value, request_id: &Option<String>) -> Value {
    if let Some(id) = request_id {
        payload["requestId"] = json!(id);
    }
    payload
}

pub fn handle(request: MediaRequest, events: EventSink) {
    // rc_input — до 60 событий в секунду: без журнала и без лишней работы.
    if request.op == "rc_input" {
        if let Some(stream) = request.stream {
            remote_control::input(stream, &request.options);
        }
        return;
    }
    // Ввод «Общего браузера» — тоже без журнала: в поток окна, к WebView2.
    if request.op == "browser_input" {
        if let Some(stream) = request.stream {
            let _ = events.proxy().send_event(AppEvent::SharedBrowser(shared_browser::Command::Input {
                stream,
                event: request.options,
            }));
        }
        return;
    }
    {
        let mut proxy = event_proxy().lock().unwrap_or_else(|p| p.into_inner());
        if proxy.is_none() {
            *proxy = Some(events.proxy().clone());
        }
    }
    devices::watch_device_changes(&events);
    // sfu_answer — SDP с ключами ICE: в журнал не пишем.
    if request.op != "request_keyframe" && request.op != "sfu_answer" {
        // id устройства — укороченный: отличить устройства хватает, журнал не пухнет.
        let device: String = request.device_id.chars().take(24).collect();
        // Куки и адреса «Общего браузера» в журнал не попадают — только их число.
        let mut logged = request.options.clone();
        if let Some(map) = logged.as_object_mut() {
            if let Some(n) = map.get("cookies").and_then(Value::as_array).map(Vec::len) {
                map.insert("cookies".into(), json!(n));
            }
            if map.contains_key("url") {
                map.insert("url".into(), json!("…"));
            }
        }
        tracing::info!(
            "[ZALI][WIN] media request op={} stream={:?} kind={} device={} source={} options={}",
            request.op, request.stream, request.kind, device, request.source_id, logged
        );
    }
    match request.op.as_str() {
        "list_devices" => spawn("zali-media-list", move || {
            events.emit(with_request_id(devices::list_devices(), &request.request_id));
        }),
        "list_screen_sources" => {
            let thumb_width = request
                .options
                .get("thumbWidth")
                .and_then(Value::as_u64)
                .unwrap_or(320);
            // 0 — список без превью (клавиша трансляции, screen_privacy.js): иначе снимок
            // каждого окна задерживал бы старт на секунды.
            let thumb_width = if thumb_width == 0 { 0 } else { thumb_width.clamp(64, 1280) as usize };
            spawn("zali-media-sources", move || {
                let sources = screen::list_sources(thumb_width);
                events.emit(with_request_id(json!({ "event": "screen_sources", "sources": sources }), &request.request_id));
            });
        }
        "start" => start(request, events),
        // Скрытые приложения в трансляции (privacy.rs, privacy_win.rs).
        "list_apps" => spawn("zali-media-apps", move || {
            events.emit(with_request_id(json!({ "event": "apps", "apps": privacy_win::list_apps() }), &request.request_id));
        }),
        "set_privacy" => {
            privacy::update(&request.options);
            if request.request_id.is_some() {
                events.emit(with_request_id(json!({ "event": "privacy_ok" }), &request.request_id));
            }
        }
        // Глобальные горячие клавиши и плашки поверх окон (desktop_ui.rs).
        "set_hotkeys" => desktop_ui::set_hotkeys(&request.options, request.request_id.clone(), events),
        "overlay" => desktop_ui::overlay(&request.options),
        "stop" => {
            if let Some(stream) = request.stream {
                let stop = sessions().remove(&stream);
                if let Some(stop) = stop {
                    stop.store(true, Ordering::Release);
                }
                screen_sources().remove(&stream);
                remote_control::stream_ended(stream, "page-stop", Some(&events));
                shared_browser::stream_finished(stream, events.proxy());
            }
        }
        "browser_nav" => {
            if let Some(stream) = request.stream {
                let text = |k: &str| request.options.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let _ = events.proxy().send_event(AppEvent::SharedBrowser(shared_browser::Command::Nav {
                    stream,
                    action: text("action"),
                    url: text("url"),
                }));
            }
        }
        "browser_cookies" => {
            let Some(stream) = request.stream.filter(|s| shared_browser::is_browser_stream(*s)) else {
                events.error(request.request_id.as_deref(), None, "not_found", "общий браузер не открыт");
                return;
            };
            let proxy = events.proxy().clone();
            let _ = proxy.send_event(AppEvent::SharedBrowser(shared_browser::Command::Cookies {
                stream,
                request_id: request.request_id.clone(),
                events,
            }));
        }
        // Удалённое управление: согласие — системным окном, только для живого потока экрана.
        "rc_grant" => {
            let Some(stream) = request.stream else {
                events.error(request.request_id.as_deref(), None, "failed", "rc_grant без stream");
                return;
            };
            let Some(source_id) = screen_sources().get(&stream).cloned() else {
                events.error(request.request_id.as_deref(), None, "not_found", "демонстрация экрана не идёт");
                return;
            };
            let peer = request.options.get("peer").and_then(Value::as_str).unwrap_or("").to_string();
            remote_control::request_grant(stream, source_id, peer, request.request_id.clone(), events, |stream, source| {
                screen_sources().get(&stream).map(|s| s == source).unwrap_or(false)
            });
        }
        "rc_revoke" => {
            if let Some(stream) = request.stream {
                remote_control::revoke(stream, "page");
            }
        }
        "set_processing" => {
            mic::set_processing(Processing::from_flags(&request.options, mic::current_processing()));
        }
        // NV12 без сжатия: каждый кадр и так ключевой (слоям SFU ключевые кадры
        // заказывает издатель ядра, screen.rs).
        "request_keyframe" => {}
        // Ответ SFU на оффер издателя экрана (страница переслала voice_sfu_publish_answer).
        "sfu_answer" => {
            let sdp = request.options.get("sdp").and_then(Value::as_str).unwrap_or("").to_string();
            match request.stream {
                Some(stream) if !sdp.is_empty() && screen::sfu_answer(stream, sdp) => {
                    events.emit(with_request_id(json!({ "event": "sfu_answer_ok", "stream": stream }), &request.request_id));
                }
                _ => events.error(request.request_id.as_deref(), request.stream, "not_found", "издатель экрана не найден"),
            }
        }
        other => {
            if request.request_id.is_some() {
                events.error(request.request_id.as_deref(), request.stream, "unsupported", format!("неизвестная операция {other}"));
            }
        }
    }
}

fn start(request: MediaRequest, events: EventSink) {
    let Some(stream) = request.stream.filter(|s| *s > 0) else {
        events.error(request.request_id.as_deref(), None, "failed", "start без stream");
        return;
    };
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut sessions = sessions();
        if sessions.contains_key(&stream) {
            drop(sessions);
            events.error(request.request_id.as_deref(), Some(stream), "busy", "поток с таким номером уже идёт");
            return;
        }
        sessions.insert(stream, Arc::clone(&stop));
    }
    if request.kind == "screen" {
        screen_sources().insert(stream, request.source_id.clone());
    }
    let ctx = StartContext {
        request_id: request.request_id.clone(),
        stream,
        device_id: request.device_id.clone(),
        source_id: request.source_id.clone(),
        options: request.options.clone(),
        frames: FrameSink::new(events.proxy().clone()),
        events,
        stop,
    };
    match request.kind.as_str() {
        "mic" => spawn("zali-media-mic", move || mic::run(ctx)),
        "camera" => spawn("zali-media-camera", move || camera::run(ctx)),
        "screen" => spawn("zali-media-screen", move || screen::run(ctx)),
        // Окно и WebView2 создаются в потоке окна; захват (screen::run) запустит уже он.
        "browser" => {
            let opt = |k: &str, d: u64| ctx.options.get(k).and_then(Value::as_u64).unwrap_or(d);
            let request = shared_browser::OpenRequest {
                url: ctx.options.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
                profile: ctx.options.get("profile").and_then(Value::as_str).unwrap_or("own").to_string(),
                cookies: ctx.options.get("cookies").and_then(Value::as_array).cloned().unwrap_or_default(),
                width: opt("width", 1280) as u32,
                height: opt("height", 720) as u32,
                scale: ctx.options.get("scale").and_then(Value::as_f64).unwrap_or(1.0),
                // 0 — частота экрана запустившего (до 240).
                fps: match opt("fps", 0) {
                    0 => shared_browser::display_refresh_rate(),
                    n => n.clamp(5, 240),
                },
                ctx: ctx.clone(),
            };
            shared_browser::mark_browser_stream(stream);
            if ctx.events.proxy().send_event(AppEvent::SharedBrowser(shared_browser::Command::Open(Box::new(request)))).is_err() {
                ctx.fail("failed", "цикл событий окна закрыт");
            }
        }
        other => ctx.fail("unsupported", format!("неизвестный вид захвата {other}")),
    }
}
