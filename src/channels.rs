//! Channel CRUD, channel permission records, and channel access checks.

use axum::{
    extract::Path as AxumPath,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use sqlx::{
    sqlite::SqlitePool,
};
use std::{
    collections::HashMap,
    sync::Arc,
};
use tokio::fs;
use tracing::{debug, error};
use uuid::Uuid;
use crate::{
    AppState, AuthenticatedUser, can_manage_server, ChannelPayload, ChannelPermissionInput,
    ChannelPermissionRecord, ChannelPermissionResponse, ChannelPermissionsPayload,
    ChannelRecord, ChannelResponse, ChannelUpdatePayload, fallback_role_permissions,
    get_server_access_context, get_server_accessibility, get_server_member_role,
    load_server_role_permissions_map, load_server_role_record, Message, normalize_server_role,
};

pub(crate) async fn load_channels_for_server(
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

pub(crate) async fn load_visible_channels_for_server(
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

/// channel_id → role → (can_view, can_send, can_manage)
pub(crate) type ChannelPermissionMap = HashMap<String, HashMap<String, (bool, bool, bool)>>;

pub(crate) async fn load_channel_permissions_map(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<ChannelPermissionMap, sqlx::Error> {
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

pub(crate) fn channel_allows_action(
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

pub(crate) fn normalize_channel_kind(kind: Option<&str>) -> String {
    match kind.unwrap_or("text").trim().to_lowercase().as_str() {
        "voice" => "voice".to_string(),
        _ => "text".to_string(),
    }
}

pub(crate) async fn channel_name_conflicts(
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

pub(crate) async fn load_channel_permissions(
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

pub(crate) async fn channel_belongs_to_server(
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

pub(crate) async fn load_channel_permission_record(
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

pub(crate) async fn upsert_channel_permissions(
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

pub(crate) async fn can_access_channel(
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

pub(crate) async fn get_channels(
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

pub(crate) async fn create_channel(
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

pub(crate) async fn update_channel(
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

pub(crate) async fn delete_channel(
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

pub(crate) async fn get_channel_permissions(
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

pub(crate) async fn update_channel_permissions(
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
