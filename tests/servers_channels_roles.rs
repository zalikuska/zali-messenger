//! Integration tests for servers (guilds), channels, membership/roles, and
//! contacts — run against a real in-process server (see tests/common/mod.rs).

mod common;

use common::{join_by_invite, register_user, spawn_app, RegisteredUser, TestApp};

async fn create_server(
    app: &TestApp,
    owner: &RegisteredUser,
    name: &str,
    is_public: bool,
) -> serde_json::Value {
    let resp = app
        .http
        .post(app.url("/api/servers"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "name": name, "is_public": is_public }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201, "create_server({}) failed", name);
    resp.json().await.unwrap()
}

#[tokio::test]
async fn create_server_seeds_default_channels_and_owner_membership() {
    let app = spawn_app().await;
    let owner = register_user(&app, "owner1", "hunter22").await;
    let server = create_server(&app, &owner, "My Guild", true).await;

    assert_eq!(server["owner"], "owner1");
    assert_eq!(server["myRole"], "owner");
    assert_eq!(server["memberCount"], 1);
    let channels = server["channels"].as_array().unwrap();
    let names: Vec<&str> = channels
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Общий чат"));
    assert!(names.contains(&"Объявления"));
}

#[tokio::test]
async fn get_servers_only_lists_own_and_joined() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    create_server(&app, &alice, "Alice's place", true).await;

    let bob_servers: serde_json::Value = app
        .http
        .get(app.url("/api/servers"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(bob_servers["servers"].as_array().unwrap().is_empty());

    let alice_servers: serde_json::Value = app
        .http
        .get(app.url("/api/servers"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alice_servers["servers"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn public_servers_are_discoverable_by_others_but_not_shown_to_owner() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    create_server(&app, &alice, "Public Place", true).await;

    let discovered: serde_json::Value = app
        .http
        .get(app.url("/api/discover/servers"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // A fresh DB no longer seeds any demo servers (see storage.rs — the six
    // "system"-owned ones this comment used to warn about are gone), so
    // Alice's is the only thing here.
    let discovered_servers = discovered["servers"].as_array().unwrap();
    assert_eq!(discovered_servers.len(), 1);
    assert!(discovered_servers
        .iter()
        .any(|s| s["name"] == "Public Place" && s["owner"] == "alice"));

    let owners_own_discovery: serde_json::Value = app
        .http
        .get(app.url("/api/discover/servers"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!owners_own_discovery["servers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["name"] == "Public Place"));
}

#[tokio::test]
async fn join_server_link_rejects_private_servers() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let server = create_server(&app, &alice, "Secret Place", false).await;
    let join_link = server["joinLink"].as_str().unwrap().to_string();

    let resp = app
        .http
        .post(app.url("/api/servers/join"))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "link": join_link }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
async fn join_server_link_succeeds_for_public_servers() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let server = create_server(&app, &alice, "Open Place", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();
    let join_link = server["joinLink"].as_str().unwrap().to_string();

    let resp = app
        .http
        .post(app.url("/api/servers/join"))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "link": join_link }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["serverId"], server_id);
    assert_eq!(body["joined"], true);
}

#[tokio::test]
async fn ensure_server_member_never_demotes_an_existing_admin() {
    // Regression guard for the documented invariant (CLAUDE.md): joining via
    // link uses ensure_server_member (ON CONFLICT DO NOTHING) — it must never
    // silently downgrade an existing admin back to plain "member".
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();
    let join_link = server["joinLink"].as_str().unwrap().to_string();

    join_by_invite(&app, &alice, &server_id, "bob", "hunter22").await;
    let promote = app
        .http
        .patch(app.url(&format!("/api/servers/{}/members/bob", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "bob", "role": "admin" }))
        .send()
        .await
        .unwrap();
    assert_eq!(promote.status(), 200);

    // Bob re-joins via the public join link — must stay admin, not reset to member.
    let rejoin = app
        .http
        .post(app.url("/api/servers/join"))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "link": join_link }))
        .send()
        .await
        .unwrap();
    assert_eq!(rejoin.status(), 200);

    let members: serde_json::Value = app
        .http
        .get(app.url(&format!("/api/servers/{}/members", server_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let bob_member = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["username"] == "bob")
        .unwrap();
    assert_eq!(bob_member["role"], "admin");
}

#[tokio::test]
async fn members_cannot_be_added_directly_and_owner_role_is_protected() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();

    // Прямого добавления участников нет вообще — даже у владельца:
    // попасть на сервер можно только по приглашению (или по ссылке публичного).
    let direct = app
        .http
        .post(app.url(&format!("/api/servers/{}/members", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "bob", "role": "member" }))
        .send()
        .await
        .unwrap();
    assert_eq!(direct.status(), 405);

    // The owner's own role can't be touched via update_server_member.
    let owner_untouchable = app
        .http
        .patch(app.url(&format!("/api/servers/{}/members/alice", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "alice", "role": "member" }))
        .send()
        .await
        .unwrap();
    assert_eq!(owner_untouchable.status(), 400);

    // ...and can't be removed.
    let owner_undeletable = app
        .http
        .delete(app.url(&format!("/api/servers/{}/members/alice", server_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(owner_undeletable.status(), 400);
}

#[tokio::test]
async fn only_owner_can_delete_server() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();

    join_by_invite(&app, &alice, &server_id, "bob", "hunter22").await;
    app.http
        .patch(app.url(&format!("/api/servers/{}/members/bob", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "bob", "role": "admin" }))
        .send()
        .await
        .unwrap();

    // Even an admin cannot delete the server — only the owner.
    let forbidden = app
        .http
        .delete(app.url(&format!("/api/servers/{}", server_id)))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);

    let allowed = app
        .http
        .delete(app.url(&format!("/api/servers/{}", server_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), 204);

    let alice_servers: serde_json::Value = app
        .http
        .get(app.url("/api/servers"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(alice_servers["servers"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn channel_create_requires_manager_and_rejects_duplicate_names() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();

    // Bob joins as a plain member — cannot create channels.
    let join_link = server["joinLink"].as_str().unwrap().to_string();
    app.http
        .post(app.url("/api/servers/join"))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "link": join_link }))
        .send()
        .await
        .unwrap();
    let forbidden = app
        .http
        .post(app.url(&format!("/api/servers/{}/channels", server_id)))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "name": "random" }))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);

    let created = app
        .http
        .post(app.url(&format!("/api/servers/{}/channels", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "name": "random" }))
        .send()
        .await
        .unwrap();
    assert!(created.status().is_success());

    let duplicate = app
        .http
        .post(app.url(&format!("/api/servers/{}/channels", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "name": "random" }))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), 400);
}

#[tokio::test]
async fn server_invite_respects_max_uses() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();

    let invite = app
        .http
        .post(app.url(&format!("/api/servers/{}/invites", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "max_uses": 1 }))
        .send()
        .await
        .unwrap();
    assert_eq!(invite.status(), 200);
    let invite_body: serde_json::Value = invite.json().await.unwrap();
    let code = invite_body["code"].as_str().unwrap().to_string();

    let first_join = app
        .http
        .post(app.url(&format!("/api/invites/{}/join", code)))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(first_join.status(), 200);

    let second_join = app
        .http
        .post(app.url(&format!("/api/invites/{}/join", code)))
        .header("Authorization", carol.auth_header())
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(second_join.status(), 410);
}

#[tokio::test]
async fn contacts_reject_self_and_unknown_users() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let self_add = app
        .http
        .post(app.url("/api/contacts"))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "alice" }))
        .send()
        .await
        .unwrap();
    assert_eq!(self_add.status(), 400);

    let unknown_add = app
        .http
        .post(app.url("/api/contacts"))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "no-such-user" }))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown_add.status(), 404);

    let good_add = app
        .http
        .post(app.url("/api/contacts"))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "bob" }))
        .send()
        .await
        .unwrap();
    assert_eq!(good_add.status(), 200);
    let body: serde_json::Value = good_add.json().await.unwrap();
    assert_eq!(body["contacts"], serde_json::json!(["bob"]));

    let removed = app
        .http
        .delete(app.url("/api/contacts/bob"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 200);
    let body: serde_json::Value = removed.json().await.unwrap();
    assert!(body["contacts"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_fresh_install_seeds_no_demo_servers() {
    // Regression test for the removal of seed_default_servers (storage.rs): a
    // fresh account on a fresh install used to find six "system"-owned demo
    // servers (Zali Hub, Dev Team, Friends, Music, Games, Study) already
    // sitting in both /api/servers and /api/discover/servers on first boot.
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    let own: serde_json::Value = app
        .http
        .get(app.url("/api/servers"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(own["servers"].as_array().unwrap().len(), 0);

    let discoverable: serde_json::Value = app
        .http
        .get(app.url("/api/discover/servers"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(discoverable["servers"].as_array().unwrap().len(), 0);
}

/// Не участник публичного сервера видит только то, что открыто роли `member`.
/// Раньше `is_public` пускал его в любой канал мимо прав канала — и участник с
/// урезанной ролью получал закрытые каналы назад, просто выйдя с сервера.
#[tokio::test]
async fn outsiders_of_a_public_server_do_not_see_channels_closed_to_members() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();
    let channels = server["channels"].as_array().unwrap();
    let hidden_id = channels[0]["id"].as_str().unwrap().to_string();
    let open_id = channels[1]["id"].as_str().unwrap().to_string();

    let resp = app
        .http
        .put(app.url(&format!("/api/servers/{server_id}/channels/{hidden_id}/permissions")))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "permissions": [
            { "role": "member", "can_view": false, "can_send": false, "can_manage": false }
        ]}))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "set permissions: {}", resp.status());

    let hidden = app
        .http
        .get(app.url(&format!("/api/servers/{server_id}/channels/{hidden_id}/messages")))
        .header("Authorization", mallory.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(hidden.status(), 403, "closed channel must stay closed to outsiders");

    let open = app
        .http
        .get(app.url(&format!("/api/servers/{server_id}/channels/{open_id}/messages")))
        .header("Authorization", mallory.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(open.status(), 200, "a channel open to members stays readable");

    let listed: serde_json::Value = app
        .http
        .get(app.url(&format!("/api/servers/{server_id}/channels")))
        .header("Authorization", mallory.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let text = listed.to_string();
    assert!(!text.contains(&hidden_id), "closed channel must not be listed: {text}");
    assert!(text.contains(&open_id));
}

#[tokio::test]
async fn joining_by_invite_never_demotes_an_existing_admin() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", false).await;
    let server_id = server["id"].as_str().unwrap().to_string();
    join_by_invite(&app, &alice, &server_id, "bob", "hunter22").await;
    let promote = app
        .http
        .patch(app.url(&format!("/api/servers/{server_id}/members/bob")))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "bob", "role": "admin" }))
        .send()
        .await
        .unwrap();
    assert_eq!(promote.status(), 200);
    let invite: serde_json::Value = app
        .http
        .post(app.url(&format!("/api/servers/{server_id}/invites")))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "max_uses": 5 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap().to_string();
    let join = app
        .http
        .post(app.url(&format!("/api/invites/{code}/join")))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(join.status(), 200);
    let members: serde_json::Value = app
        .http
        .get(app.url(&format!("/api/servers/{server_id}/members")))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let bob_member = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["username"] == "bob")
        .unwrap();
    assert_eq!(bob_member["role"], "admin");
}

/// Аватар/баннер сервера отдаётся с домена API, поэтому принимать можно только
/// растровые картинки — иначе это хранимый XSS (`text/html`, `application/javascript`).
#[tokio::test]
async fn server_assets_accept_only_real_images() {
    use base64::Engine;
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();

    let script = base64::engine::general_purpose::STANDARD.encode(b"fetch('/api/coins/transfer')");
    let bad = app
        .http
        .put(app.url(&format!("/api/servers/{server_id}/assets/banner")))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "data_url": format!("data:application/javascript;base64,{script}") }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);

    // PNG, но с ложным MIME в data URL — отдаётся как image/png.
    let png: Vec<u8> = [0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0].to_vec();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
    let ok = app
        .http
        .put(app.url(&format!("/api/servers/{server_id}/assets/avatar")))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "data_url": format!("data:text/html;base64,{encoded}") }))
        .send()
        .await
        .unwrap();
    assert!(ok.status().is_success(), "png upload: {}", ok.status());
    let served = app
        .http
        .get(app.url(&format!("/api/servers/{server_id}/assets/avatar")))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap();
    assert_eq!(served.headers()["content-type"], "image/png");
}

#[tokio::test]
async fn members_can_invite_by_default_until_the_owner_takes_it_away() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();
    let join_link = server["joinLink"].as_str().unwrap().to_string();

    app.http
        .post(app.url("/api/servers/join"))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "link": join_link }))
        .send()
        .await
        .unwrap();

    // «Приглашения» — базовое право: обычный участник уже видит его в списке серверов...
    let listed: serde_json::Value = app
        .http
        .get(app.url("/api/servers"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mine = listed["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == server_id.as_str())
        .unwrap();
    assert_eq!(mine["myRole"], "member");
    assert_eq!(mine["canInvite"], true);

    // ...и может создать приглашение, которым войдёт третий.
    let invite = app
        .http
        .post(app.url(&format!("/api/servers/{server_id}/invites")))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "expires_hours": 168 }))
        .send()
        .await
        .unwrap();
    assert_eq!(invite.status(), 200);

    // Владелец забирает право у роли — сервер перестаёт выдавать приглашения.
    let patched = app
        .http
        .patch(app.url(&format!("/api/servers/{server_id}/roles/member")))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "name": "Участник", "can_invite": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched.status(), 200);
    let denied = app
        .http
        .post(app.url(&format!("/api/servers/{server_id}/invites")))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);

    // Посторонний (не участник) не приглашает никогда.
    let outsider = app
        .http
        .post(app.url(&format!("/api/servers/{server_id}/invites")))
        .header("Authorization", carol.auth_header())
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(outsider.status(), 403);
}

#[tokio::test]
async fn server_links_use_the_public_web_url_and_accept_every_form() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let carol = register_user(&app, "carol", "hunter22").await;
    let dave = register_user(&app, "dave", "hunter22").await;
    let server = create_server(&app, &alice, "Open", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();
    let base = "https://msg.zalikus.org";

    // Ссылка сервера — адрес веб-клиента, а не zali://.
    assert_eq!(server["joinLink"], format!("{base}/server/{server_id}"));

    // Ссылка приглашения — тот же формат с кодом вместо id.
    let invite: serde_json::Value = app
        .http
        .post(app.url(&format!("/api/servers/{server_id}/invites")))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    assert_eq!(invite["url"], format!("{base}/server/{code}"));

    // Вход принимает любую форму: https-ссылку, старый zali:// и голый id.
    for (user, link) in [
        (&bob, format!("{base}/server/{server_id}")),
        (&carol, format!("zali://server/{server_id}")),
        (&dave, server_id.clone()),
    ] {
        let resp = app
            .http
            .post(app.url("/api/servers/join"))
            .header("Authorization", user.auth_header())
            .json(&serde_json::json!({ "link": link }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "join by {link}");
    }

    // Приватный сервер по ссылке не открывается — только по приглашению.
    let private = create_server(&app, &alice, "Closed", false).await;
    let private_id = private["id"].as_str().unwrap();
    let eve = register_user(&app, "eve", "hunter22").await;
    let denied = app
        .http
        .post(app.url("/api/servers/join"))
        .header("Authorization", eve.auth_header())
        .json(&serde_json::json!({ "link": format!("{base}/server/{private_id}") }))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
}

async fn befriend(app: &TestApp, a: &RegisteredUser, b: &RegisteredUser) {
    let resp = app
        .http
        .post(app.url("/api/friends/requests"))
        .header("Authorization", a.auth_header())
        .json(&serde_json::json!({ "to": b.username }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let id = body["id"].as_str().unwrap().to_string();
    let accepted = app
        .http
        .post(app.url(&format!("/api/friends/requests/{id}")))
        .header("Authorization", b.auth_header())
        .json(&serde_json::json!({ "action": "accept" }))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 200);
}

#[tokio::test]
async fn username_suggestions_rank_used_then_friends_then_mutual_friends() {
    let app = spawn_app().await;
    let me = register_user(&app, "zalikus", "hunter22").await;
    let paid = register_user(&app, "anna_paid", "hunter22").await;
    let friend = register_user(&app, "anna_friend", "hunter22").await;
    let mutual = register_user(&app, "anna_mutual", "hunter22").await;
    register_user(&app, "anna_stranger", "hunter22").await;
    register_user(&app, "zzz_nobody", "hunter22").await;

    // Друг, а у друга есть ещё один друг — он «общий».
    befriend(&app, &me, &friend).await;
    befriend(&app, &friend, &mutual).await;
    // Тот, кому я переводил, — самый «используемый».
    for i in 0..3 {
        let resp = app
            .http
            .post(app.url("/api/coins/transfer"))
            .header("Authorization", me.auth_header())
            .json(&serde_json::json!({ "to": paid.username, "amount": 1, "idempotencyKey": format!("k{i}") }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "transfer {i}");
    }

    // Пустой запрос: только те, с кем есть связь, по убыванию.
    let empty: serde_json::Value = app
        .http
        .get(app.url("/api/users/suggest"))
        .header("Authorization", me.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = empty["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["username"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["anna_paid", "anna_friend", "anna_mutual"]);
    assert_eq!(empty["users"][0]["reason"], "часто переводите");
    assert_eq!(empty["users"][1]["reason"], "друг");
    assert_eq!(empty["users"][2]["reason"], "общих друзей: 1");

    // Запрос по подстроке: связь поднимает выше, посторонний — в конце, себя нет.
    let typed: serde_json::Value = app
        .http
        .get(app.url("/api/users/suggest?q=anna"))
        .header("Authorization", me.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let typed_names: Vec<&str> = typed["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["username"].as_str().unwrap())
        .collect();
    assert_eq!(
        typed_names,
        vec!["anna_paid", "anna_friend", "anna_mutual", "anna_stranger"]
    );
    assert!(!typed_names.contains(&"zalikus"));
}
