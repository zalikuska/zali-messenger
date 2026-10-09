//! Client-submitted decryption-failure reports. Added 2026-07-31 while chasing
//! "переписки пропадают, множатся ошибки расшифровки" — the placeholder text a
//! client shows on a failed decrypt (see `detectSystemNotice` in
//! `web/src/interface.js`) is a dead end on its own: it says *that* decryption
//! failed, not *why*. This gives every client a place to phone home with the
//! surrounding state (scope, local vs. registry key fingerprint, recent trace
//! log) the moment it happens, so the pattern across accounts/devices can be
//! queried after the fact instead of asking users to paste logs by hand.
//!
//! Deliberately received as an opaque JSON blob (`payload`) rather than a
//! strict struct: the set of useful fields is still being figured out from
//! real reports, and a strict schema would 400 on exactly the client version
//! this exists to debug. Only `reason` is pulled out for indexing/filtering;
//! the rest is queried straight out of the JSON with SQLite's `json_extract`.

use crate::{constant_time_eq, AppState, AuthenticatedUser};
use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use tracing::warn;
use uuid::Uuid;

// A report is metadata plus a short log tail, never attachment-sized. Capped
// well under the global upload body limit so this endpoint can't be used to
// smuggle large payloads past it, and so one misbehaving client can't fill
// the table with megabyte rows.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct DecryptFailureReport {
    #[serde(default)]
    reason: String,
    #[serde(flatten)]
    rest: Value,
}

pub(crate) async fn report_decrypt_failure(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if body.len() > MAX_PAYLOAD_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let report: DecryptFailureReport = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            warn!("decrypt-failure report: неразбираемое тело username={}: {}", username, e);
            return StatusCode::BAD_REQUEST.into_response();
        }
    };
    let payload = serde_json::to_string(&report.rest).unwrap_or_default();
    let id = Uuid::new_v4().to_string();
    let reason = report.reason.trim().chars().take(64).collect::<String>();

    let result = sqlx::query(
        "INSERT INTO decrypt_failure_reports (id, reported_by, reason, payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&username)
    .bind(&reason)
    .bind(&payload)
    .execute(&state.db)
    .await;

    match result {
        Ok(_) => {
            warn!(
                "decrypt-failure report принят username={} reason={} id={}",
                username, reason, id
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            warn!("decrypt-failure report: ошибка записи username={}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Общие диагностические отчёты клиентов (2026-10-10).
//
// Отчёт о расшифровке выше был единственным, что клиент сам отправлял на
// сервер; звонки, доставка, обрывы соединения и ошибки JS оставались на
// устройстве — до тех пор, пока человек не пришлёт журнал руками. Сюда клиент
// кладёт снимок своего состояния (кольца журнала/трассы/голоса, неудачные
// запросы, очередь отправки) — вручную кнопкой «Отправить диагностику» или
// сам при сбое. Тело — непрозрачный JSON, как и у отчёта о расшифровке:
// набор полезных полей ещё складывается.
//
// Читается оператором: GET /api/diagnostics/reports, …/reports/:id и
// …/metrics за тем же RELEASE_ADMIN_TOKEN, что и публикация релизов
// (scripts/diag_reports.py).
// ════════════════════════════════════════════════════════════════════════════

/// Отчёт — журнал и трассы с ограниченных колец клиента, не вложения.
const MAX_CLIENT_REPORT_BYTES: usize = 256 * 1024;
/// Сколько автоматических отчётов один пользователь может прислать за час.
/// Клиент и сам их прореживает; это предохранитель от зациклившегося.
const MAX_CLIENT_REPORTS_PER_HOUR: i64 = 30;
/// Отдельная квота для ручных («Отправить диагностику»): человек жмёт кнопку
/// ровно тогда, когда что-то сломалось, — и как раз тогда автоматические могли
/// выбрать общую квоту.
const MAX_MANUAL_REPORTS_PER_HOUR: i64 = 10;
/// Сколько дней хранятся отчёты (оба вида). Чистится при записи нового.
const REPORT_RETENTION_DAYS: i64 = 30;
/// Известные виды. Неизвестный сохраняется как `other`, а не отвергается:
/// клиент новее сервера не должен терять отчёт.
const REPORT_KINDS: &[&str] = &[
    "manual",
    "voice_failed",
    "delivery_failed",
    "ws_unstable",
    "js_error",
];

#[derive(Debug, Deserialize)]
pub(crate) struct ClientReport {
    #[serde(default)]
    kind: String,
    #[serde(default, rename = "appVersion")]
    app_version: String,
    #[serde(default)]
    platform: String,
    #[serde(flatten)]
    rest: Value,
}

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

pub(crate) async fn report_client_diagnostics(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if body.len() > MAX_CLIENT_REPORT_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let report: ClientReport = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            warn!("client report: неразбираемое тело username={}: {}", username, e);
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    let kind_raw = clip(&report.kind, 32);
    let kind = if REPORT_KINDS.contains(&kind_raw.as_str()) { kind_raw } else { "other".to_string() };
    let manual = kind == "manual";
    let recent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM client_diagnostic_reports
         WHERE reported_by = ? AND (kind = 'manual') = ? AND created_at >= datetime('now', '-1 hour')",
    )
    .bind(&username)
    .bind(manual)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let quota = if manual { MAX_MANUAL_REPORTS_PER_HOUR } else { MAX_CLIENT_REPORTS_PER_HOUR };
    if recent >= quota {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let app_version = clip(&report.app_version, 32);
    let platform = clip(&report.platform, 32);
    let payload = serde_json::to_string(&report.rest).unwrap_or_default();
    let id = Uuid::new_v4().to_string();

    let result = sqlx::query(
        "INSERT INTO client_diagnostic_reports (id, reported_by, kind, app_version, platform, payload)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&username)
    .bind(&kind)
    .bind(&app_version)
    .bind(&platform)
    .bind(&payload)
    .execute(&state.db)
    .await;
    if let Err(e) = result {
        warn!("client report: ошибка записи username={}: {}", username, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    warn!(
        "client report принят username={} kind={} platform={} version={} id={} bytes={}",
        username,
        kind,
        platform,
        app_version,
        id,
        payload.len()
    );
    prune_old_reports(&state).await;
    (StatusCode::CREATED, Json(json!({ "id": id }))).into_response()
}

async fn prune_old_reports(state: &Arc<AppState>) {
    let cutoff = format!("-{} days", REPORT_RETENTION_DAYS);
    for table in ["client_diagnostic_reports", "decrypt_failure_reports"] {
        let sql = format!("DELETE FROM {table} WHERE created_at < datetime('now', ?)");
        let _ = sqlx::query(&sql).bind(&cutoff).execute(&state.db).await;
    }
}

/// Оператор, а не пользователь: тот же RELEASE_ADMIN_TOKEN, что у /api/version.
/// Не задан — эндпоинты закрыты (403), как и публикация релизов.
/// Единственная проверка операторского токена — её же зовут publish_version
/// (updates.rs) и publish_announcement (realtime.rs).
pub(crate) fn operator_authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = state.config.release_admin_token.as_ref() else {
        return false;
    };
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|token| constant_time_eq(token.as_bytes(), expected.as_bytes()))
        .unwrap_or(false)
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct ReportListQuery {
    kind: Option<String>,
    user: Option<String>,
    /// Часы назад (по умолчанию 72).
    hours: Option<i64>,
    limit: Option<i64>,
}

/// Список отчётов обоих видов, новые сверху, без тел. `kind=decrypt` — отчёты
/// о расшифровке (их `reason` идёт в поле `detail`).
pub(crate) async fn list_reports(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ReportListQuery>,
) -> impl IntoResponse {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let hours = q.hours.unwrap_or(72).clamp(1, 24 * REPORT_RETENTION_DAYS);
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let kind = q.kind.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let user = q.user.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let since = format!("-{} hours", hours);

    let rows = sqlx::query(
        "SELECT id, reported_by, kind, app_version, platform, detail, created_at, bytes FROM (
             SELECT id, reported_by, kind, app_version, platform, '' AS detail, created_at,
                    length(payload) AS bytes
             FROM client_diagnostic_reports
             UNION ALL
             SELECT id, reported_by, 'decrypt' AS kind, '' AS app_version,
                    COALESCE(json_extract(payload, '$.platform'), '') AS platform,
                    reason AS detail, created_at, length(payload) AS bytes
             FROM decrypt_failure_reports
         )
         WHERE created_at >= datetime('now', ?)
           AND (? IS NULL OR kind = ?)
           AND (? IS NULL OR reported_by = ?)
         ORDER BY created_at DESC
         LIMIT ?",
    )
    .bind(&since)
    .bind(&kind)
    .bind(&kind)
    .bind(&user)
    .bind(&user)
    .bind(limit)
    .fetch_all(&state.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            warn!("list_reports: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<String, _>("id"),
                "user": row.get::<String, _>("reported_by"),
                "kind": row.get::<String, _>("kind"),
                "appVersion": row.get::<String, _>("app_version"),
                "platform": row.get::<String, _>("platform"),
                "detail": row.get::<String, _>("detail"),
                "createdAt": row.get::<String, _>("created_at"),
                "bytes": row.get::<i64, _>("bytes"),
            })
        })
        .collect();
    Json(json!({ "hours": hours, "count": items.len(), "items": items })).into_response()
}

/// Один отчёт целиком (любого вида) — по id.
pub(crate) async fn get_report(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let row = sqlx::query(
        "SELECT reported_by, kind, app_version, platform, payload, created_at
         FROM client_diagnostic_reports WHERE id = ?
         UNION ALL
         SELECT reported_by, 'decrypt', '', '', payload, created_at
         FROM decrypt_failure_reports WHERE id = ?
         LIMIT 1",
    )
    .bind(&id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await;
    match row {
        Ok(Some(row)) => {
            let payload: String = row.get("payload");
            let body: Value = serde_json::from_str(&payload).unwrap_or(Value::String(payload));
            Json(json!({
                "id": id,
                "user": row.get::<String, _>("reported_by"),
                "kind": row.get::<String, _>("kind"),
                "appVersion": row.get::<String, _>("app_version"),
                "platform": row.get::<String, _>("platform"),
                "createdAt": row.get::<String, _>("created_at"),
                "payload": body,
            }))
            .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            warn!("get_report: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ── Метрики сервера ─────────────────────────────────────────────────────────
//
// Счётчики в памяти процесса (сбрасываются рестартом — это «как сервер живёт
// сейчас», а не история). Пишет их request_id_middleware в lib.rs на каждый
// HTTP-запрос: одна запись в карту по маршруту с вырезанными id, без аллокаций
// на горячем пути сверх этого.

/// Запрос дольше этого — «медленный».
const SLOW_REQUEST_MS: u64 = 1000;
/// Сколько разных маршрутов держим; дальше новые сливаются в `(other)`, чтобы
/// сканер с мусорными путями не раздул карту.
const MAX_TRACKED_ROUTES: usize = 300;

#[derive(Default, Clone, Copy)]
struct RouteStats {
    count: u64,
    errors_5xx: u64,
    errors_4xx: u64,
    slow: u64,
    total_ms: u64,
    max_ms: u64,
}

struct ServerMetrics {
    started_at: Instant,
    routes: Mutex<HashMap<String, RouteStats>>,
}

fn server_metrics() -> &'static ServerMetrics {
    static METRICS: OnceLock<ServerMetrics> = OnceLock::new();
    METRICS.get_or_init(|| ServerMetrics {
        started_at: Instant::now(),
        routes: Mutex::new(HashMap::new()),
    })
}

/// Время старта — зафиксировать при запуске, а не при первом запросе.
pub(crate) fn init_server_metrics() {
    let _ = server_metrics();
}

/// `/api/messages/alice` → `/api/messages/:p`: сегменты после известного
/// префикса с данными пользователя (имена, id) — не маршрут, а параметр.
fn route_template(method: &str, path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    out.push_str(method);
    out.push(' ');
    for (i, segment) in path.split('/').enumerate() {
        if i > 0 {
            out.push('/');
        }
        let looks_like_param = segment.len() > 24
            || segment.chars().any(|c| c.is_ascii_digit())
            || (i >= 3 && !matches!(segment, "channels" | "messages" | "members" | "roles" | "assets"
                | "treasury" | "deposit" | "payout" | "claim" | "cancel" | "reaction" | "devices"
                | "followers" | "requests" | "republish" | "events" | "mine" | "managed"
                | "decrypt-failure" | "report" | "reports" | "metrics" | "join" | "approve"
                | "turn-credentials" | "subscribe" | "unsubscribe" | "register" | "unregister"
                | "fcm" | "device" | "autographs" | "transfer" | "transfers" | "gifts"
                | "balance" | "distribution" | "server-payouts" | "treasuries" | "me"
                | "ws-ticket" | "login" | "logout" | "icon" | "banner" | ""));
        out.push_str(if looks_like_param && !segment.is_empty() { ":p" } else { segment });
    }
    out
}

pub(crate) fn record_request_metric(method: &str, path: &str, status: u16, elapsed_ms: u64) {
    let key = route_template(method, path);
    let Ok(mut routes) = server_metrics().routes.lock() else { return };
    // 404 на ещё не виденный путь — почти всегда сканер (/wp-admin, /.git/config…),
    // а не маршрут. Такие не заводят свой ключ, а сливаются в один: иначе за
    // минуты после рестарта они занимали все MAX_TRACKED_ROUTES мест, и реальные
    // маршруты дальше видны были только как `(other)`. 404 известного маршрута
    // (нет такого сообщения/файла) считается на нём, как и раньше.
    let key = if routes.contains_key(&key) {
        key
    } else if status == 404 {
        "(unmatched 404)".to_string()
    } else if routes.len() < MAX_TRACKED_ROUTES {
        key
    } else {
        "(other)".to_string()
    };
    let entry = routes.entry(key).or_default();
    entry.count += 1;
    entry.total_ms += elapsed_ms;
    entry.max_ms = entry.max_ms.max(elapsed_ms);
    if elapsed_ms >= SLOW_REQUEST_MS {
        entry.slow += 1;
    }
    if status >= 500 {
        entry.errors_5xx += 1;
    } else if status >= 400 {
        entry.errors_4xx += 1;
    }
}

pub(crate) fn server_uptime_secs() -> u64 {
    server_metrics().started_at.elapsed().as_secs()
}

/// Снимок для оператора: аптайм, соединения, звонки, размер БД, отчёты за
/// сутки и маршруты — топ по суммарному времени, по ошибкам и по медленным.
pub(crate) async fn get_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let routes: Vec<(String, RouteStats)> = server_metrics()
        .routes
        .lock()
        .map(|routes| routes.iter().map(|(k, v)| (k.clone(), *v)).collect())
        .unwrap_or_default();
    let mut totals = RouteStats::default();
    for (_, s) in &routes {
        totals.count += s.count;
        totals.errors_5xx += s.errors_5xx;
        totals.errors_4xx += s.errors_4xx;
        totals.slow += s.slow;
        totals.total_ms += s.total_ms;
        totals.max_ms = totals.max_ms.max(s.max_ms);
    }
    let route_json = |(name, s): &(String, RouteStats)| {
        json!({
            "route": name,
            "count": s.count,
            "avgMs": if s.count > 0 { s.total_ms / s.count } else { 0 },
            "maxMs": s.max_ms,
            "totalMs": s.total_ms,
            "slow": s.slow,
            "errors5xx": s.errors_5xx,
            "errors4xx": s.errors_4xx,
        })
    };
    let top = |mut list: Vec<(String, RouteStats)>, key: fn(&RouteStats) -> u64| {
        list.retain(|(_, s)| key(s) > 0);
        list.sort_by(|a, b| key(&b.1).cmp(&key(&a.1)));
        list.iter().take(15).map(route_json).collect::<Vec<_>>()
    };

    let ws_connections: usize = state.user_connections.iter().map(|e| e.value().len()).sum();
    let online_users = state.user_connections.iter().filter(|e| !e.value().is_empty()).count();
    let db_bytes = std::fs::metadata(state.data_dir.join("zali_messenger.db"))
        .map(|m| m.len())
        .unwrap_or(0);
    let reports_24h: Vec<Value> = sqlx::query(
        "SELECT kind, COUNT(*) AS n FROM (
             SELECT kind, created_at FROM client_diagnostic_reports
             UNION ALL SELECT 'decrypt', created_at FROM decrypt_failure_reports
         ) WHERE created_at >= datetime('now', '-1 day') GROUP BY kind ORDER BY n DESC",
    )
    .fetch_all(&state.db)
    .await
    .map(|rows| {
        rows.iter()
            .map(|r| json!({ "kind": r.get::<String, _>("kind"), "count": r.get::<i64, _>("n") }))
            .collect()
    })
    .unwrap_or_default();

    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeSecs": server_uptime_secs(),
        "wsConnections": ws_connections,
        "onlineUsers": online_users,
        "voiceRooms": state.voice_rooms.len(),
        "dbBytes": db_bytes,
        "reportsLast24h": reports_24h,
        "requests": {
            "count": totals.count,
            "avgMs": if totals.count > 0 { totals.total_ms / totals.count } else { 0 },
            "maxMs": totals.max_ms,
            "slow": totals.slow,
            "slowThresholdMs": SLOW_REQUEST_MS,
            "errors5xx": totals.errors_5xx,
            "errors4xx": totals.errors_4xx,
        },
        "routesByTime": top(routes.clone(), |s| s.total_ms),
        "routesBy5xx": top(routes.clone(), |s| s.errors_5xx),
        "routesBySlow": top(routes, |s| s.slow),
    }))
    .into_response()
}
