//! Облако настроек интерфейса (`/api/settings-sync`): слияние по ключам,
//! «последняя запись побеждает», лимиты и изоляция аккаунтов.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};
use serde_json::{json, Value};

async fn put(app: &TestApp, user: &RegisteredUser, entries: Value) -> (u16, Value) {
    let resp = app
        .http
        .put(app.url("/api/settings-sync"))
        .header("Authorization", user.auth_header())
        .json(&json!({ "entries": entries }))
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

async fn get(app: &TestApp, user: &RegisteredUser) -> Value {
    let resp = app
        .http
        .get(app.url("/api/settings-sync"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

#[tokio::test]
async fn requires_authentication() {
    let app = spawn_app().await;
    let resp = app.http.get(app.url("/api/settings-sync")).send().await.unwrap();
    assert_eq!(resp.status(), 401);
    let resp = app
        .http
        .put(app.url("/api/settings-sync"))
        .json(&json!({ "entries": {} }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn roundtrip_and_per_key_merge() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    assert_eq!(get(&app, &alice).await["entries"], json!({}));

    let (status, body) = put(&app, &alice, json!({ "design_mode": { "v": "flat", "t": 100 } })).await;
    assert_eq!(status, 200);
    assert_eq!(body["entries"]["design_mode"], json!({ "v": "flat", "t": 100 }));

    // Другое устройство меняет другой ключ — первый не стирается.
    let (_, body) = put(&app, &alice, json!({ "volume": { "v": "0.5", "t": 150 } })).await;
    assert_eq!(body["entries"]["design_mode"]["v"], "flat");
    assert_eq!(body["entries"]["volume"]["v"], "0.5");
    assert_eq!(get(&app, &alice).await["entries"], body["entries"]);
}

#[tokio::test]
async fn newer_write_wins_and_stale_write_is_rejected() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    put(&app, &alice, json!({ "theme": { "v": "dark", "t": 200 } })).await;

    // Старее хранимого: сервер возвращает свою версию, ничего не меняя.
    let (status, body) = put(&app, &alice, json!({ "theme": { "v": "light", "t": 100 } })).await;
    assert_eq!(status, 200);
    assert_eq!(body["entries"]["theme"], json!({ "v": "dark", "t": 200 }));

    // Равное время — тоже не новее.
    let (_, body) = put(&app, &alice, json!({ "theme": { "v": "tie", "t": 200 } })).await;
    assert_eq!(body["entries"]["theme"]["v"], "dark");

    // Новее — принимается.
    let (_, body) = put(&app, &alice, json!({ "theme": { "v": "light", "t": 300 } })).await;
    assert_eq!(body["entries"]["theme"], json!({ "v": "light", "t": 300 }));
}

#[tokio::test]
async fn accounts_are_isolated() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    put(&app, &alice, json!({ "theme": { "v": "dark", "t": 1 } })).await;
    assert_eq!(get(&app, &bob).await["entries"], json!({}));
}

#[tokio::test]
async fn rejects_malformed_entries() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    let bad = [
        json!({ "Bad-Key": { "v": "x", "t": 1 } }),                 // недопустимые символы
        json!({ "": { "v": "x", "t": 1 } }),                        // пустой ключ
        json!({ "k".repeat(49): { "v": "x", "t": 1 } }),            // ключ длиннее 48
        json!({ "k": { "v": "x" } }),                               // нет t
        json!({ "k": { "t": 1 } }),                                 // нет v
        json!({ "k": { "v": 5, "t": 1 } }),                         // v не строка
        json!({ "k": { "v": "x".repeat(4 * 1024 + 1), "t": 1 } }),  // значение больше 4 КиБ
    ];
    for entries in bad {
        let (status, _) = put(&app, &alice, entries.clone()).await;
        assert_eq!(status, 400, "должно отклоняться: {entries}");
    }

    // Не-объект в entries.
    let resp = app
        .http
        .put(app.url("/api/settings-sync"))
        .header("Authorization", alice.auth_header())
        .json(&json!({ "entries": [1, 2] }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    // Граничные значения проходят, и ничего из отклонённого не сохранилось.
    let (status, _) = put(
        &app,
        &alice,
        json!({ "k".repeat(48): { "v": "x".repeat(4 * 1024), "t": 1 } }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(get(&app, &alice).await["entries"].as_object().unwrap().len(), 1);
}

#[tokio::test]
async fn key_count_is_capped() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    let mut entries = serde_json::Map::new();
    for i in 0..64 {
        entries.insert(format!("k{i}"), json!({ "v": "x", "t": 1 }));
    }
    let (status, _) = put(&app, &alice, Value::Object(entries)).await;
    assert_eq!(status, 200);

    let (status, _) = put(&app, &alice, json!({ "one_more": { "v": "x", "t": 1 } })).await;
    assert_eq!(status, 413);
    assert_eq!(get(&app, &alice).await["entries"].as_object().unwrap().len(), 64);

    // Обновление существующего ключа при полном документе по-прежнему работает.
    let (status, _) = put(&app, &alice, json!({ "k0": { "v": "y", "t": 2 } })).await;
    assert_eq!(status, 200);
}
