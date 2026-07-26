//! Integration tests for `/releases/:filename` — the public, unauthenticated
//! route that serves client update artifacts.
//!
//! It is unauthenticated by necessity: both the in-app updater and the Inno
//! Setup online installer fetch `downloadUrl` with no Authorization header. That
//! makes the filename fully attacker-controlled, so the traversal and isolation
//! cases below are the point of this file, not an afterthought.

mod common;

use common::spawn_app;

fn plant_release(app: &common::TestApp, name: &str, bytes: &[u8]) {
    let dir = app.data_dir.join("releases");
    std::fs::create_dir_all(&dir).expect("create releases dir");
    std::fs::write(dir.join(name), bytes).expect("write release file");
}

#[tokio::test]
async fn release_artifact_downloads_without_authentication() {
    let app = spawn_app().await;
    plant_release(&app, "ZaliMessenger-1.1.0.exe", b"MZ fake windows binary");

    let res = app
        .http
        .get(app.url("/releases/ZaliMessenger-1.1.0.exe"))
        .send()
        .await
        .expect("release request");

    assert_eq!(res.status(), 200, "updater sends no Authorization header");
    assert_eq!(
        res.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/octet-stream")
    );
    assert_eq!(
        res.bytes().await.expect("release body").as_ref(),
        b"MZ fake windows binary"
    );
}

#[tokio::test]
async fn missing_release_artifact_is_not_found() {
    let app = spawn_app().await;

    let res = app
        .http
        .get(app.url("/releases/nope-1.0.0.exe"))
        .send()
        .await
        .expect("release request");

    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn release_route_rejects_path_traversal() {
    let app = spawn_app().await;
    // A secret one directory up from releases/ — the canonical traversal target.
    std::fs::write(app.data_dir.join("zali_messenger.db.secret"), b"top secret")
        .expect("write secret");

    // Percent-encoded separators, since a bare `..%2F` is the form that survives
    // the router without being collapsed into a different path by the client.
    for name in [
        "..%2Fzali_messenger.db.secret",
        "..%5Czali_messenger.db.secret",
        "%2E%2E%2Fzali_messenger.db.secret",
        "....%2F%2Fzali_messenger.db.secret",
        "%2Fetc%2Fpasswd",
    ] {
        let res = app
            .http
            .get(app.url(&format!("/releases/{}", name)))
            .send()
            .await
            .expect("traversal request");

        assert!(
            res.status() == 400 || res.status() == 404,
            "traversal {:?} must not be served, got {}",
            name,
            res.status()
        );
        let body = res.bytes().await.unwrap_or_default();
        assert!(
            !body.as_ref().windows(10).any(|w| w == b"top secret"),
            "traversal {:?} leaked file contents outside releases/",
            name
        );
    }
}

#[tokio::test]
async fn release_route_refuses_dotfiles_and_odd_names() {
    let app = spawn_app().await;
    plant_release(&app, "ok.exe", b"fine");

    for name in [".env", ".hidden", "with space.exe", "quote\".exe"] {
        let res = app
            .http
            .get(app.url(&format!("/releases/{}", name)))
            .send()
            .await
            .expect("request");
        assert!(
            res.status() == 400 || res.status() == 404,
            "{:?} should be refused, got {}",
            name,
            res.status()
        );
    }

    // The allowlist must not have broken ordinary artifact names.
    let res = app
        .http
        .get(app.url("/releases/ok.exe"))
        .send()
        .await
        .expect("request");
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn user_attachments_are_not_reachable_through_the_release_route() {
    let app = spawn_app().await;
    // uploads/ is a sibling of releases/ and holds user attachments guarded by
    // per-message authorization. The public route must not expose them even
    // when the file name is known.
    let uploads = app.data_dir.join("uploads");
    std::fs::create_dir_all(&uploads).expect("create uploads dir");
    std::fs::write(uploads.join("private.zali"), b"someone's message").expect("write attachment");

    let res = app
        .http
        .get(app.url("/releases/private.zali"))
        .send()
        .await
        .expect("request");

    assert_eq!(
        res.status(),
        404,
        "release route must only read from releases/"
    );
}
