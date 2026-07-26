//! Authoritative per-conversation key registry.
//!
//! Before this module existed the "which AES key is the real one for this
//! conversation?" question had no single answer anywhere in the system. Every
//! client that opened a chat without a locally stored key simply invented a
//! fresh random one and started encrypting real messages with it, hoping the
//! peer would eventually converge via `conversation_key_envelopes` (delivered
//! only to *approved* devices) or the cloud vault (which excluded every DM
//! scope owned by the peer). In production that produced seven distinct keys
//! for a single DM scope and a long tail of permanently unreadable messages.
//!
//! The registry fixes that at the root: a scope's key is claimed exactly once,
//! first-write-wins, and every participant can ask the server which key id is
//! canonical. A client that holds a different key now *knows* it is wrong
//! instead of silently minting a competitor, and can ask the holders to
//! republish an envelope for it.
//!
//! Only a non-secret fingerprint (`keyId`, a SHA-256 of the key computed
//! client-side) is ever stored here — never key material. The server learns
//! which key is canonical, not what it is.

use crate::{
    get_server_member_role, send_payload_to_user, trim_limited, AppState, AuthenticatedUser,
};
use axum::{
    extract::Query,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tracing::error;

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct ClaimConversationKeyPayload {
    pub(crate) scope: String,
    pub(crate) keyId: String,
    /// Set only by an explicit user-driven key reset. A normal claim never
    /// replaces an existing row — that is the whole point of the registry.
    pub(crate) force: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct RepublishRequestPayload {
    pub(crate) scope: String,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct ConversationKeyQuery {
    /// Comma-separated scope list. Absent means "every scope I participate in"
    /// is too expensive to compute, so it returns an empty array instead.
    pub(crate) scopes: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub(crate) struct ConversationKeyRecord {
    pub(crate) scope_key: String,
    pub(crate) key_id: String,
    pub(crate) claimed_by: String,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct ConversationKeyResponse {
    pub(crate) scope: String,
    pub(crate) keyId: String,
    pub(crate) claimedBy: String,
    pub(crate) createdAt: DateTime<Utc>,
    /// True when the caller's submitted keyId won (or already held) the claim.
    pub(crate) mine: bool,
}

/// Participants of a scope, or `None` when the scope is malformed.
///
/// `dm:a:b` — both usernames (the client sorts them, so the string is stable
/// regardless of who builds it). `server:<server_id>:<channel_id>` — resolved
/// against `server_members` by the caller, so only the server id is returned.
enum Scope {
    Dm(String, String),
    Channel { server_id: String },
}

fn parse_scope(scope: &str) -> Option<Scope> {
    let parts: Vec<&str> = scope.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let a = parts[1].trim();
    let b = parts[2].trim();
    if a.is_empty() || b.is_empty() {
        return None;
    }
    match parts[0] {
        "dm" => Some(Scope::Dm(a.to_string(), b.to_string())),
        "server" => Some(Scope::Channel {
            server_id: a.to_string(),
        }),
        _ => None,
    }
}

/// Everyone allowed to read/claim this scope's key id. For a DM that is the two
/// participants; for a channel it is the whole server membership.
async fn scope_participants(
    pool: &SqlitePool,
    scope: &str,
    caller: &str,
) -> Result<Option<Vec<String>>, sqlx::Error> {
    match parse_scope(scope) {
        None => Ok(None),
        Some(Scope::Dm(a, b)) => {
            if a != caller && b != caller {
                return Ok(None);
            }
            Ok(Some(vec![a, b]))
        }
        Some(Scope::Channel { server_id }) => {
            if get_server_member_role(pool, &server_id, caller)
                .await?
                .is_none()
            {
                return Ok(None);
            }
            let members = sqlx::query_scalar::<_, String>(
                "SELECT username FROM server_members WHERE server_id = ?",
            )
            .bind(&server_id)
            .fetch_all(pool)
            .await?;
            Ok(Some(members))
        }
    }
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        "Нет доступа к ключам этого разговора",
    )
        .into_response()
}

/// Claim a scope's canonical key id, first-write-wins.
///
/// The response always reports the *winning* key id, so a client that lost the
/// race learns it immediately and can stop using its locally invented key as
/// the canonical one.
pub(crate) async fn claim_conversation_key(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(caller): AuthenticatedUser,
    headers: HeaderMap,
    Json(payload): Json<ClaimConversationKeyPayload>,
) -> Response {
    let scope = trim_limited(payload.scope, 256);
    let key_id = trim_limited(payload.keyId, 128);
    let device_id = crate::devices::header_device_id(&headers).unwrap_or_default();
    if scope.is_empty() || key_id.len() < 8 {
        return (StatusCode::BAD_REQUEST, "Некорректный claim ключа").into_response();
    }

    match scope_participants(&state.db, &scope, &caller).await {
        Ok(Some(_)) => {}
        Ok(None) => return forbidden(),
        Err(e) => {
            error!("Ошибка проверки участников scope {}: {}", scope, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    // A forced claim (explicit "сбросить ключи шифрования" in the UI) replaces
    // the row; a normal claim is INSERT-OR-IGNORE so the first writer keeps it.
    let write = if payload.force.unwrap_or(false) {
        sqlx::query(
            "INSERT INTO conversation_key_registry (scope_key, key_id, claimed_by, claimed_device_id)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(scope_key) DO UPDATE SET
                 key_id = excluded.key_id,
                 claimed_by = excluded.claimed_by,
                 claimed_device_id = excluded.claimed_device_id,
                 updated_at = CURRENT_TIMESTAMP",
        )
    } else {
        sqlx::query(
            "INSERT OR IGNORE INTO conversation_key_registry
             (scope_key, key_id, claimed_by, claimed_device_id)
             VALUES (?, ?, ?, ?)",
        )
    };
    if let Err(e) = write
        .bind(&scope)
        .bind(&key_id)
        .bind(&caller)
        .bind(&device_id)
        .execute(&state.db)
        .await
    {
        error!("Ошибка claim ключа scope {}: {}", scope, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match load_registry_row(&state.db, &scope).await {
        Ok(Some(row)) => {
            let mine = row.key_id == key_id;
            Json(ConversationKeyResponse {
                scope: row.scope_key,
                keyId: row.key_id,
                claimedBy: row.claimed_by,
                createdAt: row.created_at,
                mine,
            })
            .into_response()
        }
        Ok(None) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(e) => {
            error!("Ошибка чтения claim ключа scope {}: {}", scope, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn load_registry_row(
    pool: &SqlitePool,
    scope: &str,
) -> Result<Option<ConversationKeyRecord>, sqlx::Error> {
    sqlx::query_as::<_, ConversationKeyRecord>(
        "SELECT scope_key, key_id, claimed_by, created_at
         FROM conversation_key_registry WHERE scope_key = ?",
    )
    .bind(scope)
    .fetch_optional(pool)
    .await
}

/// Look up the canonical key ids for a batch of scopes the caller participates
/// in. Scopes the caller has no access to are silently omitted rather than
/// rejected, so one bad entry cannot break a whole sync pass.
pub(crate) async fn get_conversation_keys(
    Query(query): Query<ConversationKeyQuery>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(caller): AuthenticatedUser,
) -> Response {
    let raw = query.scopes.unwrap_or_default();
    let scopes: Vec<String> = raw
        .split(',')
        .map(|value| trim_limited(value, 256))
        .filter(|value| !value.is_empty())
        .take(200)
        .collect();
    let mut out: Vec<ConversationKeyResponse> = Vec::new();
    for scope in scopes {
        match scope_participants(&state.db, &scope, &caller).await {
            Ok(Some(_)) => {}
            Ok(None) => continue,
            Err(e) => {
                error!("Ошибка проверки участников scope {}: {}", scope, e);
                continue;
            }
        }
        match load_registry_row(&state.db, &scope).await {
            Ok(Some(row)) => out.push(ConversationKeyResponse {
                scope: row.scope_key,
                keyId: row.key_id,
                claimedBy: row.claimed_by,
                createdAt: row.created_at,
                mine: false,
            }),
            Ok(None) => {}
            Err(e) => error!("Ошибка чтения registry scope {}: {}", scope, e),
        }
    }
    Json(out).into_response()
}

/// Ask every other participant of a scope to re-publish a key envelope for the
/// caller's device.
///
/// Without this a device that registered after the key was published simply
/// never received one: `get_key_envelopes` filters by exact
/// `recipient_device_id`, and senders only republished on their own next login.
pub(crate) async fn request_key_republish(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(caller): AuthenticatedUser,
    headers: HeaderMap,
    Json(payload): Json<RepublishRequestPayload>,
) -> Response {
    let scope = trim_limited(payload.scope, 256);
    if scope.is_empty() {
        return (StatusCode::BAD_REQUEST, "Не указан scope").into_response();
    }
    let device_id = crate::devices::header_device_id(&headers).unwrap_or_default();
    let participants = match scope_participants(&state.db, &scope, &caller).await {
        Ok(Some(list)) => list,
        Ok(None) => return forbidden(),
        Err(e) => {
            error!("Ошибка проверки участников scope {}: {}", scope, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let notify = serde_json::json!({
        "type": "key_republish_request",
        "scope": scope,
        "requester": caller,
        "requesterDeviceId": device_id,
    })
    .to_string();
    let mut notified = 0usize;
    for participant in participants {
        if participant == caller {
            continue;
        }
        notified +=
            send_payload_to_user(&state, &participant, notify.clone(), "key_republish").await;
    }
    Json(serde_json::json!({ "notified": notified })).into_response()
}
