//! Per-conversation, append-only hash chain over the *encrypted* message
//! archives.
//!
//! ## What problem this solves
//!
//! Until now the server kept exactly one fact about a message: the `.zali`
//! blob that happens to be on disk *right now*. Editing a message overwrote
//! that blob and deleting one removed both the row and the file, so afterwards
//! nothing in the system could answer "was there a message here, and did its
//! contents change?" — not even to the participants, who are the people with
//! the strongest claim to that answer.
//!
//! This module records one entry per *event* (`create` / `edit` / `delete`)
//! and links the entries with SHA-256 so that removing, reordering or
//! back-dating any of them breaks every hash after it. Because the entries
//! hold only the hash of the ciphertext — never the plaintext, never the key —
//! the server learns nothing new about what people said. It only becomes able
//! to prove *that* something was said, and that a given archive is the one it
//! logged.
//!
//! ## Numbering
//!
//! Every entry carries a label `"<message number>.<version>"`:
//!
//! * *message number* — the message's 1-based position within its
//!   conversation, allocated once when the message is first seen and never
//!   reused, even after the message is deleted.
//! * *version* — `0` is the original, `1` the first edit, `2` the second, and
//!   so on. A deletion also consumes a version, so a message created, edited
//!   once and then deleted leaves `7.0`, `7.1`, `7.2` behind.
//!
//! ## The `.zali` export
//!
//! The chain is *stored* in sqlite (append-only, O(1) per event) and
//! *exported* as an encrypted `.zali` archive under `<data_dir>/hash_chains/`.
//! The export is rebuilt from the table on every download rather than rewritten
//! on every message: an archive is a monolithic blob, so keeping it eagerly in
//! sync would mean re-encrypting the entire chain once per sent message —
//! quadratic work over a conversation's lifetime, paid on the hot send path.
//! Rebuilding at download time costs the same total work only when someone
//! actually looks, and can never serve a file that lags the table.

use crate::{
    can_access_channel, dm_conversation_scope, get_server_access_context, hex_encode,
    server_conversation_scope, AppState, AuthenticatedUser, Message,
};
use axum::{
    body::Body,
    extract::Query,
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{error, info, warn};
use zali_sdk::ZaliSession;

/// Magic marker of a chain archive. Deliberately different from the message
/// archives' `ZALIMSSG`: the SDK rejects a mismatched marker outright, so a
/// chain export can never be mistaken for (or fed to) the message unpacker.
const CHAIN_MAGIC: &[u8; 8] = b"ZALIHASH";

/// Domain separator mixed into every entry hash, so an entry digest can never
/// collide with a hash computed for some other purpose over the same fields.
const CHAIN_DOMAIN: &[u8] = b"zali.hashchain.v1";

/// `prev_hash` of the first entry in a conversation: 32 zero bytes.
pub(crate) const GENESIS_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

/// SHA-256 of an empty byte string — the payload hash used when an event has
/// no archive of its own to point at (a delete of a message whose file was
/// already gone).
const EMPTY_PAYLOAD_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChainEvent {
    Create,
    Edit,
    Delete,
}

impl ChainEvent {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ChainEvent::Create => "create",
            ChainEvent::Edit => "edit",
            ChainEvent::Delete => "delete",
        }
    }
}

/// One link of the chain, exactly as stored and exported.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, PartialEq, Eq)]
pub(crate) struct ChainEntry {
    /// 0-based index inside this conversation's chain.
    pub(crate) position: i64,
    /// 1-based ordinal of the message within the conversation.
    #[serde(rename = "messageNumber")]
    pub(crate) message_number: i64,
    /// 0 = original, 1.. = each subsequent revision (edit or delete).
    pub(crate) version: i64,
    /// `"<message_number>.<version>"` — the requested chain key.
    pub(crate) label: String,
    #[serde(rename = "messageId")]
    pub(crate) message_id: String,
    pub(crate) event: String,
    pub(crate) actor: String,
    /// SHA-256 (hex) of the encrypted `.zali` archive this event produced.
    #[serde(rename = "payloadSha256")]
    pub(crate) payload_sha256: String,
    #[serde(rename = "payloadSize")]
    pub(crate) payload_size: i64,
    #[serde(rename = "prevHash")]
    pub(crate) prev_hash: String,
    #[serde(rename = "entryHash")]
    pub(crate) entry_hash: String,
    /// Canonical RFC3339 string, stored as TEXT so the bytes that were hashed
    /// are the exact bytes that come back out — sqlite's DATETIME affinity
    /// would be free to reformat them.
    #[serde(rename = "createdAt")]
    pub(crate) created_at: String,
}

/// Streaming SHA-256 of the archive bytes as they are written to disk, so the
/// upload path never has to read the file back to learn its digest.
pub(crate) struct PayloadDigest {
    hasher: Sha256,
    len: u64,
}

impl PayloadDigest {
    pub(crate) fn new() -> Self {
        Self {
            hasher: Sha256::new(),
            len: 0,
        }
    }

    pub(crate) fn update(&mut self, chunk: &[u8]) {
        self.hasher.update(chunk);
        self.len = self.len.saturating_add(chunk.len() as u64);
    }

    pub(crate) fn finish(self) -> (String, i64) {
        (
            hex_encode(&self.hasher.finalize()),
            i64::try_from(self.len).unwrap_or(i64::MAX),
        )
    }
}

/// The chain a message belongs to. Matches the scope strings already used for
/// history tickets and the conversation-key registry, so an operator reading
/// several tables sees one identifier for one conversation.
pub(crate) fn conversation_scope_for(message: &Message) -> String {
    if let Some(server_id) = message.server_id.as_deref() {
        server_conversation_scope(server_id, message.channel_id.as_deref().unwrap_or(""))
    } else {
        dm_conversation_scope(&message.sender, &message.receiver)
    }
}

fn now_canonical() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

fn unhex32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(value.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Canonical digest of one entry — everything on it except `entry_hash`
/// itself, plus the scope the chain belongs to.
///
/// Every variable-length field is length-prefixed before it is fed to SHA-256.
/// Plain concatenation would let two different entries hash identically —
/// `actor="ab", message_id="c"` and `actor="a", message_id="bc"` produce the
/// same byte stream — which is exactly the kind of ambiguity a tamper-evident
/// log must not have.
///
/// Takes the entry rather than ten loose arguments on purpose: as positional
/// `&str`s, two of them could be swapped at the append site *and* at the verify
/// site, and the chain would keep verifying against its own mistake.
pub(crate) fn compute_entry_hash(conversation_scope: &str, entry: &ChainEntry) -> String {
    let mut hasher = Sha256::new();
    let mut field = |bytes: &[u8]| {
        hasher.update((bytes.len() as u32).to_be_bytes());
        hasher.update(bytes);
    };

    field(CHAIN_DOMAIN);
    // Hash the raw 32 bytes, not the hex text: a malformed hex string would
    // otherwise still "hash fine" and hide the corruption one link further on.
    field(&unhex32(&entry.prev_hash).unwrap_or([0u8; 32]));
    field(conversation_scope.as_bytes());
    field(&entry.position.to_be_bytes());
    field(entry.label.as_bytes());
    field(entry.message_id.as_bytes());
    field(entry.event.as_bytes());
    field(entry.actor.as_bytes());
    field(&unhex32(&entry.payload_sha256).unwrap_or([0u8; 32]));
    field(&entry.payload_size.to_be_bytes());
    field(entry.created_at.as_bytes());

    hex_encode(&hasher.finalize())
}

// ============================================================
// WRITE PATH
// ============================================================

/// Appends one entry inside an already-open `BEGIN IMMEDIATE` transaction.
///
/// `message_number`/`version` are resolved here rather than by the caller so
/// that the read that picks the next number and the insert that consumes it
/// cannot be split by a concurrent sender.
async fn append_entry(
    conn: &mut sqlx::SqliteConnection,
    conversation_scope: &str,
    message_id: &str,
    event: ChainEvent,
    actor: &str,
    payload_sha256: &str,
    payload_size: i64,
) -> Result<ChainEntry, sqlx::Error> {
    let head: Option<(i64, String)> = sqlx::query_as(
        "SELECT position, entry_hash FROM message_hash_chain
         WHERE conversation_scope = ?
         ORDER BY position DESC LIMIT 1",
    )
    .bind(conversation_scope)
    .fetch_optional(&mut *conn)
    .await?;

    let (position, prev_hash) = match head {
        Some((pos, hash)) => (pos + 1, hash),
        None => (0, GENESIS_HASH.to_string()),
    };

    // A message already in the chain keeps its number forever; a new one takes
    // the next free number in this conversation.
    let existing: Option<(i64, i64)> = sqlx::query_as(
        "SELECT message_number, MAX(version) FROM message_hash_chain
         WHERE conversation_scope = ? AND message_id = ?
         GROUP BY message_number",
    )
    .bind(conversation_scope)
    .bind(message_id)
    .fetch_optional(&mut *conn)
    .await?;

    let (message_number, version) = match existing {
        Some((number, max_version)) => (number, max_version + 1),
        None => {
            let next: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(message_number), 0) + 1 FROM message_hash_chain
                 WHERE conversation_scope = ?",
            )
            .bind(conversation_scope)
            .fetch_one(&mut *conn)
            .await?;
            (next, 0)
        }
    };

    let mut entry = ChainEntry {
        position,
        message_number,
        version,
        label: format!("{}.{}", message_number, version),
        message_id: message_id.to_string(),
        event: event.as_str().to_string(),
        actor: actor.to_string(),
        payload_sha256: payload_sha256.to_string(),
        payload_size,
        prev_hash,
        entry_hash: String::new(),
        created_at: now_canonical(),
    };
    entry.entry_hash = compute_entry_hash(conversation_scope, &entry);

    sqlx::query(
        "INSERT INTO message_hash_chain
            (conversation_scope, position, message_number, version, label, message_id,
             event, actor, payload_sha256, payload_size, prev_hash, entry_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(conversation_scope)
    .bind(entry.position)
    .bind(entry.message_number)
    .bind(entry.version)
    .bind(&entry.label)
    .bind(&entry.message_id)
    .bind(&entry.event)
    .bind(&entry.actor)
    .bind(&entry.payload_sha256)
    .bind(entry.payload_size)
    .bind(&entry.prev_hash)
    .bind(&entry.entry_hash)
    .bind(&entry.created_at)
    .execute(&mut *conn)
    .await?;

    Ok(entry)
}

/// Records one message event.
///
/// `BEGIN IMMEDIATE` is taken before the first read: `position` and
/// `message_number` are both read-then-write allocations, and sqlite's default
/// deferred transaction would happily let two concurrent senders read the same
/// head and then collide on the unique index.
///
/// An `Edit`/`Delete` for a message the chain has never seen (one sent before
/// this feature existed) back-fills a `create` entry first, so version 0 always
/// exists and `N.1` never appears without an `N.0` ahead of it.
///
/// The whole transaction runs in its own task. A handler future is dropped the
/// moment the HTTP client disconnects, and a drop landing between
/// `BEGIN IMMEDIATE` and `COMMIT` would return a connection to the pool still
/// holding sqlite's write lock — after which every message in every
/// conversation blocks behind it until that connection is recycled. Spawning
/// makes the transaction outlive the request that started it, so it always
/// reaches a commit or a rollback.
pub(crate) async fn record_message_event(
    state: &Arc<AppState>,
    conversation_scope: &str,
    message_id: &str,
    event: ChainEvent,
    actor: &str,
    payload_sha256: &str,
    payload_size: i64,
) -> Result<ChainEntry, sqlx::Error> {
    let state = Arc::clone(state);
    let conversation_scope = conversation_scope.to_string();
    let message_id = message_id.to_string();
    let actor = actor.to_string();
    let payload_sha256 = payload_sha256.to_string();

    tokio::spawn(async move {
        append_transaction(
            &state,
            &conversation_scope,
            &message_id,
            event,
            &actor,
            &payload_sha256,
            payload_size,
        )
        .await
    })
    .await
    .unwrap_or_else(|e| {
        Err(sqlx::Error::Protocol(format!(
            "задача записи hash chain не завершилась: {}",
            e
        )))
    })
}

async fn append_transaction(
    state: &Arc<AppState>,
    conversation_scope: &str,
    message_id: &str,
    event: ChainEvent,
    actor: &str,
    payload_sha256: &str,
    payload_size: i64,
) -> Result<ChainEntry, sqlx::Error> {
    let mut conn = state.db.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let result = async {
        if event != ChainEvent::Create {
            let seen: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM message_hash_chain
                 WHERE conversation_scope = ? AND message_id = ? LIMIT 1",
            )
            .bind(conversation_scope)
            .bind(message_id)
            .fetch_optional(&mut *conn)
            .await?;
            if seen.is_none() {
                warn!(
                    "HASH_CHAIN backfilling create entry for untracked message id={} scope={}",
                    message_id, conversation_scope
                );
                append_entry(
                    &mut conn,
                    conversation_scope,
                    message_id,
                    ChainEvent::Create,
                    actor,
                    payload_sha256,
                    payload_size,
                )
                .await?;
            }
        }

        append_entry(
            &mut conn,
            conversation_scope,
            message_id,
            event,
            actor,
            payload_sha256,
            payload_size,
        )
        .await
    }
    .await;

    match result {
        Ok(entry) => {
            if let Err(e) = sqlx::query("COMMIT").execute(&mut *conn).await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(e);
            }
            info!(
                "HASH_CHAIN appended scope={} label={} event={} message_id={} hash={}",
                conversation_scope, entry.label, entry.event, entry.message_id, entry.entry_hash
            );
            Ok(entry)
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(e)
        }
    }
}

/// Fire-and-log wrapper for the message handlers.
///
/// A failure to journal must never fail the send/edit/delete itself — a
/// messenger that refuses to deliver mail because its audit log hiccuped is
/// strictly worse than one with a gap in the log. The gap is loud in the logs
/// instead, and `verify_chain` still reports the chain it does have as intact.
pub(crate) async fn record_message_event_best_effort(
    state: &Arc<AppState>,
    conversation_scope: &str,
    message_id: &str,
    event: ChainEvent,
    actor: &str,
    payload_sha256: &str,
    payload_size: i64,
) {
    if let Err(e) = record_message_event(
        state,
        conversation_scope,
        message_id,
        event,
        actor,
        payload_sha256,
        payload_size,
    )
    .await
    {
        error!(
            "HASH_CHAIN append failed scope={} message_id={} event={}: {}",
            conversation_scope,
            message_id,
            event.as_str(),
            e
        );
    }
}

/// The payload hash the chain last recorded for a message — what a deletion
/// points at, so the entry still says *which* archive was removed.
pub(crate) async fn last_payload_for_message(
    state: &Arc<AppState>,
    conversation_scope: &str,
    message_id: &str,
) -> (String, i64) {
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT payload_sha256, payload_size FROM message_hash_chain
         WHERE conversation_scope = ? AND message_id = ?
         ORDER BY version DESC LIMIT 1",
    )
    .bind(conversation_scope)
    .bind(message_id)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);

    row.unwrap_or_else(|| (EMPTY_PAYLOAD_HASH.to_string(), 0))
}

/// Hashes an archive already on disk. Used when a message predates the chain
/// and is being edited or deleted, so its back-filled `create` entry points at
/// real content instead of a placeholder.
pub(crate) async fn hash_archive_on_disk(path: &std::path::Path) -> Option<(String, i64)> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut hasher = Sha256::new();
    let mut len: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf).await.ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        len = len.saturating_add(read as u64);
    }
    Some((
        hex_encode(&hasher.finalize()),
        i64::try_from(len).unwrap_or(i64::MAX),
    ))
}

// ============================================================
// READ / VERIFY
// ============================================================

pub(crate) async fn load_chain(
    state: &Arc<AppState>,
    conversation_scope: &str,
) -> Result<Vec<ChainEntry>, sqlx::Error> {
    sqlx::query_as::<_, ChainEntry>(
        "SELECT position, message_number, version, label, message_id, event, actor,
                payload_sha256, payload_size, prev_hash, entry_hash, created_at
         FROM message_hash_chain
         WHERE conversation_scope = ?
         ORDER BY position ASC",
    )
    .bind(conversation_scope)
    .fetch_all(&state.db)
    .await
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct ChainVerification {
    pub(crate) ok: bool,
    pub(crate) entries: usize,
    #[serde(rename = "headHash")]
    pub(crate) head_hash: String,
    /// Position of the first entry that failed, when `ok` is false.
    #[serde(rename = "brokenAt", skip_serializing_if = "Option::is_none")]
    pub(crate) broken_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

/// Recomputes the whole chain and reports the first link that does not hold.
///
/// Checks four separate things, because each catches a different tampering:
/// the recomputed digest (contents changed), the `prev_hash` link (an entry
/// removed or reordered), `position` continuity (an entry dropped from the
/// middle, which the link check alone would report one entry late), and the
/// label (a renumbered message).
///
/// `conversation_scope` is an input rather than a field of `ChainEntry`: it is
/// identical for every row and hashing it in means a chain lifted wholesale
/// into another conversation's export stops verifying.
pub(crate) fn verify_chain(
    conversation_scope: &str,
    entries: &[ChainEntry],
) -> ChainVerification {
    let mut expected_prev = GENESIS_HASH.to_string();

    for (index, entry) in entries.iter().enumerate() {
        let broken = |reason: &str| ChainVerification {
            ok: false,
            entries: entries.len(),
            head_hash: expected_prev.clone(),
            broken_at: Some(entry.position),
            reason: Some(reason.to_string()),
        };

        if entry.position != index as i64 {
            return broken("position is not contiguous");
        }
        if entry.prev_hash != expected_prev {
            return broken("prev_hash does not match the preceding entry");
        }
        if entry.label != format!("{}.{}", entry.message_number, entry.version) {
            return broken("label does not match message_number.version");
        }

        if compute_entry_hash(conversation_scope, entry) != entry.entry_hash {
            return broken("entry_hash does not match the entry contents");
        }

        expected_prev = entry.entry_hash.clone();
    }

    ChainVerification {
        ok: true,
        entries: entries.len(),
        head_hash: expected_prev,
        broken_at: None,
        reason: None,
    }
}

// ============================================================
// .zali EXPORT
// ============================================================

/// The chain document that goes inside the archive.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ChainDocument {
    pub(crate) version: u8,
    #[serde(rename = "conversationScope")]
    pub(crate) conversation_scope: String,
    #[serde(rename = "generatedAt")]
    pub(crate) generated_at: String,
    #[serde(rename = "genesisHash")]
    pub(crate) genesis_hash: String,
    #[serde(rename = "headHash")]
    pub(crate) head_hash: String,
    pub(crate) entries: Vec<ChainEntry>,
}

fn chain_export_filename(conversation_scope: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(conversation_scope.as_bytes());
    // The scope contains usernames and channel ids; hashing it keeps them out
    // of the filesystem *and* guarantees the name is path-safe with no
    // sanitiser to get wrong.
    format!("{}.zali", hex_encode(&hasher.finalize()))
}

pub(crate) fn chain_export_path(state: &Arc<AppState>, conversation_scope: &str) -> PathBuf {
    state
        .data_dir
        .join("hash_chains")
        .join(chain_export_filename(conversation_scope))
}

/// Builds the encrypted archive bytes for a chain.
///
/// Two members, because they answer two different questions:
/// * `chain.json` — the full ordered log, everything needed to re-verify.
/// * `index.json` — the flat `"<message number>.<version>" -> hash` map the
///   chain is meant to be read as, without walking the array.
pub(crate) fn build_chain_archive(
    conversation_scope: &str,
    entries: &[ChainEntry],
    key: &str,
) -> Result<Vec<u8>, String> {
    let verification = verify_chain(conversation_scope, entries);
    let document = ChainDocument {
        version: 1,
        conversation_scope: conversation_scope.to_string(),
        generated_at: now_canonical(),
        genesis_hash: GENESIS_HASH.to_string(),
        head_hash: verification.head_hash.clone(),
        entries: entries.to_vec(),
    };

    let chain_json = serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?;

    let mut index = serde_json::Map::new();
    for entry in entries {
        index.insert(
            entry.label.clone(),
            serde_json::json!({
                "entryHash": entry.entry_hash,
                "payloadSha256": entry.payload_sha256,
                "payloadSize": entry.payload_size,
                "event": entry.event,
                "messageId": entry.message_id,
                "position": entry.position,
                "createdAt": entry.created_at,
            }),
        );
    }
    let index_json = serde_json::to_vec_pretty(&serde_json::json!({
        "conversationScope": conversation_scope,
        "headHash": verification.head_hash,
        "verified": verification.ok,
        "hashes": index,
    }))
    .map_err(|e| e.to_string())?;

    let session = ZaliSession::new(Some(key), Some(CHAIN_MAGIC));
    session
        .create_archive_bytes(vec![
            ("chain.json".to_string(), chain_json),
            ("index.json".to_string(), index_json),
        ])
        .map_err(|e| e.to_string())
}

/// Rebuilds the on-disk `.zali` export from the table and returns its path.
pub(crate) async fn write_chain_export(
    state: &Arc<AppState>,
    conversation_scope: &str,
) -> Result<PathBuf, String> {
    let entries = load_chain(state, conversation_scope)
        .await
        .map_err(|e| e.to_string())?;
    let bytes = build_chain_archive(conversation_scope, &entries, &state.config.hash_chain_key)?;

    let path = chain_export_path(state, conversation_scope);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    // Write-then-rename: a reader that catches the directory mid-write would
    // otherwise get a truncated archive, which decrypts to nothing at all.
    let temp = path.with_extension("zali.tmp");
    tokio::fs::write(&temp, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&temp, &path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(path)
}

// ============================================================
// HTTP
// ============================================================

#[derive(Debug, Deserialize)]
pub(crate) struct ChainQuery {
    pub(crate) scope: String,
}

/// Who may read a conversation's chain: the two sides of a DM, or anyone who
/// can view the channel. Deliberately the same bar as reading the messages
/// themselves — the chain reveals message *counts and timings*, which is not
/// something to hand to a non-participant.
async fn can_view_chain(state: &Arc<AppState>, scope: &str, user: &str) -> bool {
    let parts: Vec<&str> = scope.split(':').collect();
    match parts.as_slice() {
        ["dm", a, b] => *a == user || *b == user,
        ["server", server_id, channel_id] => {
            match get_server_access_context(&state.db, server_id, user).await {
                Ok(Some((server, _role))) => {
                    server.owner == user
                        || can_access_channel(&state.db, server_id, channel_id, user, "view")
                            .await
                            .unwrap_or(false)
                }
                _ => false,
            }
        }
        _ => false,
    }
}

async fn authorize(
    state: &Arc<AppState>,
    scope: &str,
    user: &str,
) -> Result<(), (StatusCode, &'static str)> {
    if scope.trim().is_empty() || scope.len() > 512 {
        return Err((StatusCode::BAD_REQUEST, "Некорректный scope"));
    }
    if !can_view_chain(state, scope, user).await {
        warn!("HASH_CHAIN forbidden scope={} user={}", scope, user);
        return Err((StatusCode::FORBIDDEN, "Нет доступа к этой переписке"));
    }
    Ok(())
}

/// `GET /api/conversations/hash-chain?scope=…` — the chain as JSON, with its
/// verification result attached so a caller never has to trust it blindly.
pub(crate) async fn get_conversation_hash_chain(
    Query(query): Query<ChainQuery>,
    AuthenticatedUser(user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> Response {
    if let Err((status, message)) = authorize(&state, &query.scope, &user).await {
        return (status, message).into_response();
    }

    match load_chain(&state, &query.scope).await {
        Ok(entries) => {
            let verification = verify_chain(&query.scope, &entries);
            Json(serde_json::json!({
                "conversationScope": query.scope,
                "genesisHash": GENESIS_HASH,
                "headHash": verification.head_hash,
                "verified": verification.ok,
                "entries": entries,
            }))
            .into_response()
        }
        Err(e) => {
            error!("HASH_CHAIN load failed scope={}: {}", query.scope, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `GET /api/conversations/hash-chain/verify?scope=…`
pub(crate) async fn verify_conversation_hash_chain(
    Query(query): Query<ChainQuery>,
    AuthenticatedUser(user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> Response {
    if let Err((status, message)) = authorize(&state, &query.scope, &user).await {
        return (status, message).into_response();
    }

    match load_chain(&state, &query.scope).await {
        Ok(entries) => Json(verify_chain(&query.scope, &entries)).into_response(),
        Err(e) => {
            error!("HASH_CHAIN verify failed scope={}: {}", query.scope, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `GET /api/conversations/hash-chain.zali?scope=…` — the encrypted archive.
pub(crate) async fn download_conversation_hash_chain(
    Query(query): Query<ChainQuery>,
    AuthenticatedUser(user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> Response {
    if let Err((status, message)) = authorize(&state, &query.scope, &user).await {
        return (status, message).into_response();
    }

    let path = match write_chain_export(&state, &query.scope).await {
        Ok(path) => path,
        Err(e) => {
            error!("HASH_CHAIN export failed scope={}: {}", query.scope, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            [
                (
                    axum::http::header::CONTENT_TYPE,
                    HeaderValue::from_static("application/octet-stream"),
                ),
                (
                    axum::http::header::CONTENT_DISPOSITION,
                    HeaderValue::from_static("attachment; filename=\"hash-chain.zali\""),
                ),
            ],
            Body::from(bytes),
        )
            .into_response(),
        Err(e) => {
            error!("HASH_CHAIN export read failed {}: {}", path.display(), e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal entry with its digest already computed — the shape
    /// `append_entry` produces.
    fn make(scope: &str, prev: &str, mutate: impl FnOnce(&mut ChainEntry)) -> ChainEntry {
        let mut entry = ChainEntry {
            position: 0,
            message_number: 1,
            version: 0,
            label: "1.0".to_string(),
            message_id: "msg-1".to_string(),
            event: "create".to_string(),
            actor: "alice".to_string(),
            payload_sha256: EMPTY_PAYLOAD_HASH.to_string(),
            payload_size: 7,
            prev_hash: prev.to_string(),
            entry_hash: String::new(),
            created_at: "2026-08-12T10:00:00.000000Z".to_string(),
        };
        mutate(&mut entry);
        entry.label = format!("{}.{}", entry.message_number, entry.version);
        entry.entry_hash = compute_entry_hash(scope, &entry);
        entry
    }

    fn entry(position: i64, number: i64, version: i64, prev: &str, scope: &str) -> ChainEntry {
        make(scope, prev, |entry| {
            entry.position = position;
            entry.message_number = number;
            entry.version = version;
            entry.payload_sha256 =
                hex_encode(&Sha256::digest(format!("payload-{}.{}", number, version).as_bytes()));
            entry.payload_size = 10;
            entry.created_at = format!("2026-08-12T10:00:{:02}.000000Z", position);
        })
    }

    #[test]
    fn entry_hash_is_unambiguous_across_field_boundaries() {
        // Without length prefixes these two would hash identically: "ab"+"c"
        // and "a"+"bc" concatenate to the same byte stream.
        let a = make("dm:a:b", GENESIS_HASH, |e| {
            e.message_id = "ab".to_string();
            e.actor = "c".to_string();
        });
        let b = make("dm:a:b", GENESIS_HASH, |e| {
            e.message_id = "a".to_string();
            e.actor = "bc".to_string();
        });
        assert_ne!(a.entry_hash, b.entry_hash);
    }

    #[test]
    fn entry_hash_changes_with_every_field() {
        let base = make("dm:a:b", GENESIS_HASH, |_| {}).entry_hash;
        let variants = [
            // scope
            make("dm:a:c", GENESIS_HASH, |_| {}).entry_hash,
            // prev_hash
            make("dm:a:b", &"1".repeat(64), |_| {}).entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| e.position = 1).entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| e.version = 1).entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| e.message_number = 2).entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| e.message_id = "other".into()).entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| e.event = "edit".into()).entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| e.actor = "mallory".into()).entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| {
                e.payload_sha256 = hex_encode(&Sha256::digest(b"other"))
            })
            .entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| e.payload_size = 8).entry_hash,
            make("dm:a:b", GENESIS_HASH, |e| {
                e.created_at = "2026-08-12T10:00:01.000000Z".into()
            })
            .entry_hash,
        ];
        for (index, variant) in variants.iter().enumerate() {
            assert_ne!(&base, variant, "variant {} did not change the digest", index);
        }
        // ...and no two variants collide with each other either.
        let mut unique = variants.to_vec();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), variants.len());
    }

    #[test]
    fn intact_chain_verifies() {
        let scope = "dm:alice:bob";
        let first = entry(0, 1, 0, GENESIS_HASH, scope);
        let second = entry(1, 1, 1, &first.entry_hash, scope);
        let third = entry(2, 2, 0, &second.entry_hash, scope);
        let chain = vec![first, second, third.clone()];

        let result = verify_chain(scope, &chain);
        assert!(result.ok, "{:?}", result);
        assert_eq!(result.entries, 3);
        assert_eq!(result.head_hash, third.entry_hash);
    }

    #[test]
    fn empty_chain_verifies_with_the_genesis_head() {
        let result = verify_chain("dm:alice:bob", &[]);
        assert!(result.ok);
        assert_eq!(result.head_hash, GENESIS_HASH);
    }

    #[test]
    fn mutating_an_entry_breaks_verification_at_that_entry() {
        let scope = "dm:alice:bob";
        let first = entry(0, 1, 0, GENESIS_HASH, scope);
        let second = entry(1, 1, 1, &first.entry_hash, scope);
        let mut chain = vec![first, second];
        chain[0].actor = "mallory".to_string();

        let result = verify_chain(scope, &chain);
        assert!(!result.ok);
        assert_eq!(result.broken_at, Some(0));
    }

    #[test]
    fn removing_a_middle_entry_breaks_the_link() {
        let scope = "dm:alice:bob";
        let first = entry(0, 1, 0, GENESIS_HASH, scope);
        let second = entry(1, 1, 1, &first.entry_hash, scope);
        let third = entry(2, 2, 0, &second.entry_hash, scope);
        let chain = vec![first, third];

        let result = verify_chain(scope, &chain);
        assert!(!result.ok);
        assert_eq!(result.broken_at, Some(2));
    }

    #[test]
    fn truncating_the_tail_still_verifies_but_moves_the_head() {
        // Dropping the newest entries leaves a self-consistent prefix — the
        // chain alone cannot detect it, which is exactly why the head hash is
        // published alongside it.
        let scope = "dm:alice:bob";
        let first = entry(0, 1, 0, GENESIS_HASH, scope);
        let second = entry(1, 1, 1, &first.entry_hash, scope);
        let full = vec![first.clone(), second];
        let truncated = vec![first.clone()];

        assert!(verify_chain(scope, &full).ok);
        let short = verify_chain(scope, &truncated);
        assert!(short.ok);
        assert_eq!(short.head_hash, first.entry_hash);
        assert_ne!(short.head_hash, verify_chain(scope, &full).head_hash);
    }

    #[test]
    fn a_chain_verified_under_the_wrong_scope_fails() {
        let scope = "dm:alice:bob";
        let chain = vec![entry(0, 1, 0, GENESIS_HASH, scope)];
        assert!(verify_chain(scope, &chain).ok);
        assert!(!verify_chain("dm:alice:mallory", &chain).ok);
    }

    #[test]
    fn export_archive_round_trips_and_is_encrypted() {
        let scope = "dm:alice:bob";
        let first = entry(0, 1, 0, GENESIS_HASH, scope);
        let second = entry(1, 1, 1, &first.entry_hash, scope);
        let chain = vec![first, second.clone()];

        let bytes = build_chain_archive(scope, &chain, "chain-key").expect("archive");
        assert_eq!(&bytes[..8], CHAIN_MAGIC);
        // The labels are the whole point of the export — they must not be
        // readable without the key.
        assert!(!bytes.windows(3).any(|w| w == b"1.1"));

        let session = ZaliSession::new(Some("chain-key"), Some(CHAIN_MAGIC));
        let files = session.extract_all_bytes(&bytes).expect("extract");
        let chain_json = files
            .iter()
            .find(|(name, _)| name == "chain.json")
            .expect("chain.json");
        let document: ChainDocument = serde_json::from_slice(&chain_json.1).expect("parse");
        assert_eq!(document.conversation_scope, scope);
        assert_eq!(document.head_hash, second.entry_hash);
        assert_eq!(document.entries, chain);

        let index_json = files
            .iter()
            .find(|(name, _)| name == "index.json")
            .expect("index.json");
        let index: serde_json::Value = serde_json::from_slice(&index_json.1).expect("parse index");
        assert_eq!(index["verified"], serde_json::json!(true));
        assert_eq!(index["hashes"]["1.0"]["position"], serde_json::json!(0));
        assert_eq!(
            index["hashes"]["1.1"]["entryHash"],
            serde_json::json!(second.entry_hash)
        );
    }

    #[test]
    fn export_archive_cannot_be_opened_with_the_wrong_key() {
        let scope = "dm:alice:bob";
        let chain = vec![entry(0, 1, 0, GENESIS_HASH, scope)];
        let bytes = build_chain_archive(scope, &chain, "chain-key").expect("archive");

        let session = ZaliSession::new(Some("not-the-key"), Some(CHAIN_MAGIC));
        assert!(session.extract_all_bytes(&bytes).is_err());
    }

    #[test]
    fn export_filenames_are_path_safe_and_scope_specific() {
        let a = chain_export_filename("dm:alice:bob");
        let b = chain_export_filename("dm:alice:carol");
        assert_ne!(a, b);
        for name in [&a, &b] {
            assert!(name.ends_with(".zali"));
            assert!(name
                .trim_end_matches(".zali")
                .chars()
                .all(|c| c.is_ascii_hexdigit()));
        }
        // Scope strings are attacker-influenced only through usernames, but the
        // filename must be safe even if that ever stops being true.
        let hostile = chain_export_filename("dm:../../etc:passwd");
        assert!(!hostile.contains('/') && !hostile.contains(".."));
    }

    #[test]
    fn payload_digest_matches_a_one_shot_hash() {
        let mut digest = PayloadDigest::new();
        digest.update(b"ZALIMSSG");
        digest.update(b"\x01payload");
        let (hex, size) = digest.finish();

        let mut hasher = Sha256::new();
        hasher.update(b"ZALIMSSG\x01payload");
        assert_eq!(hex, hex_encode(&hasher.finalize()));
        assert_eq!(size, 16);
    }
}
