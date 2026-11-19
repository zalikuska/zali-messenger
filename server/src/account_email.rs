//! Почта аккаунта: привязка и смена с подтверждением шестизначным кодом из
//! письма и сброс забытого пароля по почте.
//!
//! Инварианты безопасности (проверяет `tests/account_email.rs`):
//!
//! - В `users.email` лежит только **подтверждённый** адрес (кодом из письма);
//!   адрес, ждущий подтверждения, живёт в `email_challenges`. Один адрес — один
//!   аккаунт (частичный уникальный индекс), и занятость адреса раскрывается только
//!   тому, кто ввёл код из этого ящика.
//! - Привязать или сменить почту можно только с текущим паролем: украденный токен
//!   не переносит восстановление доступа на чужой ящик. На прежний адрес уходит
//!   уведомление, а незавершённый сброс пароля по прежнему адресу гаснет.
//! - Код хранится HMAC-отпечатком (ключ выводится из `JWT_SECRET`, в сообщении —
//!   id заявки): утёкшая база не даёт ни кодов, ни быстрого перебора миллиона
//!   вариантов. Сравнение — за постоянное время.
//! - Код живёт 15 минут, на код — 5 попыток, после чего заявка сгорает. Письма —
//!   не чаще раза в минуту и не больше 5 в час на аккаунт и на адрес, запросы
//!   сброса — не больше 20 в час с одного IP (счётчики в базе, переживают рестарт).
//! - Сброс не выдаёт, есть ли такой аккаунт и есть ли у него почта: ответ на запрос
//!   одинаков и мгновенен (поиск и письмо — в фоне), а неверный, устаревший и
//!   «сгоревший» после пяти попыток код дают один и тот же ответ.
//! - Верный код сброса обменивается на одноразовый токен (256 бит, 10 минут), и
//!   уже с ним задаётся новый пароль. Новый пароль отзывает все токены и сокеты и
//!   удаляет облачный vault: он зашифрован старым паролем, и никто, кроме
//!   забывшего, его больше не откроет, а оставленный, он навсегда запрещал бы
//!   клиенту публиковать ключи под новым паролем (см. `syncCloudVaultPackage`).
//!   Переписки потом возвращаются с других устройств и через собеседников
//!   (`history_recovery.rs`).

use crate::{
    auth::{
        auth_response_with_cookie_and_secure, extract_client_ip, hash_password, issue_auth_response,
        password_policy_error, rate_allow, rate_bucket_ip, verify_password, AuthenticatedUser,
    },
    mail_templates,
    mailer::OutgoingMail,
    AppState,
};
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use hmac::{Hmac, Mac};
use rand::Rng;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{net::SocketAddr, sync::Arc};
use tracing::{error, info, warn};
use uuid::Uuid;

pub(crate) const CODE_TTL_SECS: i64 = 15 * 60;
pub(crate) const RESEND_COOLDOWN_SECS: i64 = 60;
pub(crate) const MAX_CODE_ATTEMPTS: i64 = 5;
const RESET_TOKEN_TTL_SECS: i64 = 10 * 60;
const SENDS_PER_HOUR_PER_ACCOUNT: i64 = 5;
const SENDS_PER_HOUR_PER_ADDRESS: i64 = 5;
const RESET_REQUESTS_PER_HOUR_PER_IP: i64 = 20;
/// Заявка без активности дольше суток удаляется.
const CHALLENGE_RETENTION_SECS: i64 = 24 * 3600;

const PURPOSE_LINK: &str = "link";
const PURPOSE_RESET: &str = "reset";

const GENERIC_BAD_RESET_CODE: &str =
    "Неверный или устаревший код. Если ошиблись несколько раз подряд — запросите новый.";

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

fn text(status: StatusCode, message: impl Into<String>) -> Response {
    (status, message.into()).into_response()
}

fn internal() -> Response {
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

fn mail_disabled() -> Response {
    text(
        StatusCode::SERVICE_UNAVAILABLE,
        "Сервер пока не отправляет письма — привязка почты и сброс пароля недоступны.",
    )
}

// ============================================================
// Адрес почты
// ============================================================

const RESERVED_TLDS: &[&str] = &["localhost", "local", "internal", "invalid", "arpa", "home", "lan", "corp"];

/// Приводит адрес к виду, в котором он хранится и сравнивается: без пробелов,
/// строчными, домен — в punycode. Принимает только то, что реально доставляемо
/// по SMTP без расширений: латинская локальная часть без кавычек и комментариев,
/// домен из двух и более меток.
pub(crate) fn normalize_email(raw: &str) -> Result<String, &'static str> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("Укажите почту");
    }
    if value.len() > 254 {
        return Err("Слишком длинный адрес почты");
    }
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("В адресе почты не должно быть пробелов");
    }
    let Some((local, domain)) = value.rsplit_once('@') else {
        return Err("В адресе почты не хватает @");
    };
    if local.is_empty() || domain.is_empty() {
        return Err("Проверьте адрес почты");
    }
    if local.len() > 64 {
        return Err("Слишком длинное имя ящика");
    }
    const LOCAL_EXTRA: &str = "!#$%&'*+-/=?^_`{|}~.";
    if !local.chars().all(|c| c.is_ascii_alphanumeric() || LOCAL_EXTRA.contains(c)) {
        return Err("Имя ящика — латиницей, без пробелов и кавычек");
    }
    if local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return Err("Проверьте точки в адресе почты");
    }
    let ascii_domain = idna::domain_to_ascii(domain.trim_end_matches('.')).map_err(|_| "Проверьте домен почты")?;
    let ascii_domain = ascii_domain.to_ascii_lowercase();
    if ascii_domain.len() > 253 {
        return Err("Слишком длинный домен почты");
    }
    let labels: Vec<&str> = ascii_domain.split('.').collect();
    if labels.len() < 2 {
        return Err("Проверьте домен почты");
    }
    for label in &labels {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("Проверьте домен почты");
        }
    }
    let tld = labels[labels.len() - 1];
    let tld_ok = (tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())) || tld.starts_with("xn--");
    if !tld_ok || RESERVED_TLDS.contains(&tld) {
        return Err("Проверьте домен почты");
    }
    Ok(format!("{}@{}", local.to_ascii_lowercase(), ascii_domain))
}

// ============================================================
// Коды
// ============================================================

fn generate_code() -> String {
    format!("{:06}", rand::rngs::OsRng.gen_range(0..1_000_000u32))
}

/// Только цифры: человек может вставить «123 456» или «123-456».
fn clean_code(raw: &str) -> Option<String> {
    let digits: String = raw.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    (digits.len() == 6 && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

fn code_key(state: &AppState) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"zali.email-code.key.v1\0");
    hasher.update(&state.config.jwt_secret);
    hasher.finalize().into()
}

fn code_digest(state: &AppState, challenge_id: &str, purpose: &str, code: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&code_key(state)).expect("HMAC принимает ключ любой длины");
    for part in [challenge_id, purpose, code] {
        mac.update(part.as_bytes());
        mac.update(b"\0");
    }
    crate::hex_encode(&mac.finalize().into_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn sha256_hex(value: &str) -> String {
    crate::hex_encode(&Sha256::digest(value.as_bytes()))
}

fn new_reset_token() -> String {
    use base64::Engine as _;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ============================================================
// Счётчики писем (в базе: переживают рестарт)
// ============================================================

async fn sends_in_last_hour(state: &AppState, key: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM email_send_log WHERE key = ? AND sent_at > ?")
        .bind(key)
        .bind(now_secs() - 3600)
        .fetch_one(&state.db)
        .await
}

async fn record_send(state: &AppState, keys: &[&str]) {
    let now = now_secs();
    for key in keys {
        if let Err(e) = sqlx::query("INSERT INTO email_send_log (key, sent_at) VALUES (?, ?)")
            .bind(key)
            .bind(now)
            .execute(&state.db)
            .await
        {
            warn!("email_send_log: {}", e);
        }
    }
}

/// `true`, если по всем ключам ещё есть место в часовом бюджете.
async fn within_hourly_budget(state: &AppState, budgets: &[(&str, i64)]) -> Result<bool, sqlx::Error> {
    for (key, max) in budgets {
        if sends_in_last_hour(state, key).await? >= *max {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Удаляет просроченное: заявки старше суток и счётчики старше часа.
pub(crate) async fn sweep_expired(state: &AppState) {
    let now = now_secs();
    let _ = sqlx::query("DELETE FROM email_challenges WHERE last_sent_at < ?")
        .bind(now - CHALLENGE_RETENTION_SECS)
        .execute(&state.db)
        .await;
    let _ = sqlx::query("DELETE FROM email_send_log WHERE sent_at < ?")
        .bind(now - 3600)
        .execute(&state.db)
        .await;
}

// ============================================================
// Заявки
// ============================================================

struct Challenge {
    id: String,
    email: String,
    code_hash: String,
    last_sent_at: i64,
    expires_at: i64,
}

async fn load_challenge(state: &AppState, username: &str, purpose: &str) -> Result<Option<Challenge>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, email, code_hash, last_sent_at, expires_at
         FROM email_challenges WHERE username = ? AND purpose = ?",
    )
    .bind(username)
    .bind(purpose)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(|r| Challenge {
        id: r.get("id"),
        email: r.get("email"),
        code_hash: r.get("code_hash"),
        last_sent_at: r.get("last_sent_at"),
        expires_at: r.get("expires_at"),
    }))
}

/// Новая заявка (или новый код в прежней): свежий id, свежий код, попытки с нуля.
/// Возвращает код — его увидит только письмо.
async fn issue_challenge(state: &AppState, username: &str, purpose: &str, email: &str) -> Result<String, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let code = generate_code();
    let hash = code_digest(state, &id, purpose, &code);
    let now = now_secs();
    sqlx::query(
        "INSERT INTO email_challenges
            (id, username, purpose, email, code_hash, attempts, sends, created_at, last_sent_at, expires_at,
             reset_token_hash, reset_token_expires_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, NULL, NULL)
         ON CONFLICT(username, purpose) DO UPDATE SET
            id = excluded.id, email = excluded.email, code_hash = excluded.code_hash, attempts = 0,
            sends = email_challenges.sends + 1, last_sent_at = excluded.last_sent_at,
            expires_at = excluded.expires_at, reset_token_hash = NULL, reset_token_expires_at = NULL",
    )
    .bind(&id)
    .bind(username)
    .bind(purpose)
    .bind(email)
    .bind(&hash)
    .bind(now)
    .bind(now)
    .bind(now + CODE_TTL_SECS)
    .execute(&state.db)
    .await?;
    Ok(code)
}

async fn delete_challenge(state: &AppState, username: &str, purpose: &str) {
    let _ = sqlx::query("DELETE FROM email_challenges WHERE username = ? AND purpose = ?")
        .bind(username)
        .bind(purpose)
        .execute(&state.db)
        .await;
}

fn pending_json(challenge: &Challenge) -> serde_json::Value {
    let now = now_secs();
    serde_json::json!({
        "email": challenge.email,
        "expiresIn": (challenge.expires_at - now).max(0),
        "resendIn": (challenge.last_sent_at + RESEND_COOLDOWN_SECS - now).max(0),
    })
}

enum CodeCheck {
    Ok,
    Wrong { remaining: i64 },
    Expired,
    Exhausted,
}

/// Сверяет код. Попытка списывается ДО сверки — одним `UPDATE … WHERE attempts < MAX`:
/// иначе пачка параллельных запросов проходила проверку лимита разом, и на код
/// приходилось столько догадок, сколько успевало долететь (аудит 2026-11-19). Пятая
/// неверная попытка сжигает заявку. Новый код (новый id) чужих промахов не наследует.
async fn check_code(state: &AppState, username: &str, purpose: &str, challenge: &Challenge, code: &str) -> Result<CodeCheck, sqlx::Error> {
    if challenge.expires_at <= now_secs() || challenge.code_hash.is_empty() {
        return Ok(CodeCheck::Expired);
    }
    let reserved: Option<i64> = sqlx::query_scalar(
        "UPDATE email_challenges SET attempts = attempts + 1
         WHERE id = ? AND attempts < ? AND code_hash <> '' RETURNING attempts",
    )
    .bind(&challenge.id)
    .bind(MAX_CODE_ATTEMPTS)
    .fetch_optional(&state.db)
    .await?;
    let Some(attempts) = reserved else {
        // Заявку успели заменить новым кодом или погасить — это «устарел»; иначе
        // попытки кончились.
        let alive: Option<i64> = sqlx::query_scalar("SELECT attempts FROM email_challenges WHERE id = ?")
            .bind(&challenge.id)
            .fetch_optional(&state.db)
            .await?;
        if alive.is_none() {
            return Ok(CodeCheck::Expired);
        }
        delete_challenge(state, username, purpose).await;
        return Ok(CodeCheck::Exhausted);
    };
    let expected = code_digest(state, &challenge.id, purpose, code);
    if constant_time_eq(expected.as_bytes(), challenge.code_hash.as_bytes()) {
        return Ok(CodeCheck::Ok);
    }
    if attempts >= MAX_CODE_ATTEMPTS {
        delete_challenge(state, username, purpose).await;
        return Ok(CodeCheck::Exhausted);
    }
    Ok(CodeCheck::Wrong { remaining: MAX_CODE_ATTEMPTS - attempts })
}

fn client_ip(remote_addr: SocketAddr, headers: &HeaderMap) -> std::net::IpAddr {
    rate_bucket_ip(extract_client_ip(remote_addr, headers))
}

fn too_many(message: &str) -> Response {
    text(StatusCode::TOO_MANY_REQUESTS, message)
}

// ============================================================
// Публичное: включена ли почта
// ============================================================

/// `GET /api/auth/email/config` — без входа: экран регистрации решает по нему,
/// показывать ли поле почты и «Забыли пароль?». Старый сервер отвечает 404 —
/// клиент считает почту выключенной.
pub(crate) async fn email_config(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "enabled": state.mailer.enabled(),
        "codeLength": 6,
        "codeTtlSecs": CODE_TTL_SECS,
        "resendCooldownSecs": RESEND_COOLDOWN_SECS,
        "maxAttempts": MAX_CODE_ATTEMPTS,
    }))
}

// ============================================================
// Привязка и смена почты (вошедший пользователь)
// ============================================================

/// `GET /api/auth/email` — подтверждённая почта и незавершённая привязка.
pub(crate) async fn email_status(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> Response {
    let row = match sqlx::query("SELECT email, email_verified_at FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&state.db)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(e) => {
            error!("email_status {}: {}", username, e);
            return internal();
        }
    };
    let pending = match load_challenge(&state, &username, PURPOSE_LINK).await {
        Ok(Some(challenge)) if challenge.expires_at > now_secs() => Some(pending_json(&challenge)),
        Ok(_) => None,
        Err(e) => {
            error!("email_status challenge {}: {}", username, e);
            return internal();
        }
    };
    Json(serde_json::json!({
        "enabled": state.mailer.enabled(),
        "email": row.get::<Option<String>, _>("email"),
        "verifiedAt": row.get::<Option<i64>, _>("email_verified_at"),
        "pending": pending,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(crate) struct StartLinkPayload {
    email: String,
    password: String,
}

/// `POST /api/auth/email` — начать привязку (или смену): проверка пароля, письмо с кодом.
pub(crate) async fn start_email_link(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Json(payload): Json<StartLinkPayload>,
) -> Response {
    if !state.mailer.enabled() {
        return mail_disabled();
    }
    // Тот же бюджет, что у смены пароля: здесь тоже проверяется пароль.
    if !rate_allow(&state, format!("emailpw:{}", username.to_lowercase()), state.config.rate_limit_max_attempts) {
        return too_many("Слишком много попыток. Повторите через минуту.");
    }
    let email = match normalize_email(&payload.email) {
        Ok(email) => email,
        Err(reason) => return text(StatusCode::BAD_REQUEST, reason),
    };
    let row = match sqlx::query("SELECT password_hash, email FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&state.db)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(e) => {
            error!("start_email_link {}: {}", username, e);
            return internal();
        }
    };
    let hash: String = row.get("password_hash");
    match verify_password(payload.password.clone(), hash).await {
        Ok(true) => {}
        Ok(false) => {
            warn!("Привязка почты: неверный пароль у '{}'", username);
            return text(StatusCode::FORBIDDEN, "Неверный пароль");
        }
        Err(e) => {
            error!("Привязка почты: bcrypt {}", e);
            return internal();
        }
    }
    if row.get::<Option<String>, _>("email").as_deref() == Some(email.as_str()) {
        return text(StatusCode::CONFLICT, "Эта почта уже привязана к вашему аккаунту");
    }
    // Повтор на тот же адрес — не чаще раза в минуту; другой адрес (исправили
    // опечатку) можно сразу, часовые бюджеты держат и такой путь.
    match load_challenge(&state, &username, PURPOSE_LINK).await {
        Ok(Some(existing)) if existing.email == email => {
            let wait = existing.last_sent_at + RESEND_COOLDOWN_SECS - now_secs();
            if wait > 0 {
                return too_many(&format!("Код уже отправлен. Повторить можно через {wait} с."));
            }
        }
        Ok(_) => {}
        Err(e) => {
            error!("start_email_link challenge {}: {}", username, e);
            return internal();
        }
    }
    send_link_code(&state, &username, &email).await
}

async fn send_link_code(state: &Arc<AppState>, username: &str, email: &str) -> Response {
    let account_key = format!("acct:{PURPOSE_LINK}:{}", username.to_lowercase());
    let address_key = format!("to:{email}");
    match within_hourly_budget(
        state,
        &[(&account_key, SENDS_PER_HOUR_PER_ACCOUNT), (&address_key, SENDS_PER_HOUR_PER_ADDRESS)],
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => return too_many("Слишком много писем за час. Попробуйте позже."),
        Err(e) => {
            error!("email budget: {}", e);
            return internal();
        }
    }
    let code = match issue_challenge(state, username, PURPOSE_LINK, email).await {
        Ok(code) => code,
        Err(e) => {
            error!("issue_challenge link {}: {}", username, e);
            return internal();
        }
    };
    let mail = OutgoingMail::new(email, "email_link_code", mail_templates::link_code(username, &code, CODE_TTL_SECS as u64));
    if !state.mailer.enqueue(mail) {
        delete_challenge(state, username, PURPOSE_LINK).await;
        return text(StatusCode::SERVICE_UNAVAILABLE, "Не удалось поставить письмо в очередь. Попробуйте ещё раз.");
    }
    record_send(state, &[&account_key, &address_key]).await;
    info!("Код привязки почты отправлен: {} → {}", username, mail_templates::mask_email(email));
    match load_challenge(state, username, PURPOSE_LINK).await {
        Ok(Some(challenge)) => (StatusCode::ACCEPTED, Json(serde_json::json!({ "pending": pending_json(&challenge) }))).into_response(),
        _ => StatusCode::ACCEPTED.into_response(),
    }
}

/// `POST /api/auth/email/resend` — новый код на тот же, уже проверенный паролем адрес.
pub(crate) async fn resend_email_link(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> Response {
    if !state.mailer.enabled() {
        return mail_disabled();
    }
    let challenge = match load_challenge(&state, &username, PURPOSE_LINK).await {
        Ok(Some(challenge)) => challenge,
        Ok(None) => return text(StatusCode::NOT_FOUND, "Запрос на привязку устарел — укажите почту заново."),
        Err(e) => {
            error!("resend_email_link {}: {}", username, e);
            return internal();
        }
    };
    let wait = challenge.last_sent_at + RESEND_COOLDOWN_SECS - now_secs();
    if wait > 0 {
        return too_many(&format!("Повторить можно через {wait} с."));
    }
    send_link_code(&state, &username, &challenge.email).await
}

#[derive(Deserialize)]
pub(crate) struct CodePayload {
    code: String,
}

/// `POST /api/auth/email/confirm` — код из письма; почта становится подтверждённой.
pub(crate) async fn confirm_email_link(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<CodePayload>,
) -> Response {
    let ip = client_ip(remote_addr, &headers);
    if !rate_allow(&state, format!("emailcode-ip:{ip}"), 30)
        || !rate_allow(&state, format!("emailcode-user:{}", username.to_lowercase()), 15)
    {
        return too_many("Слишком много попыток. Повторите через минуту.");
    }
    let Some(code) = clean_code(&payload.code) else {
        return text(StatusCode::BAD_REQUEST, "Код — шесть цифр из письма");
    };
    let challenge = match load_challenge(&state, &username, PURPOSE_LINK).await {
        Ok(Some(challenge)) => challenge,
        Ok(None) => return text(StatusCode::NOT_FOUND, "Код больше не действует — отправьте новый."),
        Err(e) => {
            error!("confirm_email_link {}: {}", username, e);
            return internal();
        }
    };
    match check_code(&state, &username, PURPOSE_LINK, &challenge, &code).await {
        Ok(CodeCheck::Ok) => {}
        Ok(CodeCheck::Wrong { remaining }) => {
            return text(StatusCode::BAD_REQUEST, format!("Неверный код. Осталось попыток: {remaining}."));
        }
        Ok(CodeCheck::Expired) => return text(StatusCode::GONE, "Код истёк — отправьте новый."),
        Ok(CodeCheck::Exhausted) => {
            return too_many("Слишком много неверных попыток — этот код больше не действует. Отправьте новый.");
        }
        Err(e) => {
            error!("check_code link {}: {}", username, e);
            return internal();
        }
    }

    let previous: Option<String> = match sqlx::query_scalar::<_, Option<String>>("SELECT email FROM users WHERE username = ?")
        .bind(&username)
        .fetch_one(&state.db)
        .await
    {
        Ok(value) => value,
        Err(e) => {
            error!("confirm_email_link previous {}: {}", username, e);
            return internal();
        }
    };
    let now = now_secs();
    let updated = sqlx::query("UPDATE users SET email = ?, email_verified_at = ? WHERE username = ?")
        .bind(&challenge.email)
        .bind(now)
        .bind(&username)
        .execute(&state.db)
        .await;
    // Код верный в любом случае — заявка своё отработала.
    delete_challenge(&state, &username, PURPOSE_LINK).await;
    if let Err(e) = updated {
        let unique = e
            .as_database_error()
            .map(|db| db.is_unique_violation())
            .unwrap_or(false);
        if unique {
            // Раскрывается только тому, кто доказал, что читает этот ящик.
            return text(StatusCode::CONFLICT, "Эта почта уже привязана к другому аккаунту.");
        }
        error!("confirm_email_link update {}: {}", username, e);
        return internal();
    }
    // Коды сброса, ушедшие на прежний адрес, больше не должны открывать аккаунт.
    delete_challenge(&state, &username, PURPOSE_RESET).await;
    if let Some(old) = previous.filter(|old| *old != challenge.email) {
        let notice = OutgoingMail::new(&old, "email_changed_notice", mail_templates::email_changed_notice(&username, &challenge.email));
        state.mailer.enqueue(notice);
    }
    info!("Почта подтверждена: {} → {}", username, mail_templates::mask_email(&challenge.email));
    Json(serde_json::json!({ "email": challenge.email, "verifiedAt": now })).into_response()
}

/// `DELETE /api/auth/email/pending` — отказ от незавершённой привязки: код гаснет.
pub(crate) async fn cancel_email_link(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> Response {
    delete_challenge(&state, &username, PURPOSE_LINK).await;
    StatusCode::NO_CONTENT.into_response()
}

// ============================================================
// Сброс пароля (без входа)
// ============================================================

/// Аккаунт по логину или по почте. `None` — не нашли (или почта не разобралась).
async fn find_account(state: &AppState, login: &str) -> Result<Option<(String, Option<String>)>, sqlx::Error> {
    let login = login.trim();
    let row = if login.contains('@') {
        let Ok(email) = normalize_email(login) else { return Ok(None) };
        sqlx::query("SELECT username, email FROM users WHERE email = ?")
            .bind(email)
            .fetch_optional(&state.db)
            .await?
    } else {
        sqlx::query("SELECT username, email FROM users WHERE lower(username) = ?")
            .bind(login.to_lowercase())
            .fetch_optional(&state.db)
            .await?
    };
    Ok(row.map(|r| (r.get("username"), r.get("email"))))
}

#[derive(Deserialize)]
pub(crate) struct ResetStartPayload {
    login: String,
}

/// `POST /api/auth/password-reset` — «Забыли пароль?». Ответ всегда один и тот же.
pub(crate) async fn start_password_reset(
    State(state): State<Arc<AppState>>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<ResetStartPayload>,
) -> Response {
    if !state.mailer.enabled() {
        return mail_disabled();
    }
    let login = payload.login.trim().to_string();
    if login.is_empty() || login.len() > 254 {
        return text(StatusCode::BAD_REQUEST, "Укажите логин или почту");
    }
    let ip_key = format!("ip:{}", client_ip(remote_addr, &headers));
    match within_hourly_budget(&state, &[(&ip_key, RESET_REQUESTS_PER_HOUR_PER_IP)]).await {
        Ok(true) => {}
        Ok(false) => return too_many("Слишком много запросов сброса. Попробуйте позже."),
        Err(e) => {
            error!("reset budget: {}", e);
            return internal();
        }
    }
    record_send(&state, &[&ip_key]).await;

    // Поиск аккаунта и письмо — в фоне: ответ не должен ни по содержанию, ни по
    // времени выдавать, есть ли такой аккаунт и привязана ли к нему почта.
    let worker = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(e) = send_reset_code(&worker, &login).await {
            error!("Сброс пароля: {}", e);
        }
    });
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "codeTtlSecs": CODE_TTL_SECS,
            "resendCooldownSecs": RESEND_COOLDOWN_SECS,
        })),
    )
        .into_response()
}

async fn send_reset_code(state: &Arc<AppState>, login: &str) -> Result<(), sqlx::Error> {
    let Some((username, Some(email))) = find_account(state, login).await? else {
        return Ok(());
    };
    if let Some(existing) = load_challenge(state, &username, PURPOSE_RESET).await? {
        if existing.last_sent_at + RESEND_COOLDOWN_SECS > now_secs() {
            return Ok(());
        }
    }
    let account_key = format!("acct:{PURPOSE_RESET}:{}", username.to_lowercase());
    let address_key = format!("to:{email}");
    if !within_hourly_budget(
        state,
        &[(&account_key, SENDS_PER_HOUR_PER_ACCOUNT), (&address_key, SENDS_PER_HOUR_PER_ADDRESS)],
    )
    .await?
    {
        warn!("Сброс пароля для '{}': часовой лимит писем исчерпан", username);
        return Ok(());
    }
    let code = issue_challenge(state, &username, PURPOSE_RESET, &email).await?;
    let mail = OutgoingMail::new(&email, "password_reset_code", mail_templates::reset_code(&username, &code, CODE_TTL_SECS as u64));
    if state.mailer.enqueue(mail) {
        record_send(state, &[&account_key, &address_key]).await;
        info!("Код сброса пароля отправлен: {} → {}", username, mail_templates::mask_email(&email));
    } else {
        delete_challenge(state, &username, PURPOSE_RESET).await;
    }
    Ok(())
}

#[derive(Deserialize)]
pub(crate) struct ResetVerifyPayload {
    login: String,
    code: String,
}

/// `POST /api/auth/password-reset/verify` — код из письма → одноразовый токен сброса.
pub(crate) async fn verify_password_reset(
    State(state): State<Arc<AppState>>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<ResetVerifyPayload>,
) -> Response {
    let ip = client_ip(remote_addr, &headers);
    if !rate_allow(&state, format!("resetcode-ip:{ip}"), 30) {
        return too_many("Слишком много попыток. Повторите через минуту.");
    }
    let Some(code) = clean_code(&payload.code) else {
        return text(StatusCode::BAD_REQUEST, "Код — шесть цифр из письма");
    };
    // Счётчик — по введённому логину, до поиска аккаунта: считай его по найденному
    // аккаунту, 429 на 16-й попытке выдавал бы, что такая почта зарегистрирована.
    // Подбор кода держит не он, а пять попыток на сам код (check_code).
    let login_key = payload.login.trim().to_lowercase();
    if login_key.is_empty() || login_key.len() > 254 {
        return text(StatusCode::BAD_REQUEST, GENERIC_BAD_RESET_CODE);
    }
    if !rate_allow(&state, format!("resetcode-login:{login_key}"), 15) {
        return too_many("Слишком много попыток. Повторите через минуту.");
    }
    let account = match find_account(&state, &payload.login).await {
        Ok(account) => account,
        Err(e) => {
            error!("verify_password_reset: {}", e);
            return internal();
        }
    };
    let Some((username, _)) = account else {
        // Та же работа, что и при настоящей проверке, — по времени не отличить.
        let _ = code_digest(&state, "-", PURPOSE_RESET, &code);
        return text(StatusCode::BAD_REQUEST, GENERIC_BAD_RESET_CODE);
    };
    let challenge = match load_challenge(&state, &username, PURPOSE_RESET).await {
        Ok(Some(challenge)) => challenge,
        Ok(None) => {
            let _ = code_digest(&state, "-", PURPOSE_RESET, &code);
            return text(StatusCode::BAD_REQUEST, GENERIC_BAD_RESET_CODE);
        }
        Err(e) => {
            error!("verify_password_reset challenge: {}", e);
            return internal();
        }
    };
    match check_code(&state, &username, PURPOSE_RESET, &challenge, &code).await {
        Ok(CodeCheck::Ok) => {}
        // Неверный, устаревший и сгоревший код — один ответ: иначе по «осталось N
        // попыток» было бы видно, что у аккаунта есть почта и идёт сброс.
        Ok(_) => return text(StatusCode::BAD_REQUEST, GENERIC_BAD_RESET_CODE),
        Err(e) => {
            error!("check_code reset {}: {}", username, e);
            return internal();
        }
    }
    let token = new_reset_token();
    // Код погашен (пустой отпечаток), заявка теперь держит только токен.
    let stored = sqlx::query(
        "UPDATE email_challenges SET code_hash = '', reset_token_hash = ?, reset_token_expires_at = ?
         WHERE id = ? AND purpose = ?",
    )
    .bind(sha256_hex(&token))
    .bind(now_secs() + RESET_TOKEN_TTL_SECS)
    .bind(&challenge.id)
    .bind(PURPOSE_RESET)
    .execute(&state.db)
    .await;
    match stored {
        Ok(done) if done.rows_affected() == 1 => {}
        Ok(_) => return text(StatusCode::BAD_REQUEST, GENERIC_BAD_RESET_CODE),
        Err(e) => {
            error!("verify_password_reset store token: {}", e);
            return internal();
        }
    }
    Json(serde_json::json!({
        "resetToken": token,
        "username": username,
        "expiresIn": RESET_TOKEN_TTL_SECS,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(crate) struct ResetCompletePayload {
    #[serde(rename = "resetToken")]
    reset_token: String,
    #[serde(rename = "newPassword")]
    new_password: String,
}

/// `POST /api/auth/password-reset/complete` — новый пароль по токену сброса.
pub(crate) async fn complete_password_reset(
    State(state): State<Arc<AppState>>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<ResetCompletePayload>,
) -> Response {
    let ip = client_ip(remote_addr, &headers);
    if !rate_allow(&state, format!("resetdone-ip:{ip}"), 20) {
        return too_many("Слишком много попыток. Повторите через минуту.");
    }
    let token = payload.reset_token.trim();
    if token.len() < 32 || token.len() > 128 {
        return text(StatusCode::BAD_REQUEST, "Сеанс сброса устарел — запросите новый код.");
    }
    let row = match sqlx::query(
        "SELECT c.username AS username, c.email AS email FROM email_challenges c
         WHERE c.purpose = ? AND c.reset_token_hash = ? AND c.reset_token_expires_at > ?",
    )
    .bind(PURPOSE_RESET)
    .bind(sha256_hex(token))
    .bind(now_secs())
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return text(StatusCode::BAD_REQUEST, "Сеанс сброса устарел — запросите новый код."),
        Err(e) => {
            error!("complete_password_reset: {}", e);
            return internal();
        }
    };
    let username: String = row.get("username");
    let email: String = row.get("email");
    if let Some(reason) = password_policy_error(&username, &payload.new_password) {
        return text(StatusCode::BAD_REQUEST, reason);
    }
    let new_hash = match hash_password(payload.new_password.clone()).await {
        Ok(hash) => hash,
        Err(e) => {
            error!("complete_password_reset bcrypt: {}", e);
            return internal();
        }
    };

    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            error!("complete_password_reset tx: {}", e);
            return internal();
        }
    };
    // Токен гасится тем же оператором, что его проверяет: два параллельных запроса
    // с одним токеном не зададут два пароля.
    let consumed = sqlx::query(
        "DELETE FROM email_challenges WHERE purpose = ? AND reset_token_hash = ? AND reset_token_expires_at > ?",
    )
    .bind(PURPOSE_RESET)
    .bind(sha256_hex(token))
    .bind(now_secs())
    .execute(&mut *tx)
    .await;
    match consumed {
        Ok(done) if done.rows_affected() == 1 => {}
        Ok(_) => return text(StatusCode::BAD_REQUEST, "Сеанс сброса устарел — запросите новый код."),
        Err(e) => {
            error!("complete_password_reset consume: {}", e);
            return internal();
        }
    }
    let updated = sqlx::query(
        "UPDATE users SET password_hash = ?, token_version = token_version + 1
         WHERE username = ? RETURNING token_version, cloud_vault_sync_enabled",
    )
    .bind(&new_hash)
    .bind(&username)
    .fetch_optional(&mut *tx)
    .await;
    let (token_version, cloud_vault_sync_enabled) = match updated {
        Ok(Some(row)) => (row.get::<i64, _>("token_version"), row.get::<i64, _>("cloud_vault_sync_enabled") != 0),
        Ok(None) => return text(StatusCode::BAD_REQUEST, "Сеанс сброса устарел — запросите новый код."),
        Err(e) => {
            error!("complete_password_reset update: {}", e);
            return internal();
        }
    };
    // Облачный vault зашифрован забытым паролем — см. шапку модуля.
    if let Err(e) = sqlx::query("DELETE FROM account_vault_events WHERE owner = ?")
        .bind(&username)
        .execute(&mut *tx)
        .await
    {
        error!("complete_password_reset vault: {}", e);
        return internal();
    }
    let _ = sqlx::query("DELETE FROM email_challenges WHERE username = ?")
        .bind(&username)
        .execute(&mut *tx)
        .await;
    if let Err(e) = tx.commit().await {
        error!("complete_password_reset commit: {}", e);
        return internal();
    }

    state.ws_tickets.retain(|_, record| record.username != username);
    crate::disconnect_user_sockets(&state, &username);
    // Неудачные входы этого аккаунта больше не о чем считать.
    state.login_attempts.remove(&crate::auth::failed_login_user_rate_key(&username));
    let notice = OutgoingMail::new(&email, "password_reset_notice", mail_templates::password_reset_notice(&username));
    state.mailer.enqueue(notice);
    info!("Пароль сброшен по почте: {}", username);

    match issue_auth_response(username, token_version, cloud_vault_sync_enabled, &state.config.jwt_secret) {
        Ok(auth) => auth_response_with_cookie_and_secure(StatusCode::OK, auth, state.config.auth_cookie_secure),
        Err(e) => {
            error!("complete_password_reset jwt: {}", e);
            internal()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_normalized() {
        assert_eq!(normalize_email("  Alice.Smith+tag@Example.COM ").unwrap(), "alice.smith+tag@example.com");
        assert_eq!(normalize_email("ivan@почта.рф").unwrap(), "ivan@xn--80a1acny.xn--p1ai");
    }

    #[test]
    fn bad_emails_are_rejected() {
        for bad in [
            "", "alice", "alice@", "@example.com", "alice@localhost", "alice@example", "a b@example.com",
            "alice@exa mple.com", ".alice@example.com", "alice.@example.com", "al..ice@example.com",
            "alice@-example.com", "alice@example.123", "\"alice\"@example.com", "alice@[127.0.0.1]",
            "alice@example.local", "иван@example.com", "alice@example.com\r\nBcc: x@y.zz",
        ] {
            assert!(normalize_email(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn codes_are_six_digits_and_cleaned() {
        for _ in 0..200 {
            let code = generate_code();
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
        assert_eq!(clean_code(" 123 456 ").as_deref(), Some("123456"));
        assert_eq!(clean_code("123-456").as_deref(), Some("123456"));
        assert!(clean_code("12345").is_none());
        assert!(clean_code("12345a").is_none());
        assert!(clean_code("1234567").is_none());
    }

    #[test]
    fn constant_time_eq_compares() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
