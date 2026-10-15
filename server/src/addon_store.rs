//! Магазин аддонов: публикация, витрина, покупка и выдача файла.
//!
//! Что здесь важно понимать:
//!
//! - **В магазин попадает только официально подписанная сборка.** Автор отдаёт
//!   сам файл `.zali`; сервер разбирает контейнер, пересчитывает отпечаток
//!   содержимого и сверяет `zali-signature.json`: вид `official`, официальный
//!   ключ, `id`/версия как в манифесте, `owner` — тот, кто публикует, и он же
//!   владелец `id` в реестре. Отозванная сборка не принимается и снимается с
//!   витрины. Подпись, которой доверяет приложение при установке, — та же.
//!
//! - **Цена — целое число ZaliCoin, 0 — бесплатно.** Деньги идут от покупателя
//!   сразу на баланс автора одной `BEGIN IMMEDIATE`-транзакцией (с записью в
//!   `coin_transactions`, как обычный перевод): так инвариант эмиссии не
//!   затрагивается, а «казна аддона» — со свободным выводом официальным аддонам
//!   — к выручке отношения не имеет.
//!
//! - **Покупка — лицензия на аккаунт.** Купивший может скачать файл снова, даже
//!   если автор снял аддон с витрины или поднял цену. Повторная покупка денег не
//!   списывает; автору свой аддон доступен всегда.
//!
//! - **Файл — JSON с base64**, как у облака аддонов: так он одинаково проходит
//!   через мост всех оболочек. Потолок — 16 МиБ (формат допускает 32).

use crate::addons::{
    addon_error, clean_line, internal, load_registry, now_ms, official_public_key, signature_message,
    valid_addon_id, valid_digest, valid_version, verify_es256,
};
use crate::{run_immediate_tx, send_json_to_user, AppState, AuthenticatedUser, CoinTxOutcome};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::{collections::HashSet, path::PathBuf, sync::Arc};
use tracing::info;
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"ZALIEXTN";
const FILE_MAX: usize = 16 * 1024 * 1024;
const ENTRIES_MAX: usize = 2000;
const MANIFEST_MAX: usize = 64 * 1024;
const SIGNATURE_MAX: usize = 16 * 1024;
const ICON_MAX: usize = 256 * 1024;
const BACKGROUND_MAX: usize = 512 * 1024;
const PRICE_MAX: i64 = 10_000;
const SUMMARY_MAX_CHARS: usize = 300;
const PUBLISH_PER_HOUR: i64 = 20;
const LISTINGS_PER_USER: i64 = 50;
const LIST_LIMIT_MAX: i64 = 60;
const SIGNATURE_PATH: &str = "zali-signature.json";
const IMAGE_EXTS: [&str; 5] = ["png", "svg", "webp", "jpg", "jpeg"];

// ============================================================================
// Контейнер .zali
// ============================================================================

fn path_problem(path: &str) -> Option<&'static str> {
    if path.is_empty() {
        return Some("пустой путь");
    }
    if path.len() > 255 {
        return Some("путь длиннее 255 байт");
    }
    if path.starts_with('/') || path.ends_with('/') {
        return Some("путь начинается или кончается «/»");
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return Some("пустой сегмент пути");
        }
        if segment == "." || segment == ".." {
            return Some("сегмент «.» или «..»");
        }
        if !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return Some("недопустимые символы в пути");
        }
    }
    None
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).filter(|end| *end <= self.bytes.len());
        match end {
            Some(end) => {
                let slice = &self.bytes[self.at..end];
                self.at = end;
                Ok(slice)
            }
            None => Err("файл обрезан".into()),
        }
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Result<u64, String> {
        let b = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_le_bytes(a))
    }
}

/// Разбирает контейнер: те же правила, что `parseContainer` в addon_format.js.
fn parse_container(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if bytes.len() > FILE_MAX {
        return Err("файл больше 16 МБ".into());
    }
    let mut r = Reader { bytes, at: 0 };
    if r.take(8).map_err(|_| "это не файл аддона".to_string())? != MAGIC {
        return Err("это не файл аддона".into());
    }
    if r.u8()? != 1 {
        return Err("неизвестная версия формата".into());
    }
    let id_len = r.u8()? as usize;
    r.take(id_len)?;
    let dom_len = r.u8()? as usize;
    if r.take(dom_len)? != b"addon" {
        return Err("это не файл аддона".into());
    }
    if r.u8()? != 0 {
        return Err("шифрование в файле аддона не поддерживается".into());
    }
    let count = r.u32()? as usize;
    if count == 0 || count > ENTRIES_MAX {
        return Err("слишком много файлов внутри".into());
    }
    let mut files: Vec<(String, Vec<u8>)> = Vec::with_capacity(count);
    let mut seen = HashSet::new();
    for _ in 0..count {
        let name_len = r.u16()? as usize;
        let name = std::str::from_utf8(r.take(name_len)?)
            .map_err(|_| "имя файла не в UTF-8".to_string())?
            .to_string();
        if let Some(problem) = path_problem(&name) {
            return Err(format!("«{}»: {}", name.chars().take(60).collect::<String>(), problem));
        }
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(format!("файл «{}» встречается дважды", name.chars().take(60).collect::<String>()));
        }
        let size = r.u64()?;
        let stored = r.u64()?;
        if size != stored {
            return Err("сжатие в файле аддона не поддерживается".into());
        }
        let size = usize::try_from(size).map_err(|_| "файл слишком большой".to_string())?;
        files.push((name, r.take(size)?.to_vec()));
    }
    if r.at != bytes.len() {
        return Err("после файлов есть лишние байты".into());
    }
    Ok(files)
}

/// Отпечаток содержимого (`contentDigest` в addon_format.js): все записи, кроме
/// подписи, по возрастанию пути; по каждой — u32be(len path) · path · u64be(len
/// data) · data.
fn content_digest(files: &[(String, Vec<u8>)]) -> String {
    let mut ordered: Vec<&(String, Vec<u8>)> = files.iter().filter(|(n, _)| n != SIGNATURE_PATH).collect();
    ordered.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut hasher = Sha256::new();
    hasher.update(b"zali-addon-content:v1\n");
    for (name, data) in ordered {
        hasher.update((name.len() as u32).to_be_bytes());
        hasher.update(name.as_bytes());
        hasher.update((data.len() as u64).to_be_bytes());
        hasher.update(data);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn find<'a>(files: &'a [(String, Vec<u8>)], path: &str) -> Option<&'a Vec<u8>> {
    files.iter().find(|(n, _)| n == path).map(|(_, d)| d)
}

fn ext_of(path: &str) -> String {
    path.rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

// ============================================================================
// Проверка публикуемой сборки
// ============================================================================

struct Verified {
    id: String,
    version: String,
    digest: String,
    name: String,
    description: String,
    author: String,
    permissions: Vec<String>,
    icon: Option<(String, Vec<u8>)>,
    background: Option<(String, Vec<u8>)>,
}

fn text_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Проверяет файл так, как это сделает приложение при установке, и заодно
/// требует, чтобы подпись была официальной и выдана именно `publisher`.
fn verify_build(files: &[(String, Vec<u8>)], publisher: &str) -> Result<Verified, (&'static str, String)> {
    let bad = |code: &'static str, msg: &str| Err((code, msg.to_string()));

    let Some(manifest_raw) = find(files, "manifest.json") else {
        return bad("bad_file", "В файле нет manifest.json");
    };
    if manifest_raw.len() > MANIFEST_MAX {
        return bad("bad_file", "manifest.json больше 64 КБ");
    }
    let manifest: Value = match serde_json::from_slice(manifest_raw) {
        Ok(v) => v,
        Err(_) => return bad("bad_file", "manifest.json — не JSON"),
    };
    let id = text_of(&manifest, "id");
    let version = text_of(&manifest, "version");
    let name = clean_line(&text_of(&manifest, "name"), 64);
    if manifest.get("zaliAddon").and_then(Value::as_i64) != Some(1) {
        return bad("bad_file", "В манифесте нужно \"zaliAddon\": 1");
    }
    if !valid_addon_id(&id) || !valid_version(&version) || name.is_empty() {
        return bad("bad_file", "В манифесте неверные id, name или version");
    }

    let Some(signature_raw) = find(files, SIGNATURE_PATH) else {
        return bad("not_official", "В магазин берутся только официально подписанные аддоны: в файле нет подписи");
    };
    if signature_raw.len() > SIGNATURE_MAX {
        return bad("bad_signature", "Файл подписи слишком большой");
    }
    let sig: Value = match serde_json::from_slice(signature_raw) {
        Ok(v) => v,
        Err(_) => return bad("bad_signature", "Подпись повреждена"),
    };
    if text_of(&sig, "kind") != "official" {
        return bad(
            "not_official",
            "В магазин берутся только официально подписанные аддоны — получите официальную подпись",
        );
    }
    let signed_at = sig.get("signedAt").and_then(Value::as_i64).unwrap_or(0);
    let digest = text_of(&sig, "digest");
    let owner = text_of(&sig, "owner");
    let public = B64.decode(text_of(&sig, "publicKey")).unwrap_or_default();
    let raw_signature = B64.decode(text_of(&sig, "signature")).unwrap_or_default();
    let official = official_public_key();
    if text_of(&sig, "alg") != "ES256" || public != official || !valid_digest(&digest) || signed_at <= 0 {
        return bad("bad_signature", "Подпись сделана не официальным ключом");
    }
    if text_of(&sig, "id") != id || text_of(&sig, "version") != version {
        return bad("bad_signature", "Подпись выдана на другой id или версию");
    }
    let message = signature_message("official", &id, &version, &owner, &digest, signed_at);
    if !verify_es256(&official, message.as_bytes(), &raw_signature) {
        return bad("bad_signature", "Подпись не сходится");
    }
    if owner != publisher {
        return bad("forbidden", "Подпись выдана другому автору — публиковать может только он");
    }
    if content_digest(files) != digest {
        return bad("bad_signature", "Содержимое файла изменено после подписи");
    }

    let description = clean_line(&text_of(&manifest, "description"), SUMMARY_MAX_CHARS);
    let author = clean_line(&text_of(&manifest, "author"), 80);
    let permissions: Vec<String> = manifest
        .get("permissions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|s| s.chars().take(40).collect::<String>())
                .take(16)
                .collect()
        })
        .unwrap_or_default();

    let asset = |key: &str, max: usize| -> Option<(String, Vec<u8>)> {
        let path = text_of(&manifest, key);
        if path.is_empty() {
            return None;
        }
        let ext = ext_of(&path);
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            return None;
        }
        let data = find(files, &path)?;
        (data.len() <= max).then(|| (ext, data.clone()))
    };

    Ok(Verified {
        id,
        version,
        digest,
        name,
        description,
        author,
        permissions,
        icon: asset("icon", ICON_MAX),
        background: asset("background", BACKGROUND_MAX),
    })
}

// ============================================================================
// Хранилище
// ============================================================================

fn store_dir(state: &AppState, id: &str) -> PathBuf {
    state.data_dir.join("addon_store").join(id)
}

async fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let tmp = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await
}

type ListingRow = (
    String, // addon_id
    String, // owner
    String, // version
    String, // digest
    String, // name
    String, // summary
    String, // author
    String, // permissions (json)
    i64,    // price
    i64,    // size
    i64,    // published_at
    i64,    // updated_at
    String, // status
    String, // icon_ext
    String, // bg_ext
);

const LISTING_COLUMNS: &str = "addon_id, owner, version, digest, name, summary, author, permissions, price, size, \
     published_at, updated_at, status, icon_ext, bg_ext";

fn listing_json(row: &ListingRow, purchases: i64, owned: bool, viewer: &str) -> Value {
    let permissions: Value = serde_json::from_str(&row.7).unwrap_or_else(|_| json!([]));
    json!({
        "id": row.0, "owner": row.1, "version": row.2, "digest": row.3, "name": row.4,
        "summary": row.5, "author": row.6, "permissions": permissions,
        "price": row.8, "size": row.9, "publishedAt": row.10, "updatedAt": row.11,
        "status": row.12, "hasIcon": !row.13.is_empty(), "hasBackground": !row.14.is_empty(),
        "purchases": purchases, "owned": owned || row.1 == viewer, "mine": row.1 == viewer,
        "free": row.8 == 0,
    })
}

async fn purchases_count(conn: &mut SqliteConnection, id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM addon_store_purchases WHERE addon_id = ? AND buyer != (SELECT owner FROM addon_store_listings WHERE addon_id = ?)")
        .bind(id)
        .bind(id)
        .fetch_one(&mut *conn)
        .await
}

async fn is_owned(conn: &mut SqliteConnection, id: &str, user: &str) -> Result<bool, sqlx::Error> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM addon_store_purchases WHERE addon_id = ? AND buyer = ?")
        .bind(id)
        .bind(user)
        .fetch_one(&mut *conn)
        .await?;
    Ok(n > 0)
}

async fn load_listing(conn: &mut SqliteConnection, id: &str) -> Result<Option<ListingRow>, sqlx::Error> {
    sqlx::query_as::<_, ListingRow>(&format!(
        "SELECT {LISTING_COLUMNS} FROM addon_store_listings WHERE addon_id = ?"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
}

/// Сводка магазина для строки аддона в «Мои аддоны» (`addons::list_mine`).
pub(crate) async fn owner_summary(conn: &mut SqliteConnection, id: &str) -> Result<Value, sqlx::Error> {
    let Some(row) = load_listing(conn, id).await? else {
        return Ok(Value::Null);
    };
    let sales = purchases_count(conn, id).await?;
    Ok(json!({
        "status": row.12, "price": row.8, "version": row.2, "digest": row.3,
        "publishedAt": row.10, "purchases": sales,
    }))
}

/// Снять с витрины сборку, которую отозвал оператор (`addons::admin_revoke_build`).
pub(crate) async fn hide_revoked(state: &Arc<AppState>, id: &str, digest: &str) {
    let _ = sqlx::query("UPDATE addon_store_listings SET status = 'hidden' WHERE addon_id = ? AND digest = ?")
        .bind(id)
        .bind(digest)
        .execute(&state.db)
        .await;
}

// ============================================================================
// Публикация
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct PublishBody {
    #[serde(rename = "fileBase64")]
    file_base64: String,
    #[serde(default)]
    price: i64,
    #[serde(default)]
    summary: Option<String>,
}

/// `POST /api/addons/store/publish` — выложить (или обновить) аддон в магазине.
pub(crate) async fn publish(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Json(body): Json<PublishBody>,
) -> impl IntoResponse {
    if body.price < 0 || body.price > PRICE_MAX {
        return addon_error(
            StatusCode::BAD_REQUEST,
            "bad_price",
            &format!("Цена — от 0 (бесплатно) до {PRICE_MAX} ZaliCoin"),
        );
    }
    let bytes = match B64.decode(body.file_base64.trim()) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => return addon_error(StatusCode::BAD_REQUEST, "bad_file", "Файл аддона не прочитан"),
    };
    let files = match parse_container(&bytes) {
        Ok(files) => files,
        Err(e) => return addon_error(StatusCode::BAD_REQUEST, "bad_file", &format!("Файл не подошёл: {e}")),
    };
    let verified = match verify_build(&files, &username) {
        Ok(v) => v,
        Err((code, message)) => {
            let status = match code {
                "forbidden" => StatusCode::FORBIDDEN,
                _ => StatusCode::BAD_REQUEST,
            };
            return addon_error(status, code, &message);
        }
    };
    let summary = match &body.summary {
        Some(text) if !text.trim().is_empty() => clean_line(text, SUMMARY_MAX_CHARS),
        _ => verified.description.clone(),
    };

    let result: Result<Response, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        let Some(registry) = load_registry(&mut conn, &verified.id).await? else {
            return Ok(addon_error(StatusCode::NOT_FOUND, "not_registered", "Аддона нет в реестре — сначала подпишите его"));
        };
        if registry.owner != username || registry.kind != "official" {
            return Ok(addon_error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Публиковать может только владелец официально подписанного аддона",
            ));
        }
        let revoked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM addon_revocations WHERE addon_id = ? AND digest = ?")
            .bind(&verified.id)
            .bind(&verified.digest)
            .fetch_one(&mut *conn)
            .await?;
        if revoked > 0 {
            return Ok(addon_error(StatusCode::FORBIDDEN, "revoked", "Эта сборка отозвана — выпустите новую версию"));
        }
        let now = now_ms();
        let recent: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM addon_events WHERE username = ? AND kind = 'store_publish' AND at > ?",
        )
        .bind(&username)
        .bind(now - 3_600_000)
        .fetch_one(&mut *conn)
        .await?;
        if recent >= PUBLISH_PER_HOUR {
            return Ok(addon_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Слишком много публикаций за час"));
        }
        let existing = load_listing(&mut conn, &verified.id).await?;
        if existing.is_none() {
            let mine: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM addon_store_listings WHERE owner = ?")
                .bind(&username)
                .fetch_one(&mut *conn)
                .await?;
            if mine >= LISTINGS_PER_USER {
                return Ok(addon_error(StatusCode::BAD_REQUEST, "too_many", "В магазине может быть не больше 50 ваших аддонов"));
            }
        }

        // Сначала файлы, потом строка: строка без файла была бы битой витриной.
        let dir = store_dir(&state, &verified.id);
        if let Err(e) = write_atomic(&dir.join(format!("{}.zali", verified.digest)), &bytes).await {
            return Ok(internal("store publish write", e));
        }
        let icon_ext = match &verified.icon {
            Some((ext, data)) => {
                if let Err(e) = write_atomic(&dir.join(format!("{}.icon", verified.digest)), data).await {
                    return Ok(internal("store publish icon", e));
                }
                ext.clone()
            }
            None => String::new(),
        };
        let bg_ext = match &verified.background {
            Some((ext, data)) => {
                if let Err(e) = write_atomic(&dir.join(format!("{}.bg", verified.digest)), data).await {
                    return Ok(internal("store publish background", e));
                }
                ext.clone()
            }
            None => String::new(),
        };

        sqlx::query(
            "INSERT INTO addon_store_listings
                (addon_id, owner, version, digest, name, summary, author, permissions, price, size,
                 published_at, updated_at, status, icon_ext, bg_ext)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
             ON CONFLICT(addon_id) DO UPDATE SET
                owner = excluded.owner, version = excluded.version, digest = excluded.digest,
                name = excluded.name, summary = excluded.summary, author = excluded.author,
                permissions = excluded.permissions, price = excluded.price, size = excluded.size,
                updated_at = excluded.updated_at, status = 'active',
                icon_ext = excluded.icon_ext, bg_ext = excluded.bg_ext",
        )
        .bind(&verified.id)
        .bind(&username)
        .bind(&verified.version)
        .bind(&verified.digest)
        .bind(&verified.name)
        .bind(&summary)
        .bind(&verified.author)
        .bind(serde_json::to_string(&verified.permissions).unwrap_or_else(|_| "[]".into()))
        .bind(body.price)
        .bind(bytes.len() as i64)
        .bind(now)
        .bind(now)
        .bind(&icon_ext)
        .bind(&bg_ext)
        .execute(&mut *conn)
        .await?;
        sqlx::query("INSERT INTO addon_events (addon_id, username, kind, version, at) VALUES (?, ?, 'store_publish', ?, ?)")
            .bind(&verified.id)
            .bind(&username)
            .bind(&verified.version)
            .bind(now)
            .execute(&mut *conn)
            .await?;

        // Старые сборки этого аддона на диске больше не нужны.
        if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with(&verified.digest) {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
        info!(
            "[ADDON] store publish id={} version={} owner={} price={}",
            verified.id, verified.version, username, body.price
        );
        let row = load_listing(&mut conn, &verified.id).await?.expect("listing just written");
        let sales = purchases_count(&mut conn, &verified.id).await?;
        Ok((StatusCode::CREATED, Json(json!({ "listing": listing_json(&row, sales, true, &username) }))).into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("store publish", e))
}

#[derive(Debug, Deserialize)]
pub(crate) struct UpdateBody {
    #[serde(default)]
    price: Option<i64>,
    #[serde(default)]
    summary: Option<String>,
}

/// `POST /api/addons/store/:id/update` — владелец меняет цену и описание.
pub(crate) async fn update_listing(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> impl IntoResponse {
    if !valid_addon_id(&id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    if let Some(price) = body.price {
        if !(0..=PRICE_MAX).contains(&price) {
            return addon_error(
                StatusCode::BAD_REQUEST,
                "bad_price",
                &format!("Цена — от 0 (бесплатно) до {PRICE_MAX} ZaliCoin"),
            );
        }
    }
    let result: Result<Response, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        let Some(row) = load_listing(&mut conn, &id).await? else {
            return Ok(addon_error(StatusCode::NOT_FOUND, "not_found", "Аддона нет в магазине"));
        };
        if row.1 != username {
            return Ok(addon_error(StatusCode::FORBIDDEN, "forbidden", "Это аддон другого автора"));
        }
        let price = body.price.unwrap_or(row.8);
        let summary = match &body.summary {
            Some(text) => clean_line(text, SUMMARY_MAX_CHARS),
            None => row.5.clone(),
        };
        sqlx::query("UPDATE addon_store_listings SET price = ?, summary = ?, updated_at = ? WHERE addon_id = ?")
            .bind(price)
            .bind(&summary)
            .bind(now_ms())
            .bind(&id)
            .execute(&mut *conn)
            .await?;
        let row = load_listing(&mut conn, &id).await?.expect("listing exists");
        let sales = purchases_count(&mut conn, &id).await?;
        Ok(Json(json!({ "listing": listing_json(&row, sales, true, &username) })).into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("store update", e))
}

/// `DELETE /api/addons/store/:id` — снять с витрины. Купившие сохраняют доступ.
pub(crate) async fn unpublish(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !valid_addon_id(&id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    match sqlx::query("UPDATE addon_store_listings SET status = 'hidden', updated_at = ? WHERE addon_id = ? AND owner = ?")
        .bind(now_ms())
        .bind(&id)
        .bind(&username)
        .execute(&state.db)
        .await
    {
        Ok(done) if done.rows_affected() == 1 => Json(json!({ "ok": true, "status": "hidden" })).into_response(),
        Ok(_) => addon_error(StatusCode::NOT_FOUND, "not_found", "Аддона нет в вашем магазине"),
        Err(e) => internal("store unpublish", e),
    }
}

// ============================================================================
// Витрина
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct ListQuery {
    #[serde(default)]
    q: String,
    /// `all` (по умолчанию), `free`, `paid`, `owned`.
    #[serde(default)]
    filter: String,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

/// `GET /api/addons/store` — витрина: активные листинги и то, что уже ваше.
pub(crate) async fn list_store(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Query(query): Query<ListQuery>,
) -> impl IntoResponse {
    let limit = query.limit.unwrap_or(LIST_LIMIT_MAX).clamp(1, LIST_LIMIT_MAX);
    let offset = query.offset.unwrap_or(0).max(0);
    let needle = format!("%{}%", query.q.trim().replace('%', "").replace('_', "").to_lowercase());
    let filter = match query.filter.as_str() {
        "free" => "AND l.price = 0",
        "paid" => "AND l.price > 0",
        "owned" => "AND (l.owner = ?3 OR EXISTS (SELECT 1 FROM addon_store_purchases p WHERE p.addon_id = l.addon_id AND p.buyer = ?3))",
        _ => "",
    };
    let sql = format!(
        "SELECT l.addon_id, l.owner, l.version, l.digest, l.name, l.summary, l.author, l.permissions, l.price,
                l.size, l.published_at, l.updated_at, l.status, l.icon_ext, l.bg_ext
         FROM addon_store_listings l
         WHERE (l.status = 'active' OR (l.owner = ?3 AND ?4 = 1))
           AND (LOWER(l.name) LIKE ?1 OR LOWER(l.summary) LIKE ?1 OR LOWER(l.owner) LIKE ?1 OR LOWER(l.addon_id) LIKE ?1)
           {filter}
         ORDER BY (SELECT COUNT(*) FROM addon_store_purchases p WHERE p.addon_id = l.addon_id) DESC, l.updated_at DESC
         LIMIT ?2 OFFSET {offset}"
    );
    let result: Result<Response, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        let rows = sqlx::query_as::<_, ListingRow>(&sql)
            .bind(&needle)
            .bind(limit)
            .bind(&username)
            .bind(if query.filter == "owned" { 1 } else { 0 })
            .fetch_all(&mut *conn)
            .await?;
        let owned: HashSet<String> = sqlx::query_scalar::<_, String>(
            "SELECT addon_id FROM addon_store_purchases WHERE buyer = ?",
        )
        .bind(&username)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();
        let mut items = Vec::with_capacity(rows.len());
        for row in &rows {
            let sales = purchases_count(&mut conn, &row.0).await?;
            items.push(listing_json(row, sales, owned.contains(&row.0), &username));
        }
        let balance: i64 = sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
            .bind(&username)
            .fetch_optional(&mut *conn)
            .await?
            .unwrap_or(0);
        Ok(Json(json!({ "items": items, "balance": balance })).into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("store list", e))
}

/// `GET /api/addons/store/:id/assets` — иконка и фон карточки как data-URL.
pub(crate) async fn assets(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_username): AuthenticatedUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !valid_addon_id(&id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    let result: Result<Response, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        let Some(row) = load_listing(&mut conn, &id).await? else {
            return Ok(addon_error(StatusCode::NOT_FOUND, "not_found", "Аддона нет в магазине"));
        };
        let dir = store_dir(&state, &id);
        let read = |ext: &str, suffix: &str| {
            let path = dir.join(format!("{}.{}", row.3, suffix));
            let ext = ext.to_string();
            async move {
                if ext.is_empty() {
                    return String::new();
                }
                match tokio::fs::read(path).await {
                    Ok(bytes) => format!("data:{};base64,{}", mime_of(&ext), B64.encode(bytes)),
                    Err(_) => String::new(),
                }
            }
        };
        let icon = read(&row.13, "icon").await;
        let background = read(&row.14, "bg").await;
        Ok(Json(json!({ "icon": icon, "background": background })).into_response())
    }
    .await;
    result.unwrap_or_else(|e| internal("store assets", e))
}

// ============================================================================
// Покупка и скачивание
// ============================================================================

#[derive(Debug)]
enum BuyOutcome {
    Done { balance: i64, price: i64 },
    AlreadyOwned,
    NotFound,
    Insufficient,
}

impl CoinTxOutcome for BuyOutcome {
    fn commits(&self) -> bool {
        matches!(self, BuyOutcome::Done { .. })
    }
}

/// `POST /api/addons/store/:id/buy` — купить (или забрать бесплатный) аддон.
pub(crate) async fn buy(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !valid_addon_id(&id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    let tx_id = id.clone();
    let tx_user = username.clone();
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result: Result<(BuyOutcome, String), sqlx::Error> = async {
            let listing: Option<(String, i64, String)> = sqlx::query_as(
                "SELECT owner, price, version FROM addon_store_listings WHERE addon_id = ? AND status = 'active'",
            )
            .bind(&tx_id)
            .fetch_optional(&mut *conn)
            .await?;
            let Some((owner, price, version)) = listing else {
                return Ok((BuyOutcome::NotFound, String::new()));
            };
            if owner == tx_user || is_owned(&mut conn, &tx_id, &tx_user).await? {
                return Ok((BuyOutcome::AlreadyOwned, owner));
            }
            let mut tx_ref = String::new();
            if price > 0 {
                let debited = sqlx::query(
                    "UPDATE coin_balances SET balance = balance - ? WHERE username = ? AND balance >= ?",
                )
                .bind(price)
                .bind(&tx_user)
                .bind(price)
                .execute(&mut *conn)
                .await?;
                if debited.rows_affected() != 1 {
                    return Ok((BuyOutcome::Insufficient, owner));
                }
                sqlx::query(
                    "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
                     ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
                )
                .bind(&owner)
                .bind(price)
                .execute(&mut *conn)
                .await?;
                tx_ref = Uuid::new_v4().to_string();
                sqlx::query(
                    "INSERT INTO coin_transactions (id, from_user, to_user, amount, idempotency_key, card_client_id)
                     VALUES (?, ?, ?, ?, ?, '')",
                )
                .bind(&tx_ref)
                .bind(&tx_user)
                .bind(&owner)
                .bind(price)
                .bind(format!("store:{}:{}", tx_id, tx_user))
                .execute(&mut *conn)
                .await?;
            }
            sqlx::query(
                "INSERT INTO addon_store_purchases (addon_id, buyer, price, version, at, tx_id)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&tx_id)
            .bind(&tx_user)
            .bind(price)
            .bind(&version)
            .bind(now_ms())
            .bind(&tx_ref)
            .execute(&mut *conn)
            .await?;
            let balance: i64 = sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
                .bind(&tx_user)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or(0);
            Ok((BuyOutcome::Done { balance, price }, owner))
        }
        .await;
        match result {
            Ok((outcome, owner)) => (conn, Ok(WithOwner(outcome, owner))),
            Err(e) => (conn, Err(e)),
        }
    })
    .await;

    match outcome {
        Ok(WithOwner(BuyOutcome::Done { balance, price }, owner)) => {
            info!("[ADDON] store buy id={} buyer={} price={}", id, username, price);
            if price > 0 {
                send_json_to_user(
                    &state,
                    &owner,
                    json!({ "type": "addon_coins", "kind": "sale", "addonId": id, "from": username, "amount": price }),
                )
                .await;
            }
            (StatusCode::CREATED, Json(json!({ "owned": true, "price": price, "balance": balance }))).into_response()
        }
        Ok(WithOwner(BuyOutcome::AlreadyOwned, _)) => Json(json!({ "owned": true, "price": 0, "alreadyOwned": true })).into_response(),
        Ok(WithOwner(BuyOutcome::NotFound, _)) => addon_error(StatusCode::NOT_FOUND, "not_found", "Аддона нет в магазине"),
        Ok(WithOwner(BuyOutcome::Insufficient, _)) => {
            addon_error(StatusCode::BAD_REQUEST, "insufficient_funds", "Недостаточно ZaliCoin на вашем балансе")
        }
        Err(e) => internal("store buy", e),
    }
}

/// Исход покупки вместе с владельцем (его нужно известить после коммита).
struct WithOwner(BuyOutcome, String);

impl CoinTxOutcome for WithOwner {
    fn commits(&self) -> bool {
        self.0.commits()
    }
}

/// `GET /api/addons/store/:id/download` — файл `.zali` тому, кто имеет на него право.
pub(crate) async fn download(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !valid_addon_id(&id) {
        return addon_error(StatusCode::BAD_REQUEST, "bad_id", "Некорректный id аддона");
    }
    let result: Result<Response, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        let Some(row) = load_listing(&mut conn, &id).await? else {
            return Ok(addon_error(StatusCode::NOT_FOUND, "not_found", "Аддона нет в магазине"));
        };
        let allowed = row.1 == username
            || is_owned(&mut conn, &id, &username).await?
            || (row.8 == 0 && row.12 == "active");
        if !allowed {
            return Ok(addon_error(StatusCode::PAYMENT_REQUIRED, "payment_required", "Аддон нужно купить"));
        }
        let revoked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM addon_revocations WHERE addon_id = ? AND digest = ?")
            .bind(&id)
            .bind(&row.3)
            .fetch_one(&mut *conn)
            .await?;
        if revoked > 0 {
            return Ok(addon_error(StatusCode::FORBIDDEN, "revoked", "Эта сборка отозвана автором или оператором"));
        }
        let path = store_dir(&state, &id).join(format!("{}.zali", row.3));
        match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(Json(json!({
                "fileName": format!("{}-{}.zali", row.0, row.2),
                "version": row.2, "digest": row.3, "size": bytes.len(),
                "dataBase64": B64.encode(bytes),
            }))
            .into_response()),
            Err(e) => Ok(internal("store download read", e)),
        }
    }
    .await;
    result.unwrap_or_else(|e| internal("store download", e))
}
