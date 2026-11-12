//! WASAPI-захват в общем режиме: микрофон, loopback устройства вывода (опорный сигнал
//! эхоподавления) и process loopback (звук демонстрации экрана без своего приложения).
//!
//! Формат всегда просим 48 кГц f32 с `AUTOCONVERTPCM` — движок сам пересэмплирует и
//! сведёт каналы, нам не нужен свой ресемплер. Если устройство такой формат с
//! автоконвертацией не приняло (старые драйверы), второй попыткой — 16-бит PCM той же
//! частоты, переводим в f32 сами.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use windows::core::{implement, Interface, Ref, Result, HRESULT};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IMMDevice, AUDCLNT_SHAREMODE_SHARED,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{IAgileObject, IAgileObject_Impl, BLOB, CLSCTX_ALL};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

const STREAMFLAGS_LOOPBACK: u32 = 0x0002_0000;
const STREAMFLAGS_EVENTCALLBACK: u32 = 0x0004_0000;
const STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x0800_0000;
const STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x8000_0000;
const BUFFERFLAGS_SILENT: u32 = 2;
const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// 100 мс буфера движка: запас на подвисание потока, задержку не добавляет
/// (в событийном режиме пакеты забираются по 10 мс).
const BUFFER_HNS: i64 = 1_000_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SampleFormat {
    F32,
    I16,
}

fn wave_format(format: SampleFormat, channels: u16) -> WAVEFORMATEX {
    let bits: u16 = if format == SampleFormat::F32 { 32 } else { 16 };
    let block = channels * bits / 8;
    WAVEFORMATEX {
        wFormatTag: if format == SampleFormat::F32 { WAVE_FORMAT_IEEE_FLOAT } else { WAVE_FORMAT_PCM },
        nChannels: channels,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * block as u32,
        nBlockAlign: block,
        wBitsPerSample: bits,
        cbSize: 0,
    }
}

pub struct WasapiCapture {
    // Порядок полей = порядок освобождения: сначала клиент захвата, потом сам клиент.
    capture: IAudioCaptureClient,
    client: IAudioClient,
    event: HANDLE,
    format: SampleFormat,
    pub channels: usize,
}

// Объекты созданы в MTA и живут в одном потоке захвата; переносятся между потоками
// только при создании (process loopback активируется асинхронно).
unsafe impl Send for WasapiCapture {}

impl WasapiCapture {
    /// Микрофон (`loopback = false`) или loopback устройства вывода.
    pub fn open_endpoint(device: &IMMDevice, channels: u16, loopback: bool) -> Result<Self> {
        let extra = if loopback { STREAMFLAGS_LOOPBACK } else { 0 };
        let mut last = None;
        for format in [SampleFormat::F32, SampleFormat::I16] {
            let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None)? };
            match Self::init(client, format, channels, extra) {
                Ok(capture) => return Ok(capture),
                Err(error) => {
                    // Нет доступа или устройства — вторая попытка не поможет.
                    if matches!(super::format::error_code_for_hresult(error.code().0), "permission" | "not_found" | "busy") {
                        return Err(error);
                    }
                    last = Some(error);
                }
            }
        }
        Err(last.unwrap_or_else(windows::core::Error::empty))
    }

    /// Звук всей системы, кроме дерева процессов этого приложения (сам клиент и его
    /// процессы WebView2 — голоса собеседников, звуки интерфейса). Windows 10 2004+.
    pub fn open_process_loopback_excluding_self(channels: u16) -> Result<Self> {
        let mut last = None;
        for format in [SampleFormat::F32, SampleFormat::I16] {
            let client = activate_process_loopback(unsafe { GetCurrentProcessId() })?;
            match Self::init(client, format, channels, STREAMFLAGS_LOOPBACK) {
                Ok(capture) => return Ok(capture),
                Err(error) => last = Some(error),
            }
        }
        Err(last.unwrap_or_else(windows::core::Error::empty))
    }

    fn init(client: IAudioClient, format: SampleFormat, channels: u16, extra_flags: u32) -> Result<Self> {
        let wfx = wave_format(format, channels);
        let flags = STREAMFLAGS_EVENTCALLBACK | STREAMFLAGS_AUTOCONVERTPCM | STREAMFLAGS_SRC_DEFAULT_QUALITY | extra_flags;
        unsafe {
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER_HNS, 0, &wfx, None)?;
            let event = CreateEventW(None, false, false, None)?;
            if let Err(error) = client.SetEventHandle(event) {
                let _ = CloseHandle(event);
                return Err(error);
            }
            let capture: IAudioCaptureClient = match client.GetService() {
                Ok(capture) => capture,
                Err(error) => {
                    let _ = CloseHandle(event);
                    return Err(error);
                }
            };
            Ok(Self { capture, client, event, format, channels: channels as usize })
        }
    }

    pub fn start(&self) -> Result<()> {
        unsafe { self.client.Start() }
    }

    /// Ждёт пакетов до `timeout_ms` и дописывает в `out` всё, что накопилось
    /// (чередующиеся отсчёты f32). Ждём с таймаутом и забираем всё в любом случае:
    /// loopback устройства вывода на части систем не сигналит событием.
    /// Ошибка — устройство пропало (`AUDCLNT_E_DEVICE_INVALIDATED`) или поток умер.
    pub fn read(&self, timeout_ms: u32, out: &mut Vec<f32>) -> Result<()> {
        unsafe {
            // Таймаут — не ошибка: всё равно проверяем, нет ли пакетов.
            let _ = WaitForSingleObject(self.event, timeout_ms);
            loop {
                let packet = self.capture.GetNextPacketSize()?;
                if packet == 0 {
                    return Ok(());
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let count = frames as usize * self.channels;
                if flags & BUFFERFLAGS_SILENT != 0 || data.is_null() {
                    out.resize(out.len() + count, 0.0);
                } else if self.format == SampleFormat::F32 {
                    out.extend_from_slice(std::slice::from_raw_parts(data as *const f32, count));
                } else {
                    let src = std::slice::from_raw_parts(data as *const i16, count);
                    out.extend(src.iter().map(|&s| s as f32 / 32768.0));
                }
                self.capture.ReleaseBuffer(frames)?;
            }
        }
    }
}

impl Drop for WasapiCapture {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

// --- process loopback: асинхронная активация --------------------------------------

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct ActivationHandler {
    done: std::sync::Mutex<Option<mpsc::Sender<()>>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(&self, _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        if let Some(tx) = self.done.lock().ok().and_then(|mut g| g.take()) {
            let _ = tx.send(());
        }
        Ok(())
    }
}

impl IAgileObject_Impl for ActivationHandler_Impl {}

fn activate_process_loopback(pid: u32) -> Result<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let prop = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: &mut params as *mut _ as *mut u8,
                    },
                },
            }),
        },
    };
    let (tx, rx) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler =
        ActivationHandler { done: std::sync::Mutex::new(Some(tx)) }.into();
    unsafe {
        let operation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&prop),
            &handler,
        )?;
        // PROPVARIANT ссылается на стековую структуру — не очищаем (PropVariantClear
        // попытался бы освободить её через CoTaskMemFree).
        if rx.recv_timeout(Duration::from_secs(5)).is_err() {
            return Err(windows::core::Error::from(HRESULT(0x8000_000Au32 as i32))); // E_PENDING
        }
        let mut hr = HRESULT(0);
        let mut unknown = None;
        operation.GetActivateResult(&mut hr, &mut unknown)?;
        hr.ok()?;
        unknown
            .ok_or_else(windows::core::Error::empty)?
            .cast::<IAudioClient>()
    }
}

// --- опорный сигнал эхоподавления ---------------------------------------------------

/// Поток: loopback устройства вывода по умолчанию → `on_render(samples, channels)`.
/// Устройство вывода сменилось (наушники) или пропало — переоткрываем по умолчанию.
pub fn run_render_reference(stop: Arc<AtomicBool>, mut on_render: impl FnMut(&[f32], usize), on_state: impl Fn(bool)) {
    let _com = super::com::ComGuard::new();
    let mut buf = Vec::with_capacity(4800);
    while !stop.load(Ordering::Acquire) {
        let opened = super::devices::enumerator()
            .and_then(|e| unsafe { e.GetDefaultAudioEndpoint(eRender, eConsole) })
            .and_then(|device| WasapiCapture::open_endpoint(&device, 2, true))
            .and_then(|cap| cap.start().map(|_| cap));
        let capture = match opened {
            Ok(capture) => capture,
            Err(error) => {
                tracing::warn!("[ZALI][WIN] media render reference unavailable: {error}");
                on_state(false);
                sleep_unless_stopped(&stop, 2000);
                continue;
            }
        };
        on_state(true);
        while !stop.load(Ordering::Acquire) {
            buf.clear();
            if capture.read(10, &mut buf).is_err() {
                break;
            }
            if !buf.is_empty() {
                on_render(&buf, capture.channels);
            }
        }
        on_state(false);
        sleep_unless_stopped(&stop, 300);
    }
}

pub fn sleep_unless_stopped(stop: &AtomicBool, ms: u64) {
    let mut left = ms;
    while left > 0 && !stop.load(Ordering::Acquire) {
        let step = left.min(50);
        std::thread::sleep(Duration::from_millis(step));
        left -= step;
    }
}
