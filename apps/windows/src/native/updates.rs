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
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED_PROCESS: u32 = 0x00000008;

    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pid = std::process::id();
    let dir = updates_dir();
    let script_path = dir.join(format!("relaunch-{}.cmd", uuid::Uuid::new_v4()));
    let script = format!(
        "@echo off\r\n\
         :wait\r\n\
         tasklist /FI \"PID eq {pid}\" 2>NUL | find \"{pid}\" >NUL\r\n\
         if not errorlevel 1 (\r\n\
         timeout /T 1 /NOBREAK >NUL\r\n\
         goto wait\r\n\
         )\r\n\
         copy /Y \"{new_exe}\" \"{current_exe}\" >NUL\r\n\
         start \"\" \"{current_exe}\"\r\n\
         del \"{new_exe}\" >NUL 2>&1\r\n\
         del \"%~f0\"\r\n",
        pid = pid,
        new_exe = new_exe_path.display(),
        current_exe = current_exe.display(),
    );
    std::fs::write(&script_path, script).map_err(|e| e.to_string())?;

    std::process::Command::new("cmd")
        .args(["/C", &script_path.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| e.to_string())?;

    let _ = proxy.send_event(AppEvent::Quit);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install_and_relaunch(_new_exe_path: PathBuf, _proxy: EventLoopProxy<AppEvent>) -> Result<(), String> {
    Err("Автообновление не поддерживается на этой платформе".to_string())
}
