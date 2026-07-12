use axum::{
    body::Body,
    extract::DefaultBodyLimit,
    http::{header, HeaderName, HeaderValue, Method, Request, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
    Json, Router,
};
use dashmap::DashMap;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::Row;
use std::{
    collections::VecDeque,
    net::SocketAddr,
    path::PathBuf,
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{fs, sync::mpsc};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn, Instrument};
use uuid::Uuid;

mod voice;
use voice::{handle_voice_event, leave_voice_room, send_voice_room_snapshot_to_user, VoiceRoom};

mod devices;
use devices::*;

mod models;
pub(crate) use models::*;
mod util;
pub(crate) use util::*;
mod storage;
pub(crate) use storage::*;
mod assets;
pub(crate) use assets::*;
mod auth;
pub(crate) use auth::*;
mod contacts;
pub(crate) use contacts::*;
mod servers;
pub(crate) use servers::*;
mod channels;
pub(crate) use channels::*;
mod roles;
pub(crate) use roles::*;
mod messages;
pub(crate) use messages::*;
mod realtime;
pub(crate) use realtime::*;

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
pub struct Config {
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
    pub fn from_env() -> Self {
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
                // localhost:8090/8092 match .claude/launch.json's "web-static"/"web-static-mobile"
                // dev previews of web/index.html — without them, testing the browser client
                // against a local `cargo run` server fails CORS silently (fetch() rejects with a
                // generic "Failed to fetch", no hint that the origin is the problem).
                // Gated on debug_assertions (same pattern as the JWT dev-default above) so a
                // release binary — what actually runs in production — never falls back to
                // accepting these dev-only ports even if ALLOWED_ORIGINS is left unset there.
                let base = "https://msgs.zalikus.org,http://localhost:3000,http://localhost,http://127.0.0.1:3000,http://127.0.0.1,zali://localhost";
                if cfg!(debug_assertions) {
                    format!(
                        "{base},http://localhost:8090,http://localhost:8092,http://127.0.0.1:8090,http://127.0.0.1:8092"
                    )
                } else {
                    base.to_string()
                }
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
            .unwrap_or(!cfg!(debug_assertions));

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

/// Correlation-ID middleware: the single change that lets a client-reported
/// problem be traced through the server logs in one pass. Reuses the
/// client-supplied `X-Request-ID` if present (web/Windows clients generate
/// one per API call and log it locally) — otherwise mints a fresh UUID — and
/// wraps the whole request in a tracing span carrying that ID, so every
/// existing `info!`/`warn!`/`error!` call inside the handler is automatically
/// tagged with it in the log output without touching those call sites. Also
/// emits a start/end access-log pair (status, duration) that didn't exist
/// before, and echoes the ID back in the response so the client can log it
/// too — `grep request_id=<id>` on the server log then shows the entire
/// request lifecycle end to end.
async fn request_id_middleware(
    axum::extract::ConnectInfo(remote_addr): axum::extract::ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let incoming_id = req
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_string);
    let request_id = incoming_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let start = Instant::now();

    let span = tracing::info_span!(
        "http_request",
        request_id = %request_id,
        %method,
        %path,
        client_ip = %remote_addr.ip(),
    );

    let mut response = async {
        info!("→ request start");
        next.run(req).await
    }
    .instrument(span.clone())
    .await;

    let elapsed_ms = start.elapsed().as_millis();
    let status = response.status().as_u16();
    span.in_scope(|| {
        info!(status, elapsed_ms, "← request done");
    });

    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-request-id"), value);
    }

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

// ============================================================
// STATE
// ============================================================

type WsSender = mpsc::Sender<String>;

pub struct AppState {
    db: SqlitePool,
    data_dir: PathBuf,
    uploads_dir: PathBuf,
    user_connections: DashMap<String, Vec<WsSender>>,
    voice_rooms: DashMap<String, VoiceRoom>,
    user_voice_rooms: DashMap<String, String>,
    ws_tickets: DashMap<String, WsTicketRecord>,
    // Rate limiting: username/IP → timestamps of recent login attempts
    login_attempts: DashMap<String, VecDeque<Instant>>,
    // Throttles the full-map sweep in login() to once per rate-limit window instead
    // of on every request — see the comment at its call site for why.
    login_attempts_last_swept: std::sync::Mutex<Instant>,
    config: Config,
}

/// Runs all `CREATE TABLE`/`ALTER TABLE`/index migrations against a fresh or
/// existing sqlite db at `data_dir`. Shared by production startup and tests
/// so both get an identical schema.
async fn init_db(data_dir: &std::path::Path) -> SqlitePool {
    let db_path = data_dir.join("zali_messenger.db");

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
            PRIMARY KEY (message_id, reactor, emoji)
        )",
    )
    .execute(&pool)
    .await
    .expect("Ошибка создания таблицы reactions");

    // A user used to be limited to one reaction per message: the original PK was
    // (message_id, reactor), so setting a second emoji replaced the first instead
    // of adding alongside it. Widening the PK above only takes effect on a brand
    // new table — an existing on-disk db still has the old constraint, so detect
    // it via PRAGMA table_info and rebuild the table in place if needed.
    let reactions_columns = sqlx::query("PRAGMA table_info(reactions)")
        .fetch_all(&pool)
        .await
        .unwrap_or_default();
    let emoji_already_in_pk = reactions_columns.iter().any(|row| {
        let name: String = row.get("name");
        name == "emoji" && row.get::<i64, _>("pk") > 0
    });
    if !reactions_columns.is_empty() && !emoji_already_in_pk {
        let mut tx = pool
            .begin()
            .await
            .expect("Не удалось начать транзакцию миграции reactions");
        sqlx::query(
            "CREATE TABLE reactions_v2 (
                message_id TEXT NOT NULL,
                reactor TEXT NOT NULL,
                emoji TEXT NOT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (message_id, reactor, emoji)
            )",
        )
        .execute(&mut *tx)
        .await
        .expect("Ошибка создания таблицы reactions_v2");
        sqlx::query(
            "INSERT OR IGNORE INTO reactions_v2 (message_id, reactor, emoji, updated_at)
             SELECT message_id, reactor, emoji, updated_at FROM reactions",
        )
        .execute(&mut *tx)
        .await
        .expect("Ошибка копирования данных reactions -> reactions_v2");
        sqlx::query("DROP TABLE reactions")
            .execute(&mut *tx)
            .await
            .expect("Ошибка удаления старой таблицы reactions");
        sqlx::query("ALTER TABLE reactions_v2 RENAME TO reactions")
            .execute(&mut *tx)
            .await
            .expect("Ошибка переименования reactions_v2 -> reactions");
        tx.commit()
            .await
            .expect("Ошибка коммита миграции reactions");
        info!("Миграция reactions: PK расширен до (message_id, reactor, emoji)");
    }

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

    pool
}

/// Builds a fully migrated, seeded `AppState` rooted at `data_dir`. Used by
/// both production startup (`run`) and integration tests, so every test gets
/// the exact same schema/seed data production does — just in an isolated
/// per-test directory instead of the canonical one.
pub async fn build_app_state(data_dir: PathBuf, config: Config) -> Arc<AppState> {
    let uploads_dir = data_dir.join("uploads");
    fs::create_dir_all(&data_dir).await.ok();
    fs::create_dir_all(&uploads_dir).await.ok();

    let pool = init_db(&data_dir).await;

    if let Err(e) =
        migrate_legacy_storage(&pool, &data_dir.join("zali_messenger.db"), &uploads_dir).await
    {
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

    Arc::new(AppState {
        db: pool,
        data_dir,
        uploads_dir,
        user_connections: DashMap::new(),
        voice_rooms: DashMap::new(),
        user_voice_rooms: DashMap::new(),
        ws_tickets: DashMap::new(),
        login_attempts: DashMap::new(),
        login_attempts_last_swept: std::sync::Mutex::new(Instant::now()),
        config,
    })
}

/// Builds the full route table wired to `state`, minus binding/serving —
/// callers decide how to run it (production binds a real port, tests bind
/// `127.0.0.1:0` and drive it with a real HTTP/WS client).
pub fn build_router(state: Arc<AppState>) -> Router {
    let origins: Vec<HeaderValue> = state
        .config
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
            // Web client's apiFetch() stamps every request with this for log
            // correlation (see loadStoredMessageCache-adjacent apiHeaders() in
            // interface.js). Missing here made the browser's CORS preflight silently
            // refuse to send the actual request for ANY api call from a browser
            // context (fetch() rejects with a generic "Failed to fetch", no server
            // log entry at all) — native shells were unaffected since they bypass
            // fetch() via the native HTTP bridge.
            HeaderName::from_static("x-request-id"),
        ])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::DELETE,
            Method::PUT,
            Method::PATCH,
        ]);

    let max_upload = state.config.max_upload_bytes;

    Router::new()
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
        .layer(middleware::from_fn(request_id_middleware))
        .with_state(state)
}

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
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

/// Production entry point: initializes tracing, builds state rooted at the
/// canonical data dir, binds `BIND_ADDR`, and serves until shutdown.
pub async fn run() {
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

    info!("Каноническая директория данных: {}", data_dir.display());

    let state = build_app_state(data_dir, config).await;

    info!(
        "Серверное хранилище активировано: data_dir={}, uploads_dir={}",
        state.data_dir.display(),
        state.uploads_dir.display()
    );

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

    let app = build_router(Arc::clone(&state));

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
