use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac_array;
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::bus::ZaliBus;
use crate::loader::ZaliModule;
use serde_json::json;

const LEGACY_PREFIX: &str = "ZALIENC:";
const AESGCM_PREFIX: &str = "ZALIENCv2:";
const PBKDF2_PREFIX: &str = "ZALIENCv3:";
const PBKDF2_ITERS: u32 = 210_000;

type HmacSha256 = Hmac<Sha256>;

fn derive_legacy_key_bytes(key: &str) -> [u8; 32] {
    let digest = Sha256::digest(key.as_bytes());
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&digest);
    bytes
}

fn derive_pbkdf2_key_bytes(key: &str, salt: &[u8]) -> [u8; 32] {
    pbkdf2_hmac_array::<Sha256, 32>(key.as_bytes(), salt, PBKDF2_ITERS)
}

fn encrypt_aes_gcm_v3(plain_text: &str, key: &str) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("Missing encryption key".to_string());
    }

    let mut salt_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut salt_bytes);
    let key_bytes = derive_pbkdf2_key_bytes(key, &salt_bytes);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher_bytes = cipher
        .encrypt(nonce, plain_text.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(format!(
        "{}{}:{}:{}:{}",
        PBKDF2_PREFIX,
        PBKDF2_ITERS,
        BASE64_STANDARD.encode(salt_bytes),
        BASE64_STANDARD.encode(nonce_bytes),
        BASE64_STANDARD.encode(cipher_bytes)
    ))
}

fn decrypt_aes_gcm_v3(payload: &str, key: &str) -> Result<String, String> {
    let rest = payload
        .strip_prefix(PBKDF2_PREFIX)
        .ok_or_else(|| "Malformed AES-GCM v3 payload".to_string())?;
    let (iters_raw, rest) = rest
        .split_once(':')
        .ok_or_else(|| "Malformed AES-GCM v3 payload".to_string())?;
    let iterations: u32 = iters_raw
        .parse()
        .map_err(|_| "Invalid PBKDF2 iteration count".to_string())?;
    if iterations < 50_000 {
        return Err("PBKDF2 iteration count too low".to_string());
    }
    let (salt_b64, rest) = rest
        .split_once(':')
        .ok_or_else(|| "Malformed AES-GCM v3 payload".to_string())?;
    let (nonce_b64, cipher_b64) = rest
        .split_once(':')
        .ok_or_else(|| "Malformed AES-GCM v3 payload".to_string())?;
    let salt_bytes = BASE64_STANDARD
        .decode(salt_b64)
        .map_err(|e| format!("Salt decode error: {}", e))?;
    let nonce_bytes = BASE64_STANDARD
        .decode(nonce_b64)
        .map_err(|e| format!("Nonce decode error: {}", e))?;
    if nonce_bytes.len() != 12 {
        return Err("Invalid AES-GCM nonce length".to_string());
    }
    let cipher_bytes = BASE64_STANDARD
        .decode(cipher_b64)
        .map_err(|e| format!("Ciphertext decode error: {}", e))?;
    let key_bytes = pbkdf2_hmac_array::<Sha256, 32>(key.as_bytes(), &salt_bytes, iterations);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), cipher_bytes.as_ref())
        .map_err(|_| "AES-GCM authentication failed".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("UTF-8 decode error: {}", e))
}

fn decrypt_aes_gcm(payload: &str, key: &str) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("Missing encryption key".to_string());
    }

    let payload = payload.trim();
    if payload.starts_with(PBKDF2_PREFIX) {
        return decrypt_aes_gcm_v3(payload, key);
    }
    if let Some(rest) = payload.strip_prefix(AESGCM_PREFIX) {
        let (nonce_b64, cipher_b64) = rest
            .split_once(':')
            .ok_or_else(|| "Malformed AES-GCM payload".to_string())?;
        let nonce_bytes = BASE64_STANDARD
            .decode(nonce_b64)
            .map_err(|e| format!("Nonce decode error: {}", e))?;
        if nonce_bytes.len() != 12 {
            return Err("Invalid AES-GCM nonce length".to_string());
        }
        let cipher_bytes = BASE64_STANDARD
            .decode(cipher_b64)
            .map_err(|e| format!("Ciphertext decode error: {}", e))?;
        let key_bytes = derive_legacy_key_bytes(key);
        let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| e.to_string())?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&nonce_bytes), cipher_bytes.as_ref())
            .map_err(|_| "AES-GCM authentication failed".to_string())?;
        return String::from_utf8(plain).map_err(|e| format!("UTF-8 decode error: {}", e));
    }

    if let Some(rest) = payload.strip_prefix(LEGACY_PREFIX) {
        if !legacy_compat_enabled() {
            return Err("Legacy XOR payloads are disabled".to_string());
        }
        // Backward compatibility for explicitly enabled legacy archives only.
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() != 2 {
            return Err("Malformed legacy payload".to_string());
        }
        let cipher_b64 = parts[0];
        let signature = parts[1];
        let mut candidates: Vec<String> = Vec::new();
        if !key.trim().is_empty() {
            candidates.push(key.to_string());
        }
        if let Some(legacy_key) = legacy_compat_key() {
            if legacy_key != key {
                candidates.push(legacy_key);
            }
        }

        for candidate in candidates {
            if !legacy_signature_matches(cipher_b64, signature, &candidate) {
                continue;
            }
            let decoded = BASE64_STANDARD
                .decode(cipher_b64)
                .map_err(|e| format!("Legacy base64 decode error: {}", e))?;
            let plain = legacy_xor_bytes(&decoded, &candidate);
            return String::from_utf8(plain).map_err(|e| format!("UTF-8 decode error: {}", e));
        }

        return Err("Legacy signature verification failed".to_string());
    }

    Ok(payload.to_string())
}

fn legacy_compat_key() -> Option<String> {
    std::env::var("ZALI_LEGACY_COMPAT_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn legacy_compat_enabled() -> bool {
    std::env::var("ZALI_ENABLE_LEGACY_XOR")
        .ok()
        .map(|v| {
            matches!(
                v.trim().to_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn legacy_signature(text: &str, key: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key.as_bytes())
        .expect("HMAC-SHA256 accepts keys of any size");
    mac.update(text.as_bytes());
    let bytes = mac.finalize().into_bytes();
    hex_encode(&bytes)
}

fn legacy_signature_compat(text: &str, key: &str) -> String {
    let mut hash: u32 = 5381;
    for c in format!("{}{}", text, key).bytes() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_add(hash)
            .wrapping_add(c as u32);
    }
    format!("{:08x}", hash)
}

fn legacy_signature_matches(cipher_b64: &str, signature: &str, key: &str) -> bool {
    let signature = signature.trim().to_ascii_lowercase();
    let modern = legacy_signature(cipher_b64, key);
    let compat = legacy_signature_compat(cipher_b64, key);
    let modern_match: bool = modern.as_bytes().ct_eq(signature.as_bytes()).into();
    let compat_match: bool = compat.as_bytes().ct_eq(signature.as_bytes()).into();
    modern_match | compat_match
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{:02x}", byte);
    }
    out
}

fn legacy_xor_bytes(input: &[u8], key: &str) -> Vec<u8> {
    if key.is_empty() {
        return input.to_vec();
    }
    let key_bytes = key.as_bytes();
    input
        .iter()
        .enumerate()
        .map(|(i, c)| c ^ key_bytes[i % key_bytes.len()])
        .collect()
}

pub fn encrypt_message_text(text: &str, key: &str) -> Result<String, String> {
    encrypt_aes_gcm_v3(text, key)
}

pub fn decrypt_message_text(payload: &str, key: &str) -> Result<String, String> {
    decrypt_aes_gcm(payload, key)
}

pub struct ZaliCrypto;

impl ZaliModule for ZaliCrypto {
    fn name(&self) -> &str {
        "zali_crypto"
    }

    fn init(&self, bus: &mut ZaliBus) -> Result<(), String> {
        bus.register_command(
            "zali_crypto",
            "encrypt",
            Box::new(|args| {
                let text = args["text"].as_str().ok_or("Missing text parameter")?;
                let key = args["key"].as_str().ok_or("Missing key parameter")?;

                let payload = encrypt_message_text(text, key)?;
                Ok(json!({
                    "ciphertext": payload
                }))
            }),
        );

        bus.register_command(
            "zali_crypto",
            "decrypt",
            Box::new(|args| {
                let ciphertext = args["ciphertext"]
                    .as_str()
                    .ok_or("Missing ciphertext parameter")?;
                let key = args["key"].as_str().ok_or("Missing key parameter")?;

                let plain_text = decrypt_message_text(ciphertext, key)?;
                Ok(json!({
                    "text": plain_text
                }))
            }),
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loader::ZaliLoader;

    #[test]
    fn encrypt_decrypt_preserves_unicode_text() {
        let mut loader = ZaliLoader::new();
        loader.register_module(ZaliCrypto).unwrap();

        let key = "ключ-секрет-2026";
        let text = "Привет, Zali! 🔐 Новая строка\nи emoji.";
        let encrypted = loader
            .bus
            .send("zali_crypto:encrypt", json!({ "text": text, "key": key }))
            .unwrap();

        let decrypted = loader
            .bus
            .send(
                "zali_crypto:decrypt",
                json!({
                    "ciphertext": encrypted["ciphertext"],
                    "key": key
                }),
            )
            .unwrap();

        assert_eq!(decrypted["text"].as_str(), Some(text));
    }

    #[test]
    fn decrypt_with_wrong_key_fails_authentication() {
        let encrypted = encrypt_message_text("top secret", "right-key").unwrap();
        let result = decrypt_message_text(&encrypted, "wrong-key");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_rejects_tampered_ciphertext() {
        let encrypted = encrypt_message_text("do not tamper", "a-key").unwrap();
        // Flip a character deep in the base64 ciphertext segment (after the
        // third ':') so the AES-GCM tag no longer matches.
        let last_colon = encrypted.rfind(':').unwrap();
        let mut bytes = encrypted.into_bytes();
        let flip_at = last_colon + 5;
        bytes[flip_at] = if bytes[flip_at] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();

        let result = decrypt_message_text(&tampered, "a-key");
        assert!(result.is_err());
    }

    #[test]
    fn encrypt_rejects_empty_key() {
        let result = encrypt_message_text("hello", "");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_passes_through_plaintext_with_no_known_prefix() {
        // Messages with no recognized ZALIENC prefix are treated as
        // already-plaintext (e.g. legacy unencrypted content) rather than
        // rejected — decrypt_message_text must not corrupt or reject them.
        let result = decrypt_message_text("just a plain string", "any-key").unwrap();
        assert_eq!(result, "just a plain string");
    }

    #[test]
    fn decrypt_rejects_malformed_v3_payload() {
        let result = decrypt_message_text("ZALIENCv3:not-enough-parts", "key");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_rejects_v3_payload_with_low_iteration_count() {
        let result = decrypt_message_text("ZALIENCv3:100:c2FsdA==:bm9uY2U=:Y2lwaGVy", "key");
        assert!(result.is_err());
    }

    #[test]
    fn legacy_xor_payloads_are_rejected_when_compat_flag_is_unset() {
        // ZALI_ENABLE_LEGACY_XOR is not set in the test environment, so this
        // must fail closed rather than silently decrypt via the weak XOR path.
        let result = decrypt_message_text("ZALIENC:c29tZWJhc2U2NA==:deadbeef", "key");
        assert!(result.is_err());
    }

    #[test]
    fn different_keys_produce_different_ciphertext_for_same_text() {
        let a = encrypt_message_text("same text", "key-a").unwrap();
        let b = encrypt_message_text("same text", "key-b").unwrap();
        assert_ne!(a, b);
        // And each only decrypts under its own key.
        assert!(decrypt_message_text(&a, "key-b").is_err());
        assert!(decrypt_message_text(&b, "key-a").is_err());
    }
}
