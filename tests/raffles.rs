//! Розыгрыши ZaliCoin — против настоящего сервера (см. tests/common/mod.rs).
//!
//! Стережётся: монетные призы замораживаются при создании и в сумме с
//! балансами всегда равны эмиссии; один аккаунт — одно участие, создатель не
//! участвует; итог подводится один раз, места делят призы по диапазонам,
//! неразыгранное возвращается создателю; секрет приза видит только победитель.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};
use reqwest::Method;
use serde_json::{json, Value};
use std::time::Duration;

const SUPPLY: i64 = 100_000;
const PASSWORD: &str = "correct horse battery staple";

fn fast_raffles() {
    std::env::set_var("ZALI_RAFFLE_MIN_SECS", "0");
}

async fn send(app: &TestApp, user: &RegisteredUser, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
    let mut request = app.http.request(method, app.url(path)).header("Authorization", user.auth_header());
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

async fn assert_supply_conserved(app: &TestApp, viewer: &RegisteredUser) {
    let (_, body) = get(app, viewer, "/api/coins/distribution").await;
    let holders: i64 = body["holders"].as_array().unwrap().iter().map(|h| h["balance"].as_i64().unwrap()).sum();
    let total = holders
        + body["held"].as_i64().unwrap()
        + body["treasuries"].as_i64().unwrap()
        + body["addonTreasuries"].as_i64().unwrap();
    assert_eq!(total, SUPPLY, "supply leaked: {}", body);
}

async fn give(app: &TestApp, from: &RegisteredUser, to: &RegisteredUser, amount: i64, key: &str) {
    let (status, body) = post(app, from, "/api/coins/transfer",
        json!({ "to": to.username, "amount": amount, "idempotencyKey": key })).await;
    assert_eq!(status, 200, "{}", body);
}

async fn server_with_members(app: &TestApp, owner: &RegisteredUser, members: &[&str]) -> (String, String) {
    let (status, server) = post(app, owner, "/api/servers", json!({ "name": "Raffles", "is_public": false })).await;
    assert_eq!(status, 201, "{}", server);
    let server_id = server["id"].as_str().unwrap().to_string();
    let channel_id = server["channels"].as_array().unwrap().iter()
        .find(|c| c["name"] == "Общий чат").expect("default text channel")["id"].as_str().unwrap().to_string();
    for member in members {
        common::join_by_invite(app, owner, &server_id, member, PASSWORD).await;
    }
    (server_id, channel_id)
}

fn raffle_body(server: &str, channel: &str, key: &str, ends_in: i64, prizes: Value) -> Value {
    json!({
        "serverId": server, "channelId": channel, "title": "Новогодний",
        "endsInSecs": ends_in, "prizes": prizes, "idempotencyKey": key,
    })
}

#[tokio::test]
async fn prizes_are_held_then_split_by_place_ranges_and_the_rest_returns_to_the_creator() {
    fast_raffles();
    let app = spawn_app().await;
    let rich = register_user(&app, "zalikus", PASSWORD).await;
    let players: Vec<RegisteredUser> = {
        let mut v = Vec::new();
        for i in 0..4 {
            v.push(register_user(&app, &format!("rafplayer{i}"), PASSWORD).await);
        }
        v
    };
    let names: Vec<&str> = players.iter().map(|p| p.username.as_str()).collect();
    let (server, channel) = server_with_members(&app, &rich, &names).await;
    let start = balance(&app, &rich).await;

    // 1–2 места: промокод; 3–6: по 50 ZC (мест 6, людей будет 4 → 2 приза вернутся).
    let prizes = json!([
        { "from": 1, "to": 2, "kind": "item", "label": "Промокод", "secret": "ZALI-SECRET-7" },
        { "from": 3, "to": 6, "kind": "coins", "amount": 50 },
    ]);
    let (status, body) = post(&app, &rich, "/api/raffles", raffle_body(&server, &channel, "r1", 2, prizes.clone())).await;
    assert_eq!(status, 201, "{}", body);
    let id = body["raffle"]["id"].as_str().unwrap().to_string();
    assert_eq!(body["raffle"]["escrow"], 200);
    assert_eq!(balance(&app, &rich).await, start - 200);
    assert_eq!(body["held"], 200);
    assert_supply_conserved(&app, &rich).await;
    // Секрет в общем виде виден только создателю.
    assert_eq!(body["raffle"]["prizes"][0]["secret"], "ZALI-SECRET-7");
    let (_, seen) = get(&app, &players[0], &format!("/api/raffles?ids={id}")).await;
    assert!(seen["raffles"][0]["prizes"][0].get("secret").is_none());

    // Повтор того же ключа — тот же розыгрыш, без второй заморозки.
    let (status, again) = post(&app, &rich, "/api/raffles", raffle_body(&server, &channel, "r1", 2, prizes)).await;
    assert_eq!(status, 200);
    assert_eq!(again["raffle"]["id"], id.as_str());
    assert_eq!(balance(&app, &rich).await, start - 200);

    // Создатель не участвует, остальные — один раз.
    assert_eq!(post(&app, &rich, &format!("/api/raffles/{id}/join"), json!({})).await.0, 403);
    for p in &players {
        assert_eq!(post(&app, p, &format!("/api/raffles/{id}/join"), json!({})).await.0, 201);
    }
    assert_eq!(post(&app, &players[0], &format!("/api/raffles/{id}/join"), json!({})).await.0, 200);
    let (_, v) = get(&app, &players[0], &format!("/api/raffles?ids={id}")).await;
    assert_eq!(v["raffles"][0]["participants"], 4);
    // Посторонний аккаунт (не участник канала) не участвует.
    let outsider = register_user(&app, "rafoutsider", PASSWORD).await;
    assert_eq!(post(&app, &outsider, &format!("/api/raffles/{id}/join"), json!({})).await.0, 403);

    // Время вышло — итог подводится при первом же обращении.
    tokio::time::sleep(Duration::from_millis(2300)).await;
    let (_, drawn) = get(&app, &players[0], &format!("/api/raffles?ids={id}")).await;
    let raffle = &drawn["raffles"][0];
    assert_eq!(raffle["status"], "drawn");
    assert_eq!(post(&app, &players[0], &format!("/api/raffles/{id}/join"), json!({})).await.0, 409);

    // 4 человека, места 1–4: двое с промокодом, двое по 50 ZC; 2 неразыгранных
    // приза (100 ZC) вернулись создателю.
    let winners = raffle["winners"].as_array().unwrap();
    assert_eq!(winners.len(), 4);
    let mut places: Vec<i64> = winners.iter().map(|w| w["place"].as_i64().unwrap()).collect();
    places.sort();
    assert_eq!(places, vec![1, 2, 3, 4]);
    let promo = winners.iter().filter(|w| w["prize"] == "Промокод").count();
    let coins = winners.iter().filter(|w| w["prize"] == "50 ZaliCoin").count();
    assert_eq!((promo, coins), (2, 2));
    assert_eq!(raffle["refunded"], 100);
    assert_eq!(balance(&app, &rich).await, start - 200 + 100);

    let mut with_secret = 0;
    let mut coin_total = 0;
    for p in &players {
        let (_, mine) = get(&app, p, &format!("/api/raffles?ids={id}")).await;
        let you = &mine["raffles"][0]["you"];
        assert_eq!(you["joined"], true);
        if you["prize"] == "Промокод" {
            assert_eq!(you["secret"], "ZALI-SECRET-7");
            with_secret += 1;
        }
        if you["prize"] == "50 ZaliCoin" {
            assert!(you["secret"].is_null());
            coin_total += 50;
        }
    }
    assert_eq!(with_secret, 2);
    let paid: i64 = {
        let mut sum = 0;
        for p in &players {
            sum += balance(&app, p).await;
        }
        sum
    };
    assert_eq!(paid, coin_total);
    assert_eq!(balance(&app, &outsider).await, 0);
    assert_supply_conserved(&app, &rich).await;
}

#[tokio::test]
async fn creation_is_validated_and_cancel_returns_the_whole_hold() {
    fast_raffles();
    let app = spawn_app().await;
    let rich = register_user(&app, "zalikus", PASSWORD).await;
    let poor = register_user(&app, "rafpoor0001", PASSWORD).await;
    let player = register_user(&app, "rafplayer9", PASSWORD).await;
    let (server, channel) = server_with_members(&app, &rich, &["rafpoor0001", "rafplayer9"]).await;
    give(&app, &rich, &poor, 10, "seed").await;

    let coins = |from: i64, to: i64, amount: i64| json!({ "from": from, "to": to, "kind": "coins", "amount": amount });
    // Не хватает денег.
    let (status, body) = post(&app, &poor, "/api/raffles",
        raffle_body(&server, &channel, "p1", 60, json!([coins(1, 5, 100)]))).await;
    assert_eq!(status, 400, "{}", body);
    assert_eq!(body["code"], "insufficient_funds");
    // Пересекающиеся диапазоны, пустые призы, неверное время, нет названия у предмета.
    for (key, prizes, ends) in [
        ("v1", json!([coins(1, 5, 1), coins(5, 8, 1)]), 60),
        ("v2", json!([]), 60),
        ("v3", json!([coins(1, 1, 1)]), 31 * 24 * 3600),
        ("v4", json!([{ "from": 1, "to": 1, "kind": "item", "label": " " }]), 60),
        ("v5", json!([coins(0, 3, 1)]), 60),
    ] {
        let (status, body) = post(&app, &rich, "/api/raffles", raffle_body(&server, &channel, key, ends, prizes)).await;
        assert_eq!(status, 400, "{key}: {body}");
    }
    // Чужой канал.
    let (status, _) = post(&app, &player, "/api/raffles",
        raffle_body("nope", "nope", "x", 60, json!([coins(1, 1, 1)]))).await;
    assert_eq!(status, 403);

    let before = balance(&app, &rich).await;
    let (status, body) = post(&app, &rich, "/api/raffles",
        raffle_body(&server, &channel, "c1", 3600, json!([coins(1, 3, 100)]))).await;
    assert_eq!(status, 201, "{}", body);
    let id = body["raffle"]["id"].as_str().unwrap().to_string();
    assert_eq!(balance(&app, &rich).await, before - 300);
    assert_supply_conserved(&app, &rich).await;
    assert_eq!(post(&app, &player, &format!("/api/raffles/{id}/join"), json!({})).await.0, 201);

    // Отменить может только создатель; возвращается вся заморозка.
    assert_eq!(post(&app, &player, &format!("/api/raffles/{id}/cancel"), json!({})).await.0, 403);
    let (status, body) = post(&app, &rich, &format!("/api/raffles/{id}/cancel"), json!({})).await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["refunded"], 300);
    assert_eq!(balance(&app, &rich).await, before);
    assert_eq!(post(&app, &rich, &format!("/api/raffles/{id}/cancel"), json!({})).await.0, 409);
    assert_eq!(post(&app, &player, &format!("/api/raffles/{id}/join"), json!({})).await.0, 409);
    let (_, mine) = get(&app, &rich, "/api/raffles/mine").await;
    assert_eq!(mine["raffles"].as_array().unwrap().len(), 0);
    assert_supply_conserved(&app, &rich).await;
}
