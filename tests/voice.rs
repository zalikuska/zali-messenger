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

