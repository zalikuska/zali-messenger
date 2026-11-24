//! Экран и окна: Windows.Graphics.Capture (Windows 10 1903+).
//!
//! * Список источников — мониторы (`EnumDisplayMonitors`) и окна верхнего уровня, как
//!   в Alt+Tab, кроме окон самого приложения; превью — один кадр WGC, уменьшенный и
//!   сжатый WIC в JPEG.
//! * Захват — `Direct3D11CaptureFramePool` (free-threaded), BGRA → NV12 с
//!   масштабированием через D3D11 VideoProcessor на GPU (BT.709 limited — так Chromium
//!   понимает NV12 `VideoFrame` без `colorSpace`), затем staging-текстура → плотный
//!   NV12 в кадр. Нет VideoProcessor — тот же перевод на CPU (`format::bgra_to_nv12`).
//! * Звук демонстрации — process loopback без дерева процессов приложения, стерео
//!   f32 тем же `stream` (`loopback::WasapiCapture::open_process_loopback_excluding_self`).
//!
//! id источника: `display:<HMONITOR>` / `window:<HWND>` — стабилен, пока источник жив.

use super::com::{now_us, ComGuard};
use super::format::{
    audio_frame, Source, bgra_to_nv12, downscale_bgra, encode_header, fit_even, nv12_len, pack_nv12, FrameHeader, HEADER_LEN,
};
use super::h264_mf::LayerEncoder;
use super::EventSink;
use super::hub::StartContext;
use super::loopback::{sleep_unless_stopped, WasapiCapture};
use base64::Engine as _;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use zali_messenger_core::sfu_publisher::{LayerConfig, PublisherConfig, SfuPublisher, VideoCodec};
use windows::core::{factory, Interface, Result, BOOL, PWSTR};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{CloseHandle, E_FAIL, HMODULE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW, DEVMODEW, ENUM_CURRENT_SETTINGS, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR, IWICImagingFactory,
    WICBitmapEncoderNoCache,
};
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, GA_ROOT, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

const MONITORINFOF_PRIMARY: u32 = 1;
const THUMB_BUDGET: Duration = Duration::from_secs(6);
/// WGC отдаёт кадр только при изменении картинки. На неподвижном экране новый участник
/// (у каждого собеседника свой кодировщик WebRTC) не получил бы ни одного кадра, пока
/// там ничего не сдвинется, — повторяем последний кадр не реже раза в секунду.
const IDLE_REPEAT: Duration = Duration::from_secs(1);
/// Во сколько раз потолок слоя SFU выше его расчётного битрейта (пиксели × к/с × bpp
/// страницы): запас активной сцене, но не весь канал. 1080p60 → ~15 Мбит/с, 540p60 → ~3,7.
const LAYER_TARGET_HEADROOM: f64 = 1.5;

// --- источники -----------------------------------------------------------------------

fn hmonitor(v: isize) -> HMONITOR {
    HMONITOR(v as *mut _)
}

fn hwnd(v: isize) -> HWND {
    HWND(v as *mut _)
}

struct DisplayInfo {
    handle: isize,
    primary: bool,
    width: i32,
    height: i32,
}

unsafe extern "system" fn monitor_proc(monitor: HMONITOR, _hdc: HDC, _rect: *mut RECT, data: LPARAM) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<DisplayInfo>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
        let r = info.monitorInfo.rcMonitor;
        out.push(DisplayInfo {
            handle: monitor.0 as isize,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            width: r.right - r.left,
            height: r.bottom - r.top,
        });
    }
    true.into()
}

fn displays() -> Vec<DisplayInfo> {
    let mut out: Vec<DisplayInfo> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(monitor_proc), LPARAM(&mut out as *mut _ as isize));
    }
    // Основной экран первым — он же «по умолчанию».
    out.sort_by_key(|d| !d.primary);
    out
}

struct WindowInfo {
    handle: isize,
    title: String,
    app: String,
    minimized: bool,
    /// Окно самого мессенджера: его можно показать, но звук для него собирает страница
    /// (звук приложения без звонка, web/src/interface/share_audio.js), не оболочка.
    own: bool,
}

unsafe extern "system" fn window_proc(hwnd: HWND, data: LPARAM) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<isize>);
    out.push(hwnd.0 as isize);
    true.into()
}

fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

/// Окна «как в Alt+Tab»: видимые, не скрытые DWM (фоновые UWP), не служебные, с
/// заголовком, верхнего уровня. Окно мессенджера тоже в списке (`own`) — его можно
/// показать в звонке.
fn windows_list() -> Vec<WindowInfo> {
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(window_proc), LPARAM(&mut handles as *mut _ as isize));
    }
    let own_pid = unsafe { GetCurrentProcessId() };
    let mut out = Vec::new();
    for raw in handles {
        let hwnd = hwnd(raw);
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetAncestor(hwnd, GA_ROOT) != hwnd {
                continue;
            }
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
                continue;
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0 {
                continue;
            }
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                continue;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let own = pid == own_pid;
            let mut buf = vec![0u16; len as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..copied.max(0) as usize]);
            if title.trim().is_empty() {
                continue;
            }
            let app = process_name(pid);
            // Рабочий стол и панель задач — это «экран», а не окно.
            if app.eq_ignore_ascii_case("explorer") && (title == "Program Manager" || title.is_empty()) {
                continue;
            }
            out.push(WindowInfo { handle: raw, title, app, minimized: IsIconic(hwnd).as_bool(), own });
        }
    }
    out
}

// --- D3D11 / WGC ---------------------------------------------------------------------

struct D3d {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt: IDirect3DDevice,
}

impl D3d {
    fn new() -> Result<Self> {
        unsafe {
            let mut device = None;
            let mut context = None;
            let base = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
            // VIDEO_SUPPORT нужен VideoProcessor'у; без него (редкие драйверы) — CPU-путь.
            let created = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                base | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );
            if created.is_err() {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    base,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )?;
            }
            let device = device.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
            let context = context.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
            // Пул кадров WGC пишет в текстуры этого устройства из своего потока.
            if let Ok(mt) = device.cast::<ID3D11Multithread>() {
                let _ = mt.SetMultithreadProtected(true);
            }
            let dxgi: IDXGIDevice = device.cast()?;
            let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
            Ok(Self { device, context, winrt })
        }
    }

    fn texture_desc(texture: &ID3D11Texture2D) -> D3D11_TEXTURE2D_DESC {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        desc
    }

    fn create_texture(&self, width: u32, height: u32, format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT, usage: D3D11_USAGE, bind: u32, cpu: u32) -> Result<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: usage,
            BindFlags: bind,
            CPUAccessFlags: cpu,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut texture))? };
        texture.ok_or_else(|| windows::core::Error::from(E_FAIL))
    }
}

fn create_item(source: Source) -> Result<GraphicsCaptureItem> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    unsafe {
        match source {
            Source::Display(h) => interop.CreateForMonitor(hmonitor(h)),
            Source::Window(h) => interop.CreateForWindow(hwnd(h)),
        }
    }
}

fn frame_texture(frame: &Direct3D11CaptureFrame) -> Result<ID3D11Texture2D> {
    let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
    unsafe { access.GetInterface::<ID3D11Texture2D>() }
}

struct Capture {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    pool_size: SizeInt32,
}

impl Capture {
    fn start(d3d: &D3d, item: &GraphicsCaptureItem, buffers: i32, cursor: bool) -> Result<Self> {
        let size = item.Size()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, buffers, size)?;
        let session = pool.CreateCaptureSession(item)?;
        let _ = session.SetIsCursorCaptureEnabled(cursor);
        // Жёлтая рамка вокруг захватываемого: на Windows 11 её можно убрать, на 10 —
        // метод отсутствует или требует разрешения; ошибка не мешает захвату.
        let _ = session.SetIsBorderRequired(false);
        session.StartCapture()?;
        Ok(Self { pool, session, pool_size: size })
    }

    /// Самый свежий кадр из пула (старые выбрасываются).
    fn latest(&self) -> Option<Direct3D11CaptureFrame> {
        let mut last = None;
        while let Ok(frame) = self.pool.TryGetNextFrame() {
            last = Some(frame);
        }
        last
    }

    fn resize_if_needed(&mut self, d3d: &D3d, content: SizeInt32) {
        if content.Width > 0 && content.Height > 0 && (content.Width != self.pool_size.Width || content.Height != self.pool_size.Height) {
            if self.pool.Recreate(&d3d.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, content).is_ok() {
                self.pool_size = content;
            }
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// Кадр BGRA с GPU в память (`content_w × content_h`, плотно).
fn read_bgra(d3d: &D3d, texture: &ID3D11Texture2D, content_w: u32, content_h: u32) -> Result<(Vec<u8>, usize, usize)> {
    let desc = D3d::texture_desc(texture);
    let w = content_w.min(desc.Width);
    let h = content_h.min(desc.Height);
    let staging = d3d.create_texture(desc.Width, desc.Height, desc.Format, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ.0 as u32)?;
    unsafe {
        d3d.context.CopyResource(&staging, texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        d3d.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let pitch = mapped.RowPitch as usize;
        let src = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * desc.Height as usize);
        let mut out = Vec::with_capacity(w as usize * h as usize * 4);
        for row in 0..h as usize {
            out.extend_from_slice(&src[row * pitch..row * pitch + w as usize * 4]);
        }
        d3d.context.Unmap(&staging, 0);
        Ok((out, w as usize, h as usize))
    }
}

// --- BGRA → NV12 на GPU --------------------------------------------------------------

struct Nv12Converter {
    video_context: ID3D11VideoContext,
    processor: ID3D11VideoProcessor,
    input: ID3D11Texture2D,
    input_view: ID3D11VideoProcessorInputView,
    output_view: ID3D11VideoProcessorOutputView,
    output: ID3D11Texture2D,
    staging: ID3D11Texture2D,
    /// Вторая staging-текстура и состояние конвейера для слоёв SFU (`convert_pipelined`).
    staging2: ID3D11Texture2D,
    next_staging: usize,
    pending: Option<usize>,
    in_w: u32,
    in_h: u32,
    out_w: u32,
    out_h: u32,
}

/// D3D11_VIDEO_PROCESSOR_COLOR_SPACE: Usage:1 | RGB_Range:1 | YCbCr_Matrix:1 | xvYCC:1 | Nominal_Range:2.
const COLOR_SPACE_INPUT_RGB_FULL: u32 = 0; // RGB 0–255
const COLOR_SPACE_OUTPUT_709_STUDIO: u32 = (1 << 2) | (1 << 4); // BT.709, 16–235

impl Nv12Converter {
    fn new(d3d: &D3d, in_w: u32, in_h: u32, out_w: u32, out_h: u32) -> Result<Self> {
        unsafe {
            let video_device: ID3D11VideoDevice = d3d.device.cast()?;
            let video_context: ID3D11VideoContext = d3d.context.cast()?;
            let rate = DXGI_RATIONAL { Numerator: 30, Denominator: 1 };
            let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: in_w,
                InputHeight: in_h,
                OutputFrameRate: rate,
                OutputWidth: out_w,
                OutputHeight: out_h,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = video_device.CreateVideoProcessorEnumerator(&content)?;
            let processor = video_device.CreateVideoProcessor(&enumerator, 0)?;

            let input = d3d.create_texture(in_w, in_h, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_USAGE_DEFAULT, (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32, 0)?;
            let output = d3d.create_texture(out_w, out_h, DXGI_FORMAT_NV12, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET.0 as u32, 0)?;
            let staging = d3d.create_texture(out_w, out_h, DXGI_FORMAT_NV12, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ.0 as u32)?;
            let staging2 = d3d.create_texture(out_w, out_h, DXGI_FORMAT_NV12, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ.0 as u32)?;

            let in_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut input_view = None;
            video_device.CreateVideoProcessorInputView(&input, &enumerator, &in_desc, Some(&mut input_view))?;
            let out_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut output_view = None;
            video_device.CreateVideoProcessorOutputView(&output, &enumerator, &out_desc, Some(&mut output_view))?;

            video_context.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: COLOR_SPACE_INPUT_RGB_FULL });
            video_context.VideoProcessorSetOutputColorSpace(&processor, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: COLOR_SPACE_OUTPUT_709_STUDIO });
            let out_rect = RECT { left: 0, top: 0, right: out_w as i32, bottom: out_h as i32 };
            video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&out_rect));
            video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&out_rect));
            // Поля вокруг вписанной картинки (окно сменило пропорции) — чёрные.
            let black = D3D11_VIDEO_COLOR { Anonymous: D3D11_VIDEO_COLOR_0 { RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.0, G: 0.0, B: 0.0, A: 1.0 } } };
            video_context.VideoProcessorSetOutputBackgroundColor(&processor, false, &black);

            Ok(Self {
                video_context,
                processor,
                input,
                input_view: input_view.ok_or_else(|| windows::core::Error::from(E_FAIL))?,
                output_view: output_view.ok_or_else(|| windows::core::Error::from(E_FAIL))?,
                output,
                staging,
                staging2,
                next_staging: 0,
                pending: None,
                in_w,
                in_h,
                out_w,
                out_h,
            })
        }
    }

    /// Кадр → NV12 на GPU в `output` (без выгрузки).
    fn blit(&self, d3d: &D3d, texture: &ID3D11Texture2D, content_w: u32, content_h: u32) -> Result<()> {
        unsafe {
            d3d.context.CopyResource(&self.input, texture);
            let (cw, ch) = (content_w.min(self.in_w).max(1), content_h.min(self.in_h).max(1));
            let src_rect = RECT { left: 0, top: 0, right: cw as i32, bottom: ch as i32 };
            self.video_context.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&src_rect));
            let dest = letterbox_rect(cw, ch, self.out_w, self.out_h);
            self.video_context.VideoProcessorSetStreamDestRect(&self.processor, 0, true, Some(&dest));
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: std::mem::ManuallyDrop::new(Some(self.input_view.clone())),
                ..Default::default()
            };
            let streams = [stream];
            let blt = self.video_context.VideoProcessorBlt(&self.processor, &self.output_view, 0, &streams);
            let [mut stream] = streams;
            std::mem::ManuallyDrop::drop(&mut stream.pInputSurface);
            blt
        }
    }

    fn read_staging(&self, d3d: &D3d, index: usize, payload: &mut Vec<u8>) -> Result<bool> {
        let staging = if index == 0 { &self.staging } else { &self.staging2 };
        // pack_nv12 ДОПИСЫВАЕТ: без очистки кадр склеивался с прошлым, не сходился по размеру
        // и выбрасывался — 1080p уходил на 1 к/с одними повторами (живой Windows 2026-11-22).
        payload.clear();
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            d3d.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let pitch = mapped.RowPitch as usize;
            let h = self.out_h as usize;
            let bytes = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * (h + h / 2));
            let ok = pack_nv12(&bytes[..pitch * h], pitch, &bytes[pitch * h..], pitch, self.out_w as usize, h, payload);
            d3d.context.Unmap(staging, 0);
            Ok(ok)
        }
    }

    /// Конвейер для слоёв SFU: кадр N уходит на GPU (и сразу `Flush`), а в `payload`
    /// выгружается кадр N−1 — его GPU давно доделал. `Ok(false)` — выгружать пока нечего.
    ///
    /// Синхронный `Map` сразу за `VideoProcessorBlt` ждал GPU — на трёх слоях и превью
    /// ~66 мс на кадр, захват держался на 15 к/с при 120 запрошенных (живой Windows,
    /// 2026-11-22: `captured` 146–150 за 10 с; с 1080p на паузе — 52 к/с).
    fn convert_pipelined(&mut self, d3d: &D3d, texture: &ID3D11Texture2D, content_w: u32, content_h: u32, payload: &mut Vec<u8>) -> Result<bool> {
        self.blit(d3d, texture, content_w, content_h)?;
        let slot = self.next_staging;
        unsafe {
            let staging = if slot == 0 { &self.staging } else { &self.staging2 };
            d3d.context.CopyResource(staging, &self.output);
            d3d.context.Flush();
        }
        let ready = self.pending.replace(slot);
        self.next_staging ^= 1;
        match ready {
            Some(prev) => self.read_staging(d3d, prev, payload),
            None => Ok(false),
        }
    }

    /// Отложенный кадр конвейера (экран замер — новых кадров нет): забрать его сейчас,
    /// иначе последнее состояние экрана так и не дойдёт до зрителя.
    fn flush_pending(&mut self, d3d: &D3d, payload: &mut Vec<u8>) -> Result<bool> {
        match self.pending.take() {
            Some(prev) => self.read_staging(d3d, prev, payload),
            None => Ok(false),
        }
    }

    /// Текстура кадра (размер пула) → плотный NV12 `out_w × out_h` в `payload`.
    fn convert(&self, d3d: &D3d, texture: &ID3D11Texture2D, content_w: u32, content_h: u32, payload: &mut Vec<u8>) -> Result<bool> {
        unsafe {
            d3d.context.CopyResource(&self.input, texture);
            let (cw, ch) = (content_w.min(self.in_w).max(1), content_h.min(self.in_h).max(1));
            let src_rect = RECT { left: 0, top: 0, right: cw as i32, bottom: ch as i32 };
            self.video_context.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&src_rect));
            // Выход фиксированного размера (слои SFU), а окно сменило пропорции — вписываем
            // с полями, а не растягиваем. Разница в пару пикселей от округления — во весь кадр.
            let dest = letterbox_rect(cw, ch, self.out_w, self.out_h);
            self.video_context.VideoProcessorSetStreamDestRect(&self.processor, 0, true, Some(&dest));
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: std::mem::ManuallyDrop::new(Some(self.input_view.clone())),
                ..Default::default()
            };
            let streams = [stream];
            let blt = self.video_context.VideoProcessorBlt(&self.processor, &self.output_view, 0, &streams);
            // ManuallyDrop внутри структуры — отдать ссылку на input_view обратно.
            let [mut stream] = streams;
            std::mem::ManuallyDrop::drop(&mut stream.pInputSurface);
            blt?;
            d3d.context.CopyResource(&self.staging, &self.output);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            d3d.context.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let pitch = mapped.RowPitch as usize;
            let h = self.out_h as usize;
            let total = pitch * (h + h / 2);
            let bytes = std::slice::from_raw_parts(mapped.pData as *const u8, total);
            let ok = pack_nv12(&bytes[..pitch * h], pitch, &bytes[pitch * h..], pitch, self.out_w as usize, h, payload);
            d3d.context.Unmap(&self.staging, 0);
            Ok(ok)
        }
    }
}

/// Прямоугольник картинки `cw × ch`, вписанной по центру в `ow × oh`.
fn letterbox_rect(cw: u32, ch: u32, ow: u32, oh: u32) -> RECT {
    let full = RECT { left: 0, top: 0, right: ow as i32, bottom: oh as i32 };
    if cw == 0 || ch == 0 {
        return full;
    }
    let k = (ow as f64 / cw as f64).min(oh as f64 / ch as f64);
    let (w, h) = ((cw as f64 * k).round() as u32, (ch as f64 * k).round() as u32);
    if ow.saturating_sub(w) <= 2 && oh.saturating_sub(h) <= 2 {
        return full;
    }
    // Чётные отступы: у NV12 цветность — на пару пикселей.
    let left = ((ow - w.min(ow)) / 2) & !1;
    let top = ((oh - h.min(oh)) / 2) & !1;
    RECT { left: left as i32, top: top as i32, right: (left + w.min(ow)) as i32, bottom: (top + h.min(oh)) as i32 }
}

// --- превью для окна выбора ----------------------------------------------------------

fn encode_jpeg(bgra: &[u8], width: usize, height: usize) -> Result<Vec<u8>> {
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let stream = CreateStreamOnHGlobal(Default::default(), true)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut props = None;
        encoder.CreateNewFrame(&mut frame, &mut props)?;
        let frame = frame.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
        frame.Initialize(props.as_ref())?;
        frame.SetSize(width as u32, height as u32)?;
        let mut format = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut format)?;
        let bgr: Vec<u8> = bgra.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        frame.WritePixels(height as u32, (width * 3) as u32, &bgr)?;
        frame.Commit()?;
        encoder.Commit()?;
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME)?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let mut out = vec![0u8; stat.cbSize as usize];
        let mut read = 0u32;
        stream.Read(out.as_mut_ptr() as *mut _, out.len() as u32, Some(&mut read)).ok()?;
        out.truncate(read as usize);
        Ok(out)
    }
}

/// Один кадр источника → `data:image/jpeg;base64,…` шириной ≤ `thumb_width`.
fn thumbnail(d3d: &D3d, source: Source, thumb_width: usize, timeout: Duration) -> Option<String> {
    let item = create_item(source).ok()?;
    let capture = Capture::start(d3d, &item, 1, false).ok()?;
    let started = Instant::now();
    let frame = loop {
        if let Some(frame) = capture.latest() {
            break frame;
        }
        if started.elapsed() > timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let content = frame.ContentSize().ok()?;
    let texture = frame_texture(&frame).ok()?;
    let (bgra, w, h) = read_bgra(d3d, &texture, content.Width.max(0) as u32, content.Height.max(0) as u32).ok()?;
    drop(frame);
    drop(capture);
    let (small, sw, sh) = downscale_bgra(&bgra, w * 4, w, h, thumb_width);
    if sw == 0 || sh == 0 {
        return None;
    }
    let jpeg = encode_jpeg(&small, sw, sh).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)))
}

/// Ответ на `list_screen_sources`.
pub fn list_sources(thumb_width: usize) -> Vec<Value> {
    let _com = ComGuard::new();
    let d3d = D3d::new().ok();
    let started = Instant::now();
    let thumb = |source: Source, timeout_ms: u64| -> String {
        // Превью — не дольше общего бюджета: список важнее картинок.
        match &d3d {
            Some(d3d) if started.elapsed() < THUMB_BUDGET => {
                thumbnail(d3d, source, thumb_width, Duration::from_millis(timeout_ms)).unwrap_or_default()
            }
            _ => String::new(),
        }
    };
    let mut out = Vec::new();
    for (index, display) in displays().into_iter().enumerate() {
        let source = Source::Display(display.handle);
        out.push(json!({
            "id": source.id(),
            "kind": "display",
            "title": if display.primary { format!("Экран {} (основной)", index + 1) } else { format!("Экран {}", index + 1) },
            "app": "",
            "width": display.width,
            "height": display.height,
            "thumb": thumb(source, 600),
        }));
    }
    for window in windows_list() {
        let source = Source::Window(window.handle);
        let mut rect = RECT::default();
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd(window.handle), &mut rect);
        }
        out.push(json!({
            "id": source.id(),
            "kind": "window",
            "title": window.title,
            "app": window.app,
            "own": window.own,
            "width": (rect.right - rect.left).max(0),
            "height": (rect.bottom - rect.top).max(0),
            // Свёрнутое окно WGC не рисует — превью не ждём.
            "thumb": if window.minimized { String::new() } else { thumb(source, 250) },
        }));
    }
    out
}

// --- захват ----------------------------------------------------------------------------

fn source_title(source: Source) -> String {
    match source {
        Source::Display(h) => {
            let index = displays().iter().position(|d| d.handle == h).map(|i| i + 1).unwrap_or(1);
            format!("Экран {index}")
        }
        Source::Window(h) => {
            let hwnd = hwnd(h);
            unsafe {
                let len = GetWindowTextLengthW(hwnd).max(0) as usize;
                let mut buf = vec![0u16; len + 1];
                let copied = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
                String::from_utf16_lossy(&buf[..copied])
            }
        }
    }
}

/// Процессы WebView2 (msedgewebview2.exe): сколько в дереве нашего процесса и сколько вне.
/// Голоса звонка играет WebView2, а process loopback исключает только наше дерево: если
/// WebView2 окажется вне его, собеседники услышат себя в демонстрации — это видно по
/// `outside` в журнале (жалоба 2026-11-24 «захватывается звук самого приложения»).
fn webview2_tree_census() -> (usize, usize) {
    use windows_sys::Win32::Foundation::{CloseHandle as CloseRaw, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut procs: Vec<(u32, u32, String)> = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return (0, 0);
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            procs.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..end])));
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseRaw(snapshot);
    }
    let me = std::process::id();
    let parent: HashMap<u32, u32> = procs.iter().map(|(p, pp, _)| (*p, *pp)).collect();
    let in_tree = |mut pid: u32| {
        for _ in 0..16 {
            if pid == me {
                return true;
            }
            match parent.get(&pid) {
                Some(&pp) if pp != 0 && pp != pid => pid = pp,
                _ => return false,
            }
        }
        false
    };
    let webviews: Vec<u32> = procs
        .iter()
        .filter(|(_, _, name)| name.eq_ignore_ascii_case("msedgewebview2.exe"))
        .map(|(p, _, _)| *p)
        .collect();
    let inside = webviews.iter().filter(|p| in_tree(**p)).count();
    (inside, webviews.len() - inside)
}

/// Звук демонстрации: process loopback без нашего дерева процессов → стерео-кадры.
fn run_screen_audio(ctx: StartContext, stop: Arc<AtomicBool>) {
    let _com = ComGuard::new();
    let (inside, outside) = webview2_tree_census();
    // outside — процессы WebView2 любых приложений, не только наши: тревожно, только если
    // inside = 0 (наш WebView2 живёт вне дерева, и голоса звонка попадут в захват).
    tracing::info!("[ZALI][WIN] media screen audio: exclude tree pid={} webview2 inside={inside} outside={outside}", std::process::id());
    let capture = match WasapiCapture::open_process_loopback_excluding_self(2).and_then(|c| c.start().map(|_| c)) {
        Ok(capture) => capture,
        Err(error) => {
            // Windows 10 до 2004 не умеет process loopback — демонстрация без звука.
            let (_, text) = super::com::describe(&error);
            tracing::warn!("[ZALI][WIN] media screen audio unavailable: {text}");
            return;
        }
    };
    const BLOCK_FRAMES: usize = 960;
    let mut buf: Vec<f32> = Vec::with_capacity(9600);
    let mut seq = 0u32;
    let mut anchor = now_us();
    let mut sent: u64 = 0;
    while !stop.load(Ordering::Acquire) && !ctx.stopped() {
        if capture.read(10, &mut buf).is_err() {
            // Сменилось устройство вывода — process loopback переживает это сам; если
            // нет, короткая пауза и выход: видео продолжается без звука.
            sleep_unless_stopped(&stop, 200);
            break;
        }
        while buf.len() >= BLOCK_FRAMES * 2 {
            let by_samples = anchor + sent * 1_000_000 / 48_000;
            let now = now_us();
            if by_samples.abs_diff(now) > 200_000 {
                anchor = now;
                sent = 0;
            }
            let ts = anchor + sent * 1_000_000 / 48_000;
            let frame = audio_frame(&FrameHeader::audio(ctx.stream, ts, 2, seq), &buf[..BLOCK_FRAMES * 2]);
            buf.drain(..BLOCK_FRAMES * 2);
            seq = seq.wrapping_add(1);
            sent += BLOCK_FRAMES as u64;
            if ctx.frames.pending() < 50 && !ctx.frames.send(frame) {
                return;
            }
        }
    }
}


// --- отправка напрямую на SFU (core/src/sfu_publisher.rs) -----------------------------
//
// Страница прислала `options.sfu` (voice_sfu.js → voiceNativeSfuScreenSpec): слои
// simulcast кодирует Media Foundation (h264_mf.rs) и шлёт в сеть издатель ядра, мимо
// WebRTC страницы. Странице — только NV12 слоя превью. Сигналинг (оффер в `started`,
// ответ — op `sfu_answer`) ведёт страница, как у macOS (MediaController.swift).

/// stream → издатель идущей демонстрации (ответ SFU приходит отдельным запросом).
fn sfu_publishers() -> MutexGuard<'static, HashMap<u32, Arc<SfuPublisher>>> {
    static MAP: OnceLock<Mutex<HashMap<u32, Arc<SfuPublisher>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|p| p.into_inner())
}

/// Ответ SFU на оффер издателя потока `stream`. `false` — издателя нет.
pub fn sfu_answer(stream: u32, sdp: String) -> bool {
    let publisher = sfu_publishers().get(&stream).cloned();
    match publisher {
        Some(p) => {
            p.accept_answer(sdp);
            true
        }
        None => false,
    }
}

struct SfuLayerSpec {
    rid: String,
    scale: f64,
    fps: u32,
    bpp: f64,
    min_bps: u64,
    max_bps: u64,
}

struct SfuSpec {
    layers: Vec<SfuLayerSpec>,
    /// Кодеки страницы, лучший первым (их декодируют все в комнате); H.264 — всегда последний.
    codecs: Vec<VideoCodec>,
    max_side: u32,
    preview: usize,
    start_bitrate: u64,
}

fn parse_sfu_spec(options: &Value, fps: u32) -> Option<SfuSpec> {
    let sfu = options.get("sfu")?;
    let layers: Vec<SfuLayerSpec> = sfu
        .get("layers")?
        .as_array()?
        .iter()
        .take(3)
        .enumerate()
        .map(|(i, l)| {
            let min_bps = l.get("minBps").and_then(Value::as_u64).unwrap_or(300_000).max(100_000);
            SfuLayerSpec {
                rid: l.get("rid").and_then(Value::as_str).unwrap_or(["q", "h", "f"][i]).chars().take(8).collect(),
                scale: l.get("scale").and_then(Value::as_f64).unwrap_or(1.0).max(1.0),
                fps: (l.get("fps").and_then(Value::as_u64).unwrap_or(fps as u64) as u32).clamp(1, 240),
                bpp: l.get("bpp").and_then(Value::as_f64).unwrap_or(0.08).clamp(0.01, 1.0),
                min_bps,
                max_bps: l.get("maxBps").and_then(Value::as_u64).unwrap_or(8_000_000).clamp(min_bps, 200_000_000),
            }
        })
        .collect();
    if layers.is_empty() {
        return None;
    }
    let preview = (sfu.get("previewLayer").and_then(Value::as_u64).unwrap_or(0) as usize).min(layers.len() - 1);
    // Превью у Windows — NV12 (страница не декодирует слой), поэтому previewDecode не нужен.
    let mut codecs: Vec<VideoCodec> = sfu
        .get("codecs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().and_then(VideoCodec::parse)).collect())
        .unwrap_or_default();
    codecs.retain(|c| *c != VideoCodec::H264);
    codecs.push(VideoCodec::H264);
    Some(SfuSpec {
        codecs,
        max_side: sfu.get("maxSide").and_then(Value::as_u64).unwrap_or(0) as u32,
        start_bitrate: sfu.get("startBitrate").and_then(Value::as_u64).unwrap_or(2_500_000),
        preview,
        layers,
    })
}

/// Вписать в `max_w × max_h` с сохранением пропорций, стороны чётные.
fn fit_box(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0);
    }
    let k = (max_w as f64 / w as f64).min(max_h as f64 / h as f64).min(1.0);
    let even = |v: f64| ((v.round() as u32) & !1).max(16);
    (even(w as f64 * k), even(h as f64 * k))
}

/// Что издатель велел кодировщикам (с его потока).
#[derive(Default)]
struct SfuControl {
    bitrates: Option<Vec<u64>>,
    keyframes: Vec<usize>,
}

struct SfuLayer {
    width: u32,
    height: u32,
    fps: u32,
    /// Частота по бюджету (`budget_fps`), ≤ `fps`.
    eff_fps: u32,
    interval: Duration,
    next_due: Instant,
    encoder: LayerEncoder,
    converter: Option<Nv12Converter>,
    paused: bool,
    last_nv12: Vec<u8>,
    last_submit: Instant,
    submitted: u64,
    busy: u64,
}

struct SfuSession {
    stream: u32,
    publisher: Arc<SfuPublisher>,
    layers: Vec<SfuLayer>,
    codec: VideoCodec,
    preview: usize,
    control: Arc<Mutex<SfuControl>>,
    events: EventSink,
    /// Кодировщик слоя умер — странице сказано один раз (она перезапустит демонстрацию).
    failed: bool,
}

impl SfuSession {
    fn start(ctx: &StartContext, spec: SfuSpec, src_w: u32, src_h: u32, max_height: u32, fps: u32) -> std::result::Result<Self, String> {
        let (w, h) = fit_even(src_w, src_h, max_height);
        // Предел уровня H.264 5.1 у кодировщиков Media Foundation — 4096×2304.
        let (mut w, mut h) = fit_box(w, h, 4096, 2304);
        if spec.max_side > 0 {
            (w, h) = fit_box(w, h, spec.max_side, spec.max_side);
        }
        let dims: Vec<(u32, u32, u32, u64)> = spec
            .layers
            .iter()
            .map(|l| {
                let lw = (((w as f64 / l.scale).round() as u32) & !1).max(16);
                let lh = (((h as f64 / l.scale).round() as u32) & !1).max(16);
                let lfps = l.fps.min(fps).max(1);
                let raw = (lw as f64 * lh as f64 * lfps as f64 * l.bpp) as u64;
                (lw, lh, lfps, raw.clamp(l.min_bps, l.max_bps))
            })
            .collect();
        // Первый кодек списка, для которого завелись кодировщики всех слоёв (H.265/AV1 —
        // только аппаратные; H.264 — последний, с программным запасным).
        let mut last_error = String::new();
        for codec in spec.codecs.clone() {
            match Self::start_with(ctx, &spec, &dims, codec) {
                Ok(session) => return Ok(session),
                Err(error) => {
                    tracing::warn!("[ZALI][WIN] media screen sfu {}: {error}", codec.name());
                    last_error = error;
                }
            }
        }
        Err(last_error)
    }

    fn start_with(ctx: &StartContext, spec: &SfuSpec, dims: &[(u32, u32, u32, u64)], codec: VideoCodec) -> std::result::Result<Self, String> {
        let config = PublisherConfig {
            codec,
            layers: spec
                .layers
                .iter()
                .zip(dims)
                // Потолок слоя — его расчётный битрейт (пиксели × к/с × bpp) с запасом на
                // активные сцены, а не общий потолок страницы (40 Мбит/с у f, 12 у h). С общим
                // при высокой оценке Wi-Fi кодировщики получали почти весь канал: h 540p шёл
                // на 5,7 Мбит/с, ключевые 1080p раздувались, а BWE зондировал паддингом до суммы
                // потолков (52 Мбит/с). Канал Windows забивался своим же трафиком — 5–6 % потерь
                // на всём, голос тоже (живой Windows → Mac 2026-11-22; без демонстрации 0,2 %).
                .map(|(l, d)| {
                    let max = ((d.3 as f64 * LAYER_TARGET_HEADROOM) as u64).clamp(l.min_bps, l.max_bps);
                    LayerConfig { rid: l.rid.clone(), width: d.0, height: d.1, fps: d.2, max_bitrate: max, min_bitrate: Some(l.min_bps) }
                })
                .collect(),
            start_bitrate: Some(spec.start_bitrate),
        };
        let control: Arc<Mutex<SfuControl>> = Arc::default();
        let stream = ctx.stream;
        let events = ctx.events.clone();
        let ctl = Arc::clone(&control);
        // Колбэк — с потока издателя: держать здесь Arc<SfuPublisher> нельзя (последний
        // drop на его же потоке ждал бы сам себя).
        let publisher = SfuPublisher::new(
            config,
            Box::new(move |text: String| {
                let Ok(ev) = serde_json::from_str::<Value>(&text) else { return };
                match ev.get("event").and_then(Value::as_str).unwrap_or("") {
                    "keyframe" => {
                        let layer = ev.get("layer").and_then(Value::as_u64).unwrap_or(0) as usize;
                        ctl.lock().unwrap_or_else(|p| p.into_inner()).keyframes.push(layer);
                        return;
                    }
                    "bitrates" => {
                        let list = ev.get("bitrates").and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_u64().unwrap_or(0)).collect());
                        ctl.lock().unwrap_or_else(|p| p.into_inner()).bitrates = list;
                    }
                    "stats" | "closed" | "connected" => tracing::info!("[ZALI][WIN] media screen sfu stream={stream} {text}"),
                    _ => {}
                }
                events.emit(json!({ "event": "sfu", "stream": stream, "sfu": ev }));
            }),
        )?;
        let publisher = Arc::new(publisher);
        let mut layers = Vec::new();
        for (i, (lw, lh, lfps, bps)) in dims.iter().copied().enumerate() {
            let p = Arc::clone(&publisher);
            let encoder = LayerEncoder::spawn(i, codec, lw, lh, lfps, bps as u32, Box::new(move |data, key, pts| p.push_frame(i, data, key, pts)))
                .map_err(|e| format!("кодировщик слоя {i} ({lw}x{lh}@{lfps}): {e}"))?;
            tracing::info!("[ZALI][WIN] media screen sfu layer {i} {} {lw}x{lh}@{lfps} {}k {}", codec.name(), bps / 1000, encoder.description);
            layers.push(SfuLayer {
                width: lw,
                height: lh,
                fps: lfps,
                eff_fps: lfps,
                interval: Duration::from_micros(1_000_000 / lfps as u64),
                next_due: Instant::now(),
                encoder,
                converter: None,
                paused: false,
                last_nv12: Vec::new(),
                last_submit: Instant::now(),
                submitted: 0,
                busy: 0,
            });
        }
        sfu_publishers().insert(stream, Arc::clone(&publisher));
        Ok(Self { stream, publisher, layers, codec, preview: spec.preview, control, events: ctx.events.clone(), failed: false })
    }

    fn offer_json(&self, rids: &[String]) -> Value {
        let (sdp, mid) = self.publisher.offer();
        json!({
            "sdp": sdp,
            "mid": mid,
            "codec": self.codec.name(),
            "layers": self.layers.iter().zip(rids).map(|(l, rid)| json!({"rid": rid, "width": l.width, "height": l.height, "fps": l.fps})).collect::<Vec<_>>(),
        })
    }

    /// Бюджет слоёв и запросы ключевых кадров от издателя → кодировщикам.
    fn apply_control(&mut self) {
        let (bitrates, keyframes) = {
            let mut c = self.control.lock().unwrap_or_else(|p| p.into_inner());
            (c.bitrates.take(), std::mem::take(&mut c.keyframes))
        };
        if let Some(list) = bitrates {
            for (layer, bps) in self.layers.iter_mut().zip(list) {
                if bps == 0 {
                    layer.paused = true;
                } else {
                    layer.encoder.set_bitrate(bps.min(u32::MAX as u64) as u32);
                    let eff = budget_fps(bps, layer.width, layer.height, layer.fps);
                    if eff != layer.eff_fps {
                        layer.eff_fps = eff;
                        layer.interval = Duration::from_micros(1_000_000 / eff as u64);
                    }
                    if layer.paused {
                        layer.paused = false;
                        layer.encoder.request_keyframe();
                    }
                }
            }
        }
        for i in keyframes {
            if let Some(layer) = self.layers.get(i) {
                layer.encoder.request_keyframe();
            }
        }
        // Слой без кодировщика зрители этого слоя видят замёрзшим: пусть страница
        // перезапустит демонстрацию (после двух сбоев — прежним путём через WebRTC).
        if !self.failed {
            if let Some(i) = self.layers.iter().position(|l| !l.encoder.alive()) {
                self.failed = true;
                tracing::warn!("[ZALI][WIN] media screen sfu stream={} layer {i} encoder stopped", self.stream);
                self.events.emit(json!({ "event": "sfu", "stream": self.stream, "sfu": {"event": "closed", "reason": "encoder_failed"} }));
            }
        }
    }

    fn stats(&mut self) -> Value {
        let out: Vec<Value> = self
            .layers
            .iter_mut()
            .map(|l| {
                let v = json!({"size": format!("{}x{}", l.width, l.height), "fps": l.fps, "eff_fps": l.eff_fps, "sent": l.submitted, "busy": l.busy, "paused": l.paused});
                l.submitted = 0;
                l.busy = 0;
                v
            })
            .collect();
        json!(out)
    }
}

impl Drop for SfuSession {
    fn drop(&mut self) {
        // Сначала кодировщики (их потоки держат Arc издателя), потом издатель.
        self.layers.clear();
        sfu_publishers().remove(&self.stream);
    }
}

/// Частота обновления основного дисплея, Гц (`None` — не узнали).
fn display_refresh_hz() -> Option<u32> {
    let mut mode = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
    let ok = unsafe { EnumDisplaySettingsW(windows::core::PCWSTR::null(), ENUM_CURRENT_SETTINGS, &mut mode) }.as_bool();
    (ok && mode.dmDisplayFrequency > 1).then_some(mode.dmDisplayFrequency.clamp(24, 240))
}

/// Частота, на которую хватает бюджета слоя: сначала падает ЧАСТОТА (до 30 к/с, чтобы на кадр
/// оставалось ~0,035 бита на пиксель), и только ниже — качество: частота держится на 30, а
/// кодировщик сжимает сильнее (так просил пользователь, 2026-11-22: «сначала фпс до 30, потом
/// качество»). Разрешение слой не меняет никогда.
fn budget_fps(bps: u64, width: u32, height: u32, max_fps: u32) -> u32 {
    let px = (width as f64 * height as f64).max(1.0);
    let by_bits = (bps as f64 / (px * 0.035)).floor() as u32;
    by_bits.clamp(30.min(max_fps), max_fps)
}

/// Кадр захвата → плотный NV12 в `payload`; возвращает фактический размер. GPU даёт ровно
/// `ow × oh`; CPU-путь (GPU отказал) — сколько вышло после ресайза (±пара пикселей, ширина
/// не больше 1920): страница примет любой, а слоям SFU нужен точный — они сверяют сами.
#[allow(clippy::too_many_arguments)]
fn convert_frame(
    d3d: &D3d,
    converter: &mut Option<Nv12Converter>,
    gpu_failed: &mut bool,
    texture: &ID3D11Texture2D,
    desc: &D3D11_TEXTURE2D_DESC,
    cw: u32,
    ch: u32,
    ow: u32,
    oh: u32,
    payload: &mut Vec<u8>,
    pipelined: bool,
) -> Option<(u32, u32)> {
    payload.clear();
    payload.reserve(nv12_len(ow as usize, oh as usize));
    if !*gpu_failed {
        let reuse = converter
            .as_ref()
            .map(|c| c.in_w == desc.Width && c.in_h == desc.Height && c.out_w == ow && c.out_h == oh)
            .unwrap_or(false);
        if !reuse {
            *converter = match Nv12Converter::new(d3d, desc.Width, desc.Height, ow, oh) {
                Ok(c) => Some(c),
                Err(error) => {
                    tracing::warn!("[ZALI][WIN] media screen: VideoProcessor unavailable, CPU path: {error}");
                    *gpu_failed = true;
                    None
                }
            };
        }
        if let Some(c) = converter.as_mut() {
            let result = if pipelined { c.convert_pipelined(d3d, texture, cw, ch, payload) } else { c.convert(d3d, texture, cw, ch, payload) };
            match result {
                Ok(ok) => return ok.then_some((ow, oh)),
                Err(error) => {
                    tracing::warn!("[ZALI][WIN] media screen: GPU convert failed, CPU path: {error}");
                    *gpu_failed = true;
                    *converter = None;
                }
            }
        }
    }
    payload.clear();
    let Ok((bgra, w, h)) = read_bgra(d3d, texture, cw, ch) else { return None };
    let (src, sw, sh) = if (w as u32, h as u32) != (ow, oh) { downscale_bgra(&bgra, w * 4, w, h, ow as usize) } else { (bgra, w, h) };
    let (nw, nh) = bgra_to_nv12(&src, sw * 4, sw, sh, payload);
    (nw > 0 && nh > 0 && !payload.is_empty()).then_some((nw as u32, nh as u32))
}

pub fn run(ctx: StartContext) {
    let _com = ComGuard::new();
    if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
        ctx.fail("unsupported", "Windows.Graphics.Capture недоступен (нужна Windows 10 1903+)");
        return;
    }
    let source = if ctx.source_id.is_empty() {
        displays().first().map(|d| Source::Display(d.handle))
    } else {
        Source::parse(&ctx.source_id)
    };
    let Some(source) = source else {
        ctx.fail("not_found", "источник демонстрации не найден");
        return;
    };
    if let Source::Window(h) = source {
        if unsafe { !IsWindow(Some(hwnd(h))).as_bool() } {
            ctx.fail("not_found", "окно уже закрыто");
            return;
        }
    }
    let opt_u = |key: &str, default: u64| ctx.options.get(key).and_then(Value::as_u64).unwrap_or(default);
    // До 240: «Общий браузер» идёт с частотой экрана; демонстрация экрана просит ≤ 60.
    // Не чаще обновления дисплея: WGC чаще кадров не даст, а кодировщик Media Foundation
    // делит битрейт на ЗАЯВЛЕННУЮ частоту — слой «120 к/с» на мониторе 60 Гц получал
    // полбюджета на кадр и выбрасывал кадры (1080p на 1–4 к/с, живой Windows 2026-11-22).
    let fps = opt_u("fps", 30).clamp(1, 240).min(display_refresh_hz().unwrap_or(240) as u64);
    let max_height = opt_u("maxHeight", 0).min(4320) as u32;
    let cursor = ctx.options.get("cursor").and_then(Value::as_bool).unwrap_or(true);
    let want_audio = ctx.options.get("audio").and_then(Value::as_bool).unwrap_or(false);

    let d3d = match D3d::new() {
        Ok(d3d) => d3d,
        Err(error) => return ctx.fail_win(&error, "Direct3D"),
    };
    let item = match create_item(source) {
        Ok(item) => item,
        Err(error) => return ctx.fail_win(&error, "источник демонстрации"),
    };
    let closed = Arc::new(AtomicBool::new(false));
    {
        let closed = Arc::clone(&closed);
        let _ = item.Closed(&TypedEventHandler::new(move |_, _| {
            closed.store(true, Ordering::Release);
            Ok(())
        }));
    }
    let mut capture = match Capture::start(&d3d, &item, 3, cursor) {
        Ok(capture) => capture,
        Err(error) => return ctx.fail_win(&error, "захват экрана"),
    };

    let audio_stop = Arc::new(AtomicBool::new(false));
    if want_audio {
        let ctx = ctx.clone();
        let stop = Arc::clone(&audio_stop);
        let _ = std::thread::Builder::new().name("zali-media-screen-audio".into()).spawn(move || run_screen_audio(ctx, stop));
    }

    let size = capture.pool_size;
    let (mut w0, mut h0) = fit_even(size.Width.max(0) as u32, size.Height.max(0) as u32, max_height);
    let mut sfu: Option<SfuSession> = None;
    let mut sfu_extra = json!({});
    if let Some(spec) = parse_sfu_spec(&ctx.options, fps as u32) {
        let rids: Vec<String> = spec.layers.iter().map(|l| l.rid.clone()).collect();
        match SfuSession::start(&ctx, spec, size.Width.max(0) as u32, size.Height.max(0) as u32, max_height, fps as u32) {
            Ok(session) => {
                // Странице — превью: размер его слоя.
                let p = &session.layers[session.preview];
                (w0, h0) = (p.width, p.height);
                sfu_extra = json!({ "sfu": session.offer_json(&rids), "layers": session.layers.len() });
                sfu = Some(session);
            }
            Err(error) => {
                tracing::warn!("[ZALI][WIN] media screen sfu unavailable: {error}");
                sfu_extra = json!({ "sfuError": error });
            }
        }
    }
    let mut started = json!({
        "codec": "nv12",
        "fps": fps,
        "label": source_title(source),
        "sourceId": source.id(),
        "width": w0,
        "height": h0,
        "audio": want_audio,
        // process loopback исключает всё дерево процессов приложения (и WebView2):
        // страница подмешивает звук приложения без звонка сама.
        "audioExcludesApp": true,
    });
    if let (Value::Object(dst), Value::Object(src)) = (&mut started, sfu_extra) {
        dst.extend(src);
    }
    ctx.started(started);

    let interval = Duration::from_micros(1_000_000 / fps);
    let mut next_tick = Instant::now();
    let mut converter: Option<Nv12Converter> = None;
    let mut gpu_failed = false;
    let mut payload: Vec<u8> = Vec::new();
    // Последний отправленный кадр (данные без заголовка) — для IDLE_REPEAT.
    let mut last_payload: Vec<u8> = Vec::new();
    let mut last_size = (0u16, 0u16);
    let mut last_sent = Instant::now();
    let mut seq = 0u32;
    let mut _held_frame: Option<Direct3D11CaptureFrame> = None;
    let mut window = Instant::now();
    let mut captured = 0u64;
    let mut idle_repeats = 0u64;
    // Время подготовки слоёв SFU на кадр (конвертация на GPU + выгрузка) — в статистику.
    let mut convert_us = 0u64;
    let mut convert_n = 0u64;
    // Заголовок + данные → поток окна; данные запоминаются для повтора без копии.
    let send = |payload: &mut Vec<u8>, last: &mut Vec<u8>, w: u16, h: u16, seq: &mut u32| -> bool {
        let mut frame_bytes = vec![0u8; HEADER_LEN + payload.len()];
        encode_header(&FrameHeader::nv12(ctx.stream, now_us(), w, h, *seq), payload.len(), &mut frame_bytes[..HEADER_LEN]);
        frame_bytes[HEADER_LEN..].copy_from_slice(payload);
        *seq = seq.wrapping_add(1);
        std::mem::swap(payload, last);
        ctx.frames.send_video(frame_bytes)
    };
    let reason = loop {
        if ctx.stopped() {
            break None;
        }
        if window.elapsed() >= Duration::from_secs(10) {
            let mut video = ctx.frames.take_stats(window.elapsed().as_secs_f64());
            video["kind"] = json!("screen");
            video["width"] = json!(last_size.0);
            video["height"] = json!(last_size.1);
            video["captured"] = json!(captured);
            video["convert_ms"] = json!(if convert_n > 0 { (convert_us as f64 / convert_n as f64 / 100.0).round() / 10.0 } else { 0.0 });
            video["idle_repeats"] = json!(idle_repeats);
            video["convert"] = json!(if gpu_failed { "cpu" } else { "gpu" });
            video["audio"] = json!(want_audio);
            if let Some(s) = sfu.as_mut() {
                video["sfu_layers"] = s.stats();
            }
            ctx.video_stats(video);
            window = Instant::now();
            captured = 0;
            idle_repeats = 0;
            convert_us = 0;
            convert_n = 0;
        }
        if closed.load(Ordering::Acquire) {
            break Some("source-closed");
        }
        if let Source::Window(h) = source {
            if unsafe { !IsWindow(Some(hwnd(h))).as_bool() } {
                break Some("source-closed");
            }
        }
        let now = Instant::now();
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        }
        next_tick = (next_tick + interval).max(Instant::now());
        if let Some(s) = sfu.as_mut() {
            s.apply_control();
        }
        // Окно не успевает забирать кадры — не тратим GPU на кадр, который выбросим
        // (с SFU превью вторично: слои кодируются всё равно).
        if sfu.is_none() && ctx.frames.pending() >= 3 {
            continue;
        }
        let Some(frame) = capture.latest() else {
            // Новых кадров нет — забрать из конвейера отложенный последний кадр каждого слоя
            // (иначе итог движения на экране не дошёл бы до зрителя, пока экран стоит).
            if let Some(s) = sfu.as_mut() {
                let preview = s.preview;
                let mut page_frame: Option<(Vec<u8>, u16, u16)> = None;
                for (i, layer) in s.layers.iter_mut().enumerate() {
                    let Some(conv) = layer.converter.as_mut() else { continue };
                    if !matches!(conv.flush_pending(&d3d, &mut payload), Ok(true)) || payload.len() != nv12_len(layer.width as usize, layer.height as usize) {
                        continue;
                    }
                    if !layer.paused {
                        layer.last_submit = Instant::now();
                        layer.last_nv12.clear();
                        layer.last_nv12.extend_from_slice(&payload);
                        if layer.encoder.submit(payload.clone(), now_us() as i64) {
                            layer.submitted += 1;
                        }
                    }
                    if i == preview && ctx.frames.pending() < 3 {
                        page_frame = Some((payload.clone(), layer.width as u16, layer.height as u16));
                    }
                }
                if let Some((mut preview_nv12, pw, ph)) = page_frame {
                    last_size = (pw, ph);
                    last_sent = Instant::now();
                    if !send(&mut preview_nv12, &mut last_payload, pw, ph, &mut seq) {
                        break None;
                    }
                    continue;
                }
            }
            // Экран неподвижен — WGC кадров не шлёт. Раз в IDLE_REPEAT повторяем последний
            // кадр: странице — чтобы дорожка не считалась замёрзшей, слоям SFU — чтобы у
            // зрителя дотянулось качество и оценка канала не падала от тишины.
            if let Some(s) = sfu.as_mut() {
                for layer in s.layers.iter_mut() {
                    if !layer.paused && !layer.last_nv12.is_empty() && layer.last_submit.elapsed() >= IDLE_REPEAT {
                        layer.last_submit = Instant::now();
                        if layer.encoder.submit(layer.last_nv12.clone(), now_us() as i64) {
                            layer.submitted += 1;
                        }
                    }
                }
            }
            if !last_payload.is_empty() && last_sent.elapsed() >= IDLE_REPEAT {
                last_sent = Instant::now();
                idle_repeats += 1;
                let mut again = last_payload.clone();
                if !send(&mut again, &mut last_payload, last_size.0, last_size.1, &mut seq) {
                    break None;
                }
            }
            continue;
        };
        captured += 1;
        let Ok(content) = frame.ContentSize() else { continue };
        let Ok(texture) = frame_texture(&frame) else { continue };
        // Окно поменяло размер — следующие кадры в пуле нового размера (текущий
        // дорисовываем по ContentSize).
        capture.resize_if_needed(&d3d, content);
        let desc = D3d::texture_desc(&texture);
        let cw = (content.Width.max(0) as u32).min(desc.Width);
        let ch = (content.Height.max(0) as u32).min(desc.Height);
        if cw == 0 || ch == 0 {
            continue;
        }
        if let Some(s) = sfu.as_mut() {
            // Слои — каждый со своей частотой, размер задан при старте (окно меняет
            // размер — картинка вписывается с полями, letterbox_rect). Странице — слой превью.
            let pts = now_us() as i64;
            let now = Instant::now();
            let preview = s.preview;
            let mut page_frame: Option<(Vec<u8>, u16, u16)> = None;
            let convert_started = Instant::now();
            for (i, layer) in s.layers.iter_mut().enumerate() {
                if now < layer.next_due {
                    continue;
                }
                layer.next_due = (layer.next_due + layer.interval).max(now);
                if layer.paused && i != preview {
                    continue;
                }
                let (lw, lh) = (layer.width, layer.height);
                // Кодировщик слоя настроен на точный размер: кадр CPU-пути другого размера —
                // мимо (GPU-путь вписывает с полями и всегда попадает).
                if convert_frame(&d3d, &mut layer.converter, &mut gpu_failed, &texture, &desc, cw, ch, lw, lh, &mut payload, true) != Some((lw, lh)) {
                    continue;
                }
                if !layer.paused {
                    layer.last_submit = Instant::now();
                    layer.last_nv12.clear();
                    layer.last_nv12.extend_from_slice(&payload);
                    if layer.encoder.submit(payload.clone(), pts) {
                        layer.submitted += 1;
                    } else {
                        layer.busy += 1;
                    }
                }
                if i == preview && ctx.frames.pending() < 3 {
                    page_frame = Some((payload.clone(), lw as u16, lh as u16));
                }
            }
            convert_us += convert_started.elapsed().as_micros() as u64;
            convert_n += 1;
            // Кадр WGC держим до следующего: его копии на GPU (конвейер без ожидания) могли ещё
            // не выполниться, а возвращённую в пул поверхность Windows перепишет следующим кадром —
            // в слой попала бы смесь двух кадров. Предыдущий к этому моменту уже скопирован.
            _held_frame = Some(frame);
            if let Some((mut preview_nv12, pw, ph)) = page_frame {
                last_size = (pw, ph);
                last_sent = Instant::now();
                if !send(&mut preview_nv12, &mut last_payload, pw, ph, &mut seq) {
                    break None;
                }
            }
            continue;
        }
        let (ow, oh) = fit_even(cw, ch, max_height);
        if ow == 0 || oh == 0 {
            continue;
        }
        let done = convert_frame(&d3d, &mut converter, &mut gpu_failed, &texture, &desc, cw, ch, ow, oh, &mut payload, false);
        drop(frame);
        // Размер — фактический: CPU-ресайз может разойтись с (ow, oh) на пару пикселей.
        let Some((fw, fh)) = done else { continue };
        last_size = (fw as u16, fh as u16);
        last_sent = Instant::now();
        if !send(&mut payload, &mut last_payload, fw as u16, fh as u16, &mut seq) {
            break None;
        }
    };
    drop(sfu);
    audio_stop.store(true, Ordering::Release);
    drop(capture);
    match reason {
        Some(reason) => ctx.ended(reason),
        None => ctx.finish(),
    }
}
