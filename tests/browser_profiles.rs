//! Общий профиль «Общего браузера» сообщества (server/src/browser_profiles.rs):
//! только участники, канонизация кук, удаление вместе с сервером.

mod common;

use common::{join_by_invite, register_user, spawn_app, RegisteredUser, TestApp};
use serde_json::{json, Value};

async fn create_server(app: &TestApp, owner: &RegisteredUser, name: &str) -> String {
    let resp = app
        .http
        .post(app.url("/api/servers"))
        .header("Authorization", owner.auth_header())
        .json(&json!({ "name": name, "is_public": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

async fn get_profile(app: &TestApp, user: &RegisteredUser, server: &str) -> (u16, Value) {
    let resp = app
        .http
        .get(app.url(&format!("/api/servers/{server}/browser-profile")))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

async fn put_profile(app: &TestApp, user: &RegisteredUser, server: &str, body: Value) -> (u16, Value) {
    let resp = app
        .http
        .put(app.url(&format!("/api/servers/{server}/browser-profile")))
        .header("Authorization", user.auth_header())
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn members_share_profile_and_outsiders_are_refused() {
    let app = spawn_app().await;
    let owner = register_user(&app, "bp_owner", "hunter22").await;
    let member = register_user(&app, "bp_member", "hunter22").await;
    let outsider = register_user(&app, "bp_outsider", "hunter22").await;
    let server = create_server(&app, &owner, "Browser guild").await;
    join_by_invite(&app, &owner, &server, "bp_member", "hunter22").await;

    let (status, empty) = get_profile(&app, &member, &server).await;
    assert_eq!(status, 200);
    assert_eq!(empty["revision"], 0);
    assert_eq!(empty["cookies"].as_array().unwrap().len(), 0);

    let cookies = json!([
        { "name": "sid", "value": "s3cret", "domain": ".example.com", "path": "/", "expires": 1900000000,
          "httpOnly": true, "secure": true, "sameSite": "None", "priority": "High" },
        { "name": "bad", "value": "x", "domain": "evil.com/path" }
    ]);
    let (status, saved) = put_profile(&app, &member, &server, json!({ "cookies": cookies })).await;
    assert_eq!(status, 200);
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["cookies"], 1, "негодная кука отброшена");

    let (status, read) = get_profile(&app, &owner, &server).await;
    assert_eq!(status, 200);
    assert_eq!(read["updatedBy"], "bp_member");
    let list = read["cookies"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["value"], "s3cret");
    assert!(list[0].get("priority").is_none(), "лишние поля не хранятся");

    let (status, _) = get_profile(&app, &outsider, &server).await;
    assert_eq!(status, 403);
    let (status, _) = put_profile(&app, &outsider, &server, json!({ "cookies": [] })).await;
    assert_eq!(status, 403);

    // Устаревшая ревизия (второй браузер начал раньше) — слияние, чужой вход остаётся.
    let other = json!([{ "name": "pref", "value": "dark", "domain": "other.org", "path": "/" }]);
    let (status, again) = put_profile(&app, &owner, &server, json!({ "cookies": other, "baseRevision": 0 })).await;
    assert_eq!(status, 200);
    assert_eq!(again["revision"], 2);
    assert_eq!(again["merged"], true);
    assert_eq!(again["cookies"], 2, "sid от bp_member не затёрт");
    // Своя актуальная ревизия — набор заменяется целиком (так проходят выходы с сайтов).
    let (status, replaced) = put_profile(&app, &owner, &server, json!({ "cookies": [], "baseRevision": 2 })).await;
    assert_eq!(status, 200);
    assert_eq!(replaced["merged"], false);
    assert_eq!(replaced["cookies"], 0);

    let (status, _) = put_profile(&app, &owner, &server, json!({ "cookies": "nope" })).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn profile_is_deleted_with_server() {
    let app = spawn_app().await;
    let owner = register_user(&app, "bp_owner2", "hunter22").await;
    let server = create_server(&app, &owner, "Short-lived").await;
    let cookie = json!([{ "name": "a", "value": "b", "domain": "example.org" }]);
    let (status, _) = put_profile(&app, &owner, &server, json!({ "cookies": cookie })).await;
    assert_eq!(status, 200);
    let resp = app
        .http
        .delete(app.url(&format!("/api/servers/{server}")))
        .header("Authorization", owner.auth_header())
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "delete_server: {}", resp.status());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_browser_profiles WHERE server_id = ?")
        .bind(&server)
        .fetch_one(
            &sqlx::SqlitePool::connect(&format!("sqlite://{}/zali_messenger.db", app.data_dir.display()))
                .await
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(count, 0);
}
