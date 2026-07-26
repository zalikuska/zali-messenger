//! Integration tests for the conversation-key registry
//! (`server/src/conversation_keys.rs`), run against a real in-process server.
//!
//! These pin down the property the whole key-desync fix rests on: a scope's
//! canonical key is decided exactly once, and a client that lost the race is
//! told so instead of being allowed to fork the conversation.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};

async fn claim(
    app: &TestApp,
    user: &RegisteredUser,
    scope: &str,
    key_id: &str,
) -> (reqwest::StatusCode, serde_json::Value) {
    let resp = app
        .http
        .post(app.url("/api/conversation-keys/claim"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "scope": scope, "keyId": key_id }))
        .send()
        .await
        .expect("claim request");
    let status = resp.status();
    let body = resp.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

async fn claim_forced(
    app: &TestApp,
    user: &RegisteredUser,
    scope: &str,
    key_id: &str,
) -> serde_json::Value {
    let resp = app
        .http
        .post(app.url("/api/conversation-keys/claim"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "scope": scope, "keyId": key_id, "force": true }))
        .send()
        .await
        .expect("forced claim request");
    assert!(resp.status().is_success());
    resp.json().await.expect("forced claim json")
}

#[tokio::test]
async fn first_claim_wins_and_later_claims_are_told_the_winner() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let scope = "dm:alice:bob";

    let (status, first) = claim(&app, &alice, scope, "key-id-alice").await;
    assert!(status.is_success());
    assert_eq!(first["keyId"], "key-id-alice");
    assert_eq!(first["mine"], true);
    assert_eq!(first["claimedBy"], "alice");

    // Bob independently invented his own key for the same conversation — the
    // exact situation that used to leave two live keys behind. He must be told
    // that alice's key already won, and that his is not canonical.
    let (status, second) = claim(&app, &bob, scope, "key-id-bob").await;
    assert!(status.is_success());
    assert_eq!(second["keyId"], "key-id-alice");
    assert_eq!(second["mine"], false);
    assert_eq!(second["claimedBy"], "alice");
}

#[tokio::test]
async fn reclaiming_the_same_key_id_stays_mine() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let scope = "dm:alice:bob";

    claim(&app, &alice, scope, "key-id-alice").await;
    // Re-resolving a conversation claims again on every open; that must remain
    // idempotent rather than looking like a lost race.
    let (_, again) = claim(&app, &alice, scope, "key-id-alice").await;
    assert_eq!(again["mine"], true);
    assert_eq!(again["keyId"], "key-id-alice");
}

#[tokio::test]
async fn forced_claim_replaces_the_registry_for_an_explicit_key_reset() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let scope = "dm:alice:bob";

    claim(&app, &alice, scope, "old-key-id").await;
    let forced = claim_forced(&app, &alice, scope, "new-key-id").await;
    assert_eq!(forced["keyId"], "new-key-id");
    assert_eq!(forced["mine"], true);
}

#[tokio::test]
async fn outsiders_cannot_read_or_claim_a_dm_scope() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;
    let scope = "dm:alice:bob";

    claim(&app, &alice, scope, "key-id-alice").await;

    let (status, _) = claim(&app, &mallory, scope, "key-id-mallory").await;
    assert_eq!(status, 403);

    // A lookup must not leak the scope's key id to a non-participant either.
    let resp = app
        .http
        .get(app.url(&format!("/api/conversation-keys?scopes={}", scope)))
        .header("Authorization", mallory.auth_header())
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let rows: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(rows.as_array().expect("array").len(), 0);
}

#[tokio::test]
async fn lookup_returns_canonical_key_ids_for_participant_scopes() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    claim(&app, &alice, "dm:alice:bob", "key-id-alice-bob").await;
    claim(&app, &alice, "dm:alice:carol", "key-id-alice-carol").await;

    // Bob participates in dm:alice:bob only — the carol scope must be omitted
    // rather than rejecting the whole batch.
    let resp = app
        .http
        .get(app.url("/api/conversation-keys?scopes=dm:alice:bob,dm:alice:carol"))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let rows: serde_json::Value = resp.json().await.unwrap();
    let rows = rows.as_array().expect("array");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["scope"], "dm:alice:bob");
    assert_eq!(rows[0]["keyId"], "key-id-alice-bob");
}

#[tokio::test]
async fn malformed_scopes_are_rejected() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    for scope in ["", "nonsense", "dm:alice", "chat:alice:bob"] {
        let (status, _) = claim(&app, &alice, scope, "key-id-alice").await;
        assert!(
            status.is_client_error(),
            "scope {:?} must not be claimable, got {}",
            scope,
            status
        );
    }
}

/// Channel scopes are the case the old client-side convergence rule did not
/// cover at all: `keyEnvelopeOverridesLocal` only understood `dm:` scopes, so
/// every member who opened a channel before someone else's envelope arrived kept
/// their own key forever. The registry is scope-agnostic — membership decides
/// access, and the first claim still wins.
#[tokio::test]
async fn channel_scope_is_gated_on_membership_and_still_first_write_wins() {
    let app = spawn_app().await;
    let owner = register_user(&app, "owner1", "hunter22").await;
    let member = register_user(&app, "member1", "hunter22").await;
    let outsider = register_user(&app, "outsider1", "hunter22").await;

    let server: serde_json::Value = app
        .http
        .post(app.url("/api/servers"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "name": "Guild", "is_public": true }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().expect("server id").to_string();
    let join_link = server["joinLink"].as_str().expect("join link").to_string();

    let joined = app
        .http
        .post(app.url("/api/servers/join"))
        .header("Authorization", member.auth_header())
        .json(&serde_json::json!({ "link": join_link }))
        .send()
        .await
        .unwrap();
    assert!(joined.status().is_success(), "member must be able to join");

    let scope = format!("server:{}:{}-general", server_id, server_id);

    let (status, first) = claim(&app, &owner, &scope, "channel-key-owner").await;
    assert!(status.is_success());
    assert_eq!(first["mine"], true);

    // The other member independently invented a channel key — it must lose.
    let (status, second) = claim(&app, &member, &scope, "channel-key-member").await;
    assert!(status.is_success());
    assert_eq!(second["keyId"], "channel-key-owner");
    assert_eq!(second["mine"], false);

    // A non-member gets nothing.
    let (status, _) = claim(&app, &outsider, &scope, "channel-key-outsider").await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn republish_request_is_scoped_to_participants() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;

    let ok = app
        .http
        .post(app.url("/api/conversation-keys/republish"))
        .header("Authorization", alice.auth_header())
        .json(&serde_json::json!({ "scope": "dm:alice:bob" }))
        .send()
        .await
        .unwrap();
    assert!(ok.status().is_success());

    let denied = app
        .http
        .post(app.url("/api/conversation-keys/republish"))
        .header("Authorization", mallory.auth_header())
        .json(&serde_json::json!({ "scope": "dm:alice:bob" }))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
}
