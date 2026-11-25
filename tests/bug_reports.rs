//! Integration tests for `POST /api/bug-reports` and the operator read side.

mod common;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use common::{register_user, spawn_app, spawn_app_with_admin_token};

const OPERATOR: &str = "operator-token-for-tests";
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

fn png(extra: usize) -> String {
    let mut bytes = PNG_MAGIC.to_vec();
    bytes.extend(std::iter::repeat(7u8).take(extra));
    B64.encode(bytes)
}

#[tokio::test]
async fn bug_report_with_image_is_stored_and_operator_can_read_it() {
    let app = spawn_app_with_admin_token(OPERATOR).await;
    let user = register_user(&app, "bugger1", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/bug-reports"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({
            "text": "Кнопка отправки не нажимается",
            "appVersion": "0.2b73",
            "platform": "macos",
            "images": [{ "data": png(32) }],
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
        .get(app.url("/api/bug-reports"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);

    let list: serde_json::Value = app
        .http
        .get(app.url("/api/bug-reports"))
        .header("Authorization", format!("Bearer {OPERATOR}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["count"], 1);
    assert_eq!(list["items"][0]["user"], "bugger1");
    assert_eq!(list["items"][0]["images"], 1);

    let one: serde_json::Value = app
        .http
        .get(app.url(&format!("/api/bug-reports/{id}")))
        .header("Authorization", format!("Bearer {OPERATOR}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(one["text"], "Кнопка отправки не нажимается");
    assert_eq!(one["images"][0]["mime"], "image/png");

    let img = app
        .http
        .get(app.url(&format!("/api/bug-reports/{id}/images/0")))
        .header("Authorization", format!("Bearer {OPERATOR}"))
        .send()
        .await
        .unwrap();
    assert_eq!(img.status(), 200);
    assert_eq!(img.headers()["content-type"], "image/png");
    assert_eq!(img.bytes().await.unwrap().len(), 8 + 32);
}

#[tokio::test]
async fn bug_report_requires_authentication() {
    let app = spawn_app().await;
    let resp = app
        .http
        .post(app.url("/api/bug-reports"))
        .json(&serde_json::json!({ "text": "без входа" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn bug_report_rejects_bad_input() {
    let app = spawn_app().await;
    let user = register_user(&app, "bugger2", "correct horse battery staple").await;
    let post = |body: serde_json::Value| {
        let req = app
            .http
            .post(app.url("/api/bug-reports"))
            .header("Authorization", user.auth_header())
            .json(&body);
        async move { req.send().await.unwrap() }
    };

    // Пустой текст.
    assert_eq!(post(serde_json::json!({ "text": "  " })).await.status(), 400);
    // Слишком длинный текст.
    let long = "я".repeat(4001);
    assert_eq!(post(serde_json::json!({ "text": long })).await.status(), 400);
    // Не картинка (SVG может нести скрипт) — по сигнатуре, а не по заявленному типу.
    let svg = B64.encode("<svg onload=alert(1)></svg>");
    assert_eq!(
        post(serde_json::json!({ "text": "баг", "images": [{ "data": svg, "mime": "image/png" }] }))
            .await
            .status(),
        400
    );
    // Больше пяти картинок.
    let many: Vec<_> = (0..6).map(|_| serde_json::json!({ "data": png(4) })).collect();
    assert_eq!(post(serde_json::json!({ "text": "баг", "images": many })).await.status(), 400);
    // Картинка больше 3 МиБ.
    let big = png(3 * 1024 * 1024);
    assert_eq!(
        post(serde_json::json!({ "text": "баг", "images": [{ "data": big }] })).await.status(),
        400
    );
}

#[tokio::test]
async fn bug_report_is_rate_limited_per_hour() {
    let app = spawn_app().await;
    let user = register_user(&app, "bugger3", "correct horse battery staple").await;
    let mut last = 0;
    for _ in 0..6 {
        last = app
            .http
            .post(app.url("/api/bug-reports"))
            .header("Authorization", user.auth_header())
            .json(&serde_json::json!({ "text": "ещё один баг" }))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16();
    }
    assert_eq!(last, 429);
}

#[tokio::test]
async fn bug_report_log_is_stored_and_returned_to_operator() {
    let app = spawn_app_with_admin_token(OPERATOR).await;
    let user = register_user(&app, "bugger4", "correct horse battery staple").await;

    let with_log = app
        .http
        .post(app.url("/api/bug-reports"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({
            "text": "С журналом",
            "log": { "kind": "bug_report", "journal": ["a", "b"], "trace": ["x"] },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(with_log.status(), 201);
    let with_id = with_log.json::<serde_json::Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let without_log = app
        .http
        .post(app.url("/api/bug-reports"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "text": "Без журнала" }))
        .send()
        .await
        .unwrap();
    assert_eq!(without_log.status(), 201);

    let list: serde_json::Value = app
        .http
        .get(app.url("/api/bug-reports"))
        .header("Authorization", format!("Bearer {OPERATOR}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let flags: Vec<(String, bool)> = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["preview"].as_str().unwrap().to_string(), i["hasLog"].as_bool().unwrap()))
        .collect();
    assert!(flags.contains(&("С журналом".to_string(), true)));
    assert!(flags.contains(&("Без журнала".to_string(), false)));

    let one: serde_json::Value = app
        .http
        .get(app.url(&format!("/api/bug-reports/{with_id}")))
        .header("Authorization", format!("Bearer {OPERATOR}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(one["log"]["journal"][1], "b");
}

#[tokio::test]
async fn bug_report_rejects_bad_or_oversized_log() {
    let app = spawn_app().await;
    let user = register_user(&app, "bugger5", "correct horse battery staple").await;
    let post = |body: serde_json::Value| {
        let req = app
            .http
            .post(app.url("/api/bug-reports"))
            .header("Authorization", user.auth_header())
            .json(&body);
        async move { req.send().await.unwrap() }
    };
    // Журнал — объект, а не строка/массив.
    assert_eq!(post(serde_json::json!({ "text": "баг", "log": "строка" })).await.status(), 400);
    assert_eq!(post(serde_json::json!({ "text": "баг", "log": [1, 2] })).await.status(), 400);
    // Больше 256 КиБ.
    let huge = "x".repeat(300 * 1024);
    assert_eq!(post(serde_json::json!({ "text": "баг", "log": { "trace": huge } })).await.status(), 400);
}
