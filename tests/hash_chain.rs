//! Integration tests for the per-conversation message hash chain.
//!
//! Everything here goes through the real HTTP handlers against a real server
//! instance: messages are sent, edited and deleted exactly the way a client
//! does it, and the chain is read back through its own endpoints and its
//! encrypted `.zali` export. Nothing pokes at the database directly, so a
//! passing run means the mechanism works end to end and not merely that the
//! functions agree with each other.

mod common;

use common::{register_user, spawn_app, RegisteredUser, TestApp};
use sha2::{Digest, Sha256};
use zali_messenger_core::net::{pack_message_bytes, unpack_message_bytes, InMemoryAttachment};
use zali_sdk::ZaliSession;

const CHAIN_MAGIC: &[u8; 8] = b"ZALIHASH";
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// A real message archive: `message.json` plus its attachments, all inside one
/// `.zali` encrypted with a single key — the exact bytes a client uploads.
fn message_archive(sender: &str, text: &str, key: &str, attachments: Vec<(&str, &[u8])>) -> Vec<u8> {
    message_archive_with_reply(sender, text, key, attachments, None)
}

/// Same, but carrying a reply quote — the payload a "reply to" message holds.
fn message_archive_with_reply(
    sender: &str,
    text: &str,
    key: &str,
    attachments: Vec<(&str, &[u8])>,
    reply: Option<&str>,
) -> Vec<u8> {
    let attachments = attachments
        .into_iter()
        .map(|(name, bytes)| InMemoryAttachment {
            name: name.to_string(),
            archive_path: name.to_string(),
            mime_type: "application/octet-stream".to_string(),
            kind: "file".to_string(),
            bytes: bytes.to_vec(),
        })
        .collect();
    pack_message_bytes(sender, text, key, 2, attachments, None, reply)
        .expect("pack message archive")
}

async fn send_dm(app: &TestApp, from: &RegisteredUser, to: &str, archive: &[u8]) -> String {
    let form = reqwest::multipart::Form::new()
        .text("sender", from.username.clone())
        .text("receiver", to.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(archive.to_vec())
                .file_name("msg.zali")
                .mime_str("application/octet-stream")
                .unwrap(),
        );

    let resp = app
        .http
        .post(app.url("/api/upload"))
        .header("Authorization", from.auth_header())
        .multipart(form)
        .send()
        .await
        .expect("upload request");
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.expect("upload json");
    body["id"].as_str().expect("message id").to_string()
}

async fn edit(
    app: &TestApp,
    actor: &RegisteredUser,
    message_id: &str,
    archive: &[u8],
) -> reqwest::Response {
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(archive.to_vec())
            .file_name("msg.zali")
            .mime_str("application/octet-stream")
            .unwrap(),
    );

    app.http
        .put(app.url(&format!("/api/message/{}", message_id)))
        .header("Authorization", actor.auth_header())
        .multipart(form)
        .send()
        .await
        .expect("edit request")
}

async fn delete(app: &TestApp, actor: &RegisteredUser, message_id: &str) -> reqwest::Response {
    app.http
        .delete(app.url(&format!("/api/message/{}", message_id)))
        .header("Authorization", actor.auth_header())
        .send()
        .await
        .expect("delete request")
}

async fn chain(app: &TestApp, user: &RegisteredUser, scope: &str) -> serde_json::Value {
    let resp = app
        .http
        .get(app.url("/api/conversations/hash-chain"))
        .query(&[("scope", scope)])
        .header("Authorization", user.auth_header())
        .send()
        .await
        .expect("chain request");
    assert_eq!(resp.status(), 200, "chain fetch failed for {}", scope);
    resp.json().await.expect("chain json")
}

/// `["1.0", "1.1", ...]` in chain order.
fn labels(chain: &serde_json::Value) -> Vec<String> {
    chain["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .map(|entry| entry["label"].as_str().expect("label").to_string())
        .collect()
}

fn events(chain: &serde_json::Value) -> Vec<String> {
    chain["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .map(|entry| entry["event"].as_str().expect("event").to_string())
        .collect()
}

fn entry_by_label<'a>(chain: &'a serde_json::Value, label: &str) -> &'a serde_json::Value {
    chain["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .find(|entry| entry["label"] == label)
        .unwrap_or_else(|| panic!("no entry labelled {}", label))
}

// ============================================================
// NUMBERING: "<message number>.<version>"
// ============================================================

#[tokio::test]
async fn a_sent_message_is_logged_as_version_zero_with_the_archive_hash() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let archive = message_archive("alice", "привет", "conv-key", vec![]);
    let message_id = send_dm(&app, &alice, "bob", &archive).await;

    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0"]);
    assert_eq!(events(&chain), vec!["create"]);
    assert_eq!(chain["verified"], serde_json::json!(true));

    let entry = entry_by_label(&chain, "1.0");
    assert_eq!(entry["messageId"], serde_json::json!(message_id));
    assert_eq!(entry["actor"], serde_json::json!("alice"));
    assert_eq!(entry["messageNumber"], serde_json::json!(1));
    assert_eq!(entry["version"], serde_json::json!(0));
    assert_eq!(entry["prevHash"], serde_json::json!(GENESIS));
    // The hash is of the ciphertext the server actually stored — this is the
    // property the whole chain rests on.
    assert_eq!(
        entry["payloadSha256"],
        serde_json::json!(sha256_hex(&archive))
    );
    assert_eq!(
        entry["payloadSize"],
        serde_json::json!(archive.len() as i64)
    );
}

#[tokio::test]
async fn each_message_takes_the_next_number_in_its_conversation() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    for n in 0..3 {
        let archive = message_archive("alice", &format!("msg {}", n), "conv-key", vec![]);
        send_dm(&app, &alice, "bob", &archive).await;
    }
    // A reply from the other side lands in the same chain: the scope is the
    // conversation, not the sender.
    let reply = message_archive("bob", "ответ", "conv-key", vec![]);
    send_dm(&app, &bob, "alice", &reply).await;

    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0", "2.0", "3.0", "4.0"]);
    assert_eq!(
        entry_by_label(&chain, "4.0")["actor"],
        serde_json::json!("bob")
    );
}

#[tokio::test]
async fn editing_appends_successive_versions_of_the_same_message_number() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let original = message_archive("alice", "первая версия", "conv-key", vec![]);
    let message_id = send_dm(&app, &alice, "bob", &original).await;

    let first_edit = message_archive("alice", "вторая версия", "conv-key", vec![]);
    let resp = edit(&app, &alice, &message_id, &first_edit).await;
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["version"], serde_json::json!(1));

    let second_edit = message_archive("alice", "третья версия", "conv-key", vec![]);
    let resp = edit(&app, &alice, &message_id, &second_edit).await;
    assert_eq!(resp.status(), 200);

    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0", "1.1", "1.2"]);
    assert_eq!(events(&chain), vec!["create", "edit", "edit"]);
    assert_eq!(chain["verified"], serde_json::json!(true));

    // Each version records the hash of *its own* ciphertext, so the log
    // distinguishes the revisions instead of just counting them.
    assert_eq!(
        entry_by_label(&chain, "1.0")["payloadSha256"],
        serde_json::json!(sha256_hex(&original))
    );
    assert_eq!(
        entry_by_label(&chain, "1.1")["payloadSha256"],
        serde_json::json!(sha256_hex(&first_edit))
    );
    assert_eq!(
        entry_by_label(&chain, "1.2")["payloadSha256"],
        serde_json::json!(sha256_hex(&second_edit))
    );
}

#[tokio::test]
async fn an_edit_replaces_what_the_recipient_downloads() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let original = message_archive("alice", "первая версия", "conv-key", vec![]);
    let message_id = send_dm(&app, &alice, "bob", &original).await;

    let edited = message_archive("alice", "исправленная версия", "conv-key", vec![]);
    assert_eq!(edit(&app, &alice, &message_id, &edited).await.status(), 200);

    let downloaded = app
        .http
        .get(app.url(&format!("/api/download/{}", message_id)))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .expect("download")
        .bytes()
        .await
        .expect("download bytes");

    let unpacked = unpack_message_bytes(&downloaded, "conv-key").expect("unpack");
    assert_eq!(unpacked.text, "исправленная версия");
    assert_eq!(sha256_hex(&downloaded), sha256_hex(&edited));
}

#[tokio::test]
async fn deleting_a_message_leaves_its_whole_history_in_the_chain() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let original = message_archive("alice", "сказанное", "conv-key", vec![]);
    let message_id = send_dm(&app, &alice, "bob", &original).await;
    let edited = message_archive("alice", "переписанное", "conv-key", vec![]);
    assert_eq!(edit(&app, &alice, &message_id, &edited).await.status(), 200);
    assert_eq!(delete(&app, &alice, &message_id).await.status(), 204);

    // The message itself is gone...
    let history: serde_json::Value = app
        .http
        .get(app.url("/api/messages/bob"))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(history.as_array().unwrap().is_empty());

    // ...but the record that it existed, was changed, and was removed is not.
    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0", "1.1", "1.2"]);
    assert_eq!(events(&chain), vec!["create", "edit", "delete"]);
    assert_eq!(chain["verified"], serde_json::json!(true));
    // The deletion points at the archive that was removed, not at a blank.
    assert_eq!(
        entry_by_label(&chain, "1.2")["payloadSha256"],
        serde_json::json!(sha256_hex(&edited))
    );
}

#[tokio::test]
async fn a_deleted_message_never_gives_its_number_back() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let first = send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "один", "conv-key", vec![]),
    )
    .await;
    assert_eq!(delete(&app, &alice, &first).await.status(), 204);
    send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "два", "conv-key", vec![]),
    )
    .await;

    let chain = chain(&app, &alice, "dm:alice:bob").await;
    // Reusing number 1 would make the deleted message and its replacement
    // indistinguishable in the log — exactly what the log exists to prevent.
    assert_eq!(labels(&chain), vec!["1.0", "1.1", "2.0"]);
}

// ============================================================
// CHAIN INTEGRITY
// ============================================================

#[tokio::test]
async fn every_entry_links_to_the_previous_one_and_the_chain_verifies() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let first = send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "один", "conv-key", vec![]),
    )
    .await;
    send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "два", "conv-key", vec![]),
    )
    .await;
    assert_eq!(
        edit(
            &app,
            &alice,
            &first,
            &message_archive("alice", "один*", "conv-key", vec![])
        )
        .await
        .status(),
        200
    );

    let chain_value = chain(&app, &alice, "dm:alice:bob").await;
    let entries = chain_value["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);

    let mut expected_prev = GENESIS.to_string();
    for (index, entry) in entries.iter().enumerate() {
        assert_eq!(entry["position"], serde_json::json!(index as i64));
        assert_eq!(entry["prevHash"], serde_json::json!(expected_prev));
        expected_prev = entry["entryHash"].as_str().unwrap().to_string();
    }
    assert_eq!(chain_value["headHash"], serde_json::json!(expected_prev));

    let verification: serde_json::Value = app
        .http
        .get(app.url("/api/conversations/hash-chain/verify"))
        .query(&[("scope", "dm:alice:bob")])
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(verification["ok"], serde_json::json!(true));
    assert_eq!(verification["entries"], serde_json::json!(3));
    assert_eq!(verification["headHash"], serde_json::json!(expected_prev));
}

#[tokio::test]
async fn separate_conversations_keep_separate_chains() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    register_user(&app, "carol", "hunter22").await;

    send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "бобу", "conv-key", vec![]),
    )
    .await;
    send_dm(
        &app,
        &alice,
        "carol",
        &message_archive("alice", "кэрол", "conv-key", vec![]),
    )
    .await;

    // Both start at 1.0: numbering is per conversation, so one chat's traffic
    // never shifts another's numbers.
    assert_eq!(labels(&chain(&app, &alice, "dm:alice:bob").await), vec!["1.0"]);
    assert_eq!(
        labels(&chain(&app, &alice, "dm:alice:carol").await),
        vec!["1.0"]
    );
}

// ============================================================
// ACCESS CONTROL
// ============================================================

#[tokio::test]
async fn a_non_participant_cannot_read_the_chain() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;

    send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "секрет", "conv-key", vec![]),
    )
    .await;

    for path in [
        "/api/conversations/hash-chain",
        "/api/conversations/hash-chain/verify",
        "/api/conversations/hash-chain.zali",
    ] {
        let resp = app
            .http
            .get(app.url(path))
            .query(&[("scope", "dm:alice:bob")])
            .header("Authorization", mallory.auth_header())
            .send()
            .await
            .expect("chain request");
        assert_eq!(resp.status(), 403, "{} leaked to a non-participant", path);
    }
}

#[tokio::test]
async fn the_chain_requires_authentication() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "секрет", "conv-key", vec![]),
    )
    .await;

    let resp = app
        .http
        .get(app.url("/api/conversations/hash-chain"))
        .query(&[("scope", "dm:alice:bob")])
        .send()
        .await
        .expect("chain request");
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn only_the_author_may_edit_and_a_refused_edit_writes_nothing() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let original = message_archive("alice", "мои слова", "conv-key", vec![]);
    let message_id = send_dm(&app, &alice, "bob", &original).await;

    // Bob is the recipient — he can read the message, but rewriting it under
    // Alice's name would be forgery the chain would faithfully attribute to her.
    let forged = message_archive("alice", "не мои слова", "conv-key", vec![]);
    assert_eq!(edit(&app, &bob, &message_id, &forged).await.status(), 403);

    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0"]);
    assert_eq!(
        entry_by_label(&chain, "1.0")["payloadSha256"],
        serde_json::json!(sha256_hex(&original))
    );

    let downloaded = app
        .http
        .get(app.url(&format!("/api/download/{}", message_id)))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(sha256_hex(&downloaded), sha256_hex(&original));
}

#[tokio::test]
async fn an_edit_without_a_valid_archive_is_rejected_and_changes_nothing() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let original = message_archive("alice", "слова", "conv-key", vec![]);
    let message_id = send_dm(&app, &alice, "bob", &original).await;

    let resp = edit(&app, &alice, &message_id, b"not-a-zali-archive-at-all").await;
    assert_eq!(resp.status(), 400);

    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0"]);

    let downloaded = app
        .http
        .get(app.url(&format!("/api/download/{}", message_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(sha256_hex(&downloaded), sha256_hex(&original));
}

// ============================================================
// THE .zali EXPORT
// ============================================================

async fn download_export(app: &TestApp, user: &RegisteredUser, scope: &str) -> Vec<u8> {
    let resp = app
        .http
        .get(app.url("/api/conversations/hash-chain.zali"))
        .query(&[("scope", scope)])
        .header("Authorization", user.auth_header())
        .send()
        .await
        .expect("export request");
    assert_eq!(resp.status(), 200);
    resp.bytes().await.expect("export bytes").to_vec()
}

#[tokio::test]
async fn the_zali_export_decrypts_to_exactly_the_chain_the_api_reports() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let first = send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "один", "conv-key", vec![]),
    )
    .await;
    assert_eq!(
        edit(
            &app,
            &alice,
            &first,
            &message_archive("alice", "один*", "conv-key", vec![])
        )
        .await
        .status(),
        200
    );
    let second = send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "два", "conv-key", vec![]),
    )
    .await;
    assert_eq!(delete(&app, &alice, &second).await.status(), 204);

    let api_chain = chain(&app, &alice, "dm:alice:bob").await;
    let export = download_export(&app, &alice, "dm:alice:bob").await;
    assert_eq!(&export[..8], CHAIN_MAGIC, "export is not a .zali archive");

    let session = ZaliSession::new(Some(app.hash_chain_key.as_str()), Some(CHAIN_MAGIC));
    let files = session.extract_all_bytes(&export).expect("extract export");
    let names: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
    assert!(names.contains(&"chain.json"));
    assert!(names.contains(&"index.json"));

    let chain_doc: serde_json::Value = serde_json::from_slice(
        &files
            .iter()
            .find(|(name, _)| name == "chain.json")
            .unwrap()
            .1,
    )
    .expect("chain.json parses");

    assert_eq!(chain_doc["conversationScope"], serde_json::json!("dm:alice:bob"));
    assert_eq!(chain_doc["headHash"], api_chain["headHash"]);
    assert_eq!(chain_doc["entries"], api_chain["entries"]);
    assert_eq!(labels(&chain_doc), vec!["1.0", "1.1", "2.0", "2.1"]);
    assert_eq!(events(&chain_doc), vec!["create", "edit", "create", "delete"]);

    // index.json is the flat "<message>.<version>" → hash map the chain is
    // meant to be read as.
    let index: serde_json::Value = serde_json::from_slice(
        &files
            .iter()
            .find(|(name, _)| name == "index.json")
            .unwrap()
            .1,
    )
    .expect("index.json parses");
    assert_eq!(index["verified"], serde_json::json!(true));
    for label in ["1.0", "1.1", "2.0", "2.1"] {
        assert_eq!(
            index["hashes"][label]["entryHash"],
            entry_by_label(&api_chain, label)["entryHash"],
            "index.json disagrees with the API at {}",
            label
        );
    }
}

#[tokio::test]
async fn the_export_is_encrypted_and_lands_on_disk_under_an_opaque_name() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "один", "conv-key", vec![]),
    )
    .await;

    let export = download_export(&app, &alice, "dm:alice:bob").await;
    // Neither the participants nor the labels may be readable in the ciphertext.
    assert!(!export.windows(5).any(|w| w == b"alice"));
    assert!(!export.windows(3).any(|w| w == b"1.0"));

    let wrong = ZaliSession::new(Some("definitely-not-the-key"), Some(CHAIN_MAGIC));
    assert!(wrong.extract_all_bytes(&export).is_err());

    // The file is a real artifact on disk, not only a response body.
    let dir = app.data_dir.join("hash_chains");
    let mut entries = std::fs::read_dir(&dir)
        .expect("hash_chains dir")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    entries.sort();
    assert_eq!(entries.len(), 1, "unexpected export files: {:?}", entries);
    let name = &entries[0];
    assert!(name.ends_with(".zali"));
    // The filename must not spell out who is talking to whom.
    assert!(!name.contains("alice") && !name.contains("bob"));
    assert_eq!(std::fs::read(dir.join(name)).unwrap(), export);
}

#[tokio::test]
async fn the_export_tracks_the_chain_as_it_grows() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "один", "conv-key", vec![]),
    )
    .await;
    let first_export = download_export(&app, &alice, "dm:alice:bob").await;

    send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "два", "conv-key", vec![]),
    )
    .await;
    let second_export = download_export(&app, &alice, "dm:alice:bob").await;

    let session = ZaliSession::new(Some(app.hash_chain_key.as_str()), Some(CHAIN_MAGIC));
    let read = |bytes: &[u8]| -> serde_json::Value {
        let files = session.extract_all_bytes(bytes).expect("extract");
        serde_json::from_slice(
            &files
                .iter()
                .find(|(name, _)| name == "chain.json")
                .unwrap()
                .1,
        )
        .expect("parse")
    };

    assert_eq!(labels(&read(&first_export)), vec!["1.0"]);
    assert_eq!(labels(&read(&second_export)), vec!["1.0", "2.0"]);
    // The first message's entry is byte-identical across exports: appending
    // must never rewrite history.
    assert_eq!(
        read(&first_export)["entries"][0],
        read(&second_export)["entries"][0]
    );
}

#[tokio::test]
async fn an_empty_conversation_exports_an_empty_but_valid_chain() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let export = download_export(&app, &alice, "dm:alice:bob").await;
    let session = ZaliSession::new(Some(app.hash_chain_key.as_str()), Some(CHAIN_MAGIC));
    let files = session.extract_all_bytes(&export).expect("extract");
    let doc: serde_json::Value = serde_json::from_slice(
        &files
            .iter()
            .find(|(name, _)| name == "chain.json")
            .unwrap()
            .1,
    )
    .unwrap();
    assert_eq!(doc["entries"], serde_json::json!([]));
    assert_eq!(doc["headHash"], serde_json::json!(GENESIS));
}

// ============================================================
// THE MESSAGE ARCHIVE ITSELF: text + attachments, one encrypted .zali
// ============================================================

#[tokio::test]
async fn one_archive_carries_the_message_and_all_its_attachments() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let photo = vec![0xABu8; 3000];
    let doc = b"attachment payload \xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82".to_vec();
    let archive = message_archive(
        "alice",
        "смотри что нашёл",
        "conv-key",
        vec![("photo.bin", &photo), ("notes.txt", &doc)],
    );

    // The single uploaded blob must not leak the text or the attachment bytes.
    assert_eq!(&archive[..8], b"ZALIMSSG");
    assert!(!archive
        .windows(14)
        .any(|w| w == "смотри".as_bytes()));
    assert!(!archive
        .windows(19)
        .any(|w| w == b"attachment payload "));

    let message_id = send_dm(&app, &alice, "bob", &archive).await;

    let downloaded = app
        .http
        .get(app.url(&format!("/api/download/{}", message_id)))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    // Byte-for-byte what was uploaded — the server stores, it does not repack.
    assert_eq!(downloaded.as_ref(), archive.as_slice());

    let unpacked = unpack_message_bytes(&downloaded, "conv-key").expect("unpack");
    assert_eq!(unpacked.sender, "alice");
    assert_eq!(unpacked.text, "смотри что нашёл");
    assert_eq!(unpacked.attachments.len(), 2);
    let photo_part = unpacked
        .attachments
        .iter()
        .find(|a| a.name == "photo.bin")
        .expect("photo attachment");
    assert_eq!(photo_part.bytes, photo);
    let doc_part = unpacked
        .attachments
        .iter()
        .find(|a| a.name == "notes.txt")
        .expect("notes attachment");
    assert_eq!(doc_part.bytes, doc);

    // One key opens the whole thing, and a wrong one opens none of it.
    assert!(unpack_message_bytes(&downloaded, "wrong-key").is_err());

    // ...and the chain hashed that exact archive.
    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(
        entry_by_label(&chain, "1.0")["payloadSha256"],
        serde_json::json!(sha256_hex(&archive))
    );
}

#[tokio::test]
async fn editing_a_message_can_change_its_attachments_and_the_chain_follows() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let original_file = vec![1u8; 512];
    let original = message_archive(
        "alice",
        "версия с файлом",
        "conv-key",
        vec![("a.bin", &original_file)],
    );
    let message_id = send_dm(&app, &alice, "bob", &original).await;

    let replacement_file = vec![2u8; 900];
    let edited = message_archive(
        "alice",
        "версия с другим файлом",
        "conv-key",
        vec![("b.bin", &replacement_file)],
    );
    assert_eq!(edit(&app, &alice, &message_id, &edited).await.status(), 200);

    let downloaded = app
        .http
        .get(app.url(&format!("/api/download/{}", message_id)))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let unpacked = unpack_message_bytes(&downloaded, "conv-key").expect("unpack");
    assert_eq!(unpacked.text, "версия с другим файлом");
    assert_eq!(unpacked.attachments.len(), 1);
    assert_eq!(unpacked.attachments[0].name, "b.bin");
    assert_eq!(unpacked.attachments[0].bytes, replacement_file);

    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(
        entry_by_label(&chain, "1.0")["payloadSha256"],
        serde_json::json!(sha256_hex(&original))
    );
    assert_eq!(
        entry_by_label(&chain, "1.1")["payloadSha256"],
        serde_json::json!(sha256_hex(&edited))
    );
    assert_ne!(
        entry_by_label(&chain, "1.0")["payloadSize"],
        entry_by_label(&chain, "1.1")["payloadSize"]
    );
}

// ============================================================
// REPLY QUOTES
// ============================================================

#[tokio::test]
async fn a_reply_carries_its_quote_inside_the_encrypted_archive() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let original = message_archive("alice", "исходное сообщение", "conv-key", vec![]);
    let original_id = send_dm(&app, &alice, "bob", &original).await;

    let quote = serde_json::json!({
        "id": original_id,
        "sender": "alice",
        "text": "исходное сообщение",
        "attachmentCount": 0,
    })
    .to_string();
    let reply = message_archive_with_reply("bob", "мой ответ", "conv-key", vec![], Some(&quote));

    // The quote embeds a verbatim copy of Alice's message — the server must not
    // be able to read it any more than it can read the body.
    assert!(!reply
        .windows("исходное".len())
        .any(|w| w == "исходное".as_bytes()));

    let reply_id = send_dm(&app, &bob, "alice", &reply).await;

    let downloaded = app
        .http
        .get(app.url(&format!("/api/download/{}", reply_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let unpacked = unpack_message_bytes(&downloaded, "conv-key").expect("unpack");
    assert_eq!(unpacked.text, "мой ответ");
    assert_eq!(unpacked.reply.as_deref(), Some(quote.as_str()));

    // Both messages are journalled independently; a reply is an ordinary message
    // as far as the chain is concerned.
    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0", "2.0"]);
    assert_eq!(
        entry_by_label(&chain, "2.0")["payloadSha256"],
        serde_json::json!(sha256_hex(&reply))
    );
}

#[tokio::test]
async fn a_quote_outlives_the_message_it_quotes() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let original_id = send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "будет удалено", "conv-key", vec![]),
    )
    .await;
    let quote = serde_json::json!({
        "id": original_id,
        "sender": "alice",
        "text": "будет удалено",
        "attachmentCount": 0,
    })
    .to_string();
    let reply_id = send_dm(
        &app,
        &bob,
        "alice",
        &message_archive_with_reply("bob", "ответ", "conv-key", vec![], Some(&quote)),
    )
    .await;

    assert_eq!(delete(&app, &alice, &original_id).await.status(), 204);

    // This is the whole reason the quote is a snapshot in the archive rather
    // than a pointer resolved at render time.
    let downloaded = app
        .http
        .get(app.url(&format!("/api/download/{}", reply_id)))
        .header("Authorization", bob.auth_header())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let unpacked = unpack_message_bytes(&downloaded, "conv-key").expect("unpack");
    assert_eq!(unpacked.reply.as_deref(), Some(quote.as_str()));
}

#[tokio::test]
async fn editing_a_reply_keeps_the_quote_it_was_answering() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    let original_id = send_dm(
        &app,
        &alice,
        "bob",
        &message_archive("alice", "вопрос", "conv-key", vec![]),
    )
    .await;
    let quote = serde_json::json!({
        "id": original_id, "sender": "alice", "text": "вопрос", "attachmentCount": 0,
    })
    .to_string();
    let reply_id = send_dm(
        &app,
        &bob,
        "alice",
        &message_archive_with_reply("bob", "первый ответ", "conv-key", vec![], Some(&quote)),
    )
    .await;

    // The client re-packs the whole message on edit, quote included — dropping it
    // would visually detach the reply from what it was answering.
    let edited =
        message_archive_with_reply("bob", "исправленный ответ", "conv-key", vec![], Some(&quote));
    assert_eq!(edit(&app, &bob, &reply_id, &edited).await.status(), 200);

    let downloaded = app
        .http
        .get(app.url(&format!("/api/download/{}", reply_id)))
        .header("Authorization", alice.auth_header())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let unpacked = unpack_message_bytes(&downloaded, "conv-key").expect("unpack");
    assert_eq!(unpacked.text, "исправленный ответ");
    assert_eq!(unpacked.reply.as_deref(), Some(quote.as_str()));

    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0", "2.0", "2.1"]);
    assert_eq!(events(&chain), vec!["create", "create", "edit"]);
}

// ============================================================
// CHANNELS
// ============================================================

/// Creates a server and returns it with one of its seeded channels —
/// `POST /api/servers` already comes back with the default channels attached.
async fn create_server_and_channel(
    app: &TestApp,
    owner: &RegisteredUser,
    name: &str,
    public: bool,
) -> (String, String) {
    let server: serde_json::Value = app
        .http
        .post(app.url("/api/servers"))
        .header("Authorization", owner.auth_header())
        .json(&serde_json::json!({ "name": name, "is_public": public }))
        .send()
        .await
        .expect("create server")
        .json()
        .await
        .expect("server json");

    // Asserted, not assumed: an ignored visibility field would silently make
    // every "private server" test below check a public server instead.
    assert_eq!(
        server["is_public"],
        serde_json::json!(public),
        "server visibility did not take effect: {}",
        server
    );

    let server_id = server["id"].as_str().expect("server id").to_string();
    let channel_id = server["channels"][0]["id"]
        .as_str()
        .expect("seeded channel id")
        .to_string();

    (server_id, channel_id)
}

#[tokio::test]
async fn channel_messages_are_chained_under_the_channel_scope() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let (server_id, channel_id) =
        create_server_and_channel(&app, &alice, "Chain Server", true).await;

    let archive = message_archive("alice", "в канал", "conv-key", vec![]);
    let form = reqwest::multipart::Form::new()
        .text("sender", "alice")
        .text("receiver", "channel")
        .part(
            "file",
            reqwest::multipart::Part::bytes(archive.clone())
                .file_name("msg.zali")
                .mime_str("application/octet-stream")
                .unwrap(),
        );
    let resp = app
        .http
        .post(app.url(&format!(
            "/api/servers/{}/channels/{}/messages",
            server_id, channel_id
        )))
        .header("Authorization", alice.auth_header())
        .multipart(form)
        .send()
        .await
        .expect("channel upload");
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    let message_id = body["id"].as_str().unwrap().to_string();

    let scope = format!("server:{}:{}", server_id, channel_id);
    let chain_value = chain(&app, &alice, &scope).await;
    assert_eq!(labels(&chain_value), vec!["1.0"]);
    assert_eq!(
        entry_by_label(&chain_value, "1.0")["payloadSha256"],
        serde_json::json!(sha256_hex(&archive))
    );

    assert_eq!(delete(&app, &alice, &message_id).await.status(), 204);
    let after = chain(&app, &alice, &scope).await;
    assert_eq!(labels(&after), vec!["1.0", "1.1"]);
    assert_eq!(events(&after), vec!["create", "delete"]);
    assert_eq!(after["verified"], serde_json::json!(true));

    // A DM chain for the same people is untouched by channel traffic.
    let dm = chain(&app, &alice, "dm:alice:alice").await;
    assert_eq!(dm["entries"], serde_json::json!([]));
}

#[tokio::test]
async fn an_outsider_cannot_read_a_private_channels_chain() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let mallory = register_user(&app, "mallory", "hunter22").await;

    let (server_id, channel_id) =
        create_server_and_channel(&app, &alice, "Private", false).await;

    let resp = app
        .http
        .get(app.url("/api/conversations/hash-chain"))
        .query(&[("scope", format!("server:{}:{}", server_id, channel_id))])
        .header("Authorization", mallory.auth_header())
        .send()
        .await
        .expect("chain request");
    assert_eq!(resp.status(), 403);
}

// ============================================================
// TAMPER DETECTION — against the real stored rows
// ============================================================

/// Opens the running instance's own sqlite file, so a test can change the log
/// behind the server's back the way an intruder with disk access would.
async fn open_db(app: &TestApp) -> sqlx::SqlitePool {
    sqlx::SqlitePool::connect(&format!(
        "sqlite://{}?mode=rw",
        app.data_dir.join("zali_messenger.db").display()
    ))
    .await
    .expect("open test db")
}

async fn verify(app: &TestApp, user: &RegisteredUser, scope: &str) -> serde_json::Value {
    app.http
        .get(app.url("/api/conversations/hash-chain/verify"))
        .query(&[("scope", scope)])
        .header("Authorization", user.auth_header())
        .send()
        .await
        .expect("verify request")
        .json()
        .await
        .expect("verify json")
}

async fn seed_three(app: &TestApp, alice: &RegisteredUser) {
    for n in 0..3 {
        send_dm(
            app,
            alice,
            "bob",
            &message_archive("alice", &format!("msg {}", n), "conv-key", vec![]),
        )
        .await;
    }
}

#[tokio::test]
async fn rewriting_a_stored_entry_is_detected() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    seed_three(&app, &alice).await;
    assert_eq!(
        verify(&app, &alice, "dm:alice:bob").await["ok"],
        serde_json::json!(true)
    );

    // Someone edits the log to blame a different sender, leaving the linkage
    // untouched. Only the recomputed digest catches this.
    let db = open_db(&app).await;
    sqlx::query(
        "UPDATE message_hash_chain SET actor = 'mallory'
         WHERE conversation_scope = ? AND position = 1",
    )
    .bind("dm:alice:bob")
    .execute(&db)
    .await
    .expect("tamper");

    let result = verify(&app, &alice, "dm:alice:bob").await;
    assert_eq!(result["ok"], serde_json::json!(false));
    assert_eq!(result["brokenAt"], serde_json::json!(1));
}

#[tokio::test]
async fn swapping_a_stored_payload_hash_is_detected() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    seed_three(&app, &alice).await;

    // Substituting one message's archive for another's is the attack the
    // payload hash exists to stop.
    let db = open_db(&app).await;
    sqlx::query(
        "UPDATE message_hash_chain
         SET payload_sha256 = (SELECT payload_sha256 FROM message_hash_chain
                               WHERE conversation_scope = ? AND position = 2)
         WHERE conversation_scope = ? AND position = 0",
    )
    .bind("dm:alice:bob")
    .bind("dm:alice:bob")
    .execute(&db)
    .await
    .expect("tamper");

    let result = verify(&app, &alice, "dm:alice:bob").await;
    assert_eq!(result["ok"], serde_json::json!(false));
    assert_eq!(result["brokenAt"], serde_json::json!(0));
}

#[tokio::test]
async fn removing_a_stored_entry_is_detected() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    seed_three(&app, &alice).await;

    let db = open_db(&app).await;
    sqlx::query("DELETE FROM message_hash_chain WHERE conversation_scope = ? AND position = 1")
        .bind("dm:alice:bob")
        .execute(&db)
        .await
        .expect("tamper");

    let result = verify(&app, &alice, "dm:alice:bob").await;
    assert_eq!(result["ok"], serde_json::json!(false));
    // Reported at the entry that no longer follows anything, i.e. the gap.
    assert_eq!(result["brokenAt"], serde_json::json!(2));
    assert_eq!(result["entries"], serde_json::json!(2));
}

#[tokio::test]
async fn renumbering_a_stored_entry_is_detected() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    seed_three(&app, &alice).await;

    // Passing off message 3 as an edit of message 1 would rewrite who said
    // what, in what order.
    let db = open_db(&app).await;
    sqlx::query(
        "UPDATE message_hash_chain SET label = '1.1', message_number = 1, version = 1
         WHERE conversation_scope = ? AND position = 2",
    )
    .bind("dm:alice:bob")
    .execute(&db)
    .await
    .expect("tamper");

    let result = verify(&app, &alice, "dm:alice:bob").await;
    assert_eq!(result["ok"], serde_json::json!(false));
    assert_eq!(result["brokenAt"], serde_json::json!(2));
}

#[tokio::test]
async fn a_tampered_chain_is_flagged_inside_the_zali_export_too() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;
    seed_three(&app, &alice).await;

    let db = open_db(&app).await;
    sqlx::query(
        "UPDATE message_hash_chain SET actor = 'mallory'
         WHERE conversation_scope = ? AND position = 0",
    )
    .bind("dm:alice:bob")
    .execute(&db)
    .await
    .expect("tamper");

    // The export must carry the bad news, not quietly re-sign the tampered
    // rows as if they were fine.
    let export = download_export(&app, &alice, "dm:alice:bob").await;
    let session = ZaliSession::new(Some(app.hash_chain_key.as_str()), Some(CHAIN_MAGIC));
    let files = session.extract_all_bytes(&export).expect("extract");
    let index: serde_json::Value = serde_json::from_slice(
        &files
            .iter()
            .find(|(name, _)| name == "index.json")
            .unwrap()
            .1,
    )
    .unwrap();
    assert_eq!(index["verified"], serde_json::json!(false));
}

#[tokio::test]
async fn a_message_that_predates_the_chain_is_backfilled_when_deleted() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    register_user(&app, "bob", "hunter22").await;

    let archive = message_archive("alice", "старое сообщение", "conv-key", vec![]);
    let message_id = send_dm(&app, &alice, "bob", &archive).await;

    // Wipe the chain to reproduce a message sent before this feature shipped.
    let db = open_db(&app).await;
    sqlx::query("DELETE FROM message_hash_chain")
        .execute(&db)
        .await
        .expect("clear chain");
    assert!(chain(&app, &alice, "dm:alice:bob").await["entries"]
        .as_array()
        .unwrap()
        .is_empty());

    assert_eq!(delete(&app, &alice, &message_id).await.status(), 204);

    // The deletion must not produce a lone "1.1" with no original ahead of it —
    // version 0 is back-filled from the archive that was still on disk.
    let chain = chain(&app, &alice, "dm:alice:bob").await;
    assert_eq!(labels(&chain), vec!["1.0", "1.1"]);
    assert_eq!(events(&chain), vec!["create", "delete"]);
    assert_eq!(chain["verified"], serde_json::json!(true));
    assert_eq!(
        entry_by_label(&chain, "1.0")["payloadSha256"],
        serde_json::json!(sha256_hex(&archive))
    );
}

#[tokio::test]
async fn concurrent_sends_produce_a_gapless_chain_with_unique_labels() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;
    let bob = register_user(&app, "bob", "hunter22").await;

    // Both directions at once: `position` and `message_number` are both
    // read-then-write allocations, so without BEGIN IMMEDIATE two senders can
    // read the same head and collide.
    let mut tasks = Vec::new();
    for n in 0..12 {
        let app = &app;
        let (from, to) = if n % 2 == 0 {
            (&alice, "bob")
        } else {
            (&bob, "alice")
        };
        tasks.push(async move {
            let archive = message_archive(
                &from.username,
                &format!("parallel {}", n),
                "conv-key",
                vec![],
            );
            send_dm(app, from, to, &archive).await
        });
    }
    let ids = futures_util::future::join_all(tasks).await;
    assert_eq!(ids.len(), 12);

    let chain_value = chain(&app, &alice, "dm:alice:bob").await;
    let entries = chain_value["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 12, "an append was lost under concurrency");

    let mut seen_labels: Vec<String> = labels(&chain_value);
    seen_labels.sort();
    seen_labels.dedup();
    assert_eq!(seen_labels.len(), 12, "duplicate label under concurrency");

    let mut numbers: Vec<i64> = entries
        .iter()
        .map(|e| e["messageNumber"].as_i64().unwrap())
        .collect();
    numbers.sort();
    assert_eq!(numbers, (1..=12).collect::<Vec<_>>());

    assert_eq!(chain_value["verified"], serde_json::json!(true));
    assert_eq!(
        verify(&app, &alice, "dm:alice:bob").await["ok"],
        serde_json::json!(true)
    );
}

#[tokio::test]
async fn a_malformed_scope_is_refused_rather_than_treated_as_a_new_conversation() {
    let app = spawn_app().await;
    let alice = register_user(&app, "alice", "hunter22").await;

    for scope in ["", "garbage", "dm:alice", "dm:alice:bob:extra", "server:only"] {
        let resp = app
            .http
            .get(app.url("/api/conversations/hash-chain"))
            .query(&[("scope", scope)])
            .header("Authorization", alice.auth_header())
            .send()
            .await
            .expect("chain request");
        assert!(
            resp.status() == 400 || resp.status() == 403,
            "scope {:?} returned {}",
            scope,
            resp.status()
        );
    }
}
