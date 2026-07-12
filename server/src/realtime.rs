//! WebSocket connection lifecycle and JSON broadcast/send helpers.

use crate::{
    handle_voice_event, leave_voice_room, send_voice_room_snapshot_to_user, AppState,
    AuthenticatedUser,
};
use axum::{
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tracing::{info, trace, warn};

pub(crate) async fn broadcast_json(state: &Arc<AppState>, payload: String) {
    let viewers: Vec<String> = state
        .user_connections
        .iter()
        .map(|entry| entry.key().clone())
        .collect();
    for viewer in viewers {
        send_payload_to_user(state, &viewer, payload.clone(), "broadcast_json").await;
    }
}

pub(crate) async fn send_payload_to_user(
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
        match conn.try_send(payload.clone()) {
            Ok(()) => sent += 1,
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                // Buffer is momentarily full (bursty/slow consumer). Drop just this
                // payload and KEEP the connection registered. Previously we removed
                // the sender here, but the socket task holds its own `tx` clone (used
                // for cleanup on disconnect), so the socket stayed open — the client
                // believed it was connected yet silently stopped receiving anything
                // until a manual reconnect. Genuinely dead sockets are still reaped by
                // the is_closed() sweep below and on the next delivery.
                failed = true;
                warn!(
                    "WS send buffer full label={} username={} payload dropped, connection kept",
                    label, username
                );
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
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

pub(crate) async fn broadcast_avatar_event(
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

pub(crate) async fn send_json_to_user(
    state: &Arc<AppState>,
    username: &str,
    payload: serde_json::Value,
) {
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

pub(crate) async fn ws_handler(
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

pub(crate) async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, username: String) {
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
