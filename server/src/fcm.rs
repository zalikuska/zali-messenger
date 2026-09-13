//! Firebase Cloud Messaging (HTTP v1) для нативного Android-приложения.
//!
//! Браузер/PWA получают Web Push (push.rs). Нативному Android-приложению Web Push
//! недоступен: вебвью не даёт ему пуш-подписку, и без FCM уведомление приходило только
//! пока жив процесс с WebSocket — то есть почти никогда, если телефон в кармане.
//!
//! **Что уходит.** Data-сообщение без текста: переписка сквозная, текста у сервера нет.
//! Отправитель, переписка, id сообщения и получатель. Приложение по нему скачивает
//! архив, расшифровывает его ключами с устройства и показывает настоящий текст
//! (apps/android/.../PushMessagingService.kt); не смогло — «Новое сообщение».
//!
//! **Кому.** То же решение по устройству, что у Web Push (`push_suppressed_for`):
//! токен хранит device_id, приложение сообщает по своему WebSocket, на экране ли оно.
//!
//! **Включение.** Путь к JSON-ключу сервисного аккаунта в `FCM_SERVICE_ACCOUNT_FILE`.
//! Не задан — `/api/push/fcm/register` отвечает 404, `send_fcm_push` ничего не делает.

use crate::{header_device_id, push_suppressed_for, AppState, AuthenticatedUser, PushNotification};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use jwt_simple::prelude::{Claims, Duration as JwtDuration, RS256KeyPair, RSAKeyPairLike};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::{info, warn};

const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

/// Нужная часть JSON-ключа сервисного аккаунта Firebase.
///
/// Debug написан руками: `private_key` — секрет, и выводить его в лог нельзя ни при
/// каком `{:?}`.
#[derive(Clone, Deserialize)]
pub(crate) struct FcmServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

fn default_token_uri() -> String {
    DEFAULT_TOKEN_URI.to_string()
}

impl std::fmt::Debug for FcmServiceAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FcmServiceAccount")
            .field("project_id", &self.project_id)
            .field("client_email", &self.client_email)
            .finish_non_exhaustive()
    }
}

pub(crate) fn load_fcm_service_account() -> Option<FcmServiceAccount> {
    let path = std::env::var("FCM_SERVICE_ACCOUNT_FILE").ok()?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) => {
            warn!("⚠️  FCM_SERVICE_ACCOUNT_FILE={} не читается: {} — FCM отключён", path, e);
            return None;
        }
    };
    let account: FcmServiceAccount = match serde_json::from_str(&raw) {
        Ok(account) => account,
        Err(e) => {
            warn!(
                "⚠️  FCM_SERVICE_ACCOUNT_FILE={} — не JSON-ключ сервисного аккаунта: {} — FCM отключён",
                path, e
            );
            return None;
        }
    };
    if let Err(e) = rsa_signing_key(&account.private_key) {
        warn!("⚠️  FCM: приватный ключ сервисного аккаунта не читается: {} — FCM отключён", e);
        return None;
    }
    Some(account)
}

/// Google отдаёт ключ в PKCS#8 («BEGIN PRIVATE KEY»). Если бэкенд jwt-simple его не
/// примет, ключ перекладывается в PKCS#1 через openssl, который у сервера уже есть.
fn rsa_signing_key(pem: &str) -> Result<RS256KeyPair, String> {
    if let Ok(key) = RS256KeyPair::from_pem(pem) {
        return Ok(key);
    }
    let pkey = openssl::pkey::PKey::private_key_from_pem(pem.as_bytes()).map_err(|e| e.to_string())?;
    let rsa = pkey.rsa().map_err(|e| e.to_string())?;
    let pkcs1 = rsa.private_key_to_pem().map_err(|e| e.to_string())?;
    let pkcs1 = String::from_utf8(pkcs1).map_err(|e| e.to_string())?;
    RS256KeyPair::from_pem(&pkcs1).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize)]
struct ScopeClaim {
    scope: String,
}

/// JWT-assertion для обмена на OAuth-токен (RFC 7523, «service account» у Google).
fn build_oauth_assertion(account: &FcmServiceAccount) -> Result<String, String> {
    let key = rsa_signing_key(&account.private_key)?;
    let mut claims = Claims::with_custom_claims(
        ScopeClaim {
            scope: FCM_SCOPE.to_string(),
        },
        JwtDuration::from_mins(60),
    )
    .with_issuer(&account.client_email)
    .with_audience(&account.token_uri);
    // Google ждёт iss/scope/aud/iat/exp; nbf, который jwt-simple ставит сам, не нужен.
    claims.invalid_before = None;
    key.sign(claims).map_err(|e| e.to_string())
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// OAuth-токен живёт час; без кэша каждое сообщение платило бы лишний запрос к Google.
static ACCESS_TOKEN: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();

async fn access_token(account: &FcmServiceAccount) -> Result<String, String> {
    let cache = ACCESS_TOKEN.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().await;
    if let Some((token, valid_until)) = guard.as_ref() {
        if Instant::now() < *valid_until {
            return Ok(token.clone());
        }
    }

    let assertion = build_oauth_assertion(account)?;
    // JWT состоит из base64url и точек — экранировать в теле формы нечего.
    let body = format!(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={}",
        assertion
    );
    let response = http_client()
        .post(&account.token_uri)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let snippet: String = String::from_utf8_lossy(&bytes).chars().take(300).collect();
        return Err(format!("status={} body={}", status, snippet));
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        #[serde(default)]
        expires_in: u64,
    }
    let parsed: TokenResponse = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let lifetime = parsed.expires_in.max(120);
    *guard = Some((
        parsed.access_token.clone(),
        Instant::now() + Duration::from_secs(lifetime - 60),
    ));
    Ok(parsed.access_token)
}

async fn forget_access_token() {
    if let Some(cache) = ACCESS_TOKEN.get() {
        *cache.lock().await = None;
    }
}

/// Токен, в который слать больше нечего: приложение удалено, данные стёрты, токен
/// перевыпущен или принадлежит другому проекту. Временные ошибки (429, 5xx) и ошибки
/// самого запроса сюда не относятся — за них токен удалять нельзя.
fn fcm_token_is_dead(status: u16, body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    match status {
        404 => true,
        400 => lower.contains("unregistered") || lower.contains("registration token"),
        403 => lower.contains("sender_id_mismatch"),
        _ => false,
    }
}

/// Один токен на устройство аккаунта. Firebase перевыпускает токены, и прежний иначе
/// получал бы пуши, пока FCM не объявит его мёртвым. Токен, уже записанный на другой
/// аккаунт, переходит к новому: это тот же телефон, в который вошли под другим именем.
pub(crate) async fn upsert_fcm_token(
    state: &Arc<AppState>,
    username: &str,
    device_id: &str,
    token: &str,
) -> Result<(), sqlx::Error> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO fcm_tokens (token, username, device_id)
         VALUES (?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET
            username = excluded.username,
            device_id = excluded.device_id,
            updated_at = CURRENT_TIMESTAMP",
    )
    .bind(token)
    .bind(username)
    .bind(device_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM fcm_tokens WHERE username = ? AND device_id = ? AND token != ?")
        .bind(username)
        .bind(device_id)
        .bind(token)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// Токены `username`, в которые пуш действительно надо слать.
pub(crate) async fn fcm_targets_for(
    state: &Arc<AppState>,
    username: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT token, device_id FROM fcm_tokens WHERE username = ?",
    )
    .bind(username)
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, device_id)| !push_suppressed_for(state, username, Some(device_id)))
        .map(|(token, _)| token)
        .collect())
}

#[derive(Debug, Deserialize)]
pub(crate) struct FcmRegisterRequest {
    token: String,
    #[serde(rename = "deviceId", default)]
    device_id: Option<String>,
}

pub(crate) async fn register_fcm_token(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<FcmRegisterRequest>,
) -> impl IntoResponse {
    if state.config.fcm_service_account.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let token = body.token.trim();
    if token.is_empty() || token.len() > 4096 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // Без устройства токен нельзя сопоставить с присутствием — такой пуш глушился бы
    // по старому правилу «есть ли у пользователя хоть один сокет».
    let Some(device_id) = header_device_id(&headers).or_else(|| {
        body.device_id
            .as_deref()
            .map(str::trim)
            .filter(|device| !device.is_empty())
            .map(str::to_string)
    }) else {
        return StatusCode::BAD_REQUEST.into_response();
    };

    match upsert_fcm_token(&state, &username, &device_id, token).await {
        Ok(()) => {
            info!("FCM-токен сохранён username={} device={}", username, device_id);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            warn!("Ошибка сохранения FCM-токена username={}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Выход из аккаунта на устройстве: иначе телефон продолжал бы получать пуши ушедшего
/// аккаунта (web/src/interface/web_push.js, unregisterNativePushDevice).
pub(crate) async fn unregister_push_device(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let Some(device_id) = header_device_id(&headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match sqlx::query("DELETE FROM fcm_tokens WHERE username = ? AND device_id = ?")
        .bind(&username)
        .bind(&device_id)
        .execute(&state.db)
        .await
    {
        Ok(result) => {
            info!(
                "Устройство снято с пушей username={} device={} tokens={}",
                username,
                device_id,
                result.rows_affected()
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            warn!("Ошибка снятия устройства с пушей username={}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn send_fcm_push(
    state: &Arc<AppState>,
    username: &str,
    notification: &PushNotification,
) {
    let Some(account) = state.config.fcm_service_account.as_ref() else {
        return;
    };
    let targets = match fcm_targets_for(state, username).await {
        Ok(targets) => targets,
        Err(e) => {
            warn!("Ошибка чтения FCM-токенов username={}: {}", username, e);
            return;
        }
    };
    if targets.is_empty() {
        return;
    }
    let access = match access_token(account).await {
        Ok(token) => token,
        Err(e) => {
            warn!("FCM: не удалось получить OAuth-токен: {}", e);
            return;
        }
    };
    let url = format!(
        "https://fcm.googleapis.com/v1/projects/{}/messages:send",
        account.project_id
    );
    let data = serde_json::Value::Object(notification.native_data(username));

    for token in targets {
        let body = serde_json::json!({
            "message": {
                "token": token,
                "data": data.clone(),
                // high: только так FCM будит приложение в Doze сразу, а не в следующее
                // окно обслуживания.
                "android": { "priority": "high", "ttl": "3600s" },
            }
        });
        let response = http_client()
            .post(&url)
            .bearer_auth(&access)
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                info!("FCM отправлен username={}", username);
            }
            Ok(response) => {
                let status = response.status().as_u16();
                let text = response.text().await.unwrap_or_default();
                if fcm_token_is_dead(status, &text) {
                    info!("FCM-токен недействителен, удаляю username={}", username);
                    sqlx::query("DELETE FROM fcm_tokens WHERE token = ?")
                        .bind(&token)
                        .execute(&state.db)
                        .await
                        .ok();
                } else {
                    if status == 401 {
                        forget_access_token().await;
                    }
                    let snippet: String = text.chars().take(300).collect();
                    warn!(
                        "FCM отправка неуспешна username={} status={} body={}",
                        username, status, snippet
                    );
                }
            }
            Err(e) => {
                warn!("FCM отправка не удалась username={}: {}", username, e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_app_state, register_connection_presence, update_connection_presence, Config};
    use base64::Engine;
    use jwt_simple::prelude::RSAPublicKeyLike;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    async fn test_state() -> Arc<AppState> {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "zali-fcm-test-{}-{}",
            std::process::id(),
            n
        ));
        build_app_state(dir, Config::from_env()).await
    }

    /// Ключ в той же форме, в какой его отдаёт консоль Firebase: PKCS#8 PEM.
    fn test_account() -> FcmServiceAccount {
        let rsa = openssl::rsa::Rsa::generate(2048).expect("rsa");
        let pkey = openssl::pkey::PKey::from_rsa(rsa).expect("pkey");
        FcmServiceAccount {
            project_id: "zali-test".to_string(),
            client_email: "fcm@zali-test.iam.gserviceaccount.com".to_string(),
            private_key: String::from_utf8(pkey.private_key_to_pem_pkcs8().expect("pem")).expect("utf8"),
            token_uri: DEFAULT_TOKEN_URI.to_string(),
        }
    }

    #[test]
    fn the_oauth_assertion_is_signed_by_the_service_account_and_scoped_to_fcm() {
        let account = test_account();
        let assertion = build_oauth_assertion(&account).expect("assertion");

        let key = rsa_signing_key(&account.private_key).expect("key");
        let claims = key
            .public_key()
            .verify_token::<ScopeClaim>(&assertion, None)
            .expect("the assertion verifies with the account's public key");
        assert_eq!(claims.issuer.as_deref(), Some(account.client_email.as_str()));
        assert_eq!(claims.custom.scope, FCM_SCOPE);

        let payload = assertion.split('.').nth(1).expect("payload");
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .expect("base64url");
        let json: serde_json::Value = serde_json::from_slice(&decoded).expect("json");
        assert_eq!(json["aud"], DEFAULT_TOKEN_URI);
        assert!(json.get("iat").is_some() && json.get("exp").is_some());
        assert!(json.get("nbf").is_none(), "Google does not expect nbf: {}", json);
    }

    #[test]
    fn the_service_account_key_never_reaches_debug_output() {
        let account = test_account();
        let printed = format!("{:?}", account);
        assert!(!printed.contains("PRIVATE KEY"), "{}", printed);
        assert!(printed.contains("zali-test"));
    }

    #[test]
    fn dead_tokens_are_recognised_and_transient_errors_are_not() {
        assert!(fcm_token_is_dead(404, r#"{"error":{"status":"NOT_FOUND"}}"#));
        assert!(fcm_token_is_dead(
            400,
            r#"{"error":{"status":"INVALID_ARGUMENT","details":[{"errorCode":"UNREGISTERED"}]}}"#
        ));
        assert!(fcm_token_is_dead(
            400,
            r#"{"error":{"message":"The registration token is not a valid FCM registration token","status":"INVALID_ARGUMENT"}}"#
        ));
        assert!(fcm_token_is_dead(403, r#"{"error":{"details":[{"errorCode":"SENDER_ID_MISMATCH"}]}}"#));

        assert!(!fcm_token_is_dead(400, r#"{"error":{"message":"Invalid JSON payload received","status":"INVALID_ARGUMENT"}}"#));
        assert!(!fcm_token_is_dead(401, r#"{"error":{"status":"UNAUTHENTICATED"}}"#));
        assert!(!fcm_token_is_dead(429, r#"{"error":{"status":"RESOURCE_EXHAUSTED"}}"#));
        assert!(!fcm_token_is_dead(503, r#"{"error":{"status":"UNAVAILABLE"}}"#));
    }

    #[tokio::test]
    async fn a_rotated_token_replaces_the_previous_one_for_that_device() {
        let state = test_state().await;
        upsert_fcm_token(&state, "alice", "dev-phone", "token-old").await.expect("old");
        upsert_fcm_token(&state, "alice", "dev-phone", "token-new").await.expect("new");

        assert_eq!(fcm_targets_for(&state, "alice").await.expect("targets"), vec!["token-new".to_string()]);
    }

    #[tokio::test]
    async fn signing_in_as_another_account_moves_the_token_to_it() {
        let state = test_state().await;
        upsert_fcm_token(&state, "alice", "dev-alice", "token-phone").await.expect("alice");
        upsert_fcm_token(&state, "bob", "dev-bob", "token-phone").await.expect("bob");

        assert!(fcm_targets_for(&state, "alice").await.expect("alice").is_empty());
        assert_eq!(fcm_targets_for(&state, "bob").await.expect("bob"), vec!["token-phone".to_string()]);
    }

    #[tokio::test]
    async fn the_android_device_in_hand_gets_no_push_but_the_users_other_device_does() {
        let state = test_state().await;
        upsert_fcm_token(&state, "alice", "dev-phone", "token-phone").await.expect("phone");
        upsert_fcm_token(&state, "alice", "dev-tablet", "token-tablet").await.expect("tablet");
        let connection = register_connection_presence(&state, "alice");
        update_connection_presence(&state, connection, true, Some("dev-phone"));

        assert_eq!(fcm_targets_for(&state, "alice").await.expect("targets"), vec!["token-tablet".to_string()]);
    }

    #[test]
    fn the_data_message_carries_only_strings_and_names_the_recipient() {
        let data = PushNotification::direct_message("alice", "m1").native_data("bob");
        assert!(data.values().all(|value| value.is_string()), "{:?}", data);
        assert_eq!(data["recipient"], "bob");
        assert_eq!(data["sender"], "alice");
        assert_eq!(data["messageId"], "m1");
        assert_eq!(data["serverId"], "");
        assert_eq!(data["tag"], "zali:dm:alice");

        let channel = PushNotification::channel_message("alice", "s1", "c1", "m2").native_data("bob");
        assert_eq!(channel["serverId"], "s1");
        assert_eq!(channel["channelId"], "c1");
    }
}
