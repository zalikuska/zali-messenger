//! In-flight send dedup, decrypted-message LRU-ish cache, and conversation
//! key-scope candidate derivation.

use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

pub(crate) fn in_flight_send_client_ids() -> &'static Mutex<HashSet<String>> {
    static IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashSet::new()))
}

// Successfully decrypted message payloads ({sender, text, attachments}) keyed by
// message id — the Rust-shell mirror of the Swift client's decryptedMessageCache.
// Message archives are immutable once stored, so a hit is always valid. Without
// this, EVERY history refresh (open chat, key event, reconnect catch-up across all
// contacts) re-downloaded every archive and re-ran PBKDF2 (210k iterations, ~100ms
// CPU) per message; volatile fields (reactions, timestamps) are merged from the
// fresh server record on each pass, so they stay live despite the cache.
pub(crate) fn decrypted_message_cache() -> &'static Mutex<HashMap<String, Value>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) const DECRYPTED_CACHE_MAX_ENTRIES: usize = 2048;
pub(crate) const DECRYPTED_CACHE_MAX_ENTRY_BYTES: usize = 1024 * 1024;
/// Ceiling on the keys tried against one archive — see the fallback loop in
/// `candidate_message_keys`. Kept identical to the macOS shell's
/// `Coordinator.maxDecryptCandidates`.
pub(crate) const MAX_DECRYPT_CANDIDATES: usize = 12;

pub(crate) fn cache_decrypted_message(message_id: &str, entry: &Value) {
    let id = message_id.trim();
    if id.is_empty() {
        return;
    }
    // Attachments arrive as inline data URLs — skip oversized payloads so the cache
    // stays a CPU shield, not a memory sink.
    if entry.to_string().len() > DECRYPTED_CACHE_MAX_ENTRY_BYTES {
        return;
    }
    if let Ok(mut cache) = decrypted_message_cache().lock() {
        if cache.len() >= DECRYPTED_CACHE_MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(id.to_string(), entry.clone());
    }
}

/// Message ids that could NOT be opened, against the key material that failed.
///
/// Mirror of the positive cache above, and needed for the same reason: a wrong
/// candidate key costs two PBKDF2-SHA256 passes at 210 000 iterations (the archive
/// session key, then the body), so a screenful of unreadable history re-ran
/// thousands of derivations on every history refresh — and a refresh fires on every
/// `key_envelope_available` push, which is precisely what happens while a
/// conversation is unreadable.
///
/// The self-repair is preserved by keying on a fingerprint of the whole key set:
/// any new key material moves it, every entry goes stale at once, and the retry
/// happens on the very next pass.
pub(crate) fn failed_decrypt_cache() -> &'static Mutex<HashMap<String, u64>> {
    static CACHE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn decrypt_known_to_fail(message_id: &str, fingerprint: u64) -> bool {
    failed_decrypt_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(message_id).copied())
        .map(|seen| seen == fingerprint)
        .unwrap_or(false)
}

pub(crate) fn remember_decrypt_failure(message_id: &str, fingerprint: u64) {
    let id = message_id.trim();
    if id.is_empty() {
        return;
    }
    if let Ok(mut cache) = failed_decrypt_cache().lock() {
        if cache.len() >= DECRYPTED_CACHE_MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(id.to_string(), fingerprint);
    }
}

/// Drops one message from the decrypt cache.
///
/// Needed because an edit replaces the archive an entry was decrypted from: the
/// id stays the same while its contents do not, which is the one case this cache
/// cannot detect on its own. Mirrors macOS `Coordinator.forgetDecryptedMessage`.
pub(crate) fn forget_decrypted_message(message_id: &str) {
    let id = message_id.trim();
    if id.is_empty() {
        return;
    }
    if let Ok(mut cache) = decrypted_message_cache().lock() {
        cache.remove(id);
    }
    // The archive behind this id was replaced, so an earlier "no key opens it"
    // verdict was about different bytes and must not survive.
    if let Ok(mut cache) = failed_decrypt_cache().lock() {
        cache.remove(id);
    }
}

/// Drops every decryption verdict, positive and negative.
///
/// Called from CLEAR_LOCAL_DATA. Both caches are process-global while everything
/// else that reset clears is per-account state, so without this they were the one
/// thing that survived a "wipe local data" — including, now, "no key of ours opens
/// this message", a verdict about key material the reset just deleted.
pub(crate) fn clear_decrypted_message_caches() {
    if let Ok(mut cache) = decrypted_message_cache().lock() {
        cache.clear();
    }
    if let Ok(mut cache) = failed_decrypt_cache().lock() {
        cache.clear();
    }
}

pub(crate) fn cached_decrypted_message(message_id: &str) -> Option<Value> {
    decrypted_message_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(message_id.trim()).cloned())
}

pub(crate) fn clear_in_flight_send_client_id(client_id: &str) {
    let id = client_id.trim();
    if id.is_empty() {
        return;
    }
    if let Ok(mut ids) = in_flight_send_client_ids().lock() {
        ids.remove(id);
    }
}

/// Mirror of `conversationScopeKey`/`canonicalConversationScope` in
/// `web/src/interface.js` (and of `ZaliCore.dmConversationScope` in the Swift
/// client) — these scope strings index the very same conversation-key map the web
/// layer writes, so all three must agree character for character.
///
/// Participants are lowercased: they arrive here from a message record, in whatever
/// casing the server stores, while the web layer may have filed the key under a
/// scope built from a contact entry. One differing character used to make the scope
/// lookup miss silently, leaving decryption to brute-force every known key. Sorting
/// happens on the lowercased values rather than after sorting the original spelling,
/// since `Zulu` sorts before `test` but `zulu` sorts after it — otherwise the
/// participant order would itself depend on casing.
pub(crate) fn dm_conversation_scope(a: &str, b: &str) -> Option<String> {
    let first = a.trim().to_lowercase();
    let second = b.trim().to_lowercase();
    if first.is_empty() || second.is_empty() {
        return None;
    }
    let mut names = [first, second];
    names.sort();
    Some(format!("dm:{}:{}", names[0], names[1]))
}

pub(crate) fn server_conversation_scope(server_id: &str, channel_id: &str) -> Option<String> {
    let server_id = server_id.trim();
    let channel_id = channel_id.trim();
    if server_id.is_empty() || channel_id.is_empty() {
        return None;
    }
    Some(format!("server:{}:{}", server_id, channel_id))
}

pub(crate) fn push_candidate_key(keys: &mut Vec<String>, key: impl Into<String>) {
    let key = key.into();
    let trimmed = key.trim();
    if trimmed.is_empty() || keys.iter().any(|existing| existing == trimmed) {
        return;
    }
    keys.push(trimmed.to_string());
}

pub(crate) fn candidate_message_keys(
    current_key: &str,
    conversation_keys: &HashMap<String, String>,
    current_username: &str,
    record: &Value,
    server_id: Option<&str>,
    channel_id: Option<&str>,
) -> Vec<String> {
    let mut keys = Vec::new();
    if let (Some(server_id), Some(channel_id)) = (server_id, channel_id) {
        if let Some(scope) = server_conversation_scope(server_id, channel_id) {
            if let Some(key) = conversation_keys.get(&scope) {
                push_candidate_key(&mut keys, key.clone());
            }
        }
    } else {
        let sender = record.get("sender").and_then(Value::as_str).unwrap_or("");
        let receiver = record.get("receiver").and_then(Value::as_str).unwrap_or("");
        let peer = if sender.trim() == current_username.trim() {
            receiver
        } else {
            sender
        };
        if let Some(scope) = dm_conversation_scope(current_username, peer) {
            if let Some(key) = conversation_keys.get(&scope) {
                push_candidate_key(&mut keys, key.clone());
            }
        }
    }
    if keys.is_empty() {
        push_candidate_key(&mut keys, current_key);
    }
    // Last-resort fallback: try every other known conversation key too. Mirrors the macOS
    // client (WebView.swift renderHistoryRecord) — a message whose scope→key mapping is
    // stale or missing may still decrypt under a key filed under a different scope, so the
    // scoped candidate above is tried first but not treated as the only option.
    //
    // Bounded, because the cost is charged per message: every candidate that does not
    // fit costs two PBKDF2-SHA256 passes at 210 000 iterations, and `alt:` keys
    // accumulate for the life of a conversation with nothing pruning them. The scoped
    // candidates above are the ones that can realistically work; this tail is a
    // heuristic for mis-scoped material and does not deserve an unbounded budget.
    //
    // Walked in sorted scope order, not `HashMap::values()`. Once the tail is capped,
    // an unordered iteration would make the *contents* of the candidate list vary
    // between calls for the same message — decryption would succeed or fail depending
    // on which twelve keys the map happened to yield, and the "we already tried this
    // key set" fingerprint below would never match twice.
    let mut scopes: Vec<&String> = conversation_keys.keys().collect();
    scopes.sort();
    for scope in scopes {
        if keys.len() >= MAX_DECRYPT_CANDIDATES {
            break;
        }
        push_candidate_key(&mut keys, conversation_keys[scope].clone());
    }
    keys
}

/// Identity of the exact candidate list a message was tried against. Used by the
/// negative decrypt cache: same list, same outcome, so there is nothing to redo.
pub(crate) fn candidate_keys_fingerprint(keys: &[String]) -> u64 {
    let mut hasher = DefaultHasher::new();
    keys.len().hash(&mut hasher);
    for key in keys {
        key.hash(&mut hasher);
    }
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dm_conversation_scope_is_order_independent() {
        assert_eq!(
            dm_conversation_scope("alice", "bob"),
            dm_conversation_scope("bob", "alice")
        );
        assert_eq!(
            dm_conversation_scope("alice", "bob"),
            Some("dm:alice:bob".to_string())
        );
    }

    /// The two sides of a conversation reach this with different spellings — the
    /// server's stored casing on one, a contact entry's on the other — and both must
    /// land on the scope the web layer filed the key under.
    #[test]
    fn dm_conversation_scope_is_case_independent() {
        assert_eq!(
            dm_conversation_scope("Alice", "BOB"),
            Some("dm:alice:bob".to_string())
        );
        assert_eq!(
            dm_conversation_scope("Pivovarca", "zalikus"),
            dm_conversation_scope("pivovarca", "zalikus")
        );
        // Participant order must not flip with casing: `Zulu` sorts before `test`
        // by byte, `zulu` sorts after it.
        assert_eq!(
            dm_conversation_scope("Zulu", "test"),
            Some("dm:test:zulu".to_string())
        );
    }

    #[test]
    fn dm_conversation_scope_rejects_empty_participant() {
        assert_eq!(dm_conversation_scope("", "bob"), None);
        assert_eq!(dm_conversation_scope("alice", "  "), None);
    }

    #[test]
    fn server_conversation_scope_formats_and_rejects_empty() {
        assert_eq!(
            server_conversation_scope("srv1", "chan1"),
            Some("server:srv1:chan1".to_string())
        );
        assert_eq!(server_conversation_scope("", "chan1"), None);
    }

    #[test]
    fn push_candidate_key_dedups_and_trims_and_skips_empty() {
        let mut keys = Vec::new();
        push_candidate_key(&mut keys, " key-a ");
        push_candidate_key(&mut keys, "key-a");
        push_candidate_key(&mut keys, "   ");
        push_candidate_key(&mut keys, "key-b");
        assert_eq!(keys, vec!["key-a".to_string(), "key-b".to_string()]);
    }

    #[test]
    fn candidate_message_keys_prefers_dm_scoped_key_over_current_key() {
        let mut conversation_keys = HashMap::new();
        conversation_keys.insert("dm:alice:bob".to_string(), "scoped-key".to_string());
        let record = serde_json::json!({ "sender": "bob", "receiver": "alice" });

        let keys = candidate_message_keys(
            "current-key",
            &conversation_keys,
            "alice",
            &record,
            None,
            None,
        );
        assert_eq!(keys[0], "scoped-key");
    }

    #[test]
    fn candidate_message_keys_falls_back_to_current_key_when_no_scope_match() {
        let conversation_keys = HashMap::new();
        let record = serde_json::json!({ "sender": "bob", "receiver": "alice" });

        let keys = candidate_message_keys(
            "current-key",
            &conversation_keys,
            "alice",
            &record,
            None,
            None,
        );
        assert_eq!(keys, vec!["current-key".to_string()]);
    }

    #[test]
    fn candidate_message_keys_uses_server_channel_scope_when_provided() {
        let mut conversation_keys = HashMap::new();
        conversation_keys.insert("server:srv1:chan1".to_string(), "channel-key".to_string());
        let record = serde_json::json!({});

        let keys = candidate_message_keys(
            "current-key",
            &conversation_keys,
            "alice",
            &record,
            Some("srv1"),
            Some("chan1"),
        );
        assert_eq!(keys[0], "channel-key");
    }

    #[test]
    fn candidate_message_keys_includes_other_scopes_as_last_resort() {
        let mut conversation_keys = HashMap::new();
        conversation_keys.insert("dm:alice:bob".to_string(), "matched-key".to_string());
        conversation_keys.insert("dm:alice:carol".to_string(), "other-key".to_string());
        let record = serde_json::json!({ "sender": "bob", "receiver": "alice" });

        let keys = candidate_message_keys(
            "current-key",
            &conversation_keys,
            "alice",
            &record,
            None,
            None,
        );
        assert_eq!(keys[0], "matched-key");
        assert!(keys.contains(&"other-key".to_string()));
        // No duplicates even though matched-key would otherwise reappear via the
        // "every other known conversation key" fallback loop.
        assert_eq!(keys.iter().filter(|k| *k == "matched-key").count(), 1);
    }

    #[test]
    fn decrypted_message_cache_round_trips_and_skips_oversized_entries() {
        let big = Value::String("x".repeat(DECRYPTED_CACHE_MAX_ENTRY_BYTES + 1));
        cache_decrypted_message("oversized-id", &big);
        assert!(cached_decrypted_message("oversized-id").is_none());

        let small = serde_json::json!({ "sender": "alice", "text": "hi" });
        cache_decrypted_message("small-id", &small);
        assert_eq!(cached_decrypted_message("small-id"), Some(small));
    }

    #[test]
    fn cache_decrypted_message_ignores_empty_id() {
        cache_decrypted_message("   ", &Value::String("x".to_string()));
        assert!(cached_decrypted_message("   ").is_none());
    }

    #[test]
    fn in_flight_send_client_id_clear_is_idempotent() {
        in_flight_send_client_ids()
            .lock()
            .unwrap()
            .insert("client-1".to_string());
        clear_in_flight_send_client_id("client-1");
        assert!(!in_flight_send_client_ids()
            .lock()
            .unwrap()
            .contains("client-1"));
        // Clearing again (or clearing something never inserted) must not panic.
        clear_in_flight_send_client_id("client-1");
        clear_in_flight_send_client_id("never-inserted");
    }
}
