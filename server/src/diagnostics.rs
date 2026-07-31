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

use crate::{AppState, AuthenticatedUser};
use axum::{extract::State, http::StatusCode, response::IntoResponse};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
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
