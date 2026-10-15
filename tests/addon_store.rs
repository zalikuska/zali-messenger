//! Магазин аддонов — против настоящего сервера.
//!
//! Стережётся: в магазин попадает только официально подписанная собственным
//! автором сборка, целая (отпечаток пересчитывается); цена — целое число ZaliCoin;
//! покупка один раз списывает деньги с покупателя и сразу зачисляет автору;
//! без покупки платный файл не отдаётся, купившему — отдаётся и после снятия с
//! витрины; эмиссия не меняется.

mod common;

use base64::Engine;
use common::{register_user, spawn_app, RegisteredUser, TestApp};
use openssl::{
    ec::EcKey,
    ecdsa::EcdsaSig,
    hash::{hash, MessageDigest},
};
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const SUPPLY: i64 = 100_000;
const PASSWORD: &str = "correct horse battery staple";
const TEST_OFFICIAL_PEM: &str = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBCXHEzrDDQR50ht3jb5IIAYKNY9BB678l7vG5G4iL4IoAoGCCqGSM49\nAwEHoUQDQgAEamDET4L1/slDaWLJ5qCgPvEPiyrr4d/gSeGChWTHBIuRXl1nFc1K\nV/vruZwV98OSTH3I4rsBLe9RUnxtFkcUgw==\n-----END EC PRIVATE KEY-----\n";
const TEST_OFFICIAL_PUBLIC: &str = "BGpgxE+C9f7JQ2liyeagoD7xD4sq6+Hf4EnhgoVkxwSLkV5dZxXNSlf767mcFffDkkx9yOK7AS3vUVJ8bRZHFIM=";

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn use_test_official_key() {
    std::env::set_var("ZALI_ADDON_OFFICIAL_PUBKEY", TEST_OFFICIAL_PUBLIC);
}

/// Контейнер ZALIEXTN: см. docs/ADDONS.md, раздел 1.
fn build_container(id: &str, entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"ZALIEXTN");
    out.push(1);
    out.push(id.len() as u8);
    out.extend_from_slice(id.as_bytes());
    out.push(5);
    out.extend_from_slice(b"addon");
    out.push(0);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (name, data) in entries {
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(data.len() as u64).to_le_bytes());
        out.extend_from_slice(&(data.len() as u64).to_le_bytes());
        out.extend_from_slice(data);
    }
    out
}

/// Отпечаток содержимого — `contentDigest` из addon_format.js.
fn content_digest(entries: &[(&str, Vec<u8>)]) -> String {
    let mut sorted: Vec<&(&str, Vec<u8>)> = entries.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut hasher = Sha256::new();
    hasher.update(b"zali-addon-content:v1\n");
    for (name, data) in sorted {
        hasher.update((name.len() as u32).to_be_bytes());
        hasher.update(name.as_bytes());
        hasher.update((data.len() as u64).to_be_bytes());
        hasher.update(data);
    }
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn signature(kind: &str, id: &str, version: &str, owner: &str, digest: &str) -> Value {
    let signed_at = 1_900_000_000_000i64.min(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64);
    let message = format!("zali-addon-sig:v1\n{kind}\n{id}\n{version}\n{owner}\n{digest}\n{signed_at}");
    let key = EcKey::private_key_from_pem(TEST_OFFICIAL_PEM.as_bytes()).unwrap();
    let digest_bytes = hash(MessageDigest::sha256(), message.as_bytes()).unwrap();
    let sig = EcdsaSig::sign(&digest_bytes, &key).unwrap();
    let mut raw = sig.r().to_vec_padded(32).unwrap();
    raw.extend(sig.s().to_vec_padded(32).unwrap());
    json!({
        "zaliSignature": 1, "kind": kind, "alg": "ES256",
        "publicKey": TEST_OFFICIAL_PUBLIC, "id": id, "version": version, "owner": owner,
        "digest": digest, "signedAt": signed_at, "signature": b64().encode(raw),
    })
}

/// Подписанный официальным (тестовым) ключом аддон автора `owner`.
fn signed_addon(id: &str, version: &str, owner: &str, kind: &str, extra: &str) -> (Vec<u8>, Value) {
    let manifest = json!({
        "zaliAddon": 1, "id": id, "name": "Тестовая игра", "version": version,
        "description": "Описание из манифеста", "author": owner, "entry": "index.html",
        "permissions": ["cache"],
    })
    .to_string();
    let entries = vec![
        ("manifest.json", manifest.into_bytes()),
        ("index.html", format!("<h1>{extra}</h1>").into_bytes()),
    ];
    let sig = signature(kind, id, version, owner, &content_digest(&entries));
    let mut all = entries.clone();
    all.push(("zali-signature.json", sig.to_string().into_bytes()));
    (build_container(id, &all), sig)
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

async fn publish(app: &TestApp, user: &RegisteredUser, file: &[u8], price: i64) -> (u16, Value) {
    post(app, user, "/api/addons/store/publish",
        json!({ "fileBase64": b64().encode(file), "price": price })).await
}

/// Официальная подпись принимается реестром — владелец `id` становится автором.
async fn register_official(app: &TestApp, user: &RegisteredUser, sig: &Value) {
    let (status, body) = post(app, user, "/api/addons/register-official", json!({ "signature": sig })).await;
    assert_eq!(status, 200, "{}", body);
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

#[tokio::test]
async fn only_officially_signed_untampered_builds_by_their_owner_get_into_the_store() {
    use_test_official_key();
    let app = spawn_app().await;
    let author = register_user(&app, "storeauthor1", PASSWORD).await;
    let other = register_user(&app, "storeother01", PASSWORD).await;
    let id = "org.example.shop1";

    // Самоподпись и отсутствие подписи — отказ.
    let (file, _) = signed_addon(id, "1.0.0", "storeauthor1", "self", "a");
    let (status, body) = publish(&app, &author, &file, 0).await;
    assert_eq!(status, 400, "{}", body);
    assert_eq!(body["code"], "not_official");
    let unsigned = build_container(id, &[("manifest.json", json!({"zaliAddon":1,"id":id,"name":"X","version":"1.0.0"}).to_string().into_bytes()), ("index.html", b"x".to_vec())]);
    assert_eq!(publish(&app, &author, &unsigned, 0).await.1["code"], "not_official");

    // Официальная подпись есть, а автора в реестре ещё нет.
    let (file, sig) = signed_addon(id, "1.0.0", "storeauthor1", "official", "a");
    let (status, body) = publish(&app, &author, &file, 0).await;
    assert_eq!(status, 404, "{}", body);
    assert_eq!(body["code"], "not_registered");
    register_official(&app, &author, &sig).await;

    // Чужая подпись, правка после подписи, отрицательная и чрезмерная цена.
    let (status, body) = publish(&app, &other, &file, 0).await;
    assert_eq!(status, 403, "{}", body);
    let tampered = {
        let mut copy = file.clone();
        let at = copy.windows(8).position(|w| w == b"<h1>a</h").unwrap();
        copy[at + 4] = b'b';
        copy
    };
    let (status, body) = publish(&app, &author, &tampered, 0).await;
    assert_eq!(status, 400, "{}", body);
    assert_eq!(body["code"], "bad_signature");
    assert_eq!(publish(&app, &author, &file, -1).await.1["code"], "bad_price");
    assert_eq!(publish(&app, &author, &file, 10_001).await.1["code"], "bad_price");
    assert_eq!(get(&app, &other, "/api/addons/store").await.1["items"].as_array().unwrap().len(), 0);

    // Целая сборка автора проходит и видна всем.
    let (status, body) = publish(&app, &author, &file, 25).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["listing"]["price"], 25);
    assert_eq!(body["listing"]["name"], "Тестовая игра");
    assert_eq!(body["listing"]["summary"], "Описание из манифеста");
    let (_, list) = get(&app, &other, "/api/addons/store").await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["items"][0]["owned"], false);
    assert_eq!(list["items"][0]["owner"], "storeauthor1");
}

#[tokio::test]
async fn buying_pays_the_author_once_and_unlocks_the_file_for_the_buyer_only() {
    use_test_official_key();
    let app = spawn_app().await;
    let rich = register_user(&app, "zalikus", PASSWORD).await;
    let author = register_user(&app, "storeauthor2", PASSWORD).await;
    let buyer = register_user(&app, "storebuyer02", PASSWORD).await;
    let stranger = register_user(&app, "storestrang2", PASSWORD).await;
    let id = "org.example.paid";
    let (file, sig) = signed_addon(id, "1.2.0", "storeauthor2", "official", "paid");
    register_official(&app, &author, &sig).await;
    assert_eq!(publish(&app, &author, &file, 40).await.0, 201);

    // Без покупки платный файл не отдаётся.
    let (status, body) = get(&app, &buyer, &format!("/api/addons/store/{id}/download")).await;
    assert_eq!(status, 402, "{}", body);
    assert_eq!(body["code"], "payment_required");

    // Денег нет — отказ без следа.
    let (status, body) = post(&app, &buyer, &format!("/api/addons/store/{id}/buy"), json!({})).await;
    assert_eq!(status, 400, "{}", body);
    assert_eq!(body["code"], "insufficient_funds");

    let (status, _) = post(&app, &rich, "/api/coins/transfer",
        json!({ "to": "storebuyer02", "amount": 100, "idempotencyKey": "seed" })).await;
    assert_eq!(status, 200);
    let (status, body) = post(&app, &buyer, &format!("/api/addons/store/{id}/buy"), json!({})).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["balance"], 60);
    assert_eq!(balance(&app, &author).await, 40);
    assert_supply_conserved(&app, &rich).await;

    // Повтор не списывает второй раз.
    let (status, body) = post(&app, &buyer, &format!("/api/addons/store/{id}/buy"), json!({})).await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["alreadyOwned"], true);
    assert_eq!(balance(&app, &buyer).await, 60);
    assert_eq!(balance(&app, &author).await, 40);

    // Файл отдаётся купившему байт в байт, чужому — нет, автору — всегда.
    let (status, body) = get(&app, &buyer, &format!("/api/addons/store/{id}/download")).await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(b64().decode(body["dataBase64"].as_str().unwrap()).unwrap(), file);
    assert_eq!(body["version"], "1.2.0");
    assert_eq!(get(&app, &stranger, &format!("/api/addons/store/{id}/download")).await.0, 402);
    assert_eq!(get(&app, &author, &format!("/api/addons/store/{id}/download")).await.0, 200);

    // Автор сам себе не продаёт, цену может поменять только он.
    let (status, body) = post(&app, &author, &format!("/api/addons/store/{id}/buy"), json!({})).await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(balance(&app, &author).await, 40);
    assert_eq!(post(&app, &stranger, &format!("/api/addons/store/{id}/update"), json!({ "price": 0 })).await.0, 403);
    let (status, body) = post(&app, &author, &format!("/api/addons/store/{id}/update"), json!({ "price": 5 })).await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["listing"]["price"], 5);

    // Снятие с витрины: исчезает из списка, у купившего доступ остаётся.
    assert_eq!(send(&app, &stranger, Method::DELETE, &format!("/api/addons/store/{id}"), None).await.0, 404);
    assert_eq!(send(&app, &author, Method::DELETE, &format!("/api/addons/store/{id}"), None).await.0, 200);
    assert_eq!(get(&app, &stranger, "/api/addons/store").await.1["items"].as_array().unwrap().len(), 0);
    assert_eq!(get(&app, &buyer, &format!("/api/addons/store/{id}/download")).await.0, 200);
    assert_eq!(post(&app, &stranger, &format!("/api/addons/store/{id}/buy"), json!({})).await.0, 404);
    assert_supply_conserved(&app, &rich).await;
}

#[tokio::test]
async fn a_free_addon_is_taken_without_money_and_a_new_version_replaces_the_old_one() {
    use_test_official_key();
    let app = spawn_app().await;
    let author = register_user(&app, "storeauthor3", PASSWORD).await;
    let reader = register_user(&app, "storereader3", PASSWORD).await;
    let id = "org.example.free";
    let (v1, sig1) = signed_addon(id, "1.0.0", "storeauthor3", "official", "one");
    register_official(&app, &author, &sig1).await;
    assert_eq!(publish(&app, &author, &v1, 0).await.0, 201);

    // Бесплатный скачивается и без «покупки».
    let (status, body) = get(&app, &reader, &format!("/api/addons/store/{id}/download")).await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["version"], "1.0.0");
    let (status, body) = post(&app, &reader, &format!("/api/addons/store/{id}/buy"), json!({})).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["price"], 0);

    // Новая версия заменяет прежнюю, владелец и цена обновляются.
    let (v2, _sig2) = signed_addon(id, "1.1.0", "storeauthor3", "official", "two");
    let (status, body) = publish(&app, &author, &v2, 0).await;
    assert_eq!(status, 201, "{}", body);
    assert_eq!(body["listing"]["version"], "1.1.0");
    let (_, body) = get(&app, &reader, &format!("/api/addons/store/{id}/download")).await;
    assert_eq!(body["version"], "1.1.0");
    assert_eq!(b64().decode(body["dataBase64"].as_str().unwrap()).unwrap(), v2);

    // Иконка/фон — отдельным запросом; у аддона без них пусто.
    let (status, assets) = get(&app, &reader, &format!("/api/addons/store/{id}/assets")).await;
    assert_eq!(status, 200, "{}", assets);
    assert_eq!(assets["icon"], "");
    assert_eq!(assets["background"], "");

    // Автор видит магазин в «Моих аддонах».
    let (_, mine) = get(&app, &author, "/api/addons/mine").await;
    assert_eq!(mine["addons"][0]["store"]["status"], "active");
    assert_eq!(mine["addons"][0]["store"]["version"], "1.1.0");
}
