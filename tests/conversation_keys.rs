//! Integration tests for the conversation-key registry
//! (`server/src/conversation_keys.rs`), run against a real in-process server.
//!
//! These pin down the property the whole key-desync fix rests on: a scope's
//! canonical key is decided exactly once, and a client that lost the race is
//! told so instead of being allowed to fork the conversation.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};
use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

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

// ---------------------------------------------------------------------------
// Scope casing
//
// DM scopes are built client-side out of usernames, and used to carry whatever
// casing the caller happened to hold, while every comparison here is byte-exact.
// Production ended up with both `dm:pivovarca:zalikus` and `dm:Pivovarca:zalikus`
// in the registry although only `Pivovarca` exists as an account: two claims, two
// envelope buckets, and no way for either side to converge on the other.
// ---------------------------------------------------------------------------

/// The two participants derive the scope from their own contact entries, so the
/// casing they use routinely differs. Both spellings must reach one registry row.
#[tokio::test]
async fn differently_cased_scopes_share_one_registry_row() {
    let app = spawn_app().await;
    let alice = register_user(&app, "Alice", "hunter22").await;
    let bob = register_user(&app, "Bob", "hunter22").await;

    let (status, first) = claim(&app, &alice, "dm:Alice:Bob", "key-id-alice").await;
    assert!(status.is_success());
    assert_eq!(first["mine"], true);

    // Bob spells both names differently. Before the fold this claimed a second,
    // independent row and both sides kept encrypting with their own key.
    let (status, second) = claim(&app, &bob, "dm:alice:bob", "key-id-bob").await;
    assert!(status.is_success());
    assert_eq!(second["keyId"], "key-id-alice");
    assert_eq!(second["mine"], false);
    assert_eq!(second["claimedBy"], "Alice");
}

/// The participant check compares the caller's username against the scope. With a
/// mixed-case account and a lowercased scope that comparison used to fail, so the
/// server answered 403 for a conversation the caller is actually in — leaving that
/// side permanently unable to claim or look up its own key.
#[tokio::test]
async fn a_mixed_case_account_is_a_participant_of_its_own_lowercased_scope() {
    let app = spawn_app().await;
    let user = register_user(&app, "Pivovarca", "hunter22").await;
    register_user(&app, "zalikus", "hunter22").await;

    let (status, body) = claim(&app, &user, "dm:pivovarca:zalikus", "key-id-piv").await;
    assert!(
        status.is_success(),
        "own scope must not be forbidden, got {status}: {body:?}"
    );
    assert_eq!(body["mine"], true);
}

/// Whichever spelling is used to look a scope up, the answer is the same row, and
/// it is reported under the canonical name so every client caches one key.
#[tokio::test]
async fn lookup_normalises_scope_casing() {
    let app = spawn_app().await;
    let alice = register_user(&app, "Alice", "hunter22").await;
    register_user(&app, "Bob", "hunter22").await;

    claim(&app, &alice, "dm:Alice:Bob", "key-id-alice-bob").await;

    let resp = app
        .http
        .get(app.url("/api/conversation-keys?scopes=dm:ALICE:bob"))
        .header("Authorization", alice.auth_header())
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

/// Participant order must not depend on casing either: `Zulu` sorts before `test`
/// by byte but after it once lowercased, so a scope built by sorting the original
/// spelling would name its participants in a different order on each side.
#[tokio::test]
async fn participant_order_does_not_depend_on_casing() {
    let app = spawn_app().await;
    let zulu = register_user(&app, "Zulu", "hunter22").await;
    let test = register_user(&app, "test", "hunter22").await;

    let (status, first) = claim(&app, &zulu, "dm:Zulu:test", "key-id-zulu").await;
    assert!(status.is_success());
    assert_eq!(first["scope"], "dm:test:zulu");
    assert_eq!(first["mine"], true);

    let (status, second) = claim(&app, &test, "dm:test:Zulu", "key-id-test").await;
    assert!(status.is_success());
    assert_eq!(second["keyId"], "key-id-zulu");
    assert_eq!(second["mine"], false);
}

/// Lowercased scopes are only unambiguous while two accounts cannot differ by case
/// alone — otherwise they would share one scope, and therefore one conversation key.
#[tokio::test]
async fn registration_rejects_a_username_differing_only_by_case() {
    let app = spawn_app().await;
    register_user(&app, "Pivovarca", "hunter22").await;

    let resp = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({ "username": "pivovarca", "password": "hunter22" }))
        .send()
        .await
        .expect("register request");
    assert_eq!(resp.status(), 409);
}

// ---------------------------------------------------------------------------
// Startup migration of legacy scope casing
//
// `migrate_scope_casing` runs on every boot and is the only code in the server
// that DELETEs registry rows, on real production data, before anyone is served.
// Its first version picked the winner by "the already-canonical spelling wins"
// and would have discarded the live key of the one conversation that was
// actually broken — production held a mis-cased `dm:Pivovarca:zalikus` claimed
// 2026-07-26 (the key both accounts had converged on) alongside an
// already-lowercase `dm:pivovarca:zalikus` claimed a day later from a mistyped
// contact. That was caught by hand, against a copy of the prod DB; these tests
// pin it down so it cannot come back.
// ---------------------------------------------------------------------------

/// Boots a server (creating the real schema), returns its data dir and a pool.
async fn spawn_with_pool() -> (std::path::PathBuf, sqlx::SqlitePool) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let data_dir = std::env::temp_dir().join(format!(
        "zali-migration-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _app = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let pool = open_pool(&data_dir).await;
    (data_dir, pool)
}

async fn open_pool(data_dir: &std::path::Path) -> sqlx::SqlitePool {
    let db = data_dir.join("zali_messenger.db");
    sqlx::SqlitePool::connect(&format!("sqlite:{}", db.to_string_lossy()))
        .await
        .expect("open test db")
}

async fn insert_registry_row(pool: &sqlx::SqlitePool, scope: &str, key_id: &str, created_at: &str) {
    sqlx::query(
        "INSERT INTO conversation_key_registry
         (scope_key, key_id, claimed_by, claimed_device_id, created_at, updated_at)
         VALUES (?, ?, 'zalikus', 'dev_test', ?, ?)",
    )
    .bind(scope)
    .bind(key_id)
    .bind(created_at)
    .bind(created_at)
    .execute(pool)
    .await
    .expect("seed registry row");
}

async fn insert_envelope(pool: &sqlx::SqlitePool, id: &str, scope: &str, sender_device: &str) {
    sqlx::query(
        "INSERT INTO conversation_key_envelopes
         (envelope_id, owner, scope_key, sender, sender_device_id, recipient_device_id, encrypted_key)
         VALUES (?, 'zalikus', ?, 'Pivovarca', ?, 'dev_recipient', 'sealed')",
    )
    .bind(id)
    .bind(scope)
    .bind(sender_device)
    .execute(pool)
    .await
    .expect("seed envelope row");
}

async fn registry_rows(pool: &sqlx::SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT scope_key, key_id FROM conversation_key_registry ORDER BY scope_key",
    )
    .fetch_all(pool)
    .await
    .expect("read registry")
}

/// The exact production shape: the *older* claim wins even though it is the
/// mis-cased one. Picking the already-canonical spelling instead would throw
/// away the key both peers were really using.
#[tokio::test]
async fn scope_casing_migration_keeps_the_oldest_claim_not_the_prettiest() {
    let (data_dir, pool) = spawn_with_pool().await;

    insert_registry_row(&pool, "dm:Pivovarca:zalikus", "live-key", "2026-07-26 19:08:40").await;
    insert_registry_row(&pool, "dm:pivovarca:zalikus", "later-key", "2026-07-27 18:17:50").await;
    insert_registry_row(&pool, "dm:GRIBOED:zalikus", "griboed-key", "2026-07-26 19:08:39").await;
    insert_registry_row(&pool, "dm:sabits:zalikus", "sabits-key", "2026-07-26 19:08:41").await;

    // Reboot over the same directory: this is what runs the migration.
    let _rebooted = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let pool = open_pool(&data_dir).await;

    assert_eq!(
        registry_rows(&pool).await,
        vec![
            ("dm:griboed:zalikus".to_string(), "griboed-key".to_string()),
            ("dm:pivovarca:zalikus".to_string(), "live-key".to_string()),
            ("dm:sabits:zalikus".to_string(), "sabits-key".to_string()),
        ],
        "the 2026-07-26 mis-cased claim must survive as the canonical row"
    );
}

/// Envelopes carry real key material, so the migration renames them and never
/// deletes: a rename that collides with an existing row leaves the legacy row
/// in place (clients canonicalise an envelope's scope on read) rather than
/// dropping a key nobody can regenerate.
#[tokio::test]
async fn scope_casing_migration_never_drops_an_envelope() {
    let (data_dir, pool) = spawn_with_pool().await;

    insert_registry_row(&pool, "dm:Pivovarca:zalikus", "live-key", "2026-07-26 19:08:40").await;
    // Plain rename.
    insert_envelope(&pool, "env-mixed", "dm:Pivovarca:zalikus", "dev_a").await;
    // Collides on (owner, scope_key, sender_device_id, recipient_device_id)
    // once renamed — must still be there afterwards.
    insert_envelope(&pool, "env-collide", "dm:PIVOVARCA:zalikus", "dev_b").await;
    insert_envelope(&pool, "env-canonical", "dm:pivovarca:zalikus", "dev_b").await;

    let _rebooted = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let pool = open_pool(&data_dir).await;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_key_envelopes")
        .fetch_one(&pool)
        .await
        .expect("count envelopes");
    assert_eq!(total, 3, "no envelope may be deleted by the migration");

    let renamed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_key_envelopes WHERE scope_key = 'dm:pivovarca:zalikus'",
    )
    .fetch_one(&pool)
    .await
    .expect("count canonical envelopes");
    assert_eq!(renamed, 2, "the non-colliding envelope must be renamed");
}

/// It runs on every boot, so a second pass over already-folded data must be a
/// no-op — in particular it must not re-stamp `created_at` and let a later
/// claim overtake the winner on the boot after that.
#[tokio::test]
async fn scope_casing_migration_is_idempotent() {
    let (data_dir, pool) = spawn_with_pool().await;

    insert_registry_row(&pool, "dm:Pivovarca:zalikus", "live-key", "2026-07-26 19:08:40").await;
    insert_registry_row(&pool, "dm:pivovarca:zalikus", "later-key", "2026-07-27 18:17:50").await;

    let _boot2 = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let after_first = registry_rows(&open_pool(&data_dir).await).await;

    let _boot3 = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let after_second = registry_rows(&open_pool(&data_dir).await).await;

    assert_eq!(after_first, after_second);
    assert_eq!(
        after_second,
        vec![("dm:pivovarca:zalikus".to_string(), "live-key".to_string())]
    );
}

/// `server:` scopes come from this server, so every participant already derives
/// the same string — the migration must not touch them even when they contain
/// uppercase characters.
#[tokio::test]
async fn scope_casing_migration_leaves_channel_scopes_alone() {
    let (data_dir, pool) = spawn_with_pool().await;

    let channel = "server:10CA71BC-C35E:10CA71BC-C35E-General";
    insert_registry_row(&pool, channel, "channel-key", "2026-07-26 19:08:40").await;

    let _rebooted = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let pool = open_pool(&data_dir).await;

    assert_eq!(
        registry_rows(&pool).await,
        vec![(channel.to_string(), "channel-key".to_string())]
    );
}

/// Dry-run of the startup migration against a **snapshot of the real production
/// database**, which is the only thing that caught the original "canonical
/// spelling wins" bug — a synthetic fixture had no older-but-mis-cased row to
/// discard. Ignored by default (it needs a snapshot); run it before every deploy
/// that touches `migrate_scope_casing`:
///
/// ```text
/// ssh zms "sqlite3 /var/lib/zali/zali_messenger.db \".backup '/tmp/dump.db'\""
/// scp zms:/tmp/dump.db /some/dir/zali_messenger.db
/// ZALI_PROD_SNAPSHOT_DIR=/some/dir \
///   cargo test --manifest-path server/Cargo.toml --test conversation_keys \
///   -- --ignored migration_against_a_production_snapshot --nocapture
/// ```
#[tokio::test]
#[ignore]
async fn migration_against_a_production_snapshot() {
    let Ok(dir) = std::env::var("ZALI_PROD_SNAPSHOT_DIR") else {
        panic!("set ZALI_PROD_SNAPSHOT_DIR to a directory holding a zali_messenger.db snapshot");
    };
    let data_dir = std::path::PathBuf::from(dir);
    let pool = open_pool(&data_dir).await;

    let before = registry_rows(&pool).await;
    let envelopes_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_key_envelopes")
        .fetch_one(&pool)
        .await
        .expect("count envelopes");
    let key_ids_before: std::collections::HashSet<String> =
        before.iter().map(|(_, k)| k.clone()).collect();
    drop(pool);

    let _app = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let pool = open_pool(&data_dir).await;
    let after = registry_rows(&pool).await;
    let envelopes_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_key_envelopes")
        .fetch_one(&pool)
        .await
        .expect("count envelopes");

    println!(
        "registry {} -> {} rows, envelopes {} -> {}",
        before.len(),
        after.len(),
        envelopes_before,
        envelopes_after
    );

    for (scope, _) in &after {
        assert_eq!(
            *scope,
            scope.to_lowercase(),
            "a DM scope survived the fold un-canonicalised: {scope}"
        );
    }
    assert_eq!(
        envelopes_after, envelopes_before,
        "envelopes carry key material and must never be deleted"
    );
    // Folding may drop a *duplicate* registry row, but never a key id that was
    // the only claim for its conversation.
    let key_ids_after: std::collections::HashSet<String> =
        after.iter().map(|(_, k)| k.clone()).collect();
    for (scope, key_id) in &before {
        if before.iter().filter(|(s, _)| s.to_lowercase() == scope.to_lowercase()).count() == 1 {
            assert!(
                key_ids_after.contains(key_id),
                "key id for {scope} vanished though it had no rival casing"
            );
        }
    }
    assert!(key_ids_before.len() >= key_ids_after.len());
}

// ---------------------------------------------------------------------------
// Username casing on the envelope path
//
// Scopes are canonically lowercased, so everything a client derives *from* a
// scope is lowercased too, while `users.username` and every `owner` column are
// byte-exact. A client can only undo that from its own contact list, and the
// user-search endpoint returns five names — so a peer with an uppercase letter
// who is not in your contacts resolved to the lowercase spelling. The server
// resolves it instead, once, for all four client implementations.
// ---------------------------------------------------------------------------

/// The republish sweep looks a peer up by whatever spelling it recovered from
/// the scope. Lowercase must find the same devices as the real casing, or the
/// sweep reports "no devices" and never delivers the key.
#[tokio::test]
async fn a_peer_is_reachable_by_the_lowercased_spelling_from_their_scope() {
    let app = spawn_app().await;
    let griboed = register_user(&app, "GRIBOED", "hunter22").await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    common::register_device(&app, &griboed, "dev_griboed_one").await;

    for spelling in ["GRIBOED", "griboed"] {
        let resp = app
            .http
            .get(app.url(&format!("/api/users/{spelling}/devices")))
            .header("Authorization", zalikus.auth_header())
            .send()
            .await
            .expect("public devices request");
        assert!(resp.status().is_success(), "lookup by {spelling} failed");
        let devices: serde_json::Value = resp.json().await.expect("devices json");
        assert_eq!(
            devices.as_array().map(|d| d.len()),
            Some(1),
            "looking up '{spelling}' must find GRIBOED's device"
        );
    }
}

/// An envelope addressed with the lowercased spelling has to land in the bucket
/// its recipient actually reads, otherwise the sender gets a 200 and the
/// recipient silently never sees a key.
#[tokio::test]
async fn an_envelope_addressed_in_lowercase_reaches_its_recipient() {
    let app = spawn_app().await;
    let griboed = register_user(&app, "GRIBOED", "hunter22").await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    common::register_device(&app, &griboed, "dev_griboed_one").await;

    let resp = app
        .http
        .post(app.url("/api/key-envelopes"))
        .header("Authorization", zalikus.auth_header())
        .json(&serde_json::json!({
            // Lowercased, exactly as peerFromConversationScope hands it back when
            // GRIBOED is not in the sender's contact list.
            "recipient": "griboed",
            "scope": "dm:griboed:zalikus",
            "recipientDeviceId": "dev_griboed_one",
            "senderDeviceId": "dev_zalikus_one",
            "encryptedKey": "x".repeat(64),
        }))
        .send()
        .await
        .expect("post envelope");
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    assert!(status.is_success(), "envelope POST failed: {status} {body}");

    let resp = app
        .http
        .get(app.url("/api/key-envelopes?deviceId=dev_griboed_one"))
        .header("Authorization", griboed.auth_header())
        .send()
        .await
        .expect("list envelopes");
    assert!(resp.status().is_success());
    let envelopes: serde_json::Value = resp.json().await.expect("envelopes json");
    assert_eq!(
        envelopes.as_array().map(|e| e.len()),
        Some(1),
        "GRIBOED must see the envelope addressed to 'griboed'"
    );
}

/// A republish sweep writes one envelope per device per scope. Notifying on every
/// write turned that burst into hundreds of `key_envelope_available` pushes, each
/// making the recipient re-sync envelopes and re-decrypt its open conversation —
/// and because a device also publishes to its own account's other devices, the
/// storm came straight back at the sender. Production log: ~100 envelope POSTs a
/// minute for hours, with 67% of the envelope *fetches* timing out behind them.
///
/// The push carries no per-envelope detail (the client always fetches everything
/// pending for its device), so one push per burst must deliver as much as one per
/// write — which is what the second half of this test pins down.
#[tokio::test]
async fn a_burst_of_envelopes_produces_one_notification_but_loses_none() {
    let app = spawn_app().await;
    let griboed = register_user(&app, "GRIBOED", "hunter22").await;
    let zalikus = register_user(&app, "zalikus", "hunter22").await;
    common::register_device(&app, &griboed, "dev_griboed_one").await;

    let mut request = app.ws_url("/ws").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", griboed.auth_header().parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("ws connect");
    assert_eq!(response.status(), 101);

    // Eight scopes back-to-back, standing in for a sweep over an account's scopes.
    for index in 0..8 {
        let resp = app
            .http
            .post(app.url("/api/key-envelopes"))
            .header("Authorization", zalikus.auth_header())
            .json(&serde_json::json!({
                "recipient": "GRIBOED",
                "scope": format!("dm:griboed:peer{index}"),
                "recipientDeviceId": "dev_griboed_one",
                "senderDeviceId": "dev_zalikus_one",
                "encryptedKey": "x".repeat(64),
            }))
            .send()
            .await
            .expect("post envelope");
        assert!(resp.status().is_success(), "envelope {index} POST failed");
    }

    // Drain whatever the socket has to offer; the burst is over, so anything the
    // server meant to send has been queued by now.
    let mut notifications = 0;
    while let Ok(Some(Ok(message))) =
        tokio::time::timeout(std::time::Duration::from_millis(600), socket.next()).await
    {
        if let WsMessage::Text(text) = message {
            if text.contains("key_envelope_available") {
                notifications += 1;
            }
        }
    }
    assert_eq!(
        notifications, 1,
        "a burst of 8 envelopes must collapse into one notification, got {notifications}"
    );

    // The whole point of coalescing is that it costs nothing: every envelope the
    // burst wrote is still there to be fetched by the single notification.
    let resp = app
        .http
        .get(app.url("/api/key-envelopes?deviceId=dev_griboed_one"))
        .header("Authorization", griboed.auth_header())
        .send()
        .await
        .expect("list envelopes");
    assert!(resp.status().is_success());
    let envelopes: serde_json::Value = resp.json().await.expect("envelopes json");
    assert_eq!(
        envelopes.as_array().map(|e| e.len()),
        Some(8),
        "coalescing the notification must not drop any envelope"
    );
}

// ---------------------------------------------------------------------------
// Stale-claim takeover.
//
// A registry row can outlive every copy of the key it fingerprints — reinstall
// both ends of a DM and `key_id` names material nobody has. Before the takeover
// existed there was no way out of that except the user pressing "сбросить ключи":
// every participant kept its own sending key and re-ran claim → promote(fail) →
// republish → sync → promote(fail) on every chat open, forever.
//
// The client decides a claim is unreachable; the server decides who wins. These
// pin the server's half, which is what makes it terminate instead of ping-pong.
// ---------------------------------------------------------------------------

async fn claim_takeover(
    app: &TestApp,
    user: &RegisteredUser,
    scope: &str,
    key_id: &str,
) -> serde_json::Value {
    let resp = app
        .http
        .post(app.url("/api/conversation-keys/claim"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({ "scope": scope, "keyId": key_id, "takeover": true }))
        .send()
        .await
        .expect("takeover claim request");
    assert!(resp.status().is_success());
    resp.json().await.expect("takeover claim json")
}

/// Backdates a row's `updated_at`, standing in for the 15 minutes a client must
/// have spent unable to obtain the canonical key before it asks for a takeover.
async fn age_registry_row(pool: &sqlx::SqlitePool, scope: &str, minutes: i64) {
    sqlx::query(
        "UPDATE conversation_key_registry
            SET updated_at = datetime('now', ?)
          WHERE scope_key = ?",
    )
    .bind(format!("-{minutes} minutes"))
    .bind(scope)
    .execute(pool)
    .await
    .expect("age registry row");
}

#[tokio::test]
async fn a_recent_claim_cannot_be_taken_over() {
    let (data_dir, pool) = spawn_with_pool().await;
    let app = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let scope = "dm:alice:bob";

    let (status, _) = claim(&app, &alice, scope, "key-id-alice").await;
    assert!(status.is_success());

    // The client-side gate is the one that decides a claim is unreachable; the
    // server's job is only to refuse a second takeover inside the window. A row
    // that was just written must survive one regardless of who asks.
    let body = claim_takeover(&app, &bob, scope, "key-id-bob").await;
    assert_eq!(body["keyId"], "key-id-alice");
    assert_eq!(body["mine"], false);
    drop(pool);
}

#[tokio::test]
async fn a_stale_claim_is_taken_over_and_the_winner_is_reported() {
    let (data_dir, pool) = spawn_with_pool().await;
    let app = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let scope = "dm:alice:bob";

    let (status, _) = claim(&app, &alice, scope, "key-id-alice").await;
    assert!(status.is_success());
    age_registry_row(&pool, scope, 30).await;

    let body = claim_takeover(&app, &bob, scope, "key-id-bob").await;
    assert_eq!(body["keyId"], "key-id-bob", "the takeover must replace the row");
    assert_eq!(body["mine"], true);
    assert_eq!(body["claimedBy"], "bob");

    // And an ordinary claim by anyone else now reports bob's key, so the rest of
    // the participants converge on something that actually exists.
    let (status, seen) = claim(&app, &alice, scope, "key-id-alice").await;
    assert!(status.is_success());
    assert_eq!(seen["keyId"], "key-id-bob");
    assert_eq!(seen["mine"], false);
    drop(pool);
}

#[tokio::test]
async fn only_one_takeover_wins_per_window() {
    let (data_dir, pool) = spawn_with_pool().await;
    let app = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let scope = "dm:alice:bob";

    let (status, _) = claim(&app, &alice, scope, "key-id-original").await;
    assert!(status.is_success());
    age_registry_row(&pool, scope, 30).await;

    // Both sides cross the threshold at the same moment — the exact case that
    // produced one live key per participant when nothing arbitrated it.
    let first = claim_takeover(&app, &bob, scope, "key-id-bob").await;
    let second = claim_takeover(&app, &alice, scope, "key-id-alice").await;

    assert_eq!(first["keyId"], "key-id-bob");
    assert_eq!(first["mine"], true);
    // The second one is refused because the first refreshed `updated_at`, and is
    // handed the winner instead of being allowed to overwrite it.
    assert_eq!(second["keyId"], "key-id-bob", "the second takeover must lose");
    assert_eq!(second["mine"], false);
    drop(pool);
}

#[tokio::test]
async fn a_takeover_on_an_unclaimed_scope_is_an_ordinary_first_claim() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let _bob = register_user(&app, "bob", "hunter22").await;
    let scope = "dm:alice:bob";

    // No row exists. That is "unclaimed", not "stale", so this must behave exactly
    // like a normal claim rather than being rejected for having nothing to replace.
    let body = claim_takeover(&app, &alice, scope, "key-id-alice").await;
    assert_eq!(body["keyId"], "key-id-alice");
    assert_eq!(body["mine"], true);
}

#[tokio::test]
async fn a_takeover_still_requires_participation() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let _bob = register_user(&app, "bob", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;
    let scope = "dm:alice:bob";

    let (status, _) = claim(&app, &alice, scope, "key-id-alice").await;
    assert!(status.is_success());

    // The participant check runs before the write mode is even chosen; a takeover
    // must not be a way around it.
    let resp = app
        .http
        .post(app.url("/api/conversation-keys/claim"))
        .header("Authorization", mallory.auth_header())
        .json(&serde_json::json!({ "scope": scope, "keyId": "key-id-mallory", "takeover": true }))
        .send()
        .await
        .expect("outsider takeover");
    assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// Envelope identity includes the key.
//
// `conversation_key_envelopes` used to be UNIQUE on
// (owner, scope, sender_device, recipient_device) — with no reference to WHICH
// key the envelope carried. Publishing several candidate keys for one scope to
// one device was therefore a run of upserts over a single row, and only the last
// survived. That silently defeated the mechanism built to repair an unreadable
// conversation: handleKeyRepublishRequest answers "I cannot decrypt this scope"
// with every candidate it holds, precisely because the ONE key the requester
// certainly already has is the active one.
// ---------------------------------------------------------------------------

async fn post_envelope(
    app: &TestApp,
    sender: &RegisteredUser,
    recipient: &str,
    scope: &str,
    key_id: Option<&str>,
    encrypted: &str,
) -> reqwest::StatusCode {
    let mut body = serde_json::json!({
        "recipient": recipient,
        "scope": scope,
        "recipientDeviceId": "dev_recipient",
        "senderDeviceId": "dev_sender",
        "encryptedKey": encrypted,
    });
    if let Some(key_id) = key_id {
        body["keyId"] = serde_json::Value::String(key_id.to_string());
    }
    app.http
        .post(app.url("/api/key-envelopes"))
        .header("Authorization", sender.auth_header())
        .json(&body)
        .send()
        .await
        .expect("post envelope")
        .status()
}

async fn envelopes_for(app: &TestApp, user: &RegisteredUser, device: &str) -> Vec<serde_json::Value> {
    let resp = app
        .http
        .get(app.url(&format!("/api/key-envelopes?deviceId={device}")))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .expect("list envelopes");
    assert!(resp.status().is_success());
    resp.json().await.expect("envelope json")
}

#[tokio::test]
async fn distinct_keys_for_one_scope_are_stored_as_distinct_envelopes() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let scope = "dm:alice:bob";

    // Three candidates for one scope, same sender device, same recipient device —
    // exactly the shape of a republish answer.
    for (key_id, blob) in [
        ("key-id-active", "encrypted-envelope-payload-active-aaaaaaaa"),
        ("key-id-old-one", "encrypted-envelope-payload-old-one-bbbbbbb"),
        ("key-id-old-two", "encrypted-envelope-payload-old-two-ccccccc"),
    ] {
        let status = post_envelope(&app, &alice, "bob", scope, Some(key_id), blob).await;
        assert!(status.is_success(), "publishing {key_id} failed");
    }

    let rows = envelopes_for(&app, &bob, "dev_recipient").await;
    assert_eq!(rows.len(), 3, "each distinct key needs its own envelope row");
    let mut blobs: Vec<&str> = rows
        .iter()
        .map(|row| row["encryptedKey"].as_str().unwrap_or(""))
        .collect();
    blobs.sort();
    assert_eq!(
        blobs,
        vec![
            "encrypted-envelope-payload-active-aaaaaaaa",
            "encrypted-envelope-payload-old-one-bbbbbbb",
            "encrypted-envelope-payload-old-two-ccccccc",
        ]
    );
}

#[tokio::test]
async fn republishing_the_same_key_replaces_its_envelope_rather_than_adding_one() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let scope = "dm:alice:bob";

    post_envelope(&app, &alice, "bob", scope, Some("key-id-a"), "encrypted-envelope-first-version-aa").await;
    post_envelope(&app, &alice, "bob", scope, Some("key-id-a"), "encrypted-envelope-second-version-b").await;

    let rows = envelopes_for(&app, &bob, "dev_recipient").await;
    assert_eq!(rows.len(), 1, "the same key must keep occupying one row");
    assert_eq!(rows[0]["encryptedKey"], "encrypted-envelope-second-version-b");
}

#[tokio::test]
async fn a_client_that_sends_no_key_id_keeps_the_old_one_row_behaviour() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;
    let scope = "dm:alice:bob";

    // Older clients predate `keyId` entirely. They land on the empty-string id, so
    // they behave exactly as before rather than accumulating a row per publish.
    post_envelope(&app, &alice, "bob", scope, None, "encrypted-envelope-legacy-first-a").await;
    post_envelope(&app, &alice, "bob", scope, None, "encrypted-envelope-legacy-second-b").await;

    let rows = envelopes_for(&app, &bob, "dev_recipient").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["encryptedKey"], "encrypted-envelope-legacy-second-b");
}

/// The column is part of a UNIQUE constraint declared inline, so adding it needs a
/// table rebuild rather than an ALTER. Existing envelopes must come through it.
#[tokio::test]
async fn adding_key_id_to_the_envelope_table_preserves_existing_rows() {
    let (data_dir, pool) = spawn_with_pool().await;

    // Recreate the pre-migration shape, then put a row in it.
    sqlx::query("DROP TABLE conversation_key_envelopes")
        .execute(&pool)
        .await
        .expect("drop new table");
    sqlx::query(
        "CREATE TABLE conversation_key_envelopes (
            envelope_id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            sender TEXT NOT NULL,
            sender_device_id TEXT NOT NULL,
            recipient_device_id TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(owner, scope_key, sender_device_id, recipient_device_id)
        )",
    )
    .execute(&pool)
    .await
    .expect("recreate legacy table");
    sqlx::query(
        "INSERT INTO conversation_key_envelopes
         (envelope_id, owner, scope_key, sender, sender_device_id, recipient_device_id, encrypted_key, created_at)
         VALUES ('env_legacy', 'bob', 'dm:alice:bob', 'alice', 'dev_a', 'dev_b', 'legacy-blob', '2026-08-01 10:00:00')",
    )
    .execute(&pool)
    .await
    .expect("seed legacy envelope");
    drop(pool);

    let _rebooted = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let pool = open_pool(&data_dir).await;

    let (envelope_id, key_id, blob, created_at) =
        sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT envelope_id, key_id, encrypted_key, created_at FROM conversation_key_envelopes",
        )
        .fetch_one(&pool)
        .await
        .expect("legacy row survived the rebuild");
    assert_eq!(envelope_id, "env_legacy");
    assert_eq!(blob, "legacy-blob");
    assert_eq!(created_at, "2026-08-01 10:00:00", "created_at must not be reset");
    assert_eq!(key_id, "", "pre-migration rows keep the id they effectively had");

    // And the widened constraint is actually in force afterwards.
    sqlx::query(
        "INSERT INTO conversation_key_envelopes
         (envelope_id, owner, scope_key, sender, sender_device_id, recipient_device_id, key_id, encrypted_key)
         VALUES ('env_new', 'bob', 'dm:alice:bob', 'alice', 'dev_a', 'dev_b', 'key-id-2', 'second-blob')",
    )
    .execute(&pool)
    .await
    .expect("a second key for the same pair must be storable");

    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversation_key_envelopes")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(count, 2);

    // Idempotent: booting again must not rebuild or duplicate anything.
    drop(pool);
    let _again = common::spawn_app_with_data_dir(data_dir.clone()).await;
    let pool = open_pool(&data_dir).await;
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversation_key_envelopes")
        .fetch_one(&pool)
        .await
        .expect("count after second boot");
    assert_eq!(count, 2);

    // The rebuild has to drop the lookup index (it names the old table and would
    // otherwise block the rename — that is what made the first version of this
    // migration fail, and the failure took the table with it). Whatever it drops,
    // startup must put back: without this index every envelope fetch is a scan.
    let index_exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'index' AND name = 'idx_conversation_key_envelopes_owner_device'",
    )
    .fetch_one(&pool)
    .await
    .expect("index lookup");
    assert_eq!(index_exists, 1, "the envelope lookup index must be restored");
}

// ---------------------------------------------------------------------------
// Cloud vault event retention.
//
// The client republishes the whole encrypted key set on every key change and
// reads the stream back on every sync, and nothing ever deleted a row: the table
// grew without bound while the read returned all of it, each row up to 256 KB.
// ---------------------------------------------------------------------------

async fn post_vault_event(app: &TestApp, user: &RegisteredUser, blob: &str, target: Option<&str>) {
    let mut body = serde_json::json!({
        "vaultEpoch": 1_i64,
        "encryptedVaultEvent": blob,
    });
    if let Some(target) = target {
        body["issuedToDeviceId"] = serde_json::Value::String(target.to_string());
    }
    let resp = app
        .http
        .post(app.url("/api/vault/events"))
        .header("Authorization", user.auth_header())
        .json(&body)
        .send()
        .await
        .expect("post vault event");
    assert!(resp.status().is_success(), "vault event rejected");
}

async fn vault_events(app: &TestApp, user: &RegisteredUser) -> Vec<serde_json::Value> {
    let resp = app
        .http
        .get(app.url("/api/vault/events"))
        .header("Authorization", user.auth_header())
        .send()
        .await
        .expect("list vault events");
    assert!(resp.status().is_success());
    resp.json().await.expect("vault json")
}

#[tokio::test]
async fn the_vault_event_stream_is_capped_and_keeps_the_newest() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    for i in 0..40 {
        post_vault_event(&app, &alice, &format!("encrypted-vault-event-number-{i:03}"), None).await;
    }

    let events = vault_events(&app, &alice).await;
    assert!(
        events.len() <= 24,
        "the stream must be bounded, got {}",
        events.len()
    );
    // Newest survive: the client scans backwards from the end looking for one it
    // can decrypt, so the tail is the only part that is ever reachable.
    let blobs: Vec<&str> = events
        .iter()
        .map(|e| e["encryptedVaultEvent"].as_str().unwrap_or(""))
        .collect();
    assert!(
        blobs.contains(&"encrypted-vault-event-number-039"),
        "the newest event must survive"
    );
    assert!(
        !blobs.contains(&"encrypted-vault-event-number-000"),
        "the oldest must have been pruned"
    );
    // Handed back oldest-first, which is the order the client's backward scan expects.
    let mut sorted = blobs.clone();
    sorted.sort();
    assert_eq!(blobs, sorted, "events must come back in ascending order");
}

#[tokio::test]
async fn broadcast_churn_does_not_evict_a_targeted_vault_handoff() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    // A one-time handoff to a specific new device (approveDeviceAndExport). It is
    // encrypted with a code that device was given out of band, and it is the only
    // copy — ordinary key churn on the approving device must not be able to bury it
    // before the new device has logged in to collect it.
    post_vault_event(&app, &alice, "encrypted-vault-handoff-for-the-new-device", Some("dev_new")).await;
    for i in 0..40 {
        post_vault_event(&app, &alice, &format!("encrypted-vault-broadcast-{i:03}"), None).await;
    }

    let events = vault_events(&app, &alice).await;
    let blobs: Vec<&str> = events
        .iter()
        .map(|e| e["encryptedVaultEvent"].as_str().unwrap_or(""))
        .collect();
    assert!(
        blobs.contains(&"encrypted-vault-handoff-for-the-new-device"),
        "a targeted handoff must not be evicted by broadcast churn"
    );
}
