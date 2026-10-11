//! Подпись аддонов, реестр авторов и казна аддона — против настоящего сервера.
//!
//! Стережётся: «свободная» подпись выдаётся любому, но `id` закрепляется за
//! первым; официальная подпись принимается только своим ключом и перехватывает
//! `id`; перевод аддону — только на подписанный аддон; вывод — только владельцем
//! и только того, что пролежало неделю; деньги не появляются и не исчезают.

mod common;

use common::{register_user, spawn_app, spawn_app_with_admin_token, RegisteredUser, TestApp};
use openssl::{
    ec::EcKey,
    ecdsa::EcdsaSig,
    hash::{hash, MessageDigest},
};
use reqwest::Method;
use serde_json::{json, Value};

const SUPPLY: i64 = 100_000;
const PASSWORD: &str = "correct horse battery staple";
const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// Приватный ключ ТЕСТОВОГО «официального» издателя. Не секрет: сервер в тестах
/// принимает именно его публичную часть (ZALI_ADDON_OFFICIAL_PUBKEY).
const TEST_OFFICIAL_PEM: &str = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBCXHEzrDDQR50ht3jb5IIAYKNY9BB678l7vG5G4iL4IoAoGCCqGSM49\nAwEHoUQDQgAEamDET4L1/slDaWLJ5qCgPvEPiyrr4d/gSeGChWTHBIuRXl1nFc1K\nV/vruZwV98OSTH3I4rsBLe9RUnxtFkcUgw==\n-----END EC PRIVATE KEY-----\n";
const TEST_OFFICIAL_PUBLIC: &str = "BGpgxE+C9f7JQ2liyeagoD7xD4sq6+Hf4EnhgoVkxwSLkV5dZxXNSlf767mcFffDkkx9yOK7AS3vUVJ8bRZHFIM=";

fn use_test_official_key() {
    std::env::set_var("ZALI_ADDON_OFFICIAL_PUBKEY", TEST_OFFICIAL_PUBLIC);
    // Приватная часть — чтобы сервер мог подписывать одобренные заявки.
    let path = std::env::temp_dir().join(format!("zali-addons-official-{}.pem", std::process::id()));
    std::fs::write(&path, TEST_OFFICIAL_PEM).unwrap();
    std::env::set_var("ZALI_ADDON_OFFICIAL_KEY_FILE", &path);
}

const OPERATOR_TOKEN: &str = "operator-test-token-0123456789";

async fn operator(app: &TestApp, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
    let mut request = app
        .http
        .request(method, app.url(path))
        .header("Authorization", format!("Bearer {OPERATOR_TOKEN}"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn official_signature(id: &str, version: &str, owner: &str, signed_at: i64) -> Value {
    let message = format!(
        "zali-addon-sig:v1\nofficial\n{id}\n{version}\n{owner}\n{DIGEST}\n{signed_at}"
    );
    let key = EcKey::private_key_from_pem(TEST_OFFICIAL_PEM.as_bytes()).unwrap();
    let digest = hash(MessageDigest::sha256(), message.as_bytes()).unwrap();
    let sig = EcdsaSig::sign(&digest, &key).unwrap();
    let mut raw = sig.r().to_vec_padded(32).unwrap();
    raw.extend(sig.s().to_vec_padded(32).unwrap());
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    json!({
        "zaliSignature": 1, "kind": "official", "alg": "ES256",
        "publicKey": TEST_OFFICIAL_PUBLIC, "id": id, "version": version, "owner": owner,
        "digest": DIGEST, "signedAt": signed_at, "signature": b64.encode(raw),
    })
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

async fn give(app: &TestApp, from: &RegisteredUser, to: &RegisteredUser, amount: i64, key: &str) {
    let (status, body) = post(
        app, from, "/api/coins/transfer",
        json!({ "to": to.username, "amount": amount, "idempotencyKey": key }),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
}

async fn sign(app: &TestApp, user: &RegisteredUser, id: &str, version: &str) -> (u16, Value) {
    post(app, user, "/api/addons/sign", json!({ "id": id, "version": version, "digest": DIGEST, "name": "Игра" })).await
}

/// Эмиссия: все балансы + все казны аддонов (карточек и казн серверов в тестах нет).
async fn assert_supply_conserved(app: &TestApp, viewer: &RegisteredUser) {
    let (_, body) = get(app, viewer, "/api/coins/distribution").await;
    let holders: i64 = body["holders"].as_array().unwrap().iter().map(|h| h["balance"].as_i64().unwrap()).sum();
    let total = holders
        + body["held"].as_i64().unwrap()
        + body["treasuries"].as_i64().unwrap()
        + body["addonTreasuries"].as_i64().unwrap();
    assert_eq!(total, SUPPLY, "supply leaked: {}", body);
}

#[tokio::test]
async fn anyone_can_self_sign_but_the_id_belongs_to_the_first_signer() {
    use_test_official_key();
    let app = spawn_app().await;
    let alice = register_user(&app, "addalice1", PASSWORD).await;
    let bob = register_user(&app, "addbobby01", PASSWORD).await;

    let (status, keys) = app.http.get(app.url("/api/addons/signing-key")).send().await
        .map(|r| (r.status().as_u16(), r)).unwrap();
    assert_eq!(status, 200);
    let keys: Value = keys.json().await.unwrap();
    assert_eq!(keys["official"]["publicKey"], TEST_OFFICIAL_PUBLIC);
    let self_key = keys["self"]["publicKey"].as_str().unwrap().to_string();

    let (status, body) = sign(&app, &alice, "org.example.game", "1.0.0").await;
    assert_eq!(status, 200, "{}", body);
    let sig = &body["signature"];
    assert_eq!(sig["kind"], "self");
    assert_eq!(sig["owner"], "addalice1");
    assert_eq!(sig["publicKey"], self_key.as_str());
    assert_eq!(sig["digest"], DIGEST);
    assert_eq!(sig["signature"].as_str().unwrap().len(), 88, "64 raw bytes in base64");

    // Тот же аддон — новая версия: можно. Чужой — нельзя.
    assert_eq!(sign(&app, &alice, "org.example.game", "1.1.0").await.0, 200);
    let (status, body) = sign(&app, &bob, "org.example.game", "9.9.9").await;
    assert_eq!(status, 409, "{}", body);
    assert_eq!(body["code"], "addon_taken");

    let (status, registry) = get(&app, &bob, "/api/addons/org.example.game").await;
    assert_eq!(status, 200);
    assert_eq!(registry["registered"], true);
    assert_eq!(registry["owner"], "addalice1");
    assert_eq!(registry["kind"], "self");
    let (_, unknown) = get(&app, &bob, "/api/addons/org.example.nothing").await;
    assert_eq!(unknown["registered"], false);

    // Мусор отвергается.
    for body in [
        json!({ "id": "BAD ID", "version": "1", "digest": DIGEST }),
        json!({ "id": "org.example.ok", "version": "1 0", "digest": DIGEST }),
        json!({ "id": "org.example.ok", "version": "1", "digest": "abc" }),
    ] {
        assert_eq!(post(&app, &alice, "/api/addons/sign", body).await.0, 400);
    }
}

#[tokio::test]
async fn an_official_signature_is_checked_and_takes_the_id_over() {
    use_test_official_key();
    let app = spawn_app().await;
    let alice = register_user(&app, "offalice01", PASSWORD).await;
    let bob = register_user(&app, "offbobby01", PASSWORD).await;
    let now = chrono::Utc::now().timestamp_millis();

    // Бобу достался id раньше.
    assert_eq!(sign(&app, &bob, "org.zali.chess", "1.0.0").await.0, 200);

    // Подпись не тем ключом, подпись с подменённым владельцем и подпись «из будущего».
    let mut forged = official_signature("org.zali.chess", "1.0.0", "offalice01", now);
    forged["owner"] = json!("offbobby01");
    assert_eq!(post(&app, &alice, "/api/addons/register-official", json!({ "signature": forged })).await.0, 400);
    let mut other_key = official_signature("org.zali.chess", "1.0.0", "offalice01", now);
    other_key["publicKey"] = json!("BDUcWsKrt/KoOeUnExrEScgAqUD3JEPCDLS5OqWmER0pm+FXwhzClXxkEh0KG4WdLkm9czOJXgXSuMuYlOcrMWw=");
    assert_eq!(post(&app, &alice, "/api/addons/register-official", json!({ "signature": other_key })).await.0, 400);
    let future = official_signature("org.zali.chess", "1.0.0", "offalice01", now + 3_600_000);
    assert_eq!(post(&app, &alice, "/api/addons/register-official", json!({ "signature": future })).await.0, 400);
    let (_, still) = get(&app, &alice, "/api/addons/org.zali.chess").await;
    assert_eq!(still["owner"], "offbobby01", "a rejected signature must change nothing");

    // У Боба на этом id уже есть облако: личная область и общая.
    let put = |scope: &'static str| format!("/api/addons/org.zali.chess/cloud/item?key=k&scope={scope}");
    for scope in ["user", "shared"] {
        let (status, body) = send(&app, &bob, Method::PUT, &put(scope),
            Some(json!({ "kind": "json", "value": "данные Боба" }))).await;
        assert_eq!(status, 200, "{}", body);
    }

    // Настоящая — перехватывает id.
    let good = official_signature("org.zali.chess", "1.0.0", "offalice01", now);
    let (status, body) = post(&app, &bob, "/api/addons/register-official", json!({ "signature": good })).await;
    assert_eq!(status, 200, "{}", body);
    // Данные, собранные на условиях прежнего автора, новому владельцу не достаются.
    for scope in ["user", "shared"] {
        let (status, _) = send(&app, &bob, Method::GET, &put(scope), None).await;
        assert_eq!(status, 404, "cloud ({scope}) must be wiped when the owner changes");
    }
    let (_, collected) = get(&app, &alice, "/api/addons/org.zali.chess/cloud/collect").await;
    assert_eq!(collected["total"], 0);
    let (_, registry) = get(&app, &bob, "/api/addons/org.zali.chess").await;
    assert_eq!(registry["owner"], "offalice01");
    assert_eq!(registry["kind"], "official");

    // Официальный аддон самоподписью не «понизить» — даже его владельцу.
    let (status, body) = sign(&app, &alice, "org.zali.chess", "2.0.0").await;
    assert_eq!(status, 409, "{}", body);
    assert_eq!(body["code"], "addon_official");
}

#[tokio::test]
async fn coins_go_only_to_signed_addons_and_the_owner_waits_a_week() {
    use_test_official_key();
    let app = spawn_app().await;
    // Всю эмиссию при первом запуске получает аккаунт `zalikus` — как в tests/treasury.rs.
    let rich = register_user(&app, "zalikus", PASSWORD).await;
    let player = register_user(&app, "addplayer1", PASSWORD).await;
    let dev = register_user(&app, "adddev0001", PASSWORD).await;
    give(&app, &rich, &player, 500, "seed").await;
    assert_supply_conserved(&app, &rich).await;

    // Неподписанному аддону переводить нельзя.
    let (status, body) = post(&app, &player, "/api/addons/org.example.shop/deposit",
        json!({ "amount": 10, "idempotencyKey": "d0" })).await;
    assert_eq!(status, 404, "{}", body);
    assert_eq!(body["code"], "not_registered");

    assert_eq!(sign(&app, &dev, "org.example.shop", "1.0.0").await.0, 200);
    let before = balance(&app, &player).await;
    let (status, body) = post(&app, &player, "/api/addons/org.example.shop/deposit",
        json!({ "amount": 120, "idempotencyKey": "d1", "note": "за стикеры" })).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["balance"], before - 120);
    assert_eq!(body["treasury"], 120);
    // Повтор того же ключа — не второй перевод.
    let (status, body) = post(&app, &player, "/api/addons/org.example.shop/deposit",
        json!({ "amount": 120, "idempotencyKey": "d1" })).await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(balance(&app, &player).await, before - 120);
    // Больше, чем есть, — отказ без следа.
    let (status, body) = post(&app, &player, "/api/addons/org.example.shop/deposit",
        json!({ "amount": 999_999, "idempotencyKey": "d2" })).await;
    assert_eq!(status, 400, "{}", body);
    assert_supply_conserved(&app, &rich).await;

    // Автор видит казну и «замок»; вывести только что внесённое нельзя.
    let (status, manage) = get(&app, &dev, "/api/addons/org.example.shop/manage").await;
    assert_eq!(status, 200, "{}", manage);
    assert_eq!(manage["treasury"]["balance"], 120);
    assert_eq!(manage["treasury"]["withdrawable"], 0);
    assert_eq!(manage["treasury"]["locked"], 120);
    assert_eq!(manage["deposits"][0]["username"], "addplayer1");
    let (status, body) = post(&app, &dev, "/api/addons/org.example.shop/withdraw",
        json!({ "amount": 10, "idempotencyKey": "w1" })).await;
    assert_eq!(status, 400, "{}", body);
    assert_eq!(body["code"], "locked");

    // Чужой не владелец и казны не видит.
    let (status, _) = post(&app, &player, "/api/addons/org.example.shop/withdraw",
        json!({ "amount": 10, "idempotencyKey": "w2" })).await;
    assert_eq!(status, 403);
    assert_eq!(get(&app, &player, "/api/addons/org.example.shop/manage").await.0, 404);
    assert_supply_conserved(&app, &rich).await;
}

#[tokio::test]
async fn usage_events_become_owner_only_statistics_for_registered_addons() {
    use_test_official_key();
    let app = spawn_app().await;
    let dev = register_user(&app, "evtdev0001", PASSWORD).await;
    let user = register_user(&app, "evtuser001", PASSWORD).await;

    // До подписи сервер об аддоне ничего не записывает.
    let (status, _) = post(&app, &user, "/api/addons/org.example.stat/events", json!({ "kind": "install", "version": "1.0.0" })).await;
    assert_eq!(status, 204);
    assert_eq!(sign(&app, &dev, "org.example.stat", "1.0.0").await.0, 200);
    assert_eq!(get(&app, &dev, "/api/addons/org.example.stat/manage").await.1["stats"]["installs"], 0);

    for kind in ["install", "launch"] {
        let (status, _) = post(&app, &user, "/api/addons/org.example.stat/events", json!({ "kind": kind, "version": "1.0.0" })).await;
        assert_eq!(status, 204);
    }
    assert_eq!(post(&app, &user, "/api/addons/org.example.stat/events", json!({ "kind": "hack" })).await.0, 400);

    let (_, manage) = get(&app, &dev, "/api/addons/org.example.stat/manage").await;
    assert_eq!(manage["stats"]["installs"], 1);
    assert_eq!(manage["stats"]["launches7d"], 1);
    assert_eq!(manage["stats"]["users7d"], 1);
    assert!(manage["stats"].get("users").is_none(), "owners get counters, not user names");

    let (status, mine) = get(&app, &dev, "/api/addons/mine").await;
    assert_eq!(status, 200);
    assert_eq!(mine["addons"][0]["id"], "org.example.stat");
    assert_eq!(mine["addons"][0]["installs"], 1);

    // Удалил — установок снова 0.
    post(&app, &user, "/api/addons/org.example.stat/events", json!({ "kind": "remove" })).await;
    // Тот же человек в пределах 5 секунд не пишется чаще — подождём, чтобы remove прошёл.
    tokio::time::sleep(std::time::Duration::from_millis(5200)).await;
    post(&app, &user, "/api/addons/org.example.stat/events", json!({ "kind": "remove" })).await;
    let (_, manage) = get(&app, &dev, "/api/addons/org.example.stat/manage").await;
    assert_eq!(manage["stats"]["installs"], 0);
}

#[tokio::test]
async fn a_person_takes_back_only_what_they_sent_and_without_the_developers_week() {
    use_test_official_key();
    let app = spawn_app().await;
    let rich = register_user(&app, "zalikus", PASSWORD).await;
    let player = register_user(&app, "payplayer1", PASSWORD).await;
    let other = register_user(&app, "payplayer2", PASSWORD).await;
    let dev = register_user(&app, "paydev0001", PASSWORD).await;
    give(&app, &rich, &player, 500, "seed1").await;
    give(&app, &rich, &other, 100, "seed2").await;

    assert_eq!(sign(&app, &dev, "org.example.bank", "1.0.0").await.0, 200);
    let dep = |amount: i64, key: &str| json!({ "amount": amount, "idempotencyKey": key });
    assert_eq!(post(&app, &player, "/api/addons/org.example.bank/deposit", dep(120, "d1")).await.0, 201);
    assert_eq!(post(&app, &other, "/api/addons/org.example.bank/deposit", dep(30, "d2")).await.0, 201);

    // Человек видит, сколько может забрать, — это его взнос, а не казна.
    let (_, info) = get(&app, &player, "/api/addons/org.example.bank").await;
    assert_eq!(info["you"]["deposited"], 120);
    assert_eq!(info["you"]["available"], 120);

    // Забрать своё можно сразу — недельное удержание касается разработчика.
    let before = balance(&app, &player).await;
    let (status, body) = post(&app, &player, "/api/addons/org.example.bank/payout", dep(50, "p1")).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["available"], 70);
    assert_eq!(balance(&app, &player).await, before + 50);
    // Повтор того же ключа — не вторая выплата.
    let (status, _) = post(&app, &player, "/api/addons/org.example.bank/payout", dep(50, "p1")).await;
    assert_eq!(status, 200);
    assert_eq!(balance(&app, &player).await, before + 50);

    // Больше своего — нельзя, даже если в казне есть чужие деньги.
    let (status, body) = post(&app, &player, "/api/addons/org.example.bank/payout", dep(71, "p2")).await;
    assert_eq!(status, 400, "{}", body);
    assert_eq!(body["code"], "over_limit");
    assert_eq!(body["available"], 70);
    assert_eq!(post(&app, &player, "/api/addons/org.example.bank/payout", dep(70, "p3")).await.0, 201);
    assert_eq!(post(&app, &player, "/api/addons/org.example.bank/payout", dep(1, "p4")).await.0, 400);

    // Посторонний аккаунт (в том числе «псевдопользователь» разработчика) без
    // своего взноса не получает ничего.
    let alt = register_user(&app, "payalt00001", PASSWORD).await;
    let (status, body) = post(&app, &alt, "/api/addons/org.example.bank/payout", dep(1, "x1")).await;
    assert_eq!(status, 400, "{}", body);
    assert_eq!(body["available"], 0);
    // Неподписанному аддону — нечего забирать.
    assert_eq!(post(&app, &player, "/api/addons/org.example.none/payout", dep(1, "x2")).await.0, 404);

    // В казне остались только чужие 30 — разработчик их ещё не видит выводимыми.
    let (_, manage) = get(&app, &dev, "/api/addons/org.example.bank/manage").await;
    assert_eq!(manage["treasury"]["balance"], 30);
    assert_eq!(manage["treasury"]["withdrawable"], 0);
    assert_eq!(manage["paidOut"], 120);
    assert_supply_conserved(&app, &rich).await;

    // Официальный аддон может платить и сверх внесённого человеком (призы).
    assert_eq!(
        post(&app, &dev, "/api/addons/register-official",
            json!({ "signature": official_signature("org.example.arcade", "1.0.0", "paydev0001", now_ms()) })).await.0,
        200
    );
    assert_eq!(post(&app, &player, "/api/addons/org.example.arcade/deposit", dep(40, "a1")).await.0, 201);
    let before = balance(&app, &alt).await;
    let (status, body) = post(&app, &alt, "/api/addons/org.example.arcade/payout", dep(25, "a2")).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(balance(&app, &alt).await, before + 25);
    // …но не больше, чем есть в казне.
    assert_eq!(post(&app, &alt, "/api/addons/org.example.arcade/payout", dep(16, "a3")).await.0, 400);
    assert_supply_conserved(&app, &rich).await;
}

#[tokio::test]
async fn official_signature_is_requested_per_build_and_issued_only_after_manual_approval() {
    use_test_official_key();
    let app = spawn_app_with_admin_token(OPERATOR_TOKEN).await;
    let dev = register_user(&app, "reqdev00001", PASSWORD).await;
    let stranger = register_user(&app, "reqstranger", PASSWORD).await;
    let other_digest = "f".repeat(64);
    let request = |digest: &str| json!({ "version": "1.0.0", "digest": digest, "note": "Игра для сообщества" });

    // Заявка — только на закреплённый за автором аддон.
    let (status, _) = post(&app, &dev, "/api/addons/org.example.star/official-request", request(DIGEST)).await;
    assert_eq!(status, 404);
    assert_eq!(sign(&app, &dev, "org.example.star", "1.0.0").await.0, 200);
    let (status, _) = post(&app, &stranger, "/api/addons/org.example.star/official-request", request(DIGEST)).await;
    assert_eq!(status, 403);

    let (status, body) = post(&app, &dev, "/api/addons/org.example.star/official-request", request(DIGEST)).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["status"], "pending");

    // До одобрения официальной подписи нет.
    let ask = json!({ "id": "org.example.star", "version": "1.0.0", "digest": DIGEST, "kind": "official" });
    let (status, body) = post(&app, &dev, "/api/addons/sign", ask.clone()).await;
    assert_eq!(status, 403, "{}", body);
    assert_eq!(body["code"], "not_approved");

    // Решает только оператор.
    let decide = |decision: &str, digest: &str| {
        json!({ "addonId": "org.example.star", "digest": digest, "decision": decision, "note": "ок" })
    };
    assert_eq!(post(&app, &dev, "/api/admin/addons/requests/decide", decide("approve", DIGEST)).await.0, 403);
    let (status, queue) = operator(&app, Method::GET, "/api/admin/addons/requests", None).await;
    assert_eq!(status, 200, "{}", queue);
    assert_eq!(queue["requests"].as_array().unwrap().len(), 1);
    assert_eq!(queue["requests"][0]["owner"], "reqdev00001");
    assert_eq!(queue["signerReady"], true);
    let (status, _) = operator(&app, Method::POST, "/api/admin/addons/requests/decide", Some(decide("approve", DIGEST))).await;
    assert_eq!(status, 200);

    // Одобрена конкретная сборка: другой отпечаток — по-прежнему нет.
    let other = json!({ "id": "org.example.star", "version": "1.0.0", "digest": other_digest, "kind": "official" });
    assert_eq!(post(&app, &dev, "/api/addons/sign", other).await.0, 403);
    // Чужой аккаунт одобрением не пользуется.
    assert_eq!(post(&app, &stranger, "/api/addons/sign", ask.clone()).await.0, 403);

    let (status, body) = post(&app, &dev, "/api/addons/sign", ask).await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["signature"]["kind"], "official");
    assert_eq!(body["signature"]["publicKey"], TEST_OFFICIAL_PUBLIC);
    // Выданная подпись проходит ту же проверку, что и подпись офлайн-инструмента.
    let (status, body) = post(&app, &stranger, "/api/addons/register-official",
        json!({ "signature": body["signature"].clone() })).await;
    assert_eq!(status, 200, "{}", body);
    let (_, info) = get(&app, &dev, "/api/addons/org.example.star").await;
    assert_eq!(info["kind"], "official");
    assert_eq!(info["owner"], "reqdev00001");
    // Официальный id самоподписью больше не подписать.
    assert_eq!(sign(&app, &dev, "org.example.star", "1.1.0").await.0, 409);

    // Автор видит состояние заявки в списке своих аддонов.
    let (_, mine) = get(&app, &dev, "/api/addons/mine").await;
    assert_eq!(mine["addons"][0]["officialRequest"]["status"], "approved");

    // Отказ: подписи нет, заявку можно подать заново.
    assert_eq!(sign(&app, &dev, "org.example.moon", "1.0.0").await.0, 200);
    let moon = |digest: &str| json!({ "version": "1.0.0", "digest": digest, "note": "" });
    assert_eq!(post(&app, &dev, "/api/addons/org.example.moon/official-request", moon(DIGEST)).await.0, 201);
    let reject = json!({ "addonId": "org.example.moon", "digest": DIGEST, "decision": "reject", "note": "Нужны правки" });
    assert_eq!(operator(&app, Method::POST, "/api/admin/addons/requests/decide", Some(reject)).await.0, 200);
    let ask = json!({ "id": "org.example.moon", "version": "1.0.0", "digest": DIGEST, "kind": "official" });
    assert_eq!(post(&app, &dev, "/api/addons/sign", ask).await.0, 403);
    let (status, body) = post(&app, &dev, "/api/addons/org.example.moon/official-request", moon(DIGEST)).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["status"], "pending");
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[tokio::test]
async fn the_owner_can_unbind_an_id_and_until_then_nobody_else_can_use_it() {
    use_test_official_key();
    let app = spawn_app().await;
    let rich = register_user(&app, "zalikus", PASSWORD).await;
    let alice = register_user(&app, "unbalice01", PASSWORD).await;
    let bob = register_user(&app, "unbbobby01", PASSWORD).await;
    let player = register_user(&app, "unbplayer1", PASSWORD).await;
    give(&app, &rich, &player, 500, "seed").await;
    let id = "org.example.unbind";

    // Пока id закреплён, чужой подписи не будет — и в ответе видно, за кем он.
    assert_eq!(sign(&app, &alice, id, "1.0.0").await.0, 200);
    let (status, body) = sign(&app, &bob, id, "1.0.0").await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "addon_taken");
    assert!(body["message"].as_str().unwrap().contains("@unbalice01"), "{body}");

    // Отвязать может только владелец, и только то, что закреплено.
    let (status, body) = post(&app, &bob, &format!("/api/addons/{id}/unbind"), json!({})).await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = post(&app, &bob, "/api/addons/org.example.nobody/unbind", json!({})).await;
    assert_eq!(status, 404, "{body}");

    // Деньги людей в казне — отвязать нельзя, иначе они достались бы новому владельцу.
    let (status, _) = post(&app, &player, &format!("/api/addons/{id}/deposit"),
        json!({ "amount": 120, "idempotencyKey": "u1" })).await;
    assert_eq!(status, 201);
    let (status, body) = post(&app, &alice, &format!("/api/addons/{id}/unbind"), json!({})).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "treasury_not_empty");
    // Облако тоже есть — оно должно пережить неудачную отвязку.
    let cloud = format!("/api/addons/{id}/cloud/item?key=k&scope=shared");
    assert_eq!(send(&app, &alice, Method::PUT, &cloud, Some(json!({ "kind": "json", "value": 1 }))).await.0, 200);
    assert_eq!(get(&app, &alice, &cloud).await.0, 200);

    // Человек забрал своё — казна пуста, id отвязывается.
    let (status, body) = post(&app, &player, &format!("/api/addons/{id}/payout"),
        json!({ "amount": 120, "idempotencyKey": "u2" })).await;
    assert_eq!(status, 201, "{body}");
    assert_supply_conserved(&app, &rich).await;
    let (status, body) = post(&app, &alice, &format!("/api/addons/{id}/unbind"), json!({})).await;
    assert_eq!(status, 200, "{body}");
    let (_, registry) = get(&app, &bob, &format!("/api/addons/{id}")).await;
    assert_eq!(registry["registered"], false);

    // Теперь Боб может закрепить его за собой — с чистого листа.
    assert_eq!(sign(&app, &bob, id, "1.0.0").await.0, 200);
    let (_, registry) = get(&app, &bob, &format!("/api/addons/{id}")).await;
    assert_eq!(registry["owner"], "unbbobby01");
    assert_eq!(get(&app, &bob, &cloud).await.0, 404, "the previous author's cloud must be gone");
    let (_, manage) = get(&app, &bob, &format!("/api/addons/{id}/manage")).await;
    assert_eq!(manage["treasury"]["balance"], 0);
    // Старый вкладчик не может утянуть деньги, которые внесут новому владельцу.
    let (_, you) = get(&app, &player, &format!("/api/addons/{id}")).await;
    assert_eq!(you["you"]["available"], 0, "{you}");
    // Прежний владелец теперь чужой для этого id.
    assert_eq!(sign(&app, &alice, id, "2.0.0").await.0, 409);
    assert_eq!(post(&app, &alice, &format!("/api/addons/{id}/unbind"), json!({})).await.0, 403);
}

#[tokio::test]
async fn an_official_id_cannot_be_unbound_by_its_owner() {
    use_test_official_key();
    let app = spawn_app().await;
    let owner = register_user(&app, "unbofficial1", PASSWORD).await;
    let now = chrono::Utc::now().timestamp_millis();
    let good = official_signature("org.zali.pinned", "1.0.0", "unbofficial1", now);
    assert_eq!(post(&app, &owner, "/api/addons/register-official", json!({ "signature": good })).await.0, 200);
    let (status, body) = post(&app, &owner, "/api/addons/org.zali.pinned/unbind", json!({})).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["code"], "addon_official");
    let (_, registry) = get(&app, &owner, "/api/addons/org.zali.pinned").await;
    assert_eq!(registry["owner"], "unbofficial1");
}

/// Подпись релиза: сумма и ссылка приходят одним ответом, поэтому клиент
/// скачивает обновление только при подписи официального ключа над ними обоими.
fn release_signature(platform: &str, version: &str, sha256: &str, url: &str) -> String {
    let message = format!("zali-release-sig:v1\n{platform}\n{version}\n{sha256}\n{url}");
    let key = EcKey::private_key_from_pem(TEST_OFFICIAL_PEM.as_bytes()).unwrap();
    let digest = hash(MessageDigest::sha256(), message.as_bytes()).unwrap();
    let sig = EcdsaSig::sign(&digest, &key).unwrap();
    let mut raw = sig.r().to_vec_padded(32).unwrap();
    raw.extend(sig.s().to_vec_padded(32).unwrap());
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(raw)
}

#[tokio::test]
async fn a_release_is_served_with_its_signature_and_a_forged_one_is_refused() {
    use_test_official_key();
    let app = spawn_app_with_admin_token(OPERATOR_TOKEN).await;
    let sha = "ab".repeat(32);
    let url = "https://msgs.zalikus.org/releases/ZaliMessenger-9.9r1.exe";
    let body = |signature: String, sha: &str, url: &str| {
        json!({ "platform": "windows", "version": "9.9r1", "notes": "", "downloadUrl": url, "sha256": sha, "signature": signature })
    };

    // Подпись на другую ссылку / другую сумму не принимается.
    let for_other_url = release_signature("windows", "9.9r1", &sha, "https://evil.example/ZaliMessenger.exe");
    assert_eq!(operator(&app, Method::POST, "/api/version", Some(body(for_other_url, &sha, url))).await.0, 400);
    let for_other_sum = release_signature("windows", "9.9r1", &"cd".repeat(32), url);
    assert_eq!(operator(&app, Method::POST, "/api/version", Some(body(for_other_sum, &sha, url))).await.0, 400);

    // Верная подпись принимается и отдаётся клиентам.
    let good = release_signature("windows", "9.9r1", &sha, url);
    assert_eq!(operator(&app, Method::POST, "/api/version", Some(body(good.clone(), &sha, url))).await.0, 204);
    let served: Value = app
        .http
        .get(app.url("/api/version?platform=windows"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(served["signature"], good);
    assert_eq!(served["downloadUrl"], url);

    // Без подписи релиз публикуется (старый процесс), но отдаётся с пустой подписью:
    // клиенты такой не скачают.
    let unsigned = json!({ "platform": "macos", "version": "9.9r1", "notes": "", "downloadUrl": url, "sha256": sha });
    assert_eq!(operator(&app, Method::POST, "/api/version", Some(unsigned)).await.0, 204);
    let served: Value = app
        .http
        .get(app.url("/api/version?platform=macos"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(served["signature"], "");
}
