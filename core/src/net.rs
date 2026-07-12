use crate::bus::ZaliBus;
use crate::loader::ZaliModule;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::convert::TryFrom;
use std::fs;
use std::path::Path;
use zali_sdk::ZaliSession;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentContent {
    pub name: String,
    pub archive_path: String,
    pub mime_type: String,
    pub kind: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageContent {
    pub sender: String,
    pub text: String,
    pub timestamp: u64,
    #[serde(default = "default_archive_key_version")]
    pub key_version: u8,
    #[serde(default)]
    pub attachments: Vec<AttachmentContent>,
}

fn default_archive_key_version() -> u8 {
    1
}

fn default_pack_key_version() -> u8 {
    2
}

// std::time::SystemTime::now() panics on wasm32-unknown-unknown ("time not implemented on
// this platform") — there's no OS clock to ask. js_sys::Date::now() reads it from the browser
// instead. Native builds keep using SystemTime so this has no effect outside wasm.
#[cfg(target_arch = "wasm32")]
fn now_unix_secs() -> u64 {
    (js_sys::Date::now() / 1000.0) as u64
}

#[cfg(not(target_arch = "wasm32"))]
fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub struct ZaliNet;

impl ZaliModule for ZaliNet {
    fn name(&self) -> &str {
        "zali_net"
    }

    fn init(&self, bus: &mut ZaliBus) -> Result<(), String> {
        // 1. zali_net:pack_message
        // Args: { "sender": "...", "text": "...", "key": "...", "output_path": "..." }
        // Returns: { "success": true, "archive_path": "..." }
        bus.register_command(
            "zali_net",
            "pack_message",
            Box::new(|args| {
                let sender = args["sender"].as_str().ok_or("Missing sender parameter")?;
                let text = args["text"].as_str().ok_or("Missing text parameter")?;
                let key = args["key"].as_str().ok_or("Missing key parameter")?;
                if key.trim().is_empty() {
                    return Err("Missing key parameter".to_string());
                }
                let output_path = args["output_path"]
                    .as_str()
                    .ok_or("Missing output_path parameter")?;
                let key_version = args
                    .get("key_version")
                    .or_else(|| args.get("keyVersion"))
                    .and_then(Value::as_u64)
                    .and_then(|value| u8::try_from(value).ok())
                    .filter(|value| *value > 0)
                    .unwrap_or_else(default_pack_key_version);
                let mut archive_files = Vec::new();
                let mut attachment_meta = Vec::new();

                let encrypted_payload = crate::crypto::encrypt_message_text(text, key)?;

                if let Some(items) = args["attachments"].as_array() {
                    for item in items {
                        let path = item
                            .get("path")
                            .and_then(|v| v.as_str())
                            .ok_or("Missing attachment path parameter")?;
                        if !Path::new(path).exists() {
                            continue;
                        }

                        let archive_path = item
                            .get("archivePath")
                            .or_else(|| item.get("archive_path"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_else(|| {
                                Path::new(path)
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("attachment.bin")
                            });

                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_else(|| {
                                Path::new(path)
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("attachment.bin")
                            });

                        let mime_type = item
                            .get("mimeType")
                            .or_else(|| item.get("mime_type"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("application/octet-stream");

                        let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("file");

                        let size = item
                            .get("size")
                            .and_then(|v| v.as_u64())
                            .unwrap_or_else(|| fs::metadata(path).map(|m| m.len()).unwrap_or(0));

                        archive_files.push((path.to_string(), archive_path.to_string()));
                        attachment_meta.push(AttachmentContent {
                            name: name.to_string(),
                            archive_path: archive_path.to_string(),
                            mime_type: mime_type.to_string(),
                            kind: kind.to_string(),
                            size,
                        });
                    }
                }

                let content = MessageContent {
                    sender: sender.to_string(),
                    text: encrypted_payload,
                    timestamp: now_unix_secs(),
                    key_version,
                    attachments: attachment_meta,
                };

                let json = serde_json::to_string(&content).map_err(|e| e.to_string())?;
                let temp_json_path = format!("{}.json", output_path);
                fs::write(&temp_json_path, json).map_err(|e| e.to_string())?;
                archive_files.insert(0, (temp_json_path.clone(), "message.json".to_string()));

                let session = ZaliSession::new(Some(key), Some(b"ZALIMSSG"));
                session
                    .create_archive(archive_files, output_path)
                    .map_err(|e| e.to_string())?;

                fs::remove_file(temp_json_path).ok();

                Ok(json!({
                    "success": true,
                    "archive_path": output_path
                }))
            }),
        );

        // 2. zali_net:unpack_message
        // Args: { "archive_path": "...", "temp_dir": "...", "key": "..." }
        // Returns: { "sender": "...", "text": "...", "timestamp": 123 }
        bus.register_command(
            "zali_net",
            "unpack_message",
            Box::new(|args| {
                let archive_path = args["archive_path"]
                    .as_str()
                    .ok_or("Missing archive_path parameter")?;
                let temp_dir = args["temp_dir"]
                    .as_str()
                    .ok_or("Missing temp_dir parameter")?;
                let key = args["key"].as_str().ok_or("Missing key parameter")?;
                if key.trim().is_empty() {
                    return Err("Missing key parameter".to_string());
                }

                let session = ZaliSession::new(Some(key), Some(b"ZALIMSSG"));
                session
                    .extract_all(archive_path, temp_dir)
                    .map_err(|e| e.to_string())?;

                let json_path = Path::new(temp_dir).join("message.json");
                let json_str = fs::read_to_string(&json_path).map_err(|e| e.to_string())?;

                // Cleanup extracted json file immediately
                fs::remove_file(json_path).ok();

                let content: MessageContent =
                    serde_json::from_str(&json_str).map_err(|e| e.to_string())?;

                let decrypted_text = crate::crypto::decrypt_message_text(&content.text, key)?;

                Ok(json!({
                    "sender": content.sender,
                    "text": decrypted_text,
                    "timestamp": content.timestamp,
                    "keyVersion": content.key_version,
                    "attachments": content.attachments,
                    "decryptionError": null,
                }))
            }),
        );

        Ok(())
    }
}

/// In-memory attachment: same metadata as `AttachmentContent` plus its raw bytes.
/// Used by the byte-based pack/unpack pair below, which has no filesystem access
/// (the browser/WASM client has none) — everything happens on `Vec<u8>` buffers.
pub struct InMemoryAttachment {
    pub name: String,
    pub archive_path: String,
    pub mime_type: String,
    pub kind: String,
    pub bytes: Vec<u8>,
}

/// A fully decoded in-memory message: metadata plus each attachment's bytes.
pub struct UnpackedMessage {
    pub sender: String,
    pub text: String,
    pub timestamp: u64,
    pub key_version: u8,
    pub attachments: Vec<InMemoryAttachment>,
}

/// Byte-buffer equivalent of `zali_net:pack_message` — builds a `.zali` archive
/// entirely in memory (no filesystem), for use from environments without one
/// (the browser/WASM client). Wire format is identical, so the resulting bytes
/// are byte-for-byte interchangeable with archives produced by the native path.
pub fn pack_message_bytes(
    sender: &str,
    text: &str,
    key: &str,
    key_version: u8,
    attachments: Vec<InMemoryAttachment>,
) -> Result<Vec<u8>, String> {
    if key.trim().is_empty() {
        return Err("Missing key parameter".to_string());
    }

    let encrypted_payload = crate::crypto::encrypt_message_text(text, key)?;

    let attachment_meta: Vec<AttachmentContent> = attachments
        .iter()
        .map(|a| AttachmentContent {
            name: a.name.clone(),
            archive_path: a.archive_path.clone(),
            mime_type: a.mime_type.clone(),
            kind: a.kind.clone(),
            size: a.bytes.len() as u64,
        })
        .collect();

    let content = MessageContent {
        sender: sender.to_string(),
        text: encrypted_payload,
        timestamp: now_unix_secs(),
        key_version: if key_version > 0 {
            key_version
        } else {
            default_pack_key_version()
        },
        attachments: attachment_meta,
    };

    let json = serde_json::to_string(&content).map_err(|e| e.to_string())?;

    let mut archive_files = vec![("message.json".to_string(), json.into_bytes())];
    for att in attachments {
        archive_files.push((att.archive_path, att.bytes));
    }

    let session = ZaliSession::new(Some(key), Some(b"ZALIMSSG"));
    session
        .create_archive_bytes(archive_files)
        .map_err(|e| e.to_string())
}

/// Byte-buffer equivalent of `zali_net:unpack_message` — decodes a `.zali`
/// archive entirely in memory. See `pack_message_bytes`.
pub fn unpack_message_bytes(archive: &[u8], key: &str) -> Result<UnpackedMessage, String> {
    if key.trim().is_empty() {
        return Err("Missing key parameter".to_string());
    }

    let session = ZaliSession::new(Some(key), Some(b"ZALIMSSG"));
    let mut files = session
        .extract_all_bytes(archive)
        .map_err(|e| e.to_string())?;

    let json_idx = files
        .iter()
        .position(|(name, _)| name == "message.json")
        .ok_or("Archive has no message.json")?;
    let (_, json_bytes) = files.remove(json_idx);
    let json_str = String::from_utf8(json_bytes).map_err(|e| e.to_string())?;
    let content: MessageContent = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;

    let decrypted_text = crate::crypto::decrypt_message_text(&content.text, key)?;

    let attachments = content
        .attachments
        .into_iter()
        .filter_map(|meta| {
            let idx = files
                .iter()
                .position(|(name, _)| *name == meta.archive_path)?;
            let (_, bytes) = files.remove(idx);
            Some(InMemoryAttachment {
                name: meta.name,
                archive_path: meta.archive_path,
                mime_type: meta.mime_type,
                kind: meta.kind,
                bytes,
            })
        })
        .collect();

    Ok(UnpackedMessage {
        sender: content.sender,
        text: decrypted_text,
        timestamp: content.timestamp,
        key_version: content.key_version,
        attachments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto::ZaliCrypto, loader::ZaliLoader};

    #[test]
    fn pack_unpack_message_preserves_unicode_text() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("message.zali");
        let unpack_dir = temp.path().join("unpacked");

        let mut loader = ZaliLoader::new();
        loader.register_module(ZaliCrypto).unwrap();
        loader.register_module(ZaliNet).unwrap();

        let key = "секретный-ключ";
        let text = "Привет, мир! Тестируем .zali 🔐";

        loader
            .bus
            .send(
                "zali_net:pack_message",
                json!({
                    "sender": "Zalikus",
                    "text": text,
                    "key": key,
                    "output_path": archive_path.to_string_lossy()
                }),
            )
            .unwrap();

        let unpacked = loader
            .bus
            .send(
                "zali_net:unpack_message",
                json!({
                    "archive_path": archive_path.to_string_lossy(),
                    "temp_dir": unpack_dir.to_string_lossy(),
                    "key": key
                }),
            )
            .unwrap();

        assert_eq!(unpacked["sender"].as_str(), Some("Zalikus"));
        assert_eq!(unpacked["text"].as_str(), Some(text));
        assert_eq!(unpacked["keyVersion"].as_u64(), Some(2));
    }

    #[test]
    fn pack_unpack_message_preserves_attachments_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("message_with_attachment.zali");
        let unpack_dir = temp.path().join("unpacked_attach");
        let attachment_path = temp.path().join("photo.png");

        fs::write(&attachment_path, b"fake-image-bytes").unwrap();

        let mut loader = ZaliLoader::new();
        loader.register_module(ZaliCrypto).unwrap();
        loader.register_module(ZaliNet).unwrap();

        loader
            .bus
            .send(
                "zali_net:pack_message",
                json!({
                    "sender": "Zalikus",
                    "text": "Фото",
                    "key": "secret",
                    "output_path": archive_path.to_string_lossy(),
                    "key_version": 7,
                    "attachments": [
                        {
                            "path": attachment_path.to_string_lossy(),
                            "archivePath": "attachments/photo.png",
                            "name": "photo.png",
                            "mimeType": "image/png",
                            "kind": "image",
                            "size": 16
                        }
                    ]
                }),
            )
            .unwrap();

        let unpacked = loader
            .bus
            .send(
                "zali_net:unpack_message",
                json!({
                    "archive_path": archive_path.to_string_lossy(),
                    "temp_dir": unpack_dir.to_string_lossy(),
                    "key": "secret"
                }),
            )
            .unwrap();

        let attachments = unpacked["attachments"].as_array().unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0]["name"].as_str(), Some("photo.png"));
        assert_eq!(attachments[0]["mimeType"].as_str(), Some("image/png"));
        assert_eq!(unpacked["keyVersion"].as_u64(), Some(7));
    }

    fn test_loader() -> ZaliLoader {
        let mut loader = ZaliLoader::new();
        loader.register_module(ZaliCrypto).unwrap();
        loader.register_module(ZaliNet).unwrap();
        loader
    }

    #[test]
    fn pack_message_requires_a_non_empty_key() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("message.zali");
        let loader = test_loader();

        let result = loader.bus.send(
            "zali_net:pack_message",
            json!({
                "sender": "Zalikus",
                "text": "hi",
                "key": "",
                "output_path": archive_path.to_string_lossy()
            }),
        );
        assert!(result.is_err());
        assert!(!archive_path.exists());
    }

    #[test]
    fn pack_message_requires_sender_text_and_output_path() {
        let loader = test_loader();
        assert!(loader
            .bus
            .send(
                "zali_net:pack_message",
                json!({ "text": "hi", "key": "k", "output_path": "/tmp/whatever.zali" })
            )
            .is_err());
        assert!(loader
            .bus
            .send(
                "zali_net:pack_message",
                json!({ "sender": "s", "key": "k", "output_path": "/tmp/whatever.zali" })
            )
            .is_err());
        assert!(loader
            .bus
            .send(
                "zali_net:pack_message",
                json!({ "sender": "s", "text": "hi", "key": "k" })
            )
            .is_err());
    }

    #[test]
    fn unpack_message_with_wrong_key_fails() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("message.zali");
        let unpack_dir = temp.path().join("unpacked");
        let loader = test_loader();

        loader
            .bus
            .send(
                "zali_net:pack_message",
                json!({
                    "sender": "Zalikus",
                    "text": "hello",
                    "key": "right-key",
                    "output_path": archive_path.to_string_lossy()
                }),
            )
            .unwrap();

        let result = loader.bus.send(
            "zali_net:unpack_message",
            json!({
                "archive_path": archive_path.to_string_lossy(),
                "temp_dir": unpack_dir.to_string_lossy(),
                "key": "wrong-key"
            }),
        );
        assert!(result.is_err());
    }

    #[test]
    fn pack_message_skips_attachments_whose_source_file_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("message.zali");
        let unpack_dir = temp.path().join("unpacked");
        let loader = test_loader();

        loader
            .bus
            .send(
                "zali_net:pack_message",
                json!({
                    "sender": "Zalikus",
                    "text": "no real attachment",
                    "key": "secret",
                    "output_path": archive_path.to_string_lossy(),
                    "attachments": [
                        {
                            "path": temp.path().join("does-not-exist.bin").to_string_lossy(),
                            "name": "ghost.bin"
                        }
                    ]
                }),
            )
            .unwrap();

        let unpacked = loader
            .bus
            .send(
                "zali_net:unpack_message",
                json!({
                    "archive_path": archive_path.to_string_lossy(),
                    "temp_dir": unpack_dir.to_string_lossy(),
                    "key": "secret"
                }),
            )
            .unwrap();

        assert!(unpacked["attachments"].as_array().unwrap().is_empty());
        assert_eq!(unpacked["text"].as_str(), Some("no real attachment"));
    }

    #[test]
    fn unpack_message_fails_when_archive_has_no_message_json() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("not-a-message.zali");
        let unpack_dir = temp.path().join("unpacked");
        let stray_file = temp.path().join("stray.txt");
        fs::write(&stray_file, b"irrelevant content").unwrap();

        // Pack a .zali archive directly via the SDK (bypassing zali_net:pack_message)
        // so it never contains a message.json — simulates a corrupt/foreign archive.
        let session = ZaliSession::new(Some("secret"), Some(b"ZALIMSSG"));
        session
            .create_archive(
                vec![(
                    stray_file.to_string_lossy().into_owned(),
                    "stray.txt".to_string(),
                )],
                archive_path.to_string_lossy().as_ref(),
            )
            .unwrap();

        let loader = test_loader();
        let result = loader.bus.send(
            "zali_net:unpack_message",
            json!({
                "archive_path": archive_path.to_string_lossy(),
                "temp_dir": unpack_dir.to_string_lossy(),
                "key": "secret"
            }),
        );
        assert!(result.is_err());
    }

    #[test]
    fn bytes_pack_unpack_message_roundtrips_with_attachment() {
        let archive = pack_message_bytes(
            "Zalikus",
            "Привет из браузера",
            "secret",
            5,
            vec![InMemoryAttachment {
                name: "photo.png".to_string(),
                archive_path: "attachments/photo.png".to_string(),
                mime_type: "image/png".to_string(),
                kind: "image".to_string(),
                bytes: b"fake-image-bytes".to_vec(),
            }],
        )
        .unwrap();

        let unpacked = unpack_message_bytes(&archive, "secret").unwrap();
        assert_eq!(unpacked.sender, "Zalikus");
        assert_eq!(unpacked.text, "Привет из браузера");
        assert_eq!(unpacked.key_version, 5);
        assert_eq!(unpacked.attachments.len(), 1);
        assert_eq!(unpacked.attachments[0].name, "photo.png");
        assert_eq!(unpacked.attachments[0].bytes, b"fake-image-bytes");
    }

    #[test]
    fn bytes_unpack_message_with_wrong_key_fails() {
        let archive = pack_message_bytes("Zalikus", "hello", "right-key", 0, vec![]).unwrap();
        assert!(unpack_message_bytes(&archive, "wrong-key").is_err());
    }

    #[test]
    fn bytes_pack_message_requires_a_non_empty_key() {
        assert!(pack_message_bytes("Zalikus", "hi", "", 0, vec![]).is_err());
    }

    #[test]
    fn bytes_archive_interops_with_path_based_archive() {
        // A message packed via the in-memory (WASM) API must unpack via the
        // path-based (native) API and vice versa — same wire format.
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("message.zali");
        let unpack_dir = temp.path().join("unpacked");

        let archive_bytes = pack_message_bytes("Zalikus", "cross-api", "secret", 3, vec![]).unwrap();
        fs::write(&archive_path, &archive_bytes).unwrap();

        let loader = test_loader();
        let unpacked = loader
            .bus
            .send(
                "zali_net:unpack_message",
                json!({
                    "archive_path": archive_path.to_string_lossy(),
                    "temp_dir": unpack_dir.to_string_lossy(),
                    "key": "secret"
                }),
            )
            .unwrap();
        assert_eq!(unpacked["sender"].as_str(), Some("Zalikus"));
        assert_eq!(unpacked["text"].as_str(), Some("cross-api"));
    }
}
