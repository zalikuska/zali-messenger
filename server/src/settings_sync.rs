//! Облако настроек интерфейса: один JSON на аккаунт, чтобы тема, расстановка
//! сообщений и громкости одинаково выглядели на всех устройствах человека.
//!
//! Что здесь важно понимать:
//!
//! - **Сервер не знает, что за настройки.** Ключ — короткое имя (`design_mode`),
//!   значение — строка (то, что клиент держит в localStorage). Состав синхронизируемого
//!   решает клиент (`web/src/interface/settings_sync.js`): нового ключа на сервере
//!   добавлять не нужно, а старый клиент не ломается от чужих ключей.
//!
//! - **Слияние по ключам, последняя запись побеждает.** Каждая запись несёт
//!   время изменения `t` (мс, с часов клиента). Приходящая запись принимается,
//!   только если новее хранимой; иначе клиенту возвращается серверная. Целый
//!   документ не перезаписывается — два устройства, поменявшие разные настройки,
//!   не стирают друг друга.
//!
//! - **Лимиты** — чтобы это не стало бесплатным диском: ключей до 64, ключ до 48
//!   символов `[a-z0-9_]`, значение до 4 КиБ, документ до 64 КиБ.
//!
//! - **Событие `settings_sync`** уходит на все соединения владельца после
//!   записи: остальные устройства подтягивают документ и применяют его сразу.
//!   Эхо своему же устройству безвредно — значения совпадают, и применять нечего.
//!
//! - **Не E2E.** Это внешний вид, а не переписка: сервер видит значения.
//!   Секретов и ключей в этот документ класть нельзя.

use crate::{realtime::send_json_to_user, AppState, AuthenticatedUser};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use tracing::warn;

const MAX_KEYS: usize = 64;
const MAX_KEY_LEN: usize = 48;
const MAX_VALUE_BYTES: usize = 4 * 1024;
const MAX_DOC_BYTES: usize = 64 * 1024;

pub(crate) async fn init_table(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_settings (
            username TEXT PRIMARY KEY,
            data TEXT NOT NULL DEFAULT '{}',
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await
    .expect("Ошибка создания таблицы user_settings");
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

async fn load(state: &AppState, username: &str) -> Map<String, Value> {
    let raw: Option<String> = sqlx::query_scalar("SELECT data FROM user_settings WHERE username = ?")
        .bind(username)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// `GET /api/settings-sync` → `{ "entries": { key: { "v": "…", "t": 123 } } }`.
pub(crate) async fn get_settings(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> impl IntoResponse {
    Json(json!({ "entries": load(&state, &username).await }))
}

/// `PUT /api/settings-sync` с `{ "entries": { key: { "v", "t" } } }` — только
/// изменённые ключи. Ответ — слитый документ целиком.
pub(crate) async fn put_settings(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let Some(incoming) = body.get("entries").and_then(Value::as_object) else {
        return (StatusCode::BAD_REQUEST, "entries must be an object").into_response();
    };
    for (key, entry) in incoming {
        let ok = valid_key(key)
            && entry.get("t").and_then(Value::as_i64).is_some()
            && entry
                .get("v")
                .and_then(Value::as_str)
                .map(|v| v.len() <= MAX_VALUE_BYTES)
                .unwrap_or(false);
        if !ok {
            return (StatusCode::BAD_REQUEST, "bad entry").into_response();
        }
    }
    let mut doc = load(&state, &username).await;
    let mut changed = false;
    for (key, entry) in incoming {
        let t = entry["t"].as_i64().unwrap_or(0);
        let newer = doc
            .get(key)
            .and_then(|old| old.get("t"))
            .and_then(Value::as_i64)
            .map(|old| t > old)
            .unwrap_or(true);
        if newer {
            doc.insert(key.clone(), json!({ "v": entry["v"], "t": t }));
            changed = true;
        }
    }
    if doc.len() > MAX_KEYS {
        return (StatusCode::PAYLOAD_TOO_LARGE, "too many keys").into_response();
    }
    let text = Value::Object(doc.clone()).to_string();
    if text.len() > MAX_DOC_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "document too large").into_response();
    }
    if changed {
        let result = sqlx::query(
            "INSERT INTO user_settings (username, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP",
        )
        .bind(&username)
        .bind(&text)
        .execute(&state.db)
        .await;
        if let Err(e) = result {
            warn!("settings_sync: запись username={} err={}", username, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        send_json_to_user(&state, &username, json!({ "type": "settings_sync" })).await;
    }
    Json(json!({ "entries": doc })).into_response()
}
