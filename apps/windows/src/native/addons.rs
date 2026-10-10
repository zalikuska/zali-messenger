//! Хранилище аддонов хаба: `ADDON_REQUEST` (веб — `web/src/interface/addons_store.js`).
//!
//! `<данные приложения>/addons/<id>/`:
//!   - `addon.zali` — файл аддона как его установили (магик `ZALIEXTN`);
//!   - `meta.json`  — сведения, которые веб показывает в хабе (манифест,
//!     отпечаток, даты); оболочка их не толкует, только хранит;
//!   - `data/…`     — данные аддона «путь → байты»: `kv.json` (zali.storage)
//!     и `cache/…` (zali.cache).
//!
//! Пути проверяются здесь заново, теми же правилами, что `pathError` в
//! `web/src/modules/addon_format.js`, плюс то, что важно только Windows
//! (зарезервированные имена, точка в конце сегмента): путь не должен суметь
//! выйти из папки аддона. Зеркала — macOS `AddonStore.swift`, Android
//! `AddonStore.kt`.

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::addon_elevated::{confirm_install, handle_elevated_request, parse_addon_archive, write_grant, AddonHost};

const ADDON_MAGIC: &[u8; 8] = b"ZALIEXTN";
const MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
const MAX_DATA_BYTES: usize = 32 * 1024 * 1024;
const MAX_META_BYTES: usize = 512 * 1024;
const MAX_PATH_BYTES: usize = 255;
const MAX_LIST_ENTRIES: usize = 20_000;

pub(crate) fn addons_root() -> PathBuf {
    super::NativeState::app_data_dir().join("addons")
}

/// `^[a-z0-9][a-z0-9._-]{2,63}$` без `..` — как ID_RE в addon_format.js.
pub(crate) fn valid_addon_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (3..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
        && !id.contains("..")
}

fn reserved_windows_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

/// Путь данных → сегменты, или текст ошибки.
pub(crate) fn data_path_segments(path: &str) -> Result<Vec<&str>, String> {
    if path.is_empty() {
        return Err("пустой путь".into());
    }
    if path.len() > MAX_PATH_BYTES {
        return Err("путь длиннее 255 байт".into());
    }
    if path.starts_with('/') || path.ends_with('/') {
        return Err("путь начинается или кончается «/»".into());
    }
    let mut segments = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() {
            return Err("пустой сегмент пути".into());
        }
        if segment == "." || segment == ".." {
            return Err("сегмент «.» или «..»".into());
        }
        if !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return Err("недопустимые символы в пути".into());
        }
        // Win32 молча отрезает точку в конце и понимает CON/NUL/… как устройства.
        if segment.ends_with('.') || reserved_windows_name(segment) {
            return Err("имя, недопустимое в Windows".into());
        }
        segments.push(segment);
    }
    Ok(segments)
}

fn str_field<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload.get(key).and_then(Value::as_str).unwrap_or("")
}

fn addon_dir(root: &Path, payload: &Value) -> Result<PathBuf, String> {
    let id = str_field(payload, "addonId");
    if !valid_addon_id(id) {
        return Err("Некорректный id аддона".into());
    }
    Ok(root.join(id))
}

fn data_file(root: &Path, payload: &Value) -> Result<PathBuf, String> {
    let mut path = addon_dir(root, payload)?.join("data");
    let rel = str_field(payload, "path");
    for segment in data_path_segments(rel).map_err(|e| format!("Путь «{}»: {}", rel, e))? {
        path.push(segment);
    }
    Ok(path)
}

fn decode_base64(payload: &Value, limit: usize) -> Result<Vec<u8>, String> {
    let encoded = str_field(payload, "dataBase64");
    if encoded.len() > limit / 3 * 4 + 8 {
        return Err("Слишком большие данные".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Данные повреждены (base64)".to_string())?;
    if bytes.len() > limit {
        return Err("Слишком большие данные".into());
    }
    Ok(bytes)
}

/// Запись через временный файл и переименование: оборванная запись не
/// оставит наполовину записанный kv.json или файл аддона.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Нет папки для записи")?;
    fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать папку: {}", e))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Не удалось записать файл: {}", error));
    }
    Ok(())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{:02x}", b)).collect()
}

fn list_data(dir: &Path, rel: &str, prefix: &str, out: &mut Vec<Value>) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_LIST_ENTRIES {
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Временные файлы write_atomic и всё, что не прошло бы проверку пути.
        if name.starts_with('.') || data_path_segments(&name).is_err() {
            continue;
        }
        let path = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            // Каталог, который не может содержать путь с префиксом, обходить незачем.
            let as_dir = format!("{}/", path);
            if prefix.starts_with(&as_dir) || as_dir.starts_with(prefix) {
                list_data(&entry.path(), &path, prefix, out)?;
            }
        } else if meta.is_file() && path.starts_with(prefix) {
            out.push(json!({ "path": path, "size": meta.len() }));
        }
    }
    Ok(())
}

/// Обрабатывает один `ADDON_REQUEST`; ответ кладётся в `data` NativeResponse.
/// Повышенные права (сессии, fs.*, system.*, backend.*) — native/addon_elevated.rs.
pub(crate) fn handle_addon_request_with_host(host: Arc<dyn AddonHost>, root: &Path, payload: &Value) -> Result<Value, String> {
    if let Some(result) = handle_elevated_request(host.clone(), root, payload) {
        return result;
    }
    if str_field(payload, "op") == "store.put" {
        return store_put(host.as_ref(), root, payload);
    }
    handle_addon_request(root, payload)
}

/// Установка: файл разбирается здесь же, права берутся из его манифеста, а
/// повышенные подтверждает пользователь в системном диалоге — до записи.
fn store_put(host: &dyn AddonHost, root: &Path, payload: &Value) -> Result<Value, String> {
    let dir = addon_dir(root, payload)?;
    let id = str_field(payload, "addonId");
    let meta = payload.get("meta").filter(|m| m.is_object()).ok_or("Нет сведений об аддоне")?;
    if meta.get("id").and_then(Value::as_str) != Some(id) {
        return Err("Сведения не от этого аддона".into());
    }
    let meta_bytes = serde_json::to_vec(meta).map_err(|e| e.to_string())?;
    if meta_bytes.len() > MAX_META_BYTES {
        return Err("Сведения об аддоне слишком большие".into());
    }
    let bytes = decode_base64(payload, MAX_ARCHIVE_BYTES)?;
    if bytes.len() < ADDON_MAGIC.len() || &bytes[..ADDON_MAGIC.len()] != ADDON_MAGIC {
        return Err("Это не файл аддона".into());
    }
    let sha256 = sha256_hex(&bytes);
    let archive = parse_addon_archive(bytes)?;
    let elevated = confirm_install(host, &archive, &sha256, &dir)?;
    write_atomic(&dir.join("addon.zali"), &archive.bytes)?;
    write_atomic(&dir.join("meta.json"), &meta_bytes)?;
    write_grant(&dir, &sha256, &elevated)?;
    Ok(json!({ "sha256": sha256, "granted": elevated }))
}

/// Операции без повышенных прав и без диалогов (store.put — только через
/// handle_addon_request_with_host).
pub(crate) fn handle_addon_request(root: &Path, payload: &Value) -> Result<Value, String> {
    match str_field(payload, "op") {
        "store.list" => {
            let mut addons = Vec::new();
            if let Ok(entries) = fs::read_dir(root) {
                for entry in entries.flatten() {
                    let id = entry.file_name().to_string_lossy().to_string();
                    if !valid_addon_id(&id) || !entry.path().join("addon.zali").is_file() {
                        continue;
                    }
                    let meta = fs::read(entry.path().join("meta.json"))
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                        .filter(Value::is_object);
                    if let Some(meta) = meta {
                        addons.push(json!({ "addonId": id, "meta": meta }));
                    }
                }
            }
            Ok(json!({ "addons": addons }))
        }
        "store.get" => {
            let dir = addon_dir(root, payload)?;
            let bytes = fs::read(dir.join("addon.zali")).map_err(|_| "Файл аддона не найден".to_string())?;
            Ok(json!({
                "dataBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                "sha256": sha256_hex(&bytes),
            }))
        }
        "store.put" => Err("Установка идёт через handle_addon_request_with_host".into()),
        "store.remove" => {
            let dir = addon_dir(root, payload)?;
            if dir.exists() {
                fs::remove_dir_all(&dir).map_err(|e| format!("Не удалось удалить аддон: {}", e))?;
            }
            Ok(json!({}))
        }
        "data.read" => {
            let path = data_file(root, payload)?;
            match fs::read(&path) {
                Ok(bytes) => Ok(json!({
                    "exists": true,
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                })),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "exists": false })),
                Err(error) => Err(format!("Не удалось прочитать: {}", error)),
            }
        }
        "data.write" => {
            let path = data_file(root, payload)?;
            if !addon_dir(root, payload)?.join("addon.zali").is_file() {
                return Err("Аддон не установлен".into());
            }
            let bytes = decode_base64(payload, MAX_DATA_BYTES)?;
            write_atomic(&path, &bytes)?;
            Ok(json!({}))
        }
        "data.delete" => {
            let path = data_file(root, payload)?;
            match fs::remove_file(&path) {
                Ok(()) => Ok(json!({})),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
                Err(error) => Err(format!("Не удалось удалить: {}", error)),
            }
        }
        "data.list" => {
            let dir = addon_dir(root, payload)?.join("data");
            let prefix = str_field(payload, "path");
            if prefix.len() > MAX_PATH_BYTES || prefix.contains('\\') || prefix.contains("..") {
                return Err("Недопустимый префикс".into());
            }
            let mut entries = Vec::new();
            list_data(&dir, "", prefix, &mut entries)?;
            Ok(json!({ "entries": entries }))
        }
        other => Err(format!("Неизвестная операция аддонов «{}»", other.chars().take(40).collect::<String>())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zali-addons-test-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    struct NoDialogs;
    impl AddonHost for NoDialogs {
        fn confirm(&self, _title: &str, _message: &str) -> bool {
            false
        }
        fn emit(&self, _payload: Value) {}
    }

    fn archive() -> Vec<u8> {
        let manifest = br#"{"name":"T","permissions":["cache"]}"#;
        let mut out = ADDON_MAGIC.to_vec();
        out.extend_from_slice(&[1, 0, 5]);
        out.extend_from_slice(b"addon");
        out.push(0);
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&13u16.to_le_bytes());
        out.extend_from_slice(b"manifest.json");
        out.extend_from_slice(&(manifest.len() as u64).to_le_bytes());
        out.extend_from_slice(&(manifest.len() as u64).to_le_bytes());
        out.extend_from_slice(manifest);
        out
    }

    fn put(root: &Path, id: &str) -> Result<Value, String> {
        handle_addon_request_with_host(
            Arc::new(NoDialogs),
            root,
            &json!({ "op": "store.put", "addonId": id, "meta": { "id": id, "manifest": { "name": "T" } }, "dataBase64": b64(&archive()) }),
        )
    }

    #[test]
    fn ids_follow_the_web_rules() {
        assert!(valid_addon_id("org.example.test"));
        assert!(valid_addon_id("abc"));
        for bad in ["ab", "Org.x", "../x", "a..b", ".abc", "a/b", "a\\b", "abc ", ""] {
            assert!(!valid_addon_id(bad), "{bad}");
        }
    }

    #[test]
    fn paths_cannot_escape() {
        assert!(data_path_segments("cache/dir/a.txt").is_ok());
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a//b", "a\\b", "C:x", "dir/", ".", "a b", "con", "nul.txt", "COM1.log", "a/b.", "x/lpt9"] {
            assert!(data_path_segments(bad).is_err(), "{bad}");
        }
        assert!(data_path_segments("console.txt").is_ok());
        assert!(data_path_segments("com10").is_ok());
    }

    #[test]
    fn store_round_trip() {
        let root = temp_root();
        let sha = put(&root, "org.example.test").unwrap()["sha256"].as_str().unwrap().to_string();
        let list = handle_addon_request(&root, &json!({ "op": "store.list" })).unwrap();
        assert_eq!(list["addons"][0]["addonId"], "org.example.test");
        assert_eq!(list["addons"][0]["meta"]["manifest"]["name"], "T");
        let got = handle_addon_request(&root, &json!({ "op": "store.get", "addonId": "org.example.test" })).unwrap();
        assert_eq!(got["sha256"].as_str().unwrap(), sha);
        assert_eq!(got["dataBase64"].as_str().unwrap(), b64(&archive()));
        handle_addon_request(&root, &json!({ "op": "store.remove", "addonId": "org.example.test" })).unwrap();
        let list = handle_addon_request(&root, &json!({ "op": "store.list" })).unwrap();
        assert_eq!(list["addons"].as_array().unwrap().len(), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn store_refuses_foreign_files_and_mismatched_meta() {
        let root = temp_root();
        let host: Arc<dyn AddonHost> = Arc::new(NoDialogs);
        let wrong_magic = json!({ "op": "store.put", "addonId": "org.x.y", "meta": { "id": "org.x.y" }, "dataBase64": b64(b"ZALIARCHxxxx") });
        assert!(handle_addon_request_with_host(host.clone(), &root, &wrong_magic).is_err());
        let broken = json!({ "op": "store.put", "addonId": "org.x.y", "meta": { "id": "org.x.y" }, "dataBase64": b64(b"ZALIEXTNxxxx") });
        assert!(handle_addon_request_with_host(host.clone(), &root, &broken).is_err());
        let mismatched = json!({ "op": "store.put", "addonId": "org.x.y", "meta": { "id": "org.other" }, "dataBase64": b64(&archive()) });
        assert!(handle_addon_request_with_host(host, &root, &mismatched).is_err());
        assert!(put(&root, "../evil").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn data_round_trip_and_listing() {
        let root = temp_root();
        let id = "org.example.data";
        // Писать можно только установленному аддону.
        let write = |path: &str, data: &[u8]| {
            handle_addon_request(&root, &json!({ "op": "data.write", "addonId": id, "path": path, "dataBase64": b64(data) }))
        };
        assert!(write("kv.json", b"{}").is_err());
        put(&root, id).unwrap();
        write("kv.json", b"{\"n\":1}").unwrap();
        write("cache/a/b.txt", b"hello").unwrap();
        write("cache/c.bin", b"xy").unwrap();
        assert!(write("../escape", b"x").is_err());
        assert!(write("cache/../../escape", b"x").is_err());

        let read = handle_addon_request(&root, &json!({ "op": "data.read", "addonId": id, "path": "cache/a/b.txt" })).unwrap();
        assert_eq!(read["exists"], true);
        assert_eq!(read["dataBase64"], b64(b"hello"));
        let missing = handle_addon_request(&root, &json!({ "op": "data.read", "addonId": id, "path": "nope" })).unwrap();
        assert_eq!(missing["exists"], false);

        let list = handle_addon_request(&root, &json!({ "op": "data.list", "addonId": id, "path": "cache/" })).unwrap();
        let mut paths: Vec<String> = list["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap().to_string()).collect();
        paths.sort();
        assert_eq!(paths, vec!["cache/a/b.txt", "cache/c.bin"]);
        let all = handle_addon_request(&root, &json!({ "op": "data.list", "addonId": id, "path": "" })).unwrap();
        assert_eq!(all["entries"].as_array().unwrap().len(), 3);

        handle_addon_request(&root, &json!({ "op": "data.delete", "addonId": id, "path": "cache/c.bin" })).unwrap();
        handle_addon_request(&root, &json!({ "op": "data.delete", "addonId": id, "path": "cache/c.bin" })).unwrap();
        let list = handle_addon_request(&root, &json!({ "op": "data.list", "addonId": id, "path": "cache/" })).unwrap();
        assert_eq!(list["entries"].as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_op_is_an_error() {
        let root = temp_root();
        assert!(handle_addon_request(&root, &json!({ "op": "fs.read", "path": "/etc/passwd" })).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
