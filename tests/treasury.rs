//! Казна сервера — против настоящего сервера (см. tests/common/mod.rs).
//!
//! Стережётся то же, что у карточек: деньги не появляются и не исчезают. После
//! каждой серии операций сумма балансов, удержанного и всех казн равна эмиссии;
//! выплачивает из казны только тот, у кого есть право «Казна»; одновременные
//! списания не уводят казну в минус; удалённый сервер возвращает остаток владельцу.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};
use reqwest::Method;
use serde_json::{json, Value};

const SUPPLY: i64 = 100_000;

async fn send(app: &TestApp, user: &RegisteredUser, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
    let mut request = app
        .http
        .request(method, app.url(path))
        .header("Authorization", user.auth_header());
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

async fn get(app: &TestApp, user: &RegisteredUser, path: &str) -> (u16, Value) {
    send(app, user, Method::GET, path, None).await
}

async fn post(app: &TestApp, user: &RegisteredUser, path: &str, body: Value) -> (u16, Value) {
    send(app, user, Method::POST, path, Some(body)).await
}

async fn balance(app: &TestApp, user: &RegisteredUser) -> i64 {
    get(app, user, "/api/coins/balance").await.1["balance"].as_i64().unwrap()
}

async fn treasury_balance(app: &TestApp, viewer: &RegisteredUser, server_id: &str) -> i64 {
    let (status, body) = get(app, viewer, &format!("/api/servers/{}/treasury", server_id)).await;
    assert_eq!(status, 200, "{}", body);
    body["balance"].as_i64().unwrap()
}

/// Балансы + удержанное в карточках + все казны — обязаны равняться эмиссии.
async fn assert_supply_conserved(app: &TestApp, viewer: &RegisteredUser) {
    let (_, body) = get(app, viewer, "/api/coins/distribution").await;
    let holders: i64 = body["holders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["balance"].as_i64().unwrap())
        .sum();
    let held = body["held"].as_i64().unwrap();
    let treasuries = body["treasuries"].as_i64().unwrap();
    assert_eq!(
        holders + held + treasuries,
        SUPPLY,
        "supply leaked: holders={} held={} treasuries={}",
        holders,
        held,
        treasuries
    );
}

async fn create_server(app: &TestApp, owner: &RegisteredUser, name: &str, members: &[&str]) -> String {
    let (status, body) = post(app, owner, "/api/servers", json!({ "name": name, "is_public": false })).await;
    assert_eq!(status, 201, "{}", body);
    let server_id = body["id"].as_str().unwrap().to_string();
    for member in members {
        let (status, body) = post(
            app,
            owner,
            &format!("/api/servers/{}/members", server_id),
            json!({ "username": member, "role": "member" }),
        )
        .await;
        assert_eq!(status, 200, "add member {}: {}", member, body);
    }
    server_id
}

async fn create_role(app: &TestApp, owner: &RegisteredUser, server_id: &str, body: Value) -> String {
    let (status, role) = post(app, owner, &format!("/api/servers/{}/roles", server_id), body).await;
    assert_eq!(status, 200, "{}", role);
    role["roleId"].as_str().unwrap().to_string()
}

async fn assign_role(app: &TestApp, owner: &RegisteredUser, server_id: &str, username: &str, role_id: &str) {
    let (status, body) = send(
        app,
        owner,
        Method::PATCH,
        &format!("/api/servers/{}/members/{}", server_id, username),
        Some(json!({ "username": username, "role": role_id })),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
}

async fn give(app: &TestApp, from: &RegisteredUser, to: &str, amount: i64, key: &str) {
    let (status, body) = post(
        app,
        from,
        "/api/coins/transfer",
        json!({ "to": to, "amount": amount, "idempotencyKey": key }),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
}

async fn deposit_own(app: &TestApp, user: &RegisteredUser, server_id: &str, amount: i64, key: &str) -> (u16, Value) {
    post(
        app,
        user,
        &format!("/api/servers/{}/treasury/deposit", server_id),
        json!({ "source": "user", "amount": amount, "idempotencyKey": key }),
    )
    .await
}

async fn payout(
    app: &TestApp,
    user: &RegisteredUser,
    server_id: &str,
    target: &str,
    to: &str,
    amount: i64,
    key: &str,
) -> (u16, Value) {
    post(
        app,
        user,
        &format!("/api/servers/{}/treasury/payout", server_id),
        json!({ "target": target, "to": to, "amount": amount, "note": "за помощь", "idempotencyKey": key }),
    )
    .await
}

#[tokio::test]
async fn members_deposit_their_own_coins_once_per_key() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let server_id = create_server(&app, &zalikus, "Guild", &["bob"]).await;
    give(&app, &zalikus, "bob", 1000, "g1").await;

    let (status, body) = deposit_own(&app, &bob, &server_id, 300, "d1").await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["balance"], 700);
    assert_eq!(body["treasuries"][0]["balance"], 300);

    // Повтор с тем же ключом возвращает ту же операцию и не списывает второй раз.
    let (status, replay) = deposit_own(&app, &bob, &server_id, 300, "d1").await;
    assert_eq!(status, 200);
    assert_eq!(replay["operation"]["id"], body["operation"]["id"]);
    assert_eq!(balance(&app, &bob).await, 700);
    assert_eq!(treasury_balance(&app, &bob, &server_id).await, 300);

    let (status, body) = deposit_own(&app, &bob, &server_id, 5000, "d2").await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "insufficient_funds");

    // Не участник сервера не пополняет казну и не видит её.
    let (status, _) = deposit_own(&app, &carol, &server_id, 1, "d3").await;
    assert_eq!(status, 403);
    let (status, _) = get(&app, &carol, &format!("/api/servers/{}/treasury", server_id)).await;
    assert_eq!(status, 403);

    let (_, view) = get(&app, &bob, &format!("/api/servers/{}/treasury", server_id)).await;
    assert_eq!(view["canManage"], false);
    assert_eq!(view["operations"].as_array().unwrap().len(), 1);
    assert_eq!(view["operations"][0]["sourceKind"], "user");
    assert!(view["roles"].as_array().unwrap().is_empty(), "roles are for managers only");
    assert!(view["members"].as_array().unwrap().is_empty(), "members are for managers only");
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn payouts_need_the_treasury_permission() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let server_id = create_server(&app, &zalikus, "Guild", &["bob", "carol"]).await;
    let (status, _) = deposit_own(&app, &zalikus, &server_id, 1000, "d1").await;
    assert_eq!(status, 201);

    let (status, _) = payout(&app, &bob, &server_id, "user", "carol", 50, "p1").await;
    assert_eq!(status, 403, "a plain member must not spend the treasury");

    let role_id = create_role(
        &app,
        &zalikus,
        &server_id,
        json!({ "name": "Казначей", "can_manage_treasury": true }),
    )
    .await;
    assign_role(&app, &zalikus, &server_id, "bob", &role_id).await;

    let (_, managed) = get(&app, &bob, "/api/coins/treasuries/managed").await;
    assert_eq!(managed["treasuries"][0]["serverId"], server_id.as_str());
    let (_, managed) = get(&app, &carol, "/api/coins/treasuries/managed").await;
    assert!(managed["treasuries"].as_array().unwrap().is_empty());

    let (status, body) = payout(&app, &bob, &server_id, "user", "carol", 50, "p2").await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(balance(&app, &carol).await, 50);
    assert_eq!(treasury_balance(&app, &bob, &server_id).await, 950);

    let (_, payouts) = get(&app, &carol, "/api/coins/server-payouts").await;
    let first = &payouts["payouts"][0];
    assert_eq!(first["serverId"], server_id.as_str());
    assert_eq!(first["serverName"], "Guild");
    assert_eq!(first["amount"], 50);
    assert_eq!(first["actor"], "bob");
    assert_eq!(first["note"], "за помощь");
    assert!(first["roleName"].is_null());

    let (status, _) = payout(&app, &bob, &server_id, "user", "nobody", 1, "p3").await;
    assert_eq!(status, 404);
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn role_payout_pays_every_holder_of_the_role() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let dave = register_user(&app, "dave", "hunter22").await;
    let server_id = create_server(&app, &zalikus, "Guild", &["bob", "carol", "dave"]).await;
    let vip = create_role(&app, &zalikus, &server_id, json!({ "name": "VIP" })).await;
    assign_role(&app, &zalikus, &server_id, "dave", &vip).await;
    let (status, _) = deposit_own(&app, &zalikus, &server_id, 1000, "d1").await;
    assert_eq!(status, 201);

    let (status, body) = payout(&app, &zalikus, &server_id, "role", "member", 10, "r1").await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["operation"]["recipients"], 2);
    assert_eq!(body["operation"]["total"], 20);
    assert_eq!(balance(&app, &bob).await, 10);
    assert_eq!(balance(&app, &carol).await, 10);
    assert_eq!(balance(&app, &dave).await, 0);

    let (status, _) = payout(&app, &zalikus, &server_id, "role", &vip, 100, "r2").await;
    assert_eq!(status, 201);
    assert_eq!(balance(&app, &dave).await, 100);

    // «Все участники» — включая владельца.
    let (status, body) = payout(&app, &zalikus, &server_id, "role", "*", 5, "r3").await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["operation"]["recipients"], 4);
    assert_eq!(treasury_balance(&app, &zalikus, &server_id).await, 860);
    assert_eq!(balance(&app, &zalikus).await, SUPPLY - 1000 + 5);

    let (_, payouts) = get(&app, &dave, "/api/coins/server-payouts").await;
    assert_eq!(payouts["payouts"].as_array().unwrap().len(), 2);
    assert_eq!(payouts["payouts"][1]["roleName"], "VIP");

    // Итог больше казны — не получает никто, а не «первые, на кого хватило».
    let (status, body) = payout(&app, &zalikus, &server_id, "role", "member", 500, "r4").await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "insufficient_funds");
    assert_eq!(balance(&app, &bob).await, 15);

    let empty = create_role(&app, &zalikus, &server_id, json!({ "name": "Пусто" })).await;
    let (status, body) = payout(&app, &zalikus, &server_id, "role", &empty, 1, "r5").await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "no_recipients");
    let (status, _) = payout(&app, &zalikus, &server_id, "role", "owner", 1, "r6").await;
    assert_eq!(status, 404, "the owner is paid as a person, not as a role");

    let (_, view) = get(&app, &zalikus, &format!("/api/servers/{}/treasury", server_id)).await;
    let roles = view["roles"].as_array().unwrap();
    assert_eq!(roles[0]["roleId"], "*");
    assert_eq!(roles[0]["members"], 4);
    assert!(roles.iter().any(|role| role["roleId"] == vip.as_str() && role["members"] == 1));
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn server_to_server_moves_need_rights_on_the_source() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let alpha = create_server(&app, &zalikus, "Alpha", &[]).await;
    let beta = create_server(&app, &zalikus, "Beta", &["bob"]).await;
    let (status, _) = deposit_own(&app, &zalikus, &alpha, 500, "d1").await;
    assert_eq!(status, 201);

    let (status, body) = post(
        &app,
        &zalikus,
        &format!("/api/servers/{}/treasury/deposit", beta),
        json!({ "source": "server", "sourceServerId": alpha, "amount": 200, "idempotencyKey": "s1" }),
    )
    .await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(treasury_balance(&app, &zalikus, &alpha).await, 300);
    assert_eq!(treasury_balance(&app, &zalikus, &beta).await, 200);

    let (status, body) = payout(&app, &zalikus, &beta, "server", &alpha, 50, "s2").await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(treasury_balance(&app, &zalikus, &alpha).await, 350);
    assert_eq!(treasury_balance(&app, &zalikus, &beta).await, 150);

    let (status, _) = payout(&app, &zalikus, &beta, "server", &beta, 1, "s3").await;
    assert_eq!(status, 400);
    let (status, _) = post(
        &app,
        &zalikus,
        &format!("/api/servers/{}/treasury/deposit", beta),
        json!({ "source": "server", "sourceServerId": beta, "amount": 1, "idempotencyKey": "s4" }),
    )
    .await;
    assert_eq!(status, 400);

    // bob состоит в Beta, но казной Alpha не распоряжается.
    let (status, _) = post(
        &app,
        &bob,
        &format!("/api/servers/{}/treasury/deposit", beta),
        json!({ "source": "server", "sourceServerId": alpha, "amount": 10, "idempotencyKey": "s5" }),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(treasury_balance(&app, &zalikus, &alpha).await, 350);

    // История Beta видит и входящую, и исходящую операцию.
    let (_, view) = get(&app, &bob, &format!("/api/servers/{}/treasury", beta)).await;
    assert_eq!(view["operations"].as_array().unwrap().len(), 2);
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn deleting_a_server_returns_its_treasury_to_the_owner() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let server_id = create_server(&app, &zalikus, "Guild", &["bob"]).await;
    give(&app, &zalikus, "bob", 100, "g1").await;
    assert_eq!(deposit_own(&app, &bob, &server_id, 100, "d1").await.0, 201);
    assert_eq!(deposit_own(&app, &zalikus, &server_id, 400, "d2").await.0, 201);
    assert_eq!(balance(&app, &zalikus).await, SUPPLY - 500);

    let (status, _) = send(&app, &zalikus, Method::DELETE, &format!("/api/servers/{}", server_id), None).await;
    assert_eq!(status, 204);
    assert_eq!(balance(&app, &zalikus).await, SUPPLY);

    let (_, payouts) = get(&app, &zalikus, "/api/coins/server-payouts").await;
    assert_eq!(payouts["payouts"][0]["amount"], 500);
    assert_eq!(payouts["payouts"][0]["serverName"], "Guild");
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn concurrent_payouts_cannot_overdraw_the_treasury() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let server_id = create_server(&app, &zalikus, "Guild", &["bob"]).await;
    assert_eq!(deposit_own(&app, &zalikus, &server_id, 100, "d1").await.0, 201);

    let url = app.url(&format!("/api/servers/{}/treasury/payout", server_id));
    let attempts = (0..8).map(|i| {
        let http = app.http.clone();
        let url = url.clone();
        let auth = zalikus.auth_header();
        async move {
            http.post(url)
                .header("Authorization", auth)
                .json(&json!({ "target": "user", "to": "bob", "amount": 60, "idempotencyKey": format!("race-{}", i) }))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }
    });
    let statuses = futures_util::future::join_all(attempts).await;
    assert_eq!(statuses.iter().filter(|s| **s == 201).count(), 1, "{:?}", statuses);
    assert!(statuses.iter().all(|s| *s == 201 || *s == 400), "{:?}", statuses);
    assert_eq!(treasury_balance(&app, &zalikus, &server_id).await, 40);
    assert_eq!(balance(&app, &bob).await, 60);
    assert_supply_conserved(&app, &zalikus).await;
}
