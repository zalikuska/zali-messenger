//! Web Push (VAPID) for the standalone browser/PWA client. Native shells
//! (macOS/Windows/iOS/Android) use their own local `SHOW_NOTIFICATION`
//! bridge and never call these routes.
//!
//! Disabled by default: if `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` aren't set
//! in Config, `/api/push/vapid-public-key` 404s (so the client never calls
//! `pushManager.subscribe()`) and `send_web_push` no-ops.
//!
//! # Кому уходит пуш
//!
//! Раньше — только если у пользователя не было НИ ОДНОГО WS-соединения. Любой онлайн-клиент
//! (приложение на Mac, другая вкладка, полуоткрытый сокет, который сервер ещё не
//! похоронил) глушил пуш на все устройства пользователя, а замороженная фоновая вкладка на
//! телефоне — за которую сетевой стек браузера продолжает отвечать на Ping, хотя JS уже не
//! исполняется и показать уведомление сам не может, — глушила его бессрочно.
//!
//! Теперь решение принимается по каждой подписке (`push_suppressed_for`): пуш не уходит на
//! устройство, только если там прямо сейчас смотрят в приложение. Сообщить это может только
//! сама вкладка — событием `client_presence` (web/src/interface/web_push.js); сервер держит
//! его на соединении вместе со временем последнего входящего кадра. Отметка «смотрю», которую
//! сокет перестал подтверждать дольше `PRESENCE_FRESH`, не в счёт: живой сокет получает Ping
//! раз в 20 с и отвечает на него, мёртвый — нет.
//!
//! Вкладка, которая жива, но не перед глазами, получает и пуш, и своё локальное уведомление.
//! Второй звонок о том же сообщении гасится по `messageId` — и в service worker, и на странице.

use crate::{header_device_id, AppState, AuthenticatedUser};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{info, warn};
use uuid::Uuid;
use web_push::{
    ContentEncoding, SubscriptionInfo, SubscriptionKeys, Urgency, VapidSignatureBuilder,
    WebPushMessageBuilder,
};

/// Сколько отметка «смотрю в приложение» живёт без подтверждения входящим кадром. Сервер
/// шлёт Ping раз в 20 с (realtime.rs), так что живой сокет обновляет её втрое чаще.
const PRESENCE_FRESH: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
pub(crate) struct PushSubscriptionRequest {
    endpoint: String,
    keys: SubscriptionKeysPayload,
    /// Тот же id устройства, что уходит в `X-Zali-Device-ID`. По нему пуш сопоставляется с
    /// присутствием вкладки на этом устройстве.
    #[serde(rename = "deviceId", default)]
    device_id: Option<String>,
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

/// Что известно серверу о WS-соединении для решения «слать ли пуш».
#[derive(Debug, Clone)]
pub(crate) struct ConnectionPresence {
    pub(crate) username: String,
    pub(crate) device_id: Option<String>,
    /// Пользователь смотрит в приложение: вкладка видима и в фокусе (`isAppAttended`).
    /// Нативные оболочки этого не сообщают, и их соединения пуш не глушат — подписок у
    /// них всё равно нет.
    pub(crate) attended: bool,
    pub(crate) last_inbound: Instant,
}

static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) fn register_connection_presence(state: &AppState, username: &str) -> u64 {
    let id = NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
    state.push_presence.insert(
        id,
        ConnectionPresence {
            username: username.to_string(),
            device_id: None,
            attended: false,
            last_inbound: Instant::now(),
        },
    );
    id
}

/// Любой входящий кадр — текст, Pong, Ping — доказывает, что сокет жив.
pub(crate) fn note_connection_inbound(state: &AppState, connection_id: u64) {
    if let Some(mut entry) = state.push_presence.get_mut(&connection_id) {
        entry.last_inbound = Instant::now();
    }
}

pub(crate) fn update_connection_presence(
    state: &AppState,
    connection_id: u64,
    attended: bool,
    device_id: Option<&str>,
) {
    if let Some(mut entry) = state.push_presence.get_mut(&connection_id) {
        entry.attended = attended;
        entry.last_inbound = Instant::now();
        if let Some(device) = device_id.map(str::trim).filter(|device| !device.is_empty()) {
            entry.device_id = Some(device.to_string());
        }
    }
}

pub(crate) fn remove_connection_presence(state: &AppState, connection_id: u64) {
    state.push_presence.remove(&connection_id);
}

/// Не слать пуш в подписку устройства `device_id`: пользователь смотрит в приложение на
/// нём прямо сейчас, и уведомление ему не нужно.
pub(crate) fn push_suppressed_for(state: &AppState, username: &str, device_id: Option<&str>) -> bool {
    match device_id.map(str::trim).filter(|device| !device.is_empty()) {
        Some(device) => state.push_presence.iter().any(|entry| {
            entry.username == username
                && entry.attended
                && entry.device_id.as_deref() == Some(device)
                && entry.last_inbound.elapsed() <= PRESENCE_FRESH
        }),
        // Подписка, оформленная клиентом до появления device_id: устройство неизвестно, и
        // остаётся прежнее правило. Клиент переподписывается на каждом входе, так что такие
        // строки перезаписываются сами.
        None => state
            .user_connections
            .get(username)
            .map(|conns| conns.iter().any(|conn| !conn.is_closed()))
            .unwrap_or(false),
    }
}

/// Содержимое пуша. Текста сообщения здесь нет и быть не может — переписка сквозная.
///
/// Заголовок и `tag` совпадают с локальным уведомлением вкладки (`showBrowserNotification`
/// в web/src/interface/notifications.js): общий tag склеивает их в одно уведомление, а
/// `messageId` в `data` не даёт ему прозвучать дважды.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PushNotification {
    title: String,
    body: String,
    tag: String,
    data: serde_json::Value,
}

impl PushNotification {
    pub(crate) fn direct_message(sender: &str, message_id: &str) -> Self {
        Self {
            title: sender.to_string(),
            body: "Новое сообщение".to_string(),
            tag: format!("zali:dm:{}", sender),
            data: serde_json::json!({
                "sender": sender,
                "serverId": null,
                "channelId": null,
                "messageId": message_id,
            }),
        }
    }

    pub(crate) fn channel_message(
        sender: &str,
        server_id: &str,
        channel_id: &str,
        message_id: &str,
    ) -> Self {
        Self {
            title: format!("{} в канале", sender),
            body: "Новое сообщение".to_string(),
            tag: format!("zali:{}:{}", server_id, channel_id),
            data: serde_json::json!({
                "sender": sender,
                "serverId": server_id,
                "channelId": channel_id,
                "messageId": message_id,
            }),
        }
    }
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
    headers: HeaderMap,
    Json(body): Json<PushSubscriptionRequest>,
) -> impl IntoResponse {
    if state.config.vapid_private_key.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let endpoint = body.endpoint.trim();
    if endpoint.is_empty() || body.keys.p256dh.trim().is_empty() || body.keys.auth.trim().is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let device_id = header_device_id(&headers).or_else(|| {
        body.device_id
            .as_deref()
            .map(str::trim)
            .filter(|device| !device.is_empty())
            .map(str::to_string)
    });

    let id = Uuid::new_v4().to_string();
    let result = sqlx::query(
        "INSERT INTO push_subscriptions (id, username, endpoint, p256dh, auth, device_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
            username = excluded.username,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            device_id = excluded.device_id",
    )
    .bind(&id)
    .bind(&username)
    .bind(endpoint)
    .bind(body.keys.p256dh.trim())
    .bind(body.keys.auth.trim())
    .bind(device_id.as_deref())
    .execute(&state.db)
    .await;

    match result {
        Ok(_) => {
            info!(
                "Push subscription сохранена username={} device={}",
                username,
                device_id.as_deref().unwrap_or("-")
            );
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

#[derive(Debug, Clone)]
pub(crate) struct PushTarget {
    pub(crate) id: String,
    endpoint: String,
    p256dh: String,
    auth: String,
}

/// Подписки `username`, в которые пуш действительно надо слать (см. модульный комментарий).
pub(crate) async fn push_targets_for(
    state: &Arc<AppState>,
    username: &str,
) -> Result<Vec<PushTarget>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT id, endpoint, p256dh, auth, device_id FROM push_subscriptions WHERE username = ?",
    )
    .bind(username)
    .fetch_all(&state.db)
    .await?;

    Ok(rows
        .into_iter()
        .filter(|(id, _, _, _, device_id)| {
            let suppressed = push_suppressed_for(state, username, device_id.as_deref());
            if suppressed {
                info!(
                    "Push пропущен: пользователь смотрит в приложение username={} id={}",
                    username, id
                );
            }
            !suppressed
        })
        .map(|(id, endpoint, p256dh, auth, _)| PushTarget {
            id,
            endpoint,
            p256dh,
            auth,
        })
        .collect())
}

/// Sends `notification` to every subscription of `username` that should get it
/// (`push_targets_for`). No-ops silently if Web Push isn't configured. Expired
/// subscriptions (404/410 from the push service) are pruned as they're discovered.
pub(crate) async fn send_web_push(
    state: &Arc<AppState>,
    username: &str,
    notification: &PushNotification,
) {
    let Some(private_key) = state.config.vapid_private_key.as_deref() else {
        return;
    };

    let targets = match push_targets_for(state, username).await {
        Ok(targets) => targets,
        Err(e) => {
            warn!("Ошибка чтения push subscriptions username={}: {}", username, e);
            return;
        }
    };
    if targets.is_empty() {
        return;
    }

    let payload = match serde_json::to_string(notification) {
        Ok(payload) => payload,
        Err(e) => {
            warn!("Ошибка сериализации push username={}: {}", username, e);
            return;
        }
    };
    let http_client = reqwest::Client::new();

    for PushTarget {
        id,
        endpoint,
        p256dh,
        auth,
    } in targets
    {
        let subscription_info = SubscriptionInfo {
            endpoint: endpoint.clone(),
            keys: SubscriptionKeys { p256dh, auth },
        };

        let message = (|| -> Result<web_push::WebPushMessage, web_push::WebPushError> {
            let mut sig_builder = VapidSignatureBuilder::from_base64_no_sub(private_key)?
                .add_sub_info(&subscription_info);
            sig_builder.add_claim("sub", state.config.vapid_subject.as_str());
            let signature = sig_builder.build()?;

            let mut builder = WebPushMessageBuilder::new(&subscription_info);
            builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
            builder.set_vapid_signature(signature);
            // High: сообщение мессенджера ждут сейчас. С Normal пуш-сервисы на телефоне
            // вправе придержать доставку до выхода устройства из энергосбережения.
            builder.set_urgency(Urgency::High);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_app_state, Config};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    async fn test_state() -> Arc<AppState> {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "zali-push-presence-test-{}-{}",
            std::process::id(),
            n
        ));
        build_app_state(dir, Config::from_env()).await
    }

    async fn subscribe(state: &Arc<AppState>, id: &str, username: &str, device: Option<&str>) {
        sqlx::query(
            "INSERT INTO push_subscriptions (id, username, endpoint, p256dh, auth, device_id)
             VALUES (?, ?, ?, 'p256dh', 'auth', ?)",
        )
        .bind(id)
        .bind(username)
        .bind(format!("https://push.example/{}", id))
        .bind(device)
        .execute(&state.db)
        .await
        .expect("insert subscription");
    }

    async fn target_ids(state: &Arc<AppState>, username: &str) -> Vec<String> {
        let mut ids: Vec<String> = push_targets_for(state, username)
            .await
            .expect("targets")
            .into_iter()
            .map(|target| target.id)
            .collect();
        ids.sort();
        ids
    }

    fn attend(state: &Arc<AppState>, username: &str, device: &str, attended: bool) -> u64 {
        let id = register_connection_presence(state, username);
        update_connection_presence(state, id, attended, Some(device));
        id
    }

    #[tokio::test]
    async fn the_device_being_looked_at_gets_no_push_but_the_users_other_devices_do() {
        let state = test_state().await;
        subscribe(&state, "laptop", "alice", Some("dev-laptop")).await;
        subscribe(&state, "phone", "alice", Some("dev-phone")).await;
        attend(&state, "alice", "dev-laptop", true);

        assert_eq!(target_ids(&state, "alice").await, vec!["phone".to_string()]);
    }

    #[tokio::test]
    async fn a_live_tab_that_is_not_being_looked_at_still_gets_the_push() {
        let state = test_state().await;
        subscribe(&state, "phone", "alice", Some("dev-phone")).await;
        // Вкладка в фоне: сокет жив, JS может быть заморожен — локально она не покажет ничего.
        attend(&state, "alice", "dev-phone", false);

        assert_eq!(target_ids(&state, "alice").await, vec!["phone".to_string()]);
    }

    #[tokio::test]
    async fn an_attended_mark_the_socket_stopped_confirming_does_not_silence_the_device() {
        let state = test_state().await;
        subscribe(&state, "phone", "alice", Some("dev-phone")).await;
        let connection = attend(&state, "alice", "dev-phone", true);
        assert!(target_ids(&state, "alice").await.is_empty());

        // Полуоткрытый сокет: ни одного входящего кадра дольше PRESENCE_FRESH.
        let stale = Instant::now()
            .checked_sub(PRESENCE_FRESH * 2)
            .expect("monotonic clock is past two freshness windows");
        state.push_presence.get_mut(&connection).expect("presence").last_inbound = stale;

        assert_eq!(target_ids(&state, "alice").await, vec!["phone".to_string()]);
    }

    #[tokio::test]
    async fn an_open_native_app_does_not_silence_the_browser_subscriptions() {
        let state = test_state().await;
        subscribe(&state, "phone", "alice", Some("dev-phone")).await;
        // Приложение на Mac: живое WS-соединение без client_presence.
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        state.user_connections.entry("alice".to_string()).or_default().push(tx);
        register_connection_presence(&state, "alice");

        assert_eq!(target_ids(&state, "alice").await, vec!["phone".to_string()]);
    }

    #[tokio::test]
    async fn another_account_looking_at_the_same_device_does_not_silence_this_one() {
        let state = test_state().await;
        subscribe(&state, "laptop", "alice", Some("dev-laptop")).await;
        attend(&state, "bob", "dev-laptop", true);

        assert_eq!(target_ids(&state, "alice").await, vec!["laptop".to_string()]);
    }

    #[tokio::test]
    async fn closing_the_socket_forgets_that_the_device_was_being_looked_at() {
        let state = test_state().await;
        subscribe(&state, "laptop", "alice", Some("dev-laptop")).await;
        let connection = attend(&state, "alice", "dev-laptop", true);
        assert!(target_ids(&state, "alice").await.is_empty());

        remove_connection_presence(&state, connection);

        assert_eq!(target_ids(&state, "alice").await, vec!["laptop".to_string()]);
    }

    #[tokio::test]
    async fn a_subscription_without_a_device_keeps_the_old_any_connection_rule() {
        let state = test_state().await;
        subscribe(&state, "legacy", "alice", None).await;
        assert_eq!(target_ids(&state, "alice").await, vec!["legacy".to_string()]);

        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        state.user_connections.entry("alice".to_string()).or_default().push(tx);

        assert!(target_ids(&state, "alice").await.is_empty());
    }

    #[test]
    fn the_push_carries_the_same_tag_as_the_tabs_own_notification() {
        let dm = PushNotification::direct_message("alice", "m1");
        assert_eq!(dm.tag, "zali:dm:alice");
        assert_eq!(dm.title, "alice");
        assert_eq!(dm.data["messageId"], "m1");

        let channel = PushNotification::channel_message("alice", "s1", "c1", "m2");
        assert_eq!(channel.tag, "zali:s1:c1");
        assert_eq!(channel.title, "alice в канале");
        assert_eq!(channel.data["channelId"], "c1");
    }
}
