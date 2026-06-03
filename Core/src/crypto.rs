use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};

use crate::bus::ZaliBus;
use crate::loader::ZaliModule;
use serde_json::json;

const LEGACY_PREFIX: &str = "ZALIENC:";
const AESGCM_PREFIX: &str = "ZALIENCv2:";

fn derive_key_bytes(key: &str) -> [u8; 32] {
    let digest = Sha256::digest(key.as_bytes());
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&digest);
    bytes
}

fn encrypt_aes_gcm(plain_text: &str, key: &str) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("Missing encryption key".to_string());
    }

    let key_bytes = derive_key_bytes(key);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher_bytes = cipher
        .encrypt(nonce, plain_text.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(format!(
        "{}{}:{}",
        AESGCM_PREFIX,
        BASE64_STANDARD.encode(nonce_bytes),
        BASE64_STANDARD.encode(cipher_bytes)
    ))
}

fn decrypt_aes_gcm(payload: &str, key: &str) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("Missing encryption key".to_string());
    }

    let payload = payload.trim();
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
        let key_bytes = derive_key_bytes(key);
        let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| e.to_string())?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&nonce_bytes), cipher_bytes.as_ref())
            .map_err(|_| "AES-GCM authentication failed".to_string())?;
        return String::from_utf8(plain).map_err(|e| format!("UTF-8 decode error: {}", e));
    }

    if let Some(rest) = payload.strip_prefix(LEGACY_PREFIX) {
        // Backward compatibility for older archives only.
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
            let expected_sig = legacy_signature(cipher_b64, &candidate);
            if expected_sig != signature {
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

fn legacy_signature(text: &str, key: &str) -> String {
    let mut hash: u32 = 5381;
    for c in format!("{}{}", text, key).bytes() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_add(hash)
            .wrapping_add(c as u32);
    }
    format!("{:08x}", hash)
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
    encrypt_aes_gcm(text, key)
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
}
