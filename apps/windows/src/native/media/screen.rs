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
use super::hub::StartContext;
use super::loopback::{sleep_unless_stopped, WasapiCapture};
use base64::Engine as _;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
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
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW};
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
            if self.pool.Recreate(&d3d.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content).is_ok() {
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

            Ok(Self {
                video_context,
                processor,
                input,
                input_view: input_view.ok_or_else(|| windows::core::Error::from(E_FAIL))?,
                output_view: output_view.ok_or_else(|| windows::core::Error::from(E_FAIL))?,
                output,
                staging,
                in_w,
                in_h,
                out_w,
                out_h,
            })
        }
    }

    /// Текстура кадра (размер пула) → плотный NV12 `out_w × out_h` в `payload`.
    fn convert(&self, d3d: &D3d, texture: &ID3D11Texture2D, content_w: u32, content_h: u32, payload: &mut Vec<u8>) -> Result<bool> {
        unsafe {
            d3d.context.CopyResource(&self.input, texture);
            let src_rect = RECT { left: 0, top: 0, right: content_w.min(self.in_w) as i32, bottom: content_h.min(self.in_h) as i32 };
            self.video_context.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&src_rect));
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

/// Звук демонстрации: process loopback без нашего дерева процессов → стерео-кадры.
fn run_screen_audio(ctx: StartContext, stop: Arc<AtomicBool>) {
    let _com = ComGuard::new();
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
    let fps = opt_u("fps", 30).clamp(1, 60);
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
    let mut capture = match Capture::start(&d3d, &item, 2, cursor) {
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
    let (w0, h0) = fit_even(size.Width.max(0) as u32, size.Height.max(0) as u32, max_height);
    ctx.started(json!({
        "codec": "nv12",
        "label": source_title(source),
        "sourceId": source.id(),
        "width": w0,
        "height": h0,
        "audio": want_audio,
        // process loopback исключает всё дерево процессов приложения (и WebView2):
        // страница подмешивает звук приложения без звонка сама.
        "audioExcludesApp": true,
    }));

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
    let mut window = Instant::now();
    let mut captured = 0u64;
    let mut idle_repeats = 0u64;
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
            video["idle_repeats"] = json!(idle_repeats);
            video["convert"] = json!(if gpu_failed { "cpu" } else { "gpu" });
            video["audio"] = json!(want_audio);
            ctx.video_stats(video);
            window = Instant::now();
            captured = 0;
            idle_repeats = 0;
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
        // Окно не успевает забирать кадры — не тратим GPU на кадр, который выбросим.
        if ctx.frames.pending() >= 3 {
            continue;
        }
        let Some(frame) = capture.latest() else {
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
        let (ow, oh) = fit_even(cw, ch, max_height);
        if ow == 0 || oh == 0 {
            continue;
        }
        payload.clear();
        payload.reserve(nv12_len(ow as usize, oh as usize));
        let mut done = false;
        if !gpu_failed {
            let reuse = converter
                .as_ref()
                .map(|c| c.in_w == desc.Width && c.in_h == desc.Height && c.out_w == ow && c.out_h == oh)
                .unwrap_or(false);
            if !reuse {
                converter = match Nv12Converter::new(&d3d, desc.Width, desc.Height, ow, oh) {
                    Ok(c) => Some(c),
                    Err(error) => {
                        tracing::warn!("[ZALI][WIN] media screen: VideoProcessor unavailable, CPU path: {error}");
                        gpu_failed = true;
                        None
                    }
                };
            }
            if let Some(c) = &converter {
                match c.convert(&d3d, &texture, cw, ch, &mut payload) {
                    Ok(ok) => done = ok,
                    Err(error) => {
                        tracing::warn!("[ZALI][WIN] media screen: GPU convert failed, CPU path: {error}");
                        gpu_failed = true;
                        converter = None;
                    }
                }
            }
        }
        if !done {
            payload.clear();
            if let Ok((bgra, w, h)) = read_bgra(&d3d, &texture, cw, ch) {
                let (src, sw, sh) = if (w as u32, h as u32) != (ow, oh) {
                    downscale_bgra(&bgra, w * 4, w, h, ow as usize)
                } else {
                    (bgra, w, h)
                };
                let (nw, nh) = bgra_to_nv12(&src, sw * 4, sw, sh, &mut payload);
                done = nw > 0;
                if done && (nw as u32, nh as u32) != (ow, oh) {
                    // CPU-уменьшение дало другой размер — заголовок по факту.
                    last_size = (nw as u16, nh as u16);
                    last_sent = Instant::now();
                    if !send(&mut payload, &mut last_payload, nw as u16, nh as u16, &mut seq) {
                        break None;
                    }
                    continue;
                }
            }
        }
        drop(frame);
        if !done {
            continue;
        }
        last_size = (ow as u16, oh as u16);
        last_sent = Instant::now();
        if !send(&mut payload, &mut last_payload, ow as u16, oh as u16, &mut seq) {
            break None;
        }
    };
    audio_stop.store(true, Ordering::Release);
    drop(capture);
    match reason {
        Some(reason) => ctx.ended(reason),
        None => ctx.finish(),
    }
}
