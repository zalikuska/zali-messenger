//! Игровой статус «Играет в …» через настоящий сервер и настоящие WebSocket.
//!
//! Юнит-тесты `server/src/activity.rs` проверяют разбор и рассылку на уровне
//! состояния; здесь — весь путь: кадр `client_activity` в сокет, `user_activity`
//! у друга, снимок при подключении и `GET /api/activity`.

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

async fn make_friends(app: &TestApp, a: &RegisteredUser, b: &RegisteredUser) {
    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", a.auth_header())
        .json(&serde_json::json!({ "to": b.username }))
        .send()
        .await
        .expect("friend request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("request json");
    let id = body["id"].as_str().expect("request id").to_string();
    let resp = app
        .http
        .post(app.url(&format!("/api/friends/requests/{}", id)))
        .header("Authorization", b.auth_header())
        .json(&serde_json::json!({ "action": "accept" }))
        .send()
        .await
        .expect("accept request");
    assert_eq!(resp.status(), 200);
}

async fn send(ws: &mut Ws, payload: serde_json::Value) {
    ws.send(WsMessage::Text(payload.to_string())).await.unwrap();
}

/// Все текстовые кадры за короткое окно: сервер отвечает асинхронно и вперемешку
/// с чужими событиями.
async fn drain(ws: &mut Ws, millis: u64) -> Vec<serde_json::Value> {
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
                    out.push(value);
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => return out,
            Err(_) => return out,
        }
    }
}

fn activity_frames<'a>(events: &'a [serde_json::Value], username: &str) -> Vec<&'a serde_json::Value> {
    events
        .iter()
        .filter(|e| e["type"] == "user_activity" && e["username"] == username)
        .collect()
}

async fn http_activity(app: &TestApp, viewer: &RegisteredUser) -> serde_json::Value {
    let resp = app
        .http
        .get(app.url("/api/activity"))
        .header("Authorization", viewer.auth_header())
        .send()
        .await
        .expect("get activity");
    assert_eq!(resp.status(), 200);
    resp.json().await.expect("activity json")
}

#[tokio::test]
async fn a_friend_sees_the_game_start_and_stop_and_a_stranger_sees_nothing() {
    let app = spawn_app().await;
    let alice = register_user(&app, "actalice01", "correct horse battery staple").await;
    let bob = register_user(&app, "actbobby01", "correct horse battery staple").await;
    let eve = register_user(&app, "acteve0001", "correct horse battery staple").await;
    make_friends(&app, &alice, &bob).await;

    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    let mut eve_ws = connect_ws(&app, &eve).await;
    let _ = drain(&mut bob_ws, 150).await;
    let _ = drain(&mut eve_ws, 150).await;

    send(
        &mut alice_ws,
        serde_json::json!({
            "type": "client_activity",
            "activity": { "kind": "game", "name": "Hades", "source": "process", "id": "proc:hades" }
        }),
    )
    .await;

    let bob_events = drain(&mut bob_ws, 500).await;
    let started = activity_frames(&bob_events, &alice.username);
    assert_eq!(started.len(), 1, "friend must get exactly one frame: {:?}", bob_events);
    assert_eq!(started[0]["activity"]["name"], "Hades");
    assert_eq!(started[0]["activity"]["source"], "process");
    assert!(
        activity_frames(&drain(&mut eve_ws, 300).await, &alice.username).is_empty(),
        "a stranger must not receive the status"
    );

    assert_eq!(http_activity(&app, &bob).await["activities"][&alice.username]["name"], "Hades");
    assert!(http_activity(&app, &eve).await["activities"]
        .as_object()
        .unwrap()
        .is_empty());

    // Игру закрыли. Пауза — чтобы пройти ограничитель частоты смены на сервере.
    tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
    send(
        &mut alice_ws,
        serde_json::json!({ "type": "client_activity", "activity": null }),
    )
    .await;
    let bob_events = drain(&mut bob_ws, 500).await;
    let stopped = activity_frames(&bob_events, &alice.username);
    assert_eq!(stopped.len(), 1, "{:?}", bob_events);
    assert!(stopped[0]["activity"].is_null());
}

#[tokio::test]
async fn a_client_connecting_later_gets_a_snapshot_and_a_dropped_socket_clears_the_status() {
    let app = spawn_app().await;
    let alice = register_user(&app, "snapalice1", "correct horse battery staple").await;
    let bob = register_user(&app, "snapbobby1", "correct horse battery staple").await;
    make_friends(&app, &alice, &bob).await;

    let mut alice_ws = connect_ws(&app, &alice).await;
    send(
        &mut alice_ws,
        serde_json::json!({ "type": "client_activity", "activity": { "kind": "game", "name": "Celeste" } }),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Боб подключается уже после того, как Алиса начала играть.
    let mut bob_ws = connect_ws(&app, &bob).await;
    let bob_events = drain(&mut bob_ws, 500).await;
    let snapshot = bob_events
        .iter()
        .find(|e| e["type"] == "activity_snapshot")
        .unwrap_or_else(|| panic!("no snapshot among {:?}", bob_events));
    assert_eq!(snapshot["activities"][&alice.username]["name"], "Celeste");

    // Сокет Алисы закрылся — статус пропал у друга сам, без явного «null».
    drop(alice_ws);
    let bob_events = drain(&mut bob_ws, 1500).await;
    let cleared = activity_frames(&bob_events, &alice.username);
    assert!(
        cleared.iter().any(|e| e["activity"].is_null()),
        "friend must see the status cleared: {:?}",
        bob_events
    );
    assert!(http_activity(&app, &bob).await["activities"]
        .as_object()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn garbage_from_a_modified_client_never_reaches_a_friend_as_a_game() {
    let app = spawn_app().await;
    let alice = register_user(&app, "junkalice1", "correct horse battery staple").await;
    let bob = register_user(&app, "junkbobby1", "correct horse battery staple").await;
    make_friends(&app, &alice, &bob).await;
    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    let _ = drain(&mut bob_ws, 150).await;

    for payload in [
        serde_json::json!({ "type": "client_activity", "activity": "Dota 2" }),
        serde_json::json!({ "type": "client_activity", "activity": { "kind": "game", "name": "   " } }),
        serde_json::json!({ "type": "client_activity", "activity": { "kind": "music", "name": "Song" } }),
        serde_json::json!({ "type": "client_activity" }),
    ] {
        send(&mut alice_ws, payload).await;
    }
    assert!(
        activity_frames(&drain(&mut bob_ws, 500).await, &alice.username).is_empty(),
        "nothing valid was sent, nothing may be broadcast"
    );
}
