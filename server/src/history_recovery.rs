//! Восстановление переписки через собеседника.
//!
//! Ключи личной переписки (`dm:a:b`) есть у обоих её участников. Если у человека
//! их не осталось — сбросил пароль и с ним облачный vault, вошёл с нового
//! устройства, очистил хранилище, — сообщения на сервере лежат, но открыть их
//! нечем. Ключ есть у собеседника: в контекстном меню собеседника — «Восстановить
//! переписку», и запрос ждёт здесь, пока тот не появится в сети. Тогда его клиент
//! шлёт все ключи этой переписки на устройства спросившего обычными ECDH-конвертами
//! (тот же путь, что `key_republish_request`, `handleKeyRepublishRequest`) и
//! отмечает запрос выполненным, а спросивший получает `history_recovery_update`.
//!
//! Отличие от `key_republish_request` — только в долговечности: тот уходит лишь
//! тем, кто в сети прямо сейчас, и теряется, если собеседник офлайн. Этот хранится
//! (30 дней) и доставляется при каждом подключении собеседника, пока не выполнен.
//!
//! Модель доверия та же, что у существующей пересылки ключей: конверт запечатан
//! публичным ключом устройства спросившего, сервер ключа не видит. Просить можно
//! только того, с кем есть личная переписка, — иначе это был бы способ слать
//! незнакомым людям уведомления.

use crate::{auth::rate_allow, auth::AuthenticatedUser, conversation_keys::canonical_scope, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use sqlx::Row;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info};
use uuid::Uuid;

const REQUEST_TTL_SECS: i64 = 30 * 24 * 3600;

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

fn dm_scope(a: &str, b: &str) -> String {
    canonical_scope(&format!("dm:{a}:{b}"))
}

#[derive(Deserialize)]
pub(crate) struct RecoveryRequestPayload {
    peer: String,
}

/// `POST /api/history-recovery` — попросить собеседника вернуть ключи переписки.
pub(crate) async fn request_recovery(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(caller): AuthenticatedUser,
    Json(payload): Json<RecoveryRequestPayload>,
) -> Response {
    if !rate_allow(&state, format!("histrec:{}", caller.to_lowercase()), 20) {
        return (StatusCode::TOO_MANY_REQUESTS, "Слишком много запросов. Повторите через минуту.").into_response();
    }
    let wanted = payload.peer.trim();
    if wanted.is_empty() || wanted.len() > 64 {
        return (StatusCode::BAD_REQUEST, "Не указан собеседник").into_response();
    }
    if wanted.eq_ignore_ascii_case(&caller) {
        return (StatusCode::BAD_REQUEST, "Переписку с собой восстанавливают другие ваши устройства").into_response();
    }
    let peer = match sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE lower(username) = ?")
        .bind(wanted.to_lowercase())
        .fetch_optional(&state.db)
        .await
    {
        Ok(Some(peer)) => peer,
        Ok(None) => return (StatusCode::NOT_FOUND, "Пользователь не найден").into_response(),
        Err(e) => {
            error!("history_recovery peer: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // Есть ли что восстанавливать: личные сообщения между ними или ключ, который
    // собеседник когда-то прислал этому аккаунту.
    let related = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(
            SELECT 1 FROM messages WHERE server_id IS NULL
              AND ((sender = ?1 AND receiver = ?2) OR (sender = ?2 AND receiver = ?1))
         ) OR EXISTS(
            SELECT 1 FROM conversation_key_envelopes
             WHERE (owner = ?1 AND sender = ?2) OR (owner = ?2 AND sender = ?1)
         )",
    )
    .bind(&caller)
    .bind(&peer)
    .fetch_one(&state.db)
    .await;
    match related {
        Ok(1) => {}
        Ok(_) => return (StatusCode::NOT_FOUND, "С этим собеседником нет личной переписки").into_response(),
        Err(e) => {
            error!("history_recovery related: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let scope = dm_scope(&caller, &peer);
    let now = now_secs();
    let id = Uuid::new_v4().to_string();
    // Повторный запрос к тому же собеседнику оживляет прежний (тот же id, снова
    // «ждёт»), а не плодит строки.
    let stored = sqlx::query_scalar::<_, String>(
        "INSERT INTO history_recovery_requests (id, requester, peer, scope, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(requester, peer) DO UPDATE SET
            scope = excluded.scope, status = 'pending', updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
         RETURNING id",
    )
    .bind(&id)
    .bind(&caller)
    .bind(&peer)
    .bind(&scope)
    .bind(now)
    .bind(now)
    .bind(now + REQUEST_TTL_SECS)
    .fetch_one(&state.db)
    .await;
    let id = match stored {
        Ok(id) => id,
        Err(e) => {
            error!("history_recovery insert: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let notified = crate::send_payload_to_user(&state, &peer, request_event(&id, &caller, &scope), "history_recovery").await;
    info!("Запрос восстановления переписки {} → {} (в сети: {})", caller, peer, notified > 0);
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "id": id,
            "peer": peer,
            "scope": scope,
            "status": "pending",
            "peerOnline": notified > 0,
        })),
    )
        .into_response()
}

fn request_event(id: &str, requester: &str, scope: &str) -> String {
    serde_json::json!({
        "type": "history_recovery_request",
        "id": id,
        "requester": requester,
        "scope": scope,
    })
    .to_string()
}

/// `GET /api/history-recovery` — входящие (ждущие ответа от меня) и исходящие.
pub(crate) async fn list_recovery(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(caller): AuthenticatedUser,
) -> Response {
    let now = now_secs();
    let incoming = sqlx::query(
        "SELECT id, requester, scope, created_at FROM history_recovery_requests
         WHERE peer = ? AND status = 'pending' AND expires_at > ? ORDER BY updated_at",
    )
    .bind(&caller)
    .bind(now)
    .fetch_all(&state.db)
    .await;
    let outgoing = sqlx::query(
        "SELECT id, peer, scope, status, updated_at FROM history_recovery_requests
         WHERE requester = ? AND expires_at > ? ORDER BY updated_at DESC LIMIT 200",
    )
    .bind(&caller)
    .bind(now)
    .fetch_all(&state.db)
    .await;
    match (incoming, outgoing) {
        (Ok(incoming), Ok(outgoing)) => Json(serde_json::json!({
            "incoming": incoming.iter().map(|r| serde_json::json!({
                "id": r.get::<String, _>("id"),
                "requester": r.get::<String, _>("requester"),
                "scope": r.get::<String, _>("scope"),
                "createdAt": r.get::<i64, _>("created_at"),
            })).collect::<Vec<_>>(),
            "outgoing": outgoing.iter().map(|r| serde_json::json!({
                "id": r.get::<String, _>("id"),
                "peer": r.get::<String, _>("peer"),
                "scope": r.get::<String, _>("scope"),
                "status": r.get::<String, _>("status"),
                "updatedAt": r.get::<i64, _>("updated_at"),
            })).collect::<Vec<_>>(),
        }))
        .into_response(),
        (Err(e), _) | (_, Err(e)) => {
            error!("history_recovery list: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct FulfillPayload {
    /// `sent` — ключи отправлены; `no_key` — у собеседника их тоже нет.
    result: String,
}

/// `POST /api/history-recovery/:id/fulfill` — собеседник отправил ключи (или их нет).
pub(crate) async fn fulfill_recovery(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(caller): AuthenticatedUser,
    Path(id): Path<String>,
    Json(payload): Json<FulfillPayload>,
) -> Response {
    let status = match payload.result.as_str() {
        "sent" => "fulfilled",
        "no_key" => "no_key",
        _ => return (StatusCode::BAD_REQUEST, "result: sent | no_key").into_response(),
    };
    let id = id.trim().to_string();
    if id.is_empty() || id.len() > 64 {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Отметить может только тот, у кого просили, и только ждущий запрос.
    let row = sqlx::query(
        "UPDATE history_recovery_requests SET status = ?, updated_at = ?
         WHERE id = ? AND peer = ? AND status = 'pending'
         RETURNING requester, scope",
    )
    .bind(status)
    .bind(now_secs())
    .bind(&id)
    .bind(&caller)
    .fetch_optional(&state.db)
    .await;
    let (requester, scope) = match row {
        Ok(Some(row)) => (row.get::<String, _>("requester"), row.get::<String, _>("scope")),
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("history_recovery fulfill: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let event = serde_json::json!({
        "type": "history_recovery_update",
        "id": id,
        "peer": caller,
        "scope": scope,
        "status": status,
    })
    .to_string();
    crate::send_payload_to_user(&state, &requester, event, "history_recovery").await;
    info!("Восстановление переписки {} ← {}: {}", requester, caller, status);
    Json(serde_json::json!({ "status": status })).into_response()
}

/// Новое WS-соединение: всё, что ждёт ответа от этого человека, — сразу в него.
/// Именно это делает запрос «отложенным до входа в сеть».
pub(crate) async fn send_pending_to_connection(state: &Arc<AppState>, username: &str, tx: &mpsc::Sender<String>) {
    let rows = sqlx::query(
        "SELECT id, requester, scope FROM history_recovery_requests
         WHERE peer = ? AND status = 'pending' AND expires_at > ? ORDER BY updated_at LIMIT 50",
    )
    .bind(username)
    .bind(now_secs())
    .fetch_all(&state.db)
    .await;
    match rows {
        Ok(rows) => {
            for row in rows {
                let event = request_event(
                    &row.get::<String, _>("id"),
                    &row.get::<String, _>("requester"),
                    &row.get::<String, _>("scope"),
                );
                if tx.try_send(event).is_err() {
                    break;
                }
            }
        }
        Err(e) => error!("history_recovery pending for {}: {}", username, e),
    }
}

/// Просроченные запросы удаляются.
pub(crate) async fn sweep_expired(state: &AppState) {
    let _ = sqlx::query("DELETE FROM history_recovery_requests WHERE expires_at < ?")
        .bind(now_secs())
        .execute(&state.db)
        .await;
}
