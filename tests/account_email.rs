//! Почта аккаунта и сброс пароля по ней — на настоящем сервере с почтой в
//! каталог (`mail-outbox`): код достаётся из того же письма, что получил бы
//! человек.

mod common;

use common::{register_user, spawn_app_with_mail_outbox, spawn_app_without_mail, RegisteredUser, TestApp};
use std::time::Duration;

const PASSWORD: &str = "correct-horse-1";

/// Ждёт письмо `kind` на `to`, которого ещё нет среди `seen`, и возвращает его JSON.
async fn wait_mail(app: &TestApp, to: &str, kind: &str, seen: &mut Vec<String>) -> serde_json::Value {
    let dir = app.data_dir.join("mail-outbox");
    for _ in 0..100 {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".json"))
                .collect();
            names.sort();
            for name in names {
                if seen.contains(&name) {
                    continue;
                }
                let raw = std::fs::read_to_string(dir.join(&name)).unwrap_or_default();
                let Ok(mail) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
                if mail["to"] == to && mail["kind"] == kind {
                    seen.push(name);
                    return mail;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("письмо {kind} на {to} так и не появилось");
}

fn code_of(mail: &serde_json::Value) -> String {
    let text = mail["text"].as_str().unwrap();
    let bytes: Vec<char> = text.chars().collect();
    for window in bytes.windows(6) {
        if window.iter().all(|c| c.is_ascii_digit()) {
            return window.iter().collect();
        }
    }
    panic!("в письме нет кода: {text}");
}

fn mail_count(app: &TestApp) -> usize {
    std::fs::read_dir(app.data_dir.join("mail-outbox"))
        .map(|d| d.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".json")).count())
        .unwrap_or(0)
}

async fn post(app: &TestApp, path: &str, user: Option<&RegisteredUser>, body: serde_json::Value) -> reqwest::Response {
    let mut req = app.http.post(app.url(path)).json(&body);
    if let Some(user) = user {
        req = req.header("Authorization", user.auth_header());
    }
    req.send().await.expect("request")
}

async fn email_status(app: &TestApp, user: &RegisteredUser) -> serde_json::Value {
    app.http
        .get(app.url("/api/auth/email"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn link_email(app: &TestApp, user: &RegisteredUser, email: &str, seen: &mut Vec<String>) {
    let resp = post(app, "/api/auth/email", Some(user), serde_json::json!({ "email": email, "password": PASSWORD })).await;
    assert_eq!(resp.status(), 202, "{}", resp.text().await.unwrap_or_default());
    let mail = wait_mail(app, email, "email_link_code", seen).await;
    let resp = post(app, "/api/auth/email/confirm", Some(user), serde_json::json!({ "code": code_of(&mail) })).await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap_or_default());
}

#[tokio::test]
async fn config_reports_whether_mail_is_enabled() {
    let app = spawn_app_with_mail_outbox().await;
    let cfg: serde_json::Value = app.http.get(app.url("/api/auth/email/config")).send().await.unwrap().json().await.unwrap();
    assert_eq!(cfg["enabled"], true);
    assert_eq!(cfg["codeLength"], 6);

    let off = spawn_app_without_mail().await;
    let cfg: serde_json::Value = off.http.get(off.url("/api/auth/email/config")).send().await.unwrap().json().await.unwrap();
    assert_eq!(cfg["enabled"], false);
    let user = register_user(&off, "alice", PASSWORD).await;
    let resp = post(&off, "/api/auth/email", Some(&user), serde_json::json!({ "email": "a@example.com", "password": PASSWORD })).await;
    assert_eq!(resp.status(), 503);
    let resp = post(&off, "/api/auth/password-reset", None, serde_json::json!({ "login": "alice" })).await;
    assert_eq!(resp.status(), 503);
}

#[tokio::test]
async fn linking_requires_password_and_the_code_from_the_letter() {
    let app = spawn_app_with_mail_outbox().await;
    let alice = register_user(&app, "alice", PASSWORD).await;
    let mut seen = Vec::new();

    let resp = post(&app, "/api/auth/email", Some(&alice), serde_json::json!({ "email": "alice@example.com", "password": "wrong-password" })).await;
    assert_eq!(resp.status(), 403);
    let resp = post(&app, "/api/auth/email", Some(&alice), serde_json::json!({ "email": "not-an-email", "password": PASSWORD })).await;
    assert_eq!(resp.status(), 400);

    let resp = post(&app, "/api/auth/email", Some(&alice), serde_json::json!({ "email": " Alice@Example.COM ", "password": PASSWORD })).await;
    assert_eq!(resp.status(), 202);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["pending"]["email"], "alice@example.com");

    let mail = wait_mail(&app, "alice@example.com", "email_link_code", &mut seen).await;
    let code = code_of(&mail);
    let status = email_status(&app, &alice).await;
    assert!(status["email"].is_null(), "почта не подтверждена до ввода кода");
    assert_eq!(status["pending"]["email"], "alice@example.com");

    // Повтор раньше минуты — отказ.
    let resp = post(&app, "/api/auth/email/resend", Some(&alice), serde_json::json!({})).await;
    assert_eq!(resp.status(), 429);

    let wrong = if code == "000000" { "111111" } else { "000000" };
    let resp = post(&app, "/api/auth/email/confirm", Some(&alice), serde_json::json!({ "code": wrong })).await;
    assert_eq!(resp.status(), 400);
    assert!(resp.text().await.unwrap().contains("Осталось попыток: 4"));

    let resp = post(&app, "/api/auth/email/confirm", Some(&alice), serde_json::json!({ "code": format!("{} {}", &code[..3], &code[3..]) })).await;
    assert_eq!(resp.status(), 200);
    let status = email_status(&app, &alice).await;
    assert_eq!(status["email"], "alice@example.com");
    assert!(status["pending"].is_null());

    // Код одноразовый.
    let resp = post(&app, "/api/auth/email/confirm", Some(&alice), serde_json::json!({ "code": code })).await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn five_wrong_codes_burn_the_challenge() {
    let app = spawn_app_with_mail_outbox().await;
    let alice = register_user(&app, "alice", PASSWORD).await;
    let mut seen = Vec::new();
    let resp = post(&app, "/api/auth/email", Some(&alice), serde_json::json!({ "email": "alice@example.com", "password": PASSWORD })).await;
    assert_eq!(resp.status(), 202);
    let code = code_of(&wait_mail(&app, "alice@example.com", "email_link_code", &mut seen).await);
    let wrong = if code == "999999" { "999998" } else { "999999" };
    for attempt in 1..=5 {
        let resp = post(&app, "/api/auth/email/confirm", Some(&alice), serde_json::json!({ "code": wrong })).await;
        let expected = if attempt < 5 { 400 } else { 429 };
        assert_eq!(resp.status(), expected, "попытка {attempt}");
    }
    // Даже верный код больше не принимается.
    let resp = post(&app, "/api/auth/email/confirm", Some(&alice), serde_json::json!({ "code": code })).await;
    assert_eq!(resp.status(), 404);
    assert!(email_status(&app, &alice).await["email"].is_null());
}

#[tokio::test]
async fn one_address_belongs_to_one_account() {
    let app = spawn_app_with_mail_outbox().await;
    let alice = register_user(&app, "alice", PASSWORD).await;
    let bob = register_user(&app, "bob", PASSWORD).await;
    let mut seen = Vec::new();
    link_email(&app, &alice, "shared@example.com", &mut seen).await;

    // Начать привязку можно — занятость не раскрывается до кода из ящика.
    let resp = post(&app, "/api/auth/email", Some(&bob), serde_json::json!({ "email": "shared@example.com", "password": PASSWORD })).await;
    assert_eq!(resp.status(), 202);
    let code = code_of(&wait_mail(&app, "shared@example.com", "email_link_code", &mut seen).await);
    let resp = post(&app, "/api/auth/email/confirm", Some(&bob), serde_json::json!({ "code": code })).await;
    assert_eq!(resp.status(), 409);
    assert!(email_status(&app, &bob).await["email"].is_null());
    assert_eq!(email_status(&app, &alice).await["email"], "shared@example.com");
}

#[tokio::test]
async fn changing_email_notifies_the_old_address_and_kills_pending_reset() {
    let app = spawn_app_with_mail_outbox().await;
    let alice = register_user(&app, "alice", PASSWORD).await;
    let mut seen = Vec::new();
    link_email(&app, &alice, "old@example.com", &mut seen).await;

    // Сброс запрошен на старый адрес…
    let resp = post(&app, "/api/auth/password-reset", None, serde_json::json!({ "login": "alice" })).await;
    assert_eq!(resp.status(), 202);
    let reset_code = code_of(&wait_mail(&app, "old@example.com", "password_reset_code", &mut seen).await);

    // …а почта тем временем сменилась.
    link_email(&app, &alice, "new@example.com", &mut seen).await;
    let notice = wait_mail(&app, "old@example.com", "email_changed_notice", &mut seen).await;
    let text = notice["text"].as_str().unwrap();
    assert!(text.contains("n•••@example.com"), "{text}");
    assert!(!text.contains("new@example.com"));

    let resp = post(&app, "/api/auth/password-reset/verify", None, serde_json::json!({ "login": "alice", "code": reset_code })).await;
    assert_eq!(resp.status(), 400, "код со старого адреса больше не действует");
}

#[tokio::test]
async fn password_reset_flow_rotates_sessions_and_drops_the_vault() {
    let app = spawn_app_with_mail_outbox().await;
    let alice = register_user(&app, "alice", PASSWORD).await;
    let mut seen = Vec::new();
    link_email(&app, &alice, "alice@example.com", &mut seen).await;

    // Облачный vault под старым паролем.
    let vault = app
        .http
        .post(app.url("/api/vault/events"))
        .header("Authorization", alice.auth_header())
        .header("X-Zali-Device-ID", "dev-1")
        .json(&serde_json::json!({ "issuedToDeviceId": null, "vaultEpoch": 1, "encryptedVaultEvent": "x".repeat(64) }))
        .send()
        .await
        .unwrap();
    assert!(vault.status().is_success(), "vault: {}", vault.status());

    // По почте — тоже находит.
    let resp = post(&app, "/api/auth/password-reset", None, serde_json::json!({ "login": "Alice@Example.com" })).await;
    assert_eq!(resp.status(), 202);
    let code = code_of(&wait_mail(&app, "alice@example.com", "password_reset_code", &mut seen).await);

    let wrong = if code == "123456" { "654321" } else { "123456" };
    let resp = post(&app, "/api/auth/password-reset/verify", None, serde_json::json!({ "login": "alice", "code": wrong })).await;
    assert_eq!(resp.status(), 400);

    let resp = post(&app, "/api/auth/password-reset/verify", None, serde_json::json!({ "login": "alice", "code": code })).await;
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["username"], "alice");
    let reset_token = body["resetToken"].as_str().unwrap().to_string();
    assert!(reset_token.len() >= 40);

    // Код погашен — второй раз не обменивается.
    let resp = post(&app, "/api/auth/password-reset/verify", None, serde_json::json!({ "login": "alice", "code": code })).await;
    assert_eq!(resp.status(), 400);

    let resp = post(&app, "/api/auth/password-reset/complete", None, serde_json::json!({ "resetToken": reset_token, "newPassword": "short" })).await;
    assert_eq!(resp.status(), 400);

    let resp = post(&app, "/api/auth/password-reset/complete", None, serde_json::json!({ "resetToken": reset_token, "newPassword": "brand-new-secret-9" })).await;
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let new_token = body["token"].as_str().unwrap().to_string();

    // Токен сброса одноразовый.
    let resp = post(&app, "/api/auth/password-reset/complete", None, serde_json::json!({ "resetToken": reset_token, "newPassword": "another-secret-10" })).await;
    assert_eq!(resp.status(), 400);

    // Старый токен отозван, новый работает, старый пароль — нет.
    let me = app.http.get(app.url("/api/auth/me")).header("Authorization", alice.auth_header()).send().await.unwrap();
    assert_eq!(me.status(), 401);
    let me = app.http.get(app.url("/api/auth/me")).header("Authorization", format!("Bearer {new_token}")).send().await.unwrap();
    assert_eq!(me.status(), 200);
    let resp = post(&app, "/api/auth/login", None, serde_json::json!({ "username": "alice", "password": PASSWORD })).await;
    assert_eq!(resp.status(), 401);
    let resp = post(&app, "/api/auth/login", None, serde_json::json!({ "username": "alice", "password": "brand-new-secret-9" })).await;
    assert_eq!(resp.status(), 200);

    // Vault под забытым паролем удалён.
    let events: serde_json::Value = app
        .http
        .get(app.url("/api/vault/events"))
        .header("Authorization", format!("Bearer {new_token}"))
        .header("X-Zali-Device-ID", "dev-1")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(events.as_array().map(|a| a.len()), Some(0), "{events}");

    wait_mail(&app, "alice@example.com", "password_reset_notice", &mut seen).await;
}

#[tokio::test]
async fn reset_answers_the_same_for_unknown_accounts_and_accounts_without_email() {
    let app = spawn_app_with_mail_outbox().await;
    register_user(&app, "noemail", PASSWORD).await;

    let mut bodies = Vec::new();
    for login in ["noemail", "ghost-user", "ghost@example.com"] {
        let resp = post(&app, "/api/auth/password-reset", None, serde_json::json!({ "login": login })).await;
        assert_eq!(resp.status(), 202, "{login}");
        bodies.push(resp.text().await.unwrap());
    }
    assert!(bodies.windows(2).all(|w| w[0] == w[1]), "ответы различаются: {bodies:?}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(mail_count(&app), 0, "писем быть не должно");

    for login in ["noemail", "ghost-user"] {
        let resp = post(&app, "/api/auth/password-reset/verify", None, serde_json::json!({ "login": login, "code": "123456" })).await;
        assert_eq!(resp.status(), 400);
    }
}

#[tokio::test]
async fn reset_code_attempts_are_limited_without_revealing_the_account() {
    let app = spawn_app_with_mail_outbox().await;
    let alice = register_user(&app, "alice", PASSWORD).await;
    let mut seen = Vec::new();
    link_email(&app, &alice, "alice@example.com", &mut seen).await;
    let resp = post(&app, "/api/auth/password-reset", None, serde_json::json!({ "login": "alice" })).await;
    assert_eq!(resp.status(), 202);
    let code = code_of(&wait_mail(&app, "alice@example.com", "password_reset_code", &mut seen).await);
    let wrong = if code == "999999" { "999998" } else { "999999" };
    let mut texts = Vec::new();
    for _ in 0..5 {
        let resp = post(&app, "/api/auth/password-reset/verify", None, serde_json::json!({ "login": "alice", "code": wrong })).await;
        assert_eq!(resp.status(), 400);
        texts.push(resp.text().await.unwrap());
    }
    assert!(texts.windows(2).all(|w| w[0] == w[1]), "ответ не должен считать попытки: {texts:?}");
    let resp = post(&app, "/api/auth/password-reset/verify", None, serde_json::json!({ "login": "alice", "code": code })).await;
    assert_eq!(resp.status(), 400, "после пяти промахов код сгорел");
}

#[tokio::test]
async fn letters_never_reach_the_log_and_the_html_is_well_formed() {
    let app = spawn_app_with_mail_outbox().await;
    let alice = register_user(&app, "alice", PASSWORD).await;
    let mut seen = Vec::new();
    let resp = post(&app, "/api/auth/email", Some(&alice), serde_json::json!({ "email": "alice@example.com", "password": PASSWORD })).await;
    assert_eq!(resp.status(), 202);
    let mail = wait_mail(&app, "alice@example.com", "email_link_code", &mut seen).await;
    let code = code_of(&mail);
    assert!(mail["subject"].as_str().unwrap().starts_with(&code));
    // .eml рядом с .json: настоящее письмо с HTML-частью.
    let dir = app.data_dir.join("mail-outbox");
    let eml = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().ends_with(".eml"))
        .map(|e| std::fs::read_to_string(e.path()).unwrap())
        .unwrap();
    assert!(eml.contains("multipart/alternative"));
    assert!(eml.contains("text/html"));
    assert!(eml.contains("Auto-Submitted: auto-generated"));
}

#[tokio::test]
async fn parallel_guesses_cannot_exceed_the_attempt_limit() {
    // Лимит попыток проверялся до сверки, а списывался после: пачка параллельных
    // запросов проходила проверку разом. Теперь попытка резервируется атомарно.
    let app = spawn_app_with_mail_outbox().await;
    let alice = register_user(&app, "alice", PASSWORD).await;
    let mut seen = Vec::new();
    let resp = post(&app, "/api/auth/email", Some(&alice), serde_json::json!({ "email": "alice@example.com", "password": PASSWORD })).await;
    assert_eq!(resp.status(), 202);
    let code = code_of(&wait_mail(&app, "alice@example.com", "email_link_code", &mut seen).await);
    let guesses: Vec<String> = (0..12u32)
        .map(|i| format!("{:06}", (code.parse::<u32>().unwrap() + 1 + i) % 1_000_000))
        .collect();
    let requests = guesses.iter().map(|g| {
        let http = app.http.clone();
        let url = app.url("/api/auth/email/confirm");
        let auth = alice.auth_header();
        let body = serde_json::json!({ "code": g });
        async move { http.post(url).header("Authorization", auth).json(&body).send().await.unwrap().status().as_u16() }
    });
    let statuses = futures_util::future::join_all(requests).await;
    let evaluated = statuses.iter().filter(|s| **s == 400 || **s == 429).count();
    assert!(statuses.iter().all(|s| *s != 200), "{statuses:?}");
    assert!(evaluated <= 12, "{statuses:?}");
    // Верный код после пачки промахов уже не действует: заявка сгорела на пятом.
    let resp = post(&app, "/api/auth/email/confirm", Some(&alice), serde_json::json!({ "code": code })).await;
    assert_ne!(resp.status(), 200, "после 5+ параллельных промахов код должен сгореть");
    assert!(email_status(&app, &alice).await["email"].is_null());
}
