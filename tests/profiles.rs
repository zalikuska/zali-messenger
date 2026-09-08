//! Integration tests for the profile surface: profile read/update, follows,
//! friend requests, wall comments and vector autographs.
//!
//! These run against the real router, so they also pin down the route table
//! itself — `/api/profile/comments/:id` sitting next to `/api/profile/:username`
//! is exactly the kind of overlap that only fails when a request is matched.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};

async fn get_profile(app: &TestApp, viewer: &RegisteredUser, owner: &str) -> serde_json::Value {
    let resp = app
        .http
        .get(app.url(&format!("/api/profile/{}", owner)))
        .header("Authorization", viewer.auth_header())
        .send()
        .await
        .expect("profile request");
    assert_eq!(resp.status(), 200, "profile({}) not 200", owner);
    resp.json().await.expect("profile json")
}

async fn make_friends(app: &TestApp, a: &RegisteredUser, b: &RegisteredUser) {
    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", a.auth_header())
        .json(&serde_json::json!({ "to": b.username }))
        .send()
        .await
        .expect("friend request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("request json");
    let id = body["id"].as_str().expect("request id").to_string();

    let resp = app
        .http
        .post(app.url(&format!("/api/friends/requests/{}", id)))
        .header("Authorization", b.auth_header())
        .json(&serde_json::json!({ "action": "accept" }))
        .send()
        .await
        .expect("accept request");
    assert_eq!(resp.status(), 200);
}

/// One stroke that passes the server's path-data allowlist.
fn sample_strokes() -> serde_json::Value {
    serde_json::json!([
        { "d": "M 10 10 L 40 60 Q 55 20 90 40", "color": "#cbff00", "width": 3.0 }
    ])
}

async fn post_autograph(
    app: &TestApp,
    author: &RegisteredUser,
    owner: &str,
) -> (reqwest::StatusCode, serde_json::Value) {
    let resp = app
        .http
        .post(app.url(&format!("/api/profile/{}/autographs", owner)))
        .header("Authorization", author.auth_header())
        .json(&serde_json::json!({
            "strokes": sample_strokes(),
            "viewBox": "0 0 100 100",
            "x": 0.25,
            "y": 0.4,
            "width": 0.3,
            "height": 0.2,
        }))
        .send()
        .await
        .expect("autograph request");
    let status = resp.status();
    let body = resp.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

async fn list_autographs(
    app: &TestApp,
    viewer: &RegisteredUser,
    owner: &str,
    status: &str,
) -> Vec<serde_json::Value> {
    let resp = app
        .http
        .get(app.url(&format!(
            "/api/profile/{}/autographs?status={}",
            owner, status
        )))
        .header("Authorization", viewer.auth_header())
        .send()
        .await
        .expect("autograph list request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("autograph list json");
    body["autographs"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

// ============================================================
// ПРОФИЛЬ
// ============================================================

#[tokio::test]
async fn profile_defaults_are_served_before_anything_is_saved() {
    let app = spawn_app().await;
    let user = register_user(&app, "profowner", "correct horse battery staple").await;

    let profile = get_profile(&app, &user, "profowner").await;
    assert_eq!(profile["username"], "profowner");
    assert_eq!(profile["commentPolicy"], "anyone");
    assert_eq!(profile["autographPolicy"], "anyone");
    // Ручное одобрение по умолчанию: молча публиковать чужой рисунок на стене
    // человека, который об этом не просил, — не то умолчание.
    assert_eq!(profile["autographAutoApprove"], "nobody");
    assert_eq!(profile["followers"], 0);
    assert_eq!(profile["isSelf"], true);
}

#[tokio::test]
async fn missing_user_profile_is_404() {
    let app = spawn_app().await;
    let user = register_user(&app, "seeker1", "correct horse battery staple").await;

    let resp = app
        .http
        .get(app.url("/api/profile/ghostuser"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .expect("profile request");
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn profile_update_persists_and_omitted_fields_are_kept() {
    let app = spawn_app().await;
    let user = register_user(&app, "editor01", "correct horse battery staple").await;

    let resp = app
        .http
        .put(app.url("/api/profile"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({
            "displayName": "Редактор",
            "bio": "Пишу код",
            "accentColor": "#CBFF00",
            "commentPolicy": "friends",
            "links": [
                { "label": "сайт", "url": "https://example.org" },
                { "label": "плохая", "url": "javascript:alert(1)" }
            ],
        }))
        .send()
        .await
        .expect("update request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("update json");
    assert_eq!(body["displayName"], "Редактор");
    assert_eq!(body["accentColor"], "#cbff00");
    assert_eq!(body["commentPolicy"], "friends");
    // javascript: в href — это XSS на чужой странице, такие ссылки не сохраняются.
    let links = body["links"].as_array().expect("links array");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["url"], "https://example.org");

    // Второй PUT трогает только статус — остальное должно уцелеть.
    let resp = app
        .http
        .put(app.url("/api/profile"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "status": "на связи" }))
        .send()
        .await
        .expect("second update request");
    assert_eq!(resp.status(), 200);

    let profile = get_profile(&app, &user, "editor01").await;
    assert_eq!(profile["status"], "на связи");
    assert_eq!(profile["displayName"], "Редактор");
    assert_eq!(profile["bio"], "Пишу код");
    assert_eq!(profile["commentPolicy"], "friends");
}

#[tokio::test]
async fn unknown_policy_value_is_rejected_instead_of_silently_ignored() {
    let app = spawn_app().await;
    let user = register_user(&app, "policyman", "correct horse battery staple").await;

    let resp = app
        .http
        .put(app.url("/api/profile"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "commentPolicy": "only-cool-people" }))
        .send()
        .await
        .expect("update request");
    assert_eq!(resp.status(), 400);
}

// ============================================================
// ПОДПИСКИ
// ============================================================

#[tokio::test]
async fn following_updates_counts_on_both_sides() {
    let app = spawn_app().await;
    let star = register_user(&app, "starman1", "correct horse battery staple").await;
    let fan = register_user(&app, "fanuser1", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/profile/starman1/follow"))
        .header("Authorization", fan.auth_header())
        .send()
        .await
        .expect("follow request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("follow json");
    assert_eq!(body["followers"], 1);
    assert_eq!(body["isFollowing"], true);

    // Владелец видит подписчика у себя, и видит, что тот на него подписан.
    let own = get_profile(&app, &star, "starman1").await;
    assert_eq!(own["followers"], 1);
    let seen_by_star = get_profile(&app, &star, "fanuser1").await;
    assert_eq!(seen_by_star["followsYou"], true);

    let resp = app
        .http
        .delete(app.url("/api/profile/starman1/follow"))
        .header("Authorization", fan.auth_header())
        .send()
        .await
        .expect("unfollow request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("unfollow json");
    assert_eq!(body["followers"], 0);
    assert_eq!(body["isFollowing"], false);
}

#[tokio::test]
async fn following_yourself_is_rejected() {
    let app = spawn_app().await;
    let user = register_user(&app, "loneuser", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/profile/loneuser/follow"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .expect("follow request");
    assert_eq!(resp.status(), 400);
}

// ============================================================
// ДРУЖБА
// ============================================================

#[tokio::test]
async fn friend_request_lifecycle_accept() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alicefr", "correct horse battery staple").await;
    let bob = register_user(&app, "bobfr001", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "to": "bobfr001", "message": "давай дружить" }))
        .send()
        .await
        .expect("friend request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("request json");
    assert_eq!(body["status"], "pending");
    let request_id = body["id"].as_str().expect("id").to_string();

    // Повтор не плодит вторую заявку.
    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "to": "bobfr001" }))
        .send()
        .await
        .expect("duplicate friend request");
    assert_eq!(resp.status(), 409);

    let resp = app
        .http
        .get(app.url("/api/friends/requests"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .expect("list requests");
    let body: serde_json::Value = resp.json().await.expect("list json");
    assert_eq!(body["incoming"].as_array().expect("incoming").len(), 1);
    assert_eq!(body["incoming"][0]["requester"], "alicefr");
    assert_eq!(body["incoming"][0]["message"], "давай дружить");

    // Заявку принимает только адресат: отправитель не может «принять» сам себя
    // в друзья к кому угодно.
    let resp = app
        .http
        .post(app.url(&format!("/api/friends/requests/{}", request_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "action": "accept" }))
        .send()
        .await
        .expect("self accept");
    assert_eq!(resp.status(), 403);

    let resp = app
        .http
        .post(app.url(&format!("/api/friends/requests/{}", request_id)))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "action": "accept" }))
        .send()
        .await
        .expect("accept");
    assert_eq!(resp.status(), 200);

    // Дружба симметрична вне зависимости от того, кто её читает.
    let seen_by_alice = get_profile(&app, &alice, "bobfr001").await;
    assert_eq!(seen_by_alice["isFriend"], true);
    assert_eq!(seen_by_alice["friends"], 1);
    let seen_by_bob = get_profile(&app, &bob, "alicefr").await;
    assert_eq!(seen_by_bob["isFriend"], true);

    let resp = app
        .http
        .get(app.url("/api/friends"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .expect("friends list");
    let body: serde_json::Value = resp.json().await.expect("friends json");
    assert_eq!(body["friends"][0], "alicefr");
}

#[tokio::test]
async fn mutual_requests_become_a_friendship_without_a_second_click() {
    let app = spawn_app().await;
    let a = register_user(&app, "mutualaa", "correct horse battery staple").await;
    let b = register_user(&app, "mutualbb", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", a.auth_header())
        .json(&serde_json::json!({ "to": "mutualbb" }))
        .send()
        .await
        .expect("first request");
    assert_eq!(resp.status(), 200);

    // Встречная заявка — это согласие, выраженное дважды.
    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", b.auth_header())
        .json(&serde_json::json!({ "to": "mutualaa" }))
        .send()
        .await
        .expect("counter request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("counter json");
    assert_eq!(body["status"], "accepted");

    let profile = get_profile(&app, &a, "mutualbb").await;
    assert_eq!(profile["isFriend"], true);
}

#[tokio::test]
async fn declined_request_can_be_sent_again() {
    let app = spawn_app().await;
    let a = register_user(&app, "persist1", "correct horse battery staple").await;
    let b = register_user(&app, "refuser1", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", a.auth_header())
        .json(&serde_json::json!({ "to": "refuser1" }))
        .send()
        .await
        .expect("first request");
    let body: serde_json::Value = resp.json().await.expect("json");
    let id = body["id"].as_str().expect("id").to_string();

    let resp = app
        .http
        .post(app.url(&format!("/api/friends/requests/{}", id)))
        .header("Authorization", b.auth_header())
        .json(&serde_json::json!({ "action": "decline" }))
        .send()
        .await
        .expect("decline");
    assert_eq!(resp.status(), 200);

    // Отказ — это отказ на сейчас, а не вечный бан: частичный UNIQUE-индекс
    // покрывает только заявки в статусе pending.
    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", a.auth_header())
        .json(&serde_json::json!({ "to": "refuser1" }))
        .send()
        .await
        .expect("second request");
    assert_eq!(resp.status(), 200);
}

// ============================================================
// КОММЕНТАРИИ
// ============================================================

#[tokio::test]
async fn comment_policy_is_enforced_on_the_server_not_just_in_the_ui() {
    let app = spawn_app().await;
    let owner = register_user(&app, "walloner", "correct horse battery staple").await;
    let stranger = register_user(&app, "stranger", "correct horse battery staple").await;

    app.http
        .put(app.url("/api/profile"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "commentPolicy": "friends" }))
        .send()
        .await
        .expect("policy update");

    let resp = app
        .http
        .post(app.url("/api/profile/walloner/comments"))
        .header("Authorization", stranger.auth_header())
        .json(&serde_json::json!({ "body": "привет" }))
        .send()
        .await
        .expect("comment request");
    assert_eq!(resp.status(), 403);

    let profile = get_profile(&app, &stranger, "walloner").await;
    assert_eq!(profile["canComment"], false);

    make_friends(&app, &stranger, &owner).await;

    let resp = app
        .http
        .post(app.url("/api/profile/walloner/comments"))
        .header("Authorization", stranger.auth_header())
        .json(&serde_json::json!({ "body": "теперь можно" }))
        .send()
        .await
        .expect("comment request after friendship");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("comments json");
    assert_eq!(body["comments"][0]["body"], "теперь можно");
    assert_eq!(body["comments"][0]["author"], "stranger");
}

#[tokio::test]
async fn followers_policy_lets_followers_comment() {
    let app = spawn_app().await;
    let owner = register_user(&app, "folowner", "correct horse battery staple").await;
    let fan = register_user(&app, "folfan01", "correct horse battery staple").await;

    app.http
        .put(app.url("/api/profile"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "commentPolicy": "followers" }))
        .send()
        .await
        .expect("policy update");

    let resp = app
        .http
        .post(app.url("/api/profile/folowner/comments"))
        .header("Authorization", fan.auth_header())
        .json(&serde_json::json!({ "body": "рано" }))
        .send()
        .await
        .expect("comment before follow");
    assert_eq!(resp.status(), 403);

    app.http
        .post(app.url("/api/profile/folowner/follow"))
        .header("Authorization", fan.auth_header())
        .send()
        .await
        .expect("follow");

    let resp = app
        .http
        .post(app.url("/api/profile/folowner/comments"))
        .header("Authorization", fan.auth_header())
        .json(&serde_json::json!({ "body": "теперь я подписчик" }))
        .send()
        .await
        .expect("comment after follow");
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn wall_owner_can_delete_any_comment_author_only_their_own() {
    let app = spawn_app().await;
    let owner = register_user(&app, "delowner", "correct horse battery staple").await;
    let guest = register_user(&app, "delguest", "correct horse battery staple").await;
    let other = register_user(&app, "delother", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/profile/delowner/comments"))
        .header("Authorization", guest.auth_header())
        .json(&serde_json::json!({ "body": "гостевой" }))
        .send()
        .await
        .expect("comment");
    let body: serde_json::Value = resp.json().await.expect("json");
    let comment_id = body["comments"][0]["id"].as_str().expect("id").to_string();

    // Посторонний не может удалить чужой комментарий на чужой стене.
    let resp = app
        .http
        .delete(app.url(&format!("/api/profile/comments/{}", comment_id)))
        .header("Authorization", other.auth_header())
        .send()
        .await
        .expect("delete by outsider");
    assert_eq!(resp.status(), 404);

    let resp = app
        .http
        .delete(app.url(&format!("/api/profile/comments/{}", comment_id)))
        .header("Authorization", owner.auth_header())
        .send()
        .await
        .expect("delete by wall owner");
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn empty_comment_is_rejected() {
    let app = spawn_app().await;
    let user = register_user(&app, "emptycom", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/profile/emptycom/comments"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "body": "   " }))
        .send()
        .await
        .expect("comment request");
    assert_eq!(resp.status(), 400);
}

// ============================================================
// АВТОГРАФЫ
// ============================================================

#[tokio::test]
async fn autograph_waits_for_manual_approval_by_default() {
    let app = spawn_app().await;
    let owner = register_user(&app, "autoown1", "correct horse battery staple").await;
    let guest = register_user(&app, "autogst1", "correct horse battery staple").await;

    let (status, body) = post_autograph(&app, &guest, "autoown1").await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], "pending");
    let autograph_id = body["id"].as_str().expect("id").to_string();

    // Публично стена пуста, пока владелец не одобрил.
    assert!(list_autographs(&app, &guest, "autoown1", "approved")
        .await
        .is_empty());
    // И очередь модерации чужому не видна, даже если он её автор.
    assert!(list_autographs(&app, &guest, "autoown1", "pending")
        .await
        .is_empty());

    let pending = list_autographs(&app, &owner, "autoown1", "pending").await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["author"], "autogst1");
    // Штрихи возвращаются вектором — путь в синтаксисе SVG, а не картинка.
    assert_eq!(pending[0]["strokes"][0]["d"], "M 10 10 L 40 60 Q 55 20 90 40");
    assert_eq!(pending[0]["viewBox"], "0 0 100 100");

    let own = get_profile(&app, &owner, "autoown1").await;
    assert_eq!(own["pendingAutographs"], 1);

    let resp = app
        .http
        .post(app.url(&format!("/api/profile/autographs/{}", autograph_id)))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "action": "approve" }))
        .send()
        .await
        .expect("approve");
    assert_eq!(resp.status(), 200);

    let approved = list_autographs(&app, &guest, "autoown1", "approved").await;
    assert_eq!(approved.len(), 1);
    assert_eq!(approved[0]["id"], autograph_id);
}

#[tokio::test]
async fn auto_approve_for_everyone_publishes_immediately() {
    let app = spawn_app().await;
    let owner = register_user(&app, "openwall", "correct horse battery staple").await;
    let guest = register_user(&app, "openguest", "correct horse battery staple").await;

    app.http
        .put(app.url("/api/profile"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "autographAutoApprove": "anyone" }))
        .send()
        .await
        .expect("policy update");

    let (status, body) = post_autograph(&app, &guest, "openwall").await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], "approved");
    assert_eq!(list_autographs(&app, &guest, "openwall", "approved").await.len(), 1);
}

#[tokio::test]
async fn auto_approve_can_be_limited_to_friends_while_anyone_may_draw() {
    let app = spawn_app().await;
    let owner = register_user(&app, "pickywal", "correct horse battery staple").await;
    let friend = register_user(&app, "pickyfrn", "correct horse battery staple").await;
    let stranger = register_user(&app, "pickystr", "correct horse battery staple").await;

    app.http
        .put(app.url("/api/profile"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({
            "autographPolicy": "anyone",
            "autographAutoApprove": "friends",
        }))
        .send()
        .await
        .expect("policy update");

    make_friends(&app, &friend, &owner).await;

    // «Кто может рисовать» и «чьё публикуется сразу» — две разные настройки.
    let (status, body) = post_autograph(&app, &friend, "pickywal").await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], "approved");

    let (status, body) = post_autograph(&app, &stranger, "pickywal").await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], "pending");

    assert_eq!(
        list_autographs(&app, &stranger, "pickywal", "approved").await.len(),
        1
    );
}

#[tokio::test]
async fn autograph_policy_blocks_drawing_entirely() {
    let app = spawn_app().await;
    let owner = register_user(&app, "closedwl", "correct horse battery staple").await;
    let stranger = register_user(&app, "closedst", "correct horse battery staple").await;

    app.http
        .put(app.url("/api/profile"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "autographPolicy": "contacts" }))
        .send()
        .await
        .expect("policy update");

    let (status, _) = post_autograph(&app, &stranger, "closedwl").await;
    assert_eq!(status, 403);

    let profile = get_profile(&app, &stranger, "closedwl").await;
    assert_eq!(profile["canAutograph"], false);

    // «Контакты» — это те, кого владелец добавил себе САМ.
    app.http
        .post(app.url("/api/contacts"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "username": "closedst" }))
        .send()
        .await
        .expect("add contact");

    let (status, _) = post_autograph(&app, &stranger, "closedwl").await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn autograph_path_data_outside_the_svg_alphabet_is_rejected() {
    let app = spawn_app().await;
    let owner = register_user(&app, "safewall", "correct horse battery staple").await;

    // Клиент подставляет `d` прямо в атрибут <path d="…">. Строка с кавычкой
    // не должна доезжать до базы, откуда её увидит каждый зритель стены.
    let resp = app
        .http
        .post(app.url("/api/profile/safewall/autographs"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({
            "strokes": [{ "d": "M 0 0 L 1 1\"><script>alert(1)</script>", "color": "#fff", "width": 2 }],
            "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2,
        }))
        .send()
        .await
        .expect("autograph request");
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn autograph_placement_is_clamped_to_the_wall() {
    let app = spawn_app().await;
    let owner = register_user(&app, "clampwal", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/profile/clampwal/autographs"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({
            "strokes": sample_strokes(),
            "x": 42.0,
            "y": -13.0,
            "width": 0.0,
            "height": 900.0,
        }))
        .send()
        .await
        .expect("autograph request");
    assert_eq!(resp.status(), 200);

    // Свой автограф одобряется владельцем сразу — он и есть владелец стены.
    let all = list_autographs(&app, &owner, "clampwal", "all").await;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["x"], 1.0);
    assert_eq!(all[0]["y"], 0.0);
    assert_eq!(all[0]["width"], 0.02);
    assert_eq!(all[0]["height"], 1.0);
}

#[tokio::test]
async fn empty_autograph_is_rejected() {
    let app = spawn_app().await;
    let owner = register_user(&app, "emptyaut", "correct horse battery staple").await;

    let resp = app
        .http
        .post(app.url("/api/profile/emptyaut/autographs"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({
            "strokes": [],
            "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2,
        }))
        .send()
        .await
        .expect("autograph request");
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn only_the_wall_owner_can_approve() {
    let app = spawn_app().await;
    let owner = register_user(&app, "modowner", "correct horse battery staple").await;
    let guest = register_user(&app, "modguest", "correct horse battery staple").await;

    let (_, body) = post_autograph(&app, &guest, "modowner").await;
    let id = body["id"].as_str().expect("id").to_string();

    let resp = app
        .http
        .post(app.url(&format!("/api/profile/autographs/{}", id)))
        .header("Authorization", guest.auth_header())
        .json(&serde_json::json!({ "action": "approve" }))
        .send()
        .await
        .expect("self approve");
    assert_eq!(resp.status(), 403);

    // Но забрать собственный рисунок со стены автор может.
    let resp = app
        .http
        .post(app.url(&format!("/api/profile/autographs/{}", id)))
        .header("Authorization", guest.auth_header())
        .json(&serde_json::json!({ "action": "delete" }))
        .send()
        .await
        .expect("author delete");
    assert_eq!(resp.status(), 200);
    assert!(list_autographs(&app, &owner, "modowner", "all").await.is_empty());
}

#[tokio::test]
async fn profile_endpoints_require_authentication() {
    let app = spawn_app().await;
    register_user(&app, "authwall", "correct horse battery staple").await;

    let resp = app
        .http
        .get(app.url("/api/profile/authwall"))
        .send()
        .await
        .expect("anonymous profile request");
    assert_eq!(resp.status(), 401);

    let resp = app
        .http
        .post(app.url("/api/profile/authwall/comments"))
        .json(&serde_json::json!({ "body": "аноним" }))
        .send()
        .await
        .expect("anonymous comment request");
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn link_color_is_sanitised_like_accent_color_and_persists() {
    let app = spawn_app().await;
    let user = register_user(&app, "linkcolor01", "correct horse battery staple").await;

    let resp = app
        .http
        .put(app.url("/api/profile"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({
            "links": [
                { "label": "valid", "url": "https://example.org/a", "color": "#FF6B6B" },
                // Same class of injection sanitize_color already rejects for
                // accentColor — a link colour is an inline `style="color:...` on
                // the client, so it must be rejected here too, not just escaped.
                { "label": "bad color", "url": "https://example.org/b", "color": "red; background:url(javascript:alert(1))" },
                // No colour at all — must round-trip as "", not fail.
                { "label": "no color", "url": "https://example.org/c" },
            ],
        }))
        .send()
        .await
        .expect("update request");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.expect("update json");
    let links = body["links"].as_array().expect("links array");
    assert_eq!(links.len(), 3);
    // Lowercased, like accentColor.
    assert_eq!(links[0]["color"], "#ff6b6b");
    assert_eq!(links[1]["color"], "", "an invalid colour must be dropped, not stored verbatim");
    assert_eq!(links[2]["color"], "");

    // Re-fetching (a fresh GET, not just the PUT response) must return the same
    // thing — this is the round trip through parse_links reading the stored
    // JSON back out, not just the in-memory value from the write path.
    let profile = get_profile(&app, &user, "linkcolor01").await;
    let links = profile["links"].as_array().expect("links array");
    assert_eq!(links[0]["color"], "#ff6b6b");
    assert_eq!(links[1]["color"], "");
}

#[tokio::test]
async fn a_link_row_saved_before_color_existed_still_loads() {
    // Simulates a profile whose `links` JSON was written by a server build
    // before the `color` field existed — parse_links must treat a missing key
    // as "no colour", not fail the whole row (and thus silently drop a link
    // someone had saved). Needs a real data dir to seed the row directly
    // against, rather than the HTTP API (which always writes the current
    // shape) — same pattern as tests/conversation_keys.rs's spawn_with_pool.
    let data_dir = std::env::temp_dir().join(format!(
        "zali-legacy-link-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let app = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let user = register_user(&app, "legacylink01", "correct horse battery staple").await;

    let pool = sqlx::SqlitePool::connect(&format!(
        "sqlite:{}",
        data_dir.join("zali_messenger.db").to_string_lossy()
    ))
    .await
    .expect("open test db");
    sqlx::query(
        "INSERT INTO user_profiles (username, links, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(username) DO UPDATE SET links = excluded.links",
    )
    .bind("legacylink01")
    .bind(r#"[{"label":"old","url":"https://example.org/legacy"}]"#)
    .execute(&pool)
    .await
    .expect("seed legacy link row");
    drop(pool);

    let profile = get_profile(&app, &user, "legacylink01").await;
    let links = profile["links"].as_array().expect("links array");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["url"], "https://example.org/legacy");
    assert_eq!(links[0]["color"], "");
}
