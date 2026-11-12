//! Разбор `MEDIA_REQUEST` и учёт идущих потоков. Вызывается из потока окна; всё,
//! что трогает устройства, уходит в свои потоки (COM MTA), поток окна не ждёт.

use super::format::Processing;
use super::{camera, devices, mic, screen, EventSink, FrameSink, MediaRequest};
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
        }
    }
}

/// stream → флаг остановки его потока захвата.
fn sessions() -> std::sync::MutexGuard<'static, HashMap<u32, Arc<AtomicBool>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
    let lock = SESSIONS.get_or_init(|| Mutex::new(HashMap::new()));
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn stop_all() {
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
    devices::watch_device_changes(&events);
    if request.op != "request_keyframe" {
        // id устройства — укороченный: отличить устройства хватает, журнал не пухнет.
        let device: String = request.device_id.chars().take(24).collect();
        tracing::info!(
            "[ZALI][WIN] media request op={} stream={:?} kind={} device={} source={} options={}",
            request.op, request.stream, request.kind, device, request.source_id, request.options
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
                .unwrap_or(320)
                .clamp(64, 1280) as usize;
            spawn("zali-media-sources", move || {
                let sources = screen::list_sources(thumb_width);
                events.emit(with_request_id(json!({ "event": "screen_sources", "sources": sources }), &request.request_id));
            });
        }
        "start" => start(request, events),
        "stop" => {
            if let Some(stream) = request.stream {
                let stop = sessions().remove(&stream);
                if let Some(stop) = stop {
                    stop.store(true, Ordering::Release);
                }
            }
        }
        "set_processing" => {
            mic::set_processing(Processing::from_flags(&request.options, mic::current_processing()));
        }
        // NV12 без сжатия: каждый кадр и так ключевой.
        "request_keyframe" => {}
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
        other => ctx.fail("unsupported", format!("неизвестный вид захвата {other}")),
    }
}
