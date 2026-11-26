//! Integration tests for voice-call signalling that are not about negotiation —
//! negotiation itself is covered end-to-end by `scripts/voice_doctor`, which runs
//! two real `ZaliInterface` instances against a simulated server. What that harness
//! cannot cover is the *real* server's room bookkeeping, so that is what lives here:
//! recovering a room the server has forgotten, and the TURN credentials it hands out.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_ws(app: &TestApp, user: &RegisteredUser) -> Ws {
    let mut request = app.ws_url("/ws").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", user.auth_header().parse().unwrap());
    let (stream, response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("ws connect");
    assert_eq!(response.status(), 101);
    stream
}

async fn create_server(app: &TestApp, owner: &RegisteredUser, name: &str) -> String {
    let resp = app
        .http
        .post(app.url("/api/servers"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "name": name, "is_public": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201, "create_server({}) failed", name);
    let body: serde_json::Value = resp.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

/// Creates a voice channel and returns its id. Channel creation replies with the
/// full channel list, not the one just created, so the new channel is picked out by
/// kind + name.
async fn create_voice_channel(
    app: &TestApp,
    owner: &RegisteredUser,
    server_id: &str,
    name: &str,
) -> String {
    let resp = app
        .http
        .post(app.url(&format!("/api/servers/{}/channels", server_id)))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "name": name, "kind": "voice" }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "create_voice_channel failed: {}", resp.status());
    let channels: serde_json::Value = resp.json().await.unwrap();
    channels
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name && c["kind"] == "voice")
        .expect("created voice channel must be in the list")["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn add_contact(app: &TestApp, user: &RegisteredUser, other: &str) {
    let resp = app
        .http
        .post(app.url("/api/contacts"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "username": other }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "add contact: {}", resp.status());
}

async fn send(ws: &mut Ws, payload: serde_json::Value) {
    ws.send(WsMessage::Text(payload.to_string())).await.unwrap();
}

/// Collects voice events for a short while. The server answers asynchronously and
/// interleaves room-state broadcasts with everything else, so a test that reads a
/// single frame is reading whichever one happened to be first.
async fn drain_voice_events(ws: &mut Ws, millis: u64) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(millis);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return out;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"]
                        .as_str()
                        .map(|t| t.starts_with("voice_"))
                        .unwrap_or(false)
                    {
                        out.push(value);
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => return out,
            Err(_) => return out,
        }
    }
}

fn find_event<'a>(events: &'a [serde_json::Value], event_type: &str) -> Option<&'a serde_json::Value> {
    events.iter().find(|e| e["type"] == event_type)
}

/// `voice_rooms` lives only in memory, so a server restart erases every call in
/// progress. Media keeps flowing (it is peer-to-peer) but signalling is dead, and a
/// DM room is only ever created by an invite — so nothing could bring it back: the
/// client's presence keepalive was answered with "room not found" forever, and the
/// call could no longer ICE-restart or renegotiate. It just went quiet the first
/// time the network hiccuped, and stayed that way.
#[tokio::test]
async fn dm_keepalive_rebuilds_a_room_the_server_has_forgotten() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    add_contact(&app, &alice, "bob").await;
    add_contact(&app, &bob, "alice").await;

    let mut alice_ws = connect_ws(&app, &alice).await;
    let room_id = "voice:dm:alice:bob:restored";

    // No invite was ever sent on this server instance — exactly the state a restart
    // leaves behind for a call that was already in progress.
    send(
        &mut alice_ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "dm",
            "keepalive": true,
        }),
    )
    .await;

    let events = drain_voice_events(&mut alice_ws, 500).await;
    assert!(
        find_event(&events, "voice_error").is_none(),
        "keepalive should rebuild the room, not report it missing: {events:?}"
    );
    let state = find_event(&events, "voice_room_state")
        .expect("rebuilt room must be announced back to the sender");
    assert_eq!(state["roomId"], room_id);
    assert_eq!(
        state["participants"],
        serde_json::json!(["alice"]),
        "only the sender is restored — the peer may genuinely have hung up while we were down"
    );

    // And the peer rejoins it on its own keepalive, which is what makes the call
    // whole again rather than leaving one side talking to an empty room.
    let mut bob_ws = connect_ws(&app, &bob).await;
    send(
        &mut bob_ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "dm",
            "keepalive": true,
        }),
    )
    .await;
    let bob_events = drain_voice_events(&mut bob_ws, 500).await;
    let bob_state =
        find_event(&bob_events, "voice_room_state").expect("peer must see the room it rejoined");
    let participants = bob_state["participants"].as_array().unwrap();
    assert_eq!(participants.len(), 2, "both sides back in: {participants:?}");
}

/// The room id carries the pair, so rebuilding from it is only safe under the same
/// checks an invite passes. Without them this would be "create me a room called
/// anything, with me in it".
#[tokio::test]
async fn dm_keepalive_refuses_to_rebuild_a_room_that_is_not_ours() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    register_user(&app, "carol", "hunter22").await;

    let mut alice_ws = connect_ws(&app, &alice).await;

    // A room between two other people.
    send(
        &mut alice_ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": "voice:dm:bob:carol:stamp",
            "roomType": "dm",
            "keepalive": true,
        }),
    )
    .await;
    let events = drain_voice_events(&mut alice_ws, 400).await;
    let error = find_event(&events, "voice_error").expect("must be refused");
    assert_eq!(error["code"], "room_not_found");

    // A room whose id names alice, but with someone she has no contact with.
    send(
        &mut alice_ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": "voice:dm:alice:bob:stamp",
            "roomType": "dm",
            "keepalive": true,
        }),
    )
    .await;
    let events = drain_voice_events(&mut alice_ws, 400).await;
    let error = find_event(&events, "voice_error").expect("non-contact must be refused");
    assert_eq!(error["code"], "room_not_found");
}

/// A plain join is not a recovery: a client asking to join a DM room that does not
/// exist is asking for a call nobody started.
#[tokio::test]
async fn dm_join_without_keepalive_still_reports_a_missing_room() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    add_contact(&app, &alice, "bob").await;
    add_contact(&app, &bob, "alice").await;

    let mut alice_ws = connect_ws(&app, &alice).await;
    send(
        &mut alice_ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": "voice:dm:alice:bob:never-existed",
            "roomType": "dm",
        }),
    )
    .await;

    let events = drain_voice_events(&mut alice_ws, 400).await;
    let error = find_event(&events, "voice_error").expect("plain join must still report it");
    assert_eq!(error["code"], "room_not_found");
}

/// A channel keepalive is a membership *re-assert*, not a way to get put into the
/// room in the first place — that distinction is what the dm_keepalive tests above
/// already check for DM rooms, via contact/room-id authorisation. Channel rooms have
/// no such check: `can_access_channel` alone gates a real join, and until this test
/// existed a keepalive rode the same permission through `join_voice_room`, which
/// cannot tell "known member reconnecting" from "stranger asking to be let in" — both
/// look like an absent `user_voice_rooms` entry. A client whose local `voice.roomId`
/// survived past the server's 150 s WS-close eviction (a laptop sleep, a Wi-Fi roam,
/// any reconnect gap longer than that window) would silently rejoin the channel call
/// on its very next presence tick, with nothing the user did to ask for it.
#[tokio::test]
async fn channel_keepalive_does_not_resurrect_a_room_you_left() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "voice-room").await;
    let room_id = format!("voice:channel:{}:{}", server_id, channel_id);

    let mut ws = connect_ws(&app, &alice).await;

    // A real join is always allowed and puts alice in the room.
    send(
        &mut ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
        }),
    )
    .await;
    let events = drain_voice_events(&mut ws, 400).await;
    let state = find_event(&events, "voice_room_state").expect("real join must succeed");
    assert_eq!(state["participants"], serde_json::json!(["alice"]));

    // She leaves explicitly — the same call the 150 s WS-close cleanup makes on a
    // real timeout, so this exercises the exact server-side state a stale reconnect
    // would find.
    send(&mut ws, serde_json::json!({ "type": "voice_leave" })).await;
    let _ = drain_voice_events(&mut ws, 200).await;

    // Her client's local voice.roomId is still this room (nothing told it otherwise),
    // so its presence timer keeps firing — a keepalive for a room she is no longer
    // a member of must be refused, not silently grant her membership back.
    send(
        &mut ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
            "keepalive": true,
        }),
    )
    .await;
    let events = drain_voice_events(&mut ws, 400).await;
    assert!(
        find_event(&events, "voice_room_state").is_none(),
        "keepalive must not resurrect membership after an explicit leave: {events:?}"
    );
    let error = find_event(&events, "voice_error").expect("must be told the room is gone");
    assert_eq!(error["code"], "room_not_found");
}

/// The self-heal a channel keepalive exists for: a still-current member's presence
/// tick must keep working, refreshing their own membership without needing to
/// rejoin explicitly.
#[tokio::test]
async fn channel_keepalive_refreshes_membership_while_still_in_the_room() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "voice-room").await;
    let room_id = format!("voice:channel:{}:{}", server_id, channel_id);

    let mut ws = connect_ws(&app, &alice).await;
    send(
        &mut ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
        }),
    )
    .await;
    let _ = drain_voice_events(&mut ws, 300).await;

    send(
        &mut ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
            "keepalive": true,
        }),
    )
    .await;
    let events = drain_voice_events(&mut ws, 400).await;
    assert!(
        find_event(&events, "voice_error").is_none(),
        "a keepalive from a still-current member must not be refused: {events:?}"
    );
    let state = find_event(&events, "voice_room_state").expect("membership must be reaffirmed");
    assert_eq!(state["participants"], serde_json::json!(["alice"]));
}

/// `voice_rooms` lives in memory, so a restart (every deploy) forgets every channel
/// call in progress. 0.2b36 answered the members' keepalives with `room_not_found`,
/// which the client obeys by hanging up — so each deploy ended every channel call two
/// seconds after the server came back. A room the server merely forgot is recovered;
/// only an explicit leave (the test above) is final.
#[tokio::test]
async fn channel_keepalive_rebuilds_membership_the_server_has_forgotten() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "voice-room").await;
    let room_id = format!("voice:channel:{}:{}", server_id, channel_id);

    let mut ws = connect_ws(&app, &alice).await;
    // Never joined on this server instance: what a restart leaves behind.
    send(
        &mut ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
            "keepalive": true,
            "device": "mac-1",
        }),
    )
    .await;
    let events = drain_voice_events(&mut ws, 400).await;
    assert!(
        find_event(&events, "voice_error").is_none(),
        "a forgotten room must be recovered, not declared gone: {events:?}"
    );
    let state = find_event(&events, "voice_room_state").expect("membership must come back");
    assert_eq!(state["participants"], serde_json::json!(["alice"]));
    assert_eq!(state["targetDevice"], "mac-1");
}

/// Production, 2026-09-10: one account signed in on two Macs. The one that was not in
/// the channel call sent `voice_leave`, the server removed the account from the room,
/// and the Mac actually talking was hung up by its own next keepalive.
#[tokio::test]
async fn a_second_device_cannot_leave_a_call_it_is_not_in() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "voice-room").await;
    let room_id = format!("voice:channel:{}:{}", server_id, channel_id);
    let join = |device: &str, keepalive: bool| {
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
            "keepalive": keepalive,
            "device": device,
        })
    };

    let mut in_call = connect_ws(&app, &alice).await;
    let mut idle = connect_ws(&app, &alice).await;
    send(&mut in_call, join("mac-1", false)).await;
    let _ = drain_voice_events(&mut in_call, 300).await;
    let _ = drain_voice_events(&mut idle, 100).await;

    send(
        &mut idle,
        serde_json::json!({ "type": "voice_leave", "roomId": room_id, "device": "mac-2" }),
    )
    .await;
    let _ = drain_voice_events(&mut idle, 300).await;

    send(&mut in_call, join("mac-1", true)).await;
    let events = drain_voice_events(&mut in_call, 400).await;
    assert!(
        find_event(&events, "voice_error").is_none(),
        "the device in the call must still be in it: {events:?}"
    );
    let state = find_event(&events, "voice_room_state").expect("membership reaffirmed");
    assert_eq!(state["participants"], serde_json::json!(["alice"]));
}

/// Joining on another device takes the call there, and the device that had it is told
/// so — addressed to it alone, with a `vid` so its two sockets deliver it once.
#[tokio::test]
async fn joining_on_another_device_moves_the_call_and_tells_the_old_one() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "voice-room").await;
    let room_id = format!("voice:channel:{}:{}", server_id, channel_id);
    let join = |device: &str, keepalive: bool| {
        serde_json::json!({
            "type": "voice_join",
            "roomId": room_id,
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
            "keepalive": keepalive,
            "device": device,
        })
    };

    let mut first = connect_ws(&app, &alice).await;
    let mut second = connect_ws(&app, &alice).await;
    send(&mut first, join("mac-1", false)).await;
    let _ = drain_voice_events(&mut first, 300).await;
    let _ = drain_voice_events(&mut second, 100).await;

    send(&mut second, join("mac-2", false)).await;
    let events = drain_voice_events(&mut first, 400).await;
    let moved = events
        .iter()
        .find(|e| e["type"] == "voice_error" && e["code"] == "session_moved")
        .expect("the old device must be told the call moved");
    assert_eq!(moved["targetDevice"], "mac-1");
    assert!(
        moved["vid"].as_str().is_some_and(|vid| vid.starts_with("srv:")),
        "server-made voice events need a vid: {moved}"
    );

    // Its leftover presence timer is refused, not allowed to take the call back.
    send(&mut first, join("mac-1", true)).await;
    let events = drain_voice_events(&mut first, 400).await;
    let refused = find_event(&events, "voice_error").expect("stale keepalive must be refused");
    assert_eq!(refused["code"], "session_moved");
    assert!(
        events
            .iter()
            .all(|e| e["type"] != "voice_room_state" || e["targetDevice"] == "mac-2"),
        "nothing about the room may be addressed to the old device: {events:?}"
    );
}

/// The DM half of the same incident: the callee's idle second device hung the call up
/// three seconds after the first one answered. And the idle device's signals must not
/// reach the caller either — two machines offering into one connection is a call with
/// ICE up and no audio.
#[tokio::test]
async fn a_second_device_cannot_hang_up_or_signal_into_a_dm_call() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    add_contact(&app, &alice, "bob").await;
    add_contact(&app, &bob, "alice").await;
    let room_id = "voice:dm:alice:bob:two-devices";

    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_answering = connect_ws(&app, &bob).await;
    let mut bob_idle = connect_ws(&app, &bob).await;

    send(
        &mut alice_ws,
        serde_json::json!({
            "type": "voice_call_invite", "roomId": room_id, "target": "bob", "device": "alice-1",
        }),
    )
    .await;
    let _ = drain_voice_events(&mut bob_idle, 300).await;
    send(
        &mut bob_answering,
        serde_json::json!({
            "type": "voice_call_accept", "roomId": room_id, "inviter": "alice", "device": "bob-1",
        }),
    )
    .await;
    let bob_events = drain_voice_events(&mut bob_answering, 400).await;
    let accepted = find_event(&bob_events, "voice_call_accepted").expect("accept must be confirmed");
    assert_eq!(accepted["targetDevice"], "bob-1", "only the answering device joins the call");
    let alice_events = drain_voice_events(&mut alice_ws, 300).await;
    let accepted = find_event(&alice_events, "voice_call_accepted").expect("caller must hear it");
    assert_eq!(accepted["targetDevice"], "alice-1");
    let _ = drain_voice_events(&mut bob_idle, 100).await;

    send(
        &mut bob_idle,
        serde_json::json!({
            "type": "voice_signal", "roomId": room_id, "to": "alice", "device": "bob-2",
            "signal": { "type": "offer", "sdp": { "type": "offer", "sdp": "v=0" } },
        }),
    )
    .await;
    send(
        &mut bob_idle,
        serde_json::json!({ "type": "voice_leave", "roomId": room_id, "device": "bob-2" }),
    )
    .await;
    let alice_events = drain_voice_events(&mut alice_ws, 400).await;
    assert!(
        find_event(&alice_events, "voice_call_ended").is_none()
            && find_event(&alice_events, "voice_signal").is_none(),
        "the idle device must neither end the call nor signal into it: {alice_events:?}"
    );

    // The answering device's keepalive still finds the call whole.
    send(
        &mut bob_answering,
        serde_json::json!({
            "type": "voice_join", "roomId": room_id, "roomType": "dm", "keepalive": true, "device": "bob-1",
        }),
    )
    .await;
    let bob_events = drain_voice_events(&mut bob_answering, 400).await;
    assert!(find_event(&bob_events, "voice_error").is_none(), "call intact: {bob_events:?}");
}

/// After a real hang-up the other side's presence keepalive used to rebuild the DM
/// room through restore_dm_room, and that client sat alone in a "connected" call,
/// auto-rejecting every new call to it as busy.
#[tokio::test]
async fn dm_keepalive_does_not_rebuild_a_call_that_was_hung_up() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    add_contact(&app, &alice, "bob").await;
    add_contact(&app, &bob, "alice").await;
    let room_id = "voice:dm:alice:bob:hung-up";

    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    send(
        &mut alice_ws,
        serde_json::json!({ "type": "voice_call_invite", "roomId": room_id, "target": "bob", "device": "a" }),
    )
    .await;
    let _ = drain_voice_events(&mut bob_ws, 300).await;
    send(
        &mut bob_ws,
        serde_json::json!({ "type": "voice_call_accept", "roomId": room_id, "inviter": "alice", "device": "b" }),
    )
    .await;
    let _ = drain_voice_events(&mut bob_ws, 300).await;
    let _ = drain_voice_events(&mut alice_ws, 100).await;

    send(
        &mut alice_ws,
        serde_json::json!({ "type": "voice_leave", "roomId": room_id, "device": "a" }),
    )
    .await;
    let bob_events = drain_voice_events(&mut bob_ws, 400).await;
    assert!(find_event(&bob_events, "voice_call_ended").is_some(), "{bob_events:?}");

    // Bob's client missed it (say, a reconnect in that very second) and keeps ticking.
    send(
        &mut bob_ws,
        serde_json::json!({ "type": "voice_join", "roomId": room_id, "roomType": "dm", "keepalive": true, "device": "b" }),
    )
    .await;
    let bob_events = drain_voice_events(&mut bob_ws, 400).await;
    assert!(
        find_event(&bob_events, "voice_room_state").is_none(),
        "a hung-up call must not be rebuilt: {bob_events:?}"
    );
    let error = find_event(&bob_events, "voice_error").expect("must be told the call is over");
    assert_eq!(error["code"], "room_not_found");
}

/// A DM removed by an implicit leave (WebSocket eviction, switching rooms) while the
/// other side is online is over: the other side was told `voice_call_ended` and left.
/// The leaver's client used to rebuild it with its next keepalive and sit in it alone
/// (2026-11-20: an Android app restarted mid-call, its old socket evicted 150 s later).
/// Eviction itself waits 150 s, so the room switch drives the same implicit path here.
#[tokio::test]
async fn dm_keepalive_does_not_rebuild_a_call_ended_by_an_implicit_leave() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    add_contact(&app, &alice, "bob").await;
    add_contact(&app, &bob, "alice").await;
    let server_id = create_server(&app, &alice, "implicit-leave").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "general").await;
    let room_id = "voice:dm:alice:bob:implicit";

    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    send(
        &mut alice_ws,
        serde_json::json!({ "type": "voice_call_invite", "roomId": room_id, "target": "bob", "device": "a" }),
    )
    .await;
    let _ = drain_voice_events(&mut bob_ws, 300).await;
    send(
        &mut bob_ws,
        serde_json::json!({ "type": "voice_call_accept", "roomId": room_id, "inviter": "alice", "device": "b" }),
    )
    .await;
    let _ = drain_voice_events(&mut bob_ws, 300).await;
    let _ = drain_voice_events(&mut alice_ws, 100).await;

    // Not a hang-up: alice's account moves to another room.
    send(
        &mut alice_ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": format!("voice:channel:{}:{}", server_id, channel_id),
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
            "device": "a",
        }),
    )
    .await;
    let bob_events = drain_voice_events(&mut bob_ws, 400).await;
    assert!(find_event(&bob_events, "voice_call_ended").is_some(), "{bob_events:?}");
    let _ = drain_voice_events(&mut alice_ws, 200).await;

    // A stale page of alice's (the one that was evicted) keeps ticking for the DM.
    send(
        &mut alice_ws,
        serde_json::json!({ "type": "voice_join", "roomId": room_id, "roomType": "dm", "keepalive": true, "device": "a2" }),
    )
    .await;
    let alice_events = drain_voice_events(&mut alice_ws, 400).await;
    assert!(
        !alice_events.iter().any(|e| e["type"] == "voice_room_state" && e["roomId"] == room_id),
        "a DM the other side was told is over must not be rebuilt: {alice_events:?}"
    );
    let error = find_event(&alice_events, "voice_error").expect("must be told the call is over");
    assert_eq!(error["code"], "room_not_found");
}

/// Every `voice_error` carries a machine-readable `code`. The client ends a call on
/// `room_not_found`, and matching that on the Russian prose in `message` would come
/// apart the first time someone rewords it.
#[tokio::test]
async fn voice_errors_carry_a_machine_readable_code() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    let mut ws = connect_ws(&app, &alice).await;
    send(
        &mut ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": "voice:channel:server-1:channel-1",
            "roomType": "channel",
        }),
    )
    .await;

    let events = drain_voice_events(&mut ws, 400).await;
    let error = find_event(&events, "voice_error").expect("join without ids must error");
    assert!(
        error["code"].as_str().is_some_and(|c| !c.is_empty()),
        "every voice_error needs a code: {error}"
    );
}

/// Rotating TURN credentials are opt-in per deployment: with no secret configured
/// the route is absent and the client keeps using the static pair compiled into its
/// bundle, exactly as before. With one configured, the credential is the RFC 5766
/// REST form coturn validates in `use-auth-secret` mode.
///
/// Every assertion about this route lives in ONE test on purpose: the environment
/// variable is process-global and `cargo test` runs tests in the same binary in
/// parallel, so splitting them lets one test's setup decide another's answer — as
/// it did on the first run here, where the "unconfigured deployments 404" case saw
/// the secret another test had just set.
#[tokio::test]
async fn turn_credentials_are_opt_in_and_time_limited() {
    std::env::remove_var("TURN_STATIC_AUTH_SECRET");
    std::env::remove_var("TURN_URLS");
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    let resp = app
        .http
        .get(app.url("/api/voice/turn-credentials"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        404,
        "unconfigured deployments must not advertise the route"
    );

    std::env::set_var("TURN_STATIC_AUTH_SECRET", "test-turn-secret");
    std::env::set_var("TURN_URLS", "turn:example.org:3478?transport=udp");
    std::env::set_var("TURN_CREDENTIAL_TTL_SECS", "600");
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    let resp = app
        .http
        .get(app.url("/api/voice/turn-credentials"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();

    let username = body["username"].as_str().unwrap();
    let (expiry, user) = username.split_once(':').expect("username is <expiry>:<user>");
    assert_eq!(user, "alice");
    let expiry: i64 = expiry.parse().expect("expiry is a unix timestamp");
    let now = chrono::Utc::now().timestamp();
    assert!(
        expiry > now && expiry <= now + 600 + 5,
        "credential must expire, and within the configured ttl (expiry={expiry} now={now})"
    );
    assert_eq!(body["ttl"], 600);
    assert_eq!(
        body["urls"],
        serde_json::json!(["turn:example.org:3478?transport=udp"])
    );

    // The password is exactly what coturn recomputes: base64(HMAC-SHA1(secret, username)).
    // Getting this wrong produces a relay that rejects every client, which looks
    // identical to a relay that is down.
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    let mut mac = <Hmac<Sha1>>::new_from_slice(b"test-turn-secret").unwrap();
    mac.update(username.as_bytes());
    let expected = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    assert_eq!(body["credential"].as_str().unwrap(), expected);

    // Unauthenticated callers get none: the relay is a paid resource, and an open
    // credential endpoint is an open relay with one extra step.
    let resp = app
        .http
        .get(app.url("/api/voice/turn-credentials"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);

    // A credential with no relay to use it on is not a credential.
    std::env::set_var("TURN_URLS", "");
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let resp = app
        .http
        .get(app.url("/api/voice/turn-credentials"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404, "no urls means the feature is off");

    std::env::remove_var("TURN_STATIC_AUTH_SECRET");
    std::env::remove_var("TURN_URLS");
    std::env::remove_var("TURN_CREDENTIAL_TTL_SECS");
}


/// Id комнаты в приглашении обязан называть пару «звонящий — адресат». Раньше
/// invite с id чужого звонка перезаписывал существующую комнату и вешал трубку.
#[tokio::test]
async fn an_invite_cannot_hijack_someone_elses_call_room() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;
    add_contact(&app, &alice, "bob").await;
    add_contact(&app, &bob, "alice").await;
    add_contact(&app, &mallory, "bob").await;
    let room_id = "voice:dm:alice:bob:victim-call";

    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    let mut mallory_ws = connect_ws(&app, &mallory).await;
    send(
        &mut alice_ws,
        serde_json::json!({ "type": "voice_call_invite", "roomId": room_id, "target": "bob", "device": "a1" }),
    )
    .await;
    let _ = drain_voice_events(&mut bob_ws, 300).await;
    send(
        &mut bob_ws,
        serde_json::json!({ "type": "voice_call_accept", "roomId": room_id, "inviter": "alice", "device": "b1" }),
    )
    .await;
    let _ = drain_voice_events(&mut bob_ws, 300).await;
    let _ = drain_voice_events(&mut alice_ws, 300).await;

    send(
        &mut mallory_ws,
        serde_json::json!({ "type": "voice_call_invite", "roomId": room_id, "target": "bob", "device": "m1" }),
    )
    .await;
    let mallory_events = drain_voice_events(&mut mallory_ws, 400).await;
    let error = find_event(&mallory_events, "voice_error").expect("hijack must be refused");
    assert_eq!(error["code"], "bad_request");
    let bob_events = drain_voice_events(&mut bob_ws, 300).await;
    assert!(find_event(&bob_events, "voice_call_invite").is_none(), "{bob_events:?}");

    // Звонок alice—bob жив: keepalive bob находит себя в комнате.
    send(
        &mut bob_ws,
        serde_json::json!({ "type": "voice_join", "roomId": room_id, "roomType": "dm", "keepalive": true, "device": "b1" }),
    )
    .await;
    let bob_events = drain_voice_events(&mut bob_ws, 400).await;
    assert!(find_event(&bob_events, "voice_error").is_none(), "call intact: {bob_events:?}");
}

/// Вход в канал проверяет права по serverId/channelId — значит и roomId обязан быть
/// комнатой этого канала. Иначе доступа к своему каналу хватало, чтобы войти в
/// чужую голосовую комнату.
#[tokio::test]
async fn a_channel_join_cannot_name_a_foreign_room() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "voice-room").await;
    let mut ws = connect_ws(&app, &alice).await;

    for (room_id, room_type) in [
        ("voice:dm:bob:carol:private".to_string(), "channel"),
        (format!("voice:channel:{}:{}", server_id, channel_id), "whatever"),
    ] {
        send(
            &mut ws,
            serde_json::json!({
                "type": "voice_join", "roomId": room_id, "roomType": room_type,
                "serverId": server_id, "channelId": channel_id,
            }),
        )
        .await;
        let events = drain_voice_events(&mut ws, 400).await;
        assert!(find_event(&events, "voice_room_state").is_none(), "{room_type} {room_id}: {events:?}");
        assert_eq!(find_event(&events, "voice_error").expect("must be refused")["code"], "bad_request");
    }
}

// ── Присутствие в голосовых каналах и самоописание участников ────────────────

async fn join_channel(ws: &mut Ws, server_id: &str, channel_id: &str) {
    send(
        ws,
        serde_json::json!({
            "type": "voice_join",
            "roomId": format!("voice:channel:{}:{}", server_id, channel_id),
            "roomType": "channel",
            "serverId": server_id,
            "channelId": channel_id,
        }),
    )
    .await;
}

async fn get_json(app: &TestApp, user: &RegisteredUser, path: &str) -> (u16, serde_json::Value) {
    let resp = app
        .http
        .get(app.url(path))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    let body = resp.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

/// Канал, в котором никого нет, отдаётся пустым, а вошедший появляется и в
/// канальном, и в серверном снимке; сервер-снимок пустые комнаты не содержит.
#[tokio::test]
async fn voice_presence_lists_who_is_in_a_channel() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "voice-room").await;
    let chan_path = format!("/api/servers/{}/channels/{}/voice", server_id, channel_id);
    let srv_path = format!("/api/servers/{}/voice", server_id);

    let (status, body) = get_json(&app, &alice, &chan_path).await;
    assert_eq!(status, 200);
    assert_eq!(body["participants"], serde_json::json!([]));
    let (status, body) = get_json(&app, &alice, &srv_path).await;
    assert_eq!(status, 200);
    assert!(body["channels"].as_object().unwrap().is_empty());

    let mut ws = connect_ws(&app, &alice).await;
    join_channel(&mut ws, &server_id, &channel_id).await;
    let _ = drain_voice_events(&mut ws, 300).await;

    let (_, body) = get_json(&app, &alice, &chan_path).await;
    assert_eq!(body["participants"], serde_json::json!(["alice"]));
    assert!(body["joinedAt"]["alice"].is_i64() || body["joinedAt"]["alice"].is_u64());
    let (_, body) = get_json(&app, &alice, &srv_path).await;
    assert_eq!(
        body["channels"][&channel_id]["participants"],
        serde_json::json!(["alice"])
    );

    send(&mut ws, serde_json::json!({ "type": "voice_leave" })).await;
    let _ = drain_voice_events(&mut ws, 300).await;
    let (_, body) = get_json(&app, &alice, &chan_path).await;
    assert_eq!(body["participants"], serde_json::json!([]));
    let (_, body) = get_json(&app, &alice, &srv_path).await;
    assert!(body["channels"].as_object().unwrap().is_empty());
}

/// Присутствие подчиняется праву «просмотр канала»: на приватном сервере
/// посторонний получает 403 на канальный эндпоинт и пустой серверный снимок,
/// а на публичном — видит то же, что и список каналов (просмотр открыт).
#[tokio::test]
async fn voice_presence_follows_channel_view_permission() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;

    let private = {
        let resp = app
            .http
            .post(app.url("/api/servers"))
            .header("Authorization", alice.auth_header())
            .json(&serde_json::json!({ "name": "Secret", "is_public": false }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 201);
        let body: serde_json::Value = resp.json().await.unwrap();
        body["id"].as_str().unwrap().to_string()
    };
    let public = create_server(&app, &alice, "Guild").await;
    let private_ch = create_voice_channel(&app, &alice, &private, "voice-room").await;
    let public_ch = create_voice_channel(&app, &alice, &public, "voice-room").await;

    let mut ws = connect_ws(&app, &alice).await;
    join_channel(&mut ws, &private, &private_ch).await;
    let _ = drain_voice_events(&mut ws, 300).await;
    // Одновременно в двух комнатах сидеть нельзя: переходим в публичную.
    join_channel(&mut ws, &public, &public_ch).await;
    let _ = drain_voice_events(&mut ws, 300).await;

    // Приватный: ни канал, ни снимок сервера посторонний не видит.
    // (Пока alice в публичном канале, приватный пуст — проверяем только доступ.)
    let (status, _) = get_json(
        &app,
        &mallory,
        &format!("/api/servers/{}/channels/{}/voice", private, private_ch),
    )
    .await;
    assert_eq!(status, 403);

    // Публичный: просмотр открыт, посторонний видит, кто в канале.
    let (status, body) = get_json(
        &app,
        &mallory,
        &format!("/api/servers/{}/channels/{}/voice", public, public_ch),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["participants"], serde_json::json!(["alice"]));

    // Вернём alice в приватный канал: серверный снимок для постороннего пуст.
    join_channel(&mut ws, &private, &private_ch).await;
    let _ = drain_voice_events(&mut ws, 300).await;
    let (status, body) = get_json(&app, &mallory, &format!("/api/servers/{}/voice", private)).await;
    assert_eq!(status, 200);
    assert!(
        body["channels"].as_object().unwrap().is_empty(),
        "посторонний не должен видеть, кто сидит в приватном канале: {body}"
    );
    let (_, body) = get_json(&app, &alice, &format!("/api/servers/{}/voice", private)).await;
    assert_eq!(body["channels"][&private_ch]["participants"], serde_json::json!(["alice"]));

    // Без токена — не пускаем вовсе.
    let resp = app
        .http
        .get(app.url(&format!("/api/servers/{}/voice", public)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
}

/// `voice_state` участника расходится по комнате и попадает в снимок присутствия;
/// чужой или посторонний `voice_state` ничего не меняет; выход стирает состояние.
#[tokio::test]
async fn voice_state_is_broadcast_and_scoped_to_members() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let channel_id = create_voice_channel(&app, &alice, &server_id, "voice-room").await;
    let room_id = format!("voice:channel:{}:{}", server_id, channel_id);
    let chan_path = format!("/api/servers/{}/channels/{}/voice", server_id, channel_id);

    let mut ws = connect_ws(&app, &alice).await;
    join_channel(&mut ws, &server_id, &channel_id).await;
    let _ = drain_voice_events(&mut ws, 300).await;

    send(
        &mut ws,
        serde_json::json!({
            "type": "voice_state", "roomId": room_id,
            "muted": true, "deafened": false, "camera": true, "screen": false,
        }),
    )
    .await;
    let events = drain_voice_events(&mut ws, 400).await;
    let state = find_event(&events, "voice_room_state").expect("изменение состояния должно разойтись");
    assert_eq!(state["states"]["alice"]["muted"], true);
    assert_eq!(state["states"]["alice"]["camera"], true);
    assert_eq!(state["states"]["alice"]["screen"], false);

    // Тот же самый state повторно — без лишней рассылки.
    send(
        &mut ws,
        serde_json::json!({
            "type": "voice_state", "roomId": room_id,
            "muted": true, "deafened": false, "camera": true, "screen": false,
        }),
    )
    .await;
    let events = drain_voice_events(&mut ws, 300).await;
    assert!(find_event(&events, "voice_room_state").is_none(), "{events:?}");

    let (_, body) = get_json(&app, &alice, &chan_path).await;
    assert_eq!(body["states"]["alice"]["muted"], true);

    // Не участник комнаты состояние в неё записать не может.
    let mut mws = connect_ws(&app, &mallory).await;
    send(
        &mut mws,
        serde_json::json!({
            "type": "voice_state", "roomId": room_id,
            "muted": false, "deafened": true, "camera": false, "screen": true,
        }),
    )
    .await;
    let _ = drain_voice_events(&mut mws, 300).await;
    let (_, body) = get_json(&app, &alice, &chan_path).await;
    assert!(body["states"]["mallory"].is_null(), "{body}");
    assert_eq!(body["participants"], serde_json::json!(["alice"]));

    // После выхода состояние не остаётся висеть.
    send(&mut ws, serde_json::json!({ "type": "voice_leave" })).await;
    let _ = drain_voice_events(&mut ws, 300).await;
    let (_, body) = get_json(&app, &alice, &chan_path).await;
    assert!(body["states"].as_object().unwrap().is_empty(), "{body}");
}

/// «Отклонить» из уведомления (POST /api/voice/call/decline) открыт без сессии, поэтому
/// без верного секрета звонка он не должен трогать звонок.
#[tokio::test]
async fn declining_from_a_notification_needs_the_calls_own_token() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    add_contact(&app, &alice, "bob").await;
    add_contact(&app, &bob, "alice").await;
    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;

    let room_id = "voice:dm:alice:bob:push";
    send(
        &mut alice_ws,
        serde_json::json!({ "type": "voice_call_invite", "roomId": room_id, "roomType": "dm", "target": "bob" }),
    )
    .await;
    let bob_events = drain_voice_events(&mut bob_ws, 500).await;
    assert!(find_event(&bob_events, "voice_call_invite").is_some(), "{bob_events:?}");

    let url = format!("http://{}/api/voice/call/decline", app.addr);
    let res = app
        .http
        .post(&url)
        .json(&serde_json::json!({ "roomId": room_id, "token": "guessed" }))
        .send()
        .await
        .expect("decline request");
    assert_eq!(res.status(), reqwest::StatusCode::GONE);

    let alice_events = drain_voice_events(&mut alice_ws, 500).await;
    assert!(
        find_event(&alice_events, "voice_call_rejected").is_none(),
        "a guessed token must not hang up the caller: {alice_events:?}"
    );
}

async fn join_server(app: &TestApp, user: &RegisteredUser, owner: &RegisteredUser, server_id: &str) {
    common::join_by_invite(app, owner, server_id, &user.username, "hunter22").await;
}

/// Ждёт событие нужного типа среди голосовых; пустой список — оно не пришло.
async fn wait_event(ws: &mut Ws, event_type: &str) -> Option<serde_json::Value> {
    let events = drain_voice_events(ws, 700).await;
    events.into_iter().find(|event| event["type"] == event_type)
}

/// Перенос участников между голосовыми каналами (`voice_move_member`): просить вправе владелец,
/// админ, «Управление» и роль с флагом `can_move_members`; цель обязана сидеть в голосовом
/// канале ЭТОГО сервера, а назначение — быть голосовым каналом этого же сервера. Сервер ничего
/// не переселяет сам — цели уходит `voice_moved`, дальше она заходит в канал как обычно.
#[tokio::test]
async fn moving_a_member_between_voice_channels_is_gated_by_permission() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let server_id = create_server(&app, &alice, "Guild").await;
    let room_a = create_voice_channel(&app, &alice, &server_id, "room-a").await;
    let room_b = create_voice_channel(&app, &alice, &server_id, "room-b").await;
    join_server(&app, &bob, &alice, &server_id).await;
    join_server(&app, &carol, &alice, &server_id).await;

    // Видимость права в списке серверов: владелец — да, участник — нет.
    let (_, listed) = get_json(&app, &alice, "/api/servers").await;
    let mine = listed["servers"].as_array().unwrap().iter().find(|s| s["id"] == server_id.as_str()).unwrap();
    assert_eq!(mine["canMoveMembers"], true);
    let (_, listed) = get_json(&app, &carol, "/api/servers").await;
    let theirs = listed["servers"].as_array().unwrap().iter().find(|s| s["id"] == server_id.as_str()).unwrap();
    assert_eq!(theirs["canMoveMembers"], false);

    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    let mut carol_ws = connect_ws(&app, &carol).await;
    join_channel(&mut bob_ws, &server_id, &room_a).await;
    join_channel(&mut carol_ws, &server_id, &room_a).await;
    let _ = drain_voice_events(&mut bob_ws, 300).await;
    let _ = drain_voice_events(&mut carol_ws, 300).await;

    let move_event = |target: &str, channel: &str| {
        serde_json::json!({
            "type": "voice_move_member", "serverId": server_id, "channelId": channel, "target": target,
        })
    };

    // Обычный участник перенести не может, цель ничего не получает.
    send(&mut carol_ws, move_event("bob", &room_b)).await;
    let result = wait_event(&mut carol_ws, "voice_move_result").await.expect("result");
    assert_eq!(result["ok"], false);
    assert_eq!(result["code"], "move_forbidden");
    assert!(wait_event(&mut bob_ws, "voice_moved").await.is_none());

    // Владелец переносит: ему — ok, цели — voice_moved с каналом и автором.
    send(&mut alice_ws, move_event("bob", &room_b)).await;
    let result = wait_event(&mut alice_ws, "voice_move_result").await.expect("result");
    assert_eq!(result["ok"], true, "{result}");
    let moved = wait_event(&mut bob_ws, "voice_moved").await.expect("bob is told to move");
    assert_eq!(moved["channelId"], room_b.as_str());
    assert_eq!(moved["fromChannelId"], room_a.as_str());
    assert_eq!(moved["by"], "alice");
    // Сервер сам не переселяет — это делает клиент цели обычным заходом в канал.
    join_channel(&mut bob_ws, &server_id, &room_b).await;
    let _ = drain_voice_events(&mut bob_ws, 300).await;

    // Перенос в тот же канал, в не-голосовой канал и того, кто не в голосе, — отказы.
    send(&mut alice_ws, move_event("carol", &room_a)).await;
    assert_eq!(wait_event(&mut alice_ws, "voice_move_result").await.unwrap()["code"], "already_there");
    let (_, channels) = get_json(&app, &alice, &format!("/api/servers/{}/channels", server_id)).await;
    let text_channel = channels.as_array().unwrap().iter().find(|c| c["kind"] == "text").unwrap()["id"].as_str().unwrap().to_string();
    send(&mut alice_ws, move_event("carol", &text_channel)).await;
    assert_eq!(wait_event(&mut alice_ws, "voice_move_result").await.unwrap()["code"], "bad_request");
    send(&mut alice_ws, move_event("alice", &room_b)).await;
    assert_eq!(wait_event(&mut alice_ws, "voice_move_result").await.unwrap()["code"], "bad_request");
    send(&mut alice_ws, move_event("nobody", &room_b)).await;
    assert_eq!(wait_event(&mut alice_ws, "voice_move_result").await.unwrap()["code"], "not_in_voice");

    // Роль с флагом can_move_members даёт право обычному участнику; владельца он не двигает.
    let role: serde_json::Value = app
        .http
        .post(app.url(&format!("/api/servers/{}/roles", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "name": "Диспетчер", "can_move_members": true }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(role["canMoveMembers"], true);
    let assign = app
        .http
        .patch(app.url(&format!("/api/servers/{}/members/carol", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "carol", "role": role["roleId"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(assign.status(), 200);
    let (_, listed) = get_json(&app, &carol, "/api/servers").await;
    let theirs = listed["servers"].as_array().unwrap().iter().find(|s| s["id"] == server_id.as_str()).unwrap();
    assert_eq!(theirs["canMoveMembers"], true);
    send(&mut carol_ws, move_event("bob", &room_a)).await;
    assert_eq!(wait_event(&mut carol_ws, "voice_move_result").await.unwrap()["ok"], true);
    join_channel(&mut alice_ws, &server_id, &room_a).await;
    let _ = drain_voice_events(&mut alice_ws, 300).await;
    send(&mut carol_ws, move_event("alice", &room_b)).await;
    assert_eq!(wait_event(&mut carol_ws, "voice_move_result").await.unwrap()["code"], "move_forbidden");
}
