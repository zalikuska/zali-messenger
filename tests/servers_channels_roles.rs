//! Integration tests for servers (guilds), channels, membership/roles, and
//! contacts — run against a real in-process server (see tests/common/mod.rs).

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};

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
    // The fresh DB is seeded with 6 public "system"-owned servers alongside
    // Alice's — assert hers is discoverable rather than pinning exact count.
    assert!(discovered["servers"]
        .as_array()
        .unwrap()
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

    let add = app
        .http
        .post(app.url(&format!("/api/servers/{}/members", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "bob", "role": "admin" }))
        .send()
        .await
        .unwrap();
    assert_eq!(add.status(), 200);

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
async fn only_managers_can_add_members_and_owner_role_is_protected() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    register_user(&app, "carol", "hunter22").await;
    let server = create_server(&app, &alice, "Guild", true).await;
    let server_id = server["id"].as_str().unwrap().to_string();

    // Bob is not a member/manager yet — cannot add carol.
    let forbidden = app
        .http
        .post(app.url(&format!("/api/servers/{}/members", server_id)))
        .header("Authorization", bob.auth_header())
        .json(&serde_json::json!({ "username": "carol" }))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);

    // Owner can add carol as a plain member.
    let added = app
        .http
        .post(app.url(&format!("/api/servers/{}/members", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "carol" }))
        .send()
        .await
        .unwrap();
    assert_eq!(added.status(), 200);

    // Nobody can assign the "owner" role through this endpoint.
    let owner_role_rejected = app
        .http
        .post(app.url(&format!("/api/servers/{}/members", server_id)))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "username": "bob", "role": "owner" }))
        .send()
        .await
        .unwrap();
    assert_eq!(owner_role_rejected.status(), 400);

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

    app.http
        .post(app.url(&format!("/api/servers/{}/members", server_id)))
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
