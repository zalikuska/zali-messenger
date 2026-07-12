//! Web Push (VAPID) for the standalone browser/PWA client. Native shells
//! (macOS/Windows/iOS/Android) use their own local `SHOW_NOTIFICATION`
//! bridge and never call these routes — this is browser-only delivery for
//! when the tab/PWA is fully closed and the WS connection is gone.
//!
//! Disabled by default: if `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` aren't set
//! in Config, `/api/push/vapid-public-key` 404s (so the client never calls
//! `pushManager.subscribe()`) and `send_web_push` no-ops.

use crate::{AppState, AuthenticatedUser};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};
use uuid::Uuid;
use web_push::{
    ContentEncoding, SubscriptionInfo, SubscriptionKeys, Urgency, VapidSignatureBuilder,
    WebPushMessageBuilder,
};

#[derive(Debug, Deserialize)]
pub(crate) struct PushSubscriptionRequest {
    endpoint: String,
    keys: SubscriptionKeysPayload,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SubscriptionKeysPayload {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PushUnsubscribeRequest {
    endpoint: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct VapidPublicKeyResponse {
    #[serde(rename = "publicKey")]
    public_key: String,
}

pub(crate) async fn get_vapid_public_key(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match &state.config.vapid_public_key {
        Some(key) => Json(VapidPublicKeyResponse {
            public_key: key.clone(),
        })
        .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(crate) async fn subscribe_push(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<PushSubscriptionRequest>,
) -> impl IntoResponse {
    if state.config.vapid_private_key.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let endpoint = body.endpoint.trim();
    if endpoint.is_empty() || body.keys.p256dh.trim().is_empty() || body.keys.auth.trim().is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let id = Uuid::new_v4().to_string();
    let result = sqlx::query(
        "INSERT INTO push_subscriptions (id, username, endpoint, p256dh, auth)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
            username = excluded.username,
            p256dh = excluded.p256dh,
            auth = excluded.auth",
    )
    .bind(&id)
    .bind(&username)
    .bind(endpoint)
    .bind(body.keys.p256dh.trim())
    .bind(body.keys.auth.trim())
    .execute(&state.db)
    .await;

    match result {
        Ok(_) => {
            info!("Push subscription сохранена username={}", username);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            warn!("Ошибка сохранения push subscription username={}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn unsubscribe_push(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<PushUnsubscribeRequest>,
) -> impl IntoResponse {
    let result = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ? AND username = ?")
        .bind(body.endpoint.trim())
        .bind(&username)
        .execute(&state.db)
        .await;

    match result {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            warn!("Ошибка удаления push subscription username={}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Sends a generic (no message text — the server never has E2E plaintext) Web
/// Push notification to every subscription `username` has registered. No-ops
/// silently if Web Push isn't configured. Expired subscriptions (404/410 from
/// the push service) are pruned as they're discovered.
pub(crate) async fn send_web_push(state: &Arc<AppState>, username: &str, title: &str, body: &str) {
    let Some(private_key) = state.config.vapid_private_key.as_deref() else {
        return;
    };

    let rows = match sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE username = ?",
    )
    .bind(username)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            warn!("Ошибка чтения push subscriptions username={}: {}", username, e);
            return;
        }
    };
    if rows.is_empty() {
        return;
    }

    let payload = serde_json::json!({ "title": title, "body": body }).to_string();
    let http_client = reqwest::Client::new();

    for (id, endpoint, p256dh, auth) in rows {
        let subscription_info = SubscriptionInfo {
            endpoint: endpoint.clone(),
            keys: SubscriptionKeys {
                p256dh,
                auth,
            },
        };

        let message = (|| -> Result<web_push::WebPushMessage, web_push::WebPushError> {
            let mut sig_builder = VapidSignatureBuilder::from_base64_no_sub(private_key)?
                .add_sub_info(&subscription_info);
            sig_builder.add_claim("sub", state.config.vapid_subject.as_str());
            let signature = sig_builder.build()?;

            let mut builder = WebPushMessageBuilder::new(&subscription_info);
            builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
            builder.set_vapid_signature(signature);
            builder.set_urgency(Urgency::Normal);
            builder.set_ttl(3600);
            builder.build()
        })();

        let message = match message {
            Ok(m) => m,
            Err(e) => {
                warn!("Ошибка сборки web push username={} id={}: {:?}", username, id, e);
                continue;
            }
        };

        let mut request = http_client.post(message.endpoint.to_string()).header("TTL", message.ttl.to_string());
        if let Some(urgency) = message.urgency {
            request = request.header("Urgency", urgency.to_string());
        }
        let status = if let Some(payload) = message.payload {
            request = request
                .header("Content-Encoding", payload.content_encoding.to_str())
                .header("Content-Type", "application/octet-stream");
            for (key, value) in payload.crypto_headers {
                request = request.header(key, value);
            }
            request.body(payload.content).send().await
        } else {
            request.send().await
        };

        match status {
            Ok(response) if response.status() == 404 || response.status() == 410 => {
                info!("Push endpoint устарел, удаляю subscription id={}", id);
                sqlx::query("DELETE FROM push_subscriptions WHERE id = ?")
                    .bind(&id)
                    .execute(&state.db)
                    .await
                    .ok();
            }
            Ok(response) if !response.status().is_success() => {
                warn!(
                    "Push отправка неуспешна username={} id={} status={}",
                    username,
                    id,
                    response.status()
                );
            }
            Ok(_) => {
                info!("Push отправлен username={} id={}", username, id);
            }
            Err(e) => {
                warn!("Push отправка не удалась username={} id={}: {}", username, id, e);
            }
        }
    }
}
