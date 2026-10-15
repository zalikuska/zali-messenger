//! Маршрут уведомлений по активности устройств через настоящий сервер и настоящие
//! WebSocket: `client_idle` в сокет, `notify_route` раньше сообщения, простой в минутах
//! по `GET /api/devices/activity`.

mod common;

use common::{fake_zali_bytes, register_user, spawn_app, RegisteredUser, TestApp};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const PASSWORD: &str = "correct horse battery staple";

/// `device` — как у нативной оболочки, заголовком апгрейда; None — как у браузера.
async fn connect_ws(app: &TestApp, user: &RegisteredUser, device: Option<&str>) -> Ws {
    let mut request = app.ws_url("/ws").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", user.auth_header().parse().unwrap());
    if let Some(device) = device {
        request.headers_mut().insert("X-Zali-Device-ID", device.parse().unwrap());
    }
    let (stream, response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("ws connect");
    assert_eq!(response.status(), 101);
    stream
}

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

async fn idle(ws: &mut Ws, payload: serde_json::Value) {
    ws.send(WsMessage::Text(payload.to_string())).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
}

async fn send_dm(app: &TestApp, from: &RegisteredUser, to: &str) -> String {
    let form = reqwest::multipart::Form::new()
        .text("sender", from.username.clone())
        .text("receiver", to.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(fake_zali_bytes())
                .file_name("msg.zali")
                .mime_str("application/octet-stream")
                .unwrap(),
        );
    let resp = app
        .http
        .post(app.url("/api/upload"))
        .header("Authorization", from.auth_header())
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

async fn device_activity(app: &TestApp, user: &RegisteredUser) -> serde_json::Value {
    let resp = app
        .http
        .get(app.url("/api/devices/activity"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

#[tokio::test]
async fn the_route_names_the_active_device_and_arrives_before_the_message() {
    let app = spawn_app().await;
    let alice = register_user(&app, "devactal01", PASSWORD).await;
    let bob = register_user(&app, "devactbo01", PASSWORD).await;

    // Mac — нативная оболочка (устройство в заголовке), ноутбук — браузер (в кадре).
    let mut mac = connect_ws(&app, &bob, Some("bob-mac")).await;
    let mut laptop = connect_ws(&app, &bob, None).await;
    idle(&mut mac, serde_json::json!({ "type": "client_idle", "idleSeconds": 3 })).await;
    idle(
        &mut laptop,
        serde_json::json!({ "type": "client_idle", "deviceId": "bob-laptop", "idleSeconds": 1800 }),
    )
    .await;
    let _ = drain(&mut mac, 150).await;
    let _ = drain(&mut laptop, 150).await;

    let id = send_dm(&app, &alice, &bob.username).await;

    for ws in [&mut mac, &mut laptop] {
        let events = drain(ws, 500).await;
        let route = events
            .iter()
            .position(|e| e["type"] == "notify_route" && e["messageId"] == id.as_str())
            .unwrap_or_else(|| panic!("no notify_route: {:?}", events));
        assert_eq!(events[route]["devices"], serde_json::json!(["bob-mac"]));
        let message = events
            .iter()
            .position(|e| e["id"] == id.as_str() && e["type"] != "notify_route")
            .unwrap_or_else(|| panic!("no message: {:?}", events));
        assert!(route < message, "route must come first: {:?}", events);
    }

    let activity = device_activity(&app, &bob).await;
    assert_eq!(activity["notifyOnly"], serde_json::json!(["bob-mac"]));
    let devices = activity["devices"].as_array().unwrap();
    let laptop_row = devices.iter().find(|d| d["deviceId"] == "bob-laptop").unwrap();
    assert_eq!(laptop_row["idleMinutes"], 30);
    assert_eq!(laptop_row["active"], false);
    let mac_row = devices.iter().find(|d| d["deviceId"] == "bob-mac").unwrap();
    assert_eq!(mac_row["idleMinutes"], 0);
    assert_eq!(mac_row["active"], true);
}

#[tokio::test]
async fn when_every_device_is_idle_no_route_is_sent() {
    let app = spawn_app().await;
    let alice = register_user(&app, "devactal02", PASSWORD).await;
    let bob = register_user(&app, "devactbo02", PASSWORD).await;

    let mut mac = connect_ws(&app, &bob, Some("bob-mac")).await;
    idle(&mut mac, serde_json::json!({ "type": "client_idle", "idleSeconds": 600 })).await;
    let _ = drain(&mut mac, 150).await;

    let id = send_dm(&app, &alice, &bob.username).await;
    let events = drain(&mut mac, 500).await;
    assert!(events.iter().any(|e| e["id"] == id.as_str()), "message missing: {:?}", events);
    assert!(
        !events.iter().any(|e| e["type"] == "notify_route"),
        "no route means notify everywhere: {:?}",
        events
    );
    assert_eq!(device_activity(&app, &bob).await["notifyOnly"], serde_json::Value::Null);
}

#[tokio::test]
async fn the_sender_gets_no_route_for_their_own_echo() {
    let app = spawn_app().await;
    let alice = register_user(&app, "devactal03", PASSWORD).await;
    let bob = register_user(&app, "devactbo03", PASSWORD).await;

    let mut alice_mac = connect_ws(&app, &alice, Some("alice-mac")).await;
    idle(&mut alice_mac, serde_json::json!({ "type": "client_idle", "idleSeconds": 0 })).await;
    let _ = drain(&mut alice_mac, 150).await;

    let id = send_dm(&app, &alice, &bob.username).await;
    let events = drain(&mut alice_mac, 400).await;
    assert!(
        !events.iter().any(|e| e["type"] == "notify_route" && e["messageId"] == id.as_str()),
        "{:?}",
        events
    );
}

#[tokio::test]
async fn an_open_chat_silences_every_device_of_the_reader() {
    let app = spawn_app().await;
    let alice = register_user(&app, "devactal04", PASSWORD).await;
    let bob = register_user(&app, "devactbo04", PASSWORD).await;

    let mut mac = connect_ws(&app, &bob, Some("bob-mac")).await;
    let mut phone = connect_ws(&app, &bob, Some("bob-phone")).await;
    idle(&mut mac, serde_json::json!({ "type": "client_idle", "idleSeconds": 2 })).await;
    idle(&mut phone, serde_json::json!({ "type": "client_idle", "idleSeconds": 20 })).await;
    idle(
        &mut mac,
        serde_json::json!({ "type": "client_view", "conversation": format!("dm:{}", alice.username) }),
    )
    .await;
    let _ = drain(&mut mac, 150).await;
    let _ = drain(&mut phone, 150).await;

    let id = send_dm(&app, &alice, &bob.username).await;
    for ws in [&mut mac, &mut phone] {
        let events = drain(ws, 500).await;
        let route = events
            .iter()
            .find(|e| e["type"] == "notify_route" && e["messageId"] == id.as_str())
            .unwrap_or_else(|| panic!("no notify_route: {:?}", events));
        assert_eq!(route["devices"], serde_json::json!([]), "{:?}", events);
    }

    // Окно ушло с экрана — снова обычный маршрут на оба активных устройства.
    idle(&mut mac, serde_json::json!({ "type": "client_view", "conversation": null })).await;
    let _ = drain(&mut phone, 100).await;
    let id = send_dm(&app, &alice, &bob.username).await;
    let events = drain(&mut phone, 500).await;
    let route = events
        .iter()
        .find(|e| e["type"] == "notify_route" && e["messageId"] == id.as_str())
        .unwrap_or_else(|| panic!("no notify_route: {:?}", events));
    assert_eq!(route["devices"], serde_json::json!(["bob-mac", "bob-phone"]));
}
