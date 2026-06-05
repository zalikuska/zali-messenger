use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Multipart, Path as AxumPath, Query,
    },
    http::{header, HeaderValue, Method, StatusCode},
    response::IntoResponse,
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
use tokio::{fs, sync::mpsc, task};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{error, info, trace, warn};
use uuid::Uuid;

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
                "https://msgs.zalikus.org,http://localhost:3000,http://localhost,http://127.0.0.1:3000,http://127.0.0.1,zali://localhost,null"
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
            .unwrap_or_else(|_| cfg!(debug_assertions));

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
            .unwrap_or(64);

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

    let migrate_queries = [
        "INSERT OR IGNORE INTO users (username, password_hash)
         SELECT username, password_hash FROM legacy.users",
        "INSERT OR IGNORE INTO contacts (owner, contact, created_at)
         SELECT owner, contact, created_at FROM legacy.contacts",
        "INSERT OR IGNORE INTO avatars (username, mime_type, data, updated_at)
         SELECT username, mime_type, data, updated_at FROM legacy.avatars",
        "INSERT OR IGNORE INTO servers (id, name, description, icon, color, join_link, owner, is_public, created_at, avatar_mime, avatar_data, banner_mime, banner_data)
         SELECT id, name, description, icon, color, join_link, owner, is_public, created_at, avatar_mime, avatar_data, banner_mime, banner_data FROM legacy.servers",
        "INSERT OR IGNORE INTO server_members (server_id, username, role, joined_at)
         SELECT server_id, username, role, joined_at FROM legacy.server_members",
        "INSERT OR IGNORE INTO server_roles (server_id, role_id, name, color, can_view, can_send, can_manage, position, updated_at, created_at)
         SELECT server_id, role_id, name, color, can_view, can_send, can_manage, position, updated_at, created_at FROM legacy.server_roles",
        "INSERT OR IGNORE INTO channels (id, server_id, name, topic, kind, position, created_at)
         SELECT id, server_id, name, topic, kind, position, created_at FROM legacy.channels",
        "INSERT OR IGNORE INTO channel_permissions (channel_id, role, can_view, can_send, can_manage, updated_at)
         SELECT channel_id, role, can_view, can_send, can_manage, updated_at FROM legacy.channel_permissions",
        "INSERT OR IGNORE INTO server_invites (code, server_id, created_by, max_uses, uses, expires_at, created_at)
         SELECT code, server_id, created_by, max_uses, uses, expires_at, created_at FROM legacy.server_invites",
        "INSERT OR IGNORE INTO reactions (message_id, reactor, emoji, updated_at)
         SELECT message_id, reactor, emoji, updated_at FROM legacy.reactions",
        "INSERT OR IGNORE INTO messages (id, client_id, sender, receiver, filename, timestamp, server_id, channel_id)
         SELECT id, NULL, sender, receiver, filename, timestamp, server_id, channel_id FROM legacy.messages",
    ];

    for query in migrate_queries {
        if let Err(e) = sqlx::query(query).execute(&mut *conn).await {
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
        // 1. Try Authorization: Bearer <token> header
        if let Some(auth_header) = parts.headers.get("Authorization") {
            if let Ok(auth_str) = auth_header.to_str() {
                if let Some(token) = auth_str.strip_prefix("Bearer ") {
                    if let Ok(token_data) = decode::<Claims>(
                        token,
                        &DecodingKey::from_secret(&state.config.jwt_secret),
                        &Validation::new(Algorithm::HS256),
                    ) {
                        return Ok(AuthenticatedUser(token_data.claims.sub));
                    } else {
                        warn!("Получен невалидный JWT-токен");
                        return Err((StatusCode::UNAUTHORIZED, "Invalid or expired token"));
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
                    if let Ok(token_data) = decode::<Claims>(
                        token,
                        &DecodingKey::from_secret(&state.config.jwt_secret),
                        &Validation::new(Algorithm::HS256),
                    ) {
                        return Ok(AuthenticatedUser(token_data.claims.sub));
                    } else {
                        warn!("Получен невалидный JWT-cookie");
                        return Err((StatusCode::UNAUTHORIZED, "Invalid or expired token"));
                    }
                }
            }
        }

        if let Some(query) = parts.uri.query() {
            for pair in query.split('&') {
                if let Some((key, value)) = pair.split_once('=') {
                    if matches!(key, "token" | "auth" | "access_token") && !value.trim().is_empty()
                    {
                        if let Ok(token_data) = decode::<Claims>(
                            value,
                            &DecodingKey::from_secret(&state.config.jwt_secret),
                            &Validation::new(Algorithm::HS256),
                        ) {
                            return Ok(AuthenticatedUser(token_data.claims.sub));
                        } else {
                            warn!("Получен невалидный JWT-token из query");
                            return Err((StatusCode::UNAUTHORIZED, "Invalid or expired token"));
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

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct ConversationKeyRequest {
    peer: Option<String>,
    serverId: Option<String>,
    channelId: Option<String>,
    key: Option<String>,
    keyVersion: Option<i64>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
struct ConversationKeyResponse {
    scopeKey: String,
    key: String,
    keyVersion: i64,
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
    participants: HashSet<String>,
}

impl VoiceRoom {
    fn new(room_type: String, server_id: Option<String>, channel_id: Option<String>) -> Self {
        Self {
            room_type,
            server_id,
            channel_id,
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
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredAssetMeta {
    mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at: Option<DateTime<Utc>>,
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
        login_attempts: DashMap::new(),
        config,
    });

    info!(
        "Серверное хранилище активировано: data_dir={}, uploads_dir={}",
        state.data_dir.display(),
        state.uploads_dir.display()
    );

    let app = Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/me", get(me))
        .route("/api/users", get(get_users))
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
        .route("/api/conversation-key", post(resolve_conversation_key))
        .route("/api/messages/:user", get(get_messages))
        .route("/api/message/:id/reaction", post(set_message_reaction))
        .route("/api/upload", post(upload_message))
        .route("/api/download/:id", get(download_message))
        .route("/api/message/:id", axum::routing::delete(delete_message))
        .route("/ws", get(ws_handler))
        .route("/health", get(health_check))
        .route("/uploads/:filename", get(download_upload_file))
        .layer(DefaultBodyLimit::max(max_upload))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    info!("🚀 Zali Server запущен на http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app)
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

fn conversation_scope_key(
    auth_user: &str,
    peer: Option<&str>,
    server_id: Option<&str>,
    channel_id: Option<&str>,
) -> Option<String> {
    let sid = server_id.unwrap_or("").trim();
    let cid = channel_id.unwrap_or("").trim();
    if !sid.is_empty() && !cid.is_empty() {
        return Some(format!("server:{}:{}", sid, cid));
    }

    let peer = peer.unwrap_or("").trim();
    if peer.is_empty() || auth_user.trim().is_empty() {
        return None;
    }
    let mut pair = vec![auth_user.trim().to_string(), peer.to_string()];
    pair.sort();
    Some(format!("dm:{}:{}", pair.join(":"), "v2"))
}

fn random_conversation_key() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut bytes = [0u8; 32];
    let mut rng = rand::thread_rng();
    use rand::RngCore as _;
    rng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
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
    let (can_view, can_send, can_manage) =
        load_server_role_permissions(pool, server_id, role_key).await?;
    Ok(match action {
        "view" => can_view,
        "send" => can_send,
        "manage" => can_manage,
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

async fn me(AuthenticatedUser(username): AuthenticatedUser) -> impl IntoResponse {
    Json(serde_json::json!({ "username": username })).into_response()
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
            Ok(Err(_)) | Err(_) => failed = true,
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
        "serverId": room.server_id,
        "channelId": room.channel_id,
        "participants": participants,
    })
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

    let participants = state
        .voice_rooms
        .get(&room_id)
        .map(|room| room.participants.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();

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
                if let (Some(sid), Some(cid)) = (server_id.as_deref(), channel_id.as_deref()) {
                    if !can_access_channel(&state.db, sid, cid, sender, "view")
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
            info!(
                "[VOICE][INVITE] from={} to={} roomId={}",
                sender, target, room_key
            );
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
            info!(
                "[VOICE] '{}' accepted call room={} inviter={}",
                sender, room_id, inviter
            );

            {
                let mut room = state
                    .voice_rooms
                    .entry(room_id.clone())
                    .or_insert_with(|| VoiceRoom::new("dm".to_string(), None, None));
                let room = room.value_mut();
                room.room_type = "dm".to_string();
                room.server_id = None;
                room.channel_id = None;
                room.participants.clear();
                room.participants.insert(sender.to_string());
                room.participants.insert(inviter.to_string());
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
            info!(
                "[VOICE][REJECT] from={} to={} roomId={}",
                sender, inviter, room_id
            );
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
            info!(
                "[VOICE][CANCEL] from={} to={} roomId={}",
                sender, target, room_id
            );
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
    jwt_secret: &[u8],
) -> Result<AuthResponse, jsonwebtoken::errors::Error> {
    let exp = Utc::now()
        .checked_add_signed(chrono::Duration::days(7))
        .expect("valid timestamp")
        .timestamp() as usize;

    let claims = Claims {
        sub: username.clone(),
        exp,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret),
    )?;

    Ok(AuthResponse { token, username })
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
    Json(payload): Json<AuthPayload>,
) -> impl IntoResponse {
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

    if payload.username.len() > 64 {
        warn!(
            "Регистрация отклонена: username '{}' слишком длинный ({} символов)",
            payload.username,
            payload.username.len()
        );
        return (
            StatusCode::BAD_REQUEST,
            "Логин слишком длинный (максимум 64 символа)",
        )
            .into_response();
    }

    if payload.password.len() < 6 {
        warn!(
            "Регистрация отклонена: username '{}' использует слишком короткий пароль ({} символов)",
            payload.username,
            payload.password.len()
        );
        return (
            StatusCode::BAD_REQUEST,
            "Пароль должен быть не менее 6 символов",
        )
            .into_response();
    }

    info!(
        "Хэширование пароля для нового пользователя '{}'",
        payload.username
    );
    let hashed = match hash_password(payload.password.clone()).await {
        Ok(h) => h,
        Err(e) => {
            error!("Ошибка хэширования пароля: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    match sqlx::query("INSERT INTO users (username, password_hash) VALUES (?, ?)")
        .bind(&payload.username)
        .bind(&hashed)
        .execute(&state.db)
        .await
    {
        Ok(_) => {
            info!(
                "Регистрация успешно завершена для пользователя '{}'",
                payload.username
            );
            match issue_auth_response(payload.username.clone(), &state.config.jwt_secret) {
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
                payload.username,
                e
            );
            (StatusCode::CONFLICT, "Пользователь уже существует").into_response()
        }
    }
}

async fn login(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    Json(payload): Json<AuthPayload>,
) -> impl IntoResponse {
    // --- Rate limiting ---
    let rate_key = payload.username.to_lowercase();
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
        if attempts.is_empty() {
            drop(attempts);
            state.login_attempts.remove(&rate_key);
            state
                .login_attempts
                .entry(rate_key.clone())
                .or_default()
                .push_back(now);
        } else {
            attempts.push_back(now);
        }
    }

    let row = sqlx::query("SELECT username, password_hash FROM users WHERE username = ?")
        .bind(&payload.username)
        .fetch_one(&state.db)
        .await;

    match row {
        Ok(r) => {
            let username: String = r.get("username");
            let hash: String = r.get("password_hash");

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

            match issue_auth_response(username.clone(), &state.config.jwt_secret) {
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
        Err(_) => (StatusCode::UNAUTHORIZED, "Неверный логин или пароль").into_response(),
    }
}

async fn get_users(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    _auth: AuthenticatedUser,
) -> impl IntoResponse {
    info!("API get_users start");
    match sqlx::query_scalar::<_, String>("SELECT username FROM users ORDER BY username")
        .fetch_all(&state.db)
        .await
    {
        Ok(users) => {
            info!("API get_users count={}", users.len());
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
    match sqlx::query_scalar::<_, String>(
        "SELECT contact FROM contacts WHERE owner = ? ORDER BY contact ASC",
    )
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(contacts) => {
            info!(
                "API get_contacts owner={} count={} contacts={}",
                owner,
                contacts.len(),
                contacts.join(",")
            );
            Json(ContactListResponse { contacts }).into_response()
        }
        Err(e) => {
            error!("Ошибка получения контактов для {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
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

    let server_id = Uuid::new_v4().to_string();
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
        warn!("Попытка создать канал в приватном сервере {}", server_id);
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
        error!("Ошибка удаления реакций канала {}/{}: {}", server_id, channel_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM messages WHERE server_id = ? AND channel_id = ?")
        .bind(&server_id)
        .bind(&channel_id)
        .execute(&mut *tx)
        .await
    {
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
    if let Err(e) = ensure_server_member(&state.db, &server_id, username, &role).await {
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
    if let Err(e) = ensure_server_member(&state.db, &server_id, target, &role).await {
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

    for filename in &filenames {
        let path = state.uploads_dir.join(filename);
        let _ = fs::remove_file(&path).await;
    }

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
        error!("Ошибка удаления реакций сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM messages WHERE server_id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        error!("Ошибка удаления сообщений сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM server_members WHERE server_id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        error!("Ошибка удаления участников сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM channels WHERE server_id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        error!("Ошибка удаления каналов сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(e) = sqlx::query("DELETE FROM servers WHERE id = ?")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        error!("Ошибка удаления сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Err(e) = tx.commit().await {
        error!("Ошибка фиксации удаления сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
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

    let invite = match sqlx::query_as::<_, ServerInviteRecord>(
        "SELECT code, server_id, created_by, max_uses, uses, expires_at, created_at
         FROM server_invites WHERE code = ? LIMIT 1",
    )
    .bind(code)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(invite)) => invite,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка поиска инвайта {}: {}", code, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Some(expires_at) = invite.expires_at {
        if expires_at < Utc::now() {
            return (StatusCode::GONE, "Срок действия инвайта истёк").into_response();
        }
    }
    if invite.max_uses > 0 && invite.uses >= invite.max_uses {
        return (StatusCode::GONE, "Инвайт уже использован").into_response();
    }

    if let Err(e) = ensure_server_member(&state.db, &invite.server_id, &auth_user, "member").await {
        error!(
            "Ошибка добавления пользователя {} по инвайту {}: {}",
            auth_user, code, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Err(e) = sqlx::query("UPDATE server_invites SET uses = uses + 1 WHERE code = ?")
        .bind(code)
        .execute(&state.db)
        .await
    {
        error!("Ошибка увеличения использования инвайта {}: {}", code, e);
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

    let normalized = raw
        .strip_prefix("zali://server/")
        .or_else(|| raw.strip_prefix("server/"))
        .unwrap_or(raw)
        .trim()
        .to_string();

    let server = match sqlx::query_as::<_, ServerRecord>(
        "SELECT id, name, description, icon, color, join_link, owner, is_public, created_at
         FROM servers
         WHERE join_link = ? OR id = ? LIMIT 1",
    )
    .bind(raw)
    .bind(&normalized)
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

    let limit = page.limit.unwrap_or(0).clamp(0, 500) as i64;
    let offset = page.offset.unwrap_or(0).max(0) as i64;
    let query = if limit > 0 {
        sqlx::query_as::<_, Message>(
            "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
             FROM messages
             WHERE server_id = ? AND channel_id = ?
             ORDER BY timestamp ASC, id ASC
             LIMIT ? OFFSET ?",
        )
        .bind(&server_id)
        .bind(&channel_id)
        .bind(limit)
        .bind(offset)
    } else {
        sqlx::query_as::<_, Message>(
            "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
             FROM messages
             WHERE server_id = ? AND channel_id = ?
             ORDER BY timestamp ASC, id ASC",
        )
        .bind(&server_id)
        .bind(&channel_id)
    };
    match query.fetch_all(&state.db).await {
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
) -> impl IntoResponse {
    info!("API get_messages start user={} auth={}", user, auth_user);
    let effective_user = auth_user.clone();
    if user != effective_user {
        warn!(
            "Несовпадение username в пути и токене: path={} auth={}. Используем auth_user.",
            user, effective_user
        );
    }

    let limit = page.limit.unwrap_or(0).clamp(0, 500) as i64;
    let offset = page.offset.unwrap_or(0).max(0) as i64;
    let query = if limit > 0 {
        sqlx::query_as::<_, Message>(
            "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
             FROM messages
             WHERE server_id IS NULL AND (receiver = ? OR sender = ?)
             ORDER BY timestamp ASC, id ASC
             LIMIT ? OFFSET ?",
        )
        .bind(&effective_user)
        .bind(&effective_user)
        .bind(limit)
        .bind(offset)
    } else {
        sqlx::query_as::<_, Message>(
            "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
             FROM messages
             WHERE server_id IS NULL AND (receiver = ? OR sender = ?)
             ORDER BY timestamp ASC, id ASC",
        )
        .bind(&effective_user)
        .bind(&effective_user)
    };
    match query.fetch_all(&state.db).await {
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
                    match field.bytes().await {
                        Ok(bytes) => file_data = bytes.to_vec(),
                        Err(e) => {
                            error!("Ошибка чтения файла аватара: {}", e);
                            return StatusCode::BAD_REQUEST.into_response();
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
    if !mime_type.starts_with("image/") {
        return (StatusCode::BAD_REQUEST, "Аватар должен быть изображением").into_response();
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
    let mut file_data: Vec<u8> = Vec::new();

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
                    "file" => match field.bytes().await {
                        Ok(b) => file_data = b.to_vec(),
                        Err(e) => {
                            error!("Ошибка чтения файла: {}", e);
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                    },
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

    if sender.is_empty() || receiver.is_empty() || file_data.is_empty() {
        warn!(
            "UPLOAD rejected missing fields sender_empty={} receiver_empty={} file_bytes={}",
            sender.is_empty(),
            receiver.is_empty(),
            file_data.len()
        );
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

    let is_server_message = !server_id.trim().is_empty() || !channel_id.trim().is_empty();
    let server_id_opt = if is_server_message {
        Some(server_id.trim().to_string())
    } else {
        None
    };
    let channel_id_opt = if is_server_message {
        Some(channel_id.trim().to_string())
    } else {
        None
    };

    if is_server_message {
        let sid = server_id_opt.as_deref().unwrap_or_default();
        let cid = channel_id_opt.as_deref().unwrap_or_default();
        if sid.is_empty() || cid.is_empty() {
            warn!("UPLOAD rejected empty server/channel after override");
            return (
                StatusCode::BAD_REQUEST,
                "Для серверного сообщения нужны server_id и channel_id",
            )
                .into_response();
        }
        match get_server_access_context(&state.db, sid, &auth_user).await {
            Ok(Some((_server, _role))) => {
                if !can_access_channel(&state.db, sid, cid, &auth_user, "send")
                    .await
                    .unwrap_or(false)
                {
                    return StatusCode::FORBIDDEN.into_response();
                }
            }
            Ok(None) => return (StatusCode::NOT_FOUND, "Сервер не найден").into_response(),
            Err(e) => {
                error!("Ошибка проверки сервера {}: {}", sid, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
        let channel_exists = sqlx::query_scalar::<_, String>(
            "SELECT id FROM channels WHERE id = ? AND server_id = ? LIMIT 1",
        )
        .bind(cid)
        .bind(sid)
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

    // Validate .zali magic header
    if file_data.len() < 8 || &file_data[0..8] != b"ZALIMSSG" {
        warn!("Получен файл с неверной сигнатурой от {}", sender);
        return (
            StatusCode::BAD_REQUEST,
            "Неверная сигнатура архива (ожидается ZALIMSSG)",
        )
            .into_response();
    }

    let id = Uuid::new_v4().to_string();
    let filename = format!("{}.zali", id);
    let path = state.uploads_dir.join(&filename);
    let temp_path = state.uploads_dir.join(format!("{}.tmp", filename));
    let timestamp = Utc::now();

    info!(
        "UPLOAD storing id={} client_id={} sender={} receiver={} file={} bytes={} server={:?} channel={:?} path={}",
        id,
        client_id,
        sender,
        receiver,
        filename,
        file_data.len(),
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

    if !client_id.is_empty() {
        match find_message_by_client_scope(
            &state,
            &client_id,
            &sender,
            &receiver,
            server_id_opt.as_deref(),
            channel_id_opt.as_deref(),
        )
        .await
        {
            Ok(Some(existing)) => {
                info!(
                    "UPLOAD deduplicated by scoped client_id={} existing_message_id={}",
                    client_id, existing.id
                );
                return (
                    StatusCode::CREATED,
                    Json(serde_json::json!({ "id": existing.id, "clientId": client_id })),
                )
                    .into_response();
            }
            Ok(None) => {}
            Err(e) => {
                error!(
                    "Ошибка проверки client_id={} перед вставкой: {}",
                    client_id, e
                );
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    }

    if let Err(e) = fs::write(&temp_path, &file_data).await {
        error!(
            "Ошибка записи временного файла {}: {}",
            temp_path.display(),
            e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Err(e) = fs::rename(&temp_path, &path).await {
        error!(
            "Ошибка атомарного перемещения файла {} -> {}: {}",
            temp_path.display(),
            path.display(),
            e
        );
        let _ = fs::remove_file(&temp_path).await;
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let insert_result = sqlx::query(
        "INSERT INTO messages (id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id)
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
                        "UPLOAD deduplicated after insert race client_id={} existing_message_id={}",
                        client_id, existing.id
                    );
                    return (
                        StatusCode::CREATED,
                        Json(serde_json::json!({ "id": existing.id, "clientId": client_id })),
                    )
                        .into_response();
                }
            }
            error!("Ошибка сохранения сообщения в БД: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn resolve_conversation_key(
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    Json(payload): Json<ConversationKeyRequest>,
) -> impl IntoResponse {
    let peer = payload.peer.as_deref();
    let server_id = payload.serverId.as_deref();
    let channel_id = payload.channelId.as_deref();

    let Some(scope_key) = conversation_scope_key(&auth_user, peer, server_id, channel_id) else {
        return (StatusCode::BAD_REQUEST, "Неверный scope ключа").into_response();
    };

    if let (Some(sid), Some(cid)) = (server_id, channel_id) {
        if !can_access_channel(&state.db, sid, cid, &auth_user, "view")
            .await
            .unwrap_or(false)
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    let key_version = payload.keyVersion.unwrap_or(2).max(1);
    let provided_key = payload
        .key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    match sqlx::query_as::<_, (String, String, i64)>(
        "SELECT scope_key, key_value, key_version FROM conversation_keys WHERE scope_key = ? LIMIT 1",
    )
    .bind(&scope_key)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some((scope_key, key_value, key_version))) => {
            return Json(ConversationKeyResponse {
                scopeKey: scope_key,
                key: key_value,
                keyVersion: key_version,
            })
            .into_response();
        }
        Ok(None) => {}
        Err(e) => {
            error!("Ошибка чтения conversation key {}: {}", scope_key, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let key_value = provided_key.unwrap_or_else(random_conversation_key);
    match sqlx::query(
        "INSERT OR IGNORE INTO conversation_keys (scope_key, key_value, key_version)
         VALUES (?, ?, ?)",
    )
    .bind(&scope_key)
    .bind(&key_value)
    .bind(key_version)
    .execute(&state.db)
    .await
    {
        Ok(_) => {
            match sqlx::query_as::<_, (String, String, i64)>(
                "SELECT scope_key, key_value, key_version FROM conversation_keys WHERE scope_key = ? LIMIT 1",
            )
            .bind(&scope_key)
            .fetch_one(&state.db)
            .await
            {
                Ok((scope_key, key_value, key_version)) => Json(ConversationKeyResponse {
                    scopeKey: scope_key,
                    key: key_value,
                    keyVersion: key_version,
                })
                .into_response(),
                Err(e) => {
                    error!("Ошибка чтения созданного conversation key {}: {}", scope_key, e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        Err(e) => {
            error!("Ошибка сохранения conversation key {}: {}", scope_key, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn download_upload_file(
    AxumPath(filename): AxumPath<String>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
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

            let path = state.uploads_dir.join(&message.filename);
            match fs::read(&path).await {
                Ok(data) => (
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
                    data,
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

            let path = state.uploads_dir.join(&m.filename);
            match fs::read(&path).await {
                Ok(data) => (
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
                    data,
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
            fs::remove_file(&path).await.ok();

            sqlx::query("DELETE FROM reactions WHERE message_id = ?")
                .bind(&id)
                .execute(&state.db)
                .await
                .ok();

            match sqlx::query("DELETE FROM messages WHERE id = ?")
                .bind(&id)
                .execute(&state.db)
                .await
            {
                Ok(_) => {
                    info!("Сообщение удалено: {} (автор: {})", id, auth_user);
                    StatusCode::NO_CONTENT.into_response()
                }
                Err(e) => {
                    error!("Ошибка удаления сообщения {}: {}", id, e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
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
