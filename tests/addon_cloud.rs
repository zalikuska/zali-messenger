//! Облако аддонов: 10 МБ на аддон (все пользователи вместе), только подписанным,
//! личная и общая области, сбор данных автором.

mod common;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use common::{register_user, spawn_app, spawn_app_with_admin_token, RegisteredUser, TestApp};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

const ADDON: &str = "org.test.cloud";
// 64 hex-символа: сервер хранит только отпечаток, содержимого не видит.
const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn call(
    app: &TestApp,
    user: &RegisteredUser,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = app
        .http
        .request(method, app.url(path))
        .header("Authorization", user.auth_header());
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req.send().await.expect("request");
    let status = resp.status();
    let value = resp.json::<Value>().await.unwrap_or(Value::Null);
    (status, value)
}

fn enc(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn item(addon: &str, key: &str, scope: &str) -> String {
    format!("/api/addons/{addon}/cloud/item?key={}&scope={scope}", enc(key))
}

fn bytes_value(len: usize) -> Value {
    json!({ "kind": "bytes", "value": B64.encode(vec![7u8; len]) })
}

async fn sign(app: &TestApp, user: &RegisteredUser, id: &str) {
    let (status, body) = call(app, user, Method::POST, "/api/addons/sign",
        Some(json!({ "id": id, "version": "1.0.0", "digest": DIGEST, "name": "Игра" }))).await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn only_a_signed_addon_gets_the_cloud() {
    let app = spawn_app().await;
    let author = register_user(&app, "author1", "hunter22").await;

    // id не закреплён за автором — облака нет совсем.
    for (method, path, body) in [
        (Method::GET, format!("/api/addons/{ADDON}/cloud"), None),
        (Method::PUT, item(ADDON, "k", "user"), Some(json!({ "kind": "json", "value": 1 }))),
        (Method::GET, item(ADDON, "k", "user"), None),
    ] {
        let (status, body) = call(&app, &author, method, &path, body).await;
        assert_eq!(status, 403, "{path}");
        assert_eq!(body["code"], "not_signed");
    }

    sign(&app, &author, ADDON).await;
    let (status, _) = call(&app, &author, Method::PUT, &item(ADDON, "k", "user"),
        Some(json!({ "kind": "json", "value": 1 }))).await;
    assert_eq!(status, 200);

    // Без токена — отказ.
    let resp = app.http.get(app.url(&format!("/api/addons/{ADDON}/cloud"))).send().await.unwrap();
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn personal_areas_are_private_shared_is_read_by_all_and_written_by_the_author() {
    let app = spawn_app().await;
    let author = register_user(&app, "author1", "hunter22").await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    sign(&app, &author, ADDON).await;

    // Личные значения: у каждого свои, одинаковый ключ не пересекается.
    for (user, level) in [(&alice, 3), (&bob, 9)] {
        let (status, _) = call(&app, user, Method::PUT, &item(ADDON, "progress", "user"),
            Some(json!({ "kind": "json", "value": { "level": level } }))).await;
        assert_eq!(status, 200);
    }
    let (_, got) = call(&app, &alice, Method::GET, &item(ADDON, "progress", "user"), None).await;
    assert_eq!(got["value"], json!({ "level": 3 }));
    let (_, got) = call(&app, &bob, Method::GET, &item(ADDON, "progress", "user"), None).await;
    assert_eq!(got["value"], json!({ "level": 9 }));

    // Байты и ключ с «/» и пробелом.
    let (status, _) = call(&app, &alice, Method::PUT, &item(ADDON, "save/slot 1", "user"),
        Some(json!({ "kind": "bytes", "value": B64.encode([1u8, 2, 3, 255]) }))).await;
    assert_eq!(status, 200);
    let (_, got) = call(&app, &alice, Method::GET, &item(ADDON, "save/slot 1", "user"), None).await;
    assert_eq!(got["kind"], "bytes");
    assert_eq!(B64.decode(got["value"].as_str().unwrap()).unwrap(), vec![1u8, 2, 3, 255]);

    // Общая область: пишет только автор, читают все.
    let (status, body) = call(&app, &alice, Method::PUT, &item(ADDON, "news", "shared"),
        Some(json!({ "kind": "json", "value": "хак" }))).await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "forbidden");
    let (status, _) = call(&app, &author, Method::PUT, &item(ADDON, "news", "shared"),
        Some(json!({ "kind": "json", "value": "новый уровень" }))).await;
    assert_eq!(status, 200);
    let (_, got) = call(&app, &bob, Method::GET, &item(ADDON, "news", "shared"), None).await;
    assert_eq!(got["value"], "новый уровень");
    // Личная область не видна через общую и наоборот.
    let (status, _) = call(&app, &bob, Method::GET, &item(ADDON, "progress", "shared"), None).await;
    assert_eq!(status, 404);
    let (status, _) = call(&app, &author, Method::DELETE, &item(ADDON, "news", "shared"), None).await;
    assert_eq!(status, 200);
    let (status, _) = call(&app, &bob, Method::DELETE, &item(ADDON, "news", "shared"), None).await;
    assert_eq!(status, 403);

    // Список личной области и сводка.
    let (_, listing) = call(&app, &alice, Method::GET, &format!("/api/addons/{ADDON}/cloud"), None).await;
    assert_eq!(listing["quota"], 10 * 1024 * 1024);
    assert_eq!(listing["mineQuota"], 1024 * 1024);
    assert_eq!(listing["isOwner"], false);
    let names: Vec<&str> = listing["items"].as_array().unwrap().iter()
        .map(|i| i["key"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["progress", "save/slot 1"]);

    // «Удалить мои данные»: стирает свою область, чужие остаются.
    let (_, cleared) = call(&app, &alice, Method::DELETE, &format!("/api/addons/{ADDON}/cloud"), None).await;
    assert_eq!(cleared["removed"], 2);
    let (status, _) = call(&app, &bob, Method::GET, &item(ADDON, "progress", "user"), None).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn ten_megabytes_belong_to_the_addon_not_to_a_person() {
    let app = spawn_app().await;
    let author = register_user(&app, "author1", "hunter22").await;
    sign(&app, &author, ADDON).await;
    sign(&app, &author, "org.test.other").await;

    // Доля одного человека — 1 МБ: больше он не положит, сколько бы ни ключей.
    let alice = register_user(&app, "alice", "hunter22").await;
    let (status, _) = call(&app, &alice, Method::PUT, &item(ADDON, "a", "user"), Some(bytes_value(1024 * 1024))).await;
    assert_eq!(status, 200);
    let (status, body) = call(&app, &alice, Method::PUT, &item(ADDON, "b", "user"), Some(bytes_value(1))).await;
    assert_eq!(status, 413);
    assert_eq!(body["code"], "quota");
    let (status, _) = call(&app, &alice, Method::PUT, &item(ADDON, "a", "user"), Some(bytes_value(1024 * 1024 + 1))).await;
    assert_eq!(status, 413);

    // Общая область автора занимает пул наравне с чужими данными: 9 МБ в общей —
    // и людям остаётся 1 МБ на всех, а не по 1 МБ каждому.
    let (status, _) = call(&app, &author, Method::PUT, &item(ADDON, "pack", "shared"), Some(bytes_value(9 * 1024 * 1024 - 1024 * 1024))).await;
    assert_eq!(status, 200);
    let (_, listing) = call(&app, &alice, Method::GET, &format!("/api/addons/{ADDON}/cloud"), None).await;
    assert_eq!(listing["bytes"], 8 * 1024 * 1024 + 1024 * 1024);
    let bob = register_user(&app, "bob", "hunter22").await;
    let (status, _) = call(&app, &bob, Method::PUT, &item(ADDON, "a", "user"), Some(bytes_value(1024 * 1024))).await;
    assert_eq!(status, 200); // пул ровно 10 МБ
    let carol = register_user(&app, "carol", "hunter22").await;
    let (status, body) = call(&app, &carol, Method::PUT, &item(ADDON, "a", "user"), Some(bytes_value(1))).await;
    assert_eq!(status, 413);
    assert!(body["message"].as_str().unwrap().contains("заполнено"), "{body}");

    // Замена освобождает место, и у другого аддона пул свой.
    let (status, _) = call(&app, &bob, Method::PUT, &item(ADDON, "a", "user"), Some(bytes_value(10))).await;
    assert_eq!(status, 200);
    let (status, _) = call(&app, &carol, Method::PUT, &item(ADDON, "a", "user"), Some(bytes_value(500_000))).await;
    assert_eq!(status, 200);
    let (status, _) = call(&app, &carol, Method::PUT, &item("org.test.other", "a", "user"), Some(bytes_value(500_000))).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn the_author_collects_what_users_saved_and_nobody_else_can() {
    let app = spawn_app().await;
    let author = register_user(&app, "author1", "hunter22").await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    sign(&app, &author, ADDON).await;
    for (user, text) in [(&alice, "от алисы"), (&bob, "от боба")] {
        let (status, _) = call(&app, user, Method::PUT, &item(ADDON, "survey", "user"),
            Some(json!({ "kind": "json", "value": { "answer": text } }))).await;
        assert_eq!(status, 200);
    }

    // Общая область в сбор не попадает.
    call(&app, &author, Method::PUT, &item(ADDON, "news", "shared"), Some(json!({ "kind": "json", "value": 1 }))).await;

    let (status, list) = call(&app, &author, Method::GET, &format!("/api/addons/{ADDON}/cloud/collect"), None).await;
    assert_eq!(status, 200);
    assert_eq!(list["total"], 2);
    assert_eq!(list["users"], 2);
    let users: Vec<&str> = list["items"].as_array().unwrap().iter().map(|i| i["user"].as_str().unwrap()).collect();
    assert_eq!(users, vec!["alice", "bob"]);

    let (status, one) = call(&app, &author, Method::GET,
        &format!("/api/addons/{ADDON}/cloud/collect/item?user=bob&key=survey"), None).await;
    assert_eq!(status, 200);
    assert_eq!(one["value"], json!({ "answer": "от боба" }));

    // Пользователь чужих данных не видит — ни списком, ни по ключу.
    let (status, body) = call(&app, &alice, Method::GET, &format!("/api/addons/{ADDON}/cloud/collect"), None).await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "forbidden");
    let (status, _) = call(&app, &alice, Method::GET,
        &format!("/api/addons/{ADDON}/cloud/collect/item?user=bob&key=survey"), None).await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn bad_ids_keys_and_payloads_are_rejected() {
    let app = spawn_app().await;
    let author = register_user(&app, "author1", "hunter22").await;
    sign(&app, &author, ADDON).await;

    let (status, _) = call(&app, &author, Method::GET, "/api/addons/Bad..Id/cloud", None).await;
    assert_eq!(status, 400);
    let (status, _) = call(&app, &author, Method::PUT, &item(ADDON, "", "user"), Some(json!({ "kind": "json", "value": 1 }))).await;
    assert_eq!(status, 400);
    let long = "k".repeat(257);
    let (status, _) = call(&app, &author, Method::PUT, &item(ADDON, &long, "user"), Some(json!({ "kind": "json", "value": 1 }))).await;
    assert_eq!(status, 400);
    let (status, _) = call(&app, &author, Method::PUT, &item(ADDON, "x", "user"), Some(json!({ "kind": "text", "value": "a" }))).await;
    assert_eq!(status, 400);
    let (status, _) = call(&app, &author, Method::PUT, &item(ADDON, "x", "user"), Some(json!({ "kind": "bytes", "value": "***" }))).await;
    assert_eq!(status, 400);
    let (status, _) = call(&app, &author, Method::GET, &item(ADDON, "x", "everyone"), None).await;
    assert_eq!(status, 400);
}

const RATE_ADDON: &str = "org.test.rate";
const OPERATOR: &str = "operator-test-token-0123456789";

async fn with_digest(
    app: &TestApp,
    user: &RegisteredUser,
    method: Method,
    path: &str,
    body: Option<Value>,
    digest: &str,
) -> (StatusCode, Value) {
    let mut req = app
        .http
        .request(method, app.url(path))
        .header("Authorization", user.auth_header())
        .header("X-Zali-Addon-Digest", digest);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req.send().await.expect("request");
    let status = resp.status();
    (status, resp.json::<Value>().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn the_author_s_reads_leave_a_trace_the_person_can_see() {
    let app = spawn_app().await;
    let author = register_user(&app, "author1", "hunter22").await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    sign(&app, &author, ADDON).await;
    for user in [&alice, &bob] {
        call(&app, user, Method::PUT, &item(ADDON, "survey", "user"),
            Some(json!({ "kind": "json", "value": "ответ" }))).await;
    }

    let (_, before) = call(&app, &alice, Method::GET, &format!("/api/addons/{ADDON}/cloud/audit"), None).await;
    assert_eq!(before["reads"], 0);
    assert_eq!(before["listings"], 0);

    // Автор читает значение Алисы и смотрит список.
    call(&app, &author, Method::GET, &format!("/api/addons/{ADDON}/cloud/collect/item?user=alice&key=survey"), None).await;
    call(&app, &author, Method::GET, &format!("/api/addons/{ADDON}/cloud/collect"), None).await;

    let (_, alice_view) = call(&app, &alice, Method::GET, &format!("/api/addons/{ADDON}/cloud/audit"), None).await;
    assert_eq!(alice_view["reads"], 1, "{alice_view}");
    assert_eq!(alice_view["listings"], 1);
    assert!(alice_view["lastAt"].as_i64().unwrap() > 0);
    // Боба автор не читал — но список он видел (имена и размеры).
    let (_, bob_view) = call(&app, &bob, Method::GET, &format!("/api/addons/{ADDON}/cloud/audit"), None).await;
    assert_eq!(bob_view["reads"], 0);
    assert_eq!(bob_view["listings"], 1);
}

#[tokio::test]
async fn an_operator_can_revoke_a_build_and_honest_clients_are_refused() {
    let app = spawn_app_with_admin_token(OPERATOR).await;
    let author = register_user(&app, "author1", "hunter22").await;
    let alice = register_user(&app, "alice", "hunter22").await;
    sign(&app, &author, ADDON).await;
    let bad = "f".repeat(64);
    let good = "a".repeat(64);

    // Обычный человек отозвать сборку не может.
    let (status, _) = call(&app, &alice, Method::POST, "/api/admin/addons/revoke",
        Some(json!({ "addonId": ADDON, "digest": bad }))).await;
    assert_eq!(status, 403);

    let resp = app.http.post(app.url("/api/admin/addons/revoke"))
        .header("Authorization", format!("Bearer {OPERATOR}"))
        .json(&json!({ "addonId": ADDON, "digest": bad, "reason": "крадёт данные" }))
        .send().await.unwrap();
    assert_eq!(resp.status(), 200);

    // Сборка из реестра видна клиентам как отозванная.
    let (_, registry) = call(&app, &alice, Method::GET, &format!("/api/addons/{ADDON}"), None).await;
    assert_eq!(registry["revoked"], json!([bad.clone()]));

    // Отозванная сборка (по заголовку) не получает ни облака, ни новых вкладов.
    let (status, body) = with_digest(&app, &alice, Method::PUT, &item(ADDON, "k", "user"),
        Some(json!({ "kind": "json", "value": 1 })), &bad).await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "revoked");
    let (status, body) = with_digest(&app, &alice, Method::POST, &format!("/api/addons/{ADDON}/deposit"),
        Some(json!({ "amount": 1, "idempotencyKey": "k1" })), &bad).await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "revoked");
    // Другая сборка того же аддона работает.
    let (status, _) = with_digest(&app, &alice, Method::PUT, &item(ADDON, "k", "user"),
        Some(json!({ "kind": "json", "value": 1 })), &good).await;
    assert_eq!(status, 200);

    // Снятие отзыва.
    let resp = app.http.post(app.url("/api/admin/addons/revoke"))
        .header("Authorization", format!("Bearer {OPERATOR}"))
        .json(&json!({ "addonId": ADDON, "digest": bad, "restore": true }))
        .send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let (status, _) = with_digest(&app, &alice, Method::PUT, &item(ADDON, "k", "user"),
        Some(json!({ "kind": "json", "value": 2 })), &bad).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn writes_are_rate_limited_per_person_and_addon() {
    let app = spawn_app().await;
    let author = register_user(&app, "rateauthor", "hunter22").await;
    let alice = register_user(&app, "ratealice", "hunter22").await;
    let bob = register_user(&app, "ratebob", "hunter22").await;
    // Счётчик общий на процесс, поэтому у этого теста свои имена и свой аддон.
    sign(&app, &author, RATE_ADDON).await;

    let mut last = StatusCode::OK;
    let mut first_refusal = None;
    for i in 0..130 {
        let (status, _) = call(&app, &alice, Method::PUT, &item(RATE_ADDON, "k", "user"),
            Some(json!({ "kind": "json", "value": i }))).await;
        last = status;
        if status == StatusCode::TOO_MANY_REQUESTS && first_refusal.is_none() {
            first_refusal = Some(i);
        }
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(first_refusal, Some(120), "the 121st write in a minute is refused");
    // Лимит на человека: Бобу это не мешает.
    let (status, _) = call(&app, &bob, Method::PUT, &item(RATE_ADDON, "k", "user"),
        Some(json!({ "kind": "json", "value": 1 }))).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn the_browser_preflight_allows_the_build_digest_header() {
    // Веб-клиент шлёт отпечаток сборки заголовком: если CORS его не перечисляет,
    // браузер обрывает запрос до сервера и аддон видит «нет связи».
    let app = spawn_app().await;
    let resp = app
        .http
        .request(Method::OPTIONS, app.url(&format!("/api/addons/{ADDON}/cloud/item?key=k")))
        .header("Origin", "http://localhost:3000")
        .header("Access-Control-Request-Method", "PUT")
        .header("Access-Control-Request-Headers", "authorization,content-type,x-zali-addon-digest")
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "preflight status {}", resp.status());
    let allowed = resp
        .headers()
        .get("access-control-allow-headers")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    assert!(allowed.contains("x-zali-addon-digest"), "allow-headers: {allowed}");
}
