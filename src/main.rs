use axum::{
    body::Body,
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Multipart, Path as AxumPath, Query,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
    Json, Router,
};
use base64::Engine;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{
        SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
    },
    QueryBuilder, Row, Sqlite,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{fs, io::AsyncWriteExt, sync::mpsc, task};
use tokio_util::io::ReaderStream;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{debug, error, info, trace, warn};
use uuid::Uuid;

#[cfg(windows)]
fn set_windows_app_user_model_id() {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    // Stable AppUserModelID so the taskbar groups windows correctly on Windows.
    let app_id: Vec<u16> = "com.zalikus.zali_messenger"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }
}

#[cfg(not(windows))]
fn set_windows_app_user_model_id() {}

// ============================================================
// CONFIG
// ============================================================

#[allow(dead_code)]
struct Config {
    jwt_secret: Vec<u8>,
    allowed_origins: Vec<String>,
    max_upload_bytes: usize,
    allow_guest_mode: bool,
    auth_cookie_secure: bool,
    rate_limit_window_secs: u64,
    rate_limit_max_attempts: usize,
    ws_channel_capacity: usize,
}

impl Config {
    fn from_env() -> Self {
        let jwt_secret = std::env::var("JWT_SECRET").ok();
        let jwt_secret = match jwt_secret {
            Some(secret) if secret.trim().len() >= 32 => secret,
            Some(secret) if cfg!(debug_assertions) => {
                warn!(
                    "⚠️  JWT_SECRET слишком короткий для продакшена, но в debug будет использован dev-дефолт"
                );
                if secret.trim().is_empty() {
                    "CHANGE_ME_IN_PRODUCTION_ZALI_SECRET_KEY_MIN32CH".to_string()
                } else {
                    secret
                }
            }
            Some(_) | None if cfg!(debug_assertions) => {
                warn!("⚠️  JWT_SECRET не задан! Используется dev-дефолт для локальной разработки.");
                "CHANGE_ME_IN_PRODUCTION_ZALI_SECRET_KEY_MIN32CH".to_string()
            }
            _ => {
                panic!("JWT_SECRET должен быть задан и содержать не менее 32 символов");
            }
        };

        let allowed_origins: Vec<String> = std::env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| {
                "https://msgs.zalikus.org,http://localhost:3000,http://localhost,http://127.0.0.1:3000,http://127.0.0.1,zali://localhost"
                    .to_string()
            })
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();

        let max_upload_bytes = std::env::var("MAX_UPLOAD_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10 * 1024 * 1024); // 10MB по умолчанию

        let allow_guest_mode = std::env::var("ALLOW_GUEST_MODE")
            .map(|v| v.to_lowercase() == "true")
            .unwrap_or(false);

        let auth_cookie_secure = std::env::var("AUTH_COOKIE_SECURE")
            .ok()
            .and_then(|v| match v.trim().to_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => Some(true),
                "0" | "false" | "no" | "off" => Some(false),
                _ => None,
            })
            .unwrap_or_else(|| !cfg!(debug_assertions));

        let rate_limit_window_secs = std::env::var("RATE_LIMIT_WINDOW_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60);

        let rate_limit_max_attempts = std::env::var("RATE_LIMIT_MAX_ATTEMPTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10);

        let ws_channel_capacity = std::env::var("WS_CHANNEL_CAPACITY")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(128);

        Self {
            jwt_secret: jwt_secret.into_bytes(),
            allowed_origins,
            max_upload_bytes,
            allow_guest_mode,
            auth_cookie_secure,
            rate_limit_window_secs,
            rate_limit_max_attempts,
            ws_channel_capacity,
        }
    }
}

const AUTH_COOKIE_NAME: &str = "zali_auth";
const JWT_ISSUER: &str = "zali-server";
const JWT_AUDIENCE: &str = "zali-messenger";
const DUMMY_BCRYPT_HASH: &str = "$2b$12$C6UzMDM.H6dfI/f/IKcEeOe6uT6yQWQfC1k1j6fQJxE1u3N0EdD6W";
const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;

fn sqlite_literal(path: &Path) -> String {
    let escaped = path.to_string_lossy().replace('\'', "''");
    format!("'{}'", escaped)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{:02x}", byte);
    }
    out
}

fn asset_root_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("assets")
}

fn user_avatar_asset_dir(data_dir: &Path, username: &str) -> PathBuf {
    asset_root_dir(data_dir)
        .join("avatars")
        .join(hex_encode(username.trim().as_bytes()))
}

fn server_asset_dir(data_dir: &Path, server_id: &str) -> PathBuf {
    asset_root_dir(data_dir)
        .join("servers")
        .join(hex_encode(server_id.trim().as_bytes()))
}

fn asset_file_paths(base_dir: PathBuf, kind: &str) -> (PathBuf, PathBuf) {
    (
        base_dir.join(format!("{}.bin", kind)),
        base_dir.join(format!("{}.json", kind)),
    )
}

async fn read_asset_file(
    base_dir: PathBuf,
    kind: &str,
) -> Result<Option<(String, Vec<u8>, Option<DateTime<Utc>>)>, std::io::Error> {
    let (bin_path, meta_path) = asset_file_paths(base_dir, kind);
    if !fs::try_exists(&bin_path).await.unwrap_or(false) {
        return Ok(None);
    }

    let data = fs::read(&bin_path).await?;
    if data.is_empty() {
        return Ok(None);
    }

    let mime = match fs::read_to_string(&meta_path).await {
        Ok(raw) => serde_json::from_str::<StoredAssetMeta>(&raw)
            .map(|meta| meta.mime_type)
            .unwrap_or_else(|_| "application/octet-stream".to_string()),
        Err(_) => "application/octet-stream".to_string(),
    };
    let updated_at = match fs::read_to_string(&meta_path).await {
        Ok(raw) => serde_json::from_str::<StoredAssetMeta>(&raw)
            .ok()
            .and_then(|meta| meta.updated_at),
        Err(_) => None,
    };

    Ok(Some((mime, data, updated_at)))
}

async fn write_asset_file(
    base_dir: PathBuf,
    kind: &str,
    mime_type: &str,
    data: &[u8],
    updated_at: Option<DateTime<Utc>>,
) -> Result<(), std::io::Error> {
    let (bin_path, meta_path) = asset_file_paths(base_dir, kind);
    if let Some(parent) = bin_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(&bin_path, data).await?;
    let meta = StoredAssetMeta {
        mime_type: mime_type.to_string(),
        updated_at,
    };
    let meta_json = serde_json::to_string_pretty(&meta).unwrap_or_else(|_| {
        serde_json::json!({ "mime_type": mime_type, "updated_at": updated_at.map(|dt| dt.to_rfc3339()) }).to_string()
    });
    fs::write(&meta_path, meta_json).await?;
    Ok(())
}

async fn clear_asset_file(base_dir: PathBuf, kind: &str) -> Result<(), std::io::Error> {
    let (bin_path, meta_path) = asset_file_paths(base_dir, kind);
    let _ = fs::remove_file(&bin_path).await;
    let _ = fs::remove_file(&meta_path).await;
    if let Some(parent) = bin_path.parent() {
        if let Ok(mut rd) = fs::read_dir(parent).await {
            if rd.next_entry().await?.is_none() {
                let _ = fs::remove_dir(parent).await;
            }
        }
    }
    Ok(())
}

fn canonical_data_dir() -> PathBuf {
    std::env::var("ZALI_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn legacy_data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

async fn copy_missing_uploads(from_dir: &Path, to_dir: &Path) -> Result<usize, std::io::Error> {
    let mut copied = 0usize;
    if !from_dir.exists() {
        return Ok(0);
    }

    let mut dir = fs::read_dir(from_dir).await?;
    while let Some(entry) = dir.next_entry().await? {
        let file_type = entry.file_type().await?;
        if !file_type.is_file() {
            continue;
        }

        let source = entry.path();
        let target = to_dir.join(entry.file_name());
        if fs::try_exists(&target).await.unwrap_or(false) {
            continue;
        }

        fs::copy(&source, &target).await?;
        copied += 1;
    }

    Ok(copied)
}

async fn security_headers(req: axum::http::Request<axum::body::Body>, next: Next) -> Response {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=31536000; includeSubDomains"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
        ),
    );
    response
}

async fn rewrite_api_v1(mut req: Request<Body>, next: Next) -> Response {
    if let Some(path_and_query) = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
    {
        if let Some(rest) = path_and_query.strip_prefix("/api/v1") {
            if rest.is_empty() || rest.starts_with('/') {
                let rewritten = format!("/api{rest}");
                if let Ok(uri) = Uri::builder().path_and_query(rewritten).build() {
                    *req.uri_mut() = uri;
                }
            }
        }
    }

    next.run(req).await
}

async fn migrate_legacy_storage(
    pool: &SqlitePool,
    canonical_db: &Path,
    canonical_uploads: &Path,
) -> Result<(), sqlx::Error> {
    let legacy_db = legacy_data_dir().join("zali_messenger.db");
    let legacy_uploads = legacy_data_dir().join("uploads");

    if legacy_db == canonical_db || !fs::try_exists(&legacy_db).await.unwrap_or(false) {
        return Ok(());
    }

    info!(
        "Проверка legacy-хранилища: db={}, uploads={}",
        legacy_db.display(),
        legacy_uploads.display()
    );

    let attach_sql = format!("ATTACH DATABASE {} AS legacy", sqlite_literal(&legacy_db));
    let mut conn = pool.acquire().await?;

    if let Err(e) = sqlx::query(&attach_sql).execute(&mut *conn).await {
        warn!(
            "Не удалось подключить legacy БД {} для миграции: {}",
            legacy_db.display(),
            e
        );
        return Ok(());
    }

    let legacy_tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM legacy.sqlite_master WHERE type='table' ORDER BY name",
    )
    .fetch_all(&mut *conn)
    .await
    .unwrap_or_default();
    info!("Legacy таблицы: {}", legacy_tables.join(", "));

    let legacy_server_cols = legacy_table_columns(&mut conn, "servers")
        .await
        .unwrap_or_default();
    let legacy_role_cols = legacy_table_columns(&mut conn, "server_roles")
        .await
        .unwrap_or_default();
    let legacy_message_cols = legacy_table_columns(&mut conn, "messages")
        .await
        .unwrap_or_default();
    let legacy_device_cols = legacy_table_columns(&mut conn, "account_devices")
        .await
        .unwrap_or_default();
    let legacy_expr = |cols: &HashSet<String>, name: &str, fallback: &str| -> String {
        if cols.contains(name) {
            name.to_string()
        } else {
            fallback.to_string()
        }
    };
    let legacy_coalesce_expr = |cols: &HashSet<String>, name: &str, fallback: &str| -> String {
        if cols.contains(name) {
            format!("COALESCE({}, {})", name, fallback)
        } else {
            fallback.to_string()
        }
    };

    let servers_join_link = legacy_coalesce_expr(
        &legacy_server_cols,
        "join_link",
        "printf('zali://server/%s', id)",
    );
    let servers_owner = legacy_coalesce_expr(&legacy_server_cols, "owner", "'system'");
    let servers_is_public = legacy_coalesce_expr(&legacy_server_cols, "is_public", "1");
    let servers_avatar_mime = legacy_expr(&legacy_server_cols, "avatar_mime", "NULL");
    let servers_avatar_data = legacy_expr(&legacy_server_cols, "avatar_data", "NULL");
    let servers_banner_mime = legacy_expr(&legacy_server_cols, "banner_mime", "NULL");
    let servers_banner_data = legacy_expr(&legacy_server_cols, "banner_data", "NULL");

    let role_can_view = legacy_coalesce_expr(&legacy_role_cols, "can_view", "1");
    let role_can_send = legacy_coalesce_expr(&legacy_role_cols, "can_send", "1");
    let role_can_manage = legacy_coalesce_expr(&legacy_role_cols, "can_manage", "0");
    let role_position = legacy_coalesce_expr(&legacy_role_cols, "position", "0");
    let role_updated_at =
        legacy_coalesce_expr(&legacy_role_cols, "updated_at", "CURRENT_TIMESTAMP");
    let role_created_at =
        legacy_coalesce_expr(&legacy_role_cols, "created_at", "CURRENT_TIMESTAMP");

    let message_client_id = legacy_expr(&legacy_message_cols, "client_id", "NULL");
    let message_server_id = legacy_expr(&legacy_message_cols, "server_id", "NULL");
    let message_channel_id = legacy_expr(&legacy_message_cols, "channel_id", "NULL");
    let device_label = legacy_coalesce_expr(&legacy_device_cols, "label", "'Zali device'");
    let device_public_key = legacy_expr(&legacy_device_cols, "public_key", "''");
    let device_signing_key = legacy_expr(&legacy_device_cols, "signing_key", "''");
    let device_key_package = legacy_expr(&legacy_device_cols, "key_package", "'{}'");
    let device_group_epoch = legacy_coalesce_expr(&legacy_device_cols, "group_epoch", "1");
    let device_approved = legacy_coalesce_expr(&legacy_device_cols, "approved", "0");
    let device_revoked = legacy_coalesce_expr(&legacy_device_cols, "revoked", "0");
    let device_approved_by = legacy_expr(&legacy_device_cols, "approved_by", "NULL");
    let device_history_days = legacy_coalesce_expr(&legacy_device_cols, "history_days", "30");
    let device_created_at =
        legacy_coalesce_expr(&legacy_device_cols, "created_at", "CURRENT_TIMESTAMP");
    let device_approved_at = legacy_expr(&legacy_device_cols, "approved_at", "NULL");
    let device_revoked_at = legacy_expr(&legacy_device_cols, "revoked_at", "NULL");

    let mut migrate_queries = vec![
        "INSERT OR IGNORE INTO users (username, password_hash)
         SELECT username, password_hash FROM legacy.users"
            .to_string(),
        "INSERT OR IGNORE INTO contacts (owner, contact, created_at)
         SELECT owner, contact, created_at FROM legacy.contacts"
            .to_string(),
        "INSERT OR IGNORE INTO avatars (username, mime_type, data, updated_at)
         SELECT username, mime_type, data, updated_at FROM legacy.avatars"
            .to_string(),
        format!(
            "INSERT OR IGNORE INTO servers (id, name, description, icon, color, join_link, owner, is_public, created_at, avatar_mime, avatar_data, banner_mime, banner_data)
             SELECT id, name, description, icon, color, {}, {}, {}, created_at, {}, {}, {}, {} FROM legacy.servers",
            servers_join_link,
            servers_owner,
            servers_is_public,
            servers_avatar_mime,
            servers_avatar_data,
            servers_banner_mime,
            servers_banner_data
        ),
        "INSERT OR IGNORE INTO server_members (server_id, username, role, joined_at)
         SELECT server_id, username, role, joined_at FROM legacy.server_members"
            .to_string(),
        format!(
            "INSERT OR IGNORE INTO server_roles (server_id, role_id, name, color, can_view, can_send, can_manage, position, updated_at, created_at)
             SELECT server_id, role_id, name, color, {}, {}, {}, {}, {}, {} FROM legacy.server_roles",
            role_can_view,
            role_can_send,
            role_can_manage,
            role_position,
            role_updated_at,
            role_created_at
        ),
        "INSERT OR IGNORE INTO channels (id, server_id, name, topic, kind, position, created_at)
         SELECT id, server_id, name, topic, kind, position, created_at FROM legacy.channels"
            .to_string(),
        "INSERT OR IGNORE INTO channel_permissions (channel_id, role, can_view, can_send, can_manage, updated_at)
         SELECT channel_id, role, can_view, can_send, can_manage, updated_at FROM legacy.channel_permissions"
            .to_string(),
        "INSERT OR IGNORE INTO server_invites (code, server_id, created_by, max_uses, uses, expires_at, created_at)
         SELECT code, server_id, created_by, max_uses, uses, expires_at, created_at FROM legacy.server_invites"
            .to_string(),
        "INSERT OR IGNORE INTO reactions (message_id, reactor, emoji, updated_at)
         SELECT message_id, reactor, emoji, updated_at FROM legacy.reactions"
            .to_string(),
        format!(
            "INSERT OR IGNORE INTO messages (id, client_id, sender, receiver, filename, timestamp, server_id, channel_id)
             SELECT id, {}, sender, receiver, filename, timestamp, {}, {} FROM legacy.messages",
            message_client_id,
            message_server_id,
            message_channel_id
        ),
    ];
    if legacy_tables.iter().any(|table| table == "account_devices") {
        migrate_queries.push(format!(
            "INSERT OR IGNORE INTO account_devices
             (owner, device_id, label, public_key, signing_key, key_package, group_epoch, approved, revoked, approved_by, history_days, created_at, approved_at, revoked_at)
             SELECT owner, device_id, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}
             FROM legacy.account_devices",
            device_label,
            device_public_key,
            device_signing_key,
            device_key_package,
            device_group_epoch,
            device_approved,
            device_revoked,
            device_approved_by,
            device_history_days,
            device_created_at,
            device_approved_at,
            device_revoked_at
        ));
    }

    for query in migrate_queries {
        if let Err(e) = sqlx::query(&query).execute(&mut *conn).await {
            warn!("Ошибка миграции legacy-данных: {}", e);
        }
    }

    let migrated_messages = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM messages")
        .fetch_one(&mut *conn)
        .await
        .unwrap_or(0);
    let migrated_contacts = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM contacts")
        .fetch_one(&mut *conn)
        .await
        .unwrap_or(0);
    info!(
        "После миграции: messages={}, contacts={}",
        migrated_messages, migrated_contacts
    );

    if let Err(e) = sqlx::query("DETACH DATABASE legacy")
        .execute(&mut *conn)
        .await
    {
        warn!("Не удалось отсоединить legacy БД после миграции: {}", e);
    }

    match copy_missing_uploads(&legacy_uploads, canonical_uploads).await {
        Ok(copied) => {
            if copied > 0 {
                info!("Скопировано {} файлов из legacy uploads", copied);
            }
        }
        Err(e) => warn!("Не удалось скопировать legacy uploads: {}", e),
    }

    Ok(())
}

async fn legacy_table_columns(
    conn: &mut sqlx::pool::PoolConnection<Sqlite>,
    table: &str,
) -> Result<HashSet<String>, sqlx::Error> {
    let sql = match table {
        "servers" | "server_roles" | "messages" | "account_devices" => {
            format!("PRAGMA legacy.table_info({})", table)
        }
        _ => {
            return Err(sqlx::Error::Protocol(
                "Unsupported legacy table name".to_string(),
            ))
        }
    };
    let rows = sqlx::query(&sql).fetch_all(&mut **conn).await?;
    let mut columns = HashSet::new();
    for row in rows {
        if let Ok(name) = row.try_get::<String, _>("name") {
            columns.insert(name);
        }
    }
    Ok(columns)
}

async fn migrate_asset_files(pool: &SqlitePool, data_dir: &Path) -> Result<(), sqlx::Error> {
    let assets_dir = asset_root_dir(data_dir);
    fs::create_dir_all(assets_dir.join("avatars"))
        .await
        .map_err(sqlx::Error::Io)?;
    fs::create_dir_all(assets_dir.join("servers"))
        .await
        .map_err(sqlx::Error::Io)?;

    let avatars: Vec<AvatarRecord> = sqlx::query_as(
        "SELECT username, mime_type, data, updated_at FROM avatars WHERE data IS NOT NULL AND length(data) > 0",
    )
    .fetch_all(pool)
    .await?;
    for avatar in avatars {
        let dir = user_avatar_asset_dir(data_dir, &avatar.username);
        if let Ok(Some((mime, data, _))) = read_asset_file(dir.clone(), "avatar").await {
            if !mime.is_empty() && !data.is_empty() {
                continue;
            }
        }
        write_asset_file(
            dir,
            "avatar",
            &avatar.mime_type,
            &avatar.data,
            Some(avatar.updated_at),
        )
        .await
        .map_err(sqlx::Error::Io)?;
    }

    let servers: Vec<(
        String,
        Option<String>,
        Option<Vec<u8>>,
        Option<String>,
        Option<Vec<u8>>,
    )> = sqlx::query_as(
        "SELECT id, avatar_mime, avatar_data, banner_mime, banner_data FROM servers",
    )
    .fetch_all(pool)
    .await?;
    for (server_id, avatar_mime, avatar_data, banner_mime, banner_data) in servers {
        if let (Some(mime), Some(data)) = (avatar_mime.as_ref(), avatar_data.as_ref()) {
            let dir = server_asset_dir(data_dir, &server_id);
            if fs::try_exists(&asset_file_paths(dir.clone(), "avatar").0)
                .await
                .unwrap_or(false)
            {
                // already migrated
            } else {
                write_asset_file(dir.clone(), "avatar", mime, data, None)
                    .await
                    .map_err(sqlx::Error::Io)?;
            }
        }
        if let (Some(mime), Some(data)) = (banner_mime.as_ref(), banner_data.as_ref()) {
            let dir = server_asset_dir(data_dir, &server_id);
            if fs::try_exists(&asset_file_paths(dir.clone(), "banner").0)
                .await
                .unwrap_or(false)
            {
                // already migrated
            } else {
                write_asset_file(dir, "banner", mime, data, None)
                    .await
                    .map_err(sqlx::Error::Io)?;
            }
        }
    }

    Ok(())
}

// ============================================================
// STATE
// ============================================================

type WsSender = mpsc::Sender<String>;

struct AppState {
    db: SqlitePool,
    data_dir: PathBuf,
    uploads_dir: PathBuf,
    user_connections: DashMap<String, Vec<WsSender>>,
    voice_rooms: DashMap<String, VoiceRoom>,
    user_voice_rooms: DashMap<String, String>,
    ws_tickets: DashMap<String, WsTicketRecord>,
    // Rate limiting: username/IP → timestamps of recent login attempts
    login_attempts: DashMap<String, VecDeque<Instant>>,
    config: Config,
}

// ============================================================
// AUTH EXTRACTOR
// ============================================================

struct AuthenticatedUser(String);

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

// ============================================================
// MODELS
// ============================================================

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
struct Message {
    id: String,
    client_id: Option<String>,
    sender: String,
    receiver: String,
    filename: String,
    timestamp: DateTime<Utc>,
    #[serde(rename = "keyVersion", skip_serializing_if = "Option::is_none")]
    key_version: Option<i64>,
    server_id: Option<String>,
    channel_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct ReactionSummary {
    emoji: String,
    count: i64,
}

#[derive(Debug, Serialize, Clone)]
struct MessageResponse {
    id: String,
    #[serde(rename = "clientId", skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    sender: String,
    receiver: String,
    filename: String,
    timestamp: DateTime<Utc>,
    #[serde(rename = "keyVersion", skip_serializing_if = "Option::is_none")]
    key_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_id: Option<String>,
    reactions: Vec<ReactionSummary>,
    #[serde(rename = "myReaction")]
    my_reaction: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
struct ServerRecord {
    id: String,
    name: String,
    description: String,
    icon: String,
    color: String,
    join_link: String,
    owner: String,
    is_public: i64,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
struct ServerInviteRecord {
    code: String,
    server_id: String,
    created_by: String,
    max_uses: i64,
    uses: i64,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct ServerInviteResponse {
    code: String,
    serverId: String,
    createdBy: String,
    maxUses: i64,
    uses: i64,
    expiresAt: Option<DateTime<Utc>>,
    createdAt: DateTime<Utc>,
    url: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
struct ChannelPermissionRecord {
    channel_id: String,
    role: String,
    can_view: i64,
    can_send: i64,
    can_manage: i64,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct ChannelPermissionResponse {
    role: String,
    canView: bool,
    canSend: bool,
    canManage: bool,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
struct ServerRoleRecord {
    server_id: String,
    role_id: String,
    name: String,
    color: String,
    can_view: i64,
    can_send: i64,
    can_manage: i64,
    can_manage_channels: i64,
    can_manage_roles: i64,
    can_invite: i64,
    can_attach: i64,
    can_embed: i64,
    can_react: i64,
    can_pin: i64,
    can_mention: i64,
    can_voice: i64,
    can_kick: i64,
    can_ban: i64,
    position: i64,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct ServerRoleResponse {
    #[serde(rename = "roleId")]
    role_id: String,
    name: String,
    color: String,
    #[serde(rename = "canView")]
    can_view: bool,
    #[serde(rename = "canSend")]
    can_send: bool,
    #[serde(rename = "canManage")]
    can_manage: bool,
    #[serde(rename = "canManageChannels")]
    can_manage_channels: bool,
    #[serde(rename = "canManageRoles")]
    can_manage_roles: bool,
    #[serde(rename = "canInvite")]
    can_invite: bool,
    #[serde(rename = "canAttach")]
    can_attach: bool,
    #[serde(rename = "canEmbed")]
    can_embed: bool,
    #[serde(rename = "canReact")]
    can_react: bool,
    #[serde(rename = "canPin")]
    can_pin: bool,
    #[serde(rename = "canMention")]
    can_mention: bool,
    #[serde(rename = "canVoice")]
    can_voice: bool,
    #[serde(rename = "canKick")]
    can_kick: bool,
    #[serde(rename = "canBan")]
    can_ban: bool,
    position: i64,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
struct ChannelRecord {
    id: String,
    server_id: String,
    name: String,
    topic: String,
    kind: String,
    position: i64,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone)]
struct ChannelResponse {
    id: String,
    name: String,
    topic: String,
    kind: String,
    position: i64,
}

#[derive(Debug, Clone)]
struct VoiceRoom {
    room_type: String,
    server_id: Option<String>,
    channel_id: Option<String>,
    call_state: String,
    initiator: Option<String>,
    target: Option<String>,
    participants: HashSet<String>,
}

impl VoiceRoom {
    fn new(room_type: String, server_id: Option<String>, channel_id: Option<String>) -> Self {
        Self {
            room_type,
            server_id,
            channel_id,
            call_state: "active".to_string(),
            initiator: None,
            target: None,
            participants: HashSet::new(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ServerResponse {
    id: String,
    name: String,
    description: String,
    icon: String,
    color: String,
    #[serde(rename = "joinLink")]
    join_link: String,
    owner: String,
    is_public: bool,
    #[serde(rename = "myRole")]
    my_role: Option<String>,
    #[serde(rename = "memberCount")]
    member_count: i64,
    channels: Vec<ChannelResponse>,
}

#[derive(Debug, Serialize)]
struct ServerListResponse {
    servers: Vec<ServerResponse>,
}

#[derive(Debug, Deserialize)]
struct ReactionPayload {
    emoji: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
struct AvatarRecord {
    username: String,
    mime_type: String,
    data: Vec<u8>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iss: String,
    aud: String,
    token_version: i64,
    jti: String,
    exp: usize,
}

#[derive(Deserialize)]
struct AuthPayload {
    username: String,
    password: String,
}

#[derive(Serialize, Clone)]
struct AuthResponse {
    token: String,
    username: String,
    #[serde(rename = "cloudVaultSyncEnabled")]
    cloud_vault_sync_enabled: bool,
}

#[derive(Debug, Serialize)]
struct WsTicketResponse {
    ticket: String,
}

#[derive(Debug, Clone)]
struct WsTicketRecord {
    username: String,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
struct ContactPayload {
    username: String,
}

#[derive(Debug, Serialize)]
struct ContactListResponse {
    contacts: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ServerPayload {
    name: String,
    description: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    join_link: Option<String>,
    is_public: Option<bool>,
    avatar_data_url: Option<String>,
    banner_data_url: Option<String>,
    roles: Option<Vec<ServerRolePayload>>,
}

#[derive(Debug, Deserialize)]
struct CloudVaultSyncPayload {
    #[serde(rename = "cloudVaultSyncEnabled")]
    cloud_vault_sync_enabled: bool,
}

#[derive(Debug, Serialize)]
struct MeResponse {
    username: String,
    #[serde(rename = "cloudVaultSyncEnabled")]
    cloud_vault_sync_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct ChannelPayload {
    name: String,
    topic: Option<String>,
    kind: Option<String>,
    can_view: Option<bool>,
    can_send: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ChannelUpdatePayload {
    name: Option<String>,
    topic: Option<String>,
    kind: Option<String>,
    position: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
struct ServerMemberRecord {
    server_id: String,
    username: String,
    role: String,
    joined_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct ServerMemberResponse {
    username: String,
    role: String,
    #[serde(rename = "joinedAt")]
    joined_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct ServerSettingsPayload {
    name: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    join_link: Option<String>,
    is_public: Option<bool>,
    avatar_data_url: Option<String>,
    banner_data_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ServerMemberPayload {
    username: String,
    role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InvitePayload {
    max_uses: Option<i64>,
    expires_hours: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct JoinInvitePayload {
    code: String,
}

#[derive(Debug, Deserialize)]
struct JoinServerLinkPayload {
    link: String,
}

#[derive(Debug, Deserialize)]
struct ChannelPermissionsPayload {
    permissions: Vec<ChannelPermissionInput>,
}

#[derive(Debug, Deserialize)]
struct ChannelPermissionInput {
    role: String,
    can_view: Option<bool>,
    can_send: Option<bool>,
    can_manage: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ServerRolePayload {
    name: String,
    color: Option<String>,
    can_view: Option<bool>,
    can_send: Option<bool>,
    can_manage: Option<bool>,
    can_manage_channels: Option<bool>,
    can_manage_roles: Option<bool>,
    can_invite: Option<bool>,
    can_attach: Option<bool>,
    can_embed: Option<bool>,
    can_react: Option<bool>,
    can_pin: Option<bool>,
    can_mention: Option<bool>,
    can_voice: Option<bool>,
    can_kick: Option<bool>,
    can_ban: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ServerAssetPayload {
    data_url: String,
}

#[derive(Debug, Deserialize, Default)]
struct MessagePageQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    since: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct UserSearchQuery {
    q: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredAssetMeta {
    mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
struct DeviceRecord {
    device_id: String,
    owner: String,
    label: String,
    public_key: String,
    signing_key: String,
    key_package: String,
    group_epoch: i64,
    approved: i64,
    revoked: i64,
    approved_by: Option<String>,
    history_days: i64,
    created_at: DateTime<Utc>,
    approved_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct DeviceResponse {
    deviceId: String,
    owner: String,
    label: String,
    publicKey: String,
    keyPackage: serde_json::Value,
    groupEpoch: i64,
    approved: bool,
    revoked: bool,
    approvedBy: Option<String>,
    historyDays: i64,
    createdAt: DateTime<Utc>,
    approvedAt: Option<DateTime<Utc>>,
    revokedAt: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct RegisterDevicePayload {
    deviceId: String,
    label: Option<String>,
    publicKey: Option<String>,
    signingKey: Option<String>,
    keyPackage: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct ApproveDevicePayload {
    deviceId: String,
    approvedByDeviceId: String,
    keyPackage: Option<serde_json::Value>,
    signature: Option<String>,
    historyDays: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct VaultEventPayload {
    deviceId: String,
    vaultEpoch: Option<i64>,
    encryptedVaultEvent: String,
    issuedToDeviceId: Option<String>,
    signature: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct VaultEventRecord {
    event_id: String,
    owner: String,
    device_id: String,
    issued_to_device_id: Option<String>,
    vault_epoch: i64,
    encrypted_vault_event: String,
    signature: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct VaultEventResponse {
    eventId: String,
    owner: String,
    deviceId: String,
    issuedToDeviceId: Option<String>,
    vaultEpoch: i64,
    encryptedVaultEvent: String,
    signature: String,
    createdAt: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct KeyEnvelopePayload {
    recipient: String,
    scope: String,
    recipientDeviceId: String,
    senderDeviceId: String,
    encryptedKey: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct KeyEnvelopeRecord {
    envelope_id: String,
    owner: String,
    scope_key: String,
    sender: String,
    sender_device_id: String,
    recipient_device_id: String,
    encrypted_key: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct KeyEnvelopeResponse {
    envelopeId: String,
    owner: String,
    scope: String,
    sender: String,
    senderDeviceId: String,
    recipientDeviceId: String,
    encryptedKey: String,
    createdAt: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct HistoryTicketPayload {
    issuedByDeviceId: String,
    issuedToDeviceId: String,
    conversationId: String,
    fromTime: String,
    toTime: String,
    expiresAt: String,
    encryptedExportSecrets: String,
    signature: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct HistoryTicketRecord {
    ticket_id: String,
    owner: String,
    issued_by_device_id: String,
    issued_to_device_id: String,
    conversation_id: String,
    from_time: DateTime<Utc>,
    to_time: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    encrypted_export_secrets: String,
    signature: String,
    revoked: i64,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct HistoryTicketResponse {
    ticketId: String,
    owner: String,
    issuedByDeviceId: String,
    issuedToDeviceId: String,
    conversationId: String,
    fromTime: DateTime<Utc>,
    toTime: DateTime<Utc>,
    expiresAt: DateTime<Utc>,
    encryptedExportSecrets: String,
    signature: String,
    revoked: bool,
    createdAt: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct TransparencyLogRecord {
    seq: i64,
    owner: String,
    event_type: String,
    group_epoch: i64,
    actor_device_id: String,
    target_device_id: Option<String>,
    event_json: String,
    signature: String,
    created_at: DateTime<Utc>,
}

// ============================================================
// MAIN
// ============================================================

#[tokio::main]
async fn main() {
    // Structured logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("zali_server=info,tower_http=warn")
            }),
        )
        .init();

    set_windows_app_user_model_id();

    let config = Config::from_env();

    let data_dir = canonical_data_dir();
    let uploads_dir = data_dir.join("uploads");
    let db_path = data_dir.join("zali_messenger.db");

    fs::create_dir_all(&data_dir).await.ok();
    fs::create_dir_all(&uploads_dir).await.ok();

    info!("Каноническая директория данных: {}", data_dir.display());
    info!("Каноническая БД: {}", db_path.display());
    info!("Каноническая uploads: {}", uploads_dir.display());

    let sqlite_options =
        SqliteConnectOptions::from_str(&format!("sqlite:{}?mode=rwc", db_path.to_string_lossy()))
            .expect("Ошибка разбора строки подключения к базе данных")
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .min_connections(1)
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(sqlite_options)
        .await
        .expect("Ошибка подключения к базе данных");

    // Run migrations
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы users");
    sqlx::query("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE users ADD COLUMN cloud_vault_sync_enabled INTEGER NOT NULL DEFAULT 1")
        .execute(&pool)
        .await
        .ok();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            client_id TEXT,
            sender TEXT NOT NULL,
            receiver TEXT NOT NULL,
            filename TEXT NOT NULL,
            timestamp DATETIME NOT NULL,
            key_version INTEGER NOT NULL DEFAULT 2
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы messages");

    sqlx::query("ALTER TABLE messages ADD COLUMN server_id TEXT")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE messages ADD COLUMN channel_id TEXT")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE messages ADD COLUMN client_id TEXT")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE messages ADD COLUMN key_version INTEGER")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("DROP INDEX IF EXISTS idx_messages_client_id")
        .execute(&pool)
        .await
        .ok();
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_scope
         ON messages (client_id, sender, receiver, COALESCE(server_id, ''), COALESCE(channel_id, ''))
         WHERE client_id IS NOT NULL AND client_id <> ''",
    )
        .execute(&pool)
        .await
        .ok();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS contacts (
            owner TEXT NOT NULL,
            contact TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (owner, contact)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы contacts");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS avatars (
            username TEXT PRIMARY KEY,
            mime_type TEXT NOT NULL,
            data BLOB NOT NULL,
            updated_at DATETIME NOT NULL
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы avatars");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS conversation_keys (
            scope_key TEXT PRIMARY KEY,
            key_value TEXT NOT NULL,
            key_version INTEGER NOT NULL DEFAULT 2,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы conversation_keys");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS account_devices (
            owner TEXT NOT NULL,
            device_id TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            public_key TEXT NOT NULL DEFAULT '',
            signing_key TEXT NOT NULL DEFAULT '',
            key_package TEXT NOT NULL DEFAULT '{}',
            group_epoch INTEGER NOT NULL DEFAULT 1,
            approved INTEGER NOT NULL DEFAULT 0,
            revoked INTEGER NOT NULL DEFAULT 0,
            approved_by TEXT,
            history_days INTEGER NOT NULL DEFAULT 30,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            approved_at DATETIME,
            revoked_at DATETIME,
            PRIMARY KEY (owner, device_id)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы account_devices");
    sqlx::query("ALTER TABLE account_devices ADD COLUMN history_days INTEGER NOT NULL DEFAULT 30")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE account_devices ADD COLUMN approved_at DATETIME")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE account_devices ADD COLUMN revoked_at DATETIME")
        .execute(&pool)
        .await
        .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_account_devices_owner_epoch
         ON account_devices (owner, group_epoch, created_at)",
    )
    .execute(&pool)
    .await
    .ok();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS account_vault_events (
            event_id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            device_id TEXT NOT NULL,
            issued_to_device_id TEXT,
            vault_epoch INTEGER NOT NULL,
            encrypted_vault_event TEXT NOT NULL,
            signature TEXT NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы account_vault_events");
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_account_vault_events_owner_epoch
         ON account_vault_events (owner, vault_epoch, created_at)",
    )
    .execute(&pool)
    .await
    .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_account_vault_events_target
         ON account_vault_events (owner, issued_to_device_id, created_at)",
    )
    .execute(&pool)
    .await
    .ok();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS conversation_key_envelopes (
            envelope_id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            sender TEXT NOT NULL,
            sender_device_id TEXT NOT NULL,
            recipient_device_id TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(owner, scope_key, sender_device_id, recipient_device_id)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы conversation_key_envelopes");
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_conversation_key_envelopes_owner_device
         ON conversation_key_envelopes (owner, recipient_device_id, created_at)",
    )
    .execute(&pool)
    .await
    .ok();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS history_tickets (
            ticket_id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            issued_by_device_id TEXT NOT NULL,
            issued_to_device_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            from_time DATETIME NOT NULL,
            to_time DATETIME NOT NULL,
            expires_at DATETIME NOT NULL,
            encrypted_export_secrets TEXT NOT NULL,
            signature TEXT NOT NULL DEFAULT '',
            revoked INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы history_tickets");
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_history_tickets_owner_device
         ON history_tickets (owner, issued_to_device_id, expires_at)",
    )
    .execute(&pool)
    .await
    .ok();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS transparency_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            event_type TEXT NOT NULL,
            group_epoch INTEGER NOT NULL,
            actor_device_id TEXT NOT NULL,
            target_device_id TEXT,
            event_json TEXT NOT NULL,
            signature TEXT NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы transparency_log");
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_transparency_log_owner_seq
         ON transparency_log (owner, seq)",
    )
    .execute(&pool)
    .await
    .ok();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            icon TEXT NOT NULL DEFAULT 'S',
            color TEXT NOT NULL DEFAULT '#cbff00',
            join_link TEXT NOT NULL DEFAULT '',
            owner TEXT NOT NULL,
            is_public INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы servers");

    sqlx::query("ALTER TABLE servers ADD COLUMN avatar_mime TEXT")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE servers ADD COLUMN avatar_data BLOB")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE servers ADD COLUMN banner_mime TEXT")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE servers ADD COLUMN banner_data BLOB")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("ALTER TABLE servers ADD COLUMN join_link TEXT NOT NULL DEFAULT ''")
        .execute(&pool)
        .await
        .ok();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS server_members (
            server_id TEXT NOT NULL,
            username TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (server_id, username)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы server_members");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS server_roles (
            server_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#cbff00',
            can_view INTEGER NOT NULL DEFAULT 1,
            can_send INTEGER NOT NULL DEFAULT 1,
            can_manage INTEGER NOT NULL DEFAULT 0,
            can_manage_channels INTEGER NOT NULL DEFAULT 0,
            can_manage_roles INTEGER NOT NULL DEFAULT 0,
            can_invite INTEGER NOT NULL DEFAULT 0,
            can_attach INTEGER NOT NULL DEFAULT 1,
            can_embed INTEGER NOT NULL DEFAULT 1,
            can_react INTEGER NOT NULL DEFAULT 1,
            can_pin INTEGER NOT NULL DEFAULT 0,
            can_mention INTEGER NOT NULL DEFAULT 0,
            can_voice INTEGER NOT NULL DEFAULT 1,
            can_kick INTEGER NOT NULL DEFAULT 0,
            can_ban INTEGER NOT NULL DEFAULT 0,
            position INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (server_id, role_id)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы server_roles");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            server_id TEXT NOT NULL,
            name TEXT NOT NULL,
            topic TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'text',
            position INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(server_id, name)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы channels");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS channel_permissions (
            channel_id TEXT NOT NULL,
            role TEXT NOT NULL,
            can_view INTEGER NOT NULL DEFAULT 1,
            can_send INTEGER NOT NULL DEFAULT 1,
            can_manage INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (channel_id, role)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы channel_permissions");

    let extra_server_role_columns = [
        ("can_manage_channels", "INTEGER NOT NULL DEFAULT 0"),
        ("can_manage_roles", "INTEGER NOT NULL DEFAULT 0"),
        ("can_invite", "INTEGER NOT NULL DEFAULT 0"),
        ("can_attach", "INTEGER NOT NULL DEFAULT 1"),
        ("can_embed", "INTEGER NOT NULL DEFAULT 1"),
        ("can_react", "INTEGER NOT NULL DEFAULT 1"),
        ("can_pin", "INTEGER NOT NULL DEFAULT 0"),
        ("can_mention", "INTEGER NOT NULL DEFAULT 0"),
        ("can_voice", "INTEGER NOT NULL DEFAULT 1"),
        ("can_kick", "INTEGER NOT NULL DEFAULT 0"),
        ("can_ban", "INTEGER NOT NULL DEFAULT 0"),
    ];
    for (column, definition) in extra_server_role_columns {
        let query = format!(
            "ALTER TABLE server_roles ADD COLUMN {} {}",
            column, definition
        );
        sqlx::query(&query).execute(&pool).await.ok();
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS server_invites (
            code TEXT PRIMARY KEY,
            server_id TEXT NOT NULL,
            created_by TEXT NOT NULL,
            max_uses INTEGER NOT NULL DEFAULT 0,
            uses INTEGER NOT NULL DEFAULT 0,
            expires_at DATETIME,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы server_invites");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS reactions (
            message_id TEXT NOT NULL,
            reactor TEXT NOT NULL,
            emoji TEXT NOT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (message_id, reactor)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы reactions");

    // Create indexes for fast queries
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages (receiver)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_messages_server_channel ON messages (server_id, channel_id, timestamp)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts (owner)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_server_members_server_id ON server_members (server_id)",
    )
    .execute(&pool)
    .await
    .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_server_members_username ON server_members (username)",
    )
    .execute(&pool)
    .await
    .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_server_roles_server_id ON server_roles (server_id)",
    )
    .execute(&pool)
    .await
    .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_channels_server_id ON channels (server_id)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_channel_permissions_channel_id ON channel_permissions (channel_id)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_server_invites_server_id ON server_invites (server_id)",
    )
    .execute(&pool)
    .await
    .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions (message_id)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_reactions_reactor ON reactions (reactor)")
        .execute(&pool)
        .await
        .ok();

    if let Err(e) = migrate_legacy_storage(&pool, &db_path, &uploads_dir).await {
        warn!("Миграция legacy storage завершилась с ошибкой: {}", e);
    }
    if let Err(e) = migrate_asset_files(&pool, &data_dir).await {
        warn!("Миграция asset storage завершилась с ошибкой: {}", e);
    }

    seed_default_servers(&pool).await.ok();
    sqlx::query(
        "INSERT OR IGNORE INTO server_members (server_id, username, role, joined_at)
         SELECT id, owner, 'owner', created_at FROM servers",
    )
    .execute(&pool)
    .await
    .ok();

    // CORS
    let origins: Vec<HeaderValue> = config
        .allowed_origins
        .iter()
        .filter_map(|o| o.parse::<HeaderValue>().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::COOKIE,
            HeaderName::from_static("x-zali-device-id"),
        ])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::DELETE,
            Method::PUT,
            Method::PATCH,
        ]);

    let max_upload = config.max_upload_bytes;

    let state = Arc::new(AppState {
        db: pool,
        data_dir,
        uploads_dir,
        user_connections: DashMap::new(),
        voice_rooms: DashMap::new(),
        user_voice_rooms: DashMap::new(),
        ws_tickets: DashMap::new(),
        login_attempts: DashMap::new(),
        config,
    });

    {
        let cleanup_state = Arc::clone(&state);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                cleanup_state
                    .ws_tickets
                    .retain(|_, record| record.expires_at > Instant::now());
            }
        });
    }

    info!(
        "Серверное хранилище активировано: data_dir={}, uploads_dir={}",
        state.data_dir.display(),
        state.uploads_dir.display()
    );

    let app = Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/ws-ticket", post(create_ws_ticket))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me).patch(update_me))
        .route("/api/users", get(get_users))
        .route("/api/users/:username/devices", get(get_user_public_devices))
        .route("/api/avatar/:username", get(get_avatar))
        .route("/api/avatar", post(upload_avatar).delete(delete_avatar))
        .route("/api/contacts", get(get_contacts).post(add_contact))
        .route(
            "/api/contacts/:username",
            axum::routing::delete(delete_contact),
        )
        .route("/api/servers", get(get_servers).post(create_server))
        .route("/api/discover/servers", get(get_public_servers))
        .route("/api/servers/join", post(join_server_link))
        .route(
            "/api/servers/:server_id/channels",
            get(get_channels).post(create_channel),
        )
        .route(
            "/api/servers/:server_id/channels/:channel_id",
            patch(update_channel).delete(delete_channel),
        )
        .route("/api/servers/:server_id", put(update_server))
        .route(
            "/api/servers/:server_id/assets/avatar",
            get(get_server_avatar)
                .put(set_server_avatar)
                .delete(delete_server_avatar),
        )
        .route(
            "/api/servers/:server_id/assets/banner",
            get(get_server_banner)
                .put(set_server_banner)
                .delete(delete_server_banner),
        )
        .route(
            "/api/servers/:server_id/members",
            get(get_server_members).post(add_server_member),
        )
        .route(
            "/api/servers/:server_id/members/:username",
            patch(update_server_member).delete(delete_server_member),
        )
        .route(
            "/api/servers/:server_id/roles",
            get(get_server_roles).post(create_server_role),
        )
        .route(
            "/api/servers/:server_id/roles/:role_id",
            patch(update_server_role).delete(delete_server_role),
        )
        .route(
            "/api/servers/:server_id/invites",
            get(get_server_invites).post(create_server_invite),
        )
        .route("/api/invites/:code/join", post(join_server_invite))
        .route(
            "/api/servers/:server_id/channels/:channel_id/permissions",
            get(get_channel_permissions).put(update_channel_permissions),
        )
        .route(
            "/api/servers/:server_id",
            axum::routing::delete(delete_server),
        )
        .route(
            "/api/servers/:server_id/channels/:channel_id/messages",
            get(get_server_messages).post(upload_server_message),
        )
        .route("/api/devices", get(get_devices).post(register_device))
        .route("/api/devices/approve", post(approve_device))
        .route(
            "/api/devices/:device_id",
            axum::routing::delete(revoke_device),
        )
        .route(
            "/api/vault/events",
            get(get_vault_events)
                .post(post_vault_event)
                .delete(delete_vault_events),
        )
        .route(
            "/api/key-envelopes",
            get(get_key_envelopes)
                .post(post_key_envelope)
                .delete(delete_key_envelopes),
        )
        .route(
            "/api/history-tickets",
            get(get_history_tickets).post(create_history_ticket),
        )
        .route("/api/transparency-log", get(get_transparency_log))
        .route("/api/messages/:user", get(get_messages))
        .route("/api/message/:id/reaction", post(set_message_reaction))
        .route("/api/upload", post(upload_message))
        .route("/api/download/:id", get(download_message))
        .route("/api/message/:id", axum::routing::delete(delete_message))
        .route("/ws", get(ws_handler))
        .route("/health", get(health_check))
        .route("/uploads/:filename", get(download_upload_file))
        .layer(middleware::from_fn(rewrite_api_v1))
        .layer(DefaultBodyLimit::max(max_upload))
        .layer(cors)
        .layer(middleware::from_fn(security_headers))
        .with_state(state);

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:3000".to_string())
        .parse()
        .expect("Неверный BIND_ADDR");
    info!("🚀 Zali Server запущен на http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .unwrap();
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = async {
                if let Some(ref mut stream) = sigterm {
                    let _ = stream.recv().await;
                }
            } => {},
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }

    info!("Получен сигнал завершения, сервер останавливается gracefully");
}

// ============================================================
// HANDLERS
// ============================================================

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

async fn column_exists(pool: &SqlitePool, column: &str) -> Result<bool, sqlx::Error> {
    let rows = sqlx::query("PRAGMA table_info(messages)")
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().any(|row| {
        let name: String = row.get("name");
        name == column
    }))
}

async fn ensure_message_columns(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    if !column_exists(pool, "server_id").await? {
        sqlx::query("ALTER TABLE messages ADD COLUMN server_id TEXT")
            .execute(pool)
            .await?;
    }
    if !column_exists(pool, "channel_id").await? {
        sqlx::query("ALTER TABLE messages ADD COLUMN channel_id TEXT")
            .execute(pool)
            .await?;
    }
    if !column_exists(pool, "client_id").await? {
        sqlx::query("ALTER TABLE messages ADD COLUMN client_id TEXT")
            .execute(pool)
            .await?;
    }
    if !column_exists(pool, "key_version").await? {
        sqlx::query("ALTER TABLE messages ADD COLUMN key_version INTEGER")
            .execute(pool)
            .await?;
    }
    sqlx::query("DROP INDEX IF EXISTS idx_messages_client_id")
        .execute(pool)
        .await
        .ok();
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_scope
         ON messages (client_id, sender, receiver, COALESCE(server_id, ''), COALESCE(channel_id, ''))
         WHERE client_id IS NOT NULL AND client_id <> ''",
    )
        .execute(pool)
        .await
        .ok();
    Ok(())
}

async fn seed_default_servers(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    ensure_message_columns(pool).await?;
    let server_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM servers")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    if server_count > 0 {
        return Ok(());
    }

    let now = Utc::now();
    let seeds = [
        ("zali-hub", "Zali Hub", "Общий хаб", "Z", "#cbff00"),
        ("dev-team", "Dev Team", "Разработка", "⚙", "#7b61ff"),
        ("friends", "Friends", "Круг общения", "☺", "#ff6b6b"),
        ("music", "Music", "Плейлисты", "♫", "#1fa7ff"),
        ("games", "Games", "Игровой чат", "🎮", "#29c46a"),
        ("study", "Study", "Учёба", "📚", "#ffb74d"),
    ];

    for (idx, (id, name, description, icon, color)) in seeds.iter().enumerate() {
        sqlx::query(
            "INSERT OR IGNORE INTO servers (id, name, description, icon, color, join_link, owner, is_public, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(description)
        .bind(icon)
        .bind(color)
        .bind(format!("zali://server/{}", id))
        .bind("system")
        .bind(now)
        .execute(pool)
        .await?;

        sqlx::query(
            "INSERT OR IGNORE INTO server_members (server_id, username, role, joined_at)
             VALUES (?, ?, 'owner', ?)",
        )
        .bind(id)
        .bind("system")
        .bind(now)
        .execute(pool)
        .await?;

        ensure_default_server_roles(pool, id, now).await?;

        let channel_specs = match *id {
            "zali-hub" => vec![
                ("general", "general", "Общий чат", "text", 0),
                (
                    "announcements",
                    "announcements",
                    "Новости и объявления",
                    "text",
                    1,
                ),
                ("media", "media", "Фото и видео", "text", 2),
                ("voice", "voice", "Голосовой холл", "voice", 3),
            ],
            "dev-team" => vec![
                ("general", "general", "Обсуждение задач", "text", 0),
                ("builds", "builds", "Сборки и релизы", "text", 1),
                ("bugs", "bugs", "Баги и фиксы", "text", 2),
                ("voice", "voice", "Созвон команды", "voice", 3),
            ],
            "friends" => vec![
                ("general", "general", "Разговоры", "text", 0),
                ("memes", "memes", "Мемы", "text", 1),
                ("voice", "voice", "Созвон друзей", "voice", 2),
            ],
            "music" => vec![
                ("general", "general", "Что слушаем", "text", 0),
                ("tracks", "tracks", "Треки и подборки", "text", 1),
                ("voice", "voice", "Музыкальная комната", "voice", 2),
            ],
            "games" => vec![
                ("general", "general", "Основной чат", "text", 0),
                ("party", "party", "Собираем пати", "text", 1),
                ("clips", "clips", "Клипы", "text", 2),
                ("voice", "voice", "Голосовой рейд", "voice", 3),
            ],
            "study" => vec![
                ("general", "general", "Общий чат", "text", 0),
                ("resources", "resources", "Материалы", "text", 1),
                ("homework", "homework", "Домашка", "text", 2),
                ("voice", "voice", "Учебный созвон", "voice", 3),
            ],
            _ => vec![
                ("general", "general", "Общий чат", "text", 0),
                ("voice", "voice", "Голосовой канал", "voice", 1),
            ],
        };

        for (channel_id, name, topic, kind, position) in channel_specs {
            sqlx::query(
                "INSERT OR IGNORE INTO channels (id, server_id, name, topic, kind, position, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(format!("{}-{}", id, channel_id))
            .bind(id)
            .bind(name)
            .bind(topic)
            .bind(kind)
            .bind(position)
            .bind(now + chrono::Duration::seconds((idx * 3 + position as usize) as i64))
            .execute(pool)
            .await?;
        }
    }

    Ok(())
}

async fn ensure_default_server_roles(
    pool: &SqlitePool,
    server_id: &str,
    created_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let default_roles = [
        (
            "member",
            "Участник",
            "#5f6a7a",
            1_i64,
            1_i64,
            0_i64,
            0_i64,
            0_i64,
            0_i64,
            1_i64,
            1_i64,
            1_i64,
            0_i64,
            0_i64,
            1_i64,
            0_i64,
            0_i64,
        ),
        (
            "admin",
            "Админ",
            "#8c7bff",
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
            1_i64,
        ),
    ];

    for (
        position,
        (
            role_id,
            name,
            color,
            can_view,
            can_send,
            can_manage,
            can_manage_channels,
            can_manage_roles,
            can_invite,
            can_attach,
            can_embed,
            can_react,
            can_pin,
            can_mention,
            can_voice,
            can_kick,
            can_ban,
        ),
    ) in default_roles.iter().enumerate()
    {
        sqlx::query(
            "INSERT OR IGNORE INTO server_roles (server_id, role_id, name, color, can_view, can_send, can_manage, can_manage_channels, can_manage_roles, can_invite, can_attach, can_embed, can_react, can_pin, can_mention, can_voice, can_kick, can_ban, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(server_id)
        .bind(role_id)
        .bind(name)
        .bind(color)
        .bind(can_view)
        .bind(can_send)
        .bind(can_manage)
        .bind(can_manage_channels)
        .bind(can_manage_roles)
        .bind(can_invite)
        .bind(can_attach)
        .bind(can_embed)
        .bind(can_react)
        .bind(can_pin)
        .bind(can_mention)
        .bind(can_voice)
        .bind(can_kick)
        .bind(can_ban)
        .bind(position as i64)
        .bind(created_at)
        .execute(pool)
        .await?;
    }

    Ok(())
}

async fn get_server_accessibility(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<Option<ServerRecord>, sqlx::Error> {
    sqlx::query_as::<_, ServerRecord>(
        "SELECT id, name, description, icon, color, join_link, owner, is_public, created_at FROM servers WHERE id = ? LIMIT 1",
    )
    .bind(server_id)
    .fetch_optional(pool)
    .await
}

async fn load_channels_for_server(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<Vec<ChannelResponse>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ChannelRecord>(
        "SELECT id, server_id, name, topic, kind, position, created_at FROM channels WHERE server_id = ? ORDER BY position ASC, name ASC",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| ChannelResponse {
            id: row.id,
            name: row.name,
            topic: row.topic,
            kind: row.kind,
            position: row.position,
        })
        .collect())
}

async fn load_visible_channels_for_server(
    pool: &SqlitePool,
    server_id: &str,
    viewer: &str,
) -> Result<Vec<ChannelResponse>, sqlx::Error> {
    let server = match get_server_accessibility(pool, server_id).await? {
        Some(server) => server,
        None => return Ok(Vec::new()),
    };
    if server.owner == viewer {
        return load_channels_for_server(pool, server_id).await;
    }

    let role = get_server_member_role(pool, server_id, viewer).await?;
    if role.is_none() {
        if server.is_public == 0 {
            return Ok(Vec::new());
        }
        return load_channels_for_server(pool, server_id).await;
    }

    let viewer_role = role.unwrap_or_else(|| "member".to_string());
    let channels = load_channels_for_server(pool, server_id).await?;
    let channel_permissions = load_channel_permissions_map(pool, server_id).await?;
    let server_permissions = load_server_role_permissions_map(pool, server_id).await?;
    let mut visible = Vec::new();
    for channel in channels {
        if channel_allows_action(
            &channel_permissions,
            &server_permissions,
            &viewer_role,
            &channel.id,
            "view",
        ) {
            visible.push(channel);
        }
    }
    Ok(visible)
}

async fn load_server_role_permissions_map(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<HashMap<String, (bool, bool, bool)>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ServerRoleRecord>(
        "SELECT server_id, role_id, name, color, can_view, can_send, can_manage, can_manage_channels, can_manage_roles, can_invite, can_attach, can_embed, can_react, can_pin, can_mention, can_voice, can_kick, can_ban, position, created_at
         FROM server_roles
         WHERE server_id = ?",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;
    let mut map = HashMap::new();
    for role in rows {
        map.insert(
            role.role_id.clone(),
            (role.can_view != 0, role.can_send != 0, role.can_manage != 0),
        );
    }
    map.entry("admin".to_string()).or_insert((true, true, true));
    map.entry("member".to_string())
        .or_insert((true, true, false));
    map.entry("owner".to_string()).or_insert((true, true, true));
    Ok(map)
}

async fn load_channel_permissions_map(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<HashMap<String, HashMap<String, (bool, bool, bool)>>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ChannelPermissionRecord>(
        "SELECT cp.channel_id, cp.role, cp.can_view, cp.can_send, cp.can_manage, cp.updated_at
         FROM channel_permissions cp
         INNER JOIN channels c ON c.id = cp.channel_id
         WHERE c.server_id = ?
         ORDER BY cp.role ASC",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;
    let mut map: HashMap<String, HashMap<String, (bool, bool, bool)>> = HashMap::new();
    for row in rows {
        map.entry(row.channel_id).or_default().insert(
            row.role,
            (row.can_view != 0, row.can_send != 0, row.can_manage != 0),
        );
    }
    Ok(map)
}

fn channel_allows_action(
    channel_permissions: &HashMap<String, HashMap<String, (bool, bool, bool)>>,
    server_permissions: &HashMap<String, (bool, bool, bool)>,
    role: &str,
    channel_id: &str,
    action: &str,
) -> bool {
    if let Some(perms) = channel_permissions.get(channel_id) {
        if let Some((can_view, can_send, can_manage)) = perms.get(role) {
            return match action {
                "view" => *can_view,
                "send" => *can_send,
                "manage" => *can_manage,
                _ => false,
            };
        }
    }
    let fallback = server_permissions
        .get(role)
        .copied()
        .or_else(|| server_permissions.get("member").copied())
        .unwrap_or((true, true, false));
    match action {
        "view" => fallback.0,
        "send" => fallback.1,
        "manage" => fallback.2,
        _ => false,
    }
}

fn normalize_channel_kind(kind: Option<&str>) -> String {
    match kind.unwrap_or("text").trim().to_lowercase().as_str() {
        "voice" => "voice".to_string(),
        _ => "text".to_string(),
    }
}

async fn channel_name_conflicts(
    pool: &SqlitePool,
    server_id: &str,
    name: &str,
    ignore_channel_id: Option<&str>,
) -> Result<bool, sqlx::Error> {
    if name.trim().is_empty() {
        return Ok(false);
    }
    let mut query = String::from("SELECT 1 FROM channels WHERE server_id = ? AND name = ?");
    if ignore_channel_id.is_some() {
        query.push_str(" AND id <> ?");
    }
    query.push_str(" LIMIT 1");

    let mut builder = sqlx::query_scalar::<_, i64>(&query)
        .bind(server_id)
        .bind(name);
    if let Some(channel_id) = ignore_channel_id {
        builder = builder.bind(channel_id);
    }

    Ok(builder.fetch_optional(pool).await?.is_some())
}

async fn build_server_response(
    pool: &SqlitePool,
    server: ServerRecord,
    viewer: &str,
) -> Result<ServerResponse, sqlx::Error> {
    let channels = if can_manage_server(pool, &server.id, viewer)
        .await
        .unwrap_or(false)
    {
        load_channels_for_server(pool, &server.id).await?
    } else {
        load_visible_channels_for_server(pool, &server.id, viewer).await?
    };
    let my_role = get_server_member_role(pool, &server.id, viewer).await?;
    let member_count = get_server_member_count(pool, &server.id).await.unwrap_or(0);
    Ok(ServerResponse {
        id: server.id,
        name: server.name,
        description: server.description,
        icon: server.icon,
        color: server.color,
        join_link: server.join_link,
        owner: server.owner,
        is_public: server.is_public != 0,
        my_role,
        member_count,
        channels,
    })
}

async fn build_server_responses_batch(
    pool: &SqlitePool,
    records: Vec<ServerRecord>,
    viewer: &str,
) -> Result<Vec<ServerResponse>, sqlx::Error> {
    if records.is_empty() {
        return Ok(Vec::new());
    }

    let server_ids: Vec<String> = records.iter().map(|server| server.id.clone()).collect();

    let mut member_counts: HashMap<String, i64> = HashMap::new();
    let mut count_builder = QueryBuilder::<Sqlite>::new(
        "SELECT server_id, COUNT(*) AS count FROM server_members WHERE server_id IN (",
    );
    {
        let mut separated = count_builder.separated(", ");
        for id in &server_ids {
            separated.push_bind(id);
        }
    }
    count_builder.push(") GROUP BY server_id");
    for row in count_builder.build().fetch_all(pool).await? {
        let server_id: String = row.get("server_id");
        let count: i64 = row.get("count");
        member_counts.insert(server_id, count);
    }

    let mut viewer_roles: HashMap<String, String> = records
        .iter()
        .filter(|server| server.owner == viewer)
        .map(|server| (server.id.clone(), "owner".to_string()))
        .collect();
    let mut role_builder =
        QueryBuilder::<Sqlite>::new("SELECT server_id, role FROM server_members WHERE username = ");
    role_builder.push_bind(viewer);
    role_builder.push(" AND server_id IN (");
    {
        let mut separated = role_builder.separated(", ");
        for id in &server_ids {
            separated.push_bind(id);
        }
    }
    role_builder.push(")");
    for row in role_builder.build().fetch_all(pool).await? {
        let server_id: String = row.get("server_id");
        let role: String = row.get("role");
        viewer_roles.entry(server_id).or_insert(role);
    }

    let mut channels_by_server: HashMap<String, Vec<ChannelResponse>> = HashMap::new();
    let mut channel_builder = QueryBuilder::<Sqlite>::new(
        "SELECT id, server_id, name, topic, kind, position, created_at FROM channels WHERE server_id IN (",
    );
    {
        let mut separated = channel_builder.separated(", ");
        for id in &server_ids {
            separated.push_bind(id);
        }
    }
    channel_builder.push(") ORDER BY server_id ASC, position ASC, name ASC");
    for channel in channel_builder
        .build_query_as::<ChannelRecord>()
        .fetch_all(pool)
        .await?
    {
        channels_by_server
            .entry(channel.server_id)
            .or_default()
            .push(ChannelResponse {
                id: channel.id,
                name: channel.name,
                topic: channel.topic,
                kind: channel.kind,
                position: channel.position,
            });
    }

    let mut server_permissions: HashMap<String, HashMap<String, (bool, bool, bool)>> =
        HashMap::new();
    let mut server_perm_builder = QueryBuilder::<Sqlite>::new(
        "SELECT server_id, role_id, can_view, can_send, can_manage FROM server_roles WHERE server_id IN (",
    );
    {
        let mut separated = server_perm_builder.separated(", ");
        for id in &server_ids {
            separated.push_bind(id);
        }
    }
    server_perm_builder.push(")");
    for row in server_perm_builder.build().fetch_all(pool).await? {
        let server_id: String = row.get("server_id");
        let role_id: String = row.get("role_id");
        let can_view: i64 = row.get("can_view");
        let can_send: i64 = row.get("can_send");
        let can_manage: i64 = row.get("can_manage");
        server_permissions
            .entry(server_id)
            .or_default()
            .insert(role_id, (can_view != 0, can_send != 0, can_manage != 0));
    }
    for id in &server_ids {
        let perms = server_permissions.entry(id.clone()).or_default();
        perms
            .entry("admin".to_string())
            .or_insert((true, true, true));
        perms
            .entry("member".to_string())
            .or_insert((true, true, false));
        perms
            .entry("owner".to_string())
            .or_insert((true, true, true));
    }

    let mut channel_permissions: HashMap<
        String,
        HashMap<String, HashMap<String, (bool, bool, bool)>>,
    > = HashMap::new();
    let mut channel_perm_builder = QueryBuilder::<Sqlite>::new(
        "SELECT c.server_id, cp.channel_id, cp.role, cp.can_view, cp.can_send, cp.can_manage
         FROM channel_permissions cp
         INNER JOIN channels c ON c.id = cp.channel_id
         WHERE c.server_id IN (",
    );
    {
        let mut separated = channel_perm_builder.separated(", ");
        for id in &server_ids {
            separated.push_bind(id);
        }
    }
    channel_perm_builder.push(")");
    for row in channel_perm_builder.build().fetch_all(pool).await? {
        let server_id: String = row.get("server_id");
        let channel_id: String = row.get("channel_id");
        let role: String = row.get("role");
        let can_view: i64 = row.get("can_view");
        let can_send: i64 = row.get("can_send");
        let can_manage: i64 = row.get("can_manage");
        channel_permissions
            .entry(server_id)
            .or_default()
            .entry(channel_id)
            .or_default()
            .insert(role, (can_view != 0, can_send != 0, can_manage != 0));
    }

    let mut responses = Vec::with_capacity(records.len());
    for server in records {
        let server_id = server.id.clone();
        let my_role = viewer_roles.get(&server_id).cloned();
        let can_manage = can_manage_by_role(my_role.as_deref())
            || my_role
                .as_deref()
                .and_then(|role| {
                    server_permissions
                        .get(&server_id)
                        .and_then(|perms| perms.get(role))
                })
                .map(|perms| perms.2)
                .unwrap_or(false);
        let all_channels = channels_by_server.remove(&server_id).unwrap_or_default();
        let channels =
            if can_manage || server.owner == viewer || (my_role.is_none() && server.is_public != 0)
            {
                all_channels
            } else if let Some(role) = my_role.as_deref() {
                let empty_channel_permissions = HashMap::new();
                let empty_server_permissions = HashMap::new();
                let channel_perm_map = channel_permissions
                    .get(&server_id)
                    .unwrap_or(&empty_channel_permissions);
                let server_perm_map = server_permissions
                    .get(&server_id)
                    .unwrap_or(&empty_server_permissions);
                all_channels
                    .into_iter()
                    .filter(|channel| {
                        channel_allows_action(
                            channel_perm_map,
                            server_perm_map,
                            role,
                            &channel.id,
                            "view",
                        )
                    })
                    .collect()
            } else {
                Vec::new()
            };

        responses.push(ServerResponse {
            id: server_id.clone(),
            name: server.name,
            description: server.description,
            icon: server.icon,
            color: server.color,
            join_link: server.join_link,
            owner: server.owner,
            is_public: server.is_public != 0,
            my_role,
            member_count: member_counts.get(&server_id).copied().unwrap_or(0),
            channels,
        });
    }

    Ok(responses)
}

fn normalize_server_role(role: Option<&str>) -> Option<String> {
    let value = role.unwrap_or("").trim().to_lowercase();
    match value.as_str() {
        "owner" => Some("owner".to_string()),
        "admin" => Some("admin".to_string()),
        "member" => Some("member".to_string()),
        _ => None,
    }
}

async fn resolve_member_role_input(
    pool: &SqlitePool,
    server_id: &str,
    role: Option<&str>,
) -> Result<String, sqlx::Error> {
    let raw = role.unwrap_or("member").trim();
    if raw.is_empty() {
        return Ok("member".to_string());
    }
    if let Some(normalized) = normalize_server_role(Some(raw)) {
        return Ok(normalized);
    }

    if let Some(custom) = load_server_role_record(pool, server_id, raw).await? {
        return Ok(custom.role_id);
    }

    Err(sqlx::Error::RowNotFound)
}

fn can_manage_by_role(role: Option<&str>) -> bool {
    matches!(role, Some("owner") | Some("admin"))
}

fn normalize_data_url(value: &str) -> Result<(String, Vec<u8>), &'static str> {
    let value = value.trim();
    if !value.starts_with("data:") {
        return Err("Неверный формат data URL");
    }
    let comma = value.find(',').ok_or("Неверный формат data URL")?;
    let meta = &value[5..comma];
    let payload = &value[comma + 1..];
    let parts: Vec<&str> = meta.split(';').collect();
    let mime = parts
        .first()
        .copied()
        .unwrap_or("application/octet-stream")
        .to_string();
    if parts.iter().any(|p| *p == "base64") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|_| "Не удалось декодировать base64")?;
        Ok((mime, bytes))
    } else {
        Err("Поддерживается только base64 data URL")
    }
}

async fn get_server_asset(
    pool: &SqlitePool,
    data_dir: &Path,
    server_id: &str,
    kind: &str,
) -> Result<Option<(String, Vec<u8>)>, sqlx::Error> {
    if kind != "avatar" && kind != "banner" {
        return Ok(None);
    }

    let dir = server_asset_dir(data_dir, server_id);
    if let Ok(Some((mime, data, _))) = read_asset_file(dir.clone(), kind).await {
        if !mime.is_empty() && !data.is_empty() {
            return Ok(Some((mime, data)));
        }
    }

    let row = match kind {
        "avatar" => {
            sqlx::query("SELECT avatar_mime, avatar_data FROM servers WHERE id = ? LIMIT 1")
                .bind(server_id)
                .fetch_optional(pool)
                .await?
        }
        "banner" => {
            sqlx::query("SELECT banner_mime, banner_data FROM servers WHERE id = ? LIMIT 1")
                .bind(server_id)
                .fetch_optional(pool)
                .await?
        }
        _ => return Ok(None),
    };
    let asset = row.and_then(|r| {
        let mime: Option<String> = r.try_get(0).ok();
        let data: Option<Vec<u8>> = r.try_get(1).ok();
        match (mime, data) {
            (Some(m), Some(d)) if !d.is_empty() => Some((m, d)),
            _ => None,
        }
    });

    if let Some((mime, data)) = asset.as_ref() {
        let _ = write_asset_file(dir, kind, mime, data, None).await;
    }

    Ok(asset)
}

async fn set_server_asset(
    pool: &SqlitePool,
    data_dir: &Path,
    server_id: &str,
    kind: &str,
    data_url: &str,
) -> Result<(), sqlx::Error> {
    let (mime, data) = normalize_data_url(data_url).map_err(|_| sqlx::Error::RowNotFound)?;
    let dir = server_asset_dir(data_dir, server_id);
    write_asset_file(dir, kind, &mime, &data, None)
        .await
        .map_err(sqlx::Error::Io)?;
    match kind {
        "avatar" => {
            sqlx::query("UPDATE servers SET avatar_mime = ?, avatar_data = ? WHERE id = ?")
                .bind(mime)
                .bind(data)
                .bind(server_id)
                .execute(pool)
                .await?;
        }
        "banner" => {
            sqlx::query("UPDATE servers SET banner_mime = ?, banner_data = ? WHERE id = ?")
                .bind(mime)
                .bind(data)
                .bind(server_id)
                .execute(pool)
                .await?;
        }
        _ => return Err(sqlx::Error::RowNotFound),
    }
    Ok(())
}

async fn clear_server_asset(
    pool: &SqlitePool,
    data_dir: &Path,
    server_id: &str,
    kind: &str,
) -> Result<(), sqlx::Error> {
    let dir = server_asset_dir(data_dir, server_id);
    let _ = clear_asset_file(dir, kind).await;
    match kind {
        "avatar" => {
            sqlx::query("UPDATE servers SET avatar_mime = NULL, avatar_data = NULL WHERE id = ?")
                .bind(server_id)
                .execute(pool)
                .await?;
        }
        "banner" => {
            sqlx::query("UPDATE servers SET banner_mime = NULL, banner_data = NULL WHERE id = ?")
                .bind(server_id)
                .execute(pool)
                .await?;
        }
        _ => return Err(sqlx::Error::RowNotFound),
    }
    Ok(())
}

async fn load_channel_permissions(
    pool: &SqlitePool,
    channel_id: &str,
) -> Result<Vec<ChannelPermissionResponse>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ChannelPermissionRecord>(
        "SELECT channel_id, role, can_view, can_send, can_manage, updated_at
         FROM channel_permissions
         WHERE channel_id = ?
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| ChannelPermissionResponse {
            role: row.role,
            canView: row.can_view != 0,
            canSend: row.can_send != 0,
            canManage: row.can_manage != 0,
        })
        .collect())
}

async fn channel_belongs_to_server(
    pool: &SqlitePool,
    server_id: &str,
    channel_id: &str,
) -> Result<bool, sqlx::Error> {
    let exists = sqlx::query_scalar::<_, String>(
        "SELECT id FROM channels WHERE id = ? AND server_id = ? LIMIT 1",
    )
    .bind(channel_id)
    .bind(server_id)
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}

async fn load_channel_permission_record(
    pool: &SqlitePool,
    channel_id: &str,
    role: &str,
) -> Result<Option<ChannelPermissionRecord>, sqlx::Error> {
    sqlx::query_as::<_, ChannelPermissionRecord>(
        "SELECT channel_id, role, can_view, can_send, can_manage, updated_at
         FROM channel_permissions
         WHERE channel_id = ? AND role = ? LIMIT 1",
    )
    .bind(channel_id)
    .bind(role)
    .fetch_optional(pool)
    .await
}

async fn load_server_roles(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<Vec<ServerRoleResponse>, sqlx::Error> {
    let created_at = Utc::now();
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_roles WHERE server_id = ?")
        .bind(server_id)
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    if existing == 0 {
        let _ = ensure_default_server_roles(pool, server_id, created_at).await;
    }

    let rows = sqlx::query_as::<_, ServerRoleRecord>(
        "SELECT server_id, role_id, name, color, can_view, can_send, can_manage, can_manage_channels, can_manage_roles, can_invite, can_attach, can_embed, can_react, can_pin, can_mention, can_voice, can_kick, can_ban, position, created_at
         FROM server_roles
         WHERE server_id = ?
         ORDER BY position ASC, name ASC",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| ServerRoleResponse {
            role_id: row.role_id,
            name: row.name,
            color: row.color,
            can_view: row.can_view != 0,
            can_send: row.can_send != 0,
            can_manage: row.can_manage != 0,
            can_manage_channels: row.can_manage_channels != 0,
            can_manage_roles: row.can_manage_roles != 0,
            can_invite: row.can_invite != 0,
            can_attach: row.can_attach != 0,
            can_embed: row.can_embed != 0,
            can_react: row.can_react != 0,
            can_pin: row.can_pin != 0,
            can_mention: row.can_mention != 0,
            can_voice: row.can_voice != 0,
            can_kick: row.can_kick != 0,
            can_ban: row.can_ban != 0,
            position: row.position,
        })
        .collect())
}

async fn load_server_role_record(
    pool: &SqlitePool,
    server_id: &str,
    role_id: &str,
) -> Result<Option<ServerRoleRecord>, sqlx::Error> {
    sqlx::query_as::<_, ServerRoleRecord>(
        "SELECT server_id, role_id, name, color, can_view, can_send, can_manage, can_manage_channels, can_manage_roles, can_invite, can_attach, can_embed, can_react, can_pin, can_mention, can_voice, can_kick, can_ban, position, created_at
         FROM server_roles
         WHERE server_id = ? AND role_id = ? LIMIT 1",
    )
    .bind(server_id)
    .bind(role_id)
    .fetch_optional(pool)
    .await
}

async fn load_server_role_permissions(
    pool: &SqlitePool,
    server_id: &str,
    role_id: &str,
) -> Result<(bool, bool, bool), sqlx::Error> {
    if role_id == "owner" {
        return Ok((true, true, true));
    }
    if let Some(role) = load_server_role_record(pool, server_id, role_id).await? {
        return Ok((role.can_view != 0, role.can_send != 0, role.can_manage != 0));
    }
    match role_id {
        "admin" => Ok((true, true, true)),
        "member" => Ok((true, true, false)),
        _ => Ok((true, true, false)),
    }
}

fn slug_role_id(value: &str) -> String {
    let mut out = String::new();
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if ch.is_whitespace() || ch == '-' || ch == '_' {
            if !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "role".to_string()
    } else {
        trimmed
    }
}

async fn create_server_role_record(
    pool: &SqlitePool,
    server_id: &str,
    payload: &ServerRolePayload,
) -> Result<ServerRoleResponse, sqlx::Error> {
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(sqlx::Error::RowNotFound);
    }
    let base_id = slug_role_id(name);
    let suffix = Uuid::new_v4().simple().to_string();
    let role_id = format!("{}-{}", base_id, &suffix[..6]);
    let color = payload
        .color
        .clone()
        .unwrap_or_else(|| "#cbff00".to_string());
    let can_view = payload.can_view.unwrap_or(true) as i64;
    let can_send = payload.can_send.unwrap_or(true) as i64;
    let can_manage = payload.can_manage.unwrap_or(false) as i64;
    let can_manage_channels = payload.can_manage_channels.unwrap_or(false) as i64;
    let can_manage_roles = payload.can_manage_roles.unwrap_or(false) as i64;
    let can_invite = payload.can_invite.unwrap_or(true) as i64;
    let can_attach = payload.can_attach.unwrap_or(true) as i64;
    let can_embed = payload.can_embed.unwrap_or(true) as i64;
    let can_react = payload.can_react.unwrap_or(true) as i64;
    let can_pin = payload.can_pin.unwrap_or(false) as i64;
    let can_mention = payload.can_mention.unwrap_or(false) as i64;
    let can_voice = payload.can_voice.unwrap_or(true) as i64;
    let can_kick = payload.can_kick.unwrap_or(false) as i64;
    let can_ban = payload.can_ban.unwrap_or(false) as i64;
    let position: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM server_roles WHERE server_id = ?",
    )
    .bind(server_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    sqlx::query(
        "INSERT INTO server_roles (server_id, role_id, name, color, can_view, can_send, can_manage, can_manage_channels, can_manage_roles, can_invite, can_attach, can_embed, can_react, can_pin, can_mention, can_voice, can_kick, can_ban, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(server_id)
    .bind(&role_id)
    .bind(name)
    .bind(&color)
    .bind(can_view)
    .bind(can_send)
    .bind(can_manage)
    .bind(can_manage_channels)
    .bind(can_manage_roles)
    .bind(can_invite)
    .bind(can_attach)
    .bind(can_embed)
    .bind(can_react)
    .bind(can_pin)
    .bind(can_mention)
    .bind(can_voice)
    .bind(can_kick)
    .bind(can_ban)
    .bind(position)
    .bind(Utc::now())
    .execute(pool)
    .await?;

    Ok(ServerRoleResponse {
        role_id,
        name: name.to_string(),
        color,
        can_view: can_view != 0,
        can_send: can_send != 0,
        can_manage: can_manage != 0,
        can_manage_channels: can_manage_channels != 0,
        can_manage_roles: can_manage_roles != 0,
        can_invite: can_invite != 0,
        can_attach: can_attach != 0,
        can_embed: can_embed != 0,
        can_react: can_react != 0,
        can_pin: can_pin != 0,
        can_mention: can_mention != 0,
        can_voice: can_voice != 0,
        can_kick: can_kick != 0,
        can_ban: can_ban != 0,
        position,
    })
}

async fn update_server_role_record(
    pool: &SqlitePool,
    server_id: &str,
    role_id: &str,
    payload: &ServerRolePayload,
) -> Result<ServerRoleResponse, sqlx::Error> {
    let current = load_server_role_record(pool, server_id, role_id).await?;
    let current = match current {
        Some(role) => role,
        None => return Err(sqlx::Error::RowNotFound),
    };
    let next_name = if payload.name.trim().is_empty() {
        current.name
    } else {
        payload.name.trim().to_string()
    };
    let next_color = payload.color.clone().unwrap_or(current.color);
    let next_view = payload.can_view.unwrap_or(current.can_view != 0) as i64;
    let next_send = payload.can_send.unwrap_or(current.can_send != 0) as i64;
    let next_manage = payload.can_manage.unwrap_or(current.can_manage != 0) as i64;
    let next_manage_channels = payload
        .can_manage_channels
        .unwrap_or(current.can_manage_channels != 0) as i64;
    let next_manage_roles = payload
        .can_manage_roles
        .unwrap_or(current.can_manage_roles != 0) as i64;
    let next_invite = payload.can_invite.unwrap_or(current.can_invite != 0) as i64;
    let next_attach = payload.can_attach.unwrap_or(current.can_attach != 0) as i64;
    let next_embed = payload.can_embed.unwrap_or(current.can_embed != 0) as i64;
    let next_react = payload.can_react.unwrap_or(current.can_react != 0) as i64;
    let next_pin = payload.can_pin.unwrap_or(current.can_pin != 0) as i64;
    let next_mention = payload.can_mention.unwrap_or(current.can_mention != 0) as i64;
    let next_voice = payload.can_voice.unwrap_or(current.can_voice != 0) as i64;
    let next_kick = payload.can_kick.unwrap_or(current.can_kick != 0) as i64;
    let next_ban = payload.can_ban.unwrap_or(current.can_ban != 0) as i64;
    sqlx::query(
        "UPDATE server_roles
         SET name = ?, color = ?, can_view = ?, can_send = ?, can_manage = ?, can_manage_channels = ?, can_manage_roles = ?, can_invite = ?, can_attach = ?, can_embed = ?, can_react = ?, can_pin = ?, can_mention = ?, can_voice = ?, can_kick = ?, can_ban = ?, updated_at = CURRENT_TIMESTAMP
         WHERE server_id = ? AND role_id = ?",
    )
    .bind(&next_name)
    .bind(&next_color)
    .bind(next_view)
    .bind(next_send)
    .bind(next_manage)
    .bind(next_manage_channels)
    .bind(next_manage_roles)
    .bind(next_invite)
    .bind(next_attach)
    .bind(next_embed)
    .bind(next_react)
    .bind(next_pin)
    .bind(next_mention)
    .bind(next_voice)
    .bind(next_kick)
    .bind(next_ban)
    .bind(server_id)
    .bind(role_id)
    .execute(pool)
    .await?;

    Ok(ServerRoleResponse {
        role_id: role_id.to_string(),
        name: next_name,
        color: next_color,
        can_view: next_view != 0,
        can_send: next_send != 0,
        can_manage: next_manage != 0,
        can_manage_channels: next_manage_channels != 0,
        can_manage_roles: next_manage_roles != 0,
        can_invite: next_invite != 0,
        can_attach: next_attach != 0,
        can_embed: next_embed != 0,
        can_react: next_react != 0,
        can_pin: next_pin != 0,
        can_mention: next_mention != 0,
        can_voice: next_voice != 0,
        can_kick: next_kick != 0,
        can_ban: next_ban != 0,
        position: current.position,
    })
}

async fn delete_server_role_record(
    pool: &SqlitePool,
    server_id: &str,
    role_id: &str,
) -> Result<(), sqlx::Error> {
    if role_id == "member" || role_id == "admin" || role_id == "owner" {
        return Err(sqlx::Error::RowNotFound);
    }
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE server_members SET role = 'member' WHERE server_id = ? AND role = ?")
        .bind(server_id)
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM server_roles WHERE server_id = ? AND role_id = ?")
        .bind(server_id)
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn upsert_channel_permissions(
    pool: &SqlitePool,
    channel_id: &str,
    perms: &[ChannelPermissionInput],
) -> Result<(), sqlx::Error> {
    for perm in perms {
        let role = normalize_server_role(Some(&perm.role)).ok_or(sqlx::Error::RowNotFound)?;
        if role == "owner" {
            continue;
        }
        let can_view = perm.can_view.unwrap_or(true) as i64;
        let can_send = perm.can_send.unwrap_or(true) as i64;
        let can_manage = perm.can_manage.unwrap_or(false) as i64;
        sqlx::query(
            "INSERT INTO channel_permissions (channel_id, role, can_view, can_send, can_manage, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(channel_id, role) DO UPDATE SET
                can_view = excluded.can_view,
                can_send = excluded.can_send,
                can_manage = excluded.can_manage,
                updated_at = excluded.updated_at",
        )
        .bind(channel_id)
        .bind(role)
        .bind(can_view)
        .bind(can_send)
        .bind(can_manage)
        .bind(Utc::now())
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn can_access_channel(
    pool: &SqlitePool,
    server_id: &str,
    channel_id: &str,
    user: &str,
    action: &str,
) -> Result<bool, sqlx::Error> {
    let server = match get_server_accessibility(pool, server_id).await? {
        Some(server) => server,
        None => return Ok(false),
    };
    let role = get_server_member_role(pool, server_id, user).await?;
    if server.owner == user {
        return Ok(true);
    }
    if role.is_none() {
        return Ok(server.is_public != 0 && action == "view");
    }

    let role_key = role.as_deref().unwrap_or("member");
    if let Some(channel_role) = load_channel_permission_record(pool, channel_id, role_key).await? {
        return Ok(match action {
            "view" => channel_role.can_view != 0,
            "send" => channel_role.can_send != 0,
            "manage" => channel_role.can_manage != 0,
            _ => false,
        });
    }
    let role_record = load_server_role_record(pool, server_id, role_key).await?;
    let (can_view, can_send, can_manage, can_voice) = role_record
        .map(|role| {
            (
                role.can_view != 0,
                role.can_send != 0,
                role.can_manage != 0,
                role.can_voice != 0,
            )
        })
        .unwrap_or_else(|| {
            let (can_view, can_send, can_manage) = fallback_role_permissions(role_key);
            (
                can_view,
                can_send,
                can_manage,
                role_key == "owner" || role_key == "admin" || role_key == "member",
            )
        });
    Ok(match action {
        "view" => can_view,
        "send" => can_send,
        "manage" => can_manage,
        "voice" => can_view && can_voice,
        _ => false,
    })
}

async fn create_server_invite_record(
    pool: &SqlitePool,
    server_id: &str,
    created_by: &str,
    max_uses: i64,
    expires_hours: Option<i64>,
) -> Result<ServerInviteRecord, sqlx::Error> {
    let code = Uuid::new_v4().simple().to_string()[..8].to_lowercase();
    let expires_at = expires_hours
        .filter(|hours| *hours > 0)
        .map(|hours| Utc::now() + chrono::Duration::hours(hours));
    sqlx::query(
        "INSERT INTO server_invites (code, server_id, created_by, max_uses, uses, expires_at, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(&code)
    .bind(server_id)
    .bind(created_by)
    .bind(max_uses)
    .bind(expires_at)
    .bind(Utc::now())
    .execute(pool)
    .await?;

    Ok(ServerInviteRecord {
        code,
        server_id: server_id.to_string(),
        created_by: created_by.to_string(),
        max_uses,
        uses: 0,
        expires_at,
        created_at: Utc::now(),
    })
}

async fn get_server_member_role(
    pool: &SqlitePool,
    server_id: &str,
    username: &str,
) -> Result<Option<String>, sqlx::Error> {
    if username.trim().is_empty() {
        return Ok(None);
    }

    let server_owner: Option<String> =
        sqlx::query_scalar("SELECT owner FROM servers WHERE id = ? LIMIT 1")
            .bind(server_id)
            .fetch_optional(pool)
            .await?;

    if server_owner.as_deref() == Some(username) {
        return Ok(Some("owner".to_string()));
    }

    sqlx::query_scalar(
        "SELECT role FROM server_members WHERE server_id = ? AND username = ? LIMIT 1",
    )
    .bind(server_id)
    .bind(username)
    .fetch_optional(pool)
    .await
}

async fn get_server_member_count(pool: &SqlitePool, server_id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM server_members WHERE server_id = ?")
        .bind(server_id)
        .fetch_one(pool)
        .await
}

async fn load_server_members(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<Vec<ServerMemberResponse>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ServerMemberRecord>(
        "SELECT server_id, username, role, joined_at
         FROM server_members
         WHERE server_id = ?
         ORDER BY
            CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
            joined_at ASC,
            username ASC",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| ServerMemberResponse {
            username: row.username,
            role: row.role,
            joined_at: row.joined_at,
        })
        .collect())
}

async fn get_server_access_context(
    pool: &SqlitePool,
    server_id: &str,
    username: &str,
) -> Result<Option<(ServerRecord, Option<String>)>, sqlx::Error> {
    if let Some(server) = get_server_accessibility(pool, server_id).await? {
        let role = get_server_member_role(pool, server_id, username).await?;
        if server.is_public != 0 || server.owner == username || role.is_some() {
            return Ok(Some((server, role)));
        }
    }

    Ok(None)
}

async fn ensure_server_member(
    pool: &SqlitePool,
    server_id: &str,
    username: &str,
    role: &str,
) -> Result<(), sqlx::Error> {
    let role = normalize_server_role(Some(role)).unwrap_or_else(|| "member".to_string());
    sqlx::query(
        "INSERT INTO server_members (server_id, username, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id, username) DO NOTHING",
    )
    .bind(server_id)
    .bind(username)
    .bind(role)
    .bind(Utc::now())
    .execute(pool)
    .await?;
    Ok(())
}

async fn upsert_server_member(
    pool: &SqlitePool,
    server_id: &str,
    username: &str,
    role: &str,
) -> Result<(), sqlx::Error> {
    let role = normalize_server_role(Some(role)).unwrap_or_else(|| "member".to_string());
    sqlx::query(
        "INSERT INTO server_members (server_id, username, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id, username) DO UPDATE SET
            role = excluded.role",
    )
    .bind(server_id)
    .bind(username)
    .bind(role)
    .bind(Utc::now())
    .execute(pool)
    .await?;
    Ok(())
}

async fn can_manage_server(
    pool: &SqlitePool,
    server_id: &str,
    username: &str,
) -> Result<bool, sqlx::Error> {
    if let Some(server) = get_server_accessibility(pool, server_id).await? {
        if server.owner == username {
            return Ok(true);
        }
        let role = get_server_member_role(pool, server_id, username).await?;
        if can_manage_by_role(role.as_deref()) {
            return Ok(true);
        }
        if let Some(role_id) = role.as_deref() {
            let (_can_view, _can_send, can_manage) =
                load_server_role_permissions(pool, server_id, role_id).await?;
            return Ok(can_manage);
        }
        return Ok(false);
    }

    Ok(false)
}

async fn me(
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

async fn update_me(
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

async fn logout(
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

async fn hash_password(password: String) -> Result<String, String> {
    task::spawn_blocking(move || bcrypt::hash(password, bcrypt::DEFAULT_COST))
        .await
        .map_err(|e| format!("bcrypt hash task failed: {}", e))?
        .map_err(|e| e.to_string())
}

async fn verify_password(password: String, hash: String) -> Result<bool, String> {
    task::spawn_blocking(move || bcrypt::verify(password, &hash))
        .await
        .map_err(|e| format!("bcrypt verify task failed: {}", e))?
        .map_err(|e| e.to_string())
}

async fn broadcast_json(state: &Arc<AppState>, payload: String) {
    let viewers: Vec<String> = state
        .user_connections
        .iter()
        .map(|entry| entry.key().clone())
        .collect();
    for viewer in viewers {
        send_payload_to_user(state, &viewer, payload.clone(), "broadcast_json").await;
    }
}

async fn send_payload_to_user(
    state: &Arc<AppState>,
    username: &str,
    payload: String,
    label: &str,
) -> usize {
    let senders = if let Some(mut conns) = state.user_connections.get_mut(username) {
        conns.retain(|conn| !conn.is_closed());
        conns.iter().cloned().collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    if senders.is_empty() {
        return 0;
    }

    let mut sent = 0usize;
    let mut failed = false;
    for conn in senders {
        match tokio::time::timeout(Duration::from_secs(2), conn.send(payload.clone())).await {
            Ok(Ok(())) => sent += 1,
            Ok(Err(_)) | Err(_) => {
                failed = true;
                if let Some(mut conns) = state.user_connections.get_mut(username) {
                    conns.retain(|existing| !existing.same_channel(&conn) && !existing.is_closed());
                }
            }
        }
    }

    if failed {
        if let Some(mut conns) = state.user_connections.get_mut(username) {
            conns.retain(|conn| !conn.is_closed());
        }
        warn!(
            "WS send had closed/slow receivers label={} username={} sent={}",
            label, username, sent
        );
    }

    sent
}

async fn broadcast_avatar_event(
    state: &Arc<AppState>,
    username: &str,
    deleted: bool,
    updated_at: Option<DateTime<Utc>>,
) {
    let payload = serde_json::json!({
        "type": if deleted { "avatar_deleted" } else { "avatar_updated" },
        "username": username,
        "deleted": deleted,
        "updated_at": updated_at.map(|dt| dt.to_rfc3339()),
    });
    broadcast_json(state, payload.to_string()).await;
}

async fn send_json_to_user(state: &Arc<AppState>, username: &str, payload: serde_json::Value) {
    let json = payload.to_string();
    let event_type = payload["type"].as_str().unwrap_or_default().to_string();
    if let Some(mut conns) = state.user_connections.get_mut(username) {
        conns.retain(|conn| !conn.is_closed());
        if event_type.starts_with("voice_") {
            info!(
                "[VOICE][SEND] to={} type={} active_ws={} roomId={} roomType={} target={} inviter={}",
                username,
                event_type,
                conns.len(),
                payload["roomId"].as_str().unwrap_or_default(),
                payload["roomType"].as_str().unwrap_or_default(),
                payload["target"].as_str().unwrap_or_default(),
                payload["inviter"].as_str().unwrap_or_default()
            );
        }
        drop(conns);
        send_payload_to_user(state, username, json, "send_json_to_user").await;
    } else if event_type.starts_with("voice_") {
        warn!(
            "[VOICE][SEND] to={} type={} no_connection_entry roomId={} roomType={}",
            username,
            event_type,
            payload["roomId"].as_str().unwrap_or_default(),
            payload["roomType"].as_str().unwrap_or_default()
        );
    }
}

fn voice_room_key(
    room_type: &str,
    server_id: Option<&str>,
    channel_id: Option<&str>,
    room_id: Option<&str>,
) -> String {
    match room_type {
        "channel" => format!(
            "voice:channel:{}:{}",
            server_id.unwrap_or_default(),
            channel_id.unwrap_or_default()
        ),
        "dm" => room_id
            .filter(|v| !v.trim().is_empty())
            .map(|v| format!("voice:dm:{}", v.trim()))
            .unwrap_or_else(|| "voice:dm:pending".to_string()),
        other => room_id
            .filter(|v| !v.trim().is_empty())
            .map(|v| format!("voice:{}:{}", other, v.trim()))
            .unwrap_or_else(|| format!("voice:{}:pending", other)),
    }
}

fn voice_room_payload(room_id: &str, room: &VoiceRoom) -> serde_json::Value {
    let mut participants: Vec<String> = room.participants.iter().cloned().collect();
    participants.sort();
    serde_json::json!({
        "type": "voice_room_state",
        "roomId": room_id,
        "roomType": room.room_type,
        "status": room.call_state,
        "initiator": room.initiator,
        "target": room.target,
        "serverId": room.server_id,
        "channelId": room.channel_id,
        "participants": participants,
    })
}

async fn send_voice_room_snapshot_to_user(state: &Arc<AppState>, username: &str) {
    let mut payloads = Vec::new();

    if let Some(room_id) = state.user_voice_rooms.get(username) {
        if let Some(room) = state.voice_rooms.get(room_id.value()) {
            payloads.push(voice_room_payload(room_id.value(), room.value()));
        }
    }

    if payloads.is_empty() {
        let username = username.to_string();
        for room in state.voice_rooms.iter() {
            let room_id = room.key().clone();
            let room = room.value();
            let is_pending_dm = room.room_type == "dm" && room.call_state == "ringing";
            let participant_match = room.participants.contains(&username);
            let initiator_match = room.initiator.as_deref() == Some(username.as_str());
            let target_match = room.target.as_deref() == Some(username.as_str());
            if is_pending_dm && (participant_match || initiator_match || target_match) {
                payloads.push(voice_room_payload(&room_id, room));
            }
        }
    }

    for payload in payloads {
        send_json_to_user(state, username, payload).await;
    }
}

async fn broadcast_voice_room_state(state: &Arc<AppState>, room_id: &str) {
    let room = match state.voice_rooms.get(room_id) {
        Some(room) => room,
        None => return,
    };
    let payload = {
        let room = room.value();
        voice_room_payload(room_id, room)
    };
    let participants = payload["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect::<Vec<_>>();
    for participant in participants {
        send_json_to_user(state, &participant, payload.clone()).await;
    }
}

async fn leave_voice_room(state: &Arc<AppState>, username: &str) {
    let room_id = match state.user_voice_rooms.remove(username) {
        Some((_, room_id)) => room_id,
        None => return,
    };
    info!("[VOICE] '{}' leaves room {}", username, room_id);

    let mut room_type = String::new();
    let mut remaining_participants: Vec<String> = Vec::new();
    let mut remove_room = false;
    if let Some(mut room) = state.voice_rooms.get_mut(&room_id) {
        room_type = room.room_type.clone();
        room.participants.remove(username);
        remaining_participants = room.participants.iter().cloned().collect();
        remove_room =
            room.participants.is_empty() || (room_type == "dm" && room.participants.len() <= 1);
    }

    if remove_room {
        info!("[VOICE] removing room {} ({})", room_id, room_type);
        state.voice_rooms.remove(&room_id);
        if room_type == "dm" {
            for participant in remaining_participants {
                send_json_to_user(
                    state,
                    &participant,
                    serde_json::json!({
                        "type": "voice_call_ended",
                        "roomId": room_id,
                        "from": username,
                    }),
                )
                .await;
            }
        }
    } else {
        broadcast_voice_room_state(state, &room_id).await;
    }
}

async fn join_voice_room(
    state: &Arc<AppState>,
    username: &str,
    room_id: &str,
    room_type: &str,
    server_id: Option<&str>,
    channel_id: Option<&str>,
) {
    info!(
        "[VOICE] '{}' joining room {} ({})",
        username, room_id, room_type
    );
    let should_leave_current_room = match state.user_voice_rooms.get(username) {
        Some(current_room) => current_room.value().as_str() != room_id,
        None => true,
    };

    if should_leave_current_room {
        leave_voice_room(state, username).await;
    }

    let mut room = state
        .voice_rooms
        .entry(room_id.to_string())
        .or_insert_with(|| {
            VoiceRoom::new(
                room_type.to_string(),
                server_id.map(|v| v.to_string()),
                channel_id.map(|v| v.to_string()),
            )
        });

    {
        let room = room.value_mut();
        room.room_type = room_type.to_string();
        room.server_id = server_id.map(|v| v.to_string());
        room.channel_id = channel_id.map(|v| v.to_string());
        room.participants.insert(username.to_string());
    }
    drop(room); // release DashMap shard lock before re-entering voice_rooms via broadcast

    state
        .user_voice_rooms
        .insert(username.to_string(), room_id.to_string());

    broadcast_voice_room_state(state, room_id).await;
}

async fn route_voice_signal(state: &Arc<AppState>, sender: &str, payload: &serde_json::Value) {
    let room_id = payload["roomId"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if room_id.is_empty() {
        return;
    }

    let room_snapshot = state.voice_rooms.get(&room_id).map(|room| {
        let participants = room.participants.iter().cloned().collect::<Vec<_>>();
        (
            room.room_type.clone(),
            room.call_state.clone(),
            room.initiator.clone(),
            room.target.clone(),
            participants,
        )
    });
    let Some((room_type, call_state, initiator, room_target, participants)) = room_snapshot else {
        warn!(
            "[VOICE][ROUTE] reject missing room sender={} roomId={}",
            sender, room_id
        );
        return;
    };
    let sender_allowed = participants.iter().any(|participant| participant == sender)
        || initiator.as_deref() == Some(sender)
        || room_target.as_deref() == Some(sender);
    if !sender_allowed {
        warn!(
            "[VOICE][ROUTE] reject unauthorized sender={} roomId={} roomType={} state={}",
            sender, room_id, room_type, call_state
        );
        return;
    }

    info!(
        "[VOICE][ROUTE] from={} roomId={} roomType={} to={} signalType={}",
        sender,
        room_id,
        payload["roomType"].as_str().unwrap_or_default(),
        payload["to"].as_str().unwrap_or_default(),
        payload["signal"]["type"].as_str().unwrap_or_default()
    );

    let mut signal = payload.clone();
    signal["from"] = serde_json::Value::String(sender.to_string());

    if let Some(target) = payload["to"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        let target_allowed = participants
            .iter()
            .any(|participant| participant == &target)
            || initiator.as_deref() == Some(target.as_str())
            || room_target.as_deref() == Some(target.as_str());
        if !target_allowed {
            warn!(
                "[VOICE][ROUTE] reject target={} sender={} roomId={} not in room",
                target, sender, room_id
            );
            return;
        }
        let active_ws = state
            .user_connections
            .get(&target)
            .map(|conns| conns.len())
            .unwrap_or(0);
        info!(
            "[VOICE][ROUTE] direct from={} to={} roomId={} signalType={} active_ws={}",
            sender,
            target,
            room_id,
            payload["signal"]["type"].as_str().unwrap_or_default(),
            active_ws
        );
        send_json_to_user(state, &target, signal).await;
        return;
    }

    for participant in participants {
        if participant == sender {
            continue;
        }
        let active_ws = state
            .user_connections
            .get(&participant)
            .map(|conns| conns.len())
            .unwrap_or(0);
        info!(
            "[VOICE][ROUTE] room-broadcast from={} to={} roomId={} signalType={} active_ws={}",
            sender,
            participant,
            room_id,
            payload["signal"]["type"].as_str().unwrap_or_default(),
            active_ws
        );
        send_json_to_user(state, &participant, signal.clone()).await;
    }
}

async fn handle_voice_event(state: &Arc<AppState>, sender: &str, payload: &serde_json::Value) {
    let event_type = payload["type"].as_str().unwrap_or_default();
    info!(
        "[VOICE][EVENT] user={} type={} roomId={} roomType={} target={} inviter={} from={}",
        sender,
        event_type,
        payload["roomId"].as_str().unwrap_or_default(),
        payload["roomType"].as_str().unwrap_or_default(),
        payload["target"].as_str().unwrap_or_default(),
        payload["inviter"].as_str().unwrap_or_default(),
        payload["from"].as_str().unwrap_or_default()
    );
    match event_type {
        "voice_join" => {
            let room_type = payload["roomType"].as_str().unwrap_or("channel");
            let room_id = payload["roomId"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let server_id = payload["serverId"].as_str().map(|s| s.trim().to_string());
            let channel_id = payload["channelId"].as_str().map(|s| s.trim().to_string());
            if room_id.is_empty() {
                return;
            }
            info!(
                "[VOICE][JOIN] user={} roomId={} roomType={} serverId={} channelId={}",
                sender,
                room_id,
                room_type,
                server_id.as_deref().unwrap_or_default(),
                channel_id.as_deref().unwrap_or_default()
            );

            if room_type == "channel" {
                match (server_id.as_deref(), channel_id.as_deref()) {
                    (Some(sid), Some(cid)) => {
                        if !can_access_channel(&state.db, sid, cid, sender, "voice")
                            .await
                            .unwrap_or(false)
                        {
                            send_json_to_user(
                                state,
                                sender,
                                serde_json::json!({
                                    "type": "voice_error",
                                    "roomId": room_id,
                                    "message": "Нет доступа к голосовому каналу"
                                }),
                            )
                            .await;
                            return;
                        }
                    }
                    _ => {
                        warn!(
                            "[VOICE][JOIN] reject channel join without server/channel sender={} roomId={}",
                            sender, room_id
                        );
                        send_json_to_user(
                            state,
                            sender,
                            serde_json::json!({
                                "type": "voice_error",
                                "roomId": room_id,
                                "message": "Необходимо указать server_id и channel_id"
                            }),
                        )
                        .await;
                        return;
                    }
                }
            } else if room_type == "dm" {
                let room = match state.voice_rooms.get(&room_id) {
                    Some(room) => room,
                    None => {
                        send_json_to_user(
                            state,
                            sender,
                            serde_json::json!({
                                "type": "voice_error",
                                "roomId": room_id,
                                "message": "Голосовая комната не найдена"
                            }),
                        )
                        .await;
                        return;
                    }
                };
                let allowed = room.participants.contains(sender)
                    || room.initiator.as_deref() == Some(sender)
                    || room.target.as_deref() == Some(sender);
                if !allowed {
                    send_json_to_user(
                        state,
                        sender,
                        serde_json::json!({
                            "type": "voice_error",
                            "roomId": room_id,
                            "message": "Нет доступа к голосовой переписке"
                        }),
                    )
                    .await;
                    return;
                }
            }

            join_voice_room(
                state,
                sender,
                &room_id,
                room_type,
                server_id.as_deref(),
                channel_id.as_deref(),
            )
            .await;
        }
        "voice_leave" => {
            info!("[VOICE][LEAVE] user={} explicit_leave", sender);
            leave_voice_room(state, sender).await;
        }
        "voice_signal" => {
            route_voice_signal(state, sender, payload).await;
        }
        "voice_call_invite" => {
            let target = payload["target"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let room_id = payload["roomId"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let room_key = if room_id.is_empty() {
                let mut pair = [sender.to_string(), target.clone()];
                pair.sort();
                voice_room_key("dm", None, None, Some(&pair.join(":")))
            } else {
                room_id
            };
            if target.is_empty() {
                return;
            }
            match contact_exists(&state.db, sender, &target).await {
                Ok(true) => {}
                Ok(false) => {
                    send_json_to_user(
                        state,
                        sender,
                        serde_json::json!({
                            "type": "voice_error",
                            "roomId": room_key,
                            "message": "Получатель должен быть в контактах"
                        }),
                    )
                    .await;
                    return;
                }
                Err(e) => {
                    error!(
                        "Ошибка проверки контакта для voice_call_invite sender={} target={}: {}",
                        sender, target, e
                    );
                    send_json_to_user(
                        state,
                        sender,
                        serde_json::json!({
                            "type": "voice_error",
                            "roomId": room_key,
                            "message": "Не удалось проверить контакты"
                        }),
                    )
                    .await;
                    return;
                }
            }
            info!(
                "[VOICE][INVITE] from={} to={} roomId={}",
                sender, target, room_key
            );
            {
                let mut room = state
                    .voice_rooms
                    .entry(room_key.clone())
                    .or_insert_with(|| VoiceRoom::new("dm".to_string(), None, None));
                let room = room.value_mut();
                room.room_type = "dm".to_string();
                room.server_id = None;
                room.channel_id = None;
                room.call_state = "ringing".to_string();
                room.initiator = Some(sender.to_string());
                room.target = Some(target.clone());
                room.participants.clear();
                room.participants.insert(sender.to_string());
                room.participants.insert(target.clone());
            }
            join_voice_room(state, sender, &room_key, "dm", None, None).await;
            broadcast_voice_room_state(state, &room_key).await;
            send_json_to_user(
                state,
                &target,
                serde_json::json!({
                    "type": "voice_call_invite",
                    "roomId": room_key,
                    "roomType": "dm",
                    "from": sender,
                    "target": target,
                }),
            )
            .await;
            send_json_to_user(
                state,
                sender,
                serde_json::json!({
                    "type": "voice_call_outgoing",
                    "roomId": room_key,
                    "roomType": "dm",
                    "target": target,
                }),
            )
            .await;

            let timeout_state = Arc::clone(state);
            let timeout_room_id = room_key.clone();
            let timeout_inviter = sender.to_string();
            let timeout_target = target.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some((call_state, participants)) =
                    timeout_state.voice_rooms.get(&timeout_room_id).map(|room| {
                        (
                            room.call_state.clone(),
                            room.participants.iter().cloned().collect::<Vec<_>>(),
                        )
                    })
                else {
                    return;
                };
                if call_state != "ringing" {
                    return;
                }
                timeout_state.voice_rooms.remove(&timeout_room_id);
                for participant in participants {
                    send_json_to_user(
                        &timeout_state,
                        &participant,
                        serde_json::json!({
                            "type": "voice_call_missed",
                            "roomId": timeout_room_id.clone(),
                            "from": timeout_inviter.clone(),
                            "target": timeout_target.clone(),
                        }),
                    )
                    .await;
                }
            });
        }
        "voice_call_accept" => {
            let inviter = payload["inviter"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let room_id = payload["roomId"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            if room_id.is_empty() || inviter.is_empty() {
                return;
            }
            let room_snapshot = state.voice_rooms.get(&room_id).map(|room| {
                (
                    room.room_type.clone(),
                    room.call_state.clone(),
                    room.initiator.clone(),
                    room.target.clone(),
                )
            });
            let Some((room_type, call_state, initiator, target)) = room_snapshot else {
                warn!(
                    "[VOICE][ACCEPT] reject missing room sender={} roomId={}",
                    sender, room_id
                );
                return;
            };
            if room_type != "dm"
                || call_state != "ringing"
                || initiator.as_deref() != Some(inviter.as_str())
                || target.as_deref() != Some(sender)
            {
                warn!(
                    "[VOICE][ACCEPT] reject unauthorized sender={} roomId={} inviter={} state={} initiator={:?} target={:?}",
                    sender, room_id, inviter, call_state, initiator, target
                );
                return;
            }
            info!(
                "[VOICE] '{}' accepted call room={} inviter={}",
                sender, room_id, inviter
            );

            join_voice_room(state, sender, &room_id, "dm", None, None).await;

            if let Some(mut room) = state.voice_rooms.get_mut(&room_id) {
                let room = room.value_mut();
                room.room_type = "dm".to_string();
                room.server_id = None;
                room.channel_id = None;
                room.call_state = "active".to_string();
                room.initiator = Some(inviter.clone());
                room.target = Some(sender.to_string());
                room.participants.clear();
                room.participants.insert(sender.to_string());
                room.participants.insert(inviter.clone());
            }

            state
                .user_voice_rooms
                .insert(sender.to_string(), room_id.clone());
            state
                .user_voice_rooms
                .insert(inviter.to_string(), room_id.clone());

            info!(
                "[VOICE][ACCEPT] room={} sender={} inviter={} participants=[{},{}]",
                room_id, sender, inviter, sender, inviter
            );
            broadcast_voice_room_state(state, &room_id).await;
            let accepted_payload = serde_json::json!({
                "type": "voice_call_accepted",
                "roomId": room_id,
                "from": sender,
                "target": inviter,
                "participants": [sender, inviter],
            });
            send_json_to_user(state, &inviter, accepted_payload.clone()).await;
            send_json_to_user(state, sender, accepted_payload).await;
            let connected_payload = serde_json::json!({
                "type": "voice_call_connected",
                "roomId": room_id,
                "from": sender,
                "target": inviter,
                "participants": [sender, inviter],
            });
            send_json_to_user(state, &inviter, connected_payload.clone()).await;
            send_json_to_user(state, sender, connected_payload).await;
            info!(
                "[VOICE][ACCEPT-DONE] room={} sender={} inviter={}",
                room_id, sender, inviter
            );
        }
        "voice_call_reject" => {
            let inviter = payload["inviter"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let room_id = payload["roomId"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            if room_id.is_empty() || inviter.is_empty() {
                return;
            }
            let allowed = state
                .voice_rooms
                .get(&room_id)
                .map(|room| {
                    room.room_type == "dm"
                        && room.call_state == "ringing"
                        && room.initiator.as_deref() == Some(inviter.as_str())
                        && room.target.as_deref() == Some(sender)
                })
                .unwrap_or(false);
            if !allowed {
                warn!(
                    "[VOICE][REJECT] reject unauthorized sender={} roomId={} inviter={}",
                    sender, room_id, inviter
                );
                return;
            }
            info!(
                "[VOICE][REJECT] from={} to={} roomId={}",
                sender, inviter, room_id
            );
            state.voice_rooms.remove(&room_id);
            state.user_voice_rooms.remove(sender);
            state.user_voice_rooms.remove(inviter.as_str());
            send_json_to_user(
                state,
                &inviter,
                serde_json::json!({
                    "type": "voice_call_rejected",
                    "roomId": room_id,
                    "from": sender,
                    "target": inviter,
                }),
            )
            .await;
        }
        "voice_call_cancel" => {
            let target = payload["target"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let room_id = payload["roomId"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            if room_id.is_empty() || target.is_empty() {
                return;
            }
            let allowed = state
                .voice_rooms
                .get(&room_id)
                .map(|room| {
                    room.room_type == "dm"
                        && room.call_state == "ringing"
                        && room.initiator.as_deref() == Some(sender)
                        && room.target.as_deref() == Some(target.as_str())
                })
                .unwrap_or(false);
            if !allowed {
                warn!(
                    "[VOICE][CANCEL] reject unauthorized sender={} roomId={} target={}",
                    sender, room_id, target
                );
                return;
            }
            info!(
                "[VOICE][CANCEL] from={} to={} roomId={}",
                sender, target, room_id
            );
            state.voice_rooms.remove(&room_id);
            state.user_voice_rooms.remove(sender);
            state.user_voice_rooms.remove(target.as_str());
            send_json_to_user(
                state,
                &target,
                serde_json::json!({
                    "type": "voice_call_cancelled",
                    "roomId": room_id,
                    "from": sender,
                    "target": target,
                }),
            )
            .await;
        }
        "voice_call_end" => {
            info!("[VOICE][END] from={} explicit_end", sender);
            leave_voice_room(state, sender).await;
        }
        _ => {}
    }
}

async fn load_reaction_states(
    state: &Arc<AppState>,
    message_ids: &[String],
    viewer: &str,
) -> Result<HashMap<String, (Vec<ReactionSummary>, Option<String>)>, sqlx::Error> {
    let mut states: HashMap<String, (HashMap<String, i64>, Option<String>)> = HashMap::new();
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT message_id, emoji, reactor FROM reactions WHERE message_id IN (",
    );
    let mut separated = builder.separated(", ");
    for message_id in message_ids {
        separated.push_bind(message_id);
    }
    builder.push(")");

    let rows = builder.build().fetch_all(&state.db).await?;
    for row in rows {
        let message_id: String = row.get("message_id");
        let emoji: String = row.get("emoji");
        let reactor: String = row.get("reactor");
        let entry = states
            .entry(message_id)
            .or_insert_with(|| (HashMap::new(), None));
        *entry.0.entry(emoji.clone()).or_insert(0) += 1;
        if reactor == viewer {
            entry.1 = Some(emoji);
        }
    }

    Ok(states
        .into_iter()
        .map(|(message_id, (counts, my_reaction))| {
            let mut reactions: Vec<ReactionSummary> = counts
                .into_iter()
                .map(|(emoji, count)| ReactionSummary { emoji, count })
                .collect();
            reactions.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.emoji.cmp(&b.emoji)));
            (message_id, (reactions, my_reaction))
        })
        .collect())
}

async fn load_reaction_state(
    state: &Arc<AppState>,
    message_id: &str,
    viewer: &str,
) -> Result<(Vec<ReactionSummary>, Option<String>), sqlx::Error> {
    let map = load_reaction_states(state, &[message_id.to_string()], viewer).await?;
    Ok(map.get(message_id).cloned().unwrap_or_default())
}

async fn load_reaction_state_for_viewers(
    state: &Arc<AppState>,
    message_id: &str,
    viewers: &[String],
) -> Result<(Vec<ReactionSummary>, HashMap<String, String>), sqlx::Error> {
    let viewer_set: HashSet<&str> = viewers.iter().map(|viewer| viewer.as_str()).collect();
    let rows = sqlx::query("SELECT emoji, reactor FROM reactions WHERE message_id = ?")
        .bind(message_id)
        .fetch_all(&state.db)
        .await?;
    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut my_reactions: HashMap<String, String> = HashMap::new();
    for row in rows {
        let emoji: String = row.get("emoji");
        let reactor: String = row.get("reactor");
        *counts.entry(emoji.clone()).or_insert(0) += 1;
        if viewer_set.contains(reactor.as_str()) {
            my_reactions.insert(reactor, emoji);
        }
    }

    let mut reactions: Vec<ReactionSummary> = counts
        .into_iter()
        .map(|(emoji, count)| ReactionSummary { emoji, count })
        .collect();
    reactions.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.emoji.cmp(&b.emoji)));
    Ok((reactions, my_reactions))
}

async fn broadcast_reaction_event(state: &Arc<AppState>, message: &Message) {
    let viewers: Vec<String> = if let (Some(server_id), Some(channel_id)) =
        (message.server_id.as_deref(), message.channel_id.as_deref())
    {
        let candidates: Vec<String> = state
            .user_connections
            .iter()
            .map(|entry| entry.key().clone())
            .collect();
        match get_server_accessibility(&state.db, server_id).await {
            Ok(Some(server)) => {
                match resolve_server_message_viewers(state, &server, channel_id, &candidates).await
                {
                    Ok(allowed) => allowed,
                    Err(e) => {
                        error!(
                            "Ошибка предварительного расчёта зрителей реакции {} в {}/{}: {}",
                            message.id, server_id, channel_id, e
                        );
                        return;
                    }
                }
            }
            Ok(None) => return,
            Err(e) => {
                error!(
                    "Ошибка проверки сервера {} перед доставкой реакции {}: {}",
                    server_id, message.id, e
                );
                return;
            }
        }
    } else if message.sender == message.receiver {
        vec![message.sender.clone()]
    } else {
        vec![message.sender.clone(), message.receiver.clone()]
    };

    let (reactions, my_reactions) =
        match load_reaction_state_for_viewers(state, &message.id, &viewers).await {
            Ok(state) => state,
            Err(e) => {
                error!("Ошибка загрузки реакций для {}: {}", message.id, e);
                return;
            }
        };

    for viewer in viewers {
        let payload = serde_json::json!({
            "type": "reaction_updated",
            "messageId": message.id,
            "sender": message.sender,
            "receiver": message.receiver,
            "serverId": message.server_id,
            "channelId": message.channel_id,
            "reactions": reactions,
            "myReaction": my_reactions.get(&viewer).cloned()
        });
        send_payload_to_user(state, &viewer, payload.to_string(), "reaction_updated").await;
    }
}

fn issue_auth_response(
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

async fn issue_ws_ticket(
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

async fn create_ws_ticket(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> impl IntoResponse {
    match issue_ws_ticket(&state, &username).await {
        Ok(response) => Json(response).into_response(),
        Err(status) => status.into_response(),
    }
}

fn take_valid_ws_ticket(state: &Arc<AppState>, ticket: &str) -> Option<String> {
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

async fn load_cloud_vault_sync_enabled(
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

fn jwt_validation() -> Validation {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[JWT_ISSUER]);
    validation.set_audience(&[JWT_AUDIENCE]);
    validation.validate_exp = true;
    validation.sub = None;
    validation
}

fn auth_cookie_value(token: &str, secure: bool) -> Result<HeaderValue, ()> {
    let secure_flag = if secure { "; Secure" } else { "" };
    let cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800{}",
        AUTH_COOKIE_NAME, token, secure_flag
    );
    HeaderValue::from_str(&cookie).map_err(|_| ())
}

fn auth_response_with_cookie_and_secure(
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

async fn register(
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

    if payload.password.len() < 8 {
        warn!(
            "Регистрация отклонена: username '{}' использует слишком короткий пароль ({} символов)",
            username,
            payload.password.len()
        );
        return (
            StatusCode::BAD_REQUEST,
            "Пароль должен быть не менее 8 символов",
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

async fn login(
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
    state.login_attempts.retain(|_, attempts| {
        attempts.retain(|t| now.duration_since(*t) < window);
        !attempts.is_empty()
    });

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

fn extract_client_ip(remote_addr: SocketAddr, headers: &HeaderMap) -> std::net::IpAddr {
    let trusted = std::env::var("TRUSTED_PROXY_MODE")
        .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
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

fn login_rate_key(ip: std::net::IpAddr, username: &str) -> String {
    let username = username.trim().to_lowercase();
    format!("{}|{}", username, ip)
}

async fn get_users(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    _auth: AuthenticatedUser,
    Query(query): Query<UserSearchQuery>,
) -> impl IntoResponse {
    let query = query.q.unwrap_or_default().trim().to_lowercase();
    if query.len() < 3 {
        info!("API get_users short_query len={}", query.len());
        return Json(Vec::<String>::new()).into_response();
    }

    info!("API get_users start query={}", query);
    let like = format!("%{}%", query);
    match sqlx::query_scalar::<_, String>(
        "SELECT username FROM users WHERE lower(username) LIKE ? ORDER BY username LIMIT 50",
    )
    .bind(like)
    .fetch_all(&state.db)
    .await
    {
        Ok(users) => {
            info!("API get_users query={} count={}", query, users.len());
            Json(users).into_response()
        }
        Err(e) => {
            error!("Ошибка получения списка пользователей: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_contacts(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    info!("API get_contacts start owner={}", owner);
    let explicit_contacts = match sqlx::query_scalar::<_, String>(
        "SELECT contact FROM contacts WHERE owner = ? ORDER BY contact ASC",
    )
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(contacts) => contacts,
        Err(e) => {
            error!("Ошибка получения контактов для {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let message_contacts = match sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT CASE
            WHEN sender = ? THEN receiver
            ELSE sender
         END AS contact
         FROM messages
         WHERE server_id IS NULL
           AND (sender = ? OR receiver = ?)
           AND CASE WHEN sender = ? THEN receiver ELSE sender END <> ?",
    )
    .bind(&owner)
    .bind(&owner)
    .bind(&owner)
    .bind(&owner)
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(contacts) => contacts,
        Err(e) => {
            error!("Ошибка получения контактов из истории для {}: {}", owner, e);
            Vec::new()
        }
    };

    let mut contacts = explicit_contacts;
    for contact in message_contacts {
        if !contacts.iter().any(|existing| existing == &contact) {
            contacts.push(contact);
        }
    }
    contacts.sort();

    info!(
        "API get_contacts owner={} count={} contacts={}",
        owner,
        contacts.len(),
        contacts.join(",")
    );
    Json(ContactListResponse { contacts }).into_response()
}

async fn add_contact(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<ContactPayload>,
) -> impl IntoResponse {
    let contact = payload.username.trim();
    info!("API add_contact start owner={} contact={}", owner, contact);
    if contact.is_empty() {
        return (StatusCode::BAD_REQUEST, "Имя контакта не может быть пустым").into_response();
    }

    if contact == owner {
        return (StatusCode::BAD_REQUEST, "Нельзя добавить самого себя").into_response();
    }

    let exists =
        sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE username = ? LIMIT 1")
            .bind(contact)
            .fetch_optional(&state.db)
            .await;

    match exists {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "Пользователь не найден").into_response();
        }
        Err(e) => {
            error!("Ошибка проверки пользователя {}: {}", contact, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    if let Err(e) = sqlx::query("INSERT OR IGNORE INTO contacts (owner, contact) VALUES (?, ?)")
        .bind(&owner)
        .bind(contact)
        .execute(&state.db)
        .await
    {
        error!("Ошибка добавления контакта {} -> {}: {}", owner, contact, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    info!("API add_contact saved owner={} contact={}", owner, contact);

    get_contacts(axum::extract::State(state), AuthenticatedUser(owner))
        .await
        .into_response()
}

async fn delete_contact(
    AxumPath(username): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    info!(
        "API delete_contact start owner={} contact={}",
        owner, username
    );
    if let Err(e) = sqlx::query("DELETE FROM contacts WHERE owner = ? AND contact = ?")
        .bind(&owner)
        .bind(&username)
        .execute(&state.db)
        .await
    {
        error!("Ошибка удаления контакта {} -> {}: {}", owner, username, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    info!(
        "API delete_contact removed owner={} contact={}",
        owner, username
    );

    get_contacts(axum::extract::State(state), AuthenticatedUser(owner))
        .await
        .into_response()
}

async fn contact_exists(
    pool: &SqlitePool,
    owner: &str,
    contact: &str,
) -> Result<bool, sqlx::Error> {
    let exists = sqlx::query_scalar::<_, String>(
        "SELECT contact FROM contacts WHERE owner = ? AND contact = ? LIMIT 1",
    )
    .bind(owner)
    .bind(contact)
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}

fn trim_limited(value: impl AsRef<str>, max_len: usize) -> String {
    value
        .as_ref()
        .trim()
        .chars()
        .take(max_len)
        .collect::<String>()
}

fn is_valid_username(value: &str) -> bool {
    let len = value.chars().count();
    (3..=32).contains(&len)
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn device_record_to_response(record: DeviceRecord) -> DeviceResponse {
    let key_package = serde_json::from_str(&record.key_package).unwrap_or_else(|_| {
        serde_json::json!({
            "raw": record.key_package
        })
    });
    DeviceResponse {
        deviceId: record.device_id,
        owner: record.owner,
        label: record.label,
        publicKey: record.public_key,
        keyPackage: key_package,
        groupEpoch: record.group_epoch,
        approved: record.approved != 0,
        revoked: record.revoked != 0,
        approvedBy: record.approved_by,
        historyDays: record.history_days,
        createdAt: record.created_at,
        approvedAt: record.approved_at,
        revokedAt: record.revoked_at,
    }
}

async fn next_device_epoch(pool: &SqlitePool, owner: &str) -> Result<i64, sqlx::Error> {
    let current = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(group_epoch) FROM account_devices WHERE owner = ?",
    )
    .bind(owner)
    .fetch_one(pool)
    .await?
    .unwrap_or(0);
    Ok(current + 1)
}

async fn load_device(
    pool: &SqlitePool,
    owner: &str,
    device_id: &str,
) -> Result<Option<DeviceRecord>, sqlx::Error> {
    sqlx::query_as::<_, DeviceRecord>(
        "SELECT device_id, owner, label, public_key, signing_key, key_package, group_epoch,
                approved, revoked, approved_by, history_days, created_at, approved_at, revoked_at
         FROM account_devices
         WHERE owner = ? AND device_id = ?
         LIMIT 1",
    )
    .bind(owner)
    .bind(device_id)
    .fetch_optional(pool)
    .await
}

async fn require_approved_device(
    pool: &SqlitePool,
    owner: &str,
    device_id: &str,
) -> Result<DeviceRecord, Response> {
    match load_device(pool, owner, device_id).await {
        Ok(Some(device)) if device.approved != 0 && device.revoked == 0 => Ok(device),
        Ok(Some(_)) => Err((StatusCode::FORBIDDEN, "Устройство не подтверждено").into_response()),
        Ok(None) => Err((StatusCode::NOT_FOUND, "Устройство не найдено").into_response()),
        Err(e) => {
            error!("Ошибка чтения устройства {}: {}", device_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
    }
}

async fn append_transparency_log(
    pool: &SqlitePool,
    owner: &str,
    event_type: &str,
    group_epoch: i64,
    actor_device_id: &str,
    target_device_id: Option<&str>,
    event_json: serde_json::Value,
    signature: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO transparency_log
         (owner, event_type, group_epoch, actor_device_id, target_device_id, event_json, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(owner)
    .bind(event_type)
    .bind(group_epoch)
    .bind(actor_device_id)
    .bind(target_device_id)
    .bind(event_json.to_string())
    .bind(signature.unwrap_or(""))
    .execute(pool)
    .await?;
    Ok(())
}

async fn get_devices(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query_as::<_, DeviceRecord>(
        "SELECT device_id, owner, label, public_key, signing_key, key_package, group_epoch,
                approved, revoked, approved_by, history_days, created_at, approved_at, revoked_at
         FROM account_devices
         WHERE owner = ?
         ORDER BY revoked ASC, approved DESC, created_at ASC",
    )
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(devices) => Json(
            devices
                .into_iter()
                .map(device_record_to_response)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка получения устройств {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_user_public_devices(
    AxumPath(username): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(_requester): AuthenticatedUser,
) -> impl IntoResponse {
    let username = trim_limited(username, 64);
    if username.is_empty() {
        return (StatusCode::BAD_REQUEST, "Нужен username").into_response();
    }
    match sqlx::query_as::<_, DeviceRecord>(
        "SELECT device_id, owner, label, public_key, signing_key, key_package, group_epoch,
                approved, revoked, approved_by, history_days, created_at, approved_at, revoked_at
         FROM account_devices
         WHERE owner = ? AND revoked = 0
         ORDER BY created_at ASC",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    {
        Ok(devices) => Json(
            devices
                .into_iter()
                .map(device_record_to_response)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка получения публичных устройств {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn register_device(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<RegisterDevicePayload>,
) -> impl IntoResponse {
    let device_id = trim_limited(payload.deviceId, 128);
    if device_id.len() < 8 || device_id.chars().any(char::is_whitespace) {
        return (StatusCode::BAD_REQUEST, "Некорректный deviceId").into_response();
    }

    let label = trim_limited(
        payload.label.unwrap_or_else(|| "Zali device".to_string()),
        96,
    );
    let public_key = trim_limited(payload.publicKey.unwrap_or_default(), 4096);
    let signing_key = trim_limited(payload.signingKey.unwrap_or_default(), 4096);
    let key_package =
        serde_json::to_string(&payload.keyPackage.unwrap_or_else(|| serde_json::json!({})))
            .unwrap_or_else(|_| "{}".to_string());

    let mut conn = match state.db.acquire().await {
        Ok(conn) => conn,
        Err(e) => {
            error!(
                "Ошибка получения соединения для регистрации устройства {}: {}",
                device_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if let Err(e) = sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await {
        error!(
            "Ошибка начала блокирующей транзакции для устройства {}: {}",
            device_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let result: Result<(bool, i64), sqlx::Error> = async {
        let approved_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM account_devices WHERE owner = ? AND approved = 1 AND revoked = 0",
        )
        .bind(&owner)
        .fetch_one(&mut *conn)
        .await?;

        let first_device = approved_count == 0;
        let group_epoch = if first_device {
            1
        } else {
            sqlx::query_scalar::<_, Option<i64>>(
                "SELECT MAX(group_epoch) FROM account_devices WHERE owner = ?",
            )
            .bind(&owner)
            .fetch_one(&mut *conn)
            .await?
            .unwrap_or(1)
        };
        let approved = if first_device { 1 } else { 0 };
        let approved_by = if first_device {
            Some(device_id.clone())
        } else {
            None
        };

        sqlx::query(
            "INSERT INTO account_devices
             (owner, device_id, label, public_key, signing_key, key_package, group_epoch, approved, revoked, approved_by, approved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)
             ON CONFLICT(owner, device_id) DO UPDATE SET
                label = excluded.label,
                public_key = excluded.public_key,
                signing_key = excluded.signing_key,
                key_package = excluded.key_package,
                approved = CASE
                    WHEN account_devices.approved = 1 THEN 1
                    ELSE excluded.approved
                END,
                revoked = 0,
                approved_by = COALESCE(account_devices.approved_by, excluded.approved_by),
                approved_at = COALESCE(approved_at, excluded.approved_at),
                revoked_at = NULL,
                history_days = CASE
                    WHEN account_devices.approved = 1 THEN COALESCE(account_devices.history_days, 30)
                    ELSE COALESCE(account_devices.history_days, 30)
                END,
                group_epoch = CASE
                    WHEN account_devices.approved = 1 THEN account_devices.group_epoch
                    ELSE excluded.group_epoch
                END",
        )
        .bind(&owner)
        .bind(&device_id)
        .bind(&label)
        .bind(&public_key)
        .bind(&signing_key)
        .bind(&key_package)
        .bind(group_epoch)
        .bind(approved)
        .bind(approved_by.as_deref())
        .bind(approved)
        .execute(&mut *conn)
        .await?;

        if first_device {
            sqlx::query(
                "UPDATE account_devices
                 SET approved = 1,
                     revoked = 0,
                     approved_by = device_id,
                     approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
                     history_days = COALESCE(history_days, 3650),
                     group_epoch = 1,
                     revoked_at = NULL
                 WHERE owner = ? AND device_id = ?",
            )
            .bind(&owner)
            .bind(&device_id)
            .execute(&mut *conn)
            .await?;
        }

        sqlx::query("COMMIT").execute(&mut *conn).await?;
        Ok((first_device, group_epoch))
    }
    .await;

    let (first_device, group_epoch) = match result {
        Ok(value) => value,
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            error!("Ошибка регистрации устройства {}: {}", device_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if first_device {
        let _ = append_transparency_log(
            &state.db,
            &owner,
            "device_add",
            group_epoch,
            &device_id,
            Some(&device_id),
            serde_json::json!({
                "type": "device_add",
                "account_id": owner,
                "new_device_id": device_id,
                "approved_by": device_id,
                "device_group_epoch": group_epoch,
                "first_device": true
            }),
            None,
        )
        .await;
    }

    match load_device(&state.db, &owner, &device_id).await {
        Ok(Some(device)) => Json(device_record_to_response(device)).into_response(),
        Ok(None) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(e) => {
            error!("Ошибка чтения зарегистрированного устройства: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn approve_device(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    headers: HeaderMap,
    Json(payload): Json<ApproveDevicePayload>,
) -> impl IntoResponse {
    let target_id = trim_limited(payload.deviceId, 128);
    let actor_id = trim_limited(payload.approvedByDeviceId, 128);
    let header_actor_id = match header_device_id(&headers) {
        Some(value) => value,
        None => {
            return (
                StatusCode::FORBIDDEN,
                "Нужен X-Zali-Device-ID доверенного устройства",
            )
                .into_response()
        }
    };
    if target_id.is_empty() || actor_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Нужны deviceId и approvedByDeviceId",
        )
            .into_response();
    }
    if target_id == actor_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Нельзя подтвердить собственное устройство"})),
        )
            .into_response();
    }
    if actor_id != header_actor_id {
        return (
            StatusCode::FORBIDDEN,
            "approvedByDeviceId должен совпадать с X-Zali-Device-ID",
        )
            .into_response();
    }

    if require_approved_device(&state.db, &owner, &header_actor_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            "Подтверждать может только доверенное устройство",
        )
            .into_response();
    }

    let target = match load_device(&state.db, &owner, &target_id).await {
        Ok(Some(device)) if device.revoked == 0 => device,
        Ok(Some(_)) => return (StatusCode::FORBIDDEN, "Устройство отозвано").into_response(),
        Ok(None) => return (StatusCode::NOT_FOUND, "Устройство не найдено").into_response(),
        Err(e) => {
            error!("Ошибка чтения устройства {}: {}", target_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let history_days = payload.historyDays.unwrap_or(30).clamp(0, 30);
    let group_epoch = match next_device_epoch(&state.db, &owner).await {
        Ok(epoch) => epoch,
        Err(e) => {
            error!("Ошибка расчета эпохи устройств {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let key_package = payload
        .keyPackage
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| target.key_package.clone()))
        .unwrap_or(target.key_package);

    if let Err(e) = sqlx::query(
        "UPDATE account_devices
         SET approved = 1,
             revoked = 0,
             approved_by = ?,
             history_days = ?,
             group_epoch = ?,
             key_package = ?,
             approved_at = CURRENT_TIMESTAMP,
             revoked_at = NULL
         WHERE owner = ? AND device_id = ?",
    )
    .bind(&actor_id)
    .bind(history_days)
    .bind(group_epoch)
    .bind(&key_package)
    .bind(&owner)
    .bind(&target_id)
    .execute(&state.db)
    .await
    {
        error!("Ошибка подтверждения устройства {}: {}", target_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let _ = append_transparency_log(
        &state.db,
        &owner,
        "device_add",
        group_epoch,
        &header_actor_id,
        Some(&target_id),
        serde_json::json!({
            "type": "device_add",
            "account_id": owner,
            "new_device_id": target_id,
            "approved_by": header_actor_id,
            "device_group_epoch": group_epoch,
            "history_days": history_days
        }),
        payload.signature.as_deref(),
    )
    .await;

    match load_device(&state.db, &owner, &target_id).await {
        Ok(Some(device)) => Json(device_record_to_response(device)).into_response(),
        Ok(None) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(e) => {
            error!("Ошибка чтения подтвержденного устройства: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn revoke_device(
    AxumPath(device_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    headers: HeaderMap,
) -> impl IntoResponse {
    let device_id = trim_limited(device_id, 128);
    let actor_id = match header_device_id(&headers) {
        Some(value) => value,
        None => {
            return (
                StatusCode::FORBIDDEN,
                "Нужен X-Zali-Device-ID доверенного устройства",
            )
                .into_response()
        }
    };
    if require_approved_device(&state.db, &owner, &actor_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            "Отзывать может только доверенное устройство",
        )
            .into_response();
    }

    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => {
            error!("Ошибка получения соединения для revoke_device {}: {}", device_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Err(e) = sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await {
        error!("Ошибка начала транзакции revoke_device {}: {}", device_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let revoke_result: Result<i64, sqlx::Error> = async {
        let active_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM account_devices WHERE owner = ? AND approved = 1 AND revoked = 0",
        )
        .bind(&owner)
        .fetch_one(&mut *conn)
        .await?;

        let target_approved = sqlx::query_scalar::<_, i64>(
            "SELECT approved FROM account_devices WHERE owner = ? AND device_id = ? LIMIT 1",
        )
        .bind(&owner)
        .bind(&device_id)
        .fetch_optional(&mut *conn)
        .await?;

        let target_approved = match target_approved {
            Some(v) => v,
            None => return Err(sqlx::Error::RowNotFound),
        };

        let target_revoked = sqlx::query_scalar::<_, i64>(
            "SELECT revoked FROM account_devices WHERE owner = ? AND device_id = ? LIMIT 1",
        )
        .bind(&owner)
        .bind(&device_id)
        .fetch_one(&mut *conn)
        .await?;

        if target_approved != 0 && target_revoked == 0 && active_count <= 1 {
            // Encode the "last device" constraint as a sentinel value
            return Ok(-1i64);
        }

        let group_epoch = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(group_epoch) FROM account_devices WHERE owner = ?",
        )
        .bind(&owner)
        .fetch_one(&mut *conn)
        .await?
        .unwrap_or(1) + 1;

        sqlx::query(
            "UPDATE account_devices
             SET revoked = 1, approved = 0, group_epoch = ?, revoked_at = CURRENT_TIMESTAMP
             WHERE owner = ? AND device_id = ?",
        )
        .bind(group_epoch)
        .bind(&owner)
        .bind(&device_id)
        .execute(&mut *conn)
        .await?;

        sqlx::query("COMMIT").execute(&mut *conn).await?;
        Ok(group_epoch)
    }
    .await;

    let group_epoch = match revoke_result {
        Ok(-1) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return (
                StatusCode::BAD_REQUEST,
                "Нельзя отозвать последнее доверенное устройство",
            )
                .into_response();
        }
        Ok(epoch) => epoch,
        Err(sqlx::Error::RowNotFound) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return (StatusCode::NOT_FOUND, "Устройство не найдено").into_response();
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            error!("Ошибка отзыва устройства {}: {}", device_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let _ = append_transparency_log(
        &state.db,
        &owner,
        "device_remove",
        group_epoch,
        &actor_id,
        Some(&device_id),
        serde_json::json!({
            "type": "device_remove",
            "account_id": owner,
            "actor_device_id": actor_id,
            "removed_device_id": device_id,
            "device_group_epoch": group_epoch
        }),
        None,
    )
    .await;

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Debug, Deserialize, Default)]
#[allow(non_snake_case)]
struct VaultQuery {
    deviceId: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[allow(non_snake_case)]
struct KeyEnvelopeQuery {
    deviceId: Option<String>,
}

async fn post_vault_event(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<VaultEventPayload>,
) -> impl IntoResponse {
    let device_id = trim_limited(payload.deviceId, 128);
    let encrypted = trim_limited(payload.encryptedVaultEvent, 262_144);
    if encrypted.len() < 16 {
        return (StatusCode::BAD_REQUEST, "Пустой encryptedVaultEvent").into_response();
    }
    if !device_id.is_empty() && device_id != "cloud" {
        if let Err(_) = require_approved_device(&state.db, &owner, &device_id).await {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Устройство не подтверждено"}))).into_response();
        }
    }
    let event_id = Uuid::new_v4().to_string();
    let vault_epoch = payload
        .vaultEpoch
        .unwrap_or_else(|| Utc::now().timestamp())
        .max(1);
    let target = payload
        .issuedToDeviceId
        .map(|value| trim_limited(value, 128))
        .filter(|value| !value.is_empty());

    if let Err(e) = sqlx::query(
        "INSERT INTO account_vault_events
         (event_id, owner, device_id, issued_to_device_id, vault_epoch, encrypted_vault_event, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&event_id)
    .bind(&owner)
    .bind(if device_id.is_empty() { "cloud" } else { &device_id })
    .bind(target.as_deref())
    .bind(vault_epoch)
    .bind(&encrypted)
    .bind(payload.signature.as_deref().unwrap_or(""))
    .execute(&state.db)
    .await
    {
        error!("Ошибка записи vault event {}: {}", event_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    Json(serde_json::json!({
        "eventId": event_id,
        "vaultEpoch": vault_epoch
    }))
    .into_response()
}

async fn delete_vault_events(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query("DELETE FROM account_vault_events WHERE owner = ?")
        .bind(&owner)
        .execute(&state.db)
        .await
    {
        Ok(result) => Json(serde_json::json!({
            "deleted": result.rows_affected()
        }))
        .into_response(),
        Err(e) => {
            error!("Ошибка очистки vault events для {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn delete_key_envelopes(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query(
        "DELETE FROM conversation_key_envelopes WHERE owner = ? OR sender = ?",
    )
    .bind(&user)
    .bind(&user)
    .execute(&state.db)
    .await
    {
        Ok(result) => Json(serde_json::json!({
            "deleted": result.rows_affected()
        }))
        .into_response(),
        Err(e) => {
            error!("Ошибка сброса key envelopes для {}: {}", user, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn key_envelope_record_to_response(record: KeyEnvelopeRecord) -> KeyEnvelopeResponse {
    KeyEnvelopeResponse {
        envelopeId: record.envelope_id,
        owner: record.owner,
        scope: record.scope_key,
        sender: record.sender,
        senderDeviceId: record.sender_device_id,
        recipientDeviceId: record.recipient_device_id,
        encryptedKey: record.encrypted_key,
        createdAt: record.created_at,
    }
}

async fn post_key_envelope(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(sender): AuthenticatedUser,
    headers: HeaderMap,
    Json(payload): Json<KeyEnvelopePayload>,
) -> impl IntoResponse {
    let recipient = trim_limited(payload.recipient, 64);
    let scope = trim_limited(payload.scope, 256);
    let sender_device_id = trim_limited(payload.senderDeviceId, 128);
    let recipient_device_id = trim_limited(payload.recipientDeviceId, 128);
    let encrypted_key = trim_limited(payload.encryptedKey, 262_144);
    let header_sender_device_id = match header_device_id(&headers) {
        Some(value) => value,
        None => return (StatusCode::FORBIDDEN, "Нужен X-Zali-Device-ID").into_response(),
    };
    if recipient.is_empty()
        || scope.is_empty()
        || sender_device_id.is_empty()
        || recipient_device_id.is_empty()
        || encrypted_key.len() < 32
    {
        return (StatusCode::BAD_REQUEST, "Некорректный key envelope").into_response();
    }
    if sender_device_id != header_sender_device_id {
        return (
            StatusCode::FORBIDDEN,
            "senderDeviceId должен совпадать с X-Zali-Device-ID",
        )
            .into_response();
    }
    if require_approved_device(&state.db, &sender, &sender_device_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            "Отправлять envelope может только доверенное устройство",
        )
            .into_response();
    }
    if require_approved_device(&state.db, &recipient, &recipient_device_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            "Устройство получателя не подтверждено",
        )
            .into_response();
    }

    let envelope_id = Uuid::new_v4().to_string();
    match sqlx::query(
        "INSERT INTO conversation_key_envelopes
         (envelope_id, owner, scope_key, sender, sender_device_id, recipient_device_id, encrypted_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, scope_key, sender_device_id, recipient_device_id) DO UPDATE SET
             encrypted_key = excluded.encrypted_key,
             created_at = CURRENT_TIMESTAMP",
    )
    .bind(&envelope_id)
    .bind(&recipient)
    .bind(&scope)
    .bind(&sender)
    .bind(&sender_device_id)
    .bind(&recipient_device_id)
    .bind(&encrypted_key)
    .execute(&state.db)
    .await
    {
        Ok(_) => Json(serde_json::json!({ "envelopeId": envelope_id })).into_response(),
        Err(e) => {
            error!("Ошибка записи key envelope {} -> {}: {}", sender, recipient, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_key_envelopes(
    Query(query): Query<KeyEnvelopeQuery>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    let target_device = query
        .deviceId
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let rows = sqlx::query_as::<_, KeyEnvelopeRecord>(
        "SELECT envelope_id, owner, scope_key, sender, sender_device_id,
                recipient_device_id, encrypted_key, created_at
         FROM conversation_key_envelopes
         WHERE owner = ? AND (? IS NULL OR recipient_device_id = ?)
         ORDER BY created_at ASC",
    )
    .bind(&owner)
    .bind(target_device.as_deref())
    .bind(target_device.as_deref())
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(key_envelope_record_to_response)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка чтения key envelopes {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_vault_events(
    Query(query): Query<VaultQuery>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    let target_device = query
        .deviceId
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let rows = sqlx::query_as::<_, VaultEventRecord>(
        "SELECT event_id, owner, device_id, issued_to_device_id, vault_epoch,
                encrypted_vault_event, signature, created_at
         FROM account_vault_events
         WHERE owner = ? AND (? IS NULL OR issued_to_device_id IS NULL OR issued_to_device_id = ?)
         ORDER BY vault_epoch ASC, created_at ASC",
    )
    .bind(&owner)
    .bind(target_device.as_deref())
    .bind(target_device.as_deref())
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|row| VaultEventResponse {
                    eventId: row.event_id,
                    owner: row.owner,
                    deviceId: row.device_id,
                    issuedToDeviceId: row.issued_to_device_id,
                    vaultEpoch: row.vault_epoch,
                    encryptedVaultEvent: row.encrypted_vault_event,
                    signature: row.signature,
                    createdAt: row.created_at,
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка чтения vault events {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn parse_rfc3339_utc(value: &str) -> Result<DateTime<Utc>, Response> {
    DateTime::parse_from_rfc3339(value.trim())
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| (StatusCode::BAD_REQUEST, "Дата должна быть RFC3339").into_response())
}

#[derive(Debug, Clone, Copy)]
struct HistoryWindow {
    from: DateTime<Utc>,
    to: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct HistoryAccess {
    base_since: Option<DateTime<Utc>>,
    ticket_windows: Vec<HistoryWindow>,
}

async fn resolve_history_access(
    _pool: &SqlitePool,
    _owner: &str,
    page: &MessagePageQuery,
    _headers: &HeaderMap,
    _conversation_id: Option<&str>,
) -> Result<HistoryAccess, Response> {
    let explicit_since = match page
        .since
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(value) => Some(parse_rfc3339_utc(value)?),
        None => None,
    };
    Ok(HistoryAccess {
        base_since: explicit_since,
        ticket_windows: Vec::new(),
    })
}

fn history_access_matches(timestamp: DateTime<Utc>, access: &HistoryAccess) -> bool {
    if access.base_since.is_none() {
        return true;
    }
    if access.base_since.is_some_and(|since| timestamp >= since) {
        return true;
    }
    access
        .ticket_windows
        .iter()
        .any(|window| timestamp >= window.from && timestamp <= window.to)
}

fn push_history_access_predicate(builder: &mut QueryBuilder<'_, Sqlite>, access: &HistoryAccess) {
    let has_base = access.base_since.is_some();
    let has_tickets = !access.ticket_windows.is_empty();
    if !has_base && !has_tickets {
        return;
    }

    builder.push(" AND (");
    let mut needs_or = false;
    if let Some(base_since) = access.base_since {
        builder.push("timestamp >= ");
        builder.push_bind(base_since);
        needs_or = true;
    }

    for window in &access.ticket_windows {
        if needs_or {
            builder.push(" OR ");
        }
        builder.push("(");
        builder.push("timestamp >= ");
        builder.push_bind(window.from);
        builder.push(" AND timestamp <= ");
        builder.push_bind(window.to);
        builder.push(")");
        needs_or = true;
    }

    builder.push(")");
}

fn header_device_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-zali-device-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn dm_conversation_scope(a: &str, b: &str) -> String {
    let mut pair = [a.trim().to_string(), b.trim().to_string()];
    pair.sort();
    format!("dm:{}:{}", pair[0], pair[1])
}

fn server_conversation_scope(server_id: &str, channel_id: &str) -> String {
    format!("server:{}:{}", server_id.trim(), channel_id.trim())
}

async fn create_history_ticket(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<HistoryTicketPayload>,
) -> impl IntoResponse {
    let issued_by = trim_limited(payload.issuedByDeviceId, 128);
    let issued_to = trim_limited(payload.issuedToDeviceId, 128);
    let from_time = match parse_rfc3339_utc(&payload.fromTime) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let to_time = match parse_rfc3339_utc(&payload.toTime) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let expires_at = match parse_rfc3339_utc(&payload.expiresAt) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if from_time > to_time || expires_at <= Utc::now() {
        return (StatusCode::BAD_REQUEST, "Некорректное окно History Ticket").into_response();
    }

    let ticket_id = Uuid::new_v4().to_string();
    let conversation_id = trim_limited(payload.conversationId, 256);
    let encrypted = trim_limited(payload.encryptedExportSecrets, 262_144);
    if conversation_id.is_empty() || encrypted.len() < 16 {
        return (
            StatusCode::BAD_REQUEST,
            "Пустой conversationId или encryptedExportSecrets",
        )
            .into_response();
    }

    if let Err(e) = sqlx::query(
        "INSERT INTO history_tickets
         (ticket_id, owner, issued_by_device_id, issued_to_device_id, conversation_id,
          from_time, to_time, expires_at, encrypted_export_secrets, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&ticket_id)
    .bind(&owner)
    .bind(&issued_by)
    .bind(&issued_to)
    .bind(&conversation_id)
    .bind(from_time)
    .bind(to_time)
    .bind(expires_at)
    .bind(&encrypted)
    .bind(payload.signature.as_deref().unwrap_or(""))
    .execute(&state.db)
    .await
    {
        error!("Ошибка записи history ticket {}: {}", ticket_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    Json(serde_json::json!({
        "ticketId": ticket_id,
        "conversationId": conversation_id
    }))
    .into_response()
}

async fn get_history_tickets(
    Query(query): Query<VaultQuery>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    let device_id = query
        .deviceId
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let rows = sqlx::query_as::<_, HistoryTicketRecord>(
        "SELECT ticket_id, owner, issued_by_device_id, issued_to_device_id, conversation_id,
                from_time, to_time, expires_at, encrypted_export_secrets, signature, revoked, created_at
         FROM history_tickets
         WHERE owner = ? AND (? IS NULL OR issued_to_device_id = ?)
         ORDER BY created_at DESC",
    )
    .bind(&owner)
    .bind(device_id.as_deref())
    .bind(device_id.as_deref())
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|row| HistoryTicketResponse {
                    ticketId: row.ticket_id,
                    owner: row.owner,
                    issuedByDeviceId: row.issued_by_device_id,
                    issuedToDeviceId: row.issued_to_device_id,
                    conversationId: row.conversation_id,
                    fromTime: row.from_time,
                    toTime: row.to_time,
                    expiresAt: row.expires_at,
                    encryptedExportSecrets: row.encrypted_export_secrets,
                    signature: row.signature,
                    revoked: row.revoked != 0,
                    createdAt: row.created_at,
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка чтения history tickets {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_transparency_log(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query_as::<_, TransparencyLogRecord>(
        "SELECT seq, owner, event_type, group_epoch, actor_device_id, target_device_id,
                event_json, signature, created_at
         FROM transparency_log
         WHERE owner = ?
         ORDER BY seq ASC",
    )
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            error!("Ошибка чтения transparency log {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_servers(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query_as::<_, ServerRecord>(
        "SELECT id, name, description, icon, color, join_link, owner, is_public, created_at
         FROM servers
         WHERE owner = ?
            OR EXISTS (
                SELECT 1 FROM server_members
                WHERE server_members.server_id = servers.id
                  AND server_members.username = ?
            )
         ORDER BY created_at ASC, name ASC",
    )
    .bind(&auth_user)
    .bind(&auth_user)
    .fetch_all(&state.db)
    .await
    {
        Ok(records) => {
            let servers = match build_server_responses_batch(&state.db, records, &auth_user).await {
                Ok(servers) => servers,
                Err(e) => {
                    error!("Ошибка сборки серверов: {}", e);
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            Json(ServerListResponse { servers }).into_response()
        }
        Err(e) => {
            error!("Ошибка получения списка серверов: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_public_servers(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query_as::<_, ServerRecord>(
        "SELECT id, name, description, icon, color, join_link, owner, is_public, created_at
         FROM servers
         WHERE is_public = 1
           AND owner != ?
           AND NOT EXISTS (
               SELECT 1 FROM server_members
               WHERE server_members.server_id = servers.id
                 AND server_members.username = ?
           )
         ORDER BY created_at ASC, name ASC",
    )
    .bind(&auth_user)
    .bind(&auth_user)
    .fetch_all(&state.db)
    .await
    {
        Ok(records) => {
            let servers = match build_server_responses_batch(&state.db, records, &auth_user).await {
                Ok(servers) => servers,
                Err(e) => {
                    error!("Ошибка сборки публичных серверов: {}", e);
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            Json(ServerListResponse { servers }).into_response()
        }
        Err(e) => {
            error!("Ошибка получения публичных серверов: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn create_server(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<ServerPayload>,
) -> impl IntoResponse {
    let ServerPayload {
        name,
        description,
        icon,
        color,
        join_link,
        is_public,
        avatar_data_url,
        banner_data_url,
        roles,
    } = payload;

    let name = name.trim();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "Имя сервера не может быть пустым").into_response();
    }

    const MAX_SERVERS_PER_USER: i64 = 25;
    let owned_count =
        match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM servers WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&state.db)
            .await
        {
            Ok(count) => count,
            Err(e) => {
                error!("Ошибка подсчета серверов владельца {}: {}", owner, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
    if owned_count >= MAX_SERVERS_PER_USER {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            "Превышен лимит серверов на аккаунт",
        )
            .into_response();
    }

    let server_id = Uuid::new_v4().to_string();

    if let Some(ref link) = join_link {
        let link = link.trim();
        if link.len() > 128 {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "join_link слишком длинный"}))).into_response();
        }
        if link.starts_with("zali://server/") && *link != format!("zali://server/{}", server_id) {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Недопустимый формат join_link"}))).into_response();
        }
    }

    let server = ServerRecord {
        id: server_id.clone(),
        name: name.to_string(),
        description: description.unwrap_or_default(),
        icon: icon.unwrap_or_else(|| name.chars().next().unwrap_or('S').to_string()),
        color: color.unwrap_or_else(|| "#cbff00".to_string()),
        join_link: join_link
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("zali://server/{}", server_id)),
        owner: owner.clone(),
        is_public: if is_public.unwrap_or(true) { 1 } else { 0 },
        created_at: Utc::now(),
    };

    match sqlx::query(
        "INSERT INTO servers (id, name, description, icon, color, join_link, owner, is_public, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&server.id)
    .bind(&server.name)
    .bind(&server.description)
    .bind(&server.icon)
    .bind(&server.color)
    .bind(&server.join_link)
    .bind(&server.owner)
    .bind(server.is_public)
    .bind(server.created_at)
    .execute(&state.db)
    .await
    {
        Ok(_) => {
            if let Err(e) = ensure_server_member(&state.db, &server.id, &owner, "owner").await {
                error!("Ошибка добавления владельца сервера {}: {}", server.id, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            if let Err(e) = ensure_default_server_roles(&state.db, &server.id, server.created_at).await {
                error!("Ошибка создания ролей сервера {}: {}", server.id, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            if let Some(custom_roles) = roles.as_ref() {
                for role in custom_roles {
                    if role.name.trim().is_empty() {
                        return (StatusCode::BAD_REQUEST, "Имя роли не может быть пустым").into_response();
                    }
                    if let Err(e) = create_server_role_record(&state.db, &server.id, role).await {
                        error!("Ошибка создания пользовательской роли сервера {}: {}", server.id, e);
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                }
            }
            if let Some(avatar_data_url) = avatar_data_url.as_deref() {
                let _ = set_server_asset(&state.db, &state.data_dir, &server.id, "avatar", avatar_data_url).await;
            }
            if let Some(banner_data_url) = banner_data_url.as_deref() {
                let _ = set_server_asset(&state.db, &state.data_dir, &server.id, "banner", banner_data_url).await;
            }

            let default_channels = [
                ("general", "Общий чат", 0),
                ("announcements", "Объявления", 1),
            ];
            for (channel_key, channel_name, position) in default_channels {
                let channel_id = format!("{}-{}", server.id, channel_key);
                let _ = sqlx::query(
                    "INSERT INTO channels (id, server_id, name, topic, kind, position, created_at)
                     VALUES (?, ?, ?, ?, 'text', ?, ?)",
                )
                .bind(&channel_id)
                .bind(&server.id)
                .bind(channel_name)
                .bind("")
                .bind(position)
                .bind(Utc::now())
                .execute(&state.db)
                .await;
            }

            match build_server_response(&state.db, server, &owner).await {
                Ok(server) => (StatusCode::CREATED, Json(server)).into_response(),
                Err(e) => {
                    error!("Ошибка формирования ответа сервера: {}", e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        Err(e) => {
            error!("Ошибка создания сервера: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_channels(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    match get_server_access_context(&state.db, &server_id, &auth_user).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(e) => {
            error!("Ошибка проверки доступа к серверу {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let channels = if can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        load_channels_for_server(&state.db, &server_id).await
    } else {
        load_visible_channels_for_server(&state.db, &server_id, &auth_user).await
    };

    match channels {
        Ok(channels) => Json(channels).into_response(),
        Err(e) => {
            error!("Ошибка получения каналов сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn create_channel(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<ChannelPayload>,
) -> impl IntoResponse {
    let server = match get_server_accessibility(&state.db, &server_id).await {
        Ok(Some(server)) => server,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска сервера {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if !can_manage_server(&state.db, &server_id, &owner)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let channel_name = payload.name.trim();
    if channel_name.is_empty() {
        return (StatusCode::BAD_REQUEST, "Имя канала не может быть пустым").into_response();
    }
    if channel_name_conflicts(&state.db, &server_id, channel_name, None)
        .await
        .unwrap_or(false)
    {
        return (
            StatusCode::BAD_REQUEST,
            "Канал с таким названием уже существует",
        )
            .into_response();
    }

    if server.is_public == 0 {
        debug!("Создание канала в приватном сервере {}", server_id);
    }

    let channel_id = format!("{}-{}", server.id, Uuid::new_v4());
    match sqlx::query(
        "INSERT INTO channels (id, server_id, name, topic, kind, position, created_at)
         VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM channels WHERE server_id = ?), 0), ?)",
    )
    .bind(&channel_id)
        .bind(&server.id)
        .bind(channel_name)
        .bind(payload.topic.unwrap_or_default())
        .bind(normalize_channel_kind(payload.kind.as_deref()))
        .bind(&server.id)
        .bind(Utc::now())
        .execute(&state.db)
    .await
    {
        Ok(_) => {
            if payload.can_view.is_some() || payload.can_send.is_some() {
                let can_view = payload.can_view.unwrap_or(true) as i64;
                let can_send = payload.can_send.unwrap_or(true) as i64;
                let _ = sqlx::query(
                    "INSERT INTO channel_permissions (channel_id, role, can_view, can_send, can_manage, updated_at)
                     VALUES (?, 'member', ?, ?, 0, ?)
                     ON CONFLICT(channel_id, role) DO UPDATE SET
                        can_view = excluded.can_view,
                        can_send = excluded.can_send,
                        updated_at = excluded.updated_at",
                )
                .bind(&channel_id)
                .bind(can_view)
                .bind(can_send)
                .bind(Utc::now())
                .execute(&state.db)
                .await;
            }

            match load_channels_for_server(&state.db, &server.id).await {
                Ok(channels) => Json(channels).into_response(),
                Err(e) => {
                    error!("Ошибка перечитывания каналов: {}", e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        },
        Err(e) => {
            error!("Ошибка создания канала в сервере {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn update_channel(
    AxumPath((server_id, channel_id)): AxumPath<(String, String)>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ChannelUpdatePayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let channel = match sqlx::query_as::<_, ChannelRecord>(
        "SELECT id, server_id, name, topic, kind, position, created_at
         FROM channels
         WHERE server_id = ? AND id = ?
         LIMIT 1",
    )
    .bind(&server_id)
    .bind(&channel_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(channel)) => channel,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска канала {}/{}: {}", server_id, channel_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let next_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| channel.name.clone());
    if next_name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "Имя канала не может быть пустым").into_response();
    }
    if next_name != channel.name
        && channel_name_conflicts(&state.db, &server_id, &next_name, Some(&channel_id))
            .await
            .unwrap_or(false)
    {
        return (
            StatusCode::BAD_REQUEST,
            "Канал с таким названием уже существует",
        )
            .into_response();
    }

    let next_topic = payload
        .topic
        .map(|topic| topic.trim().to_string())
        .unwrap_or_else(|| channel.topic.clone());
    let next_kind = payload
        .kind
        .as_deref()
        .map(|kind| normalize_channel_kind(Some(kind)))
        .unwrap_or_else(|| channel.kind.clone());
    let next_position = payload.position.unwrap_or(channel.position).max(0);

    if let Err(e) = sqlx::query(
        "UPDATE channels
         SET name = ?, topic = ?, kind = ?, position = ?
         WHERE server_id = ? AND id = ?",
    )
    .bind(&next_name)
    .bind(&next_topic)
    .bind(&next_kind)
    .bind(next_position)
    .bind(&server_id)
    .bind(&channel_id)
    .execute(&state.db)
    .await
    {
        error!(
            "Ошибка обновления канала {}/{}: {}",
            server_id, channel_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match load_channels_for_server(&state.db, &server_id).await {
        Ok(channels) => Json(channels).into_response(),
        Err(e) => {
            error!(
                "Ошибка перечитывания каналов {} после обновления {}: {}",
                server_id, channel_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn delete_channel(
    AxumPath((server_id, channel_id)): AxumPath<(String, String)>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let channel = match sqlx::query_as::<_, ChannelRecord>(
        "SELECT id, server_id, name, topic, kind, position, created_at
         FROM channels
         WHERE server_id = ? AND id = ?
         LIMIT 1",
    )
    .bind(&server_id)
    .bind(&channel_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(channel)) => channel,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска канала {}/{}: {}", server_id, channel_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let messages = match sqlx::query_as::<_, Message>(
        "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
         FROM messages
         WHERE server_id = ? AND channel_id = ?",
    )
    .bind(&server_id)
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!(
                "Ошибка загрузки сообщений канала {}/{} перед удалением: {}",
                server_id, channel_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    for msg in &messages {
        let path = state.uploads_dir.join(&msg.filename);
        let _ = fs::remove_file(&path).await;
    }

    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            error!(
                "Ошибка начала транзакции удаления канала {}/{}: {}",
                server_id, channel_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Err(e) = sqlx::query("DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE server_id = ? AND channel_id = ?)")
        .bind(&server_id)
        .bind(&channel_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления реакций канала {}/{}: {}", server_id, channel_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM messages WHERE server_id = ? AND channel_id = ?")
        .bind(&server_id)
        .bind(&channel_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!(
            "Ошибка удаления сообщений канала {}/{}: {}",
            server_id, channel_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM channel_permissions WHERE channel_id = ?")
        .bind(&channel_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!(
            "Ошибка удаления прав канала {}/{}: {}",
            server_id, channel_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM channels WHERE server_id = ? AND id = ?")
        .bind(&server_id)
        .bind(&channel_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления канала {}/{}: {}", server_id, channel_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Err(e) = tx.commit().await {
        error!(
            "Ошибка фиксации удаления канала {}/{} ({}): {}",
            server_id, channel_id, channel.name, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match load_channels_for_server(&state.db, &server_id).await {
        Ok(channels) => Json(channels).into_response(),
        Err(e) => {
            error!(
                "Ошибка перечитывания каналов {} после удаления {}: {}",
                server_id, channel_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn update_server(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerSettingsPayload>,
) -> impl IntoResponse {
    let server = match get_server_accessibility(&state.db, &server_id).await {
        Ok(Some(server)) => server,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска сервера {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let next_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or(server.name);
    let next_description = payload
        .description
        .unwrap_or(server.description)
        .trim()
        .to_string();
    let next_icon = payload
        .icon
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or(server.icon);
    let next_color = payload
        .color
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or(server.color);
    let next_join_link = payload
        .join_link
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or(server.join_link);
    let next_public = if let Some(is_public) = payload.is_public {
        if is_public {
            1
        } else {
            0
        }
    } else {
        server.is_public
    };

    if let Err(e) = sqlx::query(
        "UPDATE servers
         SET name = ?, description = ?, icon = ?, color = ?, join_link = ?, is_public = ?
         WHERE id = ?",
    )
    .bind(&next_name)
    .bind(&next_description)
    .bind(&next_icon)
    .bind(&next_color)
    .bind(&next_join_link)
    .bind(next_public)
    .bind(&server_id)
    .execute(&state.db)
    .await
    {
        error!("Ошибка обновления сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Some(avatar_data_url) = payload.avatar_data_url.as_deref() {
        if let Err(e) = set_server_asset(
            &state.db,
            &state.data_dir,
            &server_id,
            "avatar",
            avatar_data_url,
        )
        .await
        {
            error!("Ошибка обновления аватара сервера {}: {}", server_id, e);
        }
    }
    if let Some(banner_data_url) = payload.banner_data_url.as_deref() {
        if let Err(e) = set_server_asset(
            &state.db,
            &state.data_dir,
            &server_id,
            "banner",
            banner_data_url,
        )
        .await
        {
            error!("Ошибка обновления баннера сервера {}: {}", server_id, e);
        }
    }

    match get_server_accessibility(&state.db, &server_id).await {
        Ok(Some(updated)) => match build_server_response(&state.db, updated, &auth_user).await {
            Ok(server) => Json(server).into_response(),
            Err(e) => {
                error!("Ошибка формирования ответа сервера {}: {}", server_id, e);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка перечитывания сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_server_members(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    match load_server_members(&state.db, &server_id).await {
        Ok(members) => Json(serde_json::json!({ "members": members })).into_response(),
        Err(e) => {
            error!("Ошибка загрузки участников сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn add_server_member(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerMemberPayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let server = match get_server_accessibility(&state.db, &server_id).await {
        Ok(Some(server)) => server,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска сервера {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let username = payload.username.trim();
    if username.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Имя участника не может быть пустым",
        )
            .into_response();
    }
    if username == server.owner {
        return (
            StatusCode::BAD_REQUEST,
            "Владелец уже является участником сервера",
        )
            .into_response();
    }

    let role = match resolve_member_role_input(&state.db, &server_id, payload.role.as_deref()).await
    {
        Ok(role) => role,
        Err(_) => return (StatusCode::BAD_REQUEST, "Неизвестная роль").into_response(),
    };
    if role == "owner" {
        return (StatusCode::BAD_REQUEST, "Нельзя назначить роль владельца").into_response();
    }
    if let Err(e) = upsert_server_member(&state.db, &server_id, username, &role).await {
        error!(
            "Ошибка добавления участника {} в сервер {}: {}",
            username, server_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match load_server_members(&state.db, &server_id).await {
        Ok(members) => Json(serde_json::json!({ "members": members })).into_response(),
        Err(e) => {
            error!(
                "Ошибка перечитывания участников сервера {}: {}",
                server_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn update_server_member(
    AxumPath((server_id, username)): AxumPath<(String, String)>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerMemberPayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let server = match get_server_accessibility(&state.db, &server_id).await {
        Ok(Some(server)) => server,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска сервера {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let target = username.trim();
    if target.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Имя участника не может быть пустым",
        )
            .into_response();
    }
    if target == server.owner {
        return (StatusCode::BAD_REQUEST, "Роль владельца изменить нельзя").into_response();
    }

    let role = match resolve_member_role_input(&state.db, &server_id, payload.role.as_deref()).await
    {
        Ok(role) => role,
        Err(_) => return (StatusCode::BAD_REQUEST, "Неизвестная роль").into_response(),
    };
    if role == "owner" {
        return (StatusCode::BAD_REQUEST, "Нельзя назначить роль владельца").into_response();
    }
    if let Err(e) = upsert_server_member(&state.db, &server_id, target, &role).await {
        error!(
            "Ошибка обновления роли участника {} в сервере {}: {}",
            target, server_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match load_server_members(&state.db, &server_id).await {
        Ok(members) => Json(serde_json::json!({ "members": members })).into_response(),
        Err(e) => {
            error!(
                "Ошибка перечитывания участников сервера {}: {}",
                server_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn delete_server_member(
    AxumPath((server_id, username)): AxumPath<(String, String)>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let server = match get_server_accessibility(&state.db, &server_id).await {
        Ok(Some(server)) => server,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска сервера {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let target = username.trim();
    if target.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Имя участника не может быть пустым",
        )
            .into_response();
    }
    if target == server.owner {
        return (StatusCode::BAD_REQUEST, "Владельца нельзя удалить").into_response();
    }

    if let Err(e) = sqlx::query("DELETE FROM server_members WHERE server_id = ? AND username = ?")
        .bind(&server_id)
        .bind(target)
        .execute(&state.db)
        .await
    {
        error!(
            "Ошибка удаления участника {} из сервера {}: {}",
            target, server_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match load_server_members(&state.db, &server_id).await {
        Ok(members) => Json(serde_json::json!({ "members": members })).into_response(),
        Err(e) => {
            error!(
                "Ошибка перечитывания участников сервера {}: {}",
                server_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn delete_server(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    let server = match get_server_accessibility(&state.db, &server_id).await {
        Ok(Some(server)) => server,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска сервера {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if server.owner != auth_user {
        return StatusCode::FORBIDDEN.into_response();
    }

    let filenames = match sqlx::query_scalar::<_, String>(
        "SELECT filename
         FROM messages
         WHERE server_id = ?",
    )
    .bind(&server_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!(
                "Ошибка загрузки сообщений сервера {} перед удалением: {}",
                server_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            error!(
                "Ошибка начала транзакции удаления сервера {}: {}",
                server_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Err(e) = sqlx::query(
        "DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE server_id = ?)",
    )
    .bind(&server_id)
    .execute(&mut *tx)
    .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления реакций сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM messages WHERE server_id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления сообщений сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query(
        "DELETE FROM channel_permissions WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)",
    )
    .bind(&server_id)
    .execute(&mut *tx)
    .await
    {
        let _ = tx.rollback().await;
        error!(
            "Ошибка удаления прав каналов сервера {}: {}",
            server_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM server_members WHERE server_id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления участников сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM server_invites WHERE server_id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления инвайтов сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM server_roles WHERE server_id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления ролей сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM channels WHERE server_id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления каналов сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM servers WHERE id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("Ошибка удаления сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Err(e) = tx.commit().await {
        error!("Ошибка фиксации удаления сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    // Delete files only after DB transaction committed successfully
    for filename in &filenames {
        let path = state.uploads_dir.join(filename);
        let _ = fs::remove_file(&path).await;
    }

    StatusCode::NO_CONTENT.into_response()
}

async fn get_server_roles(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    match load_server_roles(&state.db, &server_id).await {
        Ok(roles) => Json(serde_json::json!({ "roles": roles })).into_response(),
        Err(e) => {
            error!("Ошибка загрузки ролей сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn create_server_role(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerRolePayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    match create_server_role_record(&state.db, &server_id, &payload).await {
        Ok(role) => Json(role).into_response(),
        Err(e) => {
            error!("Ошибка создания роли сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn update_server_role(
    AxumPath((server_id, role_id)): AxumPath<(String, String)>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerRolePayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    match update_server_role_record(&state.db, &server_id, &role_id, &payload).await {
        Ok(role) => Json(role).into_response(),
        Err(e) => {
            error!(
                "Ошибка обновления роли {} в сервере {}: {}",
                role_id, server_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn delete_server_role(
    AxumPath((server_id, role_id)): AxumPath<(String, String)>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    match delete_server_role_record(&state.db, &server_id, &role_id).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            error!(
                "Ошибка удаления роли {} в сервере {}: {}",
                role_id, server_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_server_avatar(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    match get_server_access_context(&state.db, &server_id, &auth_user).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(e) => {
            error!(
                "Ошибка проверки доступа к аватару сервера {}: {}",
                server_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    match get_server_asset(&state.db, &state.data_dir, &server_id, "avatar").await {
        Ok(Some((mime, data))) => (
            [
                (axum::http::header::CONTENT_TYPE, mime.as_str()),
                (
                    axum::http::header::CACHE_CONTROL,
                    "no-store, no-cache, must-revalidate",
                ),
                (axum::http::header::PRAGMA, "no-cache"),
            ],
            data,
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка загрузки аватара сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn set_server_avatar(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerAssetPayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if payload.data_url.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "data_url обязателен").into_response();
    }
    if let Err(e) = set_server_asset(
        &state.db,
        &state.data_dir,
        &server_id,
        "avatar",
        &payload.data_url,
    )
    .await
    {
        error!("Ошибка сохранения аватара сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn delete_server_avatar(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Err(e) = clear_server_asset(&state.db, &state.data_dir, &server_id, "avatar").await {
        error!("Ошибка удаления аватара сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn get_server_banner(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    match get_server_access_context(&state.db, &server_id, &auth_user).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(e) => {
            error!(
                "Ошибка проверки доступа к баннеру сервера {}: {}",
                server_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    match get_server_asset(&state.db, &state.data_dir, &server_id, "banner").await {
        Ok(Some((mime, data))) => (
            [
                (axum::http::header::CONTENT_TYPE, mime.as_str()),
                (
                    axum::http::header::CACHE_CONTROL,
                    "no-store, no-cache, must-revalidate",
                ),
                (axum::http::header::PRAGMA, "no-cache"),
            ],
            data,
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка загрузки баннера сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn set_server_banner(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerAssetPayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if payload.data_url.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "data_url обязателен").into_response();
    }
    if let Err(e) = set_server_asset(
        &state.db,
        &state.data_dir,
        &server_id,
        "banner",
        &payload.data_url,
    )
    .await
    {
        error!("Ошибка сохранения баннера сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn delete_server_banner(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Err(e) = clear_server_asset(&state.db, &state.data_dir, &server_id, "banner").await {
        error!("Ошибка удаления баннера сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn get_server_invites(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let rows = match sqlx::query_as::<_, ServerInviteRecord>(
        "SELECT code, server_id, created_by, max_uses, uses, expires_at, created_at
         FROM server_invites
         WHERE server_id = ?
         ORDER BY created_at DESC",
    )
    .bind(&server_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!("Ошибка загрузки инвайтов сервера {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let invites: Vec<ServerInviteResponse> = rows
        .into_iter()
        .map(|row| ServerInviteResponse {
            url: format!("zali://invite/{}", row.code),
            serverId: row.server_id,
            createdBy: row.created_by,
            code: row.code,
            maxUses: row.max_uses,
            uses: row.uses,
            expiresAt: row.expires_at,
            createdAt: row.created_at,
        })
        .collect();
    Json(serde_json::json!({ "invites": invites })).into_response()
}

async fn create_server_invite(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<InvitePayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let max_uses = payload.max_uses.unwrap_or(0).max(0);
    match create_server_invite_record(
        &state.db,
        &server_id,
        &auth_user,
        max_uses,
        payload.expires_hours,
    )
    .await
    {
        Ok(invite) => Json(ServerInviteResponse {
            url: format!("zali://invite/{}", invite.code),
            serverId: invite.server_id,
            createdBy: invite.created_by,
            code: invite.code,
            maxUses: invite.max_uses,
            uses: invite.uses,
            expiresAt: invite.expires_at,
            createdAt: invite.created_at,
        })
        .into_response(),
        Err(e) => {
            error!("Ошибка создания инвайта для сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn join_server_invite(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<JoinInvitePayload>,
) -> impl IntoResponse {
    let code = payload.code.trim();
    if code.is_empty() {
        return (StatusCode::BAD_REQUEST, "Код приглашения обязателен").into_response();
    }

    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            error!(
                "Ошибка начала транзакции при join_server_invite {}: {}",
                code, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let invite = match sqlx::query_as::<_, ServerInviteRecord>(
        "SELECT code, server_id, created_by, max_uses, uses, expires_at, created_at
         FROM server_invites WHERE code = ? LIMIT 1",
    )
    .bind(code)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(invite)) => invite,
        Ok(None) => {
            let _ = tx.rollback().await;
            return StatusCode::NOT_FOUND.into_response();
        }
        Err(e) => {
            let _ = tx.rollback().await;
            error!("Ошибка поиска инвайта {}: {}", code, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Some(expires_at) = invite.expires_at {
        if expires_at < Utc::now() {
            let _ = tx.rollback().await;
            return (StatusCode::GONE, "Срок действия инвайта истёк").into_response();
        }
    }

    let updated = match sqlx::query(
        "UPDATE server_invites
         SET uses = uses + 1
         WHERE code = ?
           AND (max_uses = 0 OR uses < max_uses)",
    )
    .bind(code)
    .execute(&mut *tx)
    .await
    {
        Ok(result) => result.rows_affected(),
        Err(e) => {
            let _ = tx.rollback().await;
            error!("Ошибка увеличения использования инвайта {}: {}", code, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if updated == 0 {
        let _ = tx.rollback().await;
        return (StatusCode::GONE, "Инвайт уже использован").into_response();
    }

    if let Err(e) = sqlx::query(
        "INSERT INTO server_members (server_id, username, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(server_id, username) DO UPDATE SET
            role = excluded.role",
    )
    .bind(&invite.server_id)
    .bind(&auth_user)
    .bind("member")
    .bind(Utc::now())
    .execute(&mut *tx)
    .await
    {
        let _ = tx.rollback().await;
        error!(
            "Ошибка добавления пользователя {} по инвайту {}: {}",
            auth_user, code, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Err(e) = tx.commit().await {
        error!("Ошибка фиксации join_server_invite {}: {}", code, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    Json(serde_json::json!({ "serverId": invite.server_id, "joined": true })).into_response()
}

async fn join_server_link(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<JoinServerLinkPayload>,
) -> impl IntoResponse {
    let raw = payload.link.trim();
    if raw.is_empty() {
        return (StatusCode::BAD_REQUEST, "Ссылка сервера обязательна").into_response();
    }

    let _normalized = raw
        .strip_prefix("zali://server/")
        .or_else(|| raw.strip_prefix("server/"))
        .unwrap_or(raw)
        .trim()
        .to_string();

    let server = match sqlx::query_as::<_, ServerRecord>(
        "SELECT id, name, description, icon, color, join_link, owner, is_public, created_at
         FROM servers
         WHERE join_link = ? LIMIT 1",
    )
    .bind(raw)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(server)) => server,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска сервера по ссылке {}: {}", raw, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if server.is_public == 0 {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Сервер приватный"}))).into_response();
    }

    if let Err(e) = ensure_server_member(&state.db, &server.id, &auth_user, "member").await {
        error!(
            "Ошибка добавления пользователя {} по ссылке сервера {}: {}",
            auth_user, server.id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    Json(serde_json::json!({ "serverId": server.id, "joined": true })).into_response()
}

async fn get_channel_permissions(
    AxumPath((server_id, channel_id)): AxumPath<(String, String)>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    match channel_belongs_to_server(&state.db, &server_id, &channel_id).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка проверки канала {}/{}: {}", server_id, channel_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    match load_channel_permissions(&state.db, &channel_id).await {
        Ok(permissions) => Json(serde_json::json!({ "serverId": server_id, "channelId": channel_id, "permissions": permissions })).into_response(),
        Err(e) => {
            error!("Ошибка загрузки прав канала {}/{}: {}", server_id, channel_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn update_channel_permissions(
    AxumPath((server_id, channel_id)): AxumPath<(String, String)>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ChannelPermissionsPayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    match channel_belongs_to_server(&state.db, &server_id, &channel_id).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка проверки канала {}/{}: {}", server_id, channel_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    match upsert_channel_permissions(&state.db, &channel_id, &payload.permissions).await {
        Ok(_) => match load_channel_permissions(&state.db, &channel_id).await {
            Ok(permissions) => Json(serde_json::json!({ "serverId": server_id, "channelId": channel_id, "permissions": permissions })).into_response(),
            Err(e) => {
                error!("Ошибка перечитывания прав канала {}/{}: {}", server_id, channel_id, e);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(e) => {
            error!("Ошибка обновления прав канала {}/{}: {}", server_id, channel_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_server_messages(
    AxumPath((server_id, channel_id)): AxumPath<(String, String)>,
    Query(page): Query<MessagePageQuery>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    info!(
        "API get_server_messages start server={} channel={} auth={}",
        server_id, channel_id, auth_user
    );
    match get_server_access_context(&state.db, &server_id, &auth_user).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(e) => {
            error!("Ошибка проверки доступа к серверу {}: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if !can_access_channel(&state.db, &server_id, &channel_id, &auth_user, "view")
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let limit = page.limit.unwrap_or(50).clamp(1, 500) as i64;
    let offset = page.offset.unwrap_or(0).max(0) as i64;
    let conversation_scope = Some(server_conversation_scope(&server_id, &channel_id));
    let history_access = match resolve_history_access(
        &state.db,
        &auth_user,
        &page,
        &headers,
        conversation_scope.as_deref(),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
         FROM messages
         WHERE server_id = ",
    );
    builder.push_bind(&server_id);
    builder.push(" AND channel_id = ");
    builder.push_bind(&channel_id);
    push_history_access_predicate(&mut builder, &history_access);
    builder.push(" ORDER BY timestamp ASC, id ASC");
    builder.push(" LIMIT ");
    builder.push_bind(limit);
    builder.push(" OFFSET ");
    builder.push_bind(offset);

    match builder
        .build_query_as::<Message>()
        .fetch_all(&state.db)
        .await
    {
        Ok(msgs) => {
            info!(
                "API get_server_messages rows server={} channel={} auth={} count={}",
                server_id,
                channel_id,
                auth_user,
                msgs.len()
            );
            let mut available_msgs = Vec::with_capacity(msgs.len());
            for msg in msgs {
                let path = state.uploads_dir.join(&msg.filename);
                if fs::try_exists(&path).await.unwrap_or(false) {
                    available_msgs.push(msg);
                } else {
                    warn!(
                        "API get_server_messages skip orphan record id={} missing_file={}",
                        msg.id,
                        path.display()
                    );
                }
            }
            let ids: Vec<String> = available_msgs.iter().map(|m| m.id.clone()).collect();
            let reaction_states = load_reaction_states(&state, &ids, &auth_user)
                .await
                .unwrap_or_default();
            let response: Vec<MessageResponse> = available_msgs
                .into_iter()
                .map(|msg| {
                    let (reactions, my_reaction) =
                        reaction_states.get(&msg.id).cloned().unwrap_or_default();
                    MessageResponse {
                        id: msg.id,
                        client_id: msg.client_id,
                        sender: msg.sender,
                        receiver: msg.receiver,
                        filename: msg.filename,
                        timestamp: msg.timestamp,
                        key_version: msg.key_version,
                        server_id: msg.server_id,
                        channel_id: msg.channel_id,
                        reactions,
                        my_reaction,
                    }
                })
                .collect();
            Json(response).into_response()
        }
        Err(e) => {
            error!(
                "Ошибка получения сообщений сервера {}/{}: {}",
                server_id, channel_id, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_messages(
    AxumPath(user): AxumPath<String>,
    Query(page): Query<MessagePageQuery>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    info!("API get_messages start user={} auth={}", user, auth_user);
    let effective_user = auth_user.clone();
    if user == effective_user {
        warn!(
            "API get_messages requested self-chat user={}",
            effective_user
        );
    }

    let limit = page.limit.unwrap_or(50).clamp(1, 500) as i64;
    let offset = page.offset.unwrap_or(0).max(0) as i64;
    let conversation_scope = Some(dm_conversation_scope(&effective_user, &user));
    let history_access = match resolve_history_access(
        &state.db,
        &effective_user,
        &page,
        &headers,
        conversation_scope.as_deref(),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
         FROM messages
         WHERE server_id IS NULL
           AND ((sender = ",
    );
    builder.push_bind(&effective_user);
    builder.push(" AND receiver = ");
    builder.push_bind(&user);
    builder.push(") OR (sender = ");
    builder.push_bind(&user);
    builder.push(" AND receiver = ");
    builder.push_bind(&effective_user);
    builder.push("))");
    push_history_access_predicate(&mut builder, &history_access);
    builder.push(" ORDER BY timestamp ASC, id ASC");
    builder.push(" LIMIT ");
    builder.push_bind(limit);
    builder.push(" OFFSET ");
    builder.push_bind(offset);
    match builder
        .build_query_as::<Message>()
        .fetch_all(&state.db)
        .await
    {
        Ok(msgs) => {
            info!(
                "API get_messages rows user={} count={} db={} uploads={}",
                effective_user,
                msgs.len(),
                state.data_dir.join("zali_messenger.db").display(),
                state.uploads_dir.display()
            );
            let mut available_msgs = Vec::with_capacity(msgs.len());
            for msg in msgs {
                let path = state.uploads_dir.join(&msg.filename);
                if fs::try_exists(&path).await.unwrap_or(false) {
                    available_msgs.push(msg);
                } else {
                    warn!(
                        "API get_messages skip orphan record id={} missing_file={}",
                        msg.id,
                        path.display()
                    );
                }
            }
            let ids: Vec<String> = available_msgs.iter().map(|m| m.id.clone()).collect();
            let reaction_states = load_reaction_states(&state, &ids, &effective_user)
                .await
                .unwrap_or_default();
            let response: Vec<MessageResponse> = available_msgs
                .into_iter()
                .map(|msg| {
                    let (reactions, my_reaction) =
                        reaction_states.get(&msg.id).cloned().unwrap_or_default();
                    MessageResponse {
                        id: msg.id,
                        client_id: msg.client_id,
                        sender: msg.sender,
                        receiver: msg.receiver,
                        filename: msg.filename,
                        timestamp: msg.timestamp,
                        key_version: msg.key_version,
                        server_id: msg.server_id,
                        channel_id: msg.channel_id,
                        reactions,
                        my_reaction,
                    }
                })
                .collect();
            Json(response).into_response()
        }
        Err(e) => {
            error!("Ошибка получения сообщений для {}: {}", user, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn set_message_reaction(
    AxumPath(id): AxumPath<String>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    Json(payload): Json<ReactionPayload>,
) -> impl IntoResponse {
    let message = match sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
    {
        Ok(message) => message,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };

    let allowed = can_access_message(&state, &message, &auth_user)
        .await
        .unwrap_or(false);
    if !allowed {
        warn!(
            "Попытка поставить реакцию к чужому сообщению: {} → {}",
            auth_user, id
        );
        return StatusCode::FORBIDDEN.into_response();
    }

    let emoji = payload.emoji.trim().to_string();
    let result = if emoji.is_empty() {
        sqlx::query("DELETE FROM reactions WHERE message_id = ? AND reactor = ?")
            .bind(&id)
            .bind(&auth_user)
            .execute(&state.db)
            .await
    } else {
        if emoji.chars().count() > 8 {
            return (StatusCode::BAD_REQUEST, "Слишком длинная реакция").into_response();
        }

        sqlx::query(
            "INSERT INTO reactions (message_id, reactor, emoji, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(message_id, reactor) DO UPDATE SET
                emoji = excluded.emoji,
                updated_at = excluded.updated_at",
        )
        .bind(&id)
        .bind(&auth_user)
        .bind(&emoji)
        .bind(Utc::now())
        .execute(&state.db)
        .await
    };

    if let Err(e) = result {
        error!(
            "Ошибка сохранения реакции {} на сообщение {}: {}",
            auth_user, id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    broadcast_reaction_event(&state, &message).await;

    match load_reaction_state(&state, &id, &auth_user).await {
        Ok((reactions, my_reaction)) => Json(serde_json::json!({
            "type": "reaction_updated",
            "messageId": id,
            "sender": message.sender,
            "receiver": message.receiver,
            "serverId": message.server_id,
            "channelId": message.channel_id,
            "reactions": reactions,
            "myReaction": my_reaction
        }))
        .into_response(),
        Err(e) => {
            error!("Ошибка загрузки реакции {}: {}", id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_avatar(
    AxumPath(username): AxumPath<String>,
    AuthenticatedUser(_auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    let file_dir = user_avatar_asset_dir(&state.data_dir, &username);
    if let Ok(Some((mime, data, _))) = read_asset_file(file_dir.clone(), "avatar").await {
        return (
            [
                (axum::http::header::CONTENT_TYPE, mime.as_str()),
                (
                    axum::http::header::CACHE_CONTROL,
                    "no-store, no-cache, must-revalidate",
                ),
                (axum::http::header::PRAGMA, "no-cache"),
            ],
            data,
        )
            .into_response();
    }

    match sqlx::query_as::<_, AvatarRecord>(
        "SELECT username, mime_type, data, updated_at FROM avatars WHERE username = ?",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(avatar)) => {
            let _ = write_asset_file(
                file_dir,
                "avatar",
                &avatar.mime_type,
                &avatar.data,
                Some(avatar.updated_at),
            )
            .await;
            (
                [
                    (axum::http::header::CONTENT_TYPE, avatar.mime_type.as_str()),
                    (
                        axum::http::header::CACHE_CONTROL,
                        "no-store, no-cache, must-revalidate",
                    ),
                    (axum::http::header::PRAGMA, "no-cache"),
                ],
                avatar.data,
            )
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка получения аватара {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn upload_avatar(
    AuthenticatedUser(username): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut file_data: Vec<u8> = Vec::new();
    let mut mime_type = String::new();

    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_string();
                if name.as_str() == "file" {
                    mime_type = field
                        .content_type()
                        .map(|m| m.to_string())
                        .unwrap_or_else(|| "image/png".to_string());
                    let mut field = field;
                    loop {
                        match field.chunk().await {
                            Ok(Some(chunk)) => {
                                if file_data.len().saturating_add(chunk.len()) > MAX_AVATAR_BYTES {
                                    return (
                                        StatusCode::PAYLOAD_TOO_LARGE,
                                        "Аватар не должен превышать 2 МБ",
                                    )
                                        .into_response();
                                }
                                file_data.extend_from_slice(&chunk);
                            }
                            Ok(None) => break,
                            Err(e) => {
                                error!("Ошибка чтения файла аватара: {}", e);
                                return StatusCode::BAD_REQUEST.into_response();
                            }
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                error!("Ошибка парсинга avatar multipart: {}", e);
                return StatusCode::BAD_REQUEST.into_response();
            }
        }
    }

    if file_data.is_empty() {
        return (StatusCode::BAD_REQUEST, "Файл аватара обязателен").into_response();
    }
    let sniffed_mime = match sniff_image_mime(&file_data) {
        Some(mime) => mime,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                "Поддерживаются только PNG, JPEG, GIF и WEBP",
            )
                .into_response();
        }
    };
    if mime_type == "image/svg+xml" || !mime_type.starts_with("image/") {
        return (StatusCode::BAD_REQUEST, "Аватар должен быть изображением").into_response();
    }
    if !mime_type.starts_with(sniffed_mime) {
        mime_type = sniffed_mime.to_string();
    }
    if file_data.len() > 2 * 1024 * 1024 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "Аватар слишком большой (макс. 2 МБ)",
        )
            .into_response();
    }

    let updated_at = Utc::now();
    let write_result = write_asset_file(
        user_avatar_asset_dir(&state.data_dir, &username),
        "avatar",
        &mime_type,
        &file_data,
        Some(updated_at),
    )
    .await;
    if let Err(e) = write_result {
        error!("Ошибка записи файла аватара {}: {}", username, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match sqlx::query(
        "INSERT INTO avatars (username, mime_type, data, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET
            mime_type = excluded.mime_type,
            data = excluded.data,
            updated_at = excluded.updated_at",
    )
    .bind(&username)
    .bind(&mime_type)
    .bind(&file_data)
    .bind(updated_at)
    .execute(&state.db)
    .await
    {
        Ok(_) => {
            broadcast_avatar_event(&state, &username, false, Some(updated_at)).await;
            Json(serde_json::json!({
                "username": username,
                "updatedAt": updated_at.to_rfc3339(),
                "mimeType": mime_type
            }))
            .into_response()
        }
        Err(e) => {
            let _ =
                clear_asset_file(user_avatar_asset_dir(&state.data_dir, &username), "avatar").await;
            error!("Ошибка сохранения аватара {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn delete_avatar(
    AuthenticatedUser(username): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    let _ = clear_asset_file(user_avatar_asset_dir(&state.data_dir, &username), "avatar").await;

    match sqlx::query("DELETE FROM avatars WHERE username = ?")
        .bind(&username)
        .execute(&state.db)
        .await
    {
        Ok(_) => {
            broadcast_avatar_event(&state, &username, true, None).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            error!("Ошибка удаления аватара {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn sniff_image_mime(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 8 && data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if data.len() >= 3 && data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if data.len() >= 6 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) {
        return Some("image/gif");
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

async fn find_message_by_client_scope(
    state: &Arc<AppState>,
    client_id: &str,
    sender: &str,
    receiver: &str,
    server_id: Option<&str>,
    channel_id: Option<&str>,
) -> Result<Option<Message>, sqlx::Error> {
    if client_id.trim().is_empty() {
        return Ok(None);
    }

    sqlx::query_as::<_, Message>(
        "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
         FROM messages
         WHERE client_id = ?
           AND sender = ?
           AND receiver = ?
           AND COALESCE(server_id, '') = ?
           AND COALESCE(channel_id, '') = ?
         LIMIT 1",
    )
    .bind(client_id)
    .bind(sender)
    .bind(receiver)
    .bind(server_id.unwrap_or(""))
    .bind(channel_id.unwrap_or(""))
    .fetch_optional(&state.db)
    .await
}

async fn upload_message(
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    multipart: Multipart,
) -> impl IntoResponse {
    upload_message_with_context(auth_user, state, multipart, None, None).await
}

async fn upload_server_message(
    AxumPath((server_id, channel_id)): AxumPath<(String, String)>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    multipart: Multipart,
) -> impl IntoResponse {
    upload_message_with_context(
        auth_user,
        state,
        multipart,
        Some(server_id),
        Some(channel_id),
    )
    .await
}

async fn upload_message_with_context(
    auth_user: String,
    state: Arc<AppState>,
    mut multipart: Multipart,
    server_id_override: Option<String>,
    channel_id_override: Option<String>,
) -> impl IntoResponse {
    info!(
        "UPLOAD start auth_user={} server_override={:?} channel_override={:?}",
        auth_user,
        server_id_override.as_deref(),
        channel_id_override.as_deref()
    );
    let mut sender = String::new();
    let mut receiver = String::new();
    let mut server_id = String::new();
    let mut channel_id = String::new();
    let mut client_id = String::new();
    let mut key_version: Option<i64> = None;
    let id = Uuid::new_v4().to_string();
    let filename = format!("{}.zali", id);
    let path = state.uploads_dir.join(&filename);
    let temp_path = state.uploads_dir.join(format!("{}.tmp", filename));
    let timestamp = Utc::now();
    let mut file_bytes: u64 = 0;
    let mut file_magic = Vec::with_capacity(8);
    let mut wrote_file = false;

    // Parse multipart fields with proper error handling (no unwrap)
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_string();
                match name.as_str() {
                    "sender" => match field.text().await {
                        Ok(v) => sender = v,
                        Err(e) => {
                            error!("Ошибка чтения поля sender: {}", e);
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                    },
                    "receiver" => match field.text().await {
                        Ok(v) => receiver = v,
                        Err(e) => {
                            error!("Ошибка чтения поля receiver: {}", e);
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                    },
                    "server_id" => match field.text().await {
                        Ok(v) => server_id = v,
                        Err(e) => {
                            error!("Ошибка чтения поля server_id: {}", e);
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                    },
                    "channel_id" => match field.text().await {
                        Ok(v) => channel_id = v,
                        Err(e) => {
                            error!("Ошибка чтения поля channel_id: {}", e);
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                    },
                    "client_id" | "clientId" => match field.text().await {
                        Ok(v) => client_id = v,
                        Err(e) => {
                            error!("Ошибка чтения поля client_id: {}", e);
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                    },
                    "key_version" | "keyVersion" => match field.text().await {
                        Ok(v) => {
                            key_version = v.trim().parse::<i64>().ok().filter(|value| *value > 0);
                        }
                        Err(e) => {
                            error!("Ошибка чтения поля key_version: {}", e);
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                    },
                    "file" => {
                        let mut field = field;
                        let mut out = match fs::File::create(&temp_path).await {
                            Ok(file) => file,
                            Err(e) => {
                                error!(
                                    "Ошибка создания временного файла {}: {}",
                                    temp_path.display(),
                                    e
                                );
                                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                            }
                        };
                        loop {
                            match field.chunk().await {
                                Ok(Some(chunk)) => {
                                    if file_magic.len() < 8 {
                                        let need = 8 - file_magic.len();
                                        file_magic
                                            .extend_from_slice(&chunk[..chunk.len().min(need)]);
                                    }
                                    file_bytes = file_bytes.saturating_add(chunk.len() as u64);
                                    if let Err(e) = out.write_all(&chunk).await {
                                        error!(
                                            "Ошибка записи временного файла {}: {}",
                                            temp_path.display(),
                                            e
                                        );
                                        let _ = fs::remove_file(&temp_path).await;
                                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                                    }
                                }
                                Ok(None) => break,
                                Err(e) => {
                                    error!("Ошибка чтения файла: {}", e);
                                    let _ = fs::remove_file(&temp_path).await;
                                    return StatusCode::BAD_REQUEST.into_response();
                                }
                            }
                        }
                        if let Err(e) = out.flush().await {
                            error!(
                                "Ошибка flush временного файла {}: {}",
                                temp_path.display(),
                                e
                            );
                            let _ = fs::remove_file(&temp_path).await;
                            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                        }
                        wrote_file = true;
                    }
                    _ => {} // Ignore unknown fields
                }
            }
            Ok(None) => break, // End of multipart
            Err(e) => {
                error!("Ошибка парсинга multipart: {}", e);
                return StatusCode::BAD_REQUEST.into_response();
            }
        }
    }

    if let Some(server_id_override) = server_id_override {
        server_id = server_id_override;
    }
    if let Some(channel_id_override) = channel_id_override {
        channel_id = channel_id_override;
    }

    if sender.is_empty() || receiver.is_empty() || file_bytes == 0 {
        warn!(
            "UPLOAD rejected missing fields sender_empty={} receiver_empty={} file_bytes={}",
            sender.is_empty(),
            receiver.is_empty(),
            file_bytes
        );
        if wrote_file {
            let _ = fs::remove_file(&temp_path).await;
        }
        return (
            StatusCode::BAD_REQUEST,
            "Поля sender, receiver и file обязательны",
        )
            .into_response();
    }

    let client_id = client_id.trim().to_string();
    let key_version = key_version.unwrap_or(2);
    let request_sender = sender.trim().to_string();
    let sender = auth_user.clone();
    if !request_sender.is_empty() && request_sender != sender {
        warn!(
            "Имя отправителя из запроса отличается от auth_user: request_sender={} auth={}. Используем auth_user.",
            request_sender, sender
        );
    }

    let mut is_server_message = !server_id.trim().is_empty() || !channel_id.trim().is_empty();
    let mut server_id_opt = if is_server_message {
        Some(server_id.trim().to_string())
    } else {
        None
    };
    let mut channel_id_opt = if is_server_message {
        Some(channel_id.trim().to_string())
    } else {
        None
    };

    if is_server_message {
        let sid = server_id_opt.clone().unwrap_or_default();
        let cid = channel_id_opt.clone().unwrap_or_default();
        if sid.is_empty() || cid.is_empty() {
            warn!("UPLOAD rejected empty server/channel after override");
            return (
                StatusCode::BAD_REQUEST,
                "Для серверного сообщения нужны server_id и channel_id",
            )
                .into_response();
        }
        match get_server_access_context(&state.db, &sid, &auth_user).await {
            Ok(Some((_server, _role))) => {
                if !can_access_channel(&state.db, &sid, &cid, &auth_user, "send")
                    .await
                    .unwrap_or(false)
                {
                    let receiver_is_user = sqlx::query_scalar::<_, String>(
                        "SELECT username FROM users WHERE username = ? LIMIT 1",
                    )
                    .bind(&receiver)
                    .fetch_optional(&state.db)
                    .await;
                    match receiver_is_user {
                        Ok(Some(_)) => {
                            warn!(
                                "UPLOAD server context denied but receiver looks like DM sender={} receiver={} server={} channel={} reason=dm_fallback",
                                auth_user, receiver, sid, cid
                            );
                            is_server_message = false;
                            server_id_opt = None;
                            channel_id_opt = None;
                        }
                        Ok(None) => {
                            warn!(
                                "UPLOAD forbidden sender={} server={} channel={} reason=channel_send_denied",
                                auth_user, sid, cid
                            );
                            return (StatusCode::FORBIDDEN, "Нет прав на отправку в этом канале")
                                .into_response();
                        }
                        Err(e) => {
                            error!(
                                "Ошибка проверки fallback DM receiver={} server={} channel={}: {}",
                                receiver, sid, cid, e
                            );
                            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                        }
                    }
                }
            }
            Ok(None) => return (StatusCode::NOT_FOUND, "Сервер не найден").into_response(),
            Err(e) => {
                error!("Ошибка проверки сервера {}: {}", sid, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
        if is_server_message {
            let channel_exists = sqlx::query_scalar::<_, String>(
                "SELECT id FROM channels WHERE id = ? AND server_id = ? LIMIT 1",
            )
            .bind(&cid)
            .bind(&sid)
            .fetch_optional(&state.db)
            .await;
            match channel_exists {
                Ok(Some(_)) => {}
                Ok(None) => return (StatusCode::NOT_FOUND, "Канал не найден").into_response(),
                Err(e) => {
                    error!("Ошибка проверки канала {}/{}: {}", sid, cid, e);
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        }
    }

    if !is_server_message {
        let receiver_exists = sqlx::query_scalar::<_, String>(
            "SELECT username FROM users WHERE username = ? LIMIT 1",
        )
        .bind(&receiver)
        .fetch_optional(&state.db)
        .await;
        match receiver_exists {
            Ok(Some(_)) => {}
            Ok(None) => {
                warn!(
                    "UPLOAD rejected unknown receiver sender={} receiver={}",
                    sender, receiver
                );
                if wrote_file {
                    let _ = fs::remove_file(&temp_path).await;
                }
                return (StatusCode::NOT_FOUND, "Получатель не найден").into_response();
            }
            Err(e) => {
                error!("Ошибка проверки получателя {}: {}", receiver, e);
                if wrote_file {
                    let _ = fs::remove_file(&temp_path).await;
                }
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }

        if sender != receiver {
            if let Err(e) =
                sqlx::query("INSERT OR IGNORE INTO contacts (owner, contact) VALUES (?, ?)")
                    .bind(&sender)
                    .bind(&receiver)
                    .execute(&state.db)
                    .await
            {
                error!(
                    "Ошибка автодобавления контакта sender={} receiver={}: {}",
                    sender, receiver, e
                );
            }
            if let Err(e) =
                sqlx::query("INSERT OR IGNORE INTO contacts (owner, contact) VALUES (?, ?)")
                    .bind(&receiver)
                    .bind(&sender)
                    .execute(&state.db)
                    .await
            {
                error!(
                    "Ошибка автодобавления обратного контакта sender={} receiver={}: {}",
                    sender, receiver, e
                );
            }
        }
    }

    // Validate .zali magic header
    if file_magic.len() < 8 || file_magic.as_slice() != b"ZALIMSSG" {
        warn!("Получен файл с неверной сигнатурой от {}", sender);
        if wrote_file {
            let _ = fs::remove_file(&temp_path).await;
        }
        return (
            StatusCode::BAD_REQUEST,
            "Неверная сигнатура архива (ожидается ZALIMSSG)",
        )
            .into_response();
    }

    info!(
        "UPLOAD storing id={} client_id={} sender={} receiver={} file={} bytes={} server={:?} channel={:?} path={}",
        id,
        client_id,
        sender,
        receiver,
        filename,
        file_bytes,
        server_id_opt,
        channel_id_opt,
        path.display()
    );
    info!(
        "UPLOAD context id={} auth_user={} request_sender={} receiver={} client_id={} is_server_message={}",
        id,
        auth_user,
        request_sender,
        receiver,
        client_id,
        !server_id_opt.is_none() || !channel_id_opt.is_none()
    );

    let insert_result = sqlx::query(
        "INSERT OR IGNORE INTO messages (id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(if client_id.is_empty() { None::<&str> } else { Some(client_id.as_str()) })
    .bind(&sender)
    .bind(&receiver)
    .bind(&filename)
    .bind(timestamp)
    .bind(key_version)
    .bind(&server_id_opt)
    .bind(&channel_id_opt)
    .execute(&state.db)
    .await;

    match insert_result {
        Ok(result) => {
            if result.rows_affected() == 0 {
                if !client_id.is_empty() {
                    if let Ok(Some(existing)) = find_message_by_client_scope(
                        &state,
                        &client_id,
                        &sender,
                        &receiver,
                        server_id_opt.as_deref(),
                        channel_id_opt.as_deref(),
                    )
                    .await
                    {
                        info!(
                            "UPLOAD deduplicated after insert client_id={} existing_message_id={}",
                            client_id, existing.id
                        );
                        let dedup_msg = Message {
                            id: existing.id.clone(),
                            client_id: existing
                                .client_id
                                .clone()
                                .or_else(|| Some(client_id.clone())),
                            sender: sender.clone(),
                            receiver: receiver.clone(),
                            filename: existing.filename.clone(),
                            timestamp: existing.timestamp,
                            key_version: Some(key_version),
                            server_id: server_id_opt.clone(),
                            channel_id: channel_id_opt.clone(),
                        };
                        if dedup_msg.server_id.is_some() {
                            deliver_server_message(&state, &dedup_msg).await;
                        } else {
                            deliver_to_user(&state, &receiver, &dedup_msg).await;
                            if sender != receiver {
                                deliver_to_user(&state, &sender, &dedup_msg).await;
                            }
                        }
                        let _ = fs::remove_file(&temp_path).await;
                        return (
                            StatusCode::CREATED,
                            Json(serde_json::json!({ "id": existing.id, "clientId": client_id })),
                        )
                            .into_response();
                    }
                }
                let _ = fs::remove_file(&temp_path).await;
                return StatusCode::CREATED.into_response();
            }

            if let Err(e) = fs::rename(&temp_path, &path).await {
                error!(
                    "Ошибка атомарного перемещения файла {} -> {}: {}",
                    temp_path.display(),
                    path.display(),
                    e
                );
                let _ = fs::remove_file(&temp_path).await;
                let _ = sqlx::query("DELETE FROM messages WHERE id = ?")
                    .bind(&id)
                    .execute(&state.db)
                    .await;
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }

            info!(
                "UPLOAD DB insert result id={} client_id={} rows_affected={}",
                id,
                client_id,
                result.rows_affected()
            );

            info!(
                "Новое сообщение: {} → {} ({}){}",
                sender,
                receiver,
                filename,
                if let (Some(sid), Some(cid)) = (&server_id_opt, &channel_id_opt) {
                    format!(" [server={}/{}]", sid, cid)
                } else {
                    String::new()
                }
            );

            let msg = Message {
                id: id.clone(),
                client_id: if client_id.is_empty() {
                    None
                } else {
                    Some(client_id.clone())
                },
                sender: sender.clone(),
                receiver: receiver.clone(),
                filename,
                timestamp,
                key_version: Some(key_version),
                server_id: server_id_opt.clone(),
                channel_id: channel_id_opt.clone(),
            };

            if msg.server_id.is_some() {
                info!("UPLOAD delivering server message id={}", msg.id);
                deliver_server_message(&state, &msg).await;
            } else {
                info!(
                    "UPLOAD delivering dm id={} to receiver={} sender={}",
                    msg.id, receiver, sender
                );
                deliver_to_user(&state, &receiver, &msg).await;
                if sender != receiver {
                    info!(
                        "UPLOAD delivering dm echo id={} to sender={}",
                        msg.id, sender
                    );
                    deliver_to_user(&state, &sender, &msg).await;
                }
            }

            info!(
                "UPLOAD complete id={} client_id={} message_id={} sender={} receiver={} server={:?} channel={:?}",
                id,
                client_id,
                msg.id,
                sender,
                receiver,
                msg.server_id,
                msg.channel_id
            );
            (
                StatusCode::CREATED,
                Json(serde_json::json!({ "id": msg.id, "clientId": msg.client_id })),
            )
                .into_response()
        }
        Err(e) => {
            let _ = fs::remove_file(&path).await;
            error!("Ошибка сохранения сообщения в БД: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn download_upload_file(
    AxumPath(filename): AxumPath<String>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    info!("UPLOAD download start file={} auth={}", filename, auth_user);
    match sqlx::query_as::<_, Message>(
        "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
         FROM messages
         WHERE filename = ?
         LIMIT 1",
    )
    .bind(&filename)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(message)) => {
            let allowed = can_access_message(&state, &message, &auth_user)
                .await
                .unwrap_or(false);
            if !allowed {
                warn!(
                    "Несанкционированный доступ к uploads: {} пытается получить файл {}",
                    auth_user, filename
                );
                return StatusCode::FORBIDDEN.into_response();
            }

            let conversation_scope = if let Some(server_id) = message.server_id.as_deref() {
                let channel_id = message.channel_id.as_deref().unwrap_or("");
                server_conversation_scope(server_id, channel_id)
            } else {
                dm_conversation_scope(&message.sender, &message.receiver)
            };
            let page = MessagePageQuery {
                limit: None,
                offset: None,
                since: None,
            };
            let history_access = match resolve_history_access(
                &state.db,
                &auth_user,
                &page,
                &headers,
                Some(&conversation_scope),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if !history_access_matches(message.timestamp, &history_access) {
                return StatusCode::FORBIDDEN.into_response();
            }

            let path = state.uploads_dir.join(&message.filename);
            match fs::File::open(&path).await {
                Ok(file) => (
                    [
                        (
                            axum::http::header::CONTENT_TYPE,
                            HeaderValue::from_static("application/octet-stream"),
                        ),
                        (
                            axum::http::header::CONTENT_DISPOSITION,
                            HeaderValue::from_str(&format!(
                                "attachment; filename=\"{}\"",
                                message.filename
                            ))
                            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
                        ),
                    ],
                    Body::from_stream(ReaderStream::new(file)),
                )
                    .into_response(),
                Err(e) => {
                    error!("Файл не найден на диске {}: {}", path.display(), e);
                    StatusCode::NOT_FOUND.into_response()
                }
            }
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска файла {} в БД: {}", filename, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn deliver_to_user(state: &Arc<AppState>, username: &str, msg: &Message) {
    let active = state
        .user_connections
        .get(username)
        .map(|conns| conns.len())
        .unwrap_or(0);
    info!(
        "WS deliver_to_user start username={} message_id={} active_conns={}",
        username, msg.id, active
    );
    let payload = match serde_json::to_string(msg) {
        Ok(json) => json,
        Err(e) => {
            error!("Ошибка сериализации сообщения {}: {}", msg.id, e);
            return;
        }
    };
    let sent = send_payload_to_user(state, username, payload, "deliver_to_user").await;
    if sent > 0 {
        info!(
            "WS deliver_to_user done username={} message_id={} sent_conns={}",
            username, msg.id, sent
        );
    } else {
        info!(
            "WS deliver_to_user skipped username={} message_id={} reason=no_connections",
            username, msg.id
        );
    }
}

fn role_permissions_for_view(
    action: &str,
    can_view: bool,
    can_send: bool,
    can_manage: bool,
) -> bool {
    match action {
        "view" => can_view,
        "send" => can_send,
        "manage" => can_manage,
        _ => false,
    }
}

fn fallback_role_permissions(role_id: &str) -> (bool, bool, bool) {
    match role_id {
        "owner" | "admin" => (true, true, true),
        "member" => (true, true, false),
        _ => (true, true, false),
    }
}

async fn resolve_server_message_viewers(
    state: &Arc<AppState>,
    server: &ServerRecord,
    channel_id: &str,
    viewers: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if viewers.is_empty() {
        return Ok(Vec::new());
    }

    let channel_permissions = load_channel_permissions(&state.db, channel_id).await?;
    let channel_perm_map: HashMap<String, (bool, bool, bool)> = channel_permissions
        .into_iter()
        .map(|perm| (perm.role, (perm.canView, perm.canSend, perm.canManage)))
        .collect();

    let mut role_rows = sqlx::query(
        "SELECT role_id, can_view, can_send, can_manage
         FROM server_roles
         WHERE server_id = ?",
    )
    .bind(&server.id)
    .fetch_all(&state.db)
    .await?;
    let role_perm_map: HashMap<String, (bool, bool, bool)> = role_rows
        .drain(..)
        .map(|row| {
            let role_id: String = row.get("role_id");
            let can_view: i64 = row.get("can_view");
            let can_send: i64 = row.get("can_send");
            let can_manage: i64 = row.get("can_manage");
            (role_id, (can_view != 0, can_send != 0, can_manage != 0))
        })
        .collect();

    let mut member_roles = HashMap::new();
    let mut builder =
        QueryBuilder::<Sqlite>::new("SELECT username, role FROM server_members WHERE server_id = ");
    builder.push_bind(&server.id);
    builder.push(" AND username IN (");
    let mut separated = builder.separated(", ");
    for viewer in viewers {
        separated.push_bind(viewer);
    }
    separated.push_unseparated(")");
    let rows = builder.build().fetch_all(&state.db).await?;
    for row in rows {
        let username: String = row.get("username");
        let role: String = row.get("role");
        member_roles.insert(username, role);
    }

    let mut allowed = Vec::with_capacity(viewers.len());
    for viewer in viewers {
        if viewer == &server.owner {
            allowed.push(viewer.clone());
            continue;
        }

        let Some(role_id) = member_roles.get(viewer) else {
            if server.is_public != 0 {
                allowed.push(viewer.clone());
            }
            continue;
        };

        let perms = channel_perm_map
            .get(role_id)
            .copied()
            .or_else(|| role_perm_map.get(role_id).copied())
            .unwrap_or_else(|| fallback_role_permissions(role_id));

        if role_permissions_for_view("view", perms.0, perms.1, perms.2) {
            allowed.push(viewer.clone());
        }
    }

    Ok(allowed)
}

async fn deliver_server_message(state: &Arc<AppState>, msg: &Message) {
    let payload = match serde_json::to_string(msg) {
        Ok(json) => json,
        Err(e) => {
            error!("Ошибка сериализации серверного сообщения {}: {}", msg.id, e);
            return;
        }
    };

    let Some(server_id) = msg.server_id.as_deref() else {
        return;
    };
    let Some(channel_id) = msg.channel_id.as_deref() else {
        return;
    };

    let viewers: Vec<String> = state
        .user_connections
        .iter()
        .map(|entry| entry.key().clone())
        .collect();
    info!(
        "WS deliver_server_message start message_id={} server={} channel={} viewers={}",
        msg.id,
        server_id,
        channel_id,
        viewers.len()
    );

    let server = match get_server_accessibility(&state.db, server_id).await {
        Ok(Some(server)) => server,
        Ok(None) => return,
        Err(e) => {
            error!(
                "Ошибка проверки доступа к серверу {} перед доставкой сообщения {}: {}",
                server_id, msg.id, e
            );
            return;
        }
    };

    let allowed_viewers =
        match resolve_server_message_viewers(state, &server, channel_id, &viewers).await {
            Ok(list) => list,
            Err(e) => {
                error!(
                    "Ошибка предварительного расчёта зрителей для сообщения {} в {}/{}: {}",
                    msg.id, server_id, channel_id, e
                );
                return;
            }
        };

    for viewer in allowed_viewers {
        let sent =
            send_payload_to_user(state, &viewer, payload.clone(), "deliver_server_message").await;
        if sent > 0 {
            info!(
                "WS deliver_server_message sent viewer={} message_id={} conns={}",
                viewer, msg.id, sent
            );
        }
    }
}

async fn can_access_message(
    state: &Arc<AppState>,
    msg: &Message,
    user: &str,
) -> Result<bool, sqlx::Error> {
    if msg.server_id.is_none() {
        return Ok(msg.sender == user || msg.receiver == user);
    }

    if let Some(server_id) = msg.server_id.as_deref() {
        if let Some((server, _role)) = get_server_access_context(&state.db, server_id, user).await?
        {
            if server.owner == user || msg.sender == user {
                return Ok(true);
            }
            if let Some(channel_id) = msg.channel_id.as_deref() {
                return can_access_channel(&state.db, server_id, channel_id, user, "view").await;
            }
            return Ok(server.is_public != 0);
        }
    }

    Ok(false)
}

async fn can_delete_message(
    state: &Arc<AppState>,
    msg: &Message,
    user: &str,
) -> Result<bool, sqlx::Error> {
    if msg.sender == user {
        return Ok(true);
    }

    if let Some(server_id) = msg.server_id.as_deref() {
        if let Some(server) = get_server_accessibility(&state.db, server_id).await? {
            if server.owner == user {
                return Ok(true);
            }
            let role = get_server_member_role(&state.db, server_id, user).await?;
            if can_manage_by_role(role.as_deref()) {
                return Ok(true);
            }
            if let Some(channel_id) = msg.channel_id.as_deref() {
                return can_access_channel(&state.db, server_id, channel_id, user, "manage").await;
            }
        }
    }

    Ok(false)
}

async fn download_message(
    AxumPath(id): AxumPath<String>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    info!("DOWNLOAD start id={} auth={}", id, auth_user);
    match sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
    {
        Ok(m) => {
            info!(
                "DOWNLOAD found id={} sender={} receiver={} filename={} server_id={:?} channel_id={:?}",
                m.id,
                m.sender,
                m.receiver,
                m.filename,
                m.server_id,
                m.channel_id
            );
            let allowed = can_access_message(&state, &m, &auth_user)
                .await
                .unwrap_or(false);
            if !allowed {
                warn!(
                    "Несанкционированное скачивание: {} пытается получить сообщение {}",
                    auth_user, id
                );
                return StatusCode::FORBIDDEN.into_response();
            }

            let conversation_scope = if let Some(server_id) = m.server_id.as_deref() {
                let channel_id = m.channel_id.as_deref().unwrap_or("");
                server_conversation_scope(server_id, channel_id)
            } else {
                dm_conversation_scope(&m.sender, &m.receiver)
            };
            let page = MessagePageQuery {
                limit: None,
                offset: None,
                since: None,
            };
            let history_access = match resolve_history_access(
                &state.db,
                &auth_user,
                &page,
                &headers,
                Some(&conversation_scope),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if !history_access_matches(m.timestamp, &history_access) {
                return StatusCode::FORBIDDEN.into_response();
            }

            let path = state.uploads_dir.join(&m.filename);
            match fs::File::open(&path).await {
                Ok(file) => (
                    [
                        (
                            axum::http::header::CONTENT_TYPE,
                            HeaderValue::from_static("application/octet-stream"),
                        ),
                        (
                            axum::http::header::CONTENT_DISPOSITION,
                            HeaderValue::from_str(&format!(
                                "attachment; filename=\"{}\"",
                                m.filename
                            ))
                            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
                        ),
                    ],
                    Body::from_stream(ReaderStream::new(file)),
                )
                    .into_response(),
                Err(e) => {
                    error!("Файл не найден на диске {}: {}", path.display(), e);
                    StatusCode::NOT_FOUND.into_response()
                }
            }
        }
        Err(e) => {
            warn!("DOWNLOAD not found id={} err={}", id, e);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

async fn delete_message(
    AxumPath(id): AxumPath<String>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    info!("DELETE_MESSAGE start id={} auth={}", id, auth_user);
    match sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
    {
        Ok(m) => {
            let allowed = can_delete_message(&state, &m, &auth_user)
                .await
                .unwrap_or(false);
            if !allowed {
                warn!("DELETE_MESSAGE forbidden id={} auth={}", id, auth_user);
                return StatusCode::FORBIDDEN.into_response();
            }

            let path = state.uploads_dir.join(&m.filename);
            info!(
                "DELETE_MESSAGE removing id={} path={} sender={} receiver={}",
                id,
                path.display(),
                m.sender,
                m.receiver
            );

            let mut tx = match state.db.begin().await {
                Ok(tx) => tx,
                Err(e) => {
                    error!("Ошибка начала транзакции удаления сообщения {}: {}", id, e);
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };

            if let Err(e) = sqlx::query("DELETE FROM reactions WHERE message_id = ?")
                .bind(&id)
                .execute(&mut *tx)
                .await
            {
                let _ = tx.rollback().await;
                error!("Ошибка удаления реакций сообщения {}: {}", id, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }

            if let Err(e) = sqlx::query("DELETE FROM messages WHERE id = ?")
                .bind(&id)
                .execute(&mut *tx)
                .await
            {
                let _ = tx.rollback().await;
                error!("Ошибка удаления сообщения {}: {}", id, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }

            if let Err(e) = tx.commit().await {
                error!("Ошибка фиксации удаления сообщения {}: {}", id, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }

            fs::remove_file(&path).await.ok();
            info!("Сообщение удалено: {} (автор: {})", id, auth_user);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            warn!("DELETE_MESSAGE not found id={} err={}", id, e);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    AuthenticatedUser(username): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    info!(
        "WS upgrade accepted username={} active_ws={} voice_rooms={}",
        username,
        state.user_connections.len(),
        state.voice_rooms.len()
    );
    ws.on_upgrade(move |socket| handle_socket(socket, state, username))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, username: String) {
    let capacity = state.config.ws_channel_capacity;
    let (tx, mut rx) = mpsc::channel::<String>(capacity);

    state
        .user_connections
        .entry(username.clone())
        .or_default()
        .push(tx.clone());

    info!(
        "[WS] '{}' подключился (voice_rooms={}, active_ws={})",
        username,
        state.voice_rooms.len(),
        state.user_connections.len()
    );

    send_voice_room_snapshot_to_user(&state, &username).await;

    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                trace!("WS outbound username={} bytes={}", username, msg.len());
                if socket.send(WsMessage::Text(msg)).await.is_err() {
                    warn!("WS outbound send failed username={}", username);
                    break;
                }
            }
            result = socket.recv() => {
                match result {
                    Some(Ok(WsMessage::Text(text))) => {
                        trace!("WS inbound username={} text_bytes={}", username, text.len());
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(event_type) = value["type"].as_str() {
                                if event_type.starts_with("voice_") {
                                    info!(
                                        "[VOICE][WS-IN] user={} type={} roomId={} roomType={} to={} target={} inviter={} participants={}",
                                        username,
                                        event_type,
                                        value["roomId"].as_str().unwrap_or_default(),
                                        value["roomType"].as_str().unwrap_or_default(),
                                        value["to"].as_str().unwrap_or_default(),
                                        value["target"].as_str().unwrap_or_default(),
                                        value["inviter"].as_str().unwrap_or_default(),
                                        value["participants"]
                                            .as_array()
                                            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(","))
                                            .unwrap_or_default(),
                                    );
                                    handle_voice_event(&state, &username, &value).await;
                                } else if event_type == "ping" {
                                    let pong = serde_json::json!({
                                        "type": "pong",
                                        "ts": Utc::now().timestamp_millis(),
                                    });
                                    if socket.send(WsMessage::Text(pong.to_string())).await.is_err() {
                                        warn!("WS pong send failed username={}", username);
                                        break;
                                    }
                                } else {
                                    trace!("WS inbound non-voice event username={} type={}", username, event_type);
                                }
                            }
                        } else {
                            warn!("WS inbound invalid JSON username={}", username);
                        }
                    }
                    Some(Ok(WsMessage::Binary(data))) => {
                        warn!("WS inbound binary frame username={} bytes={}", username, data.len());
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        trace!("WS ping username={} bytes={}", username, data.len());
                        let _ = socket.send(WsMessage::Pong(data)).await;
                    }
                    Some(Ok(WsMessage::Pong(_))) => {
                        trace!("WS pong username={}", username);
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        info!("WS close received username={}", username);
                        break;
                    }
                    Some(Err(e)) => {
                        warn!("WS recv error username={} err={}", username, e);
                        break;
                    }
                }
            }
        }
    }

    // Clean up closed senders
    if let Some(mut conns) = state.user_connections.get_mut(&username) {
        conns.retain(|c| !c.same_channel(&tx) && !c.is_closed());
    }
    state.user_connections.retain(|_, conns| !conns.is_empty());

    let has_active_connections = state
        .user_connections
        .get(&username)
        .map(|conns| !conns.is_empty())
        .unwrap_or(false);

    info!(
        "[WS] '{}' отключился (active_ws={}, voice_room={:?})",
        username,
        if has_active_connections { 1 } else { 0 },
        state
            .user_voice_rooms
            .get(&username)
            .map(|v| v.value().clone())
    );

    if !has_active_connections {
        let state_for_cleanup = state.clone();
        let username_for_cleanup = username.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(12)).await;
            let still_connected = state_for_cleanup
                .user_connections
                .get(&username_for_cleanup)
                .map(|conns| !conns.is_empty())
                .unwrap_or(false);
            if still_connected {
                info!(
                    "[VOICE] '{}' reconnect before delayed cleanup, skip leave",
                    username_for_cleanup
                );
                return;
            }
            info!(
                "[VOICE] delayed cleanup for '{}' after ws close",
                username_for_cleanup
            );
            leave_voice_room(&state_for_cleanup, &username_for_cleanup).await;
        });
    }
}
