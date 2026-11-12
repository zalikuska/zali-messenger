//! Мелочи для потоков захвата: COM на поток, время, строки, коды ошибок.

use std::sync::OnceLock;
use std::time::Instant;
use windows::core::{HRESULT, PWSTR};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};

/// COM в многопоточном апартаменте на время жизни потока захвата.
pub struct ComGuard {
    initialized: bool,
}

impl ComGuard {
    pub fn new() -> Self {
        // S_FALSE (уже инициализирован) — тоже успех, парный CoUninitialize нужен.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Self { initialized: hr.is_ok() }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { CoUninitialize() };
        }
    }
}

/// Монотонные микросекунды от старта процесса — метка времени кадров.
pub fn now_us() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/// Строка, выделенная через CoTaskMemAlloc, → String (и освобождение).
pub unsafe fn take_co_string(raw: PWSTR) -> String {
    if raw.is_null() {
        return String::new();
    }
    let text = raw.to_string().unwrap_or_default();
    CoTaskMemFree(Some(raw.0 as *const _));
    text
}

pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// Код протокола и текст для ошибки Windows API.
pub fn describe(error: &windows::core::Error) -> (&'static str, String) {
    let hr: HRESULT = error.code();
    (
        super::format::error_code_for_hresult(hr.0),
        format!("{} (0x{:08X})", error.message().trim(), hr.0 as u32),
    )
}
