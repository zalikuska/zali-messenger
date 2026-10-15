//! Аддоны хаба на сервере: подпись, реестр авторов, казна аддона (ZaliCoin).
//!
//! Что здесь важно понимать:
//!
//! - **Два вида подписи, два разных ключа.**
//!   `official` — подпись ключом разработчиков ZaliMessenger. Ключ лежит вне
//!   сервера (`ops/keys/`), подписывает его только закрытый инструмент
//!   разработчика; сюда приходит готовая подпись, сервер лишь проверяет её
//!   зашитым публичным ключом. `self` — «свободная» подпись: инструмент закрыт на
//!   стороне сервера (ключ не покидает `data_dir`), но доступен любому вошедшему
//!   пользователю: сервер подписывает отпечаток содержимого аддона **от имени
//!   этого аккаунта** и закрепляет за ним `id`. Самоподпись предупреждение не
//!   снимает — она значит «автор такой-то», а не «аддону можно верить».
//!
//! - **Подпись не знает содержимого.** Сервер получает только SHA-256 отпечаток
//!   файла (его считает клиент), не сам аддон. Поэтому подписывать он может что
//!   угодно, и поэтому клиент перед любым переводом сверяет отпечаток файла с
//!   подписанным (addon_format.js). Подпись привязывает `(id, version, digest,
//!   owner)` к ключу — не больше.
//!
//! - **`id` закрепляется за первым подписавшим.** Чужой аддон с тем же `id`
//!   получает 409 — иначе подменить автора и забрать переводы было бы просто.
//!   Официальная подпись может перехватить `id` (так разбирают захват чужого
//!   имени); обратно самоподписью официальный аддон не «понизить».
//!
//! - **Казна аддона — ещё один держатель монет.** Инвариант эмиссии теперь
//!   `SUM(coin_balances) + SUM(server_treasuries) + SUM(addon_treasuries) +
//!   удержанное в карточках = 100 000` (см. `get_coin_distribution`). Деньги
//!   входят и выходят только в `BEGIN IMMEDIATE`-транзакции с условным
//!   списанием; повтор с тем же `(username, kind, idempotency_key)` не проводит
//!   операцию второй раз.
//!
//! - **Вывести можно только то, что пролежало неделю.** Это не комиссия и не
//!   налог, а задержка на жалобу: доступно `взносы старше 7 суток − уже
//!   выведено`. Автор не может забрать деньги, которые только что внесли, — у
//!   обманутого человека есть неделя, чтобы пожаловаться.
//!
//! - **Вывод пользователем и вывод разработчиком — разные вещи.** Неделя
//!   удержания — ограничение разработчика на изъятие казны. Пользователь же
//!   в любой момент забирает назад то, что сам перевёл аддону (чужого — нет);
//!   сверх этого платить игрокам может только официальный аддон.
//!
//! - **Официальная подпись выдаётся по заявке и одобрению оператора** на
//!   конкретную сборку (id + версия + отпечаток). Новая версия — новая заявка.
//!
//! - **Статистика видна только владельцу и только счётчиками.** События
//!   (установка, запуск) пишутся лишь для аддонов из реестра; имена
//!   пользователей автору не отдаются — кроме тех, кто перевёл ему деньги.

use crate::{
    is_valid_username, run_immediate_tx, send_json_to_user, trim_limited, AppState, AuthenticatedUser,
    CoinTxOutcome, ZALICOIN_TOTAL_SUPPLY,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use openssl::{
    bn::{BigNum, BigNumContext},
    ec::{EcGroup, EcKey, EcPoint, PointConversionForm},
    ecdsa::EcdsaSig,
    error::ErrorStack,
    hash::{hash, MessageDigest},
    nid::Nid,
    pkey::Private,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::{path::Path as FsPath, sync::Arc};
use tracing::{error, info, warn};
use uuid::Uuid;

/// Публичный ключ официальной подписи ZaliMessenger: P-256, несжатая точка
/// (65 байт), base64. Приватная часть — только у закрытого инструмента
/// разработчиков и в этот репозиторий не попадает. Тот же ключ зашит в клиент
/// (`web/src/modules/addon_format.js`) — менять их нужно вместе.
const OFFICIAL_PUBLIC_KEY_B64: &str =
    "BDUcWsKrt/KoOeUnExrEScgAqUD3JEPCDLS5OqWmER0pm+FXwhzClXxkEh0KG4WdLkm9czOJXgXSuMuYlOcrMWw=";

const HOLD_MS_DEFAULT: i64 = 7 * 24 * 3600 * 1000;
const MAX_ADDONS_PER_USER: i64 = 100;
const SIGNS_PER_HOUR: i64 = 30;
const EVENT_MIN_GAP_MS: i64 = 5_000;
const HISTORY_LIMIT: i64 = 50;
const NOTE_MAX_CHARS: usize = 140;
const NAME_MAX_CHARS: usize = 64;
const SIGNATURE_FILE_VERSION: i64 = 1;
/// Время подписи «из будущего» дальше этого допуска — признак подделки или
/// сбитых часов у подписывающего; такая подпись не принимается.
const FUTURE_SKEW_MS: i64 = 10 * 60 * 1000;

// ============================================================================
// Ключи и подпись
// ============================================================================

/// Публичный официальный ключ. Переменная окружения — для тестов: у них свой
/// ключ, приватная часть которого лежит в самом тесте.
pub(crate) fn official_public_key() -> Vec<u8> {
    let raw = std::env::var("ZALI_ADDON_OFFICIAL_PUBKEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| OFFICIAL_PUBLIC_KEY_B64.to_string());
    B64.decode(raw.trim()).unwrap_or_default()
}

fn hold_ms() -> i64 {
    std::env::var("ZALI_ADDON_HOLD_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|secs| *secs >= 0)
        .map(|secs| secs * 1000)
        .unwrap_or(HOLD_MS_DEFAULT)
}

pub(crate) fn fingerprint(public_key: &[u8]) -> String {
    hex(&Sha256::digest(public_key))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn p256_group() -> Result<EcGroup, ErrorStack> {
    EcGroup::from_curve_name(Nid::X9_62_PRIME256V1)
}

/// Сообщение, которое подписывается: порядок и разделители — часть формата,
/// их же собирают клиент (addon_format.js) и инструмент подписи (Python).
pub(crate) fn signature_message(
    kind: &str,
    id: &str,
    version: &str,
    owner: &str,
    digest: &str,
    signed_at: i64,
) -> String {
    format!("zali-addon-sig:v1\n{kind}\n{id}\n{version}\n{owner}\n{digest}\n{signed_at}")
}

/// ES256: подпись «сырая» r‖s (64 байта) — так её выдаёт WebCrypto.
pub(crate) fn verify_es256(public_key: &[u8], message: &[u8], raw_signature: &[u8]) -> bool {
    if raw_signature.len() != 64 || public_key.len() != 65 || public_key[0] != 4 {
        return false;
    }
    let check = || -> Result<bool, ErrorStack> {
        let group = p256_group()?;
        let mut ctx = BigNumContext::new()?;
        let point = EcPoint::from_bytes(&group, public_key, &mut ctx)?;
        let key = EcKey::from_public_key(&group, &point)?;
        key.check_key()?;
        let digest = hash(MessageDigest::sha256(), message)?;
        let r = BigNum::from_slice(&raw_signature[..32])?;
        let s = BigNum::from_slice(&raw_signature[32..])?;
        EcdsaSig::from_private_components(r, s)?.verify(&digest, &key)
    };
    check().unwrap_or(false)
}

fn sign_es256(key: &EcKey<Private>, message: &[u8]) -> Result<Vec<u8>, ErrorStack> {
    let digest = hash(MessageDigest::sha256(), message)?;
    let signature = EcdsaSig::sign(&digest, key)?;
    let mut out = signature.r().to_vec_padded(32)?;
    out.extend(signature.s().to_vec_padded(32)?);
    Ok(out)
}

/// Закрытый серверный ключ «свободной» подписи.
pub(crate) struct AddonSigner {
    key: EcKey<Private>,
    public: Vec<u8>,
    /// Приватная часть официального ключа — только если оператор положил её на
    /// сервер (`addon_official_key.pem` или `ZALI_ADDON_OFFICIAL_KEY_FILE`).
    /// Без неё одобренные заявки выдать нечем: подпись остаётся за офлайн-
    /// инструментом разработчиков.
    official: Option<EcKey<Private>>,
}

impl AddonSigner {
    /// Читает ключ из файла или создаёт его при первом запуске. Ключ нельзя
    /// молча пересоздавать: все выданные подписи перестали бы сходиться, поэтому
    /// невозможность сохранить его — остановка запуска, а не предупреждение.
    pub(crate) fn load_or_create(data_dir: &FsPath) -> Self {
        let path = std::env::var("ZALI_ADDON_SIGNING_KEY_FILE")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| data_dir.join("addon_signing_key.pem"));
        let key = match std::fs::read(&path) {
            Ok(pem) => EcKey::private_key_from_pem(&pem)
                .expect("Ключ подписи аддонов повреждён — файл нельзя разобрать"),
            Err(_) => {
                let group = p256_group().expect("P-256 недоступна");
                let key = EcKey::generate(&group).expect("Не удалось создать ключ подписи аддонов");
                let pem = key.private_key_to_pem().expect("Не удалось записать ключ подписи");
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                {
                    use std::io::Write;
                    // Права задаются при создании: ключ ни на миг не читаем по umask.
                    let mut options = std::fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    options
                        .open(&path)
                        .and_then(|mut file| file.write_all(&pem))
                        .expect("Не удалось сохранить ключ подписи аддонов");
                }
                info!("Создан ключ подписи аддонов: {}", path.display());
                key
            }
        };
        let group = p256_group().expect("P-256 недоступна");
        let mut ctx = BigNumContext::new().expect("BN ctx");
        let public = key
            .public_key()
            .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
            .expect("Не удалось получить публичный ключ подписи");
        let official = Self::load_official(data_dir);
        Self { key, public, official }
    }

    /// Официальный ключ читается, но не создаётся: его публичная часть зашита в
    /// клиенты, и новый ключ ничего бы не подписал. Ключ, не совпавший с
    /// зашитым публичным, не используется — иначе подписи не сходились бы.
    fn load_official(data_dir: &FsPath) -> Option<EcKey<Private>> {
        let path = std::env::var("ZALI_ADDON_OFFICIAL_KEY_FILE")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| data_dir.join("addon_official_key.pem"));
        let pem = std::fs::read(&path).ok()?;
        let key = match EcKey::private_key_from_pem(&pem) {
            Ok(key) => key,
            Err(e) => {
                error!("Официальный ключ подписи аддонов не разобран ({}): {}", path.display(), e);
                return None;
            }
        };
        let group = p256_group().ok()?;
        let mut ctx = BigNumContext::new().ok()?;
        let public = key
            .public_key()
            .to_bytes(&group, PointConversionForm::UNCOMPRESSED, &mut ctx)
            .ok()?;
        if public != official_public_key() {
            warn!(
                "Ключ {} не совпадает с официальным публичным ключом приложения — игнорируется",
                path.display()
            );
            return None;
        }
        info!("Загружен официальный ключ подписи аддонов: {}", path.display());
        Some(key)
    }

    pub(crate) fn public_bytes(&self) -> &[u8] {
        &self.public
    }

    fn can_sign_official(&self) -> bool {
        self.official.is_some()
    }

    fn sign_official(&self, message: &str) -> Option<Result<Vec<u8>, ErrorStack>> {
        self.official.as_ref().map(|key| sign_es256(key, message.as_bytes()))
    }

    fn sign(&self, message: &str) -> Result<Vec<u8>, ErrorStack> {
        sign_es256(&self.key, message.as_bytes())
    }
}

// ============================================================================
// Общие мелочи
// ============================================================================

pub(crate) fn addon_error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "code": code, "message": message }))).into_response()
}

pub(crate) fn internal(context: &str, error: impl std::fmt::Display) -> Response {
    error!("addons: {} err={}", context, error);
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

pub(crate) fn valid_addon_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (3..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && !id.contains("..")
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

pub(crate) fn valid_version(version: &str) -> bool {
    let bytes = version.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
}

pub(crate) fn valid_digest(digest: &str) -> bool {
    digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn clean_line(value: &str, max: usize) -> String {
    let flat: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    trim_limited(flat, max)
}

pub(crate) fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

#[derive(Debug, Clone)]
pub(crate) struct RegistryRow {
    pub(crate) addon_id: String,
    pub(crate) owner: String,
    pub(crate) kind: String,
    pub(crate) key_fp: String,
    pub(crate) name: String,
    pub(crate) claimed_at: i64,
}

pub(crate) async fn load_registry(
    conn: &mut SqliteConnection,
    addon_id: &str,
) -> Result<Option<RegistryRow>, sqlx::Error> {
    let row = sqlx::query_as::<_, (String, String, String, String, String, i64)>(
        "SELECT addon_id, owner, kind, key_fp, name, claimed_at FROM addon_registry WHERE addon_id = ?",
    )
    .bind(addon_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(addon_id, owner, kind, key_fp, name, claimed_at)| RegistryRow {
        addon_id,
        owner,
        kind,
        key_fp,
        name,
        claimed_at,
    }))
}

fn registry_json(row: &RegistryRow) -> Value {
    json!({
        "id": row.addon_id,
        "owner": row.owner,
        "kind": row.kind,
        "keyFingerprint": row.key_fp,
        "name": row.name,
        "claimedAt": row.claimed_at,
    })
}

// ============================================================================
// Ключи и реестр
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct RevokeBody {
    #[serde(rename = "addonId")]
    addon_id: String,
    digest: String,
    #[serde(default)]
    reason: String,
    /// `true` — вернуть сборку (снять отзыв).
    #[serde(default)]
    restore: bool,
}

/// `POST /api/admin/addons/revoke` — оператору: отозвать отпечаток сборки (или вернуть).
pub(crate) async fn admin_revoke_build(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<RevokeBody>,
) -> impl IntoResponse {
    if !crate::operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let digest = body.digest.trim().to_lowercase();
    if !valid_addon_id(&body.addon_id) || !valid_digest(&digest) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_request", "Нужны addonId и digest (64 hex)");
    }
    let result = if body.restore {
        sqlx::query("DELETE FROM addon_revocations WHERE addon_id = ? AND digest = ?")
            .bind(&body.addon_id)
            .bind(&digest)
            .execute(&state.db)
            .await
    } else {
        sqlx::query(
            "INSERT OR REPLACE INTO addon_revocations (addon_id, digest, reason, revoked_at) VALUES (?, ?, ?, ?)",
        )
        .bind(&body.addon_id)
        .bind(&digest)
        .bind(clean_line(&body.reason, REQUEST_NOTE_MAX_CHARS))
        .bind(now_ms())
        .execute(&state.db)
        .await
    };
    match result {
        Ok(_) => {
            if !body.restore {
                crate::addon_store::hide_revoked(&state, &body.addon_id, &digest).await;
            }
            info!("[ADDON] revoke id={} digest={} restore={}", body.addon_id, digest, body.restore);
            Json(json!({ "ok": true, "restored": body.restore })).into_response()
        }
        Err(e) => internal("admin_revoke_build", e),
    }
}

/// `GET /api/addons/signing-key` — публичные ключи для проверки подписей.
/// Без авторизации: проверка нужна и до входа, и это публичные данные.
pub(crate) async fn get_signing_keys(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let official = official_public_key();
    let own = state.addon_signer.public_bytes();
    Json(json!({
        "self": { "publicKey": B64.encode(own), "fingerprint": fingerprint(own) },
        "official": { "publicKey": B64.encode(&official), "fingerprint": fingerprint(&official) },
        "holdDays": hold_ms() / (24 * 3600 * 1000),
    }))
}

/// `GET /api/addons/:id` — кому принадлежит аддон и чьим ключом подписан.
pub(crate) async fn get_registry(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(viewer): AuthenticatedUser,
    Path(addon_id): Path<String>,
) -> impl IntoResponse {
    if !valid_addon_id(&addon_id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    let mut conn = match state.db.acquire().await {
        Ok(conn) => conn,
        Err(e) => return internal("get_registry acquire", e),
    };
    match load_registry(&mut conn, &addon_id).await {
        Ok(Some(row)) => {
            let mut body = registry_json(&row);
            body["registered"] = json!(true);
            // Отозванные сборки: приложение не запускает их и не даёт им ни облака, ни монет.
            let revoked: Vec<String> = sqlx::query_scalar(
                "SELECT digest FROM addon_revocations WHERE addon_id = ? ORDER BY revoked_at",
            )
            .bind(&addon_id)
            .fetch_all(&mut *conn)
            .await
            .unwrap_or_default();
            body["revoked"] = json!(revoked);
            // Сколько этот человек может забрать из аддона прямо сейчас.
            match user_payout_allowance(&mut conn, &addon_id, &viewer, row.kind == "official").await {
                Ok((deposited, available)) => {
                    body["you"] = json!({ "deposited": deposited, "available": available });
                }
                Err(e) => return internal("get_registry allowance", e),
            }
            Json(body).into_response()
        }
        Ok(None) => Json(json!({ "registered": false, "id": addon_id })).into_response(),
        Err(e) => internal("get_registry", e),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct SignRequest {
    id: String,
    version: String,
    /// SHA-256 содержимого, hex (см. `contentDigest` в addon_format.js).
    digest: String,
    #[serde(default)]
    name: String,
    /// `self` (по умолчанию) или `official` — последняя только для одобренной
    /// заявки на ровно эту сборку.
    #[serde(default)]
    kind: String,
}

/// `POST /api/addons/sign` — «свободная» подпись: сервер подписывает отпечаток
/// от имени вошедшего аккаунта и закрепляет за ним `id`.
pub(crate) async fn sign_addon(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Json(body): Json<SignRequest>,
) -> impl IntoResponse {
    let id = body.id.trim().to_string();
    let version = body.version.trim().to_string();
    let digest = body.digest.trim().to_lowercase();
    if !valid_addon_id(&id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "id аддона: 3–64 символа a-z, 0-9, «.», «_», «-»");
    }
    if !valid_version(&version) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_version", "Некорректная версия аддона");
    }
    if !valid_digest(&digest) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_digest", "Нужен SHA-256 содержимого, 64 hex-символа");
    }
    let name = clean_line(&body.name, NAME_MAX_CHARS);
    let want_official = match body.kind.trim() {
        "" | "self" => false,
        "official" => true,
        _ => return addon_error(StatusCode::BAD_REQUEST, "bad_kind", "Вид подписи: self или official"),
    };
    let now = now_ms();

    let result: Result<Response, sqlx::Error> = async {
        // Сколько подписей этот аккаунт выпросил за час: инструмент открыт всем,
        // и без потолка им можно было бы забивать журнал и реестр.
        let recent: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM addon_events WHERE username = ? AND kind = 'sign' AND at > ?",
        )
        .bind(&username)
        .bind(now - 3_600_000)
        .fetch_one(&state.db)
        .await?;
        if recent >= SIGNS_PER_HOUR {
            return Ok(addon_error(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Слишком много подписей за час — попробуйте позже",
            ));
        }

        let mut conn = state.db.acquire().await?;
        let existing = load_registry(&mut conn, &id).await?;
        if want_official {
            return sign_official_build(&state, &mut conn, existing, &username, &id, &version, &digest, &name, now).await;
        }
        match &existing {
            Some(row) if row.kind == "official" => {
                return Ok(addon_error(
                    StatusCode::CONFLICT,
                    "addon_official",
                    "Этот id у официального аддона ZaliMessenger — выберите другой",
                ));
            }
            Some(row) if row.owner != username => {
                return Ok(addon_error(
                    StatusCode::CONFLICT,
                    "addon_taken",
                    &format!(
                        "Этот id закреплён за @{} — выберите другой. Владелец может отвязать его в «Подпись аддонов» → «Управление»",
                        row.owner
                    ),
                ));
            }
            Some(_) => {}
            None => {
                let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM addon_registry WHERE owner = ?")
                    .bind(&username)
                    .fetch_one(&mut *conn)
                    .await?;
                if owned >= MAX_ADDONS_PER_USER {
                    return Ok(addon_error(
                        StatusCode::BAD_REQUEST,
                        "too_many_addons",
                        "За одним аккаунтом может быть не больше 100 аддонов",
                    ));
                }
            }
        }

        let public = state.addon_signer.public_bytes().to_vec();
        let key_fp = fingerprint(&public);
        // INSERT OR IGNORE + проверка владельца ниже: два одновременных запроса
        // на свободный id не могут оба стать владельцами.
        sqlx::query(
            "INSERT OR IGNORE INTO addon_registry
                (addon_id, owner, kind, public_key, key_fp, name, claimed_at, updated_at)
             VALUES (?, ?, 'self', ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&username)
        .bind(B64.encode(&public))
        .bind(&key_fp)
        .bind(&name)
        .bind(now)
        .bind(now)
        .execute(&mut *conn)
        .await?;
        let owner: String = sqlx::query_scalar("SELECT owner FROM addon_registry WHERE addon_id = ?")
            .bind(&id)
            .fetch_one(&mut *conn)
            .await?;
        if owner != username {
            return Ok(addon_error(
                StatusCode::CONFLICT,
                "addon_taken",
                "Этот id уже закреплён за другим автором — выберите другой",
            ));
        }
        sqlx::query("UPDATE addon_registry SET name = ?, updated_at = ? WHERE addon_id = ?")
            .bind(&name)
            .bind(now)
            .bind(&id)
            .execute(&mut *conn)
            .await?;
        sqlx::query("INSERT INTO addon_events (addon_id, username, kind, version, at) VALUES (?, ?, 'sign', ?, ?)")
            .bind(&id)
            .bind(&username)
            .bind(&version)
            .bind(now)
            .execute(&mut *conn)
            .await?;

        let message = signature_message("self", &id, &version, &username, &digest, now);
        let signature = match state.addon_signer.sign(&message) {
            Ok(signature) => signature,
            Err(e) => return Ok(internal("sign_addon", e)),
        };
        info!("[ADDON] signed id={} version={} owner={}", id, version, username);
        Ok(Json(json!({
            "signature": {
                "zaliSignature": SIGNATURE_FILE_VERSION,
                "kind": "self",
                "alg": "ES256",
                "publicKey": B64.encode(&public),
                "id": id,
                "version": version,
                "owner": username,
                "digest": digest,
                "signedAt": now,
                "signature": B64.encode(&signature),
            },
            "registry": { "id": id, "owner": username, "kind": "self", "keyFingerprint": key_fp, "name": name },
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("sign_addon", e))
}

#[derive(Debug, Deserialize)]
pub(crate) struct RegisterOfficialRequest {
    signature: Value,
}

/// Исход записи в реестр: коммитится всегда (отказы возвращаются до транзакции).
struct Registered;

impl CoinTxOutcome for Registered {
    fn commits(&self) -> bool {
        true
    }
}

/// `POST /api/addons/register-official` — внести в реестр аддон с официальной
/// подписью. Вызвать может любой вошедший: подлинность держится на подписи, а не
/// на том, кто её принёс.
pub(crate) async fn register_official(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_username): AuthenticatedUser,
    Json(body): Json<RegisterOfficialRequest>,
) -> impl IntoResponse {
    let sig = &body.signature;
    let text = |key: &str| sig.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let id = text("id");
    let version = text("version");
    let owner = text("owner");
    let digest = text("digest");
    let signed_at = sig.get("signedAt").and_then(Value::as_i64).unwrap_or(0);
    let public = B64.decode(text("publicKey")).unwrap_or_default();
    let raw_signature = B64.decode(text("signature")).unwrap_or_default();

    if text("kind") != "official"
        || text("alg") != "ES256"
        || !valid_addon_id(&id)
        || !valid_version(&version)
        || !valid_digest(&digest)
        || !is_valid_username(&owner)
        || signed_at <= 0
        || signed_at > now_ms() + FUTURE_SKEW_MS
    {
        return addon_error(StatusCode::BAD_REQUEST, "bad_signature", "Подпись повреждена");
    }
    let official = official_public_key();
    if public != official {
        return addon_error(StatusCode::BAD_REQUEST, "bad_signature", "Подпись сделана не официальным ключом");
    }
    let message = signature_message("official", &id, &version, &owner, &digest, signed_at);
    if !verify_es256(&official, message.as_bytes(), &raw_signature) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_signature", "Подпись не сходится");
    }

    let result: Result<Response, sqlx::Error> = async {
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = ?")
            .bind(&owner)
            .fetch_one(&state.db)
            .await?;
        if exists == 0 {
            return Ok(addon_error(
                StatusCode::BAD_REQUEST,
                "owner_unknown",
                "Владельца из подписи нет на этом сервере",
            ));
        }
        let now = now_ms();
        let name = clean_line(&text("name"), NAME_MAX_CHARS);
        let key_fp = fingerprint(&official);
        // Смена владельца и стирание облака — одна транзакция: между ними новый
        // владелец не успевает прочитать данные людей, собранные прежним автором.
        let (tx_id, tx_owner, tx_name, tx_fp, tx_key) =
            (id.clone(), owner.clone(), name.clone(), key_fp.clone(), B64.encode(&official));
        run_immediate_tx(state.db.clone(), move |mut conn| async move {
            let result = async {
                let previous_owner: Option<String> =
                    sqlx::query_scalar("SELECT owner FROM addon_registry WHERE addon_id = ?")
                        .bind(&tx_id)
                        .fetch_optional(&mut *conn)
                        .await?;
                // Официальная подпись перехватывает id у самоподписи и меняет владельца:
                // решение принимает владелец ключа разработчиков, а не очередь заявок.
                sqlx::query(
                    "INSERT INTO addon_registry
                        (addon_id, owner, kind, public_key, key_fp, name, claimed_at, updated_at)
                     VALUES (?, ?, 'official', ?, ?, ?, ?, ?)
                     ON CONFLICT(addon_id) DO UPDATE SET
                        owner = excluded.owner, kind = 'official', public_key = excluded.public_key,
                        key_fp = excluded.key_fp, updated_at = excluded.updated_at,
                        name = CASE WHEN excluded.name = '' THEN addon_registry.name ELSE excluded.name END",
                )
                .bind(&tx_id)
                .bind(&tx_owner)
                .bind(&tx_key)
                .bind(&tx_fp)
                .bind(&tx_name)
                .bind(now)
                .bind(now)
                .execute(&mut *conn)
                .await?;
                if previous_owner.as_deref().map_or(false, |prev| prev != tx_owner) {
                    // Данные пользователей собраны на условиях прежнего автора и новому не переходят.
                    crate::addon_cloud::wipe_addon(&mut *conn, &tx_id).await?;
                }
                Ok(Registered)
            }
            .await;
            (conn, result)
        })
        .await?;
        info!("[ADDON] official registered id={} owner={}", id, owner);
        Ok(Json(json!({
            "registry": { "id": id, "owner": owner, "kind": "official", "keyFingerprint": key_fp },
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("register_official", e))
}

// ============================================================================
// Заявки на официальную подпись
// ============================================================================

const REQUEST_NOTE_MAX_CHARS: usize = 500;
const MAX_PENDING_REQUESTS_PER_USER: i64 = 5;

/// Выдаёт официальную подпись одобренной сборке. Ключ — серверный, но только
/// для (id, версия, отпечаток), которые оператор одобрил вручную.
#[allow(clippy::too_many_arguments)]
async fn sign_official_build(
    state: &Arc<AppState>,
    conn: &mut SqliteConnection,
    existing: Option<RegistryRow>,
    username: &str,
    id: &str,
    version: &str,
    digest: &str,
    name: &str,
    now: i64,
) -> Result<Response, sqlx::Error> {
    let Some(row) = existing else {
        return Ok(addon_error(
            StatusCode::NOT_FOUND,
            "not_registered",
            "Сначала подпишите аддон самоподписью — заявка подаётся на закреплённый за вами аддон",
        ));
    };
    if row.owner != username {
        return Ok(addon_error(StatusCode::FORBIDDEN, "forbidden", "Этот аддон закреплён за другим автором"));
    }
    let approved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM addon_official_requests
         WHERE addon_id = ? AND digest = ? AND version = ? AND owner = ? AND status = 'approved'",
    )
    .bind(id)
    .bind(digest)
    .bind(version)
    .bind(username)
    .fetch_one(&mut *conn)
    .await?;
    if approved == 0 {
        return Ok(addon_error(
            StatusCode::FORBIDDEN,
            "not_approved",
            "Эта сборка не одобрена для официальной подписи — подайте заявку на неё",
        ));
    }
    let message = signature_message("official", id, version, username, digest, now);
    let signature = match state.addon_signer.sign_official(&message) {
        None => {
            return Ok(addon_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "official_unavailable",
                "Сервер пока не может выдавать официальные подписи — сборка одобрена, повторите позже",
            ))
        }
        Some(Err(e)) => return Ok(internal("sign_official_build", e)),
        Some(Ok(signature)) => signature,
    };
    let official = official_public_key();
    let key_fp = fingerprint(&official);
    sqlx::query(
        "UPDATE addon_registry
         SET kind = 'official', public_key = ?, key_fp = ?, updated_at = ?,
             name = CASE WHEN ? = '' THEN name ELSE ? END
         WHERE addon_id = ? AND owner = ?",
    )
    .bind(B64.encode(&official))
    .bind(&key_fp)
    .bind(now)
    .bind(name)
    .bind(name)
    .bind(id)
    .bind(username)
    .execute(&mut *conn)
    .await?;
    sqlx::query("INSERT INTO addon_events (addon_id, username, kind, version, at) VALUES (?, ?, 'sign', ?, ?)")
        .bind(id)
        .bind(username)
        .bind(version)
        .bind(now)
        .execute(&mut *conn)
        .await?;
    info!("[ADDON] official signed id={} version={} owner={}", id, version, username);
    Ok(Json(json!({
        "signature": {
            "zaliSignature": SIGNATURE_FILE_VERSION,
            "kind": "official",
            "alg": "ES256",
            "publicKey": B64.encode(&official),
            "id": id,
            "version": version,
            "owner": username,
            "digest": digest,
            "signedAt": now,
            "signature": B64.encode(&signature),
        },
        "registry": { "id": id, "owner": username, "kind": "official", "keyFingerprint": key_fp },
    }))
    .into_response())
}

fn request_json(
    addon_id: &str,
    version: &str,
    digest: &str,
    status: &str,
    note: &str,
    decision_note: &str,
    created_at: i64,
    decided_at: i64,
) -> Value {
    json!({
        "addonId": addon_id, "version": version, "digest": digest, "status": status,
        "note": note, "decisionNote": decision_note,
        "createdAt": created_at, "decidedAt": decided_at,
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct OfficialRequestBody {
    version: String,
    digest: String,
    #[serde(default)]
    note: String,
}

/// `POST /api/addons/:id/official-request` — автор просит одобрить конкретную
/// сборку для официальной подписи. Рассматривает оператор вручную.
pub(crate) async fn request_official(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Json(body): Json<OfficialRequestBody>,
) -> impl IntoResponse {
    let version = body.version.trim().to_string();
    let digest = body.digest.trim().to_lowercase();
    if !valid_addon_id(&addon_id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    if !valid_version(&version) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_version", "Некорректная версия аддона");
    }
    if !valid_digest(&digest) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_digest", "Нужен SHA-256 содержимого, 64 hex-символа");
    }
    let note = trim_limited(
        body.note.chars().map(|c| if c == '\n' || !c.is_control() { c } else { ' ' }).collect::<String>(),
        REQUEST_NOTE_MAX_CHARS,
    );
    let now = now_ms();
    let result: Result<Response, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        let Some(row) = load_registry(&mut conn, &addon_id).await? else {
            return Ok(addon_error(
                StatusCode::NOT_FOUND,
                "not_registered",
                "Сначала подпишите аддон самоподписью — заявка подаётся на закреплённый за вами аддон",
            ));
        };
        if row.owner != username {
            return Ok(addon_error(StatusCode::FORBIDDEN, "forbidden", "Этот аддон закреплён за другим автором"));
        }
        let existing = sqlx::query_as::<_, (String, String, String, i64, i64)>(
            "SELECT status, note, decision_note, created_at, decided_at FROM addon_official_requests
             WHERE addon_id = ? AND digest = ?",
        )
        .bind(&addon_id)
        .bind(&digest)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some((status, old_note, decision_note, created_at, decided_at)) = &existing {
            if status != "rejected" {
                // Повторная заявка на ту же сборку ничего не меняет: возвращаем
                // как есть, чтобы клиент мог показать текущее состояние.
                return Ok(Json(request_json(
                    &addon_id, &version, &digest, status, old_note, decision_note, *created_at, *decided_at,
                ))
                .into_response());
            }
        }
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM addon_official_requests WHERE owner = ? AND status = 'pending'",
        )
        .bind(&username)
        .fetch_one(&mut *conn)
        .await?;
        if pending >= MAX_PENDING_REQUESTS_PER_USER {
            return Ok(addon_error(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_requests",
                "Уже есть пять заявок на рассмотрении — дождитесь решения",
            ));
        }
        sqlx::query(
            "INSERT INTO addon_official_requests
                (addon_id, version, digest, owner, note, status, decision_note, created_at, decided_at)
             VALUES (?, ?, ?, ?, ?, 'pending', '', ?, 0)
             ON CONFLICT(addon_id, digest) DO UPDATE SET
                version = excluded.version, note = excluded.note, status = 'pending',
                decision_note = '', created_at = excluded.created_at, decided_at = 0",
        )
        .bind(&addon_id)
        .bind(&version)
        .bind(&digest)
        .bind(&username)
        .bind(&note)
        .bind(now)
        .execute(&mut *conn)
        .await?;
        info!("[ADDON] official requested id={} version={} owner={}", addon_id, version, username);
        Ok((
            StatusCode::CREATED,
            Json(request_json(&addon_id, &version, &digest, "pending", &note, "", now, 0)),
        )
            .into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("request_official", e))
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct RequestListQuery {
    status: Option<String>,
}

/// `GET /api/admin/addons/requests` — очередь заявок для оператора
/// (`RELEASE_ADMIN_TOKEN`). По умолчанию — только ожидающие.
pub(crate) async fn admin_list_requests(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<RequestListQuery>,
) -> impl IntoResponse {
    if !crate::operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let status = q.status.as_deref().map(str::trim).unwrap_or("pending");
    let rows = sqlx::query_as::<_, (String, String, String, String, String, String, String, i64, i64)>(
        "SELECT addon_id, version, digest, owner, note, status, decision_note, created_at, decided_at
         FROM addon_official_requests WHERE (? = 'all' OR status = ?)
         ORDER BY created_at DESC LIMIT 200",
    )
    .bind(status)
    .bind(status)
    .fetch_all(&state.db)
    .await;
    match rows {
        Ok(rows) => Json(json!({
            "requests": rows.into_iter().map(|(addon_id, version, digest, owner, note, status, decision_note, created_at, decided_at)| {
                let mut v = request_json(&addon_id, &version, &digest, &status, &note, &decision_note, created_at, decided_at);
                v["owner"] = json!(owner);
                v
            }).collect::<Vec<_>>(),
            "signerReady": state.addon_signer.can_sign_official(),
        }))
        .into_response(),
        Err(e) => internal("admin_list_requests", e),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct DecideBody {
    #[serde(rename = "addonId")]
    addon_id: String,
    digest: String,
    /// `approve` или `reject`.
    decision: String,
    #[serde(default)]
    note: String,
}

/// `POST /api/admin/addons/requests/decide` — решение оператора по заявке.
pub(crate) async fn admin_decide_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<DecideBody>,
) -> impl IntoResponse {
    if !crate::operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let status = match body.decision.trim() {
        "approve" => "approved",
        "reject" => "rejected",
        _ => return addon_error(StatusCode::BAD_REQUEST, "bad_request", "decision: approve или reject"),
    };
    let digest = body.digest.trim().to_lowercase();
    if !valid_addon_id(&body.addon_id) || !valid_digest(&digest) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_request", "Нужны addonId и digest");
    }
    let note = clean_line(&body.note, REQUEST_NOTE_MAX_CHARS);
    let now = now_ms();
    let updated = sqlx::query_as::<_, (String, String)>(
        "UPDATE addon_official_requests SET status = ?, decision_note = ?, decided_at = ?
         WHERE addon_id = ? AND digest = ? RETURNING owner, version",
    )
    .bind(status)
    .bind(&note)
    .bind(now)
    .bind(&body.addon_id)
    .bind(&digest)
    .fetch_optional(&state.db)
    .await;
    match updated {
        Ok(Some((owner, version))) => {
            info!("[ADDON] official request id={} version={} -> {}", body.addon_id, version, status);
            send_json_to_user(
                &state,
                &owner,
                json!({
                    "type": "addon_official", "addonId": body.addon_id, "version": version,
                    "status": status, "note": note,
                }),
            )
            .await;
            Json(json!({ "ok": true, "status": status, "owner": owner, "version": version })).into_response()
        }
        Ok(None) => addon_error(StatusCode::NOT_FOUND, "not_found", "Такой заявки нет"),
        Err(e) => internal("admin_decide_request", e),
    }
}

// ============================================================================
// Казна аддона
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TreasurySummary {
    pub(crate) balance: i64,
    pub(crate) withdrawable: i64,
    /// Время (мс) и сумма ближайшего созревания; `None` — ждать нечего.
    pub(crate) next_unlock: Option<(i64, i64)>,
}

async fn treasury_summary(
    conn: &mut SqliteConnection,
    addon_id: &str,
    now: i64,
) -> Result<TreasurySummary, sqlx::Error> {
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM addon_treasuries WHERE addon_id = ?")
        .bind(addon_id)
        .fetch_optional(&mut *conn)
        .await?
        .unwrap_or(0);
    let cutoff = now - hold_ms();
    let matured: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM addon_coin_ops
         WHERE addon_id = ? AND kind = 'deposit' AND created_ms <= ?",
    )
    .bind(addon_id)
    .bind(cutoff)
    .fetch_one(&mut *conn)
    .await?;
    let withdrawn: i64 = sqlx::query_scalar(
        // Выплаты пользователям тоже уменьшают то, что можно забрать разработчику:
        // неизвестно, какого возраста взносы они вернули, — считаем с запасом.
        "SELECT COALESCE(SUM(amount), 0) FROM addon_coin_ops
         WHERE addon_id = ? AND kind IN ('withdraw', 'payout')",
    )
    .bind(addon_id)
    .fetch_one(&mut *conn)
    .await?;
    let withdrawable = (matured - withdrawn).clamp(0, balance.max(0));
    let next = sqlx::query_as::<_, (i64, i64)>(
        "SELECT created_ms, amount FROM addon_coin_ops
         WHERE addon_id = ? AND kind = 'deposit' AND created_ms > ?
         ORDER BY created_ms ASC LIMIT 1",
    )
    .bind(addon_id)
    .bind(cutoff)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(TreasurySummary {
        balance,
        withdrawable,
        next_unlock: next.map(|(created, amount)| (created + hold_ms(), amount)),
    })
}

async fn user_balance(conn: &mut SqliteConnection, username: &str) -> i64 {
    sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
        .bind(username)
        .fetch_optional(&mut *conn)
        .await
        .ok()
        .flatten()
        .unwrap_or(0)
}

#[derive(Debug)]
enum DepositOutcome {
    Done { balance: i64, treasury: i64 },
    Replayed { balance: i64, treasury: i64 },
    NotRegistered,
    InsufficientFunds,
}

impl CoinTxOutcome for DepositOutcome {
    fn commits(&self) -> bool {
        matches!(self, DepositOutcome::Done { .. })
    }
}

async fn apply_deposit(
    conn: &mut SqliteConnection,
    addon_id: &str,
    username: &str,
    amount: i64,
    note: &str,
    idempotency_key: &str,
) -> Result<DepositOutcome, sqlx::Error> {
    let replay: Option<String> = sqlx::query_scalar(
        "SELECT id FROM addon_coin_ops WHERE username = ? AND kind = 'deposit' AND idempotency_key = ?",
    )
    .bind(username)
    .bind(idempotency_key)
    .fetch_optional(&mut *conn)
    .await?;
    if replay.is_some() {
        let treasury: i64 = sqlx::query_scalar("SELECT balance FROM addon_treasuries WHERE addon_id = ?")
            .bind(addon_id)
            .fetch_optional(&mut *conn)
            .await?
            .unwrap_or(0);
        let balance = user_balance(conn, username).await;
        return Ok(DepositOutcome::Replayed { balance, treasury });
    }
    // Реестр читается внутри транзакции: перевод не должен уйти аддону, которого
    // уже нет (или который успели «разжаловать»).
    if load_registry(conn, addon_id).await?.is_none() {
        return Ok(DepositOutcome::NotRegistered);
    }
    let debited = sqlx::query(
        "UPDATE coin_balances SET balance = balance - ? WHERE username = ? AND balance >= ?",
    )
    .bind(amount)
    .bind(username)
    .bind(amount)
    .execute(&mut *conn)
    .await?;
    if debited.rows_affected() != 1 {
        return Ok(DepositOutcome::InsufficientFunds);
    }
    sqlx::query(
        "INSERT INTO addon_treasuries (addon_id, balance) VALUES (?, ?)
         ON CONFLICT(addon_id) DO UPDATE SET balance = balance + excluded.balance",
    )
    .bind(addon_id)
    .bind(amount)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO addon_coin_ops (id, addon_id, kind, username, amount, note, idempotency_key, created_ms)
         VALUES (?, ?, 'deposit', ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(addon_id)
    .bind(username)
    .bind(amount)
    .bind(note)
    .bind(idempotency_key)
    .bind(now_ms())
    .execute(&mut *conn)
    .await?;
    let treasury: i64 = sqlx::query_scalar("SELECT balance FROM addon_treasuries WHERE addon_id = ?")
        .bind(addon_id)
        .fetch_one(&mut *conn)
        .await?;
    let balance = user_balance(conn, username).await;
    Ok(DepositOutcome::Done { balance, treasury })
}

#[derive(Debug, Deserialize)]
pub(crate) struct DepositRequest {
    amount: i64,
    #[serde(default)]
    note: Option<String>,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
}

/// `POST /api/addons/:id/deposit` — перевести свои ZaliCoin на баланс аддона.
pub(crate) async fn deposit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Json(body): Json<DepositRequest>,
) -> impl IntoResponse {
    let key = trim_limited(&body.idempotency_key, 128);
    if !valid_addon_id(&addon_id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    // Отозванной сборке деньги больше не несут; вернуть своё можно всегда (payout).
    if crate::addon_cloud::digest_revoked(&state, &headers, &addon_id).await {
        return addon_error(
            StatusCode::FORBIDDEN,
            "revoked",
            "Эта сборка аддона отозвана: обновите аддон до новой версии",
        );
    }
    if key.is_empty() {
        return addon_error(StatusCode::BAD_REQUEST, "bad_request", "Ключ операции обязателен");
    }
    if body.amount <= 0 || body.amount > ZALICOIN_TOTAL_SUPPLY {
        return addon_error(StatusCode::BAD_REQUEST, "bad_amount", "Сумма должна быть больше нуля");
    }
    let note = clean_line(body.note.as_deref().unwrap_or(""), NOTE_MAX_CHARS);

    let tx_addon = addon_id.clone();
    let tx_user = username.clone();
    let tx_note = note.clone();
    let amount = body.amount;
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result = apply_deposit(&mut conn, &tx_addon, &tx_user, amount, &tx_note, &key).await;
        (conn, result)
    })
    .await;

    match outcome {
        Ok(DepositOutcome::Done { balance, treasury }) => {
            info!("[ADDON] deposit addon={} from={} amount={}", addon_id, username, amount);
            if let Ok(mut conn) = state.db.acquire().await {
                if let Ok(Some(row)) = load_registry(&mut conn, &addon_id).await {
                    send_json_to_user(
                        &state,
                        &row.owner,
                        json!({
                            "type": "addon_coins", "kind": "deposit", "addonId": addon_id,
                            "from": username, "amount": amount, "treasury": treasury,
                        }),
                    )
                    .await;
                }
            }
            (StatusCode::CREATED, Json(json!({ "balance": balance, "treasury": treasury, "amount": amount }))).into_response()
        }
        Ok(DepositOutcome::Replayed { balance, treasury }) => {
            Json(json!({ "balance": balance, "treasury": treasury, "amount": amount, "replayed": true })).into_response()
        }
        Ok(DepositOutcome::NotRegistered) => addon_error(
            StatusCode::NOT_FOUND,
            "not_registered",
            "Этот аддон не подписан — переводить ему нельзя",
        ),
        Ok(DepositOutcome::InsufficientFunds) => addon_error(
            StatusCode::BAD_REQUEST,
            "insufficient_funds",
            "Недостаточно ZaliCoin на вашем балансе",
        ),
        Err(e) => internal("deposit", e),
    }
}

#[derive(Debug)]
enum WithdrawOutcome {
    Done { balance: i64, summary: TreasurySummary },
    Replayed { balance: i64, summary: TreasurySummary },
    NotRegistered,
    NotOwner,
    Locked(TreasurySummary),
}

impl CoinTxOutcome for WithdrawOutcome {
    fn commits(&self) -> bool {
        matches!(self, WithdrawOutcome::Done { .. })
    }
}

async fn apply_withdraw(
    conn: &mut SqliteConnection,
    addon_id: &str,
    username: &str,
    amount: i64,
    idempotency_key: &str,
) -> Result<WithdrawOutcome, sqlx::Error> {
    let now = now_ms();
    let replay: Option<String> = sqlx::query_scalar(
        "SELECT id FROM addon_coin_ops WHERE username = ? AND kind = 'withdraw' AND idempotency_key = ?",
    )
    .bind(username)
    .bind(idempotency_key)
    .fetch_optional(&mut *conn)
    .await?;
    if replay.is_some() {
        let summary = treasury_summary(conn, addon_id, now).await?;
        let balance = user_balance(conn, username).await;
        return Ok(WithdrawOutcome::Replayed { balance, summary });
    }
    let Some(registry) = load_registry(conn, addon_id).await? else {
        return Ok(WithdrawOutcome::NotRegistered);
    };
    if registry.owner != username {
        return Ok(WithdrawOutcome::NotOwner);
    }
    let summary = treasury_summary(conn, addon_id, now).await?;
    if amount > summary.withdrawable {
        return Ok(WithdrawOutcome::Locked(summary));
    }
    let debited = sqlx::query(
        "UPDATE addon_treasuries SET balance = balance - ? WHERE addon_id = ? AND balance >= ?",
    )
    .bind(amount)
    .bind(addon_id)
    .bind(amount)
    .execute(&mut *conn)
    .await?;
    if debited.rows_affected() != 1 {
        return Ok(WithdrawOutcome::Locked(summary));
    }
    sqlx::query(
        "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
         ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
    )
    .bind(username)
    .bind(amount)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO addon_coin_ops (id, addon_id, kind, username, amount, note, idempotency_key, created_ms)
         VALUES (?, ?, 'withdraw', ?, ?, '', ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(addon_id)
    .bind(username)
    .bind(amount)
    .bind(idempotency_key)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    let summary = treasury_summary(conn, addon_id, now).await?;
    let balance = user_balance(conn, username).await;
    Ok(WithdrawOutcome::Done { balance, summary })
}

fn summary_json(summary: &TreasurySummary) -> Value {
    json!({
        "balance": summary.balance,
        "withdrawable": summary.withdrawable,
        "locked": summary.balance - summary.withdrawable,
        "holdDays": hold_ms() / (24 * 3600 * 1000),
        "nextUnlock": summary.next_unlock.map(|(at, amount)| json!({ "at": at, "amount": amount })),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct WithdrawRequest {
    amount: i64,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
}

/// `POST /api/addons/:id/withdraw` — владелец забирает на свой баланс то, что
/// пролежало в казне дольше недели.
pub(crate) async fn withdraw(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Json(body): Json<WithdrawRequest>,
) -> impl IntoResponse {
    let key = trim_limited(&body.idempotency_key, 128);
    if !valid_addon_id(&addon_id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    if key.is_empty() {
        return addon_error(StatusCode::BAD_REQUEST, "bad_request", "Ключ операции обязателен");
    }
    if body.amount <= 0 || body.amount > ZALICOIN_TOTAL_SUPPLY {
        return addon_error(StatusCode::BAD_REQUEST, "bad_amount", "Сумма должна быть больше нуля");
    }
    let tx_addon = addon_id.clone();
    let tx_user = username.clone();
    let amount = body.amount;
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result = apply_withdraw(&mut conn, &tx_addon, &tx_user, amount, &key).await;
        (conn, result)
    })
    .await;
    match outcome {
        Ok(WithdrawOutcome::Done { balance, summary }) => {
            info!("[ADDON] withdraw addon={} by={} amount={}", addon_id, username, amount);
            (StatusCode::CREATED, Json(json!({ "balance": balance, "treasury": summary_json(&summary), "amount": amount })))
                .into_response()
        }
        Ok(WithdrawOutcome::Replayed { balance, summary }) => {
            Json(json!({ "balance": balance, "treasury": summary_json(&summary), "amount": amount, "replayed": true }))
                .into_response()
        }
        Ok(WithdrawOutcome::NotRegistered) => {
            addon_error(StatusCode::NOT_FOUND, "not_registered", "Такого аддона нет в реестре")
        }
        // Чужой и несуществующий неразличимы: чужую казну не должно быть видно.
        Ok(WithdrawOutcome::NotOwner) => {
            addon_error(StatusCode::FORBIDDEN, "forbidden", "Выводить из казны может только автор аддона")
        }
        Ok(WithdrawOutcome::Locked(summary)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "code": "locked",
                "message": "Доступно к выводу только то, что внесено больше недели назад",
                "treasury": summary_json(&summary),
            })),
        )
            .into_response(),
        Err(e) => internal("withdraw", e),
    }
}

// ============================================================================
// Вывод пользователем
// ============================================================================

#[derive(Debug)]
enum PayoutOutcome {
    Done { balance: i64, remaining: i64 },
    Replayed { balance: i64, remaining: i64 },
    NotRegistered,
    /// Просили больше, чем можно: `allowed` — сколько можно забрать сейчас.
    OverLimit { allowed: i64 },
}

impl CoinTxOutcome for PayoutOutcome {
    fn commits(&self) -> bool {
        matches!(self, PayoutOutcome::Done { .. })
    }
}

/// Сколько человек может забрать из аддона прямо сейчас: переведённое им самим
/// за вычетом уже полученного. У официального аддона — любая сумма из казны
/// (призы), у остальных чужие деньги достаться не могут.
async fn user_payout_allowance(
    conn: &mut SqliteConnection,
    addon_id: &str,
    username: &str,
    official: bool,
) -> Result<(i64, i64), sqlx::Error> {
    let treasury: i64 = sqlx::query_scalar("SELECT balance FROM addon_treasuries WHERE addon_id = ?")
        .bind(addon_id)
        .fetch_optional(&mut *conn)
        .await?
        .unwrap_or(0);
    let net: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(CASE kind WHEN 'deposit' THEN amount WHEN 'payout' THEN -amount ELSE 0 END), 0)
         FROM addon_coin_ops WHERE addon_id = ? AND username = ? AND kind IN ('deposit', 'payout')",
    )
    .bind(addon_id)
    .bind(username)
    .fetch_one(&mut *conn)
    .await?;
    let own = net.max(0);
    let allowed = if official { treasury } else { own.min(treasury) };
    Ok((own, allowed.max(0)))
}

async fn apply_payout(
    conn: &mut SqliteConnection,
    addon_id: &str,
    username: &str,
    amount: i64,
    idempotency_key: &str,
) -> Result<PayoutOutcome, sqlx::Error> {
    let replay: Option<String> = sqlx::query_scalar(
        "SELECT id FROM addon_coin_ops WHERE username = ? AND kind = 'payout' AND idempotency_key = ?",
    )
    .bind(username)
    .bind(idempotency_key)
    .fetch_optional(&mut *conn)
    .await?;
    let registry = load_registry(conn, addon_id).await?;
    let official = registry.as_ref().map(|r| r.kind == "official").unwrap_or(false);
    if replay.is_some() {
        let (_, allowed) = user_payout_allowance(conn, addon_id, username, official).await?;
        let balance = user_balance(conn, username).await;
        return Ok(PayoutOutcome::Replayed { balance, remaining: allowed });
    }
    if registry.is_none() {
        return Ok(PayoutOutcome::NotRegistered);
    }
    let (_, allowed) = user_payout_allowance(conn, addon_id, username, official).await?;
    if amount > allowed {
        return Ok(PayoutOutcome::OverLimit { allowed });
    }
    let debited = sqlx::query(
        "UPDATE addon_treasuries SET balance = balance - ? WHERE addon_id = ? AND balance >= ?",
    )
    .bind(amount)
    .bind(addon_id)
    .bind(amount)
    .execute(&mut *conn)
    .await?;
    if debited.rows_affected() != 1 {
        return Ok(PayoutOutcome::OverLimit { allowed: 0 });
    }
    sqlx::query(
        "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
         ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
    )
    .bind(username)
    .bind(amount)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO addon_coin_ops (id, addon_id, kind, username, amount, note, idempotency_key, created_ms)
         VALUES (?, ?, 'payout', ?, ?, '', ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(addon_id)
    .bind(username)
    .bind(amount)
    .bind(idempotency_key)
    .bind(now_ms())
    .execute(&mut *conn)
    .await?;
    let (_, remaining) = user_payout_allowance(conn, addon_id, username, official).await?;
    let balance = user_balance(conn, username).await;
    Ok(PayoutOutcome::Done { balance, remaining })
}

/// `POST /api/addons/:id/payout` — человек забирает из аддона на свой баланс.
/// Это не вывод разработчика: недельного удержания здесь нет, но и чужого не
/// достать — только переведённое самим человеком (у официального аддона —
/// ещё и то, что аддон решил ему выплатить).
pub(crate) async fn payout(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Json(body): Json<WithdrawRequest>,
) -> impl IntoResponse {
    let key = trim_limited(&body.idempotency_key, 128);
    if !valid_addon_id(&addon_id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    if key.is_empty() {
        return addon_error(StatusCode::BAD_REQUEST, "bad_request", "Ключ операции обязателен");
    }
    if body.amount <= 0 || body.amount > ZALICOIN_TOTAL_SUPPLY {
        return addon_error(StatusCode::BAD_REQUEST, "bad_amount", "Сумма должна быть больше нуля");
    }
    let tx_addon = addon_id.clone();
    let tx_user = username.clone();
    let amount = body.amount;
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result = apply_payout(&mut conn, &tx_addon, &tx_user, amount, &key).await;
        (conn, result)
    })
    .await;
    match outcome {
        Ok(PayoutOutcome::Done { balance, remaining }) => {
            info!("[ADDON] payout addon={} to={} amount={}", addon_id, username, amount);
            (StatusCode::CREATED, Json(json!({ "balance": balance, "amount": amount, "available": remaining })))
                .into_response()
        }
        Ok(PayoutOutcome::Replayed { balance, remaining }) => {
            Json(json!({ "balance": balance, "amount": amount, "available": remaining, "replayed": true }))
                .into_response()
        }
        Ok(PayoutOutcome::NotRegistered) => {
            addon_error(StatusCode::NOT_FOUND, "not_registered", "Такого аддона нет в реестре")
        }
        Ok(PayoutOutcome::OverLimit { allowed }) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "code": "over_limit",
                "message": "Можно забрать не больше, чем вы сами перевели этому аддону",
                "available": allowed,
            })),
        )
            .into_response(),
        Err(e) => internal("payout", e),
    }
}

// ============================================================================
// Статистика и управление
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct EventRequest {
    kind: String,
    #[serde(default)]
    version: String,
}

/// `POST /api/addons/:id/events` — установка, обновление, запуск, удаление.
/// Пишется только для аддонов из реестра: об остальных сервер ничего не знает.
pub(crate) async fn record_event(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Json(body): Json<EventRequest>,
) -> impl IntoResponse {
    let kind = body.kind.trim();
    if !valid_addon_id(&addon_id) || !matches!(kind, "install" | "update" | "launch" | "remove") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let version = if valid_version(body.version.trim()) { body.version.trim().to_string() } else { String::new() };
    let now = now_ms();
    let result: Result<StatusCode, sqlx::Error> = async {
        let registered: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM addon_registry WHERE addon_id = ?")
            .bind(&addon_id)
            .fetch_one(&state.db)
            .await?;
        if registered == 0 {
            return Ok(StatusCode::NO_CONTENT);
        }
        let recent: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM addon_events WHERE addon_id = ? AND username = ? AND kind = ? AND at > ?",
        )
        .bind(&addon_id)
        .bind(&username)
        .bind(kind)
        .bind(now - EVENT_MIN_GAP_MS)
        .fetch_one(&state.db)
        .await?;
        if recent > 0 {
            return Ok(StatusCode::NO_CONTENT);
        }
        sqlx::query("INSERT INTO addon_events (addon_id, username, kind, version, at) VALUES (?, ?, ?, ?, ?)")
            .bind(&addon_id)
            .bind(&username)
            .bind(kind)
            .bind(&version)
            .bind(now)
            .execute(&state.db)
            .await?;
        Ok(StatusCode::NO_CONTENT)
    }
    .await;
    match result {
        Ok(status) => status.into_response(),
        Err(e) => internal("record_event", e),
    }
}

async fn stats_json(conn: &mut SqliteConnection, addon_id: &str, now: i64) -> Result<Value, sqlx::Error> {
    let day = 24 * 3600 * 1000_i64;
    let installs: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT e.username) FROM (
            SELECT username, MAX(at) AS last FROM addon_events
            WHERE addon_id = ? AND kind IN ('install', 'update', 'launch', 'remove')
            GROUP BY username
         ) t JOIN addon_events e
            ON e.addon_id = ? AND e.username = t.username AND e.at = t.last
         WHERE e.kind != 'remove'",
    )
    .bind(addon_id)
    .bind(addon_id)
    .fetch_one(&mut *conn)
    .await?;
    let ever_installed: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT username) FROM addon_events
         WHERE addon_id = ? AND kind IN ('install', 'update', 'launch')",
    )
    .bind(addon_id)
    .fetch_one(&mut *conn)
    .await?;
    let count_launches = |since: i64| {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM addon_events WHERE addon_id = ? AND kind = 'launch' AND at > ?",
        )
        .bind(addon_id.to_string())
        .bind(since)
    };
    let launches_7d = count_launches(now - 7 * day).fetch_one(&mut *conn).await?;
    let launches_30d = count_launches(now - 30 * day).fetch_one(&mut *conn).await?;
    let launches_total = count_launches(0).fetch_one(&mut *conn).await?;
    let users_7d: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT username) FROM addon_events WHERE addon_id = ? AND kind = 'launch' AND at > ?",
    )
    .bind(addon_id)
    .bind(now - 7 * day)
    .fetch_one(&mut *conn)
    .await?;
    let users_30d: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT username) FROM addon_events WHERE addon_id = ? AND kind = 'launch' AND at > ?",
    )
    .bind(addon_id)
    .bind(now - 30 * day)
    .fetch_one(&mut *conn)
    .await?;
    let daily = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS d, COUNT(*), COUNT(DISTINCT username)
         FROM addon_events WHERE addon_id = ? AND kind = 'launch' AND at > ?
         GROUP BY d ORDER BY d ASC",
    )
    .bind(addon_id)
    .bind(now - 14 * day)
    .fetch_all(&mut *conn)
    .await?;
    Ok(json!({
        "installs": installs,
        "everInstalled": ever_installed,
        "launches7d": launches_7d,
        "launches30d": launches_30d,
        "launchesTotal": launches_total,
        "users7d": users_7d,
        "users30d": users_30d,
        "daily": daily.into_iter()
            .map(|(day, launches, users)| json!({ "day": day, "launches": launches, "users": users }))
            .collect::<Vec<_>>(),
    }))
}

/// Итог отвязки `id` (в транзакции: либо всё, либо ничего).
enum UnbindOutcome {
    Done,
    NotRegistered,
    NotOwner,
    Official,
    Funds(i64),
}

impl CoinTxOutcome for UnbindOutcome {
    fn commits(&self) -> bool {
        matches!(self, UnbindOutcome::Done)
    }
}

/// `POST /api/addons/:id/unbind` — владелец снимает закрепление `id`.
///
/// Пока `id` закреплён, другой автор не может подписать аддон с таким же `id`
/// (409 `addon_taken`). Отвязав его, владелец отпускает имя: следующий подписавший
/// станет новым владельцем. Чтобы это не стало способом забрать чужое:
///
/// - в казне должно быть пусто — иначе вклады людей достались бы новому владельцу;
/// - журнал вкладов, статистика и заявки уходят в архив (`<id>#unbound-<время>`),
///   так что новый владелец начинает с нуля, а «доступно к возврату» старых
///   вкладчиков не может утянуть его казну;
/// - облако аддона стирается: данные собраны на условиях прежнего автора;
/// - официальный `id` отвязывает только оператор — владельцу нельзя.
pub(crate) async fn unbind_addon(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
) -> impl IntoResponse {
    if !valid_addon_id(&addon_id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    let tx_addon = addon_id.clone();
    let tx_user = username.clone();
    let archived = format!("{}#unbound-{}", addon_id, now_ms());
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result = async {
            let Some(row) = load_registry(&mut conn, &tx_addon).await? else {
                return Ok(UnbindOutcome::NotRegistered);
            };
            if row.owner != tx_user {
                return Ok(UnbindOutcome::NotOwner);
            }
            if row.kind == "official" {
                return Ok(UnbindOutcome::Official);
            }
            let balance: i64 = sqlx::query_scalar("SELECT balance FROM addon_treasuries WHERE addon_id = ?")
                .bind(&tx_addon)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or(0);
            if balance > 0 {
                return Ok(UnbindOutcome::Funds(balance));
            }
            for table in ["addon_coin_ops", "addon_events", "addon_official_requests"] {
                sqlx::query(&format!("UPDATE {table} SET addon_id = ? WHERE addon_id = ?"))
                    .bind(&archived)
                    .bind(&tx_addon)
                    .execute(&mut *conn)
                    .await?;
            }
            sqlx::query("DELETE FROM addon_treasuries WHERE addon_id = ?")
                .bind(&tx_addon)
                .execute(&mut *conn)
                .await?;
            sqlx::query("DELETE FROM addon_registry WHERE addon_id = ?")
                .bind(&tx_addon)
                .execute(&mut *conn)
                .await?;
            // Облако стирается в той же транзакции: id освобождается вместе с данными.
            crate::addon_cloud::wipe_addon(&mut *conn, &tx_addon).await?;
            Ok(UnbindOutcome::Done)
        }
        .await;
        (conn, result)
    })
    .await;
    match outcome {
        Ok(UnbindOutcome::Done) => {
            info!("[ADDON] unbound id={} by={}", addon_id, username);
            Json(json!({ "ok": true, "id": addon_id })).into_response()
        }
        Ok(UnbindOutcome::NotRegistered) => addon_error(StatusCode::NOT_FOUND, "not_registered", "Этот id ни за кем не закреплён"),
        Ok(UnbindOutcome::NotOwner) => addon_error(StatusCode::FORBIDDEN, "forbidden", "Отвязать id может только его владелец"),
        Ok(UnbindOutcome::Official) => addon_error(
            StatusCode::FORBIDDEN,
            "addon_official",
            "Официальный id отвязывают только разработчики ZaliMessenger",
        ),
        Ok(UnbindOutcome::Funds(balance)) => addon_error(
            StatusCode::CONFLICT,
            "treasury_not_empty",
            &format!("В казне аддона {balance} ZC: сначала верните их людям и выведите — потом отвязывайте id"),
        ),
        Err(e) => internal("unbind_addon", e),
    }
}

/// `GET /api/addons/:id/manage` — казна и статистика; только владельцу.
pub(crate) async fn manage_addon(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
) -> impl IntoResponse {
    if !valid_addon_id(&addon_id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    let result: Result<Response, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        let Some(row) = load_registry(&mut conn, &addon_id).await? else {
            return Ok(addon_error(StatusCode::NOT_FOUND, "not_found", "Аддона нет в реестре"));
        };
        // Для не-владельца ответ тот же, что для несуществующего: что у чужого
        // аддона есть казна и сколько в ней, знать никому не нужно.
        if row.owner != username {
            return Ok(addon_error(StatusCode::NOT_FOUND, "not_found", "Аддона нет в реестре"));
        }
        let now = now_ms();
        let summary = treasury_summary(&mut conn, &addon_id, now).await?;
        let deposits = sqlx::query_as::<_, (String, i64, String, i64)>(
            "SELECT username, amount, note, created_ms FROM addon_coin_ops
             WHERE addon_id = ? AND kind = 'deposit' ORDER BY created_ms DESC LIMIT ?",
        )
        .bind(&addon_id)
        .bind(HISTORY_LIMIT)
        .fetch_all(&mut *conn)
        .await?;
        let withdrawals = sqlx::query_as::<_, (i64, i64)>(
            "SELECT amount, created_ms FROM addon_coin_ops
             WHERE addon_id = ? AND kind = 'withdraw' ORDER BY created_ms DESC LIMIT ?",
        )
        .bind(&addon_id)
        .bind(HISTORY_LIMIT)
        .fetch_all(&mut *conn)
        .await?;
        let stats = stats_json(&mut conn, &addon_id, now).await?;
        let paid_out: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(amount), 0) FROM addon_coin_ops WHERE addon_id = ? AND kind = 'payout'",
        )
        .bind(&addon_id)
        .fetch_one(&mut *conn)
        .await?;
        Ok(Json(json!({
            "addon": registry_json(&row),
            "paidOut": paid_out,
            "treasury": summary_json(&summary),
            "deposits": deposits.into_iter()
                .map(|(from, amount, note, at)| json!({ "username": from, "amount": amount, "note": note, "at": at }))
                .collect::<Vec<_>>(),
            "withdrawals": withdrawals.into_iter()
                .map(|(amount, at)| json!({ "amount": amount, "at": at }))
                .collect::<Vec<_>>(),
            "stats": stats,
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("manage_addon", e))
}

/// `GET /api/addons/mine` — аддоны, закреплённые за аккаунтом, со сводкой.
pub(crate) async fn list_mine(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> impl IntoResponse {
    let result: Result<Response, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        let ids = sqlx::query_as::<_, (String, String, String, i64)>(
            "SELECT addon_id, name, kind, claimed_at FROM addon_registry WHERE owner = ? ORDER BY claimed_at DESC",
        )
        .bind(&username)
        .fetch_all(&mut *conn)
        .await?;
        let now = now_ms();
        let mut items = Vec::with_capacity(ids.len());
        for (id, name, kind, claimed_at) in ids {
            let summary = treasury_summary(&mut conn, &id, now).await?;
            let stats = stats_json(&mut conn, &id, now).await?;
            // Последняя заявка на официальную подпись — для строки в списке.
            let request = sqlx::query_as::<_, (String, String, String, String, String, i64, i64)>(
                "SELECT version, digest, status, note, decision_note, created_at, decided_at
                 FROM addon_official_requests WHERE addon_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&id)
            .fetch_optional(&mut *conn)
            .await?
            .map(|(version, digest, status, note, decision_note, created_at, decided_at)| {
                request_json(&id, &version, &digest, &status, &note, &decision_note, created_at, decided_at)
            });
            let store = crate::addon_store::owner_summary(&mut conn, &id).await?;
            items.push(json!({
                "id": id, "name": name, "kind": kind, "claimedAt": claimed_at,
                "officialRequest": request,
                "store": store,
                "treasury": summary_json(&summary),
                "installs": stats["installs"], "launches7d": stats["launches7d"],
            }));
        }
        Ok(Json(json!({ "addons": items })).into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("list_mine", e))
}

/// Сумма казн всех аддонов — в общую статистику эмиссии (`coins.rs`).
pub(crate) async fn total_addon_treasuries(pool: &sqlx::SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COALESCE(SUM(balance), 0) FROM addon_treasuries")
        .fetch_one(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_app_state, Config};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    async fn test_state() -> Arc<AppState> {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("zali-addons-test-{}-{}", std::process::id(), n));
        build_app_state(dir, Config::from_env()).await
    }

    async fn fund(state: &Arc<AppState>, user: &str, balance: i64) {
        sqlx::query("INSERT INTO coin_balances (username, balance) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET balance = excluded.balance")
            .bind(user)
            .bind(balance)
            .execute(&state.db)
            .await
            .unwrap();
    }

    async fn register(state: &Arc<AppState>, id: &str, owner: &str) {
        sqlx::query(
            "INSERT INTO addon_registry (addon_id, owner, kind, public_key, key_fp, name, claimed_at, updated_at)
             VALUES (?, ?, 'self', 'k', 'fp', 'Test', 0, 0)",
        )
        .bind(id)
        .bind(owner)
        .execute(&state.db)
        .await
        .unwrap();
    }

    async fn deposit_tx(state: &Arc<AppState>, id: &str, user: &str, amount: i64, key: &str) -> DepositOutcome {
        let (id, user, key) = (id.to_string(), user.to_string(), key.to_string());
        run_immediate_tx(state.db.clone(), move |mut conn| async move {
            let r = apply_deposit(&mut conn, &id, &user, amount, "", &key).await;
            (conn, r)
        })
        .await
        .unwrap()
    }

    async fn withdraw_tx(state: &Arc<AppState>, id: &str, user: &str, amount: i64, key: &str) -> WithdrawOutcome {
        let (id, user, key) = (id.to_string(), user.to_string(), key.to_string());
        run_immediate_tx(state.db.clone(), move |mut conn| async move {
            let r = apply_withdraw(&mut conn, &id, &user, amount, &key).await;
            (conn, r)
        })
        .await
        .unwrap()
    }

    async fn supply(state: &Arc<AppState>) -> i64 {
        let balances: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(balance), 0) FROM coin_balances")
            .fetch_one(&state.db).await.unwrap();
        balances + total_addon_treasuries(&state.db).await.unwrap()
    }

    #[test]
    fn self_signatures_round_trip_and_reject_tampering() {
        let dir = std::env::temp_dir().join(format!("zali-signer-test-{}", std::process::id()));
        let signer = AddonSigner::load_or_create(&dir);
        let message = signature_message("self", "org.t.addon", "1.0.0", "alice", &"a".repeat(64), 1_700_000_000_000);
        let signature = signer.sign(&message).unwrap();
        assert_eq!(signature.len(), 64);
        assert!(verify_es256(signer.public_bytes(), message.as_bytes(), &signature));
        let other = signature_message("self", "org.t.addon", "1.0.0", "mallory", &"a".repeat(64), 1_700_000_000_000);
        assert!(!verify_es256(signer.public_bytes(), other.as_bytes(), &signature), "owner is part of the message");
        let mut broken = signature.clone();
        broken[10] ^= 1;
        assert!(!verify_es256(signer.public_bytes(), message.as_bytes(), &broken));
        // Ключ переживает перезапуск: второй signer читает тот же файл.
        let again = AddonSigner::load_or_create(&dir);
        assert_eq!(again.public_bytes(), signer.public_bytes());
    }

    #[test]
    fn identifiers_are_validated_strictly() {
        assert!(valid_addon_id("org.example.snake"));
        assert!(!valid_addon_id("ab"));
        assert!(!valid_addon_id("Org.Example"));
        assert!(!valid_addon_id("a..b"));
        assert!(!valid_addon_id(".hidden"));
        assert!(valid_version("1.0.0-beta+3"));
        assert!(!valid_version("1 0"));
        assert!(valid_digest(&"0f".repeat(32)));
        assert!(!valid_digest(&"0F".repeat(32)));
        assert!(!valid_digest("abc"));
    }

    #[tokio::test]
    async fn a_deposit_moves_money_once_and_keeps_the_supply() {
        let state = test_state().await;
        register(&state, "org.t.game", "dev").await;
        fund(&state, "alice", 100).await;
        let base = supply(&state).await; // в базе уже есть начальная эмиссия

        let first = deposit_tx(&state, "org.t.game", "alice", 30, "k1").await;
        assert!(matches!(first, DepositOutcome::Done { balance: 70, treasury: 30 }), "{first:?}");
        let again = deposit_tx(&state, "org.t.game", "alice", 30, "k1").await;
        assert!(matches!(again, DepositOutcome::Replayed { balance: 70, treasury: 30 }), "{again:?}");
        assert_eq!(supply(&state).await, base, "the replay must not move money twice");
    }

    #[tokio::test]
    async fn an_unregistered_addon_and_an_empty_wallet_are_refused_without_a_trace() {
        let state = test_state().await;
        fund(&state, "alice", 10).await;
        let base = supply(&state).await;
        assert!(matches!(deposit_tx(&state, "org.t.unknown", "alice", 5, "k").await, DepositOutcome::NotRegistered));
        register(&state, "org.t.game", "dev").await;
        assert!(matches!(deposit_tx(&state, "org.t.game", "alice", 50, "k2").await, DepositOutcome::InsufficientFunds));
        assert_eq!(supply(&state).await, base);
        let ops: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM addon_coin_ops").fetch_one(&state.db).await.unwrap();
        assert_eq!(ops, 0, "a refused operation must leave no row");
    }

    #[tokio::test]
    async fn only_deposits_older_than_the_hold_can_be_withdrawn_and_only_by_the_owner() {
        let state = test_state().await;
        register(&state, "org.t.game", "dev").await;
        fund(&state, "alice", 100).await;
        fund(&state, "bob", 100).await;
        let base = supply(&state).await;
        deposit_tx(&state, "org.t.game", "alice", 40, "a1").await;
        deposit_tx(&state, "org.t.game", "bob", 20, "b1").await;

        // Только что внесено — вывести нельзя.
        match withdraw_tx(&state, "org.t.game", "dev", 10, "w1").await {
            WithdrawOutcome::Locked(summary) => {
                assert_eq!(summary.balance, 60);
                assert_eq!(summary.withdrawable, 0);
                assert!(summary.next_unlock.is_some());
            }
            other => panic!("expected Locked, got {other:?}"),
        }
        // Чужой не владелец.
        assert!(matches!(withdraw_tx(&state, "org.t.game", "alice", 10, "w2").await, WithdrawOutcome::NotOwner));

        // Взнос Алисы «состарился» на 8 дней, взнос Боба — свежий.
        sqlx::query("UPDATE addon_coin_ops SET created_ms = created_ms - ? WHERE username = 'alice'")
            .bind(8 * 24 * 3600 * 1000_i64)
            .execute(&state.db)
            .await
            .unwrap();
        match withdraw_tx(&state, "org.t.game", "dev", 50, "w3").await {
            WithdrawOutcome::Locked(summary) => assert_eq!(summary.withdrawable, 40, "only Alice's matured deposit"),
            other => panic!("expected Locked for more than matured, got {other:?}"),
        }
        let done = withdraw_tx(&state, "org.t.game", "dev", 40, "w4").await;
        assert!(matches!(&done, WithdrawOutcome::Done { balance: 40, summary } if summary.balance == 20 && summary.withdrawable == 0), "{done:?}");
        // Повтор того же ключа — не второй вывод.
        assert!(matches!(withdraw_tx(&state, "org.t.game", "dev", 40, "w4").await, WithdrawOutcome::Replayed { .. }));
        assert_eq!(supply(&state).await, base, "money is conserved across deposit and withdrawal");
    }
}
