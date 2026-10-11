//! Повышенные права аддонов хаба: файлы на всём диске (`fs.read`/`fs.write`),
//! запуск программ (`launch`) и собственный процесс-бэкенд (`process`).
//!
//! Модель (дизайн — docs/ADDONS.md):
//! - права берутся из манифеста внутри самого файла аддона, а не из сведений,
//!   которые прислал веб;
//! - при установке (`store.put`) оболочка показывает системный диалог и
//!   записывает `grant.json` — отпечаток SHA-256 файла и подтверждённые права;
//! - при каждом запуске (`session.start`) — снова диалог, и только для того же
//!   отпечатка; выдаётся `sessionId`, без которого ни одна операция ниже не
//!   выполняется, и только в пределах прав этой сессии;
//! - `session.end` (остановка аддона) закрывает сессию и завершает бэкенд.
//!
//! Бэкенд — программа из файла аддона под эту платформу
//! (`backend.commands["windows-x64"]` и т. п.), распакованная в
//! `<папка аддона>/bin/<отпечаток>/`. Общение — строками JSON через
//! stdin/stdout; каждая строка stdout приходит аддону событием `backend`.
//! Зеркало для macOS — `apps/macos/.../Services/AddonElevated.swift`.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

pub(crate) const ELEVATED_PERMISSIONS: [&str; 5] = ["network.any", "fs.read", "fs.write", "launch", "process"];
const MAX_FS_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 5_000;
const MAX_BACKEND_LINE: usize = 1024 * 1024;

/// Что оболочка даёт этому модулю: системный диалог и доставку событий в веб.
pub(crate) trait AddonHost: Send + Sync {
    fn confirm(&self, title: &str, message: &str) -> bool;
    fn emit(&self, payload: Value);
}

/// Ключ платформы в `backend.commands` для этой сборки.
pub(crate) fn backend_platform_key() -> &'static str {
    match (cfg!(target_os = "windows"), cfg!(target_arch = "aarch64")) {
        (true, true) => "windows-arm64",
        (true, false) => "windows-x64",
        (false, true) => "macos-arm64",
        (false, false) => "macos-x64",
    }
}

// ---- Файл аддона: контейнер и манифест ----

pub(crate) struct AddonArchive {
    pub bytes: Vec<u8>,
    pub entries: HashMap<String, (usize, usize)>,
    pub manifest: Value,
}

impl AddonArchive {
    pub(crate) fn file(&self, name: &str) -> Option<&[u8]> {
        self.entries.get(name).map(|&(start, len)| &self.bytes[start..start + len])
    }

    pub(crate) fn name(&self) -> String {
        self.manifest.get("name").and_then(Value::as_str).unwrap_or("Аддон").chars().take(64).collect()
    }

    pub(crate) fn elevated_permissions(&self) -> Vec<String> {
        let declared: HashSet<&str> = self
            .manifest
            .get("permissions")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        ELEVATED_PERMISSIONS.iter().filter(|p| declared.contains(*p)).map(|p| p.to_string()).collect()
    }
}

/// Тот же разбор, что `parseContainer` в web/src/modules/addon_format.js.
pub(crate) fn parse_addon_archive(bytes: Vec<u8>) -> Result<AddonArchive, String> {
    let fail = |m: &str| Err(format!("Файл аддона повреждён: {}", m));
    let mut offset = 0usize;
    let need = |offset: usize, n: usize| offset.checked_add(n).filter(|&end| end <= bytes.len()).is_some();
    if !need(0, 8) || &bytes[..8] != b"ZALIEXTN" {
        return fail("не тот магик");
    }
    offset += 8;
    if !need(offset, 1) || bytes[offset] != 1 {
        return fail("версия формата");
    }
    offset += 1;
    for _ in 0..2 {
        if !need(offset, 1) {
            return fail("обрезан");
        }
        let len = bytes[offset] as usize;
        offset += 1;
        if !need(offset, len) {
            return fail("обрезан");
        }
        offset += len;
    }
    if !need(offset, 5) || bytes[offset] != 0 {
        return fail("зашифрован");
    }
    offset += 1;
    let count = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    offset += 4;
    if count > 2000 {
        return fail("слишком много записей");
    }
    let mut entries = HashMap::new();
    for _ in 0..count {
        if !need(offset, 2) {
            return fail("обрезан");
        }
        let name_len = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        offset += 2;
        if !need(offset, name_len + 16) {
            return fail("обрезан");
        }
        let name = std::str::from_utf8(&bytes[offset..offset + name_len]).map_err(|_| "Файл аддона повреждён: имя".to_string())?.to_string();
        offset += name_len;
        super::data_path_segments(&name).map_err(|e| format!("Файл аддона повреждён: «{}»: {}", name, e))?;
        let size = u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
        let stored = u64::from_le_bytes(bytes[offset + 8..offset + 16].try_into().unwrap());
        offset += 16;
        if size != stored || size > bytes.len() as u64 || !need(offset, size as usize) {
            return fail("размеры");
        }
        if entries.insert(name.to_ascii_lowercase(), (offset, size as usize)).is_some() {
            return fail("повтор имени");
        }
        offset += size as usize;
    }
    if offset != bytes.len() {
        return fail("лишние данные");
    }
    // Ключи — в нижнем регистре (повторы различались только регистром); имена
    // в манифесте сверяются так же.
    let manifest_raw = entries.get("manifest.json").map(|&(s, l)| bytes[s..s + l].to_vec()).ok_or("В файле нет manifest.json")?;
    let manifest: Value = serde_json::from_slice(&manifest_raw).map_err(|_| "manifest.json — не JSON".to_string())?;
    if !manifest.is_object() {
        return Err("manifest.json должен быть объектом".into());
    }
    Ok(AddonArchive { bytes, entries, manifest })
}

fn grant_path(dir: &Path) -> PathBuf {
    dir.join("grant.json")
}

fn permission_titles(permissions: &[String]) -> String {
    permissions
        .iter()
        .map(|p| match p.as_str() {
            "network.any" => "• обращаться к любым серверам в интернете и передавать им данные аддона",
            "fs.read" => "• читать любые файлы и папки компьютера",
            "fs.write" => "• создавать, менять и удалять любые файлы компьютера",
            "launch" => "• открывать файлы и запускать программы",
            "process" => "• запускать свою программу с вашими правами",
            _ => "",
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `store.put`: подтверждение повышенных прав при установке. Вызывается до
/// записи файла; при отказе установка отменяется целиком.
pub(crate) fn confirm_install(host: &dyn AddonHost, archive: &AddonArchive, sha256: &str, dir: &Path) -> Result<Vec<String>, String> {
    let elevated = archive.elevated_permissions();
    if elevated.is_empty() {
        let _ = fs::remove_file(grant_path(dir));
        return Ok(elevated);
    }
    let message = format!(
        "Аддон «{}» просит повышенные права:\n\n{}\n\nОн сможет делать это от вашего имени, пока открыт. Устанавливайте его, только если доверяете автору.\n\nОтпечаток: {}",
        archive.name(),
        permission_titles(&elevated),
        &sha256[..32.min(sha256.len())]
    );
    if !host.confirm("Установить аддон с повышенными правами?", &message) {
        return Err("Установка отменена".into());
    }
    Ok(elevated)
}

pub(crate) fn write_grant(dir: &Path, sha256: &str, elevated: &[String]) -> Result<(), String> {
    if elevated.is_empty() {
        let _ = fs::remove_file(grant_path(dir));
        return Ok(());
    }
    let body = serde_json::to_vec(&json!({ "sha256": sha256, "permissions": elevated })).map_err(|e| e.to_string())?;
    fs::write(grant_path(dir), body).map_err(|e| format!("Не удалось сохранить подтверждение: {}", e))
}

// ---- Сессии ----

struct Backend {
    child: Child,
    stdin: ChildStdin,
}

struct Session {
    addon_id: String,
    permissions: HashSet<String>,
    data_dir: PathBuf,
    backend: Option<Arc<Mutex<Backend>>>,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_field(payload: &Value) -> String {
    payload.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string()
}

fn with_session<T>(payload: &Value, permission: &str, f: impl FnOnce(&Session) -> Result<T, String>) -> Result<T, String> {
    let id = session_field(payload);
    let guard = sessions().lock().map_err(|_| "Сессии аддонов недоступны".to_string())?;
    let session = guard.get(&id).ok_or("Аддон не запущен с повышенными правами")?;
    if !permission.is_empty() && !session.permissions.contains(permission) {
        return Err(format!("Нет разрешения «{}»", permission));
    }
    f(session)
}

fn stop_backend(backend: &Arc<Mutex<Backend>>) {
    if let Ok(mut b) = backend.lock() {
        let _ = b.child.kill();
        let _ = b.child.wait();
    }
}

pub(crate) fn session_start(host: Arc<dyn AddonHost>, root: &Path, payload: &Value) -> Result<Value, String> {
    let addon_id = payload.get("addonId").and_then(Value::as_str).unwrap_or("").to_string();
    if !super::valid_addon_id(&addon_id) {
        return Err("Некорректный id аддона".into());
    }
    let dir = root.join(&addon_id);
    let bytes = fs::read(dir.join("addon.zali")).map_err(|_| "Файл аддона не найден".to_string())?;
    let sha256 = super::sha256_hex(&bytes);
    let archive = parse_addon_archive(bytes)?;
    let elevated = archive.elevated_permissions();
    let grant: Value = fs::read(grant_path(&dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let granted: HashSet<String> = grant
        .get("permissions")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if grant.get("sha256").and_then(Value::as_str) != Some(sha256.as_str()) || !elevated.iter().all(|p| granted.contains(p)) {
        return Err("Повышенные права этого файла не подтверждались при установке — переустановите аддон".into());
    }
    if !elevated.is_empty() {
        let message = format!(
            "Аддон «{}» запускается с повышенными правами:\n\n{}\n\nЗапустить?",
            archive.name(),
            permission_titles(&elevated)
        );
        if !host.confirm("Запустить аддон с повышенными правами?", &message) {
            return Err("Запуск отменён".into());
        }
    }
    let session_id = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let data_dir = dir.join("data");
    let _ = fs::create_dir_all(&data_dir);
    let permissions: HashSet<String> = elevated.iter().cloned().collect();
    let backend = if permissions.contains("process") {
        Some(start_backend(host.clone(), &session_id, &addon_id, &dir, &data_dir, &archive, &sha256)?)
    } else {
        None
    };
    let mut guard = sessions().lock().map_err(|_| "Сессии аддонов недоступны".to_string())?;
    // Одна сессия на аддон: прежняя (если веб её не закрыл) закрывается.
    let stale: Vec<String> = guard.iter().filter(|(_, s)| s.addon_id == addon_id).map(|(k, _)| k.clone()).collect();
    for key in stale {
        if let Some(old) = guard.remove(&key) {
            if let Some(b) = old.backend {
                stop_backend(&b);
            }
        }
    }
    guard.insert(session_id.clone(), Session { addon_id, permissions, data_dir, backend: backend.clone() });
    Ok(json!({ "sessionId": session_id, "granted": elevated, "backend": backend.is_some() }))
}

pub(crate) fn session_end(payload: &Value) -> Result<Value, String> {
    let id = session_field(payload);
    let removed = sessions().lock().ok().and_then(|mut g| g.remove(&id));
    if let Some(b) = removed.and_then(|s| s.backend) {
        stop_backend(&b);
    }
    Ok(json!({}))
}

// ---- Бэкенд-процесс ----

fn start_backend(
    host: Arc<dyn AddonHost>,
    session_id: &str,
    addon_id: &str,
    dir: &Path,
    data_dir: &Path,
    archive: &AddonArchive,
    sha256: &str,
) -> Result<Arc<Mutex<Backend>>, String> {
    let backend = archive.manifest.get("backend").ok_or("В манифесте нет backend")?;
    let command = backend
        .get("commands")
        .and_then(|c| c.get(backend_platform_key()))
        .and_then(Value::as_str)
        .ok_or("У аддона нет программы для этой системы")?;
    let segments = super::data_path_segments(command).map_err(|e| format!("backend: {}", e))?;
    let body = archive.file(&command.to_ascii_lowercase()).ok_or("Программы бэкенда нет в файле аддона")?;
    let args: Vec<String> = backend
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).take(32).collect())
        .unwrap_or_default();

    // Распаковка: bin/<отпечаток>/<путь>. Старые версии — удаляются.
    let bin_root = dir.join("bin");
    let version_dir = bin_root.join(&sha256[..16]);
    if let Ok(entries) = fs::read_dir(&bin_root) {
        for entry in entries.flatten() {
            if entry.path() != version_dir {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let mut exe = version_dir.clone();
    for s in &segments {
        exe.push(s);
    }
    // Распакованные файлы сверяются с архивом при каждом запуске: подменённый
    // на диске бэкенд не должен запуститься с правами подлинного.
    if fs::read(&exe).ok().as_deref() != Some(body) {
        if let Some(parent) = exe.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Не удалось распаковать бэкенд: {}", e))?;
        }
        fs::write(&exe, body).map_err(|e| format!("Не удалось распаковать бэкенд: {}", e))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&exe, fs::Permissions::from_mode(0o755));
    }

    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .current_dir(data_dir)
        .env("ZALI_ADDON_ID", addon_id)
        .env("ZALI_ADDON_DIR", &version_dir)
        .env("ZALI_ADDON_DATA", data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Не удалось запустить бэкенд: {}", e))?;
    let stdin = child.stdin.take().ok_or("Нет stdin у бэкенда")?;
    let stdout = child.stdout.take().ok_or("Нет stdout у бэкенда")?;
    let stderr = child.stderr.take();
    let handle = Arc::new(Mutex::new(Backend { child, stdin }));

    let sid = session_id.to_string();
    let reader_host = host.clone();
    let watched = handle.clone();
    std::thread::Builder::new()
        .name("zali-addon-backend".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.by_ref().take(MAX_BACKEND_LINE as u64 + 1).read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if line.len() > MAX_BACKEND_LINE {
                    // Слишком длинная строка — отбросить её остаток до перевода строки.
                    let mut skip = Vec::new();
                    let _ = reader.read_until(b'\n', &mut skip);
                    reader_host.emit(json!({ "sessionId": sid, "event": "backend-error", "data": { "message": "Строка от бэкенда длиннее 1 МБ" } }));
                    continue;
                }
                let text = String::from_utf8_lossy(&line).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let data = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "text": text }));
                reader_host.emit(json!({ "sessionId": sid, "event": "backend", "data": data }));
            }
            let code = watched.lock().ok().and_then(|mut b| b.child.wait().ok()).and_then(|s| s.code());
            reader_host.emit(json!({ "sessionId": sid, "event": "backend-exit", "data": { "code": code } }));
        })
        .map_err(|e| e.to_string())?;
    if let Some(stderr) = stderr {
        let addon = addon_id.to_string();
        let _ = std::thread::Builder::new().name("zali-addon-stderr".into()).spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok).take(10_000) {
                tracing::debug!("[ZALI][ADDON][{}] {}", addon, line.chars().take(500).collect::<String>());
            }
        });
    }
    Ok(handle)
}

fn backend_send(payload: &Value) -> Result<Value, String> {
    let backend = with_session(payload, "process", |s| s.backend.clone().ok_or_else(|| "Бэкенд не запущен".to_string()))?;
    let mut line = serde_json::to_string(payload.get("message").unwrap_or(&Value::Null)).map_err(|e| e.to_string())?;
    if line.len() > MAX_BACKEND_LINE {
        return Err("Сообщение больше 1 МБ".into());
    }
    line.push('\n');
    let mut b = backend.lock().map_err(|_| "Бэкенд недоступен".to_string())?;
    b.stdin.write_all(line.as_bytes()).and_then(|_| b.stdin.flush()).map_err(|_| "Бэкенд не принимает сообщения (завершился?)".to_string())?;
    Ok(json!(true))
}

fn backend_restart(host: Arc<dyn AddonHost>, root: &Path, payload: &Value) -> Result<Value, String> {
    let (addon_id, old) = with_session(payload, "process", |s| Ok((s.addon_id.clone(), s.backend.clone())))?;
    if let Some(b) = old {
        stop_backend(&b);
    }
    let dir = root.join(&addon_id);
    let bytes = fs::read(dir.join("addon.zali")).map_err(|_| "Файл аддона не найден".to_string())?;
    let sha256 = super::sha256_hex(&bytes);
    let archive = parse_addon_archive(bytes)?;
    let sid = session_field(payload);
    let handle = start_backend(host, &sid, &addon_id, &dir, &dir.join("data"), &archive, &sha256)?;
    if let Ok(mut guard) = sessions().lock() {
        if let Some(s) = guard.get_mut(&sid) {
            s.backend = Some(handle);
            return Ok(json!(true));
        }
    }
    Err("Аддон уже остановлен".into())
}

// ---- Файлы на всём диске ----

fn abs_path(payload: &Value) -> Result<PathBuf, String> {
    let raw = payload.get("path").and_then(Value::as_str).unwrap_or("");
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') {
        return Err("Нужен полный путь".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("Нужен полный путь (от корня диска)".into());
    }
    Ok(path)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(target_os = "windows") { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn kind_of(meta: &fs::Metadata) -> &'static str {
    if meta.is_dir() {
        "dir"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    }
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn fs_op(op: &str, payload: &Value) -> Result<Value, String> {
    match op {
        "fs.paths" => with_session(payload, "", |s| {
            if !s.permissions.contains("fs.read") && !s.permissions.contains("fs.write") {
                return Err("Нет разрешения на файлы".into());
            }
            let home = home_dir();
            let sub = |name: &str| home.as_ref().map(|h| h.join(name).to_string_lossy().to_string());
            Ok(json!({
                "home": home.as_ref().map(|h| h.to_string_lossy().to_string()),
                "documents": sub("Documents"),
                "downloads": sub("Downloads"),
                "desktop": sub("Desktop"),
                "temp": std::env::temp_dir().to_string_lossy(),
                "addonData": s.data_dir.to_string_lossy(),
                "separator": std::path::MAIN_SEPARATOR.to_string(),
                "platform": backend_platform_key(),
            }))
        }),
        "fs.read" => with_session(payload, "fs.read", |_| {
            let path = abs_path(payload)?;
            let meta = fs::metadata(&path).map_err(|e| format!("Нет доступа: {}", e))?;
            if !meta.is_file() {
                return Err("Это не файл".into());
            }
            if meta.len() > MAX_FS_BYTES {
                return Err("Файл больше 32 МБ".into());
            }
            let bytes = fs::read(&path).map_err(|e| format!("Не удалось прочитать: {}", e))?;
            Ok(json!({ "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        }),
        "fs.stat" => with_session(payload, "fs.read", |_| {
            let path = abs_path(payload)?;
            Ok(match fs::metadata(&path) {
                Ok(meta) => json!({ "exists": true, "type": kind_of(&meta), "size": meta.len(), "modifiedMs": modified_ms(&meta) }),
                Err(_) => json!({ "exists": false }),
            })
        }),
        "fs.list" => with_session(payload, "fs.read", |_| {
            let path = abs_path(payload)?;
            let entries = fs::read_dir(&path).map_err(|e| format!("Не удалось открыть папку: {}", e))?;
            let mut out = Vec::new();
            for entry in entries.flatten().take(MAX_LIST_ENTRIES) {
                let meta = entry.metadata().ok();
                out.push(json!({
                    "name": entry.file_name().to_string_lossy(),
                    "type": meta.as_ref().map(kind_of).unwrap_or("other"),
                    "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    "modifiedMs": meta.as_ref().and_then(modified_ms),
                }));
            }
            Ok(Value::Array(out))
        }),
        "fs.write" => with_session(payload, "fs.write", |_| {
            let path = abs_path(payload)?;
            let encoded = payload.get("dataBase64").and_then(Value::as_str).unwrap_or("");
            if encoded.len() as u64 > MAX_FS_BYTES / 3 * 4 + 8 {
                return Err("Больше 32 МБ за раз".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "Данные повреждены".to_string())?;
            let append = payload.get("append").and_then(Value::as_bool).unwrap_or(false);
            let mut file = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(append)
                .truncate(!append)
                .open(&path)
                .map_err(|e| format!("Не удалось открыть для записи: {}", e))?;
            file.write_all(&bytes).map_err(|e| format!("Не удалось записать: {}", e))?;
            Ok(json!(true))
        }),
        "fs.mkdir" => with_session(payload, "fs.write", |_| {
            let path = abs_path(payload)?;
            fs::create_dir_all(&path).map_err(|e| format!("Не удалось создать папку: {}", e))?;
            Ok(json!(true))
        }),
        "fs.remove" => with_session(payload, "fs.write", |_| {
            let path = abs_path(payload)?;
            // Корень диска, папка пользователя и её непосредственный родитель — никогда.
            let depth = path.components().count();
            if depth <= 2 || home_dir().map(|h| h == path || h.starts_with(&path)).unwrap_or(false) {
                return Err("Эту папку удалять нельзя".into());
            }
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => return Ok(json!(false)),
            };
            let recursive = payload.get("recursive").and_then(Value::as_bool).unwrap_or(false);
            let result = if meta.is_dir() {
                if recursive { fs::remove_dir_all(&path) } else { fs::remove_dir(&path) }
            } else {
                fs::remove_file(&path)
            };
            result.map_err(|e| format!("Не удалось удалить: {}", e))?;
            Ok(json!(true))
        }),
        _ => Err("Неизвестная операция".into()),
    }
}

fn system_op(op: &str, payload: &Value) -> Result<Value, String> {
    with_session(payload, "launch", |_| {
        let path = abs_path(payload)?;
        match op {
            "system.open" => {
                if !path.exists() {
                    return Err("Такого файла или папки нет".into());
                }
                super::open_external_url(&path.to_string_lossy()).map_err(|e| format!("Не удалось открыть: {}", e))?;
                Ok(json!(true))
            }
            "system.exec" => {
                let args: Vec<String> = payload
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).take(64).collect())
                    .unwrap_or_default();
                let mut cmd = Command::new(&path);
                cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
                    if !Path::new(cwd).is_absolute() {
                        return Err("cwd — полный путь".into());
                    }
                    cmd.current_dir(cwd);
                }
                let child = cmd.spawn().map_err(|e| format!("Не удалось запустить: {}", e))?;
                Ok(json!({ "pid": child.id() }))
            }
            _ => Err("Неизвестная операция".into()),
        }
    })
}

/// Операции этого модуля; `None` — операция не отсюда (её разбирает addons.rs).
pub(crate) fn handle_elevated_request(host: Arc<dyn AddonHost>, root: &Path, payload: &Value) -> Option<Result<Value, String>> {
    let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
    Some(match op {
        "session.start" => session_start(host, root, payload),
        "session.end" => session_end(payload),
        "backend.send" => backend_send(payload),
        "backend.restart" => backend_restart(host, root, payload),
        _ if op.starts_with("fs.") => fs_op(op, payload),
        "system.open" | "system.exec" => system_op(op, payload),
        _ => return None,
    })
}

/// Байты для ответа fs.read — отдельно, чтобы не держать их дважды в тестах.
#[cfg(test)]
fn decode(v: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(v["dataBase64"].as_str().unwrap()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct FakeHost {
        answer: AtomicBool,
        asked: AtomicUsize,
        events: Mutex<Vec<Value>>,
    }

    impl AddonHost for FakeHost {
        fn confirm(&self, _title: &str, _message: &str) -> bool {
            self.asked.fetch_add(1, Ordering::SeqCst);
            self.answer.load(Ordering::SeqCst)
        }
        fn emit(&self, payload: Value) {
            self.events.lock().unwrap().push(payload);
        }
    }

    fn host(answer: bool) -> Arc<FakeHost> {
        Arc::new(FakeHost { answer: AtomicBool::new(answer), asked: AtomicUsize::new(0), events: Mutex::new(Vec::new()) })
    }

    fn build(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = b"ZALIEXTN".to_vec();
        out.push(1);
        out.push(0);
        out.push(5);
        out.extend_from_slice(b"addon");
        out.push(0);
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (name, data) in entries {
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&(data.len() as u64).to_le_bytes());
            out.extend_from_slice(&(data.len() as u64).to_le_bytes());
            out.extend_from_slice(data);
        }
        out
    }

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zali-elev-test-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn install(h: Arc<FakeHost>, root: &Path, id: &str, manifest: Value) -> Result<Value, String> {
        let archive = build(&[("manifest.json", manifest.to_string().as_bytes()), ("index.html", b"x")]);
        super::super::handle_addon_request_with_host(
            h,
            root,
            &json!({ "op": "store.put", "addonId": id, "meta": { "id": id }, "dataBase64": base64::engine::general_purpose::STANDARD.encode(archive) }),
        )
    }

    #[test]
    fn archive_parser_matches_the_web_format() {
        let ok = build(&[("manifest.json", br#"{"name":"A","permissions":["fs.read","cache"]}"#)]);
        let archive = parse_addon_archive(ok.clone()).unwrap();
        assert_eq!(archive.name(), "A");
        assert_eq!(archive.elevated_permissions(), vec!["fs.read"]);
        let mut truncated = ok.clone();
        truncated.pop();
        assert!(parse_addon_archive(truncated).is_err());
        assert!(parse_addon_archive(build(&[("../x", b"1"), ("manifest.json", b"{}")])).is_err());
        assert!(parse_addon_archive(build(&[("index.html", b"1")])).is_err());
        let mut encrypted = ok;
        encrypted[8 + 1 + 1 + 1 + 5] = 1;
        assert!(parse_addon_archive(encrypted).is_err());
    }

    #[test]
    fn elevated_install_and_launch_need_confirmation() {
        let root = temp_root();
        let manifest = json!({ "name": "Файлы", "permissions": ["fs.read", "fs.write"] });
        let declined = host(false);
        assert_eq!(install(declined.clone(), &root, "org.t.files", manifest.clone()).unwrap_err(), "Установка отменена");
        assert_eq!(declined.asked.load(Ordering::SeqCst), 1);
        assert!(!root.join("org.t.files/addon.zali").exists());

        let accepted = host(true);
        install(accepted.clone(), &root, "org.t.files", manifest).unwrap();
        assert!(root.join("org.t.files/grant.json").exists());

        // Запуск: снова диалог; отказ — без сессии.
        let start = json!({ "op": "session.start", "addonId": "org.t.files" });
        assert!(handle_elevated_request(host(false), &root, &start).unwrap().is_err());
        let h = host(true);
        let session = handle_elevated_request(h.clone(), &root, &start).unwrap().unwrap();
        assert_eq!(h.asked.load(Ordering::SeqCst), 1);
        let sid = session["sessionId"].as_str().unwrap().to_string();

        let target = root.join("outside.txt");
        let write = json!({ "op": "fs.write", "sessionId": sid, "path": target.to_string_lossy(), "dataBase64": base64::engine::general_purpose::STANDARD.encode(b"hi") });
        handle_elevated_request(h.clone(), &root, &write).unwrap().unwrap();
        let read = handle_elevated_request(h.clone(), &root, &json!({ "op": "fs.read", "sessionId": sid, "path": target.to_string_lossy() })).unwrap().unwrap();
        assert_eq!(decode(&read), b"hi");
        let list = handle_elevated_request(h.clone(), &root, &json!({ "op": "fs.list", "sessionId": sid, "path": root.to_string_lossy() })).unwrap().unwrap();
        assert!(list.as_array().unwrap().iter().any(|e| e["name"] == "outside.txt"));
        assert!(handle_elevated_request(h.clone(), &root, &json!({ "op": "fs.read", "sessionId": sid, "path": "relative.txt" })).unwrap().is_err());
        // launch не просили — нет и права.
        assert!(handle_elevated_request(h.clone(), &root, &json!({ "op": "system.open", "sessionId": sid, "path": target.to_string_lossy() })).unwrap().is_err());
        // Без сессии — ничего.
        assert!(handle_elevated_request(h.clone(), &root, &json!({ "op": "fs.read", "sessionId": "nope", "path": target.to_string_lossy() })).unwrap().is_err());

        handle_elevated_request(h.clone(), &root, &json!({ "op": "session.end", "sessionId": sid })).unwrap().unwrap();
        assert!(handle_elevated_request(h, &root, &json!({ "op": "fs.read", "sessionId": sid, "path": target.to_string_lossy() })).unwrap().is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_swapped_file_loses_its_grant() {
        let root = temp_root();
        install(host(true), &root, "org.t.swap", json!({ "name": "S", "permissions": ["fs.read"] })).unwrap();
        // Файл подменили на диске мимо store.put.
        let other = build(&[("manifest.json", br#"{"name":"S","permissions":["fs.read","fs.write"]}"#)]);
        fs::write(root.join("org.t.swap/addon.zali"), other).unwrap();
        let h = host(true);
        assert!(handle_elevated_request(h.clone(), &root, &json!({ "op": "session.start", "addonId": "org.t.swap" })).unwrap().is_err());
        assert_eq!(h.asked.load(Ordering::SeqCst), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn normal_addons_need_no_dialog() {
        let root = temp_root();
        let h = host(false);
        install(h.clone(), &root, "org.t.plain", json!({ "name": "P", "permissions": ["cache"] })).unwrap();
        assert_eq!(h.asked.load(Ordering::SeqCst), 0);
        assert!(!root.join("org.t.plain/grant.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// Бэкенд — настоящий процесс, повторяющий строки stdin в stdout (любая
    /// такая программа под эту платформу; путь — в ZALI_TEST_ECHO_BACKEND).
    /// Без переменной тест пропускается: в системе нет надёжного «эха» —
    /// findstr под wine, например, ничего не выводит.
    #[test]
    fn backend_process_round_trip() {
        let Some(echo) = std::env::var_os("ZALI_TEST_ECHO_BACKEND").and_then(|p| fs::read(p).ok()) else { return };
        let root = temp_root();
        let manifest = json!({
            "name": "Эхо", "permissions": ["process"],
            "backend": { "type": "process", "commands": { (backend_platform_key()): "bin/echo.exe" }, "args": [] }
        });
        let archive = build(&[("manifest.json", manifest.to_string().as_bytes()), ("bin/echo.exe", &echo)]);
        let h = host(true);
        super::super::handle_addon_request_with_host(
            h.clone(),
            &root,
            &json!({ "op": "store.put", "addonId": "org.t.echo", "meta": { "id": "org.t.echo" }, "dataBase64": base64::engine::general_purpose::STANDARD.encode(archive) }),
        )
        .unwrap();
        let session = handle_elevated_request(h.clone(), &root, &json!({ "op": "session.start", "addonId": "org.t.echo" })).unwrap().unwrap();
        assert_eq!(session["backend"], true);
        let sid = session["sessionId"].as_str().unwrap().to_string();
        handle_elevated_request(h.clone(), &root, &json!({ "op": "backend.send", "sessionId": sid, "message": { "ping": 1 } })).unwrap().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if h.events.lock().unwrap().iter().any(|e| e["event"] == "backend" && e["data"]["ping"] == 1) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "no echo: {:?}", h.events.lock().unwrap());
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        handle_elevated_request(h.clone(), &root, &json!({ "op": "session.end", "sessionId": sid })).unwrap().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !h.events.lock().unwrap().iter().any(|e| e["event"] == "backend-exit") {
            assert!(std::time::Instant::now() < deadline, "no exit event");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_remove_roots() {
        let root = temp_root();
        install(host(true), &root, "org.t.rm", json!({ "name": "R", "permissions": ["fs.write"] })).unwrap();
        let h = host(true);
        let sid = handle_elevated_request(h.clone(), &root, &json!({ "op": "session.start", "addonId": "org.t.rm" })).unwrap().unwrap()["sessionId"].as_str().unwrap().to_string();
        let top = if cfg!(target_os = "windows") { "C:\\" } else { "/" };
        assert!(handle_elevated_request(h.clone(), &root, &json!({ "op": "fs.remove", "sessionId": sid, "path": top, "recursive": true })).unwrap().is_err());
        if let Some(home) = home_dir() {
            assert!(handle_elevated_request(h.clone(), &root, &json!({ "op": "fs.remove", "sessionId": sid, "path": home.to_string_lossy(), "recursive": true })).unwrap().is_err());
        }
        let _ = fs::remove_dir_all(&root);
    }
}
