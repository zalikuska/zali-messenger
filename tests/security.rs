//! Security regression tests.
//!
//! Every case here corresponds to a hole that was found and closed, phrased as
//! "the attack no longer works" rather than "the handler returns 200". They
//! exist because none of these are visible in normal use: an unused credential
//! path, a rate limiter that throttles the wrong key, and a table nobody reads
//! all behave perfectly right up to the moment they are abused.

mod common;

use common::{register_user, spawn_app};

/// A JWT must never be accepted from the query string.
///
/// It used to be, under `?token=`, `?auth=` and `?access_token=`. No client in
/// this repo ever sent one that way — but a query string is copied verbatim into
/// the reverse proxy's access log, browser history and outgoing `Referer`, and
/// this token is a seven-day full-account bearer credential. One log line was a
/// week of account takeover.
#[tokio::test]
async fn jwt_in_query_string_is_rejected() {
    let app = spawn_app().await;
    let user = register_user(&app, "querytokenuser", "correct horse battery").await;

    // Sanity check: the very same token works through the header, so a failure
    // below is the query path being closed, not a broken token.
    let ok = app
        .http
        .get(app.url("/api/auth/me"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .expect("header-auth request");
    assert_eq!(ok.status(), 200, "header auth should still work");

    for param in ["token", "auth", "access_token"] {
        let resp = app
            .http
            .get(app.url(&format!("/api/auth/me?{}={}", param, user.token)))
            .send()
            .await
            .expect("query-auth request");
        assert_eq!(
            resp.status(),
            401,
            "?{}= must not authenticate anyone",
            param
        );
    }
}

/// The WS ticket is the *only* credential the query string carries, and it is
/// single-use: replaying one that was already consumed must fail.
#[tokio::test]
async fn ws_ticket_is_single_use() {
    let app = spawn_app().await;
    let user = register_user(&app, "ticketuser", "correct horse battery").await;

    let ticket: String = {
        let resp = app
            .http
            .post(app.url("/api/auth/ws-ticket"))
            .header("Authorization", user.auth_header())
            .send()
            .await
            .expect("ws-ticket request");
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = resp.json().await.expect("ws-ticket json");
        body["ticket"].as_str().expect("ticket field").to_string()
    };

    let first = app
        .http
        .get(app.url(&format!("/api/auth/me?ticket={}", ticket)))
        .send()
        .await
        .expect("first ticket use");
    assert_eq!(first.status(), 200, "a fresh ticket should authenticate");

    let replay = app
        .http
        .get(app.url(&format!("/api/auth/me?ticket={}", ticket)))
        .send()
        .await
        .expect("ticket replay");
    assert_eq!(replay.status(), 401, "a consumed ticket must not work twice");
}

/// A password spray — one guess against many different accounts from one
/// address — must run into a limit.
///
/// The original limiter was keyed on (username, IP), so every request in a spray
/// landed in a different bucket and nothing ever throttled. `/api/users` hands
/// the account list to any logged-in user, so the usernames are not secret
/// either.
#[tokio::test]
async fn password_spray_across_usernames_is_throttled() {
    let app = spawn_app().await;

    // Well under the per-(username, IP) budget for each individual name, so only
    // a limiter that counts failures per IP can stop this.
    let mut throttled_at = None;
    for i in 0..80 {
        let resp = app
            .http
            .post(app.url("/api/auth/login"))
            .json(&serde_json::json!({
                "username": format!("sprayvictim{}", i),
                "password": "Password123",
            }))
            .send()
            .await
            .expect("login attempt");
        if resp.status() == 429 {
            throttled_at = Some(i);
            break;
        }
        assert_eq!(resp.status(), 401, "attempt {} should be a plain rejection", i);
    }

    assert!(
        throttled_at.is_some(),
        "80 failed logins across 80 distinct usernames from one IP were never throttled"
    );
}

/// Signing in successfully must not consume the per-IP failure budget — a
/// household or office behind one NAT address should never lock itself out by
/// using the product normally.
#[tokio::test]
async fn successful_logins_do_not_consume_the_failure_budget() {
    let app = spawn_app().await;
    register_user(&app, "busyoffice", "correct horse battery").await;

    for i in 0..60 {
        let resp = app
            .http
            .post(app.url("/api/auth/login"))
            .json(&serde_json::json!({
                "username": "busyoffice",
                "password": "correct horse battery",
            }))
            .send()
            .await
            .expect("login attempt");
        assert_eq!(
            resp.status(),
            200,
            "successful login {} was throttled by the failure budget",
            i
        );
    }
}

/// The legacy `conversation_keys` table stored the real AES key for a
/// conversation, in plaintext, next to the ciphertext it opens. Nothing has read
/// it for a long time; startup must actively drop it rather than leave the rows
/// sitting there unread but perfectly readable.
#[tokio::test]
async fn legacy_plaintext_key_table_is_gone_after_startup() {
    let app = spawn_app().await;
    let db = app.data_dir.join("zali_messenger.db");

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&format!("sqlite:{}", db.to_string_lossy()))
        .await
        .expect("open test db");

    let found: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_keys'",
    )
    .fetch_optional(&pool)
    .await
    .expect("query sqlite_master");

    assert!(
        found.is_none(),
        "conversation_keys still exists — the server is keeping plaintext conversation keys"
    );
}

/// Registration must not create two accounts whose names differ only by case.
///
/// Conversation scopes lowercase their participants (`canonical_scope`), so
/// `Pivovarca` and `pivovarca` would resolve to one scope and therefore one
/// conversation key — each able to read the other's messages.
#[tokio::test]
async fn case_variant_usernames_cannot_both_register() {
    let app = spawn_app().await;
    register_user(&app, "CaseVictim", "correct horse battery").await;

    let resp = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({
            "username": "casevictim",
            "password": "another password",
        }))
        .send()
        .await
        .expect("register request");
    assert_eq!(
        resp.status(),
        409,
        "a case-variant of an existing username must be refused"
    );
}

/// Attachments are served as an opaque download, never as something the browser
/// will render in the app's own origin. A stored `.html` or `.svg` that renders
/// inline is stored XSS with the session token in reach.
#[tokio::test]
async fn uploads_are_served_as_opaque_attachments() {
    let app = spawn_app().await;
    let sender = register_user(&app, "attachsender", "correct horse battery").await;
    register_user(&app, "attachreceiver", "correct horse battery").await;

    let form = reqwest::multipart::Form::new()
        .text("sender", "attachsender")
        .text("receiver", "attachreceiver")
        .part(
            "file",
            reqwest::multipart::Part::bytes(common::fake_zali_bytes())
                .file_name("payload.html")
                .mime_str("text/html")
                .expect("mime"),
        );

    let resp = app
        .http
        .post(app.url("/api/upload"))
        .header("Authorization", sender.auth_header())
        .multipart(form)
        .send()
        .await
        .expect("upload request");
    assert_eq!(resp.status(), 201, "upload should succeed");
    let body: serde_json::Value = resp.json().await.expect("upload json");
    let id = body["id"].as_str().expect("message id").to_string();

    let download = app
        .http
        .get(app.url(&format!("/api/download/{}", id)))
        .header("Authorization", sender.auth_header())
        .send()
        .await
        .expect("download request");
    assert_eq!(download.status(), 200);

    let content_type = download
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        content_type.starts_with("application/octet-stream"),
        "attachment served as {} — it must never be a renderable type",
        content_type
    );

    let nosniff = download
        .headers()
        .get("x-content-type-options")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert_eq!(
        nosniff, "nosniff",
        "without nosniff the browser may sniff its way back to text/html"
    );
}

/// An authenticated stranger must not be able to read a DM they are not part of.
#[tokio::test]
async fn third_party_cannot_download_a_dm_attachment() {
    let app = spawn_app().await;
    let sender = register_user(&app, "dmsender", "correct horse battery").await;
    register_user(&app, "dmreceiver", "correct horse battery").await;
    let stranger = register_user(&app, "dmstranger", "correct horse battery").await;

    let form = reqwest::multipart::Form::new()
        .text("sender", "dmsender")
        .text("receiver", "dmreceiver")
        .part(
            "file",
            reqwest::multipart::Part::bytes(common::fake_zali_bytes())
                .file_name("secret.zali")
                .mime_str("application/octet-stream")
                .expect("mime"),
        );
    let resp = app
        .http
        .post(app.url("/api/upload"))
        .header("Authorization", sender.auth_header())
        .multipart(form)
        .send()
        .await
        .expect("upload request");
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.expect("upload json");
    let id = body["id"].as_str().expect("message id").to_string();

    let denied = app
        .http
        .get(app.url(&format!("/api/download/{}", id)))
        .header("Authorization", stranger.auth_header())
        .send()
        .await
        .expect("stranger download request");
    assert!(
        denied.status() == 403 || denied.status() == 404,
        "a stranger got {} for someone else's DM attachment",
        denied.status()
    );
}

/// Publishing a client release is the highest-value write on this server — it
/// decides what binary every desktop client downloads and runs. Without
/// `RELEASE_ADMIN_TOKEN` configured the route must be closed, and a wrong token
/// must never be enough.
#[tokio::test]
async fn release_publishing_rejects_unauthorized_callers() {
    let app = spawn_app().await;
    let user = register_user(&app, "releaseuser", "correct horse battery").await;

    let payload = serde_json::json!({
        "platform": "macos",
        "version": "9.9.9",
        "notes": "malicious",
        "downloadUrl": "https://example.invalid/evil.zip",
        "sha256": "0".repeat(64),
    });

    for header in [None, Some(user.auth_header()), Some("Bearer wrong".to_string())] {
        let mut req = app.http.post(app.url("/api/version")).json(&payload);
        if let Some(value) = header.clone() {
            req = req.header("Authorization", value);
        }
        let resp = req.send().await.expect("publish request");
        assert_eq!(
            resp.status(),
            403,
            "publish accepted with Authorization={:?}",
            header
        );
    }
}
