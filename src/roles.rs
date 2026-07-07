//! Custom server role records, role permission maps, and role endpoints.

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
use tracing::error;
use uuid::Uuid;
use crate::{
    AppState, AuthenticatedUser, can_manage_server, ensure_default_server_roles,
    ServerRolePayload, ServerRoleRecord, ServerRoleResponse,
};

pub(crate) async fn load_server_role_permissions_map(
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

pub(crate) async fn load_server_roles(
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

pub(crate) async fn load_server_role_record(
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

pub(crate) async fn load_server_role_permissions(
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

pub(crate) fn slug_role_id(value: &str) -> String {
    let mut out = String::new();
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if (ch.is_whitespace() || ch == '-' || ch == '_')
            && !out.ends_with('-') {
                out.push('-');
            }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "role".to_string()
    } else {
        trimmed
    }
}

pub(crate) async fn create_server_role_record(
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

pub(crate) async fn update_server_role_record(
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

pub(crate) async fn delete_server_role_record(
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

pub(crate) async fn get_server_roles(
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

pub(crate) async fn create_server_role(
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

pub(crate) async fn update_server_role(
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

pub(crate) async fn delete_server_role(
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

pub(crate) fn role_permissions_for_view(
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

pub(crate) fn fallback_role_permissions(role_id: &str) -> (bool, bool, bool) {
    match role_id {
        "owner" | "admin" => (true, true, true),
        "member" => (true, true, false),
        _ => (true, true, false),
    }
}
