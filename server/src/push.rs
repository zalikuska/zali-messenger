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
//!
//! Поверх этого — маршрут по активности (device_activity.rs): если человек что-то делал
//! на каком-то из устройств меньше двух минут назад, пуш уходит только на такие
//! устройства; бездельничают все — на все.

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
    /// Во что играет пользователь на этом соединении (activity.rs). Не про пуши —
    /// лежит здесь, потому что это единственная запись «что известно о живом сокете»
    /// и она уже создаётся и удаляется вместе с ним.
    pub(crate) activity: Option<crate::activity::ConnectionActivity>,
    /// Переписка, открытая сейчас на экране этого соединения перед глазами человека
    /// (`client_view`): `dm:<собеседник>` или `<сервер>:<канал>` — то же, что `tag`
    /// уведомления без `zali:`. По ней не звенит ни одно устройство (device_activity.rs).
    pub(crate) viewing: Option<String>,
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
            activity: None,
            viewing: None,
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
    let (username, device) = {
        let Some(mut entry) = state.push_presence.get_mut(&connection_id) else {
            return;
        };
        entry.attended = attended;
        entry.last_inbound = Instant::now();
        if let Some(device) = device_id.map(str::trim).filter(|device| !device.is_empty()) {
            entry.device_id = Some(device.to_string());
        }
        (entry.username.clone(), entry.device_id.clone())
    };
    // Устройство ушло с экрана (Android onStop шлёт это из натива): открытая на нём
    // переписка больше не «перед глазами», даже если вебвью замёрз раньше, чем успел
    // сказать это сам по своему сокету.
    if !attended {
        if let Some(device) = device {
            for mut entry in state.push_presence.iter_mut() {
                if entry.username == username && entry.device_id.as_deref() == Some(device.as_str()) {
                    entry.viewing = None;
                }
            }
        }
    }
}

/// `client_view`: какая переписка открыта на экране соединения, если на него смотрят.
pub(crate) fn update_connection_view(state: &AppState, connection_id: u64, conversation: Option<&str>) {
    if let Some(mut entry) = state.push_presence.get_mut(&connection_id) {
        entry.last_inbound = Instant::now();
        entry.viewing = conversation
            .map(str::trim)
            .filter(|key| !key.is_empty() && key.len() <= 512)
            .map(str::to_string);
    }
}

/// Устройство соединения, известное из заголовка `X-Zali-Device-ID` апгрейда WS
/// (нативные оболочки). Браузер заголовков к WS не добавляет и называет устройство
/// сам — в `client_presence`/`client_idle`.
pub(crate) fn set_connection_device(state: &AppState, connection_id: u64, device_id: Option<&str>) {
    let Some(device) = device_id.map(str::trim).filter(|device| !device.is_empty()) else {
        return;
    };
    if let Some(mut entry) = state.push_presence.get_mut(&connection_id) {
        entry.device_id = Some(device.to_string());
    }
}

/// Устройство, от имени которого говорит соединение.
pub(crate) fn connection_device(state: &AppState, connection_id: u64) -> Option<String> {
    state.push_presence.get(&connection_id).and_then(|entry| entry.device_id.clone())
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
    /// Показать, но без звука и вибрации (режим «в игре», focus.rs). Service
    /// worker передаёт это в `showNotification({silent})`, Android — в канал.
    silent: bool,
    /// Зашифрованный архив сообщения (base64), если он маленький, — только для FCM, см.
    /// `with_inline_archive`. В Web Push не сериализуется: service worker сообщения не
    /// расшифровывает, а лимит пуш-сервиса на тело тот же ~4 КБ.
    #[serde(skip)]
    inline_archive: Option<Arc<str>>,
}

/// Потолок FCM на `data` целиком (ключи + значения) — 4096 байт; запас на служебное.
const FCM_DATA_MAX_BYTES: usize = 3900;

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
            silent: false,
            inline_archive: None,
        }
    }

    /// Архив сообщения едет в самом FCM-пуше, если влезает в его лимит.
    ///
    /// Без него телефон, получив пуш, отдельно скачивал архив (`GET /api/download/:id`)
    /// по холодному соединению из фона — это и было главной задержкой уведомления на
    /// Android, а при плохой сети давало «Новое сообщение» без текста. Медиана архива —
    /// ~300 байт, так что обычный текст влезает.
    ///
    /// **Только для личных сообщений.** Их ключ есть лишь у участников, и Google видит
    /// шифротекст. Ключ канала выводится из id сервера и канала (`deriveServerChannelKey`,
    /// см. скилл zali-ops-open-risks), а они лежат в том же пуше, — архив канала здесь
    /// читался бы кем угодно на пути, включая сам FCM.
    pub(crate) fn with_inline_archive(mut self, archive_base64: Option<String>) -> Self {
        let is_direct = self.data.get("serverId").map_or(true, |value| value.is_null());
        if is_direct {
            self.inline_archive = archive_base64.filter(|value| !value.is_empty()).map(Arc::from);
        }
        self
    }

    /// Переписка уведомления — ключ, которым клиент называет открытый чат (`client_view`).
    pub(crate) fn conversation(&self) -> String {
        self.tag.strip_prefix("zali:").unwrap_or(&self.tag).to_string()
    }

    /// То же уведомление, но без звука.
    pub(crate) fn silenced(mut self) -> Self {
        self.silent = true;
        self
    }

    /// «Всё равно оповестить» (focus.rs): показать, даже если уведомление об этом
    /// сообщении уже висит (тихое), и со звуком. Без метки service worker и
    /// Android считают такой пуш повтором и подавляют его.
    pub(crate) fn forced(mut self) -> Self {
        if let Some(data) = self.data.as_object_mut() {
            data.insert("force".to_string(), serde_json::Value::Bool(true));
        }
        self
    }

    /// The same notification as FCM `data` for the native Android app (fcm.rs): flat
    /// string values only, which is all an FCM data message carries. `recipient` lets the
    /// app drop a push addressed to an account that is no longer signed in on it.
    pub(crate) fn native_data(&self, recipient: &str) -> serde_json::Map<String, serde_json::Value> {
        let field = |name: &str| {
            self.data
                .get(name)
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        };
        let mut data = serde_json::Map::new();
        for (key, value) in [
            ("kind", "message".to_string()),
            ("title", self.title.clone()),
            ("body", self.body.clone()),
            ("tag", self.tag.clone()),
            ("recipient", recipient.to_string()),
            ("sender", field("sender")),
            ("serverId", field("serverId")),
            ("channelId", field("channelId")),
            ("messageId", field("messageId")),
            ("silent", if self.silent { "1" } else { "" }.to_string()),
            (
                "force",
                if self.data.get("force").and_then(|v| v.as_bool()).unwrap_or(false) { "1" } else { "" }
                    .to_string(),
            ),
        ] {
            data.insert(key.to_string(), serde_json::Value::String(value));
        }
        if let Some(archive) = self.inline_archive.as_deref() {
            let used: usize = data
                .iter()
                .map(|(key, value)| key.len() + value.as_str().map_or(0, str::len))
                .sum();
            if used + "inlineArchive".len() + archive.len() <= FCM_DATA_MAX_BYTES {
                data.insert("inlineArchive".to_string(), serde_json::Value::String(archive.to_string()));
            }
        }
        data
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
            silent: false,
            inline_archive: None,
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

const MAX_PUSH_SUBSCRIPTIONS_PER_USER: i64 = 20;

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
    if !is_acceptable_push_endpoint(endpoint) {
        warn!("Push subscription отклонена: endpoint не публичный https username={}", username);
        return (StatusCode::BAD_REQUEST, "Некорректный push endpoint").into_response();
    }
    // Чужую подписку (тот же endpoint) забрать себе можно только с её же ключами:
    // браузер, сменивший аккаунт, присылает тот же p256dh/auth, а знающий лишь
    // endpoint — свои. Раньше ON CONFLICT молча переписывал владельца и ключи.
    match sqlx::query_as::<_, (String, String, String)>(
        "SELECT username, p256dh, auth FROM push_subscriptions WHERE endpoint = ?",
    )
    .bind(endpoint)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some((owner, p256dh, auth)))
            if owner != username
                && (p256dh != body.keys.p256dh.trim() || auth != body.keys.auth.trim()) =>
        {
            warn!("Push subscription отклонена: endpoint принадлежит другому аккаунту username={}", username);
            return StatusCode::CONFLICT.into_response();
        }
        Ok(None) => {
            // Потолок подписок на аккаунт: каждая — исходящий POST на каждое сообщение.
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM push_subscriptions WHERE username = ?")
                .bind(&username)
                .fetch_one(&state.db)
                .await
                .unwrap_or(0);
            if count >= MAX_PUSH_SUBSCRIPTIONS_PER_USER {
                return (StatusCode::TOO_MANY_REQUESTS, "Слишком много push-подписок").into_response();
            }
        }
        Ok(Some(_)) => {}
        Err(e) => {
            tracing::error!("Ошибка чтения push subscription: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
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
    route: &crate::NotifyRoute,
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
            if !route.allows(device_id.as_deref()) {
                info!(
                    "Push пропущен: человек сейчас на другом устройстве username={} id={}",
                    username, id
                );
                return false;
            }
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

/// Один клиент на весь процесс: `Client::new()` на каждый пуш означал новый пул
/// соединений и полное TLS-рукопожатие с пуш-сервисом на каждое сообщение. Таймаут —
/// потому что без него зависший пуш-сервис навсегда держал фоновую задачу рассылки.
/// Редиректы выключены: endpoint проверен, а цель редиректа — нет.
fn web_push_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}

/// Endpoint подписки — URL, на который сервер сам будет слать POST, поэтому он
/// обязан быть публичным https-адресом пуш-сервиса. Раньше годился любой, включая
/// `http://127.0.0.1:3000` (AdGuard на этой же машине) и внутренние адреса: SSRF,
/// срабатывающий на каждое входящее сообщение.
pub(crate) fn is_acceptable_push_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.port().is_some_and(|port| port != 443) {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    // IP-литерал (в т. ч. `[::1]`) — не адрес пуш-сервиса, а прямой путь внутрь сети.
    if host.starts_with('[') || host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    // Только известные пуш-сервисы браузеров. Любой публичный https-адрес делал
    // сервер рефлектором: подписка на `https://жертва/` — POST туда на каждое
    // сообщение аккаунта (аудит 2026-11-18).
    is_known_push_service(&host)
}

/// Хосты пуш-сервисов: Chrome/Edge(Chromium)/Opera/Samsung — FCM, Firefox — Mozilla
/// autopush, Safari — Apple, старый Edge — WNS.
pub(crate) fn is_known_push_service(host: &str) -> bool {
    const EXACT: &[&str] = &["fcm.googleapis.com", "android.googleapis.com"];
    const SUFFIX: &[&str] = &[".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];
    EXACT.contains(&host) || SUFFIX.iter().any(|suffix| host.ends_with(suffix))
}

/// Публичный ли адрес: не частный, не loopback, не link-local, не CGNAT, не
/// документационный и не multicast.
pub(crate) fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
                || o[0] >= 240)
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(mapped));
            }
            let seg = v6.segments();
            let first = seg[0];
            // Адреса, встраивающие IPv4: NAT64 (64:ff9b::/96), 6to4 (2002::/16) и
            // устаревшие IPv4-compatible (::a.b.c.d) — судим по вложенному IPv4.
            if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
                let o = v6.octets();
                return is_public_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::new(o[12], o[13], o[14], o[15])));
            }
            if first == 0x2002 {
                let o = v6.octets();
                return is_public_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::new(o[2], o[3], o[4], o[5])));
            }
            if seg[..6] == [0, 0, 0, 0, 0, 0] && !v6.is_loopback() && !v6.is_unspecified() {
                let o = v6.octets();
                return is_public_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::new(o[12], o[13], o[14], o[15])));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first & 0xffc0) == 0xfec0
                || (first == 0x2001 && seg[1] == 0x0db8))
        }
    }
}

/// Имя endpoint'а резолвится только в публичные адреса. Проверка по имени одна
/// не спасает: домен злоумышленника может указывать на внутренний адрес :443.
/// Окно между проверкой и соединением остаётся, поэтому это второй слой, а не
/// замена `is_acceptable_push_endpoint`.
/// Возвращает имя и проверенный адрес: соединение затем идёт ровно на него
/// (`pinned_push_client`), а не на результат второго резолва — иначе DNS
/// rebinding отвечал «публичный» проверке и «внутренний» соединению.
async fn endpoint_resolves_public(endpoint: &str) -> Option<(String, std::net::SocketAddr)> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    let host = url.host_str()?.to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.ok()?.collect();
    if addrs.is_empty() || addrs.iter().any(|addr| !is_public_ip(addr.ip())) {
        return None;
    }
    Some((host, addrs[0]))
}

/// Клиент, который соединяется только с уже проверенным адресом endpoint'а.
///
/// Переиспользуется для той же пары «имя + проверенный адрес». Раньше клиент
/// создавался на каждый пуш, а с ним и пул: каждое уведомление платило новое TCP+TLS
/// до пуш-сервиса. Защита от DNS rebinding от этого не слабеет: ключ — уже
/// проверенный адрес, соединение по-прежнему идёт ровно на него, а резолв и проверка
/// (`endpoint_resolves_public`) выполняются перед каждым пушем, как и раньше.
fn pinned_push_client(host: &str, addr: std::net::SocketAddr) -> reqwest::Client {
    static CLIENTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<(String, std::net::SocketAddr), reqwest::Client>>> =
        std::sync::OnceLock::new();
    // Пуш-сервисов единицы (FCM, Mozilla, Apple), но адресов у них много — потолок,
    // чтобы карта не росла бесконечно; при переполнении просто начинаем заново.
    const MAX_CACHED_CLIENTS: usize = 64;
    let clients = CLIENTS.get_or_init(Default::default);
    let key = (host.to_ascii_lowercase(), addr);
    if let Ok(cache) = clients.lock() {
        if let Some(client) = cache.get(&key) {
            return client.clone();
        }
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(host, addr)
        .build();
    let Ok(client) = client else {
        return web_push_client();
    };
    if let Ok(mut cache) = clients.lock() {
        if cache.len() >= MAX_CACHED_CLIENTS {
            cache.clear();
        }
        cache.insert(key, client.clone());
    }
    client
}

/// Every push channel of `username`: Web Push subscriptions of their browsers and FCM
/// tokens of their Android devices. Each decides per device on its own, within the
/// activity route (device_activity.rs).
pub(crate) async fn send_push(state: &Arc<AppState>, username: &str, notification: &PushNotification) {
    let route = crate::notify_route_for(state, username, Some(&notification.conversation())).await;
    send_push_routed(state, username, notification, &route).await;
}

/// `send_push` с уже посчитанным маршрутом: доставка по сокету считает его раньше, чтобы
/// клиенты и пуши решали по одному и тому же.
///
/// Web Push и FCM — параллельно. Последовательно FCM ждал, пока отработают все
/// подписки браузеров (на каждую — DNS и HTTP до пуш-сервиса, до 10 с таймаута), и
/// телефон узнавал о сообщении на секунды позже компьютера.
pub(crate) async fn send_push_routed(
    state: &Arc<AppState>,
    username: &str,
    notification: &PushNotification,
    route: &crate::NotifyRoute,
) {
    tokio::join!(
        send_web_push(state, username, notification, route),
        crate::send_fcm_push(state, username, notification, route),
    );
}

/// Sends `notification` to every subscription of `username` that should get it
/// (`push_targets_for`). No-ops silently if Web Push isn't configured. Expired
/// subscriptions (404/410 from the push service) are pruned as they're discovered.
/// Subscriptions are pushed concurrently: one slow push service must not hold up the rest.
pub(crate) async fn send_web_push(
    state: &Arc<AppState>,
    username: &str,
    notification: &PushNotification,
    route: &crate::NotifyRoute,
) {
    if state.config.vapid_private_key.is_none() {
        return;
    }

    let targets = match push_targets_for(state, username, route).await {
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
    send_web_push_payload(state, username, targets, payload, 3600).await;
}

/// Одно тело Web Push на перечисленные подписки, параллельно.
async fn send_web_push_payload(
    state: &Arc<AppState>,
    username: &str,
    targets: Vec<PushTarget>,
    payload: String,
    ttl_secs: u32,
) {
    let payload: Arc<str> = Arc::from(payload);
    let mut sends = tokio::task::JoinSet::new();
    for target in targets {
        let state = Arc::clone(state);
        let username = username.to_string();
        let payload = Arc::clone(&payload);
        sends.spawn(async move { send_one_web_push(&state, &username, &payload, target, ttl_secs).await });
    }
    while sends.join_next().await.is_some() {}
}

// MARK: - Звонки
//
// До этого о входящем звонке знал только открытый WebSocket: телефон в кармане, закрытая
// вкладка, свёрнутое приложение не звонили вовсе, а о пропущенном звонке не узнавали
// никогда. Теперь звонок идёт и пушем — на каждое устройство адресата, на которое никто
// не смотрит (смотрят — звонит само приложение). Маршрут по активности (device_activity.rs)
// здесь не применяется: ответить можно с любого устройства, и звонить должны все.

/// Чем закончился звонок для того, кому звонили.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallPushEnd {
    /// Принят на одном из устройств адресата.
    Answered,
    /// Отклонён адресатом.
    Declined,
    /// Звонивший сдался или вышло время.
    Missed,
}

impl CallPushEnd {
    fn as_str(self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::Declined => "declined",
            Self::Missed => "missed",
        }
    }
}

/// Звонить дольше этого бессмысленно: сервер сам снимает звонок через 60 с (voice.rs).
const CALL_PUSH_TTL_SECS: u32 = 60;
/// «Пропущенный звонок» полезен и через час.
const MISSED_CALL_PUSH_TTL_SECS: u32 = 3600;

fn call_tag(room_id: &str) -> String {
    format!("zali:call:{}", room_id)
}

/// Входящий звонок пушем. `decline_token` позволяет отклонить звонок прямо из
/// уведомления, без сессии (`POST /api/voice/call/decline`): у service worker токена
/// входа нет, а Android-приёмнику кнопки незачем поднимать вебвью.
pub(crate) async fn send_incoming_call_push(
    state: &Arc<AppState>,
    target: &str,
    room_id: &str,
    from: &str,
    decline_token: &str,
) {
    let web = async {
        if state.config.vapid_private_key.is_none() {
            return;
        }
        let targets = match push_targets_for(state, target, &crate::NotifyRoute::All).await {
            Ok(targets) => targets,
            Err(e) => {
                warn!("Ошибка чтения push subscriptions username={}: {}", target, e);
                return;
            }
        };
        if targets.is_empty() {
            return;
        }
        let payload = serde_json::json!({
            "title": "Входящий звонок",
            "body": from,
            "tag": call_tag(room_id),
            "data": {
                "kind": "call",
                "roomId": room_id,
                "from": from,
                "sender": from,
                "declineToken": decline_token,
            },
        });
        send_web_push_payload(state, target, targets, payload.to_string(), CALL_PUSH_TTL_SECS).await;
    };
    let fcm = async {
        let Some(account) = state.config.fcm_service_account.as_ref() else {
            return;
        };
        // Все токены, без фильтра «смотрят в приложение» (`push_suppressed_for`). Для
        // сообщения он верен — оно приходит по тому же сокету, что и присутствие. Звонок —
        // нет: на Android присутствие шлёт нативный сокет, а звонок ждёт сокет вебвью, и
        // они умирают порознь. Телефон с «живым» нативным сокетом и мёртвым сокетом вебвью
        // не звонил вовсе (пуш глушился, а страница о звонке не знала). Двойного звонка
        // нет: приложение на экране само решает, нужен ли ему пуш
        // (PushMessagingService.onIncomingCall → ensureIncomingCallRings).
        let targets = match crate::all_fcm_tokens(state, target).await {
            Ok(targets) => targets,
            Err(e) => {
                warn!("Ошибка чтения FCM-токенов username={}: {}", target, e);
                return;
            }
        };
        let data = serde_json::json!({
            "kind": "call",
            "recipient": target,
            "roomId": room_id,
            "from": from,
            "declineToken": decline_token,
        });
        crate::send_fcm_data(state, account, target, targets, data, CALL_PUSH_TTL_SECS as u64).await;
    };
    tokio::join!(web, fcm);
    info!("[VOICE][PUSH] incoming call push to={} roomId={}", target, room_id);
}

/// Звонок закончился — снять «Входящий звонок» там, куда он ушёл пушем.
///
/// FCM — на все токены адресата, без фильтра «смотрят»: телефон мог зазвонить, а потом
/// его взяли в руки, и уведомление-звонок иначе висело бы и звенело до своего таймаута.
/// Web Push обязан что-то показать (подписка userVisibleOnly), поэтому он заменяет
/// уведомление звонка тем же tag: «Пропущенный звонок» — со звуком, остальное — молча.
pub(crate) async fn send_call_end_push(
    state: &Arc<AppState>,
    target: &str,
    room_id: &str,
    from: &str,
    end: CallPushEnd,
) {
    let ttl = if end == CallPushEnd::Missed { MISSED_CALL_PUSH_TTL_SECS } else { CALL_PUSH_TTL_SECS };
    let web = async {
        if state.config.vapid_private_key.is_none() {
            return;
        }
        let targets = match push_targets_for(state, target, &crate::NotifyRoute::All).await {
            Ok(targets) => targets,
            Err(e) => {
                warn!("Ошибка чтения push subscriptions username={}: {}", target, e);
                return;
            }
        };
        if targets.is_empty() {
            return;
        }
        let (title, silent) = match end {
            CallPushEnd::Missed => ("Пропущенный звонок", false),
            CallPushEnd::Answered => ("Звонок принят на другом устройстве", true),
            CallPushEnd::Declined => ("Звонок отклонён", true),
        };
        let payload = serde_json::json!({
            "title": title,
            "body": from,
            "tag": call_tag(room_id),
            "silent": silent,
            "data": {
                "kind": "call_end",
                "outcome": end.as_str(),
                "roomId": room_id,
                "from": from,
                "sender": from,
            },
        });
        send_web_push_payload(state, target, targets, payload.to_string(), ttl).await;
    };
    let fcm = async {
        let Some(account) = state.config.fcm_service_account.as_ref() else {
            return;
        };
        let targets = match crate::all_fcm_tokens(state, target).await {
            Ok(targets) => targets,
            Err(e) => {
                warn!("Ошибка чтения FCM-токенов username={}: {}", target, e);
                return;
            }
        };
        let data = serde_json::json!({
            "kind": "call_end",
            "recipient": target,
            "roomId": room_id,
            "from": from,
            "outcome": end.as_str(),
        });
        crate::send_fcm_data(state, account, target, targets, data, ttl as u64).await;
    };
    tokio::join!(web, fcm);
    info!("[VOICE][PUSH] call end push to={} roomId={} outcome={}", target, room_id, end.as_str());
}

async fn send_one_web_push(state: &Arc<AppState>, username: &str, payload: &str, target: PushTarget, ttl_secs: u32) {
    let Some(private_key) = state.config.vapid_private_key.as_deref() else {
        return;
    };
    let PushTarget {
        id,
        endpoint,
        p256dh,
        auth,
    } = target;
    if !is_acceptable_push_endpoint(&endpoint) {
        warn!("Push endpoint отклонён (не публичный https) id={}", id);
        return;
    }
    let Some((pinned_host, pinned_addr)) = endpoint_resolves_public(&endpoint).await else {
        warn!("Push endpoint отклонён (резолвится во внутренний адрес или не резолвится) id={}", id);
        return;
    };
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
        builder.set_ttl(ttl_secs);
        builder.build()
    })();

    let message = match message {
        Ok(m) => m,
        Err(e) => {
            warn!("Ошибка сборки web push username={} id={}: {:?}", username, id, e);
            return;
        }
    };

    let http_client = pinned_push_client(&pinned_host, pinned_addr);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_app_state, Config};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn internal_addresses_are_not_public() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.9.9", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "198.18.0.1"] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip} must not be public");
        }
        for ip in ["8.8.8.8", "142.250.74.14", "2606:4700:4700::1111"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip} must be public");
        }
    }

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
        let mut ids: Vec<String> = push_targets_for(state, username, &crate::NotifyRoute::All)
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

    #[tokio::test]
    async fn the_activity_route_keeps_pushes_off_idle_devices() {
        let state = test_state().await;
        subscribe(&state, "laptop", "alice", Some("dev-laptop")).await;
        subscribe(&state, "phone", "alice", Some("dev-phone")).await;
        subscribe(&state, "legacy", "alice", None).await;
        let route = crate::NotifyRoute::Only(["dev-phone".to_string()].into_iter().collect());
        let mut ids: Vec<String> = push_targets_for(&state, "alice", &route)
            .await
            .expect("targets")
            .into_iter()
            .map(|target| target.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["phone".to_string()]);
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
