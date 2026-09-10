//! Voice call signaling: room membership state and the `voice_*` WebSocket
//! message handlers. Split out of main.rs so voice-call bugs (join/leave
//! races, signaling routing, call invite/accept/reject/cancel state machine)
//! can be found and fixed without wading through unrelated HTTP handlers.

use crate::{can_access_channel, contact_exists, send_json_to_user, AppState, AuthenticatedUser};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
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
    /// Which DEVICE of each participant holds that participant's place in the room.
    ///
    /// Membership is per account (`participants`, `user_voice_rooms`), but a call is
    /// carried by exactly one device — and the server used to fan every voice event
    /// out to all of an account's devices and accept every event from any of them.
    /// With one account signed in on two machines that is not a corner case, it is
    /// what production looked like on 2026-09-10: the idle second Mac sent
    /// `voice_leave` three seconds after the first one accepted, which destroyed the
    /// DM room and hung up the caller; in a channel it removed the account from the
    /// roster under the device actually talking. Absent entry = a client too old to
    /// say which device it is; such a participant is not targeted and not guarded,
    /// exactly as before.
    devices: HashMap<String, String>,
    /// The device that placed a DM call, so the ringing/accepted/rejected replies go
    /// to it and not to every device of the caller's account.
    initiator_device: Option<String>,
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
            devices: HashMap::new(),
            initiator_device: None,
        }
    }
}

/// Why an account is leaving its voice room. Only an explicit hang-up is remembered
/// (see `mark_voice_room_ended`): a WebSocket that closed or a switch to another room
/// is exactly what a later keepalive is allowed to recover from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VoiceLeave {
    Explicit,
    Implicit,
}

/// How long an explicit end is remembered. Long enough to outlast any presence timer
/// a client could still have running for that room; a genuinely new call gets a new
/// room id anyway.
const ENDED_VOICE_ROOM_TTL: Duration = Duration::from_secs(30 * 60);

/// The device a voice event came from, as the client names it (`device`, see
/// voiceEventPayload). Bounded so a client cannot park arbitrary data in room state.
fn event_device(payload: &serde_json::Value) -> String {
    payload["device"]
        .as_str()
        .map(str::trim)
        .filter(|device| device.len() <= 128)
        .unwrap_or_default()
        .to_string()
}

/// Addresses an event to one device of the recipient account. The server cannot
/// route by device (sockets are not tagged with one, and a native shell holds two per
/// device), so every socket still gets the frame and the client drops what is not
/// its own (`targetDevice`, see handleVoiceEvent).
fn targeted(mut payload: serde_json::Value, device: &str) -> serde_json::Value {
    if !device.is_empty() {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "targetDevice".to_string(),
                serde_json::Value::String(device.to_string()),
            );
        }
    }
    payload
}

/// Two device ids name different devices only when both are known — an old client
/// that sends none is never treated as a stranger to its own call.
fn other_device(holder: &str, device: &str) -> bool {
    !holder.is_empty() && !device.is_empty() && holder != device
}

fn member_device(state: &Arc<AppState>, room_id: &str, username: &str) -> String {
    state
        .voice_rooms
        .get(room_id)
        .and_then(|room| room.devices.get(username).cloned())
        .unwrap_or_default()
}

fn member_end_key(room_id: &str, username: &str) -> String {
    format!("{}\n{}", room_id, username)
}

/// Remembers that a room (DM: the whole room; channel: one account's place in it) was
/// ended on purpose, so a presence keepalive still ticking somewhere cannot rebuild it.
fn mark_voice_room_ended(state: &Arc<AppState>, key: String) {
    let now = Instant::now();
    if state.ended_voice_rooms.len() > 2048 {
        state
            .ended_voice_rooms
            .retain(|_, at| now.duration_since(*at) < ENDED_VOICE_ROOM_TTL);
    }
    state.ended_voice_rooms.insert(key, now);
}

fn voice_room_ended(state: &Arc<AppState>, key: &str) -> bool {
    match state.ended_voice_rooms.get(key).map(|at| at.elapsed()) {
        Some(age) if age < ENDED_VOICE_ROOM_TTL => true,
        Some(_) => {
            state.ended_voice_rooms.remove(key);
            false
        }
        None => false,
    }
}

fn session_moved_payload(room_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "voice_error",
        "roomId": room_id,
        "code": "session_moved",
        "message": "Звонок продолжен на другом устройстве",
    })
}

async fn send_voice_error(
    state: &Arc<AppState>,
    username: &str,
    device: &str,
    room_id: &str,
    code: &str,
    message: &str,
) {
    // To the device that asked. An error about one device's request used to reach
    // every device of the account, and `room_not_found` ends the call wherever it
    // lands.
    send_json_to_user(
        state,
        username,
        targeted(
            serde_json::json!({
                "type": "voice_error",
                "roomId": room_id,
                "code": code,
                "message": message,
            }),
            device,
        ),
    )
    .await;
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
            // Only the device holding the call may adopt it from the reconnect
            // snapshot; another device of the account connecting must not.
            let device = room.devices.get(username).cloned().unwrap_or_default();
            payloads.push(targeted(voice_room_payload(room_id.value(), room.value()), &device));
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
                // The caller's ringing belongs to the device that dialled; the callee
                // rings on every device.
                let device = if initiator_match {
                    room.initiator_device.clone().unwrap_or_default()
                } else {
                    String::new()
                };
                payloads.push(targeted(voice_room_payload(&room_id, room), &device));
            }
        }
    }

    for payload in payloads {
        send_json_to_user(state, username, payload).await;
    }
}

async fn broadcast_voice_room_state(state: &Arc<AppState>, room_id: &str) {
    // Copied out and the map guard dropped before the first await: the guard used to
    // live across every send below, holding a voice_rooms shard lock through
    // arbitrary socket I/O.
    let Some((payload, devices)) = state
        .voice_rooms
        .get(room_id)
        .map(|room| (voice_room_payload(room_id, room.value()), room.devices.clone()))
    else {
        return;
    };
    let participants = payload["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect::<Vec<_>>();
    for participant in participants {
        let device = devices.get(&participant).cloned().unwrap_or_default();
        send_json_to_user(state, &participant, targeted(payload.clone(), &device)).await;
    }
}

pub(crate) async fn leave_voice_room(state: &Arc<AppState>, username: &str, reason: VoiceLeave) {
    let room_id = match state.user_voice_rooms.remove(username) {
        Some((_, room_id)) => room_id,
        None => return,
    };
    info!("[VOICE] '{}' leaves room {} ({:?})", username, room_id, reason);

    let mut room_type = String::new();
    let mut remaining_participants: Vec<String> = Vec::new();
    let mut devices: HashMap<String, String> = HashMap::new();
    let mut remove_room = false;
    if let Some(mut room) = state.voice_rooms.get_mut(&room_id) {
        room_type = room.room_type.clone();
        room.participants.remove(username);
        room.devices.remove(username);
        remaining_participants = room.participants.iter().cloned().collect();
        devices = room.devices.clone();
        remove_room =
            room.participants.is_empty() || (room_type == "dm" && room.participants.len() <= 1);
    }

    if reason == VoiceLeave::Explicit {
        if room_type == "dm" {
            // The whole DM room is over. Without this the other side's presence
            // keepalive — or this side's, from a device that missed the hang-up —
            // rebuilt it through restore_dm_room within 8 s, and that client sat
            // alone in a "connected" call forever, auto-rejecting every new call to
            // it as busy.
            mark_voice_room_ended(state, room_id.clone());
        } else {
            mark_voice_room_ended(state, member_end_key(&room_id, username));
        }
    }

    if remove_room {
        info!("[VOICE] removing room {} ({})", room_id, room_type);
        state.voice_rooms.remove(&room_id);
        if room_type == "dm" {
            for participant in remaining_participants {
                let device = devices.get(&participant).cloned().unwrap_or_default();
                send_json_to_user(
                    state,
                    &participant,
                    targeted(
                        serde_json::json!({
                            "type": "voice_call_ended",
                            "roomId": room_id,
                            "from": username,
                        }),
                        &device,
                    ),
                )
                .await;
            }
        }
    } else {
        broadcast_voice_room_state(state, &room_id).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn join_voice_room(
    state: &Arc<AppState>,
    username: &str,
    device: &str,
    room_id: &str,
    room_type: &str,
    server_id: Option<&str>,
    channel_id: Option<&str>,
    keepalive: bool,
) {
    info!(
        "[VOICE] '{}' joining room {} ({}) keepalive={} device={}",
        username, room_id, room_type, keepalive, device
    );
    let current_room = state
        .user_voice_rooms
        .get(username)
        .map(|current| current.value().clone());
    let should_leave_current_room = current_room.as_deref() != Some(room_id);

    // user_voice_rooms is keyed by USERNAME, so a user can only be in one voice
    // room account-wide: joining evicts whatever room they were in. That is fine
    // for an explicit join, but a keepalive must never do it — with the same
    // account signed in on two devices sitting in two different rooms, each
    // device's keepalive would evict the other every few seconds, flapping both
    // calls forever. Absent mapping (the eviction we are recovering from) is not
    // "a different room", so the recovery path still works.
    if keepalive && should_leave_current_room {
        if let Some(current) = current_room.as_deref() {
            info!(
                "[VOICE] ignoring keepalive from '{}' for {} — already in another room",
                username, room_id
            );
            // And when that other room is held by another device, the one ticking here
            // is a device whose call was moved away. Tell it, or it keeps a dead call
            // on screen and re-asserts it every 8 s.
            if other_device(&member_device(state, current, username), device) {
                send_json_to_user(state, username, targeted(session_moved_payload(room_id), device))
                    .await;
            }
            return;
        }
    }

    // The same account's place in THIS room is held by another device: a keepalive from
    // here is a leftover timer, not a member re-asserting itself, and must not refresh
    // (or re-route) anything.
    if keepalive
        && !should_leave_current_room
        && other_device(&member_device(state, room_id, username), device)
    {
        info!(
            "[VOICE] ignoring keepalive from '{}' device={} for {} — held by another device",
            username, device, room_id
        );
        send_json_to_user(state, username, targeted(session_moved_payload(room_id), device)).await;
        return;
    }

    if should_leave_current_room {
        if let Some(previous) = current_room.as_deref() {
            let previous_holder = member_device(state, previous, username);
            if other_device(&previous_holder, device) {
                // Joining here takes the account out of the call another of its
                // devices is in; that device has to hear it from us.
                send_json_to_user(
                    state,
                    username,
                    targeted(session_moved_payload(previous), &previous_holder),
                )
                .await;
            }
        }
        leave_voice_room(state, username, VoiceLeave::Implicit).await;
    }

    if !keepalive {
        // A real join is the user asking to be here again.
        state
            .ended_voice_rooms
            .remove(&member_end_key(room_id, username));
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

    let (roster_changed, displaced) = {
        let room = room.value_mut();
        room.room_type = room_type.to_string();
        room.server_id = server_id.map(|v| v.to_string());
        room.channel_id = channel_id.map(|v| v.to_string());
        let displaced = room
            .devices
            .get(username)
            .filter(|held| other_device(held.as_str(), device))
            .cloned();
        if !device.is_empty() {
            room.devices.insert(username.to_string(), device.to_string());
        } else if !keepalive {
            // An explicit join from a client that names no device: nothing to target.
            room.devices.remove(username);
        }
        (room.participants.insert(username.to_string()), displaced)
    };
    drop(room); // release DashMap shard lock before re-entering voice_rooms via broadcast

    if let Some(previous) = displaced {
        info!(
            "[VOICE] '{}' moved room {} from device={} to device={}",
            username, room_id, previous, device
        );
        send_json_to_user(state, username, targeted(session_moved_payload(room_id), &previous)).await;
    }

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
            room.devices.clone(),
        )
    });
    let Some((room_type, call_state, initiator, room_target, participants, devices)) = room_snapshot
    else {
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
    // The account is in the room, but through another device. Offers from here are
    // what left a peer applying descriptions from two machines to one connection:
    // ICE connected, DTLS never did, and the call carried no audio at all.
    let sender_device = event_device(payload);
    let sender_holder = devices.get(sender).cloned().unwrap_or_default();
    if other_device(&sender_holder, &sender_device) {
        warn!(
            "[VOICE][ROUTE] reject signal from a device not in the call sender={} device={} holder={} roomId={}",
            sender, sender_device, sender_holder, room_id
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
    if let Some(object) = signal.as_object_mut() {
        // Addressing is the server's to decide, never the sender's.
        object.remove("targetDevice");
    }

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
        let target_device = devices.get(&target).cloned().unwrap_or_default();
        info!(
            "[VOICE][ROUTE] direct from={} to={} roomId={} signalType={} active_ws={} device={}",
            sender,
            target,
            room_id,
            payload["signal"]["type"].as_str().unwrap_or_default(),
            active_ws,
            target_device
        );
        send_json_to_user(state, &target, targeted(signal, &target_device)).await;
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
        let device = devices.get(&participant).cloned().unwrap_or_default();
        send_json_to_user(state, &participant, targeted(signal.clone(), &device)).await;
    }
}

pub(crate) async fn handle_voice_event(
    state: &Arc<AppState>,
    sender: &str,
    payload: &serde_json::Value,
) {
    let event_type = payload["type"].as_str().unwrap_or_default();
    let device = event_device(payload);
    info!(
        "[VOICE][EVENT] user={} type={} roomId={} roomType={} target={} inviter={} from={} device={}",
        sender,
        event_type,
        payload["roomId"].as_str().unwrap_or_default(),
        payload["roomType"].as_str().unwrap_or_default(),
        payload["target"].as_str().unwrap_or_default(),
        payload["inviter"].as_str().unwrap_or_default(),
        payload["from"].as_str().unwrap_or_default(),
        device
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
                            send_voice_error(
                                state,
                                sender,
                                &device,
                                &room_id,
                                "channel_forbidden",
                                "Нет доступа к голосовому каналу",
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
                        send_voice_error(
                            state,
                            sender,
                            &device,
                            &room_id,
                            "bad_request",
                            "Необходимо указать server_id и channel_id",
                        )
                        .await;
                        return;
                    }
                }
                // A keepalive for a room that does not list us is either a room the
                // server forgot (a restart — every deploy — or the 150 s eviction after
                // a long outage) or one we left on purpose. The first must be recovered:
                // 0.2b36 refused both with room_not_found, which the client obeys by
                // hanging up, so every deploy ended every channel call two seconds after
                // the server came back (production, 2026-09-10 21:10:37). Only the second
                // is final, and only an explicit leave records it. Channel access itself
                // was already checked above, same as for a real join.
                if keepalive
                    && !state
                        .voice_rooms
                        .get(&room_id)
                        .map(|room| room.participants.contains(sender))
                        .unwrap_or(false)
                    && voice_room_ended(state, &member_end_key(&room_id, sender))
                {
                    send_voice_error(
                        state,
                        sender,
                        &device,
                        &room_id,
                        "room_not_found",
                        "Голосовой канал больше не активен для вас",
                    )
                    .await;
                    return;
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
                    // Rebuilt when the server forgot it — never after a real hang-up.
                    None => {
                        keepalive
                            && !voice_room_ended(state, &room_id)
                            && dm_room_claim_authorized(state, sender, &room_id).await
                    }
                    Some(false) => {
                        keepalive && dm_room_claim_authorized(state, sender, &room_id).await
                    }
                };
                if !allowed {
                    let (code, message) = if membership.is_none() {
                        ("room_not_found", "Голосовая комната не найдена")
                    } else {
                        ("room_forbidden", "Нет доступа к голосовой переписке")
                    };
                    send_voice_error(state, sender, &device, &room_id, code, message).await;
                    return;
                }
                if membership.is_none() {
                    restore_dm_room(state, sender, &room_id);
                }
            }

            join_voice_room(
                state,
                sender,
                &device,
                &room_id,
                room_type,
                server_id.as_deref(),
                channel_id.as_deref(),
                keepalive,
            )
            .await;
        }
        "voice_leave" => {
            info!("[VOICE][LEAVE] user={} device={} explicit_leave", sender, device);
            leave_voice_room_from_device(state, sender, &device, payload).await;
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
                    send_voice_error(
                        state,
                        sender,
                        &device,
                        &room_key,
                        "not_a_contact",
                        "Получатель должен быть в контактах",
                    )
                    .await;
                    return;
                }
                Err(e) => {
                    error!(
                        "Ошибка проверки контакта для voice_call_invite sender={} target={}: {}",
                        sender, target, e
                    );
                    send_voice_error(
                        state,
                        sender,
                        &device,
                        &room_key,
                        "contact_check_failed",
                        "Не удалось проверить контакты",
                    )
                    .await;
                    return;
                }
            }
            info!(
                "[VOICE][INVITE] from={} to={} roomId={} device={}",
                sender, target, room_key, device
            );
            // A new call, even under a reused id, is not the one that ended.
            state.ended_voice_rooms.remove(&room_key);
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
                room.devices.clear();
                room.initiator_device = (!device.is_empty()).then(|| device.clone());
            }
            // join_voice_room() already broadcasts the current room state (call_state
            // is already "ringing" above, before this call) — a second identical
            // broadcast here just doubled every invite's room-state traffic.
            join_voice_room(state, sender, &device, &room_key, "dm", None, None, false).await;
            // Rings on every device of the callee — any of them may answer.
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
            // But only the device that dialled is "calling".
            send_json_to_user(
                state,
                sender,
                targeted(
                    serde_json::json!({
                        "type": "voice_call_outgoing",
                        "roomId": room_key,
                        "roomType": "dm",
                        "target": target,
                    }),
                    &device,
                ),
            )
            .await;

            let timeout_state = Arc::clone(state);
            let timeout_room_id = room_key.clone();
            let timeout_inviter = sender.to_string();
            let timeout_target = target.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some((call_state, participants, initiator_device)) =
                    timeout_state.voice_rooms.get(&timeout_room_id).map(|room| {
                        (
                            room.call_state.clone(),
                            room.participants.iter().cloned().collect::<Vec<_>>(),
                            room.initiator_device.clone().unwrap_or_default(),
                        )
                    })
                else {
                    return;
                };
                if call_state != "ringing" {
                    return;
                }
                timeout_state.voice_rooms.remove(&timeout_room_id);
                mark_voice_room_ended(&timeout_state, timeout_room_id.clone());
                for participant in participants {
                    let device = if participant == timeout_inviter {
                        initiator_device.as_str()
                    } else {
                        ""
                    };
                    send_json_to_user(
                        &timeout_state,
                        &participant,
                        targeted(
                            serde_json::json!({
                                "type": "voice_call_missed",
                                "roomId": timeout_room_id.clone(),
                                "from": timeout_inviter.clone(),
                                "target": timeout_target.clone(),
                            }),
                            device,
                        ),
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

            join_voice_room(state, sender, &device, &room_id, "dm", None, None, false).await;

            let mut inviter_device = String::new();
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
                // The call now lives on exactly two devices: the one that dialled and
                // the one that answered.
                room.devices
                    .retain(|user, _| user.as_str() == sender || *user == inviter);
                inviter_device = room.initiator_device.clone().unwrap_or_default();
                if !inviter_device.is_empty() {
                    room.devices.insert(inviter.clone(), inviter_device.clone());
                }
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
            // Addressed per device. The callee's OTHER devices still receive it, see a
            // targetDevice that is not theirs and stop ringing
            // (handleVoiceEventForOtherDevice) — instead of all of them entering the
            // call and negotiating as the same user.
            let accepted_payload = serde_json::json!({
                "type": "voice_call_accepted",
                "roomId": room_id,
                "from": sender,
                "target": inviter,
                "participants": [sender, inviter],
            });
            send_json_to_user(state, &inviter, targeted(accepted_payload.clone(), &inviter_device)).await;
            send_json_to_user(state, sender, targeted(accepted_payload, &device)).await;
            let connected_payload = serde_json::json!({
                "type": "voice_call_connected",
                "roomId": room_id,
                "from": sender,
                "target": inviter,
                "participants": [sender, inviter],
            });
            send_json_to_user(state, &inviter, targeted(connected_payload.clone(), &inviter_device)).await;
            send_json_to_user(state, sender, targeted(connected_payload, &device)).await;
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
                "[VOICE][REJECT] from={} to={} roomId={} device={}",
                sender, inviter, room_id, device
            );
            let inviter_device = state
                .voice_rooms
                .get(&room_id)
                .and_then(|room| room.initiator_device.clone())
                .unwrap_or_default();
            state.voice_rooms.remove(&room_id);
            mark_voice_room_ended(state, room_id.clone());
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
            let rejected_payload = serde_json::json!({
                "type": "voice_call_rejected",
                "roomId": room_id,
                "from": sender,
                "target": inviter,
            });
            send_json_to_user(state, &inviter, targeted(rejected_payload.clone(), &inviter_device))
                .await;
            // And to the callee's own account: its other devices are still ringing for a
            // call that no longer exists (the room is gone, so not even the missed-call
            // timeout would stop them). The declining device has already reset.
            send_json_to_user(state, sender, rejected_payload).await;
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
            mark_voice_room_ended(state, room_id.clone());
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
            info!("[VOICE][END] from={} device={} explicit_end", sender, device);
            leave_voice_room_from_device(state, sender, &device, payload).await;
        }
        _ => {}
    }
}

/// An explicit hang-up (`voice_leave` / `voice_call_end`), checked against which room
/// and which device it actually speaks for. Both checks were missing: any device of the
/// account, about any room, removed the account from whatever room it was in NOW.
async fn leave_voice_room_from_device(
    state: &Arc<AppState>,
    sender: &str,
    device: &str,
    payload: &serde_json::Value,
) {
    let Some(current) = state
        .user_voice_rooms
        .get(sender)
        .map(|room| room.value().clone())
    else {
        return;
    };
    let named = payload["roomId"].as_str().map(str::trim).unwrap_or_default();
    if !named.is_empty() && named != current {
        info!(
            "[VOICE][LEAVE] ignoring leave for {} from '{}' — the account is in {}",
            named, sender, current
        );
        return;
    }
    let holder = member_device(state, &current, sender);
    if other_device(&holder, device) {
        warn!(
            "[VOICE][LEAVE] ignoring leave from '{}' device={} — {} is held by device={}",
            sender, device, current, holder
        );
        return;
    }
    leave_voice_room(state, sender, VoiceLeave::Explicit).await;
}
