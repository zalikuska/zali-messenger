//! Message upload/download/delete, reactions, history pagination, and
//! fan-out delivery to DM/server recipients.

use crate::{
    can_access_channel, can_manage_by_role, dm_conversation_scope, fallback_role_permissions,
    get_server_access_context, get_server_accessibility, get_server_member_role,
    history_access_matches, load_channel_permissions, push_history_access_predicate,
    resolve_history_access, role_permissions_for_view, send_payload_to_user,
    server_conversation_scope, AppState, AuthenticatedUser, Message, MessagePageQuery,
    MessageResponse, ReactionPayload, ReactionSummary, ServerRecord,
};
use axum::{
    body::Body,
    extract::{Multipart, Path as AxumPath, Query},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use sqlx::{QueryBuilder, Row, Sqlite};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::{fs, io::AsyncWriteExt};
use tokio_util::io::ReaderStream;
use tracing::{error, info, warn};
use uuid::Uuid;

pub(crate) async fn load_reaction_states(
    state: &Arc<AppState>,
    message_ids: &[String],
    viewer: &str,
) -> Result<HashMap<String, (Vec<ReactionSummary>, Vec<String>)>, sqlx::Error> {
    let mut states: HashMap<String, (HashMap<String, i64>, Vec<String>)> = HashMap::new();
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
            .or_insert_with(|| (HashMap::new(), Vec::new()));
        *entry.0.entry(emoji.clone()).or_insert(0) += 1;
        if reactor == viewer {
            entry.1.push(emoji);
        }
    }

    Ok(states
        .into_iter()
        .map(|(message_id, (counts, my_reactions))| {
            let mut reactions: Vec<ReactionSummary> = counts
                .into_iter()
                .map(|(emoji, count)| ReactionSummary { emoji, count })
                .collect();
            reactions.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.emoji.cmp(&b.emoji)));
            (message_id, (reactions, my_reactions))
        })
        .collect())
}

pub(crate) async fn load_reaction_state(
    state: &Arc<AppState>,
    message_id: &str,
    viewer: &str,
) -> Result<(Vec<ReactionSummary>, Vec<String>), sqlx::Error> {
    let map = load_reaction_states(state, &[message_id.to_string()], viewer).await?;
    Ok(map.get(message_id).cloned().unwrap_or_default())
}

pub(crate) async fn load_reaction_state_for_viewers(
    state: &Arc<AppState>,
    message_id: &str,
    viewers: &[String],
) -> Result<(Vec<ReactionSummary>, HashMap<String, Vec<String>>), sqlx::Error> {
    let viewer_set: HashSet<&str> = viewers.iter().map(|viewer| viewer.as_str()).collect();
    let rows = sqlx::query("SELECT emoji, reactor FROM reactions WHERE message_id = ?")
        .bind(message_id)
        .fetch_all(&state.db)
        .await?;
    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut my_reactions: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let emoji: String = row.get("emoji");
        let reactor: String = row.get("reactor");
        *counts.entry(emoji.clone()).or_insert(0) += 1;
        if viewer_set.contains(reactor.as_str()) {
            my_reactions.entry(reactor).or_default().push(emoji);
        }
    }

    let mut reactions: Vec<ReactionSummary> = counts
        .into_iter()
        .map(|(emoji, count)| ReactionSummary { emoji, count })
        .collect();
    reactions.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.emoji.cmp(&b.emoji)));
    Ok((reactions, my_reactions))
}

pub(crate) async fn broadcast_reaction_event(state: &Arc<AppState>, message: &Message) {
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
            "myReactions": my_reactions.get(&viewer).cloned().unwrap_or_default()
        });
        send_payload_to_user(state, &viewer, payload.to_string(), "reaction_updated").await;
    }
}

pub(crate) async fn get_server_messages(
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

    let limit = page.limit.unwrap_or(50).clamp(1, 500);
    let offset = page.offset.unwrap_or(0).max(0);
    let newest_first = page.newest_first.unwrap_or(false);
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
    if newest_first {
        builder.push(" ORDER BY timestamp DESC, id DESC");
    } else {
        builder.push(" ORDER BY timestamp ASC, id ASC");
    }
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
                    let (reactions, my_reactions) =
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
                        my_reactions,
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

pub(crate) async fn get_messages(
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

    let limit = page.limit.unwrap_or(50).clamp(1, 500);
    let offset = page.offset.unwrap_or(0).max(0);
    let newest_first = page.newest_first.unwrap_or(false);
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
    if newest_first {
        builder.push(" ORDER BY timestamp DESC, id DESC");
    } else {
        builder.push(" ORDER BY timestamp ASC, id ASC");
    }
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
                    let (reactions, my_reactions) =
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
                        my_reactions,
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

pub(crate) async fn set_message_reaction(
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
    if emoji.is_empty() {
        return (StatusCode::BAD_REQUEST, "Пустая реакция").into_response();
    }
    if emoji.chars().count() > 8 {
        return (StatusCode::BAD_REQUEST, "Слишком длинная реакция").into_response();
    }

    // Toggles this specific emoji for the reactor, independent of any other
    // emoji they've already reacted with — a user can stack several different
    // reactions on the same message (Discord-style), rather than being limited
    // to one at a time.
    let already_set = sqlx::query(
        "SELECT 1 FROM reactions WHERE message_id = ? AND reactor = ? AND emoji = ?",
    )
    .bind(&id)
    .bind(&auth_user)
    .bind(&emoji)
    .fetch_optional(&state.db)
    .await;

    let result = match already_set {
        Ok(Some(_)) => {
            sqlx::query("DELETE FROM reactions WHERE message_id = ? AND reactor = ? AND emoji = ?")
                .bind(&id)
                .bind(&auth_user)
                .bind(&emoji)
                .execute(&state.db)
                .await
        }
        Ok(None) => {
            sqlx::query(
                "INSERT INTO reactions (message_id, reactor, emoji, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(message_id, reactor, emoji) DO NOTHING",
            )
            .bind(&id)
            .bind(&auth_user)
            .bind(&emoji)
            .bind(Utc::now())
            .execute(&state.db)
            .await
        }
        Err(e) => Err(e),
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
        Ok((reactions, my_reactions)) => Json(serde_json::json!({
            "type": "reaction_updated",
            "messageId": id,
            "sender": message.sender,
            "receiver": message.receiver,
            "serverId": message.server_id,
            "channelId": message.channel_id,
            "reactions": reactions,
            "myReactions": my_reactions
        }))
        .into_response(),
        Err(e) => {
            error!("Ошибка загрузки реакции {}: {}", id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn find_message_by_client_scope(
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

pub(crate) async fn upload_message(
    AuthenticatedUser(auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    multipart: Multipart,
) -> impl IntoResponse {
    upload_message_with_context(auth_user, state, multipart, None, None).await
}

pub(crate) async fn upload_server_message(
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

pub(crate) async fn upload_message_with_context(
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
            if wrote_file {
                let _ = fs::remove_file(&temp_path).await;
            }
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
                            if wrote_file {
                                let _ = fs::remove_file(&temp_path).await;
                            }
                            return (StatusCode::FORBIDDEN, "Нет прав на отправку в этом канале")
                                .into_response();
                        }
                        Err(e) => {
                            error!(
                                "Ошибка проверки fallback DM receiver={} server={} channel={}: {}",
                                receiver, sid, cid, e
                            );
                            if wrote_file {
                                let _ = fs::remove_file(&temp_path).await;
                            }
                            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                        }
                    }
                }
            }
            Ok(None) => {
                if wrote_file {
                    let _ = fs::remove_file(&temp_path).await;
                }
                return (StatusCode::NOT_FOUND, "Сервер не найден").into_response();
            }
            Err(e) => {
                error!("Ошибка проверки сервера {}: {}", sid, e);
                if wrote_file {
                    let _ = fs::remove_file(&temp_path).await;
                }
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
                Ok(None) => {
                    if wrote_file {
                        let _ = fs::remove_file(&temp_path).await;
                    }
                    return (StatusCode::NOT_FOUND, "Канал не найден").into_response();
                }
                Err(e) => {
                    error!("Ошибка проверки канала {}/{}: {}", sid, cid, e);
                    if wrote_file {
                        let _ = fs::remove_file(&temp_path).await;
                    }
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
        server_id_opt.is_some() || channel_id_opt.is_some()
    );

    // Move the archive into its final path BEFORE inserting the row. If the row were
    // inserted first, a crash — or a concurrent history/download read — in the window
    // before the rename would see a message whose file is still at temp_path: history
    // lists it, but download 404s. File-first means the row is never visible without its
    // backing file (a crash instead leaves only a harmless orphan file, not an orphan row).
    if wrote_file {
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
    }

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
                        // Our just-renamed file is a duplicate of the existing message's
                        // own file (different id) — drop it, not temp_path (already moved).
                        let _ = fs::remove_file(&path).await;
                        return (
                            StatusCode::CREATED,
                            Json(serde_json::json!({ "id": existing.id, "clientId": client_id })),
                        )
                            .into_response();
                    }
                }
                // Duplicate insert ignored (row already existed) — drop our renamed file.
                let _ = fs::remove_file(&path).await;
                return StatusCode::CREATED.into_response();
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

pub(crate) async fn download_upload_file(
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
                newest_first: None,
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

pub(crate) async fn deliver_to_user(state: &Arc<AppState>, username: &str, msg: &Message) {
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

pub(crate) async fn resolve_server_message_viewers(
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

pub(crate) async fn deliver_server_message(state: &Arc<AppState>, msg: &Message) {
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

pub(crate) async fn can_access_message(
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

pub(crate) async fn can_delete_message(
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

pub(crate) async fn download_message(
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
                newest_first: None,
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

pub(crate) async fn delete_message(
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
