//! Управление приложением из терминала (scripts/zali_ctl.py): локальный HTTP-вход на
//! 127.0.0.1 с токеном. Включается в Настройках → «Для разработчиков» → «Управление из
//! терминала» (CONTROL_REQUEST), по умолчанию выключен. Зеркало macOS —
//! apps/macos/Sources/ZaliMessenger/Services/ControlServer.swift; команды исполняет
//! страница (web/src/interface/control.js).
//!
//! Защита та же, что на macOS: только loopback; `Authorization: Bearer <token>` на
//! каждом запросе, токен создаёт и хранит оболочка (control.json в каталоге данных
//! пользователя), сравнение без раннего выхода; запросы с `Origin` (браузерные
//! страницы) и с чужим `Host` (DNS rebinding) отклоняются.
//!
//! `evaluate_script` в WRY промисов не ждёт: команда запускается
//! `window.__zaliControlStart(id, cmd, args)`, а результат забирается опросом
//! `window.__zaliControlTake(id)` через `evaluate_script_with_callback`.

use tracing::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tao::event_loop::EventLoopProxy;

use super::{AppEvent, NativeState};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Config {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    token: String,
    #[serde(default)]
    port: u16,
}

struct Control {
    config: Config,
    running: bool,
    error: String,
    /// Растёт при каждом перезапуске/остановке: поток слушателя с устаревшим
    /// номером выходит после ближайшего accept.
    generation: u64,
}

static CONTROL: OnceLock<Mutex<Control>> = OnceLock::new();
static PROXY: OnceLock<EventLoopProxy<AppEvent>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

fn control() -> &'static Mutex<Control> {
    CONTROL.get_or_init(|| {
        Mutex::new(Control {
            config: load_config(),
            running: false,
            error: String::new(),
            generation: 0,
        })
    })
}

fn config_path() -> PathBuf {
    let dir = NativeState::app_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("control.json")
}

fn load_config() -> Config {
    std::fs::read(config_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_config(config: &Config) {
    let path = config_path();
    match serde_json::to_vec(config) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(&path, bytes) {
                warn!("[CONTROL] config save failed: {error}");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
        Err(error) => warn!("[CONTROL] config encode failed: {error}"),
    }
}

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// При запуске: запомнить прокси окна и поднять вход, если он был включён.
pub fn init(proxy: EventLoopProxy<AppEvent>) {
    let _ = PROXY.set(proxy);
    let mut guard = control().lock().unwrap_or_else(|e| e.into_inner());
    if guard.config.enabled {
        start_locked(&mut guard);
    }
}

/// CONTROL_REQUEST из настроек: status | enable | disable | rotate.
pub fn handle(op: &str) -> Value {
    let mut guard = control().lock().unwrap_or_else(|e| e.into_inner());
    match op {
        "enable" => {
            guard.config.enabled = true;
            if guard.config.token.is_empty() {
                guard.config.token = new_token();
            }
            save_config(&guard.config);
            if !guard.running {
                start_locked(&mut guard);
            }
            info!("[CONTROL] enabled port={}", guard.config.port);
        }
        "disable" => {
            guard.config.enabled = false;
            save_config(&guard.config);
            stop_locked(&mut guard);
            info!("[CONTROL] disabled");
        }
        "rotate" => {
            guard.config.token = new_token();
            save_config(&guard.config);
            info!("[CONTROL] token rotated");
        }
        _ => {}
    }
    status_locked(&guard)
}

fn status_locked(c: &Control) -> Value {
    let mut out = json!({
        "enabled": c.config.enabled,
        "running": c.running,
        "port": c.config.port,
        "platform": if cfg!(target_os = "windows") { "windows" } else { "macos-rust" },
    });
    if c.config.enabled && c.running && !c.config.token.is_empty() {
        out["token"] = json!(c.config.token);
        out["url"] = json!(format!("zalictl://{}@127.0.0.1:{}", c.config.token, c.config.port));
    }
    if !c.error.is_empty() {
        out["error"] = json!(c.error);
    }
    out
}

fn start_locked(c: &mut Control) {
    stop_locked(c);
    if c.config.token.is_empty() {
        c.config.token = new_token();
        save_config(&c.config);
    }
    // Порт постоянный, чтобы строка подключения пережила перезапуск; занят — новый.
    let listener = (c.config.port != 0)
        .then(|| TcpListener::bind(("127.0.0.1", c.config.port)).ok())
        .flatten()
        .or_else(|| TcpListener::bind(("127.0.0.1", 0)).ok());
    let Some(listener) = listener else {
        c.running = false;
        c.error = "не удалось открыть порт".into();
        warn!("[CONTROL] listen failed");
        return;
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    if port != c.config.port {
        c.config.port = port;
        save_config(&c.config);
    }
    c.generation += 1;
    c.running = true;
    c.error.clear();
    let generation = c.generation;
    info!("[CONTROL] listening on 127.0.0.1:{port}");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if control().lock().map(|g| g.generation != generation).unwrap_or(true) {
                break;
            }
            if let Ok(stream) = stream {
                std::thread::spawn(move || serve(stream));
            }
        }
    });
}

fn stop_locked(c: &mut Control) {
    if !c.running {
        return;
    }
    c.generation += 1;
    c.running = false;
    // Разбудить accept, чтобы поток увидел новый номер и вышел.
    let _ = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], c.config.port)),
        Duration::from_millis(200),
    );
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let mut lines = head.split("\r\n");
            let mut first = lines.next()?.split(' ');
            let method = first.next()?.to_string();
            let path = first.next()?.to_string();
            let headers: Vec<(String, String)> = lines
                .filter_map(|line| {
                    let (k, v) = line.split_once(':')?;
                    Some((k.trim().to_ascii_lowercase(), v.trim().to_string()))
                })
                .collect();
            let length: usize = headers
                .iter()
                .find(|(k, _)| k == "content-length")
                .and_then(|(_, v)| v.parse().ok())
                .unwrap_or(0);
            if length > MAX_REQUEST_BYTES {
                return None;
            }
            let start = end + 4;
            while buf.len() < start + length {
                let n = stream.read(&mut chunk).ok()?;
                if n == 0 {
                    return None;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let body = buf[start..start + length].to_vec();
            return Some(Request { method, path, headers, body });
        }
        if buf.len() > MAX_REQUEST_BYTES {
            return None;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        _ => "Status",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn respond_json(stream: &mut TcpStream, status: u16, value: Value) {
    respond(stream, status, "application/json", value.to_string().as_bytes());
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    let mut diff = (x.len() != y.len()) as u8;
    for i in 0..x.len().max(y.len()) {
        diff |= x.get(i).copied().unwrap_or(0) ^ y.get(i).copied().unwrap_or(0);
    }
    diff == 0 && !y.is_empty()
}

fn serve(mut stream: TcpStream) {
    let Some(req) = read_request(&mut stream) else {
        respond_json(&mut stream, 400, json!({"ok": false, "error": "bad request"}));
        return;
    };
    let (enabled, token, port) = {
        let g = control().lock().unwrap_or_else(|e| e.into_inner());
        (g.config.enabled, g.config.token.clone(), g.config.port)
    };
    if req.header("origin").is_some() {
        respond_json(&mut stream, 403, json!({"ok": false, "error": "browser requests are not allowed"}));
        return;
    }
    let host = req.header("host").unwrap_or("").to_ascii_lowercase();
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        respond_json(&mut stream, 403, json!({"ok": false, "error": "bad host"}));
        return;
    }
    let presented = req
        .header("authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !enabled || !constant_time_eq(presented, &token) {
        warn!("[CONTROL] rejected {} {}: bad token", req.method, req.path);
        respond_json(&mut stream, 401, json!({"ok": false, "error": "bad token"}));
        return;
    }
    let path = req.path.split('?').next().unwrap_or("");
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    match (req.method.as_str(), path) {
        ("GET", "/ping") => respond_json(
            &mut stream,
            200,
            json!({"ok": true, "platform": if cfg!(target_os = "windows") { "windows" } else { "macos-rust" },
                   "version": super::APP_DISPLAY_VERSION, "pid": std::process::id()}),
        ),
        ("POST", "/cmd") => {
            let cmd = body.get("cmd").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let args = body.get("args").cloned().unwrap_or_else(|| json!({}));
            let timeout_ms = body
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(60_000)
                .clamp(500, 600_000);
            info!("[CONTROL] cmd {cmd}");
            let result = run_on_page(&cmd, &args, Duration::from_millis(timeout_ms));
            respond(&mut stream, 200, "application/json", result.as_bytes());
        }
        ("GET", "/snapshot") => respond_json(
            &mut stream,
            501,
            json!({"ok": false, "error": "snapshot is macOS-only for now"}),
        ),
        ("POST", "/window") => {
            let event = match body.get("action").and_then(Value::as_str).unwrap_or("") {
                "show" => Some(AppEvent::TrayShow),
                "hide" => Some(AppEvent::CloseWindowRequest),
                _ => None,
            };
            match (event, PROXY.get()) {
                (Some(event), Some(proxy)) => {
                    let _ = proxy.send_event(event);
                    respond_json(&mut stream, 200, json!({"ok": true}));
                }
                (None, _) => respond_json(&mut stream, 400, json!({"ok": false, "error": "action: show|hide"})),
                (_, None) => respond_json(&mut stream, 503, json!({"ok": false, "error": "no window"})),
            }
        }
        _ => respond_json(
            &mut stream,
            404,
            json!({"ok": false, "error": "routes: GET /ping, POST /cmd, GET /snapshot, POST /window"}),
        ),
    }
}

/// Один вызов скрипта с ответом (строка JSON-значения выражения, как её отдаёт WRY).
fn eval_with_reply(proxy: &EventLoopProxy<AppEvent>, script: String, wait: Duration) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    proxy.send_event(AppEvent::ControlEval(script, tx)).ok()?;
    rx.recv_timeout(wait).ok()
}

fn run_on_page(cmd: &str, args: &Value, timeout: Duration) -> String {
    let Some(proxy) = PROXY.get() else {
        return json!({"ok": false, "error": "no window"}).to_string();
    };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let start = format!(
        "(typeof window.__zaliControlStart === 'function') ? window.__zaliControlStart({id}, {}, {}) : false",
        Value::String(cmd.to_string()),
        args
    );
    match eval_with_reply(proxy, start, Duration::from_secs(5)).as_deref() {
        Some("true") => {}
        Some(_) => return json!({"ok": false, "error": "page not ready"}).to_string(),
        None => return json!({"ok": false, "error": "window did not answer"}).to_string(),
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        let take = format!("window.__zaliControlTake({id})");
        if let Some(raw) = eval_with_reply(proxy, take, Duration::from_secs(5)) {
            // Выражение вернуло строку JSON — WRY отдаёт её ещё раз закодированной.
            if let Ok(Value::String(answer)) = serde_json::from_str::<Value>(&raw) {
                return answer;
            }
        }
    }
    json!({"ok": false, "error": "timeout"}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare_is_exact() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abd", "abc"));
        assert!(!constant_time_eq("ab", "abc"));
        assert!(!constant_time_eq("abcd", "abc"));
        // Пустой токен оболочки не пускает никого, даже с пустым заголовком.
        assert!(!constant_time_eq("", ""));
    }

    #[test]
    fn reads_request_split_across_packets() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let writer = std::thread::spawn(move || {
            let mut s = TcpStream::connect(addr).unwrap();
            let body = r#"{"cmd":"state","args":{}}"#;
            let head = format!(
                "POST /cmd HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer t0k\r\nContent-Length: {}\r\n\r\n",
                addr.port(),
                body.len()
            );
            s.write_all(head.as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(30));
            s.write_all(&body.as_bytes()[..5]).unwrap();
            std::thread::sleep(Duration::from_millis(30));
            s.write_all(&body.as_bytes()[5..]).unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        let req = read_request(&mut stream).expect("request");
        writer.join().unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/cmd");
        assert_eq!(req.header("authorization"), Some("Bearer t0k"));
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        assert_eq!(body["cmd"], "state");
    }
}
