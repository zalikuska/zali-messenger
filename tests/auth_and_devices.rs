//! Integration tests for authentication and device-trust endpoints, run
//! against a real in-process server (see tests/common/mod.rs).

mod common;

use common::{register_device, register_user, spawn_app};

#[tokio::test]
async fn server_echoes_client_supplied_request_id() {
    let app = spawn_app().await;
    let resp = app
        .http
        .get(app.url("/health"))
        .header("X-Request-ID", "my-custom-trace-id")
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.headers().get("x-request-id").unwrap(),
        "my-custom-trace-id"
    );
}

#[tokio::test]
async fn server_mints_a_request_id_when_client_sends_none() {
    let app = spawn_app().await;
    let resp = app.http.get(app.url("/health")).send().await.unwrap();
    let id = resp
        .headers()
        .get("x-request-id")
        .expect("server must always echo a request id")
        .to_str()
        .unwrap();
    assert!(!id.is_empty());
}

#[tokio::test]
async fn register_returns_token_and_created() {
    let app = spawn_app().await;
    let resp = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({ "username": "alice", "password": "hunter22" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["username"], "alice");
    assert!(!body["token"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn register_duplicate_username_conflicts() {
    let app = spawn_app().await;
    register_user(&app, "bob", "hunter22").await;

    let resp = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({ "username": "bob", "password": "differentpw" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 409);
}

#[tokio::test]
async fn register_rejects_short_password() {
    let app = spawn_app().await;
    let resp = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({ "username": "carol", "password": "abc12" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn register_rejects_password_over_72_bytes() {
    let app = spawn_app().await;
    let long_password = "x".repeat(73);
    let resp = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({ "username": "dave", "password": long_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn register_rejects_short_and_invalid_usernames() {
    let app = spawn_app().await;

    let too_short = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({ "username": "ab", "password": "hunter22" }))
        .send()
        .await
        .unwrap();
    assert_eq!(too_short.status(), 400);

    let bad_chars = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({ "username": "bad user!", "password": "hunter22" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_chars.status(), 400);
}

#[tokio::test]
async fn login_succeeds_with_correct_password_and_fails_otherwise() {
    let app = spawn_app().await;
    register_user(&app, "erin", "correct-horse").await;

    let ok = app
        .http
        .post(app.url("/api/auth/login"))
        .json(&serde_json::json!({ "username": "erin", "password": "correct-horse" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);

    let wrong_password = app
        .http
        .post(app.url("/api/auth/login"))
        .json(&serde_json::json!({ "username": "erin", "password": "wrong-password" }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_password.status(), 401);

    let unknown_user = app
        .http
        .post(app.url("/api/auth/login"))
        .json(&serde_json::json!({ "username": "nobody-here", "password": "whatever1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown_user.status(), 401);
}

#[tokio::test]
async fn me_requires_auth_and_reflects_correct_user() {
    let app = spawn_app().await;
    let alice = register_user(&app, "frank", "hunter22").await;
    let bob = register_user(&app, "grace", "hunter22").await;

    let unauthenticated = app.http.get(app.url("/api/auth/me")).send().await.unwrap();
    assert_eq!(unauthenticated.status(), 401);

    let as_alice = app
        .http
        .get(app.url("/api/auth/me"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(as_alice.status(), 200);
    let body: serde_json::Value = as_alice.json().await.unwrap();
    assert_eq!(body["username"], "frank");

    let as_bob = app
        .http
        .get(app.url("/api/auth/me"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = as_bob.json().await.unwrap();
    assert_eq!(body["username"], "grace");
}

#[tokio::test]
async fn logout_invalidates_the_token_used() {
    let app = spawn_app().await;
    let user = register_user(&app, "hank", "hunter22").await;

    let logout = app
        .http
        .post(app.url("/api/auth/logout"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), 204);

    // Same token must now be rejected — token_version bumped server-side.
    let stale = app
        .http
        .get(app.url("/api/auth/me"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 401);
}

#[tokio::test]
async fn ws_ticket_is_issued_only_to_authenticated_users() {
    let app = spawn_app().await;
    let user = register_user(&app, "ivan", "hunter22").await;

    let unauthenticated = app
        .http
        .post(app.url("/api/auth/ws-ticket"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), 401);

    let authenticated = app
        .http
        .post(app.url("/api/auth/ws-ticket"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(authenticated.status(), 200);
    let body: serde_json::Value = authenticated.json().await.unwrap();
    assert!(!body["ticket"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn first_device_is_auto_approved_second_is_not() {
    let app = spawn_app().await;
    let user = register_user(&app, "julia", "hunter22").await;

    let first = register_device(&app, &user, "device-one-aaaaaaaa").await;
    assert_eq!(first["approved"], true);

    let second = register_device(&app, &user, "device-two-bbbbbbbb").await;
    assert_eq!(second["approved"], false);
}

#[tokio::test]
async fn device_cannot_self_approve() {
    let app = spawn_app().await;
    let user = register_user(&app, "karl", "hunter22").await;
    let first = register_device(&app, &user, "device-one-aaaaaaaa").await;
    let device_id = first["deviceId"].as_str().unwrap().to_string();

    let resp = app
        .http
        .post(app.url("/api/devices/approve"))
        .header("Authorization", user.auth_header())
        .header("X-Zali-Device-ID", &device_id)
        .json(&serde_json::json!({
            "deviceId": device_id,
            "approvedByDeviceId": device_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn approve_device_requires_matching_trusted_header_and_succeeds() {
    let app = spawn_app().await;
    let user = register_user(&app, "liam", "hunter22").await;
    let first = register_device(&app, &user, "device-one-aaaaaaaa").await;
    let trusted_id = first["deviceId"].as_str().unwrap().to_string();
    let second = register_device(&app, &user, "device-two-bbbbbbbb").await;
    let target_id = second["deviceId"].as_str().unwrap().to_string();
    assert_eq!(second["approved"], false);

    // approvedByDeviceId must match the X-Zali-Device-ID header.
    let mismatched = app
        .http
        .post(app.url("/api/devices/approve"))
        .header("Authorization", user.auth_header())
        .header("X-Zali-Device-ID", &trusted_id)
        .json(&serde_json::json!({
            "deviceId": target_id,
            "approvedByDeviceId": "someone-else-device",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(mismatched.status(), 403);

    // Missing trusted-device header entirely.
    let no_header = app
        .http
        .post(app.url("/api/devices/approve"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({
            "deviceId": target_id,
            "approvedByDeviceId": trusted_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(no_header.status(), 403);

    let approved = app
        .http
        .post(app.url("/api/devices/approve"))
        .header("Authorization", user.auth_header())
        .header("X-Zali-Device-ID", &trusted_id)
        .json(&serde_json::json!({
            "deviceId": target_id,
            "approvedByDeviceId": trusted_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), 200);
    let body: serde_json::Value = approved.json().await.unwrap();
    assert_eq!(body["approved"], true);
}

#[tokio::test]
async fn cannot_revoke_the_last_trusted_device() {
    let app = spawn_app().await;
    let user = register_user(&app, "mona", "hunter22").await;
    let only_device = register_device(&app, &user, "device-only-aaaaaaaa").await;
    let device_id = only_device["deviceId"].as_str().unwrap().to_string();

    let resp = app
        .http
        .delete(app.url(&format!("/api/devices/{}", device_id)))
        .header("Authorization", user.auth_header())
        .header("X-Zali-Device-ID", &device_id)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn revoking_a_non_last_device_succeeds() {
    let app = spawn_app().await;
    let user = register_user(&app, "nora", "hunter22").await;
    let trusted = register_device(&app, &user, "device-one-aaaaaaaa").await;
    let trusted_id = trusted["deviceId"].as_str().unwrap().to_string();
    let second = register_device(&app, &user, "device-two-bbbbbbbb").await;
    let second_id = second["deviceId"].as_str().unwrap().to_string();

    app.http
        .post(app.url("/api/devices/approve"))
        .header("Authorization", user.auth_header())
        .header("X-Zali-Device-ID", &trusted_id)
        .json(&serde_json::json!({
            "deviceId": second_id,
            "approvedByDeviceId": trusted_id,
        }))
        .send()
        .await
        .unwrap();

    let resp = app
        .http
        .delete(app.url(&format!("/api/devices/{}", second_id)))
        .header("Authorization", user.auth_header())
        .header("X-Zali-Device-ID", &trusted_id)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    let devices: serde_json::Value = app
        .http
        .get(app.url("/api/devices"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second_after = devices
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["deviceId"] == second_id)
        .unwrap();
    assert_eq!(second_after["revoked"], true);
}

#[tokio::test]
async fn two_users_devices_are_fully_isolated() {
    let app = spawn_app().await;
    let alice = register_user(&app, "olga", "hunter22").await;
    let bob = register_user(&app, "peter", "hunter22").await;

    register_device(&app, &alice, "alice-device-aaaaaa").await;
    register_device(&app, &bob, "bob-device-bbbbbbbb").await;

    let alice_devices: serde_json::Value = app
        .http
        .get(app.url("/api/devices"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alice_devices.as_array().unwrap().len(), 1);
    assert_eq!(alice_devices[0]["owner"], "olga");

    let bob_devices: serde_json::Value = app
        .http
        .get(app.url("/api/devices"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bob_devices.as_array().unwrap().len(), 1);
    assert_eq!(bob_devices[0]["owner"], "peter");
}
