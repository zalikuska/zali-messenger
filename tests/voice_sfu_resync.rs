//! SFU после рестарта процесса: комната пересобирается keepalive'ом клиента, а SFU пуст.
//! Клиент, у которого не было ни одной дорожки, о потере не узнаёт и до конца звонка
//! остаётся без чужих стримов (прод 2026-11-26: четвёртый в комнате не видел экран).
//! Сервер сам просит такого участника заново войти в SFU.
//!
//! Отдельный бинарник: SFU включается переменной окружения процесса.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_ws(app: &TestApp, user: &RegisteredUser) -> Ws {
    let mut request = app.ws_url("/ws").into_client_request().unwrap();
    request.headers_mut().insert("Authorization", user.auth_header().parse().unwrap());
    let (stream, response) = tokio_tungstenite::connect_async(request).await.expect("ws connect");
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
                    if value["type"].as_str().map(|t| t.starts_with("voice_")).unwrap_or(false) {
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

#[tokio::test]
async fn keepalive_after_restart_asks_a_member_outside_the_sfu_to_rejoin() {
    // Свободный UDP-порт под SFU этого процесса.
    let port = std::net::UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    std::env::set_var("SFU_UDP_PORT", port.to_string());
    std::env::set_var("SFU_PUBLIC_IP", "127.0.0.1");

    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    add_contact(&app, &alice, "bob").await;
    add_contact(&app, &bob, "alice").await;
    let mut ws = connect_ws(&app, &alice).await;
    let room_id = "voice:dm:alice:bob:resync";

    // Сервер только что поднялся: комнату пересобирает keepalive, `voice_sfu_join` не было.
    send(&mut ws, serde_json::json!({
        "type": "voice_join", "roomId": room_id, "roomType": "dm", "keepalive": true, "sfu": true,
    })).await;
    let events = drain_voice_events(&mut ws, 600).await;
    let state = find_event(&events, "voice_room_state").expect("комната пересобрана");
    assert_eq!(state["videoTransport"], "sfu", "{events:?}");
    let closed = find_event(&events, "voice_sfu_closed").expect("вне SFU — просят войти заново");
    assert_eq!(closed["roomId"], room_id);
    assert_eq!(closed["role"], "subscribe");

    // Клиент вошёл в SFU — следующий keepalive уже не дёргает его.
    send(&mut ws, serde_json::json!({ "type": "voice_sfu_join", "roomId": room_id, "reset": true })).await;
    send(&mut ws, serde_json::json!({
        "type": "voice_join", "roomId": room_id, "roomType": "dm", "keepalive": true, "sfu": true,
    })).await;
    let events = drain_voice_events(&mut ws, 600).await;
    assert!(find_event(&events, "voice_sfu_closed").is_none(), "лишний resync: {events:?}");

    // Клиент без SFU (старый или выключенный) просьбы не получает.
    let mut bob_ws = connect_ws(&app, &bob).await;
    send(&mut bob_ws, serde_json::json!({
        "type": "voice_join", "roomId": room_id, "roomType": "dm", "keepalive": true,
    })).await;
    let events = drain_voice_events(&mut bob_ws, 600).await;
    assert!(find_event(&events, "voice_sfu_closed").is_none(), "{events:?}");
}
