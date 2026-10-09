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

// ── Общие отчёты клиентов, чтение оператором, метрики ──────────────────────

#[tokio::test]
async fn client_report_is_stored_and_readable_by_the_operator_only() {
    let app = common::spawn_app_with_admin_token("operator-token-for-tests").await;
    let user = register_user(&app, "reporter2", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/diagnostics/report"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({
            "kind": "voice_failed",
            "appVersion": "0.2b47",
            "platform": "browser",
            "journal": ["a", "b"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let id = resp.json::<serde_json::Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Пользовательский токен — не операторский.
    let forbidden = app
        .http
        .get(app.url("/api/diagnostics/reports"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);

    let list: serde_json::Value = app
        .http
        .get(app.url("/api/diagnostics/reports?kind=voice_failed"))
        .header("Authorization", "Bearer operator-token-for-tests")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["count"], 1);
    assert_eq!(list["items"][0]["id"], id);
    assert_eq!(list["items"][0]["user"], "reporter2");
    assert_eq!(list["items"][0]["platform"], "browser");

    let full: serde_json::Value = app
        .http
        .get(app.url(&format!("/api/diagnostics/reports/{id}")))
        .header("Authorization", "Bearer operator-token-for-tests")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(full["kind"], "voice_failed");
    assert_eq!(full["payload"]["journal"][1], "b");
}

#[tokio::test]
async fn unknown_report_kind_is_kept_as_other_and_oversized_is_rejected() {
    let app = common::spawn_app_with_admin_token("operator-token-for-tests").await;
    let user = register_user(&app, "reporter3", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/diagnostics/report"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "kind": "from-the-future" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let list: serde_json::Value = app
        .http
        .get(app.url("/api/diagnostics/reports?kind=other"))
        .header("Authorization", "Bearer operator-token-for-tests")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["count"], 1);

    let huge = "x".repeat(300 * 1024);
    let resp = app
        .http
        .post(app.url("/api/diagnostics/report"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "kind": "manual", "journal": [huge] }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 413);
}

#[tokio::test]
async fn client_reports_are_rate_limited_per_user() {
    let app = spawn_app().await;
    let user = register_user(&app, "reporter4", "correct horse battery staple").await;
    let mut last = 0;
    for _ in 0..31 {
        last = app
            .http
            .post(app.url("/api/diagnostics/report"))
            .header("Authorization", user.auth_header())
            .json(&serde_json::json!({ "kind": "js_error" }))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16();
    }
    assert_eq!(last, 429, "the 31st report within an hour is refused");
}

#[tokio::test]
async fn metrics_count_requests_and_need_the_operator_token() {
    let app = common::spawn_app_with_admin_token("operator-token-for-tests").await;
    let _ = register_user(&app, "metrics1", "correct horse battery staple").await;
    let health: serde_json::Value = app
        .http
        .get(app.url("/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(health["uptimeSecs"].is_u64());

    let denied = app.http.get(app.url("/api/diagnostics/metrics")).send().await.unwrap();
    assert_eq!(denied.status(), 403);

    let metrics: serde_json::Value = app
        .http
        .get(app.url("/api/diagnostics/metrics"))
        .header("Authorization", "Bearer operator-token-for-tests")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(metrics["requests"]["count"].as_u64().unwrap() >= 2);
    assert!(metrics["routesByTime"].as_array().is_some());
    assert!(metrics["uptimeSecs"].is_u64());
}
