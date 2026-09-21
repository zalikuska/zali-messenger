//! «Запускать при входе в Windows» — свёрнутым в трей.
//!
//! До этого автозапуск ставила только галочка онлайн-установщика (запись `Run` в
//! `ZaliMessenger.iss`). Кто запускал `.exe` напрямую — скачанный руками или
//! поставленный до установщика — жил без автозапуска вообще, а переключить его из
//! приложения было нельзя. Для мессенджера это не мелочь: не запущенное приложение
//! не получает ни сообщений, ни звонков, и уведомлений на Windows нет совсем.
//!
//! Поэтому приложение прописывает себя само, при каждом старте релизной сборки, и
//! переписывает путь, если `.exe` переехал. Отказ пользователя хранится отдельно и
//! уважается:
//! - переключатель в настройках пишет `HKCU\Software\ZaliMessenger\AutostartDisabled`;
//! - снятая галочка установщика пишет туда же;
//! - «Отключить» в Диспетчере задач (вкладка «Автозагрузка») Windows хранит в
//!   `StartupApproved\Run`, оставляя запись `Run` на месте, — её перезапись путь не
//!   трогает, так что и этот выбор переживает запуск. Включение из настроек его снимает.
//!
//! Флаг `--start-minimized` уже понимает `main.rs`: окно не показывается, остаётся
//! значок в трее. Всё — HKCU, без повышения прав.

use serde::Serialize;

/// Аргумент, с которым приложение запускается из автозапуска (`main.rs`).
pub(crate) const START_MINIMIZED_ARG: &str = "--start-minimized";

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutostartStatus {
    /// Приложение действительно стартует при входе: запись есть и не отключена.
    pub enabled: bool,
    /// Запись есть, но выключена в Диспетчере задач.
    pub blocked_by_system: bool,
}

#[cfg(target_os = "windows")]
pub(crate) fn register_autostart_on_launch() {
    imp::register_on_launch();
}

pub(crate) fn autostart_status() -> AutostartStatus {
    imp::status()
}

pub(crate) fn set_autostart(enabled: bool) -> Result<AutostartStatus, String> {
    imp::set(enabled)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{AutostartStatus, START_MINIMIZED_ARG};
    use tracing::{error, info};
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteKeyValueW, RegGetValueW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
        RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APPROVED_KEY: &str =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    /// Имя совпадает с записью установщика — это одна и та же запись.
    const RUN_VALUE: &str = "ZaliMessenger";
    const PREFS_KEY: &str = "Software\\ZaliMessenger";
    const OPT_OUT_VALUE: &str = "AutostartDisabled";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn command_line() -> Option<String> {
        let exe = std::env::current_exe().ok()?;
        Some(format!("\"{}\" {}", exe.display(), START_MINIMIZED_ARG))
    }

    /// Сырые байты значения, `None` — если его нет.
    fn read_raw(subkey: &str, name: &str, flags: u32) -> Option<Vec<u8>> {
        let subkey = wide(subkey);
        let name = wide(name);
        let mut size: u32 = 0;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                flags,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        if buf.is_empty() {
            return Some(buf);
        }
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                flags,
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut _,
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        buf.truncate(size as usize);
        Some(buf)
    }

    fn read_string(subkey: &str, name: &str) -> Option<String> {
        let raw = read_raw(subkey, name, RRF_RT_REG_SZ)?;
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        Some(String::from_utf16_lossy(&units))
    }

    fn write_value(subkey: &str, name: &str, kind: u32, data: &[u8]) -> Result<(), String> {
        let subkey_w = wide(subkey);
        let name_w = wide(name);
        let mut key: HKEY = std::ptr::null_mut();
        unsafe {
            let status = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey_w.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            );
            if status != ERROR_SUCCESS {
                return Err(format!("RegCreateKeyExW {} status={}", subkey, status));
            }
            let status = RegSetValueExW(key, name_w.as_ptr(), 0, kind, data.as_ptr(), data.len() as u32);
            RegCloseKey(key);
            if status != ERROR_SUCCESS {
                return Err(format!("RegSetValueExW {}\\{} status={}", subkey, name, status));
            }
        }
        Ok(())
    }

    fn write_string(subkey: &str, name: &str, value: &str) -> Result<(), String> {
        let bytes: Vec<u8> = wide(value).iter().flat_map(|unit| unit.to_le_bytes()).collect();
        write_value(subkey, name, REG_SZ, &bytes)
    }

    fn delete_value(subkey: &str, name: &str) -> Result<(), String> {
        let subkey_w = wide(subkey);
        let name_w = wide(name);
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, subkey_w.as_ptr(), name_w.as_ptr()) };
        if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("RegDeleteKeyValueW {}\\{} status={}", subkey, name, status))
        }
    }

    fn opted_out() -> bool {
        read_raw(PREFS_KEY, OPT_OUT_VALUE, RRF_RT_REG_DWORD)
            .map(|raw| raw.first().copied().unwrap_or(0) != 0)
            .unwrap_or(false)
    }

    /// Диспетчер задач хранит «отключено» первым байтом записи: чётный — включено
    /// (02, 06), нечётный — выключено (03, 07).
    fn blocked_by_system() -> bool {
        read_raw(APPROVED_KEY, RUN_VALUE, RRF_RT_REG_BINARY)
            .and_then(|raw| raw.first().copied())
            .map(|flag| flag & 1 == 1)
            .unwrap_or(false)
    }

    /// Жив ли файл, на который указывает уже записанная команда автозапуска.
    /// Команда имеет вид `"C:\...\ZaliMessenger.exe" --start-minimized`.
    fn recorded_exe_alive(command: &str) -> bool {
        let trimmed = command.trim();
        let path = match trimmed.strip_prefix('"') {
            Some(rest) => rest.split('"').next().unwrap_or(""),
            None => trimmed.split_whitespace().next().unwrap_or(""),
        };
        !path.is_empty() && std::path::Path::new(path).is_file()
    }

    pub(super) fn register_on_launch() {
        // `cargo run` не должен прописывать в автозагрузку отладочный бинарник из
        // target/. Переключатель в настройках работает и там — это явный выбор.
        if cfg!(debug_assertions) || opted_out() {
            return;
        }
        let Some(wanted) = command_line() else {
            return;
        };
        // Запись перехватывается ТОЛЬКО если её некому исполнять. Иначе разовый запуск
        // второй копии (скачанный `.exe` из «Загрузок» при установленной в Program Files)
        // переводил автозапуск на себя, и после удаления этой копии Windows молча
        // запускала несуществующий путь — а настройки показывали «включено», потому что
        // значение в реестре есть. Мёртвый путь, наоборот, чиним: это наш же переехавший exe.
        match read_string(RUN_KEY, RUN_VALUE) {
            Some(existing) if existing == wanted => return,
            Some(existing) if recorded_exe_alive(&existing) => {
                info!("autostart kept as is: owned by {}", existing);
                return;
            }
            _ => {}
        }
        match write_string(RUN_KEY, RUN_VALUE, &wanted) {
            Ok(()) => info!("autostart registered: {}", wanted),
            Err(error) => error!("autostart registration failed: {}", error),
        }
    }

    pub(super) fn status() -> AutostartStatus {
        let registered = !opted_out() && read_string(RUN_KEY, RUN_VALUE).is_some();
        let blocked = registered && blocked_by_system();
        AutostartStatus {
            enabled: registered && !blocked,
            blocked_by_system: blocked,
        }
    }

    pub(super) fn set(enabled: bool) -> Result<AutostartStatus, String> {
        if enabled {
            let wanted = command_line().ok_or_else(|| "Не удалось определить путь к приложению".to_string())?;
            write_string(RUN_KEY, RUN_VALUE, &wanted)?;
            delete_value(PREFS_KEY, OPT_OUT_VALUE)?;
            // Отключение из Диспетчера задач снимается явным включением здесь —
            // иначе переключатель встал бы во «вкл», а Windows всё равно не запускала бы.
            delete_value(APPROVED_KEY, RUN_VALUE)?;
        } else {
            write_value(PREFS_KEY, OPT_OUT_VALUE, REG_DWORD, &1u32.to_le_bytes())?;
            delete_value(RUN_KEY, RUN_VALUE)?;
        }
        info!("autostart set enabled={}", enabled);
        Ok(status())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::AutostartStatus;

    pub(super) fn status() -> AutostartStatus {
        AutostartStatus::default()
    }

    pub(super) fn set(_enabled: bool) -> Result<AutostartStatus, String> {
        Err("Автозапуск настраивается только в Windows".to_string())
    }
}
