//! Windows-часть скрытия приложений (логика и тесты — `privacy.rs`):
//!
//! * список запущенных приложений с окнами для «Добавить приложение» (op `list_apps`);
//! * трекер окон: на каждый кадр захвата (и раз в 80 мс, пока кадров нет) `EnumWindows`
//!   (сверху вниз по z-порядку) + `DWMWA_EXTENDED_FRAME_BOUNDS` → маска окон скрытых
//!   приложений в экранных координатах (физические пиксели: процесс DPI-aware — tao).
//!   Опрос, а не `SetWinEventHook`: хуку нужен свой цикл сообщений, а опрос на кадре и так
//!   видит всё, что на кадре; сдвиг закрыт объединением старого и нового положения
//!   (`mask_from_windows`);
//! * маска надписи плашки — GDI, Segoe UI, как цифры значка на панели задач.
//!
//! Перекрывающим считается только обычное непрозрачное окно: прозрачные/слоистые
//! оверлеи (игровые, Discord, наши плашки с WDA_EXCLUDEFROMCAPTURE), «поверх всех» и
//! служебные под собой ничего не прячут — под ними скрытое окно закрывается. Лишняя
//! плашка безопаснее, чем окно, мелькнувшее сквозь прозрачный оверлей.

use super::privacy::{self, mask_from_windows, FrameMask, LabelMask, Rect, Rounding, Style, TrackedWindow, PLATE_TEXT};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, COLORREF, E_FAIL, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA, IWICImagingFactory,
    WICBitmapEncoderNoCache,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
use windows::Win32::UI::Shell::SHDefExtractIconW;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, DrawTextW, GetMonitorInfoW, SelectObject,
    SetBkMode, SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, DT_CALCRECT, DT_NOPREFIX, DT_SINGLELINE, FW_SEMIBOLD, HMONITOR,
    MONITORINFO, OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, EnumWindows, GetAncestor, DI_NORMAL, HICON, GetWindowDisplayAffinity, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GA_ROOT, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;
/// Шаг потока трекера и как давно должен быть последний опрос, чтобы поток опросил сам.
const POLL: Duration = Duration::from_millis(33);
const IDLE_POLL: Duration = Duration::from_millis(80);
/// Поле вокруг окна, скругление маски и стираемых окон поверх (физические пиксели).
/// Окна Windows 11 скруглены на 8 логических px — до 16 при 200 %; 20 — с запасом.
const ROUNDING: Rounding = Rounding { margin: 8, radius: 14, occluder_radius: 20 };

unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<isize>);
    out.push(hwnd.0 as isize);
    true.into()
}

fn top_level_windows() -> Vec<HWND> {
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut handles as *mut _ as isize));
    }
    handles.into_iter().map(|h| HWND(h as *mut _)).collect()
}

/// Полный путь к .exe процесса (пусто — не открылся).
fn process_path(pid: u32) -> String {
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
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

fn path_stem(path: &str) -> String {
    std::path::Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Имя .exe без расширения (как есть, с регистром).
pub fn process_stem(pid: u32) -> String {
    path_stem(&process_path(pid))
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// Строка из ресурса версии .exe (`FileDescription`, `ProductName`) на языке файла.
fn version_string(path: &str, key: &str) -> Option<String> {
    unsafe {
        let file = wide(path);
        let size = GetFileVersionInfoSizeW(PCWSTR(file.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(file.as_ptr()), None, size, data.as_mut_ptr() as *mut _).ok()?;
        let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        // Языки ресурса; если их нет — самые частые: англ. США и нейтральный, Unicode.
        let mut langs: Vec<(u16, u16)> = Vec::new();
        let translation = wide("\\VarFileInfo\\Translation");
        if VerQueryValueW(data.as_ptr() as *const _, PCWSTR(translation.as_ptr()), &mut ptr, &mut len).as_bool() && !ptr.is_null() {
            let pairs = std::slice::from_raw_parts(ptr as *const u16, (len as usize) / 2);
            langs.extend(pairs.chunks_exact(2).map(|p| (p[0], p[1])));
        }
        langs.extend([(0x0409, 0x04B0), (0x0000, 0x04B0), (0x0409, 0x04E4)]);
        for (lang, cp) in langs {
            let query = wide(&format!("\\StringFileInfo\\{lang:04x}{cp:04x}\\{key}"));
            if VerQueryValueW(data.as_ptr() as *const _, PCWSTR(query.as_ptr()), &mut ptr, &mut len).as_bool() && !ptr.is_null() && len > 0 {
                let chars = std::slice::from_raw_parts(ptr as *const u16, len as usize);
                let end = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
                let text = String::from_utf16_lossy(&chars[..end]).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
        None
    }
}

/// Человеческое имя приложения: описание .exe («Google Chrome», «Диспетчер задач»), у
/// вспомогательных процессов (Steam — `steamwebhelper.exe`, «Steam Client WebHelper») —
/// имя продукта; без ресурса версии — имя файла с заглавной буквы.
fn friendly_name(path: &str, stem: &str) -> String {
    let description = version_string(path, "FileDescription");
    let product = version_string(path, "ProductName");
    let helper = |s: &str| {
        let l = s.to_lowercase();
        l.contains("helper") || l.contains("host") || l.ends_with(".exe")
    };
    let name = match (description, product) {
        (Some(d), Some(p)) if helper(&d) && !helper(&p) => p,
        (Some(d), _) if !d.is_empty() && !helper(&d) => d,
        (_, Some(p)) if !p.is_empty() && !helper(&p) => p,
        _ => {
            let mut chars: Vec<char> = stem.chars().collect();
            if let Some(first) = chars.first_mut() {
                *first = first.to_uppercase().next().unwrap_or(*first);
            }
            chars.into_iter().collect()
        }
    };
    name.chars().take(60).collect()
}

/// Значок .exe → `data:image/png;base64,…` 48×48 (как значки приложений на macOS).
fn exe_icon(path: &str) -> Option<String> {
    const SIZE: i32 = 48;
    unsafe {
        let file = wide(path);
        let mut icon = HICON::default();
        if SHDefExtractIconW(PCWSTR(file.as_ptr()), 0, 0, Some(&mut icon), None, SIZE as u32).is_err() || icon.is_invalid() {
            return None;
        }
        // Рисуем на чёрном и на белом: разница даёт прозрачность и у старых значков без
        // альфа-канала (только маска), и у новых 32-битных.
        let draw = |background: u8| -> Option<Vec<u8>> {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return None;
            }
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = SIZE;
            bmi.bmiHeader.biHeight = -SIZE;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0;
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let out = match CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(bitmap) if !bits.is_null() => {
                    let old = SelectObject(dc, bitmap.into());
                    let n = (SIZE * SIZE * 4) as usize;
                    std::ptr::write_bytes(bits as *mut u8, background, n);
                    let ok = DrawIconEx(dc, 0, 0, icon, SIZE, SIZE, 0, None, DI_NORMAL).is_ok();
                    let pixels = ok.then(|| std::slice::from_raw_parts(bits as *const u8, n).to_vec());
                    SelectObject(dc, old);
                    let _ = DeleteObject(bitmap.into());
                    pixels
                }
                Ok(bitmap) => {
                    let _ = DeleteObject(bitmap.into());
                    None
                }
                Err(_) => None,
            };
            let _ = DeleteDC(dc);
            out
        };
        let black = draw(0);
        let white = draw(255);
        let _ = DestroyIcon(icon);
        let (black, white) = (black?, white?);
        let mut bgra = vec![0u8; black.len()];
        for i in (0..black.len()).step_by(4) {
            // white − black = 255·(1 − α) по каждому каналу; берём зелёный (самый точный).
            let alpha = 255 - (white[i + 1] as i32 - black[i + 1] as i32).clamp(0, 255);
            if alpha > 0 {
                for c in 0..3 {
                    bgra[i + c] = ((black[i + c] as i32 * 255 + alpha / 2) / alpha).min(255) as u8;
                }
            }
            bgra[i + 3] = alpha as u8;
        }
        if bgra.chunks_exact(4).all(|p| p[3] == 0) {
            return None;
        }
        let png = encode_png(&bgra, SIZE as u32).ok()?;
        use base64::Engine as _;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
    }
}

/// BGRA (без предумножения) → PNG через WIC. Поток с COM (`ComGuard`).
fn encode_png(bgra: &[u8], side: u32) -> windows::core::Result<Vec<u8>> {
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let stream = CreateStreamOnHGlobal(Default::default(), true)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut props = None;
        encoder.CreateNewFrame(&mut frame, &mut props)?;
        let frame = frame.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
        frame.Initialize(props.as_ref())?;
        frame.SetSize(side, side)?;
        let mut format = GUID_WICPixelFormat32bppBGRA;
        frame.SetPixelFormat(&mut format)?;
        frame.WritePixels(side, side * 4, bgra)?;
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

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn cloaked(hwnd: HWND) -> bool {
    let mut value = 0u32;
    unsafe { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut value as *mut u32 as *mut _, 4).is_ok() && value != 0 }
}

fn frame_rect(hwnd: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    unsafe {
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).is_err()
            && GetWindowRect(hwnd, &mut r).is_err()
        {
            return None;
        }
    }
    let rect = Rect::new(r.left, r.top, r.right, r.bottom);
    (!rect.is_empty()).then_some(rect)
}

/// Владелец окна-источника (`window:<HWND>`) — id приложения.
pub fn window_owner_id(hwnd: isize) -> String {
    privacy::normalize_id(&process_stem(window_pid(HWND(hwnd as *mut _))))
}

/// Прямоугольник монитора в экранных координатах.
pub fn monitor_rect(monitor: isize) -> Option<Rect> {
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe {
        if !GetMonitorInfoW(HMONITOR(monitor as *mut _), &mut info).as_bool() {
            return None;
        }
    }
    let r = info.rcMonitor;
    Some(Rect::new(r.left, r.top, r.right, r.bottom))
}

/// Запущенные приложения с видимыми окнами: `[{id, name, icon}]` (кроме самого
/// мессенджера). `id` — имя .exe (по нему скрываются окна), `name` и `icon` — из .exe.
pub fn list_apps() -> Vec<Value> {
    let _com = super::com::ComGuard::new();
    let own = unsafe { GetCurrentProcessId() };
    let mut seen: HashMap<String, String> = HashMap::new();  // id → путь к .exe
    for hwnd in top_level_windows() {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetAncestor(hwnd, GA_ROOT) != hwnd || cloaked(hwnd) {
                continue;
            }
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 || GetWindowTextLengthW(hwnd) <= 0 {
                continue;
            }
        }
        let pid = window_pid(hwnd);
        if pid == own || pid == 0 {
            continue;
        }
        let path = process_path(pid);
        let stem = path_stem(&path);
        if stem.is_empty() {
            continue;
        }
        let id = privacy::normalize_id(&stem);
        if id == "explorer" || id == "applicationframehost" || id == "textinputhost" || id == "shellexperiencehost" {
            continue;
        }
        seen.entry(id).or_insert(path);
    }
    let mut out: Vec<(String, String, Option<String>)> = seen
        .into_iter()
        .map(|(id, path)| {
            let name = friendly_name(&path, &path_stem(&path));
            let icon = exe_icon(&path);
            (id, name, icon)
        })
        .collect();
    out.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    out.into_iter()
        .map(|(id, name, icon)| {
            let mut app = json!({ "id": id, "name": name });
            if let Some(icon) = icon {
                app["icon"] = json!(icon);
            }
            app
        })
        .collect()
}

// --- трекер окон ----------------------------------------------------------------------

/// Состояние трекера: маска, поколение состояния скрытия, для которого она посчитана
/// (`u64::MAX` — ещё ни разу: кадр закрывается целиком, screen.rs), и что нужно опросу.
struct Tracker {
    generation: u64,
    mask: FrameMask,
    polled_at: Option<Instant>,
    previous: Vec<(isize, Rect, Style)>,
    names: HashMap<u32, String>,
    names_at: Instant,
}

impl Tracker {
    fn reset(&mut self) {
        self.generation = u64::MAX;
        self.mask = FrameMask::default();
        self.polled_at = None;
        self.previous.clear();
    }

    fn poll(&mut self) {
        self.polled_at = Some(Instant::now());
        let own = unsafe { GetCurrentProcessId() };
        // Поколение — до чтения состояния: изменение посреди опроса даст новый опрос.
        let generation = privacy::generation();
        let apps: HashMap<String, Style> = privacy::snapshot().video_apps().into_iter().collect();
        if apps.is_empty() {
            self.previous.clear();
            self.generation = generation;
            self.mask = FrameMask::default();
            return;
        }
        // pid переиспользуются — кэш имён живёт не дольше пары секунд.
        if self.names_at.elapsed() > Duration::from_secs(2) {
            self.names.clear();
            self.names_at = Instant::now();
        }
        let mut windows = Vec::new();
        for hwnd in top_level_windows() {
            unsafe {
                if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || cloaked(hwnd) {
                    continue;
                }
            }
            let Some(rect) = frame_rect(hwnd) else { continue };
            let pid = window_pid(hwnd);
            let id = match self.names.get(&pid) {
                Some(id) => id.clone(),
                None => {
                    let id = privacy::normalize_id(&process_stem(pid));
                    // Пустое имя (процесс ещё не открывается) не кэшируем — спросим в следующем опросе.
                    if !id.is_empty() {
                        self.names.insert(pid, id.clone());
                    }
                    id
                }
            };
            let hidden = if pid == own { None } else { apps.get(&id).copied() };
            let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
            let mut affinity = 0u32;
            unsafe {
                let _ = GetWindowDisplayAffinity(hwnd, &mut affinity);
            }
            let overlay_like = ex & (WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOPMOST.0 | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) != 0;
            windows.push(TrackedWindow {
                id: hwnd.0 as isize,
                rect,
                hidden,
                captured: affinity != WDA_EXCLUDEFROMCAPTURE && !overlay_like,
            });
        }
        self.mask = mask_from_windows(&windows, &mut self.previous, ROUNDING);
        self.generation = generation;
    }
}

fn tracker() -> &'static Mutex<Tracker> {
    static TRACKER: OnceLock<Mutex<Tracker>> = OnceLock::new();
    TRACKER.get_or_init(|| {
        Mutex::new(Tracker {
            generation: u64::MAX,
            mask: FrameMask::default(),
            polled_at: None,
            previous: Vec::new(),
            names: HashMap::new(),
            names_at: Instant::now(),
        })
    })
}

static USERS: AtomicUsize = AtomicUsize::new(0);
/// Номер живого потока трекера: старый поток, ещё не заметивший, что охранников не
/// осталось, выходит, когда поднялся новый, — двух потоков не бывает.
static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Пока жив хотя бы один охранник, трекер работает (поток поднимается сам).
pub struct TrackGuard;

impl Drop for TrackGuard {
    fn drop(&mut self) {
        USERS.fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn track() -> TrackGuard {
    if USERS.fetch_add(1, Ordering::AcqRel) == 0 {
        let epoch = EPOCH.fetch_add(1, Ordering::AcqRel) + 1;
        tracker().lock().unwrap_or_else(|p| p.into_inner()).reset();
        let _ = std::thread::Builder::new().name("zali-privacy-windows".into()).spawn(move || run_tracker(epoch));
    }
    TrackGuard
}

/// Маска скрытых окон (экранные координаты) для кадра, взятого из захвата в `frame_at`,
/// и поколение состояния (`privacy::generation`), для которого она посчитана.
///
/// Опрос — по кадрам: если последний опрос начат раньше `frame_at`, опросить сейчас,
/// синхронно (EnumWindows, около миллисекунды). Окно, которое есть на кадре, в таком
/// опросе уже есть — первый кадр появившегося окна не уходит открытым. Объединение с
/// прошлым опросом (`mask_from_windows`) закрывает и кадр, отставший на один в
/// конвейере GPU.
pub fn regions_for_frame(frame_at: Instant) -> (u64, FrameMask) {
    let mut t = tracker().lock().unwrap_or_else(|p| p.into_inner());
    if USERS.load(Ordering::Acquire) > 0 && t.polled_at.map_or(true, |at| at < frame_at || t.generation != privacy::generation()) {
        t.poll();
    }
    (t.generation, t.mask.clone())
}

/// Поток держит маску свежей, пока кадров нет (экран стоит, WGC молчит): пока кадры
/// идут, опрашивают они сами.
fn run_tracker(epoch: u64) {
    while USERS.load(Ordering::Acquire) > 0 && EPOCH.load(Ordering::Acquire) == epoch {
        {
            let mut t = tracker().lock().unwrap_or_else(|p| p.into_inner());
            if t.polled_at.map_or(true, |at| at.elapsed() >= IDLE_POLL) || t.generation != privacy::generation() {
                t.poll();
            }
        }
        std::thread::sleep(POLL);
    }
    if EPOCH.load(Ordering::Acquire) == epoch {
        tracker().lock().unwrap_or_else(|p| p.into_inner()).reset();
    }
}

// --- надпись плашки -------------------------------------------------------------------

fn labels() -> &'static Mutex<HashMap<usize, Option<LabelMask>>> {
    static CACHE: OnceLock<Mutex<HashMap<usize, Option<LabelMask>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Маска надписи плашки кеглем `size` px (кэшируется).
pub fn label_mask(size: usize) -> Option<LabelMask> {
    let mut cache = labels().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(found) = cache.get(&size) {
        return found.clone();
    }
    let mask = unsafe { render_label(size as i32) };
    cache.insert(size, mask.clone());
    mask
}

unsafe fn render_label(size: i32) -> Option<LabelMask> {
    let dc = CreateCompatibleDC(None);
    if dc.is_invalid() {
        return None;
    }
    let face: Vec<u16> = "Segoe UI".encode_utf16().chain(Some(0)).collect();
    let font = CreateFontW(
        -size, 0, 0, 0, FW_SEMIBOLD.0 as i32, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
        ANTIALIASED_QUALITY, DEFAULT_PITCH.0 as u32, PCWSTR(face.as_ptr()),
    );
    let old_font = SelectObject(dc, font.into());
    let mut text: Vec<u16> = PLATE_TEXT.encode_utf16().collect();
    let mut measure = RECT::default();
    DrawTextW(dc, &mut text, &mut measure, DT_CALCRECT | DT_SINGLELINE | DT_NOPREFIX);
    let (w, h) = ((measure.right - measure.left).max(1) + 4, (measure.bottom - measure.top).max(1) + 2);
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0;
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let result = match CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(bitmap) if !bits.is_null() => {
            let old_bitmap = SelectObject(dc, bitmap.into());
            std::ptr::write_bytes(bits as *mut u32, 0, (w * h) as usize);
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, COLORREF(0x00FF_FFFF));
            let mut rect = RECT { left: 2, top: 1, right: w, bottom: h };
            DrawTextW(dc, &mut text, &mut rect, DT_SINGLELINE | DT_NOPREFIX);
            let raw = std::slice::from_raw_parts(bits as *const u32, (w * h) as usize);
            let alpha: Vec<u8> = raw.iter().map(|px| ((px >> 8) & 0xFF) as u8).collect();
            SelectObject(dc, old_bitmap);
            let _ = DeleteObject(bitmap.into());
            Some(LabelMask { width: w as usize, height: h as usize, alpha })
        }
        Ok(bitmap) => {
            let _ = DeleteObject(bitmap.into());
            None
        }
        Err(_) => None,
    };
    SelectObject(dc, old_font);
    let _ = DeleteObject(font.into());
    let _ = DeleteDC(dc);
    result
}

// --- звук: сессии и дерево процессов ---------------------------------------------------

/// pid процессов со звуковыми сессиями на всех активных устройствах вывода.
pub fn audio_session_pids() -> Vec<u32> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{eRender, IAudioSessionControl2, IAudioSessionManager2, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::CLSCTX_ALL;
    let mut out = Vec::new();
    let Ok(enumerator) = super::devices::enumerator() else { return out };
    unsafe {
        let Ok(devices) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out };
        let count = devices.GetCount().unwrap_or(0);
        for i in 0..count {
            let Ok(device) = devices.Item(i) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
            for j in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(control) = sessions.GetSession(j) else { continue };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                // S_OK — сессия системных звуков (pid 0), её process loopback не берёт.
                if control2.IsSystemSoundsSession().0 == 0 {
                    continue;
                }
                if let Ok(pid) = control2.GetProcessId() {
                    if pid != 0 && !out.contains(&pid) {
                        out.push(pid);
                    }
                }
            }
        }
    }
    out
}

/// Снимок процессов: pid, родитель, id (.exe без расширения, нижний регистр).
pub fn process_table() -> Vec<privacy::ProcInfo> {
    use windows_sys::Win32::Foundation::{CloseHandle as CloseRaw, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            out.push(privacy::ProcInfo { pid: entry.th32ProcessID, parent: entry.th32ParentProcessID, id: privacy::normalize_id(&name) });
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseRaw(snap);
    }
    out
}
