//! SQLite bootstrap: data-dir resolution, legacy storage migration, schema
//! column upgrades, and default server/role seeding.

use crate::{
    asset_file_paths, asset_root_dir, read_asset_file, server_asset_dir, user_avatar_asset_dir,
    write_asset_file, AvatarRecord,
};
use chrono::{DateTime, Utc};
use sqlx::{sqlite::SqlitePool, Row, Sqlite};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use tokio::fs;
use tracing::{info, warn};

pub(crate) fn sqlite_literal(path: &Path) -> String {
    let escaped = path.to_string_lossy().replace('\'', "''");
    format!("'{}'", escaped)
}

pub(crate) fn canonical_data_dir() -> PathBuf {
    std::env::var("ZALI_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

pub(crate) fn legacy_data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

pub(crate) async fn copy_missing_uploads(
    from_dir: &Path,
    to_dir: &Path,
) -> Result<usize, std::io::Error> {
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

pub(crate) async fn migrate_legacy_storage(
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

pub(crate) async fn legacy_table_columns(
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

pub(crate) async fn migrate_asset_files(
    pool: &SqlitePool,
    data_dir: &Path,
) -> Result<(), sqlx::Error> {
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

    // (id, avatar_mime, avatar_data, banner_mime, banner_data)
    type ServerAssetRow = (
        String,
        Option<String>,
        Option<Vec<u8>>,
        Option<String>,
        Option<Vec<u8>>,
    );
    let servers: Vec<ServerAssetRow> = sqlx::query_as(
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

pub(crate) async fn column_exists(pool: &SqlitePool, column: &str) -> Result<bool, sqlx::Error> {
    let rows = sqlx::query("PRAGMA table_info(messages)")
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().any(|row| {
        let name: String = row.get("name");
        name == column
    }))
}

pub(crate) async fn ensure_message_columns(pool: &SqlitePool) -> Result<(), sqlx::Error> {
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

pub(crate) async fn seed_default_servers(pool: &SqlitePool) -> Result<(), sqlx::Error> {
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

pub(crate) async fn ensure_default_server_roles(
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
