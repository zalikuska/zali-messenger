//! Authentication: JWT issuing/validation, the AuthenticatedUser extractor,
//! register/login/logout, /me endpoints, WS tickets, and login rate limiting.

use axum::{
    extract::ConnectInfo,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use sqlx::{
    sqlite::SqlitePool, Row,
};
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::task;
use tracing::{error, info, warn};
use uuid::Uuid;
use crate::{
    AppState, AuthPayload, AuthResponse, Claims, CloudVaultSyncPayload, is_valid_username,
    MeResponse, WsTicketRecord, WsTicketResponse,
};

pub(crate) const AUTH_COOKIE_NAME: &str = "zali_auth";
pub(crate) const JWT_ISSUER: &str = "zali-server";
pub(crate) const JWT_AUDIENCE: &str = "zali-messenger";
pub(crate) const DUMMY_BCRYPT_HASH: &str = "$2b$12$C6UzMDM.H6dfI/f/IKcEeOe6uT6yQWQfC1k1j6fQJxE1u3N0EdD6W";
// ============================================================
// AUTH EXTRACTOR
// ============================================================

pub(crate) struct AuthenticatedUser(pub(crate) String);

#[axum::async_trait]
impl axum::extract::FromRequestParts<Arc<AppState>> for AuthenticatedUser {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        async fn validate_token(token: &str, state: &Arc<AppState>) -> Result<String, StatusCode> {
            let validation = jwt_validation();
            let token_data = decode::<Claims>(
                token,
                &DecodingKey::from_secret(&state.config.jwt_secret),
                &validation,
            )
            .map_err(|_| StatusCode::UNAUTHORIZED)?;
            let claims = token_data.claims;
            if claims.iss != JWT_ISSUER || claims.aud != JWT_AUDIENCE {
                return Err(StatusCode::UNAUTHORIZED);
            }
            let token_version =
                sqlx::query_scalar::<_, i64>("SELECT token_version FROM users WHERE username = ?")
                    .bind(&claims.sub)
                    .fetch_optional(&state.db)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                    .ok_or(StatusCode::UNAUTHORIZED)?;
            if token_version != claims.token_version {
                return Err(StatusCode::UNAUTHORIZED);
            }
            Ok(claims.sub)
        }

        // 1. Try Authorization: Bearer <token> header
        if let Some(auth_header) = parts.headers.get("Authorization") {
            if let Ok(auth_str) = auth_header.to_str() {
                if let Some(token) = auth_str.strip_prefix("Bearer ") {
                    match validate_token(token, state).await {
                        Ok(username) => return Ok(AuthenticatedUser(username)),
                        Err(_) => {
                            warn!("Получен невалидный JWT-токен");
                            return Err((StatusCode::UNAUTHORIZED, "Invalid or expired token"));
                        }
                    }
                }
            }
        }

        // 2. Try HttpOnly cookie
        if let Some(cookie_header) = parts.headers.get(header::COOKIE) {
            if let Ok(cookie_str) = cookie_header.to_str() {
                if let Some(token) = cookie_str
                    .split(';')
                    .find_map(|part| part.trim().strip_prefix(&format!("{}=", AUTH_COOKIE_NAME)))
                {
                    match validate_token(token, state).await {
                        Ok(username) => return Ok(AuthenticatedUser(username)),
                        Err(_) => {
                            warn!("Получен невалидный JWT-cookie");
                            return Err((StatusCode::UNAUTHORIZED, "Invalid or expired token"));
                        }
                    }
                }
            }
        }

        if let Some(query) = parts.uri.query() {
            for pair in query.split('&') {
                if let Some((key, value)) = pair.split_once('=') {
                    if key == "ticket" && !value.trim().is_empty() {
                        if let Some(username) = take_valid_ws_ticket(state, value) {
                            return Ok(AuthenticatedUser(username));
                        }
                        warn!("Получен невалидный ws-ticket");
                        return Err((StatusCode::UNAUTHORIZED, "Invalid or expired token"));
                    }
                    if matches!(key, "token" | "auth" | "access_token") && !value.trim().is_empty()
                    {
                        match validate_token(value, state).await {
                            Ok(username) => return Ok(AuthenticatedUser(username)),
                            Err(_) => {
                                warn!("Получен невалидный JWT-token из query");
                                return Err((StatusCode::UNAUTHORIZED, "Invalid or expired token"));
                            }
                        }
                    }
                }
            }
        }

        // 2. Guest fallback only when explicitly enabled
        if state.config.allow_guest_mode {
            return Ok(AuthenticatedUser("Zalikus".to_string()));
        }

        Err((StatusCode::UNAUTHORIZED, "Authentication required"))
    }
}

pub(crate) async fn me(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> impl IntoResponse {
    match load_cloud_vault_sync_enabled(&state.db, &username).await {
        Ok(enabled) => Json(MeResponse {
            username,
            cloud_vault_sync_enabled: enabled,
        })
        .into_response(),
        Err(e) => {
            error!("Ошибка чтения настроек аккаунта {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn update_me(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Json(payload): Json<CloudVaultSyncPayload>,
) -> impl IntoResponse {
    let response_username = username.clone();
    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            error!("Ошибка начала транзакции для {}: {}", username, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Err(e) = sqlx::query("UPDATE users SET cloud_vault_sync_enabled = ? WHERE username = ?")
        .bind(if payload.cloud_vault_sync_enabled {
            1
        } else {
            0
        })
        .bind(&username)
        .execute(&mut *tx)
        .await
    {
        error!(
            "Ошибка обновления cloud_vault_sync_enabled для {}: {}",
            username, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if !payload.cloud_vault_sync_enabled {
        if let Err(e) = sqlx::query("DELETE FROM account_vault_events WHERE owner = ?")
            .bind(&username)
            .execute(&mut *tx)
            .await
        {
            error!("Ошибка очистки vault events для {}: {}", username, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        if let Err(e) = sqlx::query("DELETE FROM history_tickets WHERE owner = ?")
            .bind(&username)
            .execute(&mut *tx)
            .await
        {
            error!("Ошибка очистки history tickets для {}: {}", username, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    if let Err(e) = tx.commit().await {
        error!("Ошибка фиксации update_me для {}: {}", username, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match load_cloud_vault_sync_enabled(&state.db, &username).await {
        Ok(enabled) => Json(MeResponse {
            username: response_username,
            cloud_vault_sync_enabled: enabled,
        })
        .into_response(),
        Err(e) => {
            error!(
                "Ошибка чтения настроек аккаунта {} после обновления: {}",
                username, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn logout(
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    match sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE username = ?")
        .bind(&auth_user)
        .execute(&state.db)
        .await
    {
        Ok(_) => {
            let mut response = StatusCode::NO_CONTENT.into_response();
            let expired_cookie = format!(
                "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
                AUTH_COOKIE_NAME
            );
            if let Ok(value) = HeaderValue::from_str(&expired_cookie) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        Err(e) => {
            error!("Ошибка logout для {}: {}", auth_user, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn hash_password(password: String) -> Result<String, String> {
    task::spawn_blocking(move || bcrypt::hash(password, bcrypt::DEFAULT_COST))
        .await
        .map_err(|e| format!("bcrypt hash task failed: {}", e))?
        .map_err(|e| e.to_string())
}

pub(crate) async fn verify_password(password: String, hash: String) -> Result<bool, String> {
    task::spawn_blocking(move || bcrypt::verify(password, &hash))
        .await
        .map_err(|e| format!("bcrypt verify task failed: {}", e))?
        .map_err(|e| e.to_string())
}

pub(crate) fn issue_auth_response(
    username: String,
    token_version: i64,
    cloud_vault_sync_enabled: bool,
    jwt_secret: &[u8],
) -> Result<AuthResponse, jsonwebtoken::errors::Error> {
    let exp = Utc::now()
        .checked_add_signed(chrono::Duration::days(7))
        .expect("valid timestamp")
        .timestamp() as usize;

    let claims = Claims {
        sub: username.clone(),
        iss: JWT_ISSUER.to_string(),
        aud: JWT_AUDIENCE.to_string(),
        token_version,
        jti: Uuid::new_v4().to_string(),
        exp,
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(jwt_secret),
    )?;

    Ok(AuthResponse {
        token,
        username,
        cloud_vault_sync_enabled,
    })
}

pub(crate) async fn issue_ws_ticket(
    state: &Arc<AppState>,
    username: &str,
) -> Result<WsTicketResponse, StatusCode> {
    let ticket = Uuid::new_v4().to_string();
    let expires_at = Instant::now()
        .checked_add(Duration::from_secs(30))
        .unwrap_or_else(|| Instant::now() + Duration::from_secs(30));
    state.ws_tickets.insert(
        ticket.clone(),
        WsTicketRecord {
            username: username.to_string(),
            expires_at,
        },
    );
    Ok(WsTicketResponse { ticket })
}

pub(crate) async fn create_ws_ticket(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> impl IntoResponse {
    match issue_ws_ticket(&state, &username).await {
        Ok(response) => Json(response).into_response(),
        Err(status) => status.into_response(),
    }
}

pub(crate) fn take_valid_ws_ticket(state: &Arc<AppState>, ticket: &str) -> Option<String> {
    let ticket = ticket.trim();
    if ticket.is_empty() {
        return None;
    }
    let entry = state.ws_tickets.remove(ticket)?;
    let (_, record) = entry;
    if Instant::now() <= record.expires_at {
        Some(record.username)
    } else {
        None
    }
}

pub(crate) async fn load_cloud_vault_sync_enabled(
    pool: &SqlitePool,
    username: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(cloud_vault_sync_enabled, 1) FROM users WHERE username = ? LIMIT 1",
    )
    .bind(username)
    .fetch_one(pool)
    .await
    .map(|value| value != 0)
}

pub(crate) fn jwt_validation() -> Validation {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[JWT_ISSUER]);
    validation.set_audience(&[JWT_AUDIENCE]);
    validation.validate_exp = true;
    validation.sub = None;
    validation
}

pub(crate) fn auth_cookie_value(token: &str, secure: bool) -> Result<HeaderValue, ()> {
    let secure_flag = if secure { "; Secure" } else { "" };
    let cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800{}",
        AUTH_COOKIE_NAME, token, secure_flag
    );
    HeaderValue::from_str(&cookie).map_err(|_| ())
}

pub(crate) fn auth_response_with_cookie_and_secure(
    status: StatusCode,
    auth: AuthResponse,
    secure: bool,
) -> axum::response::Response {
    let mut response = (status, Json(auth.clone())).into_response();
    if let Ok(value) = auth_cookie_value(&auth.token, secure) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

pub(crate) async fn register(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<AuthPayload>,
) -> impl IntoResponse {
    // --- Rate limiting by IP ---
    let client_ip = extract_client_ip(remote_addr, &headers);
    let reg_rate_key = format!("reg:{}", client_ip);
    let window = Duration::from_secs(state.config.rate_limit_window_secs);
    let max_attempts = state.config.rate_limit_max_attempts;
    let now = Instant::now();
    {
        let mut attempts = state.login_attempts.entry(reg_rate_key).or_default();
        attempts.retain(|t| now.duration_since(*t) < window);
        if attempts.len() >= max_attempts {
            warn!("Rate limit exceeded при регистрации ip={}", client_ip);
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "Слишком много попыток регистрации. Повторите позже.",
            )
                .into_response();
        }
        attempts.push_back(now);
    }

    info!(
        "Попытка регистрации: username='{}', password_len={}",
        payload.username,
        payload.password.len()
    );

    if payload.username.trim().is_empty() || payload.password.is_empty() {
        warn!("Регистрация отклонена: пустой логин или пароль");
        return (
            StatusCode::BAD_REQUEST,
            "Логин и пароль не могут быть пустыми",
        )
            .into_response();
    }

    let username = payload.username.trim();
    if username.len() < 3 || username.len() > 32 {
        warn!(
            "Регистрация отклонена: username '{}' слишком длинный ({} символов)",
            username,
            username.len()
        );
        return (
            StatusCode::BAD_REQUEST,
            "Логин должен быть длиной от 3 до 32 символов",
        )
            .into_response();
    }

    if !is_valid_username(username) {
        warn!(
            "Регистрация отклонена: username '{}' не прошёл валидацию",
            username
        );
        return (
            StatusCode::BAD_REQUEST,
            "Логин может содержать только латинские буквы, цифры, _ и -",
        )
            .into_response();
    }

    if payload.password.len() < 6 {
        warn!(
            "Регистрация отклонена: username '{}' использует слишком короткий пароль ({} символов)",
            username,
            payload.password.len()
        );
        return (
            StatusCode::BAD_REQUEST,
            "Пароль должен быть не менее 6 символов",
        )
            .into_response();
    }

    if payload.password.len() > 72 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Пароль не должен превышать 72 символа"})),
        )
            .into_response();
    }

    info!("Хэширование пароля для нового пользователя '{}'", username);
    let hashed = match hash_password(payload.password.clone()).await {
        Ok(h) => h,
        Err(e) => {
            error!("Ошибка хэширования пароля: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    match sqlx::query("INSERT INTO users (username, password_hash) VALUES (?, ?)")
        .bind(username)
        .bind(&hashed)
        .execute(&state.db)
        .await
    {
        Ok(_) => {
            info!(
                "Регистрация успешно завершена для пользователя '{}'",
                username
            );
            match issue_auth_response(username.to_string(), 0, true, &state.config.jwt_secret) {
                Ok(auth) => auth_response_with_cookie_and_secure(
                    StatusCode::CREATED,
                    auth,
                    state.config.auth_cookie_secure,
                ),
                Err(e) => {
                    error!("Ошибка генерации JWT после регистрации: {}", e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        Err(e) => {
            warn!(
                "Регистрация не удалась для '{}': пользователь уже существует или БД вернула ошибку: {}",
                username,
                e
            );
            (StatusCode::CONFLICT, "Пользователь уже существует").into_response()
        }
    }
}

pub(crate) async fn login(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<AuthPayload>,
) -> impl IntoResponse {
    // --- Rate limiting ---
    let client_ip = extract_client_ip(remote_addr, &headers);
    let rate_key = login_rate_key(client_ip, &payload.username);
    let window = Duration::from_secs(state.config.rate_limit_window_secs);
    let max_attempts = state.config.rate_limit_max_attempts;
    let now = Instant::now();
    // Sweeping every key in the map on every single login request is pure overhead —
    // the per-key retain() just below already keeps this request's own rate-limit
    // check correct regardless. The full sweep only exists to bound memory (drop
    // stale IP/username keys nobody has hit in a while), so it only needs to run
    // occasionally, not on every request.
    {
        let mut last_swept = state.login_attempts_last_swept.lock().unwrap();
        if now.duration_since(*last_swept) >= window {
            state.login_attempts.retain(|_, attempts| {
                attempts.retain(|t| now.duration_since(*t) < window);
                !attempts.is_empty()
            });
            *last_swept = now;
        }
    }

    {
        let mut attempts = state.login_attempts.entry(rate_key.clone()).or_default();
        // Drop old entries outside the window
        attempts.retain(|t| now.duration_since(*t) < window);
        if attempts.len() >= max_attempts {
            warn!(
                "Rate limit exceeded для пользователя '{}'",
                payload.username
            );
            return (
                StatusCode::TOO_MANY_REQUESTS,
                format!(
                    "Слишком много попыток. Повторите через {} секунд.",
                    state.config.rate_limit_window_secs
                ),
            )
                .into_response();
        }
        attempts.push_back(now);
    }

    let row =
        sqlx::query(
            "SELECT username, password_hash, token_version, cloud_vault_sync_enabled FROM users WHERE username = ?",
        )
            .bind(&payload.username)
            .fetch_optional(&state.db)
            .await;

    match row {
        Ok(Some(r)) => {
            let username: String = r.get("username");
            let hash: String = r.get("password_hash");
            let token_version: i64 = r.get::<i64, _>("token_version");
            let cloud_vault_sync_enabled: i64 = r.get::<i64, _>("cloud_vault_sync_enabled");

            let valid = match verify_password(payload.password.clone(), hash).await {
                Ok(valid) => valid,
                Err(e) => {
                    error!("Ошибка проверки пароля: {}", e);
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            if !valid {
                warn!("Неверный пароль для пользователя '{}'", payload.username);
                return (StatusCode::UNAUTHORIZED, "Неверный логин или пароль").into_response();
            }

            // Clear rate limit on success
            state.login_attempts.remove(&rate_key);

            match issue_auth_response(
                username.clone(),
                token_version,
                cloud_vault_sync_enabled != 0,
                &state.config.jwt_secret,
            ) {
                Ok(auth) => {
                    info!("Успешный вход: {}", username);
                    auth_response_with_cookie_and_secure(
                        StatusCode::OK,
                        auth,
                        state.config.auth_cookie_secure,
                    )
                }
                Err(e) => {
                    error!("Ошибка генерации JWT: {}", e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        Ok(None) => {
            let _ = verify_password(payload.password.clone(), DUMMY_BCRYPT_HASH.to_string()).await;
            (StatusCode::UNAUTHORIZED, "Неверный логин или пароль").into_response()
        }
        Err(e) => {
            error!("Ошибка чтения пользователя при логине: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) fn extract_client_ip(remote_addr: SocketAddr, headers: &HeaderMap) -> std::net::IpAddr {
    let trusted = std::env::var("TRUSTED_PROXY_MODE")
        .map(|v| {
            matches!(
                v.trim().to_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if trusted {
        if let Some(ip) = headers
            .get("X-Forwarded-For")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .and_then(|s| s.trim().parse::<std::net::IpAddr>().ok())
        {
            return ip;
        }
        if let Some(ip) = headers
            .get("X-Real-IP")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<std::net::IpAddr>().ok())
        {
            return ip;
        }
    }
    remote_addr.ip()
}

pub(crate) fn login_rate_key(ip: std::net::IpAddr, username: &str) -> String {
    let username = username.trim().to_lowercase();
    format!("{}|{}", username, ip)
}
