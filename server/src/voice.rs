//! Voice call signaling: room membership state and the `voice_*` WebSocket
//! message handlers. Split out of main.rs so voice-call bugs (join/leave
//! races, signaling routing, call invite/accept/reject/cancel state machine)
//! can be found and fixed without wading through unrelated HTTP handlers.

use crate::{can_access_channel, contact_exists, send_json_to_user, AppState, AuthenticatedUser};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use base64::Engine;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};

/// Short-lived TURN credentials, in the scheme coturn implements as
/// `use-auth-secret` (RFC 5766 §10, "TURN REST API"): the username is
/// `<unix expiry>:<user>` and the password is the base64 of its HMAC-SHA1 under a
/// secret shared with the relay — so the relay validates it arithmetically and
/// needs no per-user account, and a leaked credential stops working by itself.
///
/// The alternative, which this replaces where it is configured, is the single
/// `zali`/`turnpass` pair compiled into every client: readable by anyone who has
/// ever opened the bundle, usable by them for as long as it exists, and revocable
/// only by rebuilding and redistributing every client on every platform.
///
/// 404 when the deployment has not configured a secret — the client treats that as
/// "no rotating credentials here" and keeps using the static pair, so a server
/// without coturn in this mode behaves exactly as it did before.
pub(crate) async fn get_turn_credentials(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let Some(secret) = state.config.turn_static_auth_secret.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ttl = state.config.turn_credential_ttl_secs;
    let expiry = chrono::Utc::now().timestamp().saturating_add(ttl as i64);
    let turn_username = format!("{}:{}", expiry, username);

    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    let Ok(mut mac) = <Hmac<Sha1>>::new_from_slice(secret.as_bytes()) else {
        error!("[VOICE][TURN] cannot build HMAC from TURN_STATIC_AUTH_SECRET");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    mac.update(turn_username.as_bytes());
    let credential = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

    Json(serde_json::json!({
        "username": turn_username,
        "credential": credential,
        "ttl": ttl,
        "urls": state.config.turn_urls,
    }))
    .into_response()
}

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
    keepalive: bool,
) {
    info!(
        "[VOICE] '{}' joining room {} ({}) keepalive={}",
        username, room_id, room_type, keepalive
    );
    let should_leave_current_room = match state.user_voice_rooms.get(username) {
        Some(current_room) => current_room.value().as_str() != room_id,
        None => true,
    };

    // user_voice_rooms is keyed by USERNAME, so a user can only be in one voice
    // room account-wide: joining evicts whatever room they were in. That is fine
    // for an explicit join, but a keepalive must never do it — with the same
    // account signed in on two devices sitting in two different rooms, each
    // device's keepalive would evict the other every few seconds, flapping both
    // calls forever. Absent mapping (the eviction we are recovering from) is not
    // "a different room", so the recovery path still works.
    if keepalive && should_leave_current_room && state.user_voice_rooms.contains_key(username) {
        info!(
            "[VOICE] ignoring keepalive from '{}' for {} — already in another room",
            username, room_id
        );
        return;
    }

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

    let roster_changed = {
        let room = room.value_mut();
        room.room_type = room_type.to_string();
        room.server_id = server_id.map(|v| v.to_string());
        room.channel_id = channel_id.map(|v| v.to_string());
        room.participants.insert(username.to_string())
    };
    drop(room); // release DashMap shard lock before re-entering voice_rooms via broadcast

    state
        .user_voice_rooms
        .insert(username.to_string(), room_id.to_string());

    if roster_changed {
        broadcast_voice_room_state(state, room_id).await;
    } else {
        // Idempotent re-join. Clients re-assert voice_join on a timer while in a
        // room (see sendVoiceRoomPresence in interface.js) so a transport blip past
        // the delayed cleanup in realtime.rs doesn't silently evict them — that
        // keepalive must not fan a room-state broadcast out to every participant
        // every few seconds. The roster is unchanged, so only the sender needs the
        // snapshot; for everyone else this is a no-op.
        send_voice_room_snapshot_to_user(state, username).await;
    }
}

/// Pulls the two participants out of a DM room id. The client builds it as
/// `voice:dm:<a>:<b>[:<stamp>]` with the pair sorted (voiceRoomKeyForDm /
/// makeDmCallRoomId in web/src/interface/voice_transport.js), and the server's own
/// fallback in the invite branch builds the same shape. Anything else is not a DM
/// room id and must not be treated as one.
fn dm_room_participants(room_id: &str) -> Option<(String, String)> {
    let rest = room_id.strip_prefix("voice:dm:")?;
    let mut parts = rest.split(':');
    let a = parts.next()?.trim();
    let b = parts.next()?.trim();
    if a.is_empty() || b.is_empty() || a.eq_ignore_ascii_case(b) {
        return None;
    }
    Some((a.to_string(), b.to_string()))
}

/// Whether `sender` may claim membership of this DM room on the strength of the
/// room id alone — used when the server's own record of the room is gone or does
/// not list them yet (a restart, or an eviction after a long outage).
///
/// Authorised exactly like the invite that would have created the room: the id must
/// encode this sender as one of the pair, and the two must be contacts. Without
/// those checks this would be "put me in a room called anything".
async fn dm_room_claim_authorized(state: &Arc<AppState>, sender: &str, room_id: &str) -> bool {
    let Some((a, b)) = dm_room_participants(room_id) else {
        warn!(
            "[VOICE][RESTORE] reject malformed dm room id sender={} roomId={}",
            sender, room_id
        );
        return false;
    };
    let peer = if a.eq_ignore_ascii_case(sender) {
        b
    } else if b.eq_ignore_ascii_case(sender) {
        a
    } else {
        warn!(
            "[VOICE][RESTORE] reject sender not in room id sender={} roomId={}",
            sender, room_id
        );
        return false;
    };
    match contact_exists(&state.db, sender, &peer).await {
        Ok(true) => true,
        Ok(false) => {
            warn!(
                "[VOICE][RESTORE] reject non-contact sender={} peer={} roomId={}",
                sender, peer, room_id
            );
            false
        }
        Err(e) => {
            error!(
                "[VOICE][RESTORE] contact check failed sender={} peer={} roomId={}: {}",
                sender, peer, room_id, e
            );
            false
        }
    }
}

/// Recreates a DM room the server has forgotten, with `sender` as its only member.
///
/// Only the sender, never both: the other side may genuinely have hung up while we
/// were down, and listing them would tell everyone they are in a call they already
/// left. Their own keepalive re-adds them within seconds if they are still there,
/// and if they are not, the surviving client sees a roster of one and its dead-call
/// detection takes it from there.
fn restore_dm_room(state: &Arc<AppState>, sender: &str, room_id: &str) {
    // Re-checked under the entry lock: two keepalives, one from each participant,
    // can land together, and the second must join the room the first created rather
    // than replace it — which would drop the first participant straight back out.
    let mut created = false;
    state
        .voice_rooms
        .entry(room_id.to_string())
        .or_insert_with(|| {
            created = true;
            let mut room = VoiceRoom::new("dm".to_string(), None, None);
            room.call_state = "active".to_string();
            room
        })
        .participants
        .insert(sender.to_string());
    if created {
        info!(
            "[VOICE][RESTORE] rebuilt dm room {} for '{}' after it went missing",
            room_id, sender
        );
    } else {
        info!(
            "[VOICE][RESTORE] '{}' re-admitted to restored dm room {}",
            sender, room_id
        );
    }
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

    // The size of an SDP and the type of an ICE candidate are the two facts that
    // separate "signalling worked and the media failed" from "the signal itself was
    // wrong", and neither was recorded: an SDP that arrives truncated or empty, or a
    // room where nobody ever offers a relay candidate, both showed up here as an
    // ordinary routed signal.
    let signal_type = payload["signal"]["type"].as_str().unwrap_or_default();
    let sdp_len = payload["signal"]["sdp"]["sdp"]
        .as_str()
        .map(|v| v.len())
        .unwrap_or(0);
    let candidate_kind = payload["signal"]["candidate"]["candidate"]
        .as_str()
        .and_then(|c| {
            c.split_whitespace()
                .nth(7)
                .map(|kind| kind.to_string())
        })
        .unwrap_or_default();
    info!(
        "[VOICE][ROUTE] from={} roomId={} roomType={} to={} signalType={} sdpLen={} candType={} roster=[{}]",
        sender,
        room_id,
        payload["roomType"].as_str().unwrap_or_default(),
        payload["to"].as_str().unwrap_or_default(),
        signal_type,
        sdp_len,
        candidate_kind,
        participants.join(",")
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

pub(crate) async fn handle_voice_event(
    state: &Arc<AppState>,
    sender: &str,
    payload: &serde_json::Value,
) {
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
            // Set by the client's periodic membership re-assert (sendVoiceRoomPresence)
            // as opposed to a user actually joining a channel. Non-destructive: it may
            // restore a room the client was evicted from, never move it out of one.
            let keepalive = payload["keepalive"].as_bool().unwrap_or(false);
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
                                    "code": "channel_forbidden",
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
                                "code": "bad_request",
                                "message": "Необходимо указать server_id и channel_id"
                            }),
                        )
                        .await;
                        return;
                    }
                }
            } else if room_type == "dm" {
                // Three situations, and only the first one used to be handled:
                //   - the room exists and lists us: ordinary re-join;
                //   - the room is gone entirely: the server restarted (voice_rooms
                //     lives only in memory), or evicted us after a long outage;
                //   - the room exists but does not list us: our peer's keepalive
                //     rebuilt it first, with only themselves in it.
                //
                // The last two are the same situation seen a moment apart, and both
                // used to be answered with an error forever — a DM room is only ever
                // created by voice_call_invite, so nothing could bring one back. The
                // media kept flowing (it is peer-to-peer) while signalling was dead:
                // no ICE restart, no renegotiation, and the call went quiet the first
                // time the network hiccuped. Channel rooms never had this problem;
                // join_voice_room recreates them by name.
                //
                // Recovery is only ever driven by a keepalive — a plain join asking
                // for a room that does not exist is asking for a call nobody started.
                let membership = state.voice_rooms.get(&room_id).map(|room| {
                    room.participants.contains(sender)
                        || room.initiator.as_deref() == Some(sender)
                        || room.target.as_deref() == Some(sender)
                });
                let allowed = match membership {
                    Some(true) => true,
                    _ => keepalive && dm_room_claim_authorized(state, sender, &room_id).await,
                };
                if !allowed {
                    let (code, message) = if membership.is_none() {
                        ("room_not_found", "Голосовая комната не найдена")
                    } else {
                        ("room_forbidden", "Нет доступа к голосовой переписке")
                    };
                    send_json_to_user(
                        state,
                        sender,
                        serde_json::json!({
                            "type": "voice_error",
                            "roomId": room_id,
                            "code": code,
                            "message": message,
                        }),
                    )
                    .await;
                    return;
                }
                if membership.is_none() {
                    restore_dm_room(state, sender, &room_id);
                }
            }

            join_voice_room(
                state,
                sender,
                &room_id,
                room_type,
                server_id.as_deref(),
                channel_id.as_deref(),
                keepalive,
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
                            "code": "not_a_contact",
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
                            "code": "contact_check_failed",
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
            // join_voice_room() already broadcasts the current room state (call_state
            // is already "ringing" above, before this call) — a second identical
            // broadcast here just doubled every invite's room-state traffic.
            join_voice_room(state, sender, &room_key, "dm", None, None, false).await;
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

            join_voice_room(state, sender, &room_id, "dm", None, None, false).await;

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
            // Only drop a user->room mapping if it actually points at the room being
            // rejected. The reject target may be busy in a *different* active call
            // (voice_call_invite never joins the target, so their mapping still points
            // at their ongoing room) — an unconditional remove(sender) here would wipe
            // that active call's mapping, orphaning the room and breaking reconnect
            // snapshot restore. See the client-side busy-guard in interface.js.
            state
                .user_voice_rooms
                .remove_if(sender, |_, v| v == &room_id);
            state
                .user_voice_rooms
                .remove_if(inviter.as_str(), |_, v| v == &room_id);
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
            // Same reasoning as the reject branch above: the cancelled invite's target
            // is never joined to the ringing room, so their user->room mapping may well
            // point at a *different* call they are actually in. Removing it
            // unconditionally orphaned that room (leave_voice_room then finds no
            // mapping and never drops them from its participant list).
            state
                .user_voice_rooms
                .remove_if(sender, |_, v| v == &room_id);
            state
                .user_voice_rooms
                .remove_if(target.as_str(), |_, v| v == &room_id);
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
