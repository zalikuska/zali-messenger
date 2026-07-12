//! Integration tests for message send/receive, history, reactions, deletion,
//! and real-time WebSocket delivery between concurrently-connected users —
//! run against a real in-process server with real WS clients (no mocks).

mod common;

use common::{fake_zali_bytes, register_user, spawn_app, RegisteredUser, TestApp};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn upload_dm(
    app: &TestApp,
    from: &RegisteredUser,
    to_username: &str,
    client_id: Option<&str>,
) -> reqwest::Response {
    let mut form = reqwest::multipart::Form::new()
        .text("sender", from.username.clone())
        .text("receiver", to_username.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(fake_zali_bytes())
                .file_name("msg.zali")
                .mime_str("application/octet-stream")
                .unwrap(),
        );
    if let Some(client_id) = client_id {
        form = form.text("client_id", client_id.to_string());
    }

    app.http
        .post(app.url("/api/upload"))
        .header("Authorization", from.auth_header())
        .multipart(form)
        .send()
        .await
        .expect("upload request")
}

async fn connect_ws(
    app: &TestApp,
    user: &RegisteredUser,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
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

#[tokio::test]
async fn dm_upload_requires_existing_receiver() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    let resp = upload_dm(&app, &alice, "nobody-such-user", None).await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn dm_upload_and_history_visible_to_both_participants() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let resp = upload_dm(&app, &alice, "bob", Some("client-1")).await;
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    let message_id = body["id"].as_str().unwrap().to_string();
    assert!(!message_id.is_empty());

    let alice_view: serde_json::Value = app
        .http
        .get(app.url("/api/messages/bob"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alice_view.as_array().unwrap().len(), 1);
    assert_eq!(alice_view[0]["sender"], "alice");
    assert_eq!(alice_view[0]["receiver"], "bob");

    let bob_view: serde_json::Value = app
        .http
        .get(app.url("/api/messages/alice"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bob_view.as_array().unwrap().len(), 1);
    assert_eq!(bob_view[0]["id"], message_id);
}

#[tokio::test]
async fn duplicate_client_id_upload_is_deduplicated() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let first = upload_dm(&app, &alice, "bob", Some("dedup-key")).await;
    assert_eq!(first.status(), 201);
    let first_body: serde_json::Value = first.json().await.unwrap();
    let first_id = first_body["id"].as_str().unwrap().to_string();

    let second = upload_dm(&app, &alice, "bob", Some("dedup-key")).await;
    assert_eq!(second.status(), 201);
    let second_body: serde_json::Value = second.json().await.unwrap();
    assert_eq!(
        second_body["id"], first_id,
        "duplicate client_id must resolve to the same message"
    );

    let history: serde_json::Value = app
        .http
        .get(app.url("/api/messages/bob"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        history.as_array().unwrap().len(),
        1,
        "no duplicate row should be stored"
    );
}

#[tokio::test]
async fn reaction_set_and_cleared_is_visible_in_history() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let resp = upload_dm(&app, &alice, "bob", None).await;
    let body: serde_json::Value = resp.json().await.unwrap();
    let message_id = body["id"].as_str().unwrap().to_string();

    let reacted = app
        .http
        .post(app.url(&format!("/api/message/{}/reaction", message_id)))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "emoji": "👍" }))
        .send()
        .await
        .unwrap();
    assert_eq!(reacted.status(), 200);
    let reacted_body: serde_json::Value = reacted.json().await.unwrap();
    assert_eq!(reacted_body["reactions"][0]["emoji"], "👍");
    assert_eq!(reacted_body["reactions"][0]["count"], 1);
    assert_eq!(reacted_body["myReactions"], serde_json::json!(["👍"]));

    // A different emoji stacks alongside the first instead of replacing it —
    // one user can react with several distinct emoji on the same message.
    let stacked = app
        .http
        .post(app.url(&format!("/api/message/{}/reaction", message_id)))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "emoji": "🔥" }))
        .send()
        .await
        .unwrap();
    assert_eq!(stacked.status(), 200);
    let stacked_body: serde_json::Value = stacked.json().await.unwrap();
    assert_eq!(stacked_body["reactions"].as_array().unwrap().len(), 2);
    let mut my_reactions: Vec<String> = stacked_body["myReactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    my_reactions.sort();
    assert_eq!(my_reactions, vec!["👍".to_string(), "🔥".to_string()]);

    // Posting the same emoji again toggles it back off, leaving the other one.
    let cleared = app
        .http
        .post(app.url(&format!("/api/message/{}/reaction", message_id)))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "emoji": "👍" }))
        .send()
        .await
        .unwrap();
    assert_eq!(cleared.status(), 200);
    let cleared_body: serde_json::Value = cleared.json().await.unwrap();
    assert_eq!(cleared_body["reactions"].as_array().unwrap().len(), 1);
    assert_eq!(cleared_body["reactions"][0]["emoji"], "🔥");
    assert_eq!(cleared_body["myReactions"], serde_json::json!(["🔥"]));
}

#[tokio::test]
async fn reaction_on_someone_elses_dm_is_forbidden() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    let outsider = register_user(&app, "carol", "hunter22").await;
    let resp = upload_dm(&app, &alice, "bob", None).await;
    let body: serde_json::Value = resp.json().await.unwrap();
    let message_id = body["id"].as_str().unwrap().to_string();

    let resp = app
        .http
        .post(app.url(&format!("/api/message/{}/reaction", message_id)))
        .header("Authorization", outsider.auth_header())
        .json(&serde_json::json!({ "emoji": "👍" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
async fn only_sender_can_delete_a_dm() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let resp = upload_dm(&app, &alice, "bob", None).await;
    let body: serde_json::Value = resp.json().await.unwrap();
    let message_id = body["id"].as_str().unwrap().to_string();

    let forbidden = app
        .http
        .delete(app.url(&format!("/api/message/{}", message_id)))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);

    let allowed = app
        .http
        .delete(app.url(&format!("/api/message/{}", message_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), 204);

    let history: serde_json::Value = app
        .http
        .get(app.url("/api/messages/bob"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(history.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn websocket_ping_gets_pong() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let mut ws = connect_ws(&app, &alice).await;

    ws.send(WsMessage::Text(r#"{"type":"ping"}"#.to_string()))
        .await
        .unwrap();

    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
        .await
        .expect("timed out waiting for pong")
        .expect("stream ended")
        .expect("ws error");
    let WsMessage::Text(text) = reply else {
        panic!("expected text frame, got {:?}", reply);
    };
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["type"], "pong");
}

#[tokio::test]
async fn recipient_receives_dm_over_websocket_in_real_time() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    // Bob is connected and listening *before* Alice sends anything — this is
    // the live-delivery path (deliver_to_user), not history catch-up.
    let mut bob_ws = connect_ws(&app, &bob).await;

    let resp = upload_dm(&app, &alice, "bob", None).await;
    assert_eq!(resp.status(), 201);
    let upload_body: serde_json::Value = resp.json().await.unwrap();
    let message_id = upload_body["id"].as_str().unwrap().to_string();

    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), bob_ws.next())
        .await
        .expect("timed out waiting for realtime delivery")
        .expect("stream ended")
        .expect("ws error");
    let WsMessage::Text(text) = frame else {
        panic!("expected text frame, got {:?}", frame);
    };
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["id"], message_id);
    assert_eq!(value["sender"], "alice");
    assert_eq!(value["receiver"], "bob");
}

#[tokio::test]
async fn sender_also_gets_a_websocket_echo_of_their_own_dm() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;

    let resp = upload_dm(&app, &alice, "bob", None).await;
    assert_eq!(resp.status(), 201);

    for ws in [&mut alice_ws, &mut bob_ws] {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for delivery")
            .expect("stream ended")
            .expect("ws error");
        let WsMessage::Text(text) = frame else {
            panic!("expected text frame, got {:?}", frame);
        };
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["sender"], "alice");
        assert_eq!(value["receiver"], "bob");
    }
}

#[tokio::test]
async fn a_third_user_never_sees_someone_elses_dm() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;

    let mut carol_ws = connect_ws(&app, &carol).await;

    let resp = upload_dm(&app, &alice, "bob", None).await;
    assert_eq!(resp.status(), 201);

    // Carol shouldn't get anything: race the delivery window against a short
    // timeout and assert nothing arrives (a stray voice/ping frame would fail
    // this too, since none should be in flight in this scenario).
    let result = tokio::time::timeout(std::time::Duration::from_millis(500), carol_ws.next()).await;
    assert!(
        result.is_err(),
        "carol should not receive alice/bob's DM, but got: {:?}",
        result
    );
}
