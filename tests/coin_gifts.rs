//! ZaliCoin-карточки в каналах и квитанции переводов — против настоящего сервера
//! (см. tests/common/mod.rs).
//!
//! Главное, что здесь стережётся: деньги не появляются и не исчезают. После
//! любой последовательности операций сумма балансов плюс удержанное равна
//! эмиссии, одна карточка с одним зарядом не активируется дважды даже при
//! одновременных запросах, а отмена возвращает только неактивированное.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};
use serde_json::{json, Value};

const SUPPLY: i64 = 100_000;

async fn balance_of(app: &TestApp, user: &RegisteredUser) -> (i64, i64) {
    let body: Value = app
        .http
        .get(app.url("/api/coins/balance"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (body["balance"].as_i64().unwrap(), body["held"].as_i64().unwrap())
}

/// Сумма всех балансов плюс удержанное — обязана всегда равняться эмиссии.
async fn assert_supply_conserved(app: &TestApp, viewer: &RegisteredUser) {
    let body: Value = app
        .http
        .get(app.url("/api/coins/distribution"))
        .header("Authorization", viewer.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
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

/// Приватный сервер zalikus'а с участниками `members`; возвращает (server_id, channel_id).
async fn server_with_members(app: &TestApp, owner: &RegisteredUser, members: &[&str]) -> (String, String) {
    let resp = app
        .http
        .post(app.url("/api/servers"))
        .header("Authorization", owner.auth_header())
        .json(&json!({ "name": "Coins", "is_public": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let server: Value = resp.json().await.unwrap();
    let server_id = server["id"].as_str().unwrap().to_string();
    let channel_id = server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "Общий чат")
        .expect("default text channel")["id"]
        .as_str()
        .unwrap()
        .to_string();
    for member in members {
        let add = app
            .http
            .post(app.url(&format!("/api/servers/{}/members", server_id)))
            .header("Authorization", owner.auth_header())
            .json(&json!({ "username": member, "role": "member" }))
            .send()
            .await
            .unwrap();
        assert_eq!(add.status(), 200, "add member {}", member);
    }
    (server_id, channel_id)
}

async fn create_gift(
    app: &TestApp,
    sender: &RegisteredUser,
    server_id: &str,
    channel_id: &str,
    amount: i64,
    claims: i64,
    key: &str,
) -> reqwest::Response {
    app.http
        .post(app.url("/api/coins/gifts"))
        .header("Authorization", sender.auth_header())
        .json(&json!({
            "serverId": server_id,
            "channelId": channel_id,
            "amount": amount,
            "claims": claims,
            "idempotencyKey": key,
        }))
        .send()
        .await
        .unwrap()
}

async fn claim(app: &TestApp, user: &RegisteredUser, gift_id: &str) -> reqwest::Response {
    app.http
        .post(app.url(&format!("/api/coins/gifts/{}/claim", gift_id)))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap()
}

async fn cancel(app: &TestApp, user: &RegisteredUser, gift_id: &str) -> reqwest::Response {
    app.http
        .post(app.url(&format!("/api/coins/gifts/{}/cancel", gift_id)))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn creating_a_gift_moves_coins_onto_hold() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    let (server_id, channel_id) = server_with_members(&app, &zalikus, &["bob"]).await;

    let resp = create_gift(&app, &zalikus, &server_id, &channel_id, 100, 3, "k1").await;
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["gift"]["status"], "active");
    assert_eq!(body["gift"]["held"], 300);
    assert_eq!(body["balance"], SUPPLY - 300);
    assert_eq!(body["held"], 300);

    assert_eq!(balance_of(&app, &zalikus).await, (SUPPLY - 300, 300));
    assert_supply_conserved(&app, &zalikus).await;

    // Повтор с тем же ключом — та же карточка, второй раз не удерживается.
    let replay = create_gift(&app, &zalikus, &server_id, &channel_id, 100, 3, "k1").await;
    assert_eq!(replay.status(), 200);
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay["gift"]["id"], body["gift"]["id"]);
    assert_eq!(balance_of(&app, &zalikus).await, (SUPPLY - 300, 300));
}

#[tokio::test]
async fn gift_creation_is_validated() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let poor = register_user(&app, "poor", "hunter22").await;
    let outsider = register_user(&app, "outsider", "hunter22").await;
    let (server_id, channel_id) = server_with_members(&app, &zalikus, &["poor"]).await;

    let no_money = create_gift(&app, &poor, &server_id, &channel_id, 10, 1, "a").await;
    assert_eq!(no_money.status(), 400);
    let too_many = create_gift(&app, &zalikus, &server_id, &channel_id, 1, 101, "b").await;
    assert_eq!(too_many.status(), 400);
    let zero = create_gift(&app, &zalikus, &server_id, &channel_id, 0, 1, "c").await;
    assert_eq!(zero.status(), 400);
    let over_supply = create_gift(&app, &zalikus, &server_id, &channel_id, SUPPLY, 2, "d").await;
    assert_eq!(over_supply.status(), 400);
    let not_member = create_gift(&app, &outsider, &server_id, &channel_id, 1, 1, "e").await;
    assert_eq!(not_member.status(), 403);

    assert_eq!(balance_of(&app, &zalikus).await, (SUPPLY, 0));
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn each_account_claims_one_charge_and_only_members_can_claim() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let outsider = register_user(&app, "outsider", "hunter22").await;
    let (server_id, channel_id) = server_with_members(&app, &zalikus, &["bob", "carol"]).await;

    let body: Value = create_gift(&app, &zalikus, &server_id, &channel_id, 50, 2, "k")
        .await
        .json()
        .await
        .unwrap();
    let gift_id = body["gift"]["id"].as_str().unwrap().to_string();

    assert_eq!(claim(&app, &zalikus, &gift_id).await.status(), 403, "sender claimed own gift");
    assert_eq!(claim(&app, &outsider, &gift_id).await.status(), 403, "non-member claimed");

    let first = claim(&app, &bob, &gift_id).await;
    assert_eq!(first.status(), 200);
    let first: Value = first.json().await.unwrap();
    assert_eq!(first["balance"], 50);
    assert_eq!(first["gift"]["claimedCount"], 1);
    assert_eq!(first["gift"]["status"], "active");

    let again = claim(&app, &bob, &gift_id).await;
    assert_eq!(again.status(), 409);
    let again: Value = again.json().await.unwrap();
    assert_eq!(again["code"], "already_claimed");
    assert_eq!(balance_of(&app, &bob).await.0, 50);

    let second: Value = claim(&app, &carol, &gift_id).await.json().await.unwrap();
    assert_eq!(second["gift"]["status"], "exhausted");
    assert_eq!(second["gift"]["held"], 0);
    let claimers: Vec<&str> = second["gift"]["claims"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["username"].as_str().unwrap())
        .collect();
    assert_eq!(claimers.len(), 2);
    assert!(claimers.contains(&"bob") && claimers.contains(&"carol"));

    assert_eq!(balance_of(&app, &zalikus).await, (SUPPLY - 100, 0));
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn concurrent_claims_on_a_single_charge_gift_pay_out_once() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let names: Vec<String> = (0..8).map(|i| format!("racer{}", i)).collect();
    let mut racers = Vec::new();
    for name in &names {
        racers.push(register_user(&app, name, "hunter22").await);
    }
    let member_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let (server_id, channel_id) = server_with_members(&app, &zalikus, &member_refs).await;

    let body: Value = create_gift(&app, &zalikus, &server_id, &channel_id, 777, 1, "race")
        .await
        .json()
        .await
        .unwrap();
    let gift_id = body["gift"]["id"].as_str().unwrap().to_string();

    let attempts = racers.iter().map(|racer| {
        let http = app.http.clone();
        let url = app.url(&format!("/api/coins/gifts/{}/claim", gift_id));
        let auth = racer.auth_header();
        async move {
            http.post(url)
                .header("Authorization", auth)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }
    });
    let statuses = futures_util::future::join_all(attempts).await;
    assert_eq!(statuses.iter().filter(|s| **s == 200).count(), 1, "statuses={:?}", statuses);
    assert_eq!(statuses.iter().filter(|s| **s == 409).count(), racers.len() - 1, "statuses={:?}", statuses);

    let mut paid = 0;
    for racer in &racers {
        paid += balance_of(&app, racer).await.0;
    }
    assert_eq!(paid, 777);
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn cancel_refunds_only_unclaimed_charges() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let (server_id, channel_id) = server_with_members(&app, &zalikus, &["bob", "carol"]).await;

    let body: Value = create_gift(&app, &zalikus, &server_id, &channel_id, 100, 3, "k")
        .await
        .json()
        .await
        .unwrap();
    let gift_id = body["gift"]["id"].as_str().unwrap().to_string();
    assert_eq!(claim(&app, &bob, &gift_id).await.status(), 200);

    assert_eq!(cancel(&app, &bob, &gift_id).await.status(), 403, "non-sender cancelled");

    let cancelled = cancel(&app, &zalikus, &gift_id).await;
    assert_eq!(cancelled.status(), 200);
    let cancelled: Value = cancelled.json().await.unwrap();
    assert_eq!(cancelled["refunded"], 200);
    assert_eq!(cancelled["gift"]["status"], "cancelled");
    assert_eq!(cancelled["gift"]["claimedCount"], 1);
    assert_eq!(cancelled["held"], 0);

    assert_eq!(balance_of(&app, &zalikus).await, (SUPPLY - 100, 0));
    assert_eq!(balance_of(&app, &bob).await.0, 100, "claimed coins must stay with bob");

    let late = claim(&app, &carol, &gift_id).await;
    assert_eq!(late.status(), 409);
    let late: Value = late.json().await.unwrap();
    assert_eq!(late["code"], "gift_cancelled");

    let twice = cancel(&app, &zalikus, &gift_id).await;
    assert_eq!(twice.status(), 409);
    assert_eq!(balance_of(&app, &zalikus).await, (SUPPLY - 100, 0), "double cancel refunded twice");
    assert_supply_conserved(&app, &zalikus).await;
}

#[tokio::test]
async fn gift_state_is_only_visible_to_channel_viewers() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let outsider = register_user(&app, "outsider", "hunter22").await;
    let (server_id, channel_id) = server_with_members(&app, &zalikus, &["bob"]).await;

    let body: Value = create_gift(&app, &zalikus, &server_id, &channel_id, 5, 1, "k")
        .await
        .json()
        .await
        .unwrap();
    let gift_id = body["gift"]["id"].as_str().unwrap().to_string();

    let lookup = |user: &RegisteredUser| {
        let request = app
            .http
            .get(app.url(&format!("/api/coins/gifts?ids={},missing-id", gift_id)))
            .header("Authorization", user.auth_header());
        async move {
            let body: Value = request.send().await.unwrap().json().await.unwrap();
            body["gifts"].as_array().unwrap().len()
        }
    };
    assert_eq!(lookup(&bob).await, 1);
    assert_eq!(lookup(&zalikus).await, 1);
    assert_eq!(lookup(&outsider).await, 0);

    let mine: Value = app
        .http
        .get(app.url("/api/coins/gifts/mine"))
        .header("Authorization", zalikus.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(mine["gifts"].as_array().unwrap().len(), 1);
    assert_eq!(claim(&app, &bob, &gift_id).await.status(), 200);
    let mine: Value = app
        .http
        .get(app.url("/api/coins/gifts/mine"))
        .header("Authorization", zalikus.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(mine["gifts"].as_array().unwrap().is_empty(), "exhausted gift still listed as active");
}

#[tokio::test]
async fn transfer_receipt_is_visible_only_to_both_parties() {
    let app = spawn_app().await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let eve = register_user(&app, "eve", "hunter22").await;

    let resp = app
        .http
        .post(app.url("/api/coins/transfer"))
        .header("Authorization", zalikus.auth_header())
        .json(&json!({ "to": "bob", "amount": 42, "idempotencyKey": "t1", "cardClientId": "card-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    let tx_id = body["transactionId"].as_str().unwrap().to_string();

    // Повтор отдаёт тот же id — иначе клиент после ретрая сослался бы на несуществующий перевод.
    let replay: Value = app
        .http
        .post(app.url("/api/coins/transfer"))
        .header("Authorization", zalikus.auth_header())
        .json(&json!({ "to": "bob", "amount": 42, "idempotencyKey": "t1", "cardClientId": "card-1" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(replay["transactionId"], tx_id);

    for (user, visible) in [(&zalikus, true), (&bob, true), (&eve, false)] {
        let resp = app
            .http
            .get(app.url(&format!("/api/coins/transfers/{}", tx_id)))
            .header("Authorization", user.auth_header())
            .send()
            .await
            .unwrap();
        if visible {
            assert_eq!(resp.status(), 200);
            let receipt: Value = resp.json().await.unwrap();
            assert_eq!(receipt["from"], "zalikus");
            assert_eq!(receipt["to"], "bob");
            assert_eq!(receipt["amount"], 42);
            assert_eq!(receipt["cardClientId"], "card-1");
        } else {
            assert_eq!(resp.status(), 404);
        }
    }

    // Перевод из кошелька карточки не имеет: пустая привязка, а не NULL, иначе его
    // нельзя было бы отличить от перевода, сделанного до появления привязки.
    let wallet: Value = app
        .http
        .post(app.url("/api/coins/transfer"))
        .header("Authorization", zalikus.auth_header())
        .json(&json!({ "to": "bob", "amount": 7, "idempotencyKey": "t2" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let receipt: Value = app
        .http
        .get(app.url(&format!("/api/coins/transfers/{}", wallet["transactionId"].as_str().unwrap())))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(receipt["cardClientId"], "");
}
