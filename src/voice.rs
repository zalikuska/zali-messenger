//! Voice call signaling: room membership state and the `voice_*` WebSocket
//! message handlers. Split out of main.rs so voice-call bugs (join/leave
//! races, signaling routing, call invite/accept/reject/cancel state machine)
//! can be found and fixed without wading through unrelated HTTP handlers.

use crate::{can_access_channel, contact_exists, send_json_to_user, AppState};
use serde_json;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};

#[derive(Debug, Clone)]
pub(crate) struct VoiceRoom {
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

pub(crate) async fn send_voice_room_snapshot_to_user(state: &Arc<AppState>, username: &str) {
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

pub(crate) async fn leave_voice_room(state: &Arc<AppState>, username: &str) {
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

pub(crate) async fn handle_voice_event(state: &Arc<AppState>, sender: &str, payload: &serde_json::Value) {
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
