//! «Восстановить переписку»: запрос ждёт собеседника и доставляется ему, как
//! только тот подключится; ответ доходит до спросившего.

mod common;

use common::{fake_zali_bytes, register_user, spawn_app, RegisteredUser, TestApp};
use futures_util::StreamExt;
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn upload_dm(app: &TestApp, from: &RegisteredUser, to: &str) {
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
}

async fn connect_ws(app: &TestApp, user: &RegisteredUser) -> Ws {
    let mut request = app.ws_url("/ws").into_client_request().unwrap();
    request.headers_mut().insert("Authorization", user.auth_header().parse().unwrap());
    let (stream, _) = tokio_tungstenite::connect_async(request).await.expect("ws connect");
    stream
}

/// Первое событие нужного типа (прочие — снимки голоса, активности — пропускаются).
async fn next_event(ws: &mut Ws, event_type: &str) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = tokio::time::timeout(left, ws.next())
            .await
            .unwrap_or_else(|_| panic!("нет события {event_type}"))
            .expect("ws closed")
            .expect("ws error");
        if let WsMessage::Text(text) = frame {
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            if value["type"] == event_type {
                return value;
            }
        }
    }
}

async fn request(app: &TestApp, from: &RegisteredUser, peer: &str) -> reqwest::Response {
    app.http
        .post(app.url("/api/history-recovery"))
        .header("Authorization", from.auth_header())
        .json(&serde_json::json!({ "peer": peer }))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn request_waits_for_the_peer_and_the_answer_reaches_the_requester() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22-ok").await;
    let bob = register_user(&app, "bob", "hunter22-ok").await;
    upload_dm(&app, &bob, "alice").await;

    // Боб не в сети.
    let resp = request(&app, &alice, "Bob").await;
    assert_eq!(resp.status(), 202);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["peerOnline"], false);
    assert_eq!(body["peer"], "bob");
    assert_eq!(body["scope"], "dm:alice:bob");
    let id = body["id"].as_str().unwrap().to_string();

    // Повторный запрос — тот же, а не новый.
    let again: serde_json::Value = request(&app, &alice, "bob").await.json().await.unwrap();
    assert_eq!(again["id"], id);

    let mut alice_ws = connect_ws(&app, &alice).await;
    // Боб входит в сеть — и сразу получает запрос.
    let mut bob_ws = connect_ws(&app, &bob).await;
    let event = next_event(&mut bob_ws, "history_recovery_request").await;
    assert_eq!(event["id"], id);
    assert_eq!(event["requester"], "alice");
    assert_eq!(event["scope"], "dm:alice:bob");

    let list: serde_json::Value = app
        .http
        .get(app.url("/api/history-recovery"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["incoming"][0]["id"], id);

    // Отметить выполненным может только тот, у кого просили.
    let resp = app
        .http
        .post(app.url(&format!("/api/history-recovery/{id}/fulfill")))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "result": "sent" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);

    let resp = app
        .http
        .post(app.url(&format!("/api/history-recovery/{id}/fulfill")))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "result": "sent" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let update = next_event(&mut alice_ws, "history_recovery_update").await;
    assert_eq!(update["status"], "fulfilled");
    assert_eq!(update["peer"], "bob");

    // Выполненный запрос больше не доставляется.
    drop(bob_ws);
    let list: serde_json::Value = app
        .http
        .get(app.url("/api/history-recovery"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["incoming"].as_array().unwrap().len(), 0);
    let outgoing: serde_json::Value = app
        .http
        .get(app.url("/api/history-recovery"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(outgoing["outgoing"][0]["status"], "fulfilled");
}

#[tokio::test]
async fn strangers_and_self_cannot_be_asked() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22-ok").await;
    register_user(&app, "stranger", "hunter22-ok").await;
    assert_eq!(request(&app, &alice, "stranger").await.status(), 404);
    assert_eq!(request(&app, &alice, "nobody-at-all").await.status(), 404);
    assert_eq!(request(&app, &alice, "alice").await.status(), 400);
}
