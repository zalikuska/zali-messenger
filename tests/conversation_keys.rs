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
