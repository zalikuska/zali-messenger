//! Жалобы на сообщения → очередь → Jev (заглушка Decisions API) → мера →
//! состояние аккаунта → блокировка изменяющих запросов. Сервер настоящий
//! (tests/common), вместо OpenRouter — локальный axum, отвечающий по меткам в
//! тексте красной зоны: SPAM — спам, THREAT — угроза, GROSS — грубая угроза,
//! остальное — нарушений нет.

mod common;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use common::{
    fake_zali_bytes, join_by_invite, register_user, spawn_app, spawn_app_with_data_dir, spawn_app_with_moderation, RegisteredUser,
    TestApp,
};
use serde_json::{json, Value};
use zali_messenger_core::net::pack_message_bytes;

const ADMIN: &str = "moderation-admin-token";

#[derive(Default)]
struct Mock {
    calls: AtomicUsize,
    bodies: Mutex<Vec<String>>,
}

async fn decisions(State(mock): State<Arc<Mock>>, headers: HeaderMap, body: String) -> (axum::http::StatusCode, Json<Value>) {
    mock.calls.fetch_add(1, Ordering::SeqCst);
    mock.bodies.lock().unwrap().push(body.clone());
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer test-openrouter-key") {
        return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({ "error": { "message": "bad key" } })));
    }
    let request: Value = serde_json::from_str(&body).unwrap();
    assert!(request["model"].as_str().unwrap().starts_with("typesafe/jev"));
    assert_eq!(request["questions"]["rule"]["type"], "choice");
    let red: String = request["state"]["transcript"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["zone"] == "red" && m["author"] == "A")
        .map(|m| m["text"].as_str().unwrap().to_string())
        .collect::<Vec<_>>()
        .join(" ");
    // Наказуемы только тяжкие пункты 3.1: метки в тексте — условные «мошенничество»
    // (обычное, грубое) и «мелкое» (тяжесть ниже порога — предупреждение).
    let (p, rule, severity) = if red.contains("GROSS") {
        (0.97, "fraud", 2.9)
    } else if red.contains("THREAT") {
        (0.95, "fraud", 2.0)
    } else if red.contains("SPAM") {
        (0.96, "fraud", 1.0)
    } else {
        (0.04, "none", 0.1)
    };
    (
        axum::http::StatusCode::OK,
        Json(json!({
            "id": "gen-dec-test",
            "model": "typesafe/jev-1.14-test",
            "provider": "TypeSafe",
            "answers": {
                "violates": { "type": "noul", "noul": p },
                "rule": { "type": "choice", "choice": rule, "confidence": 0.9, "probabilities": { rule: 0.9 } },
                "severity": { "type": "score", "score": severity, "confidence": 0.9 }
            },
            "usage": { "input_tokens": 500, "output_tokens": 50, "cost": 0.00002 }
        })),
    )
}

async fn spawn_mock() -> (String, Arc<Mock>) {
    let mock = Arc::new(Mock::default());
    let app = Router::new().route("/alpha/decisions", post(decisions)).with_state(Arc::clone(&mock));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), mock)
}

async fn app_with_classifier(per_day: u32) -> (TestApp, Arc<Mock>) {
    let (url, mock) = spawn_mock().await;
    (spawn_app_with_moderation(&url, 600, per_day, ADMIN).await, mock)
}

async fn dm(app: &TestApp, from: &RegisteredUser, to: &str) -> reqwest::Response {
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
    app.http
        .post(app.url("/api/upload"))
        .header("Authorization", from.auth_header())
        .multipart(form)
        .send()
        .await
        .unwrap()
}

async fn dm_id(app: &TestApp, from: &RegisteredUser, to: &str) -> String {
    let resp = dm(app, from, to).await;
    assert!(resp.status().is_success(), "dm upload: {}", resp.status());
    let body: Value = resp.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

async fn report(app: &TestApp, user: &RegisteredUser, anchor: &str, messages: &[(&str, &str, &str)]) -> reqwest::Response {
    app.http
        .post(app.url("/api/moderation/reports"))
        .header("Authorization", user.auth_header())
        .json(&json!({
            "anchorMessageId": anchor,
            "messages": messages.iter().map(|(id, text, zone)| json!({ "id": id, "text": text, "zone": zone })).collect::<Vec<_>>(),
        }))
        .send()
        .await
        .unwrap()
}

async fn report_id(app: &TestApp, user: &RegisteredUser, anchor: &str, messages: &[(&str, &str, &str)]) -> String {
    let resp = report(app, user, anchor, messages).await;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap();
    assert!(status.is_success(), "report failed: {status} {body}");
    body["id"].as_str().unwrap().to_string()
}

async fn standing(app: &TestApp, user: &RegisteredUser) -> Value {
    app.http
        .get(app.url("/api/moderation/standing"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// Ждёт решения по жалобе (очередь обрабатывается фоновой задачей).
async fn wait_decided(app: &TestApp, reporter: &RegisteredUser, id: &str) -> String {
    for _ in 0..100 {
        let s = standing(app, reporter).await;
        if let Some(r) = s["reports"].as_array().unwrap().iter().find(|r| r["id"] == id) {
            let status = r["status"].as_str().unwrap();
            if status != "queued" && status != "processing" {
                return status.to_string();
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("жалоба {id} не обработана");
}

/// Жалоба из ЛС: текст прислал сам жалобщик (E2E), поэтому авто-наказания нет —
/// решение классификатора ждёт оператора (`review` / `unverified`). Оператор
/// подтверждает нарушение — дальше та же лестница мер.
async fn operator_confirms(app: &TestApp, reporter: &RegisteredUser, id: &str, gross: bool, tier: &str) {
    assert_eq!(wait_decided(app, reporter, id).await, "review");
    let s = standing(app, reporter).await;
    let mine = s["reports"].as_array().unwrap().iter().find(|r| r["id"] == id).unwrap().clone();
    assert_eq!(mine["status"], "review");
    let resp = app
        .http
        .post(app.url(&format!("/api/admin/moderation/reports/{id}/decide")))
        .header("Authorization", format!("Bearer {ADMIN}"))
        .json(&json!({ "decision": "violation", "category": "fraud", "gross": gross, "tier": tier }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(wait_decided(app, reporter, id).await, "actioned");
}

async fn db(app: &TestApp) -> sqlx::SqlitePool {
    sqlx::SqlitePool::connect(&format!("sqlite://{}/zali_messenger.db", app.data_dir.display()))
        .await
        .unwrap()
}

#[tokio::test]
async fn violations_fill_the_bar_and_three_restrict_writing() {
    let (app, mock) = app_with_classifier(50).await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bobby", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;

    // Первый спам при чистой истории — предупреждение: на шкалу не влияет.
    let hello = dm_id(&app, &bob, "alice").await;
    let spam = dm_id(&app, &bob, "alice").await;
    let id = report_id(&app, &alice, &spam, &[(&hello, "привет", "context"), (&spam, "SPAM купи", "red")]).await;
    operator_confirms(&app, &alice, &id, false, "warning").await;
    let s = standing(&app, &bob).await;
    assert_eq!(s["level"], "ok");
    assert_eq!(s["title"], "С аккаунтом все отлично!");
    assert_eq!(s["violations"][0]["tier"], "warning");
    assert_eq!(s["violations"][0]["tierTitle"], "Предупреждение");

    // Угрозы — нарушения: заполняют шкалу.
    for (n, (reporter, peer)) in [(&alice, "alice"), (&alice, "alice")].iter().enumerate() {
        let threat = dm_id(&app, &bob, peer).await;
        let id = report_id(&app, reporter, &threat, &[(&threat, "THREAT берегись", "red")]).await;
        operator_confirms(&app, reporter, &id, false, "violation").await;
        let s = standing(&app, &bob).await;
        assert_eq!(s["level"], "warnings");
        assert_eq!(s["title"], format!("Получено {} из 3 предупреждений", n + 1));
        assert_eq!(s["violations"][0]["tier"], "violation");
    }

    // Третье нарушение — временные ограничения: писать нельзя, читать можно.
    let threat = dm_id(&app, &bob, "carol").await;
    let id = report_id(&app, &carol, &threat, &[(&threat, "THREAT ещё", "red")]).await;
    operator_confirms(&app, &carol, &id, false, "violation").await;
    let s = standing(&app, &bob).await;
    assert_eq!(s["level"], "restricted");
    assert_eq!(s["title"], "Применены временные ограничения");
    assert!(s["until"].is_string());

    let blocked = dm(&app, &bob, "alice").await;
    assert_eq!(blocked.status(), 403);
    assert_eq!(blocked.text().await.unwrap(), "account_restricted");
    let reading = app
        .http
        .get(app.url("/api/messages/alice"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap();
    assert!(reading.status().is_success());
    // Жаловаться ограниченному можно.
    let hers = dm_id(&app, &alice, "bobby").await;
    assert!(report(&app, &bob, &hers, &[(&hers, "hm", "red")]).await.status().is_success());

    // Страница нарушения: место и фрагмент — только владельцу.
    let violation_id = s["violations"][0]["id"].as_str().unwrap().to_string();
    let detail: Value = app
        .http
        .get(app.url(&format!("/api/moderation/violations/{violation_id}")))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail["place"]["kind"], "dm");
    assert_eq!(detail["place"]["peer"], "carol");
    assert_eq!(detail["placeLabel"], "Личная переписка с carol");
    assert_eq!(detail["fragment"][0]["zone"], "red");
    assert_eq!(detail["ttlDays"], 60);
    let foreign = app
        .http
        .get(app.url(&format!("/api/moderation/violations/{violation_id}")))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 404);

    // В OpenRouter не уходят имена.
    for body in mock.bodies.lock().unwrap().iter() {
        assert!(!body.contains("bobby") && !body.contains("alice") && !body.contains("carol"), "{body}");
    }
}

#[tokio::test]
async fn serious_violation_suspends_until_operator_revokes() {
    let (app, _mock) = app_with_classifier(50).await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bobby", "hunter22").await;

    let gross = dm_id(&app, &bob, "alice").await;
    let id = report_id(&app, &alice, &gross, &[(&gross, "GROSS я тебя найду", "red")]).await;
    operator_confirms(&app, &alice, &id, true, "serious").await;

    let s = standing(&app, &bob).await;
    assert_eq!(s["level"], "suspended");
    assert_eq!(s["title"], "Аккаунт приостановлен");
    assert_eq!(s["reviewPending"], false);
    assert_eq!(s["violations"][0]["tier"], "serious");
    assert_eq!(s["violations"][0]["tierTitle"], "Серьёзное нарушение");

    let blocked = dm(&app, &bob, "alice").await;
    assert_eq!(blocked.status(), 403);
    assert_eq!(blocked.text().await.unwrap(), "account_suspended");

    let queue: Value = app
        .http
        .get(app.url("/api/admin/moderation/queue"))
        .header("Authorization", format!("Bearer {ADMIN}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(queue["classifier"]["requestsToday"], 1);
    // Мера уже проверена оператором — в очереди на пересмотр её нет.
    assert!(!queue["violations"].as_array().unwrap().iter().any(|v| v["username"] == "bobby"));
    let violation = s["violations"][0]["id"].as_str().unwrap().to_string();

    let revoke = app
        .http
        .post(app.url(&format!("/api/admin/moderation/violations/{violation}/revoke")))
        .header("Authorization", format!("Bearer {ADMIN}"))
        .json(&json!({ "reason": "ошибка классификатора" }))
        .send()
        .await
        .unwrap();
    assert_eq!(revoke.status(), 200);
    assert!(dm(&app, &bob, "alice").await.status().is_success());
    assert_eq!(standing(&app, &bob).await["level"], "ok");
}

#[tokio::test]
async fn reports_are_validated_and_rate_limited() {
    // Без ключа OpenRouter: жалобы принимаются и ждут в очереди.
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bobby", "hunter22").await;
    register_user(&app, "carol", "hunter22").await;

    let mine = dm_id(&app, &alice, "bobby").await;
    let m1 = dm_id(&app, &bob, "alice").await;
    let m2 = dm_id(&app, &bob, "alice").await;
    let m3 = dm_id(&app, &bob, "alice").await;
    let elsewhere = dm_id(&app, &bob, "carol").await;

    let own = report(&app, &alice, &mine, &[(&mine, "моё", "red")]).await;
    assert_eq!(own.status(), 400);
    let not_red = report(&app, &alice, &m1, &[(&m1, "x", "context"), (&m2, "y", "red")]).await;
    assert_eq!(not_red.status(), 400);
    let gap = report(&app, &alice, &m1, &[(&m1, "x", "red"), (&m2, "y", "context"), (&m3, "z", "red")]).await;
    assert_eq!(gap.status(), 400);
    let mixed = report(&app, &alice, &m1, &[(&m1, "x", "red"), (&elsewhere, "z", "context")]).await;
    assert_eq!(mixed.status(), 400);
    let foreign = report(&app, &alice, &elsewhere, &[(&elsewhere, "z", "red")]).await;
    assert_eq!(foreign.status(), 403);
    let missing = report(&app, &alice, "no-such-id", &[("no-such-id", "z", "red")]).await;
    assert_eq!(missing.status(), 409);

    let first = report(&app, &alice, &m1, &[(&m1, "x", "red")]).await;
    assert_eq!(first.status(), 201);
    let again = report(&app, &alice, &m1, &[(&m1, "x", "red")]).await;
    assert_eq!(again.status(), 409);
    assert!(report(&app, &alice, &m2, &[(&m2, "y", "red")]).await.status().is_success());
    assert!(report(&app, &alice, &m3, &[(&m3, "z", "red")]).await.status().is_success());
    // Четвёртая за час — отказ: до классификатора не доходит.
    let m4 = dm_id(&app, &bob, "alice").await;
    let fourth = report(&app, &alice, &m4, &[(&m4, "w", "red")]).await;
    assert_eq!(fourth.status(), 429);
    let s = standing(&app, &alice).await;
    assert_eq!(s["reportQuota"]["hourLeft"], 0);
    assert_eq!(s["reports"].as_array().unwrap().len(), 3);
    assert_eq!(s["reports"][0]["statusLabel"], "На проверке");
}

#[tokio::test]
async fn daily_cap_keeps_reports_queued() {
    let (app, mock) = app_with_classifier(1).await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bobby", "hunter22").await;

    let a = dm_id(&app, &bob, "alice").await;
    let b = dm_id(&app, &bob, "alice").await;
    let first = report_id(&app, &alice, &a, &[(&a, "просто текст", "red")]).await;
    let second = report_id(&app, &alice, &b, &[(&b, "и ещё", "red")]).await;
    assert_eq!(wait_decided(&app, &alice, &first).await, "rejected");
    tokio::time::sleep(Duration::from_millis(800)).await;
    let s = standing(&app, &alice).await;
    let queued = s["reports"].as_array().unwrap().iter().find(|r| r["id"] == second).unwrap();
    assert_eq!(queued["status"], "queued");
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
}

fn channel_key(scope: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(format!("zali-channel-key-v1:{scope}").as_bytes()))
}

async fn channel_post(app: &TestApp, user: &RegisteredUser, server: &str, channel: &str, text: &str) -> String {
    let key = channel_key(&format!("server:{server}:{channel}"));
    let archive = pack_message_bytes(&user.username, text, &key, 2, vec![], None, None).unwrap();
    let form = reqwest::multipart::Form::new()
        .text("sender", user.username.clone())
        .text("receiver", "channel")
        .part(
            "file",
            reqwest::multipart::Part::bytes(archive)
                .file_name("msg.zali")
                .mime_str("application/octet-stream")
                .unwrap(),
        );
    let resp = app
        .http
        .post(app.url(&format!("/api/servers/{server}/channels/{channel}/messages")))
        .header("Authorization", user.auth_header())
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn channel_texts_are_verified_and_reports_on_one_message_merge() {
    let (app, mock) = app_with_classifier(50).await;
    let owner = register_user(&app, "owner", "hunter22").await;
    let bob = register_user(&app, "bobby", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let server: Value = app
        .http
        .post(app.url("/api/servers"))
        .header("Authorization", owner.auth_header())
        .json(&json!({ "name": "Клуб", "is_public": false }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_string();
    let channel_id = server["channels"][0]["id"].as_str().unwrap().to_string();
    join_by_invite(&app, &owner, &server_id, "bobby", "hunter22").await;
    join_by_invite(&app, &owner, &server_id, "carol", "hunter22").await;

    let spam = channel_post(&app, &bob, &server_id, &channel_id, "SPAM заходите на сайт").await;
    let id = report_id(&app, &carol, &spam, &[(&spam, "SPAM заходите на сайт", "red")]).await;
    let merged = report(&app, &owner, &spam, &[(&spam, "SPAM заходите на сайт", "red")]).await;
    assert_eq!(merged.status(), 200);
    let merged: Value = merged.json().await.unwrap();
    assert_eq!(merged["merged"], true);
    assert_eq!(merged["id"], id);
    assert_eq!(wait_decided(&app, &carol, &id).await, "actioned");
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1, "две жалобы на одно сообщение — один запрос к Jev");
    let verification: String = sqlx::query_scalar("SELECT verification FROM moderation_reports WHERE id = ?")
        .bind(&id)
        .fetch_one(&db(&app).await)
        .await
        .unwrap();
    assert_eq!(verification, "server");
    let place = &standing(&app, &bob).await["violations"][0];
    assert_eq!(place["placeLabel"], "Клуб · #Общий чат");

    // Подделанный текст канала видно: до Jev не доходит, решает человек.
    let calm = channel_post(&app, &bob, &server_id, &channel_id, "всем привет").await;
    let forged = report_id(&app, &carol, &calm, &[(&calm, "SPAM поддельный текст", "red")]).await;
    assert_eq!(wait_decided(&app, &carol, &forged).await, "review");
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn important_context_can_be_several_pieces_around_the_violation() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bobby", "hunter22").await;
    let mut ids = Vec::new();
    for _ in 0..7 {
        ids.push(dm_id(&app, &bob, "alice").await);
    }
    // Контекст до нарушения, нарушение, обычное сообщение, контекст после.
    let zones = ["orange", "orange", "context", "red", "context", "orange", "context"];
    let messages: Vec<(&str, &str, &str)> = ids.iter().zip(zones).map(|(id, z)| (id.as_str(), "текст", z)).collect();
    let ok = report(&app, &alice, &ids[3], &messages).await;
    assert_eq!(ok.status(), 201, "{}", ok.text().await.unwrap());

    // Шесть отрезков контекста — больше лимита.
    let mut many = Vec::new();
    for _ in 0..13 {
        many.push(dm_id(&app, &bob, "alice").await);
    }
    let zones: Vec<&str> = (0..13).map(|i| if i == 12 { "red" } else if i % 2 == 0 { "orange" } else { "context" }).collect();
    let messages: Vec<(&str, &str, &str)> = many.iter().zip(zones).map(|(id, z)| (id.as_str(), "т", z)).collect();
    let too_many = report(&app, &alice, &many[12], &messages).await;
    assert_eq!(too_many.status(), 400);
}

#[tokio::test]
async fn appeal_is_accepted_once_and_refusals_say_why() {
    let (app, _mock) = app_with_classifier(50).await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bobby", "hunter22").await;

    let threat = dm_id(&app, &bob, "alice").await;
    let id = report_id(&app, &alice, &threat, &[(&threat, "THREAT берегись", "red")]).await;
    operator_confirms(&app, &alice, &id, false, "violation").await;
    let violation = standing(&app, &bob).await["violations"][0]["id"].as_str().unwrap().to_string();

    let appeal = |who: &RegisteredUser, vid: &str, text: &str| {
        app.http
            .post(app.url(&format!("/api/moderation/violations/{vid}/appeal")))
            .header("Authorization", who.auth_header())
            .json(&json!({ "text": text }))
            .send()
    };

    // Слишком коротко — 400 с причиной.
    let short = appeal(&bob, &violation, "нет").await.unwrap();
    assert_eq!(short.status(), 400);
    assert_eq!(short.json::<Value>().await.unwrap()["error"], "too_short");

    // Чужую меру не оспорить, несуществующую — тоже: «не найдена».
    let foreign = appeal(&alice, &violation, "это была цитата, а не угроза").await.unwrap();
    assert_eq!(foreign.status(), 404);
    let missing = appeal(&bob, "no-such-id", "это была цитата, а не угроза").await.unwrap();
    assert_eq!(missing.status(), 404);

    // Принято один раз.
    let ok = appeal(&bob, &violation, "это была цитата, а не угроза").await.unwrap();
    assert!(ok.status().is_success(), "appeal: {}", ok.status());
    let detail: Value = app
        .http
        .get(app.url(&format!("/api/moderation/violations/{violation}")))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail["appealStatus"], "pending");

    let again = appeal(&bob, &violation, "и ещё раз: это была цитата").await.unwrap();
    assert_eq!(again.status(), 409);
    assert_eq!(again.json::<Value>().await.unwrap()["error"], "appeal_exists");
}

#[tokio::test]
async fn insults_are_not_punished_and_retired_rules_are_lifted() {
    let (app, _mock) = app_with_classifier(50).await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bobby", "hunter22").await;

    // Ругань и шутливая «угроза» — нарушений нет.
    let rude = dm_id(&app, &bob, "alice").await;
    let id = report_id(&app, &alice, &rude, &[(&rude, "ты идиот, убью тебя ахах", "red")]).await;
    assert_eq!(wait_decided(&app, &alice, &id).await, "rejected");
    assert_eq!(standing(&app, &bob).await["level"], "ok");

    // Мера по пункту, которого больше нет в Правилах (старое «Спам»), снимается при старте.
    let pool = db(&app).await;
    sqlx::query(
        "INSERT INTO moderation_violations (id, username, category, tier, expires_at, source, created_at)
         VALUES ('old-spam', 'bobby', 'spam', 'violation', '2999-01-01T00:00:00Z', 'operator', '2026-11-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    // Тот же каталог данных — как перезапуск сервера.
    let app = spawn_app_with_data_dir(app.data_dir.clone()).await;
    let s = standing(&app, &bob).await;
    assert_eq!(s["level"], "ok");
    let v = s["violations"].as_array().unwrap().iter().find(|v| v["id"] == "old-spam").unwrap();
    assert_eq!(v["revoked"], true);
}
