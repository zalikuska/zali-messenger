//! Integration tests for `POST /api/diagnostics/decrypt-failure`.

mod common;

use common::{register_user, spawn_app};

#[tokio::test]
async fn decrypt_failure_report_is_accepted_and_stored() {
    let app = spawn_app().await;
    let user = register_user(&app, "reporter1", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/diagnostics/decrypt-failure"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({
            "reason": "wrong-key",
            "scope": "dm:reporter1:someone",
            "hasLocalKey": true,
            "localKeyId": "abc123",
            "canonicalKeyId": "def456",
            "keyMatches": false,
            "recentLog": ["line one", "line two"],
        }))
        .send()
        .await
        .expect("report request");

    assert_eq!(resp.status(), 204);

    let row: (String, String, String) = sqlx::query_as(
        "SELECT reported_by, reason, payload FROM decrypt_failure_reports WHERE reported_by = ?",
    )
    .bind("reporter1")
    .fetch_one(&sqlx::SqlitePool::connect(&format!(
        "sqlite://{}/zali_messenger.db",
        app.data_dir.display()
    )).await.expect("connect to test db"))
    .await
    .expect("fetch stored report");

    assert_eq!(row.0, "reporter1");
    assert_eq!(row.1, "wrong-key");
    let payload: serde_json::Value = serde_json::from_str(&row.2).expect("payload json");
    assert_eq!(payload["scope"], "dm:reporter1:someone");
    assert_eq!(payload["keyMatches"], false);
}

#[tokio::test]
async fn decrypt_failure_report_requires_authentication() {
    let app = spawn_app().await;

    let resp = app
        .http
        .post(app.url("/api/diagnostics/decrypt-failure"))
        .json(&serde_json::json!({ "reason": "wrong-key" }))
        .send()
        .await
        .expect("report request");

    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn oversized_decrypt_failure_report_is_rejected() {
    let app = spawn_app().await;
    let user = register_user(&app, "reporter2", "correct horse battery staple").await;

    let huge_log: Vec<String> = (0..5000).map(|i| format!("padding line {i}")).collect();
    let resp = app
        .http
        .post(app.url("/api/diagnostics/decrypt-failure"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "reason": "wrong-key", "recentLog": huge_log }))
        .send()
        .await
        .expect("report request");

    assert_eq!(resp.status(), 413);
}
