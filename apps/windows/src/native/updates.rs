//! Downloads a new build and swaps it in for the running `.exe` on relaunch.
//! Windows ships as a raw executable (no installer/MSI pipeline — see
//! CLAUDE.md's Windows Build Distribution notes), so the "install" step is
//! just a file copy over the current binary, not an unzip.

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use tao::event_loop::EventLoopProxy;

use crate::native::{dispatch_ui_event, http_client, new_request_id, trace, AppEvent, NativeState, UiBusEvent};

const MAX_UPDATE_BYTES: u64 = 300 * 1024 * 1024;

fn updates_dir() -> PathBuf {
    let dir = NativeState::app_data_dir().join("updates");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Holds the verified download between DOWNLOAD_UPDATE_REQUEST and
/// INSTALL_UPDATE_REQUEST. Deliberately not part of `NativeState` (which is
/// `Clone` and gets persisted/serialized elsewhere) — this is ephemeral,
/// process-local state, same scope as the macOS client's `pendingUpdateArchivePath`.
static PENDING_UPDATE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub(crate) fn set_pending_update_path(path: Option<PathBuf>) {
    if let Ok(mut guard) = PENDING_UPDATE_PATH.lock() {
        *guard = path;
    }
}

pub(crate) fn pending_update_path() -> Option<PathBuf> {
    PENDING_UPDATE_PATH.lock().ok().and_then(|guard| guard.clone())
}

/// SHA-256 скачанного обновления: файл в %APPDATA% доступен на запись тому же
/// пользователю, поэтому перед установкой хэш сверяется ещё раз.
static PENDING_UPDATE_SHA: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn set_pending_update_sha(sha: Option<String>) {
    if let Ok(mut guard) = PENDING_UPDATE_SHA.lock() {
        *guard = sha.map(|value| value.to_lowercase());
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn verify_pending_update(path: &std::path::Path) -> Result<(), String> {
    let expected = PENDING_UPDATE_SHA
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .ok_or_else(|| "Обновление не проверено".to_string())?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{:02x}", b)).collect();
    if actual != expected {
        let _ = std::fs::remove_file(path);
        return Err("Файл обновления изменился после проверки — установка отменена".to_string());
    }
    Ok(())
}

/// Публичная часть официального ключа (та же, что `OFFICIAL_PUBLIC_KEY` в
/// web/src/modules/addon_format.js): несжатая точка P-256.
const OFFICIAL_RELEASE_PUBLIC_KEY_B64: &str =
    "BDUcWsKrt/KoOeUnExrEScgAqUD3JEPCDLS5OqWmER0pm+FXwhzClXxkEh0KG4WdLkm9czOJXgXSuMuYlOcrMWw=";

/// Подпись релиза (формат `release_signature_message` в server/src/updates.rs и
/// scripts/release_sign.py). Раньше её проверял только JS, а мост принимал любой
/// https-адрес с любым SHA-256 — то есть доверял тому, кто прислал команду.
pub(crate) fn verify_release_signature(version: &str, sha256: &str, url: &str, signature_b64: &str) -> bool {
    use base64::Engine;
    let platform = if cfg!(target_os = "macos") { "macos" } else { "windows" };
    let message = format!(
        "zali-release-sig:v1\n{platform}\n{version}\n{}\n{url}",
        sha256.trim().to_lowercase()
    );
    let engine = base64::engine::general_purpose::STANDARD;
    let (Ok(public), Ok(signature)) = (
        engine.decode(OFFICIAL_RELEASE_PUBLIC_KEY_B64),
        engine.decode(signature_b64.trim()),
    ) else {
        return false;
    };
    if signature.len() != 64 {
        return false;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, public)
        .verify(message.as_bytes(), &signature)
        .is_ok()
}

/// Ключ порядка версий — зеркало `version_key` в server/src/updates.rs и
/// `compareVersions` в web/src/interface/updates.js: major, minor, канал
/// (r > b > a), сборка, подсборка; легаси `1.1.4` — release.
fn version_key(version: &str) -> (u64, u64, u8, u64, u64) {
    let v = version.trim();
    if let Some((major, rest)) = v.split_once('.') {
        if let Some(split) = rest.find(|c: char| c.is_ascii_alphabetic()) {
            let (minor, tail) = rest.split_at(split);
            let channel = tail.chars().next().unwrap_or('r').to_ascii_lowercase();
            let rank = match channel { 'a' => 0, 'b' => 1, _ => 2 };
            let tail = &tail[1..];
            let (build, sub) = tail.split_once('.').unwrap_or((tail, "0"));
            return (
                major.parse().unwrap_or(0),
                minor.parse().unwrap_or(0),
                rank,
                build.parse().unwrap_or(0),
                sub.parse().unwrap_or(0),
            );
        }
    }
    let mut parts = v.split('.').map(|n| n.parse::<u64>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0), 2, parts.next().unwrap_or(0), 0)
}

/// Подписанный, но старый релиз — не обновление: без этой проверки мост ставил
/// любую когда-либо подписанную (в том числе уязвимую) сборку (аудит 2026-11-18).
pub(crate) fn is_newer_version(candidate: &str, current: &str) -> bool {
    version_key(candidate) > version_key(current)
}

pub(crate) async fn download_update(
    url: String,
    expected_sha256: String,
    proxy: EventLoopProxy<AppEvent>,
) -> Result<PathBuf, String> {
    if !url.starts_with("https://") {
        return Err("Некорректный URL обновления".to_string());
    }
    let client = http_client();
    let http_request_id = new_request_id();
    let response = client
        .get(&url)
        .header("X-Request-ID", &http_request_id)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }
    if let Some(len) = response.content_length() {
        if len > MAX_UPDATE_BYTES {
            return Err("Обновление превышает допустимый размер".to_string());
        }
    }

    let dir = updates_dir();
    let file_path = dir.join(format!("update-{}.exe", uuid::Uuid::new_v4()));
    let mut output = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| e.to_string())?;

    let expected_total = response.content_length();
    let mut total_written: u64 = 0;
    let mut last_reported = -1.0f64;
    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        total_written += chunk.len() as u64;
        if total_written > MAX_UPDATE_BYTES {
            let _ = tokio::fs::remove_file(&file_path).await;
            return Err("Обновление превышает допустимый размер".to_string());
        }
        hasher.update(&chunk);
        tokio::io::AsyncWriteExt::write_all(&mut output, &chunk)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(total) = expected_total {
            let fraction = total_written as f64 / total as f64;
            if fraction - last_reported >= 0.02 || fraction >= 1.0 {
                last_reported = fraction;
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::UpdateEvent,
                    serde_json::json!({ "kind": "progress", "progress": fraction.min(1.0).max(0.0) }),
                );
            }
        }
    }

    let digest = format!("{:x}", hasher.finalize());
    if digest.to_lowercase() != expected_sha256.to_lowercase() {
        let _ = tokio::fs::remove_file(&file_path).await;
        return Err("Контрольная сумма обновления не совпадает".to_string());
    }

    trace(format!(
        "download_update done http_request_id={} bytes={} path={}",
        http_request_id,
        total_written,
        file_path.display()
    ));
    Ok(file_path)
}

/// Writes a relaunch helper script that waits for this process to exit, copies
/// the new `.exe` over the current one, and relaunches it, then requests app
/// exit via `AppEvent::Quit`. Windows-only: the non-Windows build of this crate
/// is the experimental, non-primary macOS Rust shell (see CLAUDE.md) — install
/// there is intentionally unsupported rather than duplicating the swap logic
/// for a platform this feature isn't shipping to.
#[cfg(target_os = "windows")]
pub(crate) fn install_and_relaunch(new_exe_path: PathBuf, proxy: EventLoopProxy<AppEvent>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW only. It used to be OR'd with DETACHED_PROCESS, but Windows
    // *ignores* CREATE_NO_WINDOW when DETACHED_PROCESS is also set, and a detached
    // process has no console at all — so every console program the script ran
    // (tasklist, find, timeout) was given a brand new console of its own, each one
    // a visible window titled after its command line. That is the `find "<number>"`
    // window users saw, the number being this process's PID. With CREATE_NO_WINDOW
    // alone cmd gets a console that has no window, and children inherit it.
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    verify_pending_update(&new_exe_path)?;
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = updates_dir();
    let script_path = dir.join(format!("relaunch-{}.cmd", uuid::Uuid::new_v4()));
    let log_path = dir.join("install.log");
    // No tasklist/find polling any more: Windows keeps a running image locked, so
    // retrying the copy IS the wait, and it tests the thing we actually care about
    // instead of a PID. That also drops `timeout`, which needs console input and
    // failed instantly here ("Input redirection is not supported"), turning the
    // supposed one-second wait into a spin loop.
    //
    // Failure is no longer silent. The old script hid the copy behind >NUL and
    // relaunched nothing, so an install into a directory this user cannot write —
    // Program Files, when the Inno Setup installer put it there and the app runs
    // unelevated — looked exactly like "nothing happens". Now the previous version
    // is started back up and the reason is left in install.log.
    // The retry loop alone was not enough: when the Inno Setup installer put the app
    // in Program Files and it runs unelevated, the copy can never succeed — all 60
    // tries fail, the OLD binary is restarted, and the next login finds the same
    // newer release and offers it again. That is the update loop users hit: accepting
    // the update is precisely what restarts it. So an exhausted retry loop now
    // re-runs this same script elevated (`-Verb RunAs`, i.e. a UAC prompt) and does a
    // single copy from there, verifying the result with `fc /b` before declaring
    // success — a declined UAC prompt must not be mistaken for a completed install.
    let script = format!(
        "@echo off\r\n\
         setlocal\r\n\
         set \"SRC={new_exe}\"\r\n\
         set \"DST={current_exe}\"\r\n\
         set \"LOG={log}\"\r\n\
         if /I \"%~1\"==\"elevated\" goto elevatedcopy\r\n\
         set /a tries=0\r\n\
         :retry\r\n\
         set /a tries+=1\r\n\
         copy /Y \"%SRC%\" \"%DST%\" >>\"%LOG%\" 2>&1\r\n\
         if not errorlevel 1 goto launch\r\n\
         if %tries% GEQ 60 goto elevate\r\n\
         ping -n 2 127.0.0.1 >NUL 2>&1\r\n\
         goto retry\r\n\
         :launch\r\n\
         echo [%DATE% %TIME%] updated to \"%SRC%\">>\"%LOG%\"\r\n\
         start \"\" \"%DST%\"\r\n\
         goto cleanup\r\n\
         :elevate\r\n\
         echo [%DATE% %TIME%] direct copy to \"%DST%\" failed after %tries% tries, asking for elevation>>\"%LOG%\"\r\n\
         powershell -NoProfile -WindowStyle Hidden -Command \"Start-Process -FilePath '%~f0' -ArgumentList 'elevated' -Verb RunAs -Wait -WindowStyle Hidden\" >>\"%LOG%\" 2>&1\r\n\
         fc /b \"%SRC%\" \"%DST%\" >NUL 2>&1\r\n\
         if errorlevel 1 goto failed\r\n\
         echo [%DATE% %TIME%] updated to \"%SRC%\" via elevation>>\"%LOG%\"\r\n\
         start \"\" \"%DST%\"\r\n\
         goto cleanup\r\n\
         :failed\r\n\
         echo [%DATE% %TIME%] could not replace \"%DST%\" (elevation declined or failed), restarting old version>>\"%LOG%\"\r\n\
         start \"\" \"%DST%\"\r\n\
         goto cleanup\r\n\
         :elevatedcopy\r\n\
         copy /Y \"%SRC%\" \"%DST%\" >>\"%LOG%\" 2>&1\r\n\
         exit /b\r\n\
         :cleanup\r\n\
         del \"%SRC%\" >NUL 2>&1\r\n\
         (goto) 2>NUL & del \"%~f0\"\r\n",
        new_exe = new_exe_path.display(),
        current_exe = current_exe.display(),
        log = log_path.display(),
    );
    std::fs::write(&script_path, script).map_err(|e| e.to_string())?;

    trace(format!(
        "install_and_relaunch script={} target={}",
        script_path.display(),
        current_exe.display()
    ));

    std::process::Command::new("cmd")
        .args(["/C", &script_path.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;

    let _ = proxy.send_event(AppEvent::Quit);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install_and_relaunch(_new_exe_path: PathBuf, _proxy: EventLoopProxy<AppEvent>) -> Result<(), String> {
    Err("Автообновление не поддерживается на этой платформе".to_string())
}

#[cfg(test)]
mod release_signature_tests {
    use super::{is_newer_version, verify_release_signature};

    // Подписано официальным ключом через scripts/release_sign.py (платформа этой
    // сборки — macos: тесты гоняются на машине разработчика).
    const SIG: &str = "NjLWioJB9O/HFOvKHHEa751SuvcDHrzT7Glhpz259+Ja7/dumDeP45GYPvjup7tCzis0y/BmZXqNmFDYJOf/3A==";
    const URL: &str = "https://msgs.zalikus.org/releases/x.exe";

    #[cfg(target_os = "macos")]
    #[test]
    fn accepts_official_signature_and_rejects_tampering() {
        let sha = "ab".repeat(32);
        assert!(verify_release_signature("0.2b99", &sha, URL, SIG));
        assert!(is_newer_version("0.2b62", "0.2b61"));
        assert!(is_newer_version("0.2r1", "0.2b61"));
        assert!(!is_newer_version("0.2b60", "0.2b61"));
        assert!(!is_newer_version("0.2b61", "0.2b61"));
        assert!(!verify_release_signature("0.2b98", &sha, URL, SIG));
        assert!(!verify_release_signature("0.2b99", &sha, "https://evil.example/x.exe", SIG));
        assert!(!verify_release_signature("0.2b99", &"cd".repeat(32), URL, SIG));
        assert!(!verify_release_signature("0.2b99", &sha, URL, ""));
    }
}
