//! Гостевой режим (`ALLOW_GUEST_MODE=true`) превращает запрос без токена в `Zalikus`.
//! Деньги гостю не принадлежат: каждый денежный маршрут обязан отвечать 401, а сумма
//! балансов — не меняться. Обычный перевод с токеном при этом работает.

mod common;

use common::{register_user, spawn_app_with_guest_mode};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

const MONEY_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/coins/balance"),
    ("POST", "/api/coins/transfer"),
    ("GET", "/api/coins/transfers/x"),
    ("GET", "/api/coins/gifts?server_id=x"),
    ("POST", "/api/coins/gifts"),
    ("GET", "/api/coins/gifts/mine"),
    ("POST", "/api/coins/gifts/x/claim"),
    ("POST", "/api/coins/gifts/x/cancel"),
    ("GET", "/api/raffles"),
    ("POST", "/api/raffles"),
    ("GET", "/api/raffles/mine"),
    ("POST", "/api/raffles/x/join"),
    ("POST", "/api/raffles/x/cancel"),
    ("GET", "/api/coins/treasuries/managed"),
    ("GET", "/api/coins/server-payouts"),
    ("GET", "/api/servers/x/treasury"),
    ("POST", "/api/servers/x/treasury/deposit"),
    ("POST", "/api/servers/x/treasury/payout"),
    ("POST", "/api/addons/x/deposit"),
    ("POST", "/api/addons/x/withdraw"),
    ("POST", "/api/addons/x/payout"),
    ("POST", "/api/addons/store/x/buy"),
];

#[tokio::test]
async fn guest_mode_does_not_open_money_routes() {
    let app = spawn_app_with_guest_mode().await;
    let alice = register_user(&app, "alice_money", "correct-horse-battery").await;

    // Гость в остальном работает как Zalikus — чтобы тест не прошёл вхолостую,
    // убеждаемся, что режим действительно включён: обычный маршрут проходит аутентификацию без токена.
    let probe = app.http.get(app.url("/api/auth/me")).send().await.unwrap();
    // (В пустой БД `Zalikus` нет, поэтому не 200, а ошибка уже после аутентификации.)
    assert_ne!(probe.status(), StatusCode::UNAUTHORIZED, "guest mode must be on for this test");

    for (method, path) in MONEY_ROUTES {
        let resp = app
            .http
            .request(Method::from_bytes(method.as_bytes()).unwrap(), app.url(path))
            .json(&json!({ "to": "alice_money", "amount": 1, "recipient": "alice_money" }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path} must reject a tokenless request in guest mode"
        );
    }

    // Баланс получателя не изменился.
    let body: Value = app
        .http
        .get(app.url("/api/coins/balance"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["held"].as_i64().unwrap(), 0);
}

#[tokio::test]
async fn verified_transfer_still_works_in_guest_mode() {
    let app = spawn_app_with_guest_mode().await;
    let alice = register_user(&app, "alice_pay", "correct-horse-battery").await;
    let bob = register_user(&app, "bob_pay", "correct-horse-battery").await;

    // Обычный путь с токеном: баланс читается (у нового аккаунта 0 — перевод
    // отклонён по сумме, но не по аутентификации).
    for user in [&alice, &bob] {
        let resp = app
            .http
            .get(app.url("/api/coins/balance"))
            .header("Authorization", user.auth_header())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
    let resp = app
        .http
        .post(app.url("/api/coins/transfer"))
        .header("Authorization", alice.auth_header())
        .json(&json!({ "to": "bob_pay", "amount": 1 }))
        .send()
        .await
        .unwrap();
    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
}
