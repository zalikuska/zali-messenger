//! Режим «в игре» через настоящий сервер и настоящие WebSocket: настройки,
//! политика уведомления до самого сообщения, заметка отправителю, «Всё равно
//! оповестить» и сброс по окончании игровой сессии.

mod common;

use common::{fake_zali_bytes, register_user, spawn_app, RegisteredUser, TestApp};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const PASSWORD: &str = "correct horse battery staple";

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

async fn make_friends(app: &TestApp, a: &RegisteredUser, b: &RegisteredUser) {
    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", a.auth_header())
        .json(&serde_json::json!({ "to": b.username }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let id = body["id"].as_str().unwrap().to_string();
    let resp = app
        .http
        .post(app.url(&format!("/api/friends/requests/{}", id)))
        .header("Authorization", b.auth_header())
        .json(&serde_json::json!({ "action": "accept" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

async fn put_focus(app: &TestApp, user: &RegisteredUser, body: serde_json::Value) -> reqwest::Response {
    app.http
        .put(app.url("/api/game-focus"))
        .header("Authorization", user.auth_header())
        .json(&body)
        .send()
        .await
        .unwrap()
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

async fn start_playing(ws: &mut Ws, game: &str) {
    // share:false — игру получатель никому не показывает, но режим «в игре» её видит.
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "client_activity",
            "activity": { "kind": "game", "name": game, "share": false }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
}

fn types(events: &[serde_json::Value]) -> Vec<String> {
    events
        .iter()
        .map(|e| {
            e["type"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| if e["sender"].is_string() { "message".into() } else { "?".into() })
        })
        .collect()
}

#[tokio::test]
async fn settings_round_trip_and_reject_nonsense() {
    let app = spawn_app().await;
    let bob = register_user(&app, "focusbob01", PASSWORD).await;

    let resp = app
        .http
        .get(app.url("/api/game-focus"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap();
    let defaults: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(defaults["mode"], "off");
    assert_eq!(defaults["audience"], "everyone");

    let resp = put_focus(
        &app,
        &bob,
        serde_json::json!({ "mode": "defer", "audience": "only", "games": ["Dota 2", "dota 2"], "people": ["alice01", "alice01", "bad name"] }),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let saved: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(saved["games"], serde_json::json!(["Dota 2"]));
    assert_eq!(saved["people"], serde_json::json!(["alice01"]));

    assert_eq!(put_focus(&app, &bob, serde_json::json!({ "mode": "loud" })).await.status(), 400);
    assert_eq!(put_focus(&app, &bob, serde_json::json!({ "audience": "enemies" })).await.status(), 400);
}

#[tokio::test]
async fn a_deferred_message_announces_itself_in_order_and_notify_now_releases_it_once() {
    let app = spawn_app().await;
    let alice = register_user(&app, "focusalice", PASSWORD).await;
    let bob = register_user(&app, "focusbobby", PASSWORD).await;
    let eve = register_user(&app, "focuseve01", PASSWORD).await;
    make_friends(&app, &alice, &bob).await;
    assert_eq!(put_focus(&app, &bob, serde_json::json!({ "mode": "defer", "audience": "friends" })).await.status(), 200);

    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    let mut eve_ws = connect_ws(&app, &eve).await;
    start_playing(&mut bob_ws, "Dota 2").await;
    let _ = drain(&mut alice_ws, 100).await;
    let _ = drain(&mut bob_ws, 100).await;
    let _ = drain(&mut eve_ws, 100).await;

    let message_id = send_dm(&app, &alice, &bob.username).await;

    let bob_events = drain(&mut bob_ws, 500).await;
    let kinds = types(&bob_events);
    let policy_at = kinds.iter().position(|k| k == "notify_policy").unwrap_or_else(|| panic!("no policy in {:?}", kinds));
    let message_at = kinds.iter().position(|k| k == "message").unwrap_or_else(|| panic!("no message in {:?}", kinds));
    assert!(policy_at < message_at, "policy must precede the message: {:?}", kinds);
    assert_eq!(bob_events[policy_at]["mode"], "defer");
    assert_eq!(bob_events[policy_at]["messageId"], message_id.as_str());

    let alice_events = drain(&mut alice_ws, 300).await;
    let note = alice_events.iter().find(|e| e["type"] == "delivery_note").expect("delivery_note");
    assert_eq!(note["to"], bob.username.as_str());
    assert_eq!(note["mode"], "defer");
    assert!(note.get("game").is_none(), "the sender must not learn the game name");

    // Посторонний не может «оповестить» чужое сообщение.
    let resp = app
        .http
        .post(app.url(&format!("/api/message/{}/notify-now", message_id)))
        .header("Authorization", eve.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);

    let resp = app
        .http
        .post(app.url(&format!("/api/message/{}/notify-now", message_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bob_events = drain(&mut bob_ws, 400).await;
    let now = bob_events.iter().find(|e| e["type"] == "notify_now").expect("notify_now");
    assert_eq!(now["messageId"], message_id.as_str());

    // Второй раз — нельзя: одно сообщение будит один раз.
    let resp = app
        .http
        .post(app.url(&format!("/api/message/{}/notify-now", message_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn a_message_outside_the_audience_is_a_normal_one() {
    let app = spawn_app().await;
    let alice = register_user(&app, "audalice01", PASSWORD).await;
    let bob = register_user(&app, "audbobby01", PASSWORD).await;
    // alice и bob не друзья, а режим — «только друзья».
    assert_eq!(put_focus(&app, &bob, serde_json::json!({ "mode": "silent", "audience": "friends" })).await.status(), 200);
    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    start_playing(&mut bob_ws, "Dota 2").await;
    let _ = drain(&mut bob_ws, 100).await;
    let _ = drain(&mut alice_ws, 100).await;

    send_dm(&app, &alice, &bob.username).await;

    let kinds = types(&drain(&mut bob_ws, 400).await);
    assert!(kinds.contains(&"message".to_string()));
    assert!(!kinds.contains(&"notify_policy".to_string()), "{:?}", kinds);
    assert!(!types(&drain(&mut alice_ws, 200).await).contains(&"delivery_note".to_string()));
}

#[tokio::test]
async fn closing_the_game_releases_what_was_held() {
    std::env::set_var("ZALI_FOCUS_FLUSH_GRACE_MS", "100");
    let app = spawn_app().await;
    let alice = register_user(&app, "flushalice1", PASSWORD).await;
    let bob = register_user(&app, "flushbobby1", PASSWORD).await;
    assert_eq!(put_focus(&app, &bob, serde_json::json!({ "mode": "defer" })).await.status(), 200);
    let mut alice_ws = connect_ws(&app, &alice).await;
    let mut bob_ws = connect_ws(&app, &bob).await;
    start_playing(&mut bob_ws, "Hades").await;
    let _ = drain(&mut bob_ws, 100).await;
    let _ = drain(&mut alice_ws, 100).await;
    let message_id = send_dm(&app, &alice, &bob.username).await;
    let _ = drain(&mut bob_ws, 300).await;
    let _ = drain(&mut alice_ws, 100).await;

    // Игра закрылась (раньше MIN_UPDATE_INTERVAL смену сервер не принимает).
    tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
    bob_ws
        .send(WsMessage::Text(serde_json::json!({ "type": "client_activity", "activity": null }).to_string()))
        .await
        .unwrap();

    let bob_events = drain(&mut bob_ws, 1200).await;
    assert!(types(&bob_events).contains(&"focus_flush".to_string()), "{:?}", types(&bob_events));
    let alice_events = drain(&mut alice_ws, 300).await;
    let done = alice_events.iter().find(|e| e["type"] == "delivery_note_done").expect("done");
    assert_eq!(done["messageIds"][0], message_id.as_str());
}
