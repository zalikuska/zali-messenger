use crate::bus::ZaliBus;
use crate::loader::ZaliModule;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::convert::TryFrom;
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
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                    key_version,
                    attachments: attachment_meta,
                };

                let json = serde_json::to_string(&content).map_err(|e| e.to_string())?;
                let temp_json_path = format!("{}.json", output_path);
                fs::write(&temp_json_path, json).map_err(|e| e.to_string())?;
                archive_files.insert(0, (temp_json_path.clone(), "message.json".to_string()));

                let session = ZaliSession::new(None, Some(b"ZALIMSSG"));
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

                let session = ZaliSession::new(None, Some(b"ZALIMSSG"));
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
}
