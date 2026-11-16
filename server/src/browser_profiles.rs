//! Общий профиль «Общего браузера» сообщества: куки, с которыми любой участник
//! сервера запускает браузер-активность в звонке (web/src/interface/shared_browser.js).
//!
//! - **Читать и писать могут только участники сервера.** Это и есть смысл профиля:
//!   вошёл один — вошли все, кто запускает браузер в этом сообществе.
//! - **Два браузера сообщества одновременно не затирают друг друга.** Клиент шлёт
//!   `baseRevision` — ревизию, от которой начал. Совпала — его набор заменяет хранимый
//!   (так проходят и выходы с сайтов); не совпала или не прислана — слияние по
//!   (домен, путь, имя): его куки поверх, чужие, которых у него нет, остаются.
//! - **Лишнее обрезается, а не валит запись:** просроченные выкидываются, дальше —
//!   сессионные и самые долгоживущие, до `MAX_COOKIES` и `MAX_DOC_BYTES`.
//! - **Не E2E.** У сообщества нет секрета, которого не знал бы сервер (ключ канала
//!   выводится из scope), поэтому шифровать на клиенте было бы видимостью защиты.
//!   Сервер видит куки, как видит сообщения каналов, — это сказано и в интерфейсе.
//! - **Формат — куки в виде CDP `Network.Cookie`** (общий для WebKit и WebView2):
//!   имя, значение, домен, путь, срок, флаги. Всё прочее отбрасывается при записи,
//!   а размеры ограничены, чтобы это не стало бесплатным диском.
//! - Профиль удаляется вместе с сервером (`delete_server`).

use crate::{get_server_member_role, rate_allow, AppState, AuthenticatedUser};
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use tracing::{error, info};

const MAX_COOKIES: usize = 600;
/// Сколько кук принять на вход до обрезки (оболочки отдают не больше 2000).
const MAX_INCOMING: usize = 5000;
const MAX_NAME: usize = 256;
const MAX_VALUE: usize = 4096;
const MAX_DOMAIN: usize = 255;
const MAX_PATH: usize = 1024;
const MAX_DOC_BYTES: usize = 384 * 1024;
/// Записей на человека за окно лимитера: закрытие браузера и автосохранение раз в минуту.
const MAX_WRITES_PER_WINDOW: usize = 40;

pub(crate) async fn init_table(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS server_browser_profiles (
            server_id TEXT PRIMARY KEY,
            data TEXT NOT NULL DEFAULT '[]',
            revision INTEGER NOT NULL DEFAULT 0,
            updated_by TEXT NOT NULL DEFAULT '',
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await
    .expect("Ошибка создания таблицы server_browser_profiles");
}

fn valid_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= MAX_DOMAIN
        && domain
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'[' | b']'))
}

fn bounded_str<'a>(cookie: &'a Map<String, Value>, key: &str, max: usize) -> Option<&'a str> {
    cookie.get(key).and_then(Value::as_str).filter(|s| s.len() <= max)
}

/// Кука в каноническом виде или `None`, если она не проходит лимиты.
pub(crate) fn sanitize_cookie(raw: &Value) -> Option<Value> {
    let cookie = raw.as_object()?;
    let name = bounded_str(cookie, "name", MAX_NAME)?;
    let value = bounded_str(cookie, "value", MAX_VALUE)?;
    let domain = bounded_str(cookie, "domain", MAX_DOMAIN).filter(|d| valid_domain(d))?;
    let path = bounded_str(cookie, "path", MAX_PATH).unwrap_or("/");
    if name.is_empty() || name.chars().any(|c| c.is_control()) || value.chars().any(|c| c.is_control()) {
        return None;
    }
    let expires = cookie
        .get("expires")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(-1.0);
    let same_site = match cookie.get("sameSite").and_then(Value::as_str) {
        Some("Strict") => "Strict",
        Some("None") => "None",
        _ => "Lax",
    };
    Some(json!({
        "name": name,
        "value": value,
        "domain": domain,
        "path": if path.starts_with('/') { path } else { "/" },
        "expires": expires,
        "httpOnly": cookie.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
        "secure": cookie.get("secure").and_then(Value::as_bool).unwrap_or(false),
        "sameSite": same_site,
    }))
}

fn cookie_key(c: &Value) -> (String, String, String) {
    let field = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    (field("domain"), field("path"), c.get("name").and_then(Value::as_str).unwrap_or("").to_string())
}

/// Куки `incoming` поверх `stored`: совпавшие по (домен, путь, имя) — из `incoming`.
pub(crate) fn merge_cookies(stored: Vec<Value>, incoming: Vec<Value>) -> Vec<Value> {
    let keys: std::collections::HashSet<_> = incoming.iter().map(cookie_key).collect();
    let mut out = incoming;
    out.extend(stored.into_iter().filter(|c| !keys.contains(&cookie_key(c))));
    out
}

/// Без просроченных; сессионные и долгоживущие — первыми; не больше лимитов.
pub(crate) fn trim_cookies(cookies: Vec<Value>, now_secs: f64) -> Vec<Value> {
    let expires = |c: &Value| c.get("expires").and_then(Value::as_f64).unwrap_or(-1.0);
    let mut live: Vec<Value> = cookies.into_iter().filter(|c| expires(c) <= 0.0 || expires(c) > now_secs).collect();
    let rank = |c: &Value| if expires(c) <= 0.0 { f64::INFINITY } else { expires(c) };
    live.sort_by(|a, b| rank(b).partial_cmp(&rank(a)).unwrap_or(std::cmp::Ordering::Equal));
    live.truncate(MAX_COOKIES);
    while !live.is_empty() && Value::Array(live.clone()).to_string().len() > MAX_DOC_BYTES {
        let drop = (live.len() / 10).max(1);
        live.truncate(live.len() - drop);
    }
    live
}

async fn require_member(state: &AppState, server_id: &str, username: &str) -> Result<(), StatusCode> {
    match get_server_member_role(&state.db, server_id, username).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(StatusCode::FORBIDDEN),
        Err(e) => {
            error!("browser_profiles: роль {} в {}: {}", username, server_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// `GET /api/servers/:server_id/browser-profile` → `{cookies, revision, updatedBy, updatedAt}`.
pub(crate) async fn get_profile(
    AxumPath(server_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> impl IntoResponse {
    if let Err(code) = require_member(&state, &server_id, &username).await {
        return code.into_response();
    }
    let row: Option<(String, i64, String, String)> = sqlx::query_as(
        "SELECT data, revision, updated_by, CAST(updated_at AS TEXT) FROM server_browser_profiles WHERE server_id = ?",
    )
    .bind(&server_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let Some((data, revision, updated_by, updated_at)) = row else {
        return Json(json!({ "cookies": [], "revision": 0, "updatedBy": "", "updatedAt": "" })).into_response();
    };
    let cookies = serde_json::from_str::<Value>(&data).unwrap_or_else(|_| json!([]));
    Json(json!({ "cookies": cookies, "revision": revision, "updatedBy": updated_by, "updatedAt": updated_at }))
        .into_response()
}

/// `PUT /api/servers/:server_id/browser-profile` с `{cookies: [...]}` → `{revision}`.
pub(crate) async fn put_profile(
    AxumPath(server_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Err(code) = require_member(&state, &server_id, &username).await {
        return code.into_response();
    }
    if !rate_allow(&state, format!("browser-profile:{username}"), MAX_WRITES_PER_WINDOW) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let Some(raw) = body.get("cookies").and_then(Value::as_array) else {
        return (StatusCode::BAD_REQUEST, "cookies must be an array").into_response();
    };
    if raw.len() > MAX_INCOMING {
        return (StatusCode::PAYLOAD_TOO_LARGE, "too many cookies").into_response();
    }
    // Негодная кука отбрасывается, а не валит всю запись: браузер мог набрать
    // одну огромную куку какого-нибудь трекера, и из-за неё не сохранились бы входы.
    let incoming: Vec<Value> = raw.iter().filter_map(sanitize_cookie).collect();
    let stored: Option<(String, i64)> =
        sqlx::query_as("SELECT data, revision FROM server_browser_profiles WHERE server_id = ?")
            .bind(&server_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let base = body.get("baseRevision").and_then(Value::as_i64);
    let merged = matches!(&stored, Some((_, revision)) if base != Some(*revision));
    let combined = match stored {
        Some((data, _)) if merged => {
            let old = serde_json::from_str::<Value>(&data).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
            merge_cookies(old, incoming)
        }
        _ => incoming,
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let cookies = trim_cookies(combined, now);
    let text = Value::Array(cookies.clone()).to_string();
    let revision: Result<i64, sqlx::Error> = sqlx::query_scalar(
        "INSERT INTO server_browser_profiles (server_id, data, revision, updated_by, updated_at)
         VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(server_id) DO UPDATE SET data = excluded.data, revision = revision + 1,
             updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
         RETURNING revision",
    )
    .bind(&server_id)
    .bind(&text)
    .bind(&username)
    .fetch_one(&state.db)
    .await;
    match revision {
        Ok(revision) => {
            // Только счётчики: значения кук в журнал не попадают.
            info!(
                "browser_profiles: server={} by={} incoming={} stored={} merged={} revision={}",
                server_id,
                username,
                raw.len(),
                cookies.len(),
                merged,
                revision
            );
            Json(json!({ "revision": revision, "cookies": cookies.len(), "merged": merged })).into_response()
        }
        Err(e) => {
            error!("browser_profiles: запись server={} err={}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_known_fields_only() {
        let cookie = sanitize_cookie(&json!({
            "name": "sid", "value": "abc", "domain": ".example.com", "path": "/",
            "expires": 1900000000.5, "httpOnly": true, "secure": true, "sameSite": "None",
            "priority": "High", "sourcePort": 443
        }))
        .unwrap();
        assert_eq!(cookie["sameSite"], "None");
        assert!(cookie.get("priority").is_none());
        assert_eq!(cookie["expires"], 1900000000.5);
    }

    #[test]
    fn merge_keeps_others_and_trim_respects_limits() {
        let a = json!({ "name": "a", "value": "1", "domain": "x.com", "path": "/", "expires": -1.0 });
        let b_old = json!({ "name": "b", "value": "old", "domain": "y.com", "path": "/", "expires": 2.0e9 });
        let b_new = json!({ "name": "b", "value": "new", "domain": "y.com", "path": "/", "expires": 2.0e9 });
        let merged = merge_cookies(vec![a.clone(), b_old], vec![b_new]);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|c| c["value"] == "new") && merged.iter().any(|c| c["name"] == "a"));
        let mut many: Vec<Value> = (0..MAX_COOKIES + 100)
            .map(|i| json!({ "name": format!("c{i}"), "value": "v", "domain": "z.com", "path": "/", "expires": 2.0e9 + i as f64 }))
            .collect();
        many.push(json!({ "name": "gone", "value": "v", "domain": "z.com", "path": "/", "expires": 10.0 }));
        many.push(a);
        let trimmed = trim_cookies(many, 1.5e9);
        assert_eq!(trimmed.len(), MAX_COOKIES);
        assert_eq!(trimmed[0]["name"], "a", "сессионная — первой");
        assert!(!trimmed.iter().any(|c| c["name"] == "gone"), "просроченная выброшена");
    }

    #[test]
    fn sanitize_rejects_bad_cookies() {
        assert!(sanitize_cookie(&json!({ "name": "", "value": "x", "domain": "a.com" })).is_none());
        assert!(sanitize_cookie(&json!({ "name": "a", "value": "x", "domain": "a.com/evil" })).is_none());
        assert!(sanitize_cookie(&json!({ "name": "a", "value": "x\n", "domain": "a.com" })).is_none());
        assert!(sanitize_cookie(&json!({ "name": "a", "value": "x".repeat(MAX_VALUE + 1), "domain": "a.com" })).is_none());
        let fixed = sanitize_cookie(&json!({ "name": "a", "value": "x", "domain": "a.com", "path": "rel", "sameSite": "weird" })).unwrap();
        assert_eq!(fixed["path"], "/");
        assert_eq!(fixed["sameSite"], "Lax");
        assert_eq!(fixed["expires"], -1.0);
    }
}
