//! Server (guild) CRUD, membership management, invites, and join links.

use crate::{
    channel_allows_action, create_server_role_record, ensure_default_server_roles,
    load_channels_for_server, load_server_role_permissions, load_server_role_record,
    load_visible_channels_for_server, set_server_asset, AppState, AuthenticatedUser,
    ChannelPermissionMap, ChannelRecord, ChannelResponse, InvitePayload, JoinInvitePayload,
    JoinServerLinkPayload, ServerInviteRecord, ServerInviteResponse, ServerListResponse,
    ServerMemberPayload, ServerMemberRecord, ServerMemberResponse, ServerPayload, ServerRecord,
    ServerResponse, ServerSettingsPayload,
};
use axum::{extract::Path as AxumPath, http::StatusCode, response::IntoResponse, Json};
use chrono::Utc;
use sqlx::{sqlite::SqlitePool, QueryBuilder, Row, Sqlite};
use std::{collections::HashMap, sync::Arc};
use tokio::fs;
use tracing::error;
use uuid::Uuid;

pub(crate) async fn get_server_accessibility(
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

pub(crate) async fn build_server_response(
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

pub(crate) async fn build_server_responses_batch(
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

    let mut channel_permissions: HashMap<String, ChannelPermissionMap> = HashMap::new();
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

pub(crate) fn normalize_server_role(role: Option<&str>) -> Option<String> {
    let value = role.unwrap_or("").trim().to_lowercase();
    match value.as_str() {
        "owner" => Some("owner".to_string()),
        "admin" => Some("admin".to_string()),
        "member" => Some("member".to_string()),
        _ => None,
    }
}

pub(crate) async fn resolve_member_role_input(
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

pub(crate) fn can_manage_by_role(role: Option<&str>) -> bool {
    matches!(role, Some("owner") | Some("admin"))
}

pub(crate) async fn create_server_invite_record(
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

pub(crate) async fn get_server_member_role(
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

pub(crate) async fn get_server_member_count(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM server_members WHERE server_id = ?")
        .bind(server_id)
        .fetch_one(pool)
        .await
}

pub(crate) async fn load_server_members(
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

pub(crate) async fn get_server_access_context(
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

pub(crate) async fn ensure_server_member(
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

pub(crate) async fn upsert_server_member(
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

pub(crate) async fn can_manage_server(
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

pub(crate) async fn get_servers(
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

pub(crate) async fn get_public_servers(
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

pub(crate) async fn create_server(
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
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "join_link слишком длинный"})),
            )
                .into_response();
        }
        if link.starts_with("zali://server/") && *link != format!("zali://server/{}", server_id) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Недопустимый формат join_link"})),
            )
                .into_response();
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

pub(crate) async fn update_server(
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

pub(crate) async fn get_server_members(
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

pub(crate) async fn add_server_member(
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

pub(crate) async fn update_server_member(
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

pub(crate) async fn delete_server_member(
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

pub(crate) async fn delete_server(
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

pub(crate) async fn get_server_invites(
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

pub(crate) async fn create_server_invite(
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

pub(crate) async fn join_server_invite(
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

pub(crate) async fn join_server_link(
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
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Сервер приватный"})),
        )
            .into_response();
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
