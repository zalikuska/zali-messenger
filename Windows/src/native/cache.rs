//! In-flight send dedup, decrypted-message LRU-ish cache, and conversation
//! key-scope candidate derivation.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
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

pub(crate) fn dm_conversation_scope(a: &str, b: &str) -> Option<String> {
    let first = a.trim();
    let second = b.trim();
    if first.is_empty() || second.is_empty() {
        return None;
    }
    let mut names = [first.to_string(), second.to_string()];
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
    keys
}
