//! Нативный захват микрофона, камеры и экрана в Windows-оболочке.
//!
//! Спецификация — `.claude/skills/voice-calls/native-capture.md`; страница —
//! `web/src/interface/native_media.js`. Коротко: WebView2 сам умеет getUserMedia, но
//! тогда звук идёт через его собственную обработку и режим «связь», а камеру и экран
//! страница выбирает системными диалогами. Здесь устройства открывает оболочка:
//!
//! * микрофон — WASAPI shared, роль `eConsole` (не `eCommunications`: режим «связь»
//!   включает системное приглушение остальных приложений), 48 кГц моно f32,
//!   обработка `VoiceProcessor` из core (AEC3 → RNNoise → AGC2) с опорным сигналом
//!   из WASAPI loopback устройства вывода по умолчанию (`mic.rs`, `loopback.rs`);
//! * камера — Media Foundation `IMFSourceReader` в NV12, один сеанс на устройство,
//!   кадры раздаются всем потокам, открывшим эту камеру (`camera.rs`);
//! * экран и окна — Windows.Graphics.Capture, BGRA → NV12 через D3D11 VideoProcessor;
//!   звук демонстрации — process loopback всей системы, кроме дерева процессов
//!   самого приложения (`screen.rs`, `loopback.rs`).
//!
//! Управление — `MEDIA_REQUEST` (`handle_media_request`), ответы и события — шина
//! `media_event`. Кадры (`format.rs`) уходят в поток окна событием
//! `AppEvent::MediaFrame` и оттуда — в страницу через общую память WebView2
//! (`shared_buffer.rs`). Потоки захвата WebView2 не трогают: её COM-объекты живут
//! только в потоке окна.

// Вне Windows отсюда нужны только флаги и честный отказ на MEDIA_REQUEST.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use super::{dispatch_ui_event, AppEvent, UiBusEvent};
use serde_json::{json, Value};
use std::fmt;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tao::event_loop::EventLoopProxy;

pub(crate) mod format;

#[cfg(target_os = "windows")]
mod camera;
#[cfg(target_os = "windows")]
mod com;
#[cfg(target_os = "windows")]
mod devices;
#[cfg(target_os = "windows")]
mod hub;
#[cfg(target_os = "windows")]
mod loopback;
#[cfg(target_os = "windows")]
mod mf;
#[cfg(target_os = "windows")]
mod mic;
#[cfg(target_os = "windows")]
mod screen;
#[cfg(target_os = "windows")]
pub(crate) mod shared_buffer;

/// Что умеет эта сборка — флаги `__ZALI_NATIVE_CAPS__` и `__ZALI_MEDIA_BRIDGE`.
/// Без флага страница идёт в getUserMedia/getDisplayMedia движка.
pub(crate) const NATIVE_MEDIA: bool = cfg!(target_os = "windows");

/// User-скрипт верхнего фрейма: транспорт кадров (см. `shared_buffer.rs`).
pub(crate) fn media_bridge_script() -> &'static str {
    if NATIVE_MEDIA {
        "window.__ZALI_MEDIA_BRIDGE = {kind:'sharedbuffer'};\n"
    } else {
        ""
    }
}

/// Готовый кадр (заголовок + данные) на пути «поток захвата → поток окна».
/// Пока кадр не отправлен в страницу (или не выброшен), он числится в счётчике
/// своего потока — по нему поток захвата видит, что окно не успевает, и
/// пропускает видеокадры вместо того, чтобы копить их в очереди сообщений.
#[derive(Clone)]
pub struct MediaFrame(Arc<FrameInner>);

struct FrameInner {
    bytes: Vec<u8>,
    inflight: Arc<AtomicUsize>,
}

impl Drop for FrameInner {
    fn drop(&mut self) {
        self.inflight.fetch_sub(1, Ordering::AcqRel);
    }
}

impl MediaFrame {
    pub fn bytes(&self) -> &[u8] {
        &self.0.bytes
    }
}

impl fmt::Debug for MediaFrame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MediaFrame({} bytes)", self.0.bytes.len())
    }
}

/// Отправитель кадров одного потока захвата.
#[derive(Clone)]
pub(crate) struct FrameSink {
    proxy: EventLoopProxy<AppEvent>,
    inflight: Arc<AtomicUsize>,
    counters: Arc<SinkCounters>,
}

/// Счётчики потока для `stats` раз в 10 с (сбрасываются при чтении).
#[derive(Default)]
pub(crate) struct SinkCounters {
    sent: AtomicU64,
    bytes: AtomicU64,
    dropped: AtomicU64,
}

impl FrameSink {
    pub(crate) fn new(proxy: EventLoopProxy<AppEvent>) -> Self {
        Self { proxy, inflight: Arc::new(AtomicUsize::new(0)), counters: Arc::default() }
    }

    /// `{frames, kbps, dropped, pending}` за `seconds` и сброс счётчиков.
    pub(crate) fn take_stats(&self, seconds: f64) -> Value {
        let sent = self.counters.sent.swap(0, Ordering::AcqRel);
        let bytes = self.counters.bytes.swap(0, Ordering::AcqRel);
        let dropped = self.counters.dropped.swap(0, Ordering::AcqRel);
        let seconds = seconds.max(0.001);
        json!({
            "frames": sent,
            "fps": (sent as f64 / seconds * 10.0).round() / 10.0,
            "kbps": (bytes as f64 * 8.0 / seconds / 1000.0) as u64,
            "dropped": dropped,
            "pending": self.pending(),
        })
    }

    /// Сколько кадров ждут поток окна.
    pub(crate) fn pending(&self) -> usize {
        self.inflight.load(Ordering::Acquire)
    }

    /// `false` — цикл событий закрыт (приложение выходит).
    pub(crate) fn send(&self, bytes: Vec<u8>) -> bool {
        self.inflight.fetch_add(1, Ordering::AcqRel);
        self.counters.sent.fetch_add(1, Ordering::Relaxed);
        self.counters.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        let frame = MediaFrame(Arc::new(FrameInner { bytes, inflight: Arc::clone(&self.inflight) }));
        self.proxy.send_event(AppEvent::MediaFrame(frame)).is_ok()
    }

    /// Видео: пропустить кадр, если окно ещё не забрало предыдущие.
    pub(crate) fn send_video(&self, bytes: Vec<u8>) -> bool {
        if self.pending() >= 3 {
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
            return true;
        }
        self.send(bytes)
    }
}

/// Отправитель событий `media_event`.
#[derive(Clone)]
pub(crate) struct EventSink {
    proxy: EventLoopProxy<AppEvent>,
}

impl EventSink {
    pub(crate) fn new(proxy: EventLoopProxy<AppEvent>) -> Self {
        Self { proxy }
    }

    pub(crate) fn emit(&self, payload: Value) {
        dispatch_ui_event(&self.proxy, UiBusEvent::MediaEvent, payload);
    }

    pub(crate) fn error(&self, request_id: Option<&str>, stream: Option<u32>, code: &str, message: impl Into<String>) {
        let mut payload = json!({ "event": "error", "code": code, "message": message.into() });
        if let Some(id) = request_id.filter(|id| !id.is_empty()) {
            payload["requestId"] = json!(id);
        }
        if let Some(stream) = stream {
            payload["stream"] = json!(stream);
        }
        self.emit(payload);
    }

    pub(crate) fn proxy(&self) -> &EventLoopProxy<AppEvent> {
        &self.proxy
    }
}

/// Поля запроса `MEDIA_REQUEST`, разобранные один раз.
#[derive(Debug, Clone)]
pub(crate) struct MediaRequest {
    pub op: String,
    pub request_id: Option<String>,
    pub stream: Option<u32>,
    pub kind: String,
    pub device_id: String,
    pub source_id: String,
    pub options: Value,
}

impl MediaRequest {
    pub(crate) fn parse(payload: &Value) -> Option<Self> {
        let text = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let op = text("op");
        if op.is_empty() {
            return None;
        }
        let request_id = Some(text("requestId")).filter(|id| !id.is_empty());
        let stream = payload
            .get("stream")
            .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .and_then(|v| u32::try_from(v).ok());
        Some(Self {
            op,
            request_id,
            stream,
            kind: text("kind"),
            device_id: text("deviceId"),
            source_id: text("sourceId"),
            options: payload.get("options").cloned().unwrap_or(Value::Null),
        })
    }
}

/// Страница перезагрузилась (или ушла): её потоки больше никому не нужны, а
/// микрофон/камера/экран иначе остались бы захвачены до выхода из приложения.
pub(crate) fn stop_all() {
    #[cfg(target_os = "windows")]
    hub::stop_all();
}

/// Общая память WebView2 недоступна: страница выключает нативный захват до
/// перезагрузки и уходит в getUserMedia, идущие потоки останавливаются.
pub(crate) fn transport_unavailable(proxy: &EventLoopProxy<AppEvent>) {
    stop_all();
    EventSink::new(proxy.clone()).emit(json!({ "event": "transport_unavailable" }));
}

/// Точка входа из `handle_ipc_message` (поток окна). Долгое — в своих потоках.
pub(crate) fn handle_media_request(payload: &Value, proxy: &EventLoopProxy<AppEvent>) {
    let Some(request) = MediaRequest::parse(payload) else {
        return;
    };
    let events = EventSink::new(proxy.clone());
    #[cfg(target_os = "windows")]
    hub::handle(request, events);
    #[cfg(not(target_os = "windows"))]
    {
        // Экспериментальный macOS Rust-шелл нативный захват не объявляет; на случай
        // старой страницы — честный отказ, чтобы она ушла в getUserMedia.
        if request.request_id.is_some() {
            events.error(request.request_id.as_deref(), request.stream, "unsupported", "нативный захват недоступен в этой оболочке");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_parsing_accepts_numeric_and_string_streams() {
        let r = MediaRequest::parse(&json!({"op": "start", "requestId": "r1", "stream": 4, "kind": "mic", "options": {"processing": true}})).unwrap();
        assert_eq!(r.op, "start");
        assert_eq!(r.request_id.as_deref(), Some("r1"));
        assert_eq!(r.stream, Some(4));
        assert_eq!(r.kind, "mic");
        assert_eq!(r.device_id, "");
        assert_eq!(r.options["processing"], json!(true));
        let r = MediaRequest::parse(&json!({"op": "stop", "stream": "7"})).unwrap();
        assert_eq!(r.stream, Some(7));
        assert!(r.request_id.is_none());
        assert!(MediaRequest::parse(&json!({"stream": 1})).is_none());
        assert_eq!(MediaRequest::parse(&json!({"op": "stop", "stream": -1})).unwrap().stream, None);
    }
}
