//! Кадры в страницу через общую память WebView2.
//!
//! `ICoreWebView2Environment12::CreateSharedBuffer` → копия кадра в буфер →
//! `ICoreWebView2_17::PostSharedBufferToScript(READ_ONLY)` → страница получает
//! `sharedbufferreceived`, копирует данные (VideoFrame/AudioData) и сразу зовёт
//! `chrome.webview.releaseBuffer`.
//!
//! Буфер на каждый кадр, `Close()` сразу после отправки. Переиспользовать буфер по
//! кругу нельзя: страница не сообщает, что уже скопировала кадр, а запись в буфер,
//! который она ещё читает, даёт рваный кадр. `Close()` освобождает только наше
//! отображение памяти — у страницы своё, и оно живёт до `releaseBuffer`. Создание
//! буфера — это отображение файла в память, на 30 кадрах 1080p это доли миллисекунды.
//!
//! Только верхний документ `zali.localhost`: `ICoreWebView2_17::PostSharedBufferToScript`
//! и так адресует верхний фрейм (не песочницу аддона), а адрес документа проверяется
//! перед каждой отправкой — если в вебвью вдруг окажется чужая страница, кадры ей не
//! уйдут.

use super::format::is_app_document;
use super::MediaFrame;
use std::time::{Duration, Instant};
use tracing::warn;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Environment12, ICoreWebView2_17, ICoreWebView2_2,
    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
};
use windows052::core::{w, ComInterface, PWSTR};
use wry::{WebView, WebViewExtWindows};

/// Адрес верхнего документа перепроверяется не чаще раза в 500 мс.
const ORIGIN_CHECK_INTERVAL: Duration = Duration::from_millis(500);

struct Target {
    core: ICoreWebView2,
    webview17: ICoreWebView2_17,
    environment: ICoreWebView2Environment12,
}

#[derive(Default)]
pub struct Poster {
    target: Option<Target>,
    /// Интерфейсы недоступны (старый WebView2 Runtime) — больше не пытаться.
    unavailable: bool,
    origin_ok: bool,
    origin_checked_at: Option<Instant>,
    failures: u32,
}

impl Poster {
    fn target(&mut self, webview: &WebView) -> Option<&Target> {
        if self.target.is_none() && !self.unavailable {
            match Self::resolve(webview) {
                Ok(target) => self.target = Some(target),
                Err(error) => {
                    // Без ICoreWebView2_17/Environment12 (WebView2 Runtime < 1.0.1661)
                    // кадры не доставить; страница не получит первого кадра и уйдёт в
                    // getUserMedia по своему таймауту.
                    warn!("[ZALI][WIN] media shared buffer unavailable: {error}");
                    self.unavailable = true;
                }
            }
        }
        self.target.as_ref()
    }

    fn resolve(webview: &WebView) -> windows052::core::Result<Target> {
        unsafe {
            let controller = webview.controller();
            let core = controller.CoreWebView2()?;
            let webview17: ICoreWebView2_17 = core.cast()?;
            let core2: ICoreWebView2_2 = core.cast()?;
            let environment: ICoreWebView2Environment12 = core2.Environment()?.cast()?;
            Ok(Target { core, webview17, environment })
        }
    }

    fn origin_allowed(&mut self) -> bool {
        let fresh = self
            .origin_checked_at
            .map(|at| at.elapsed() < ORIGIN_CHECK_INTERVAL)
            .unwrap_or(false);
        if fresh {
            return self.origin_ok;
        }
        let Some(target) = self.target.as_ref() else {
            return false;
        };
        let url = unsafe {
            let mut raw = PWSTR::null();
            if target.core.Source(&mut raw).is_err() || raw.is_null() {
                String::new()
            } else {
                let text = raw.to_string().unwrap_or_default();
                windows::Win32::System::Com::CoTaskMemFree(Some(raw.0 as *const _));
                text
            }
        };
        self.origin_ok = is_app_document(&url);
        self.origin_checked_at = Some(Instant::now());
        self.origin_ok
    }

    /// Отправить кадр странице. Ошибки не роняют поток окна: кадр просто теряется.
    /// `true` — общая память только что оказалась недоступна (старый WebView2 Runtime):
    /// вызывающий говорит странице выключить нативный захват, иначе каждый захват
    /// ждал бы кадра до таймаута страницы.
    pub fn post(&mut self, webview: &WebView, frame: &MediaFrame) -> bool {
        let bytes = frame.bytes();
        if bytes.is_empty() {
            return false;
        }
        let was_unavailable = self.unavailable;
        if self.target(webview).is_none() {
            return !was_unavailable && self.unavailable;
        }
        if !self.origin_allowed() {
            return false;
        }
        let Some(target) = self.target.as_ref() else {
            return false;
        };
        let result = unsafe {
            (|| -> windows052::core::Result<()> {
                let buffer = target.environment.CreateSharedBuffer(bytes.len() as u64)?;
                let mut ptr: *mut u8 = std::ptr::null_mut();
                let posted = buffer.Buffer(&mut ptr).and_then(|_| {
                    if ptr.is_null() {
                        return Err(windows052::core::Error::from(windows052::Win32::Foundation::E_POINTER));
                    }
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
                    target.webview17.PostSharedBufferToScript(
                        &buffer,
                        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                        // Валидный JSON → event.additionalData === null в странице.
                        w!("null"),
                    )
                });
                let _ = buffer.Close();
                posted
            })()
        };
        match result {
            Ok(()) => self.failures = 0,
            Err(error) => {
                self.failures += 1;
                if self.failures == 1 || self.failures % 300 == 0 {
                    warn!("[ZALI][WIN] media frame post failed ({}x): {error}", self.failures);
                }
            }
        }
        false
    }
}
