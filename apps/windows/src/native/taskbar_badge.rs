//! Windows-only: renders a small red-circle "unread count" badge and applies it as
//! the window's taskbar overlay icon via `ITaskbarList3::SetOverlayIcon`. There is no
//! equivalent on the experimental macOS Rust shell (no taskbar to overlay) or the
//! primary Swift client — this feature is Windows-specific by request, gated end to
//! end by the `taskbarBadge` native capability (see `NativeCapabilities` in
//! `native.rs`), so `nativeSupports('taskbarBadge')` on the JS side is false anywhere
//! else and this code never runs there.
//!
//! NOTE: originally written against the documented Win32/COM surface (windows-rs
//! 0.61) without compiling on a real Windows machine — cross-compiling to
//! x86_64-pc-windows-msvc from a Mac fails on unrelated `ring` C code (see
//! CLAUDE.md). The `.github/workflows/build-windows.yml` CI run caught the actual
//! signature mismatches (`CreateBitmap` returns `HBITMAP` directly rather than a
//! `Result`, `DeleteObject` takes `HGDIOBJ` not `HBITMAP`, `SetOverlayIcon`'s icon
//! param is a plain `HICON` not `Option<HICON>`) — fixed against that feedback.
//! A failure here is still designed to be silent (a missing badge), never a crash.

use super::badge_render::{badge_label, badge_size_for_dpi, compose_badge};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject,
    DrawTextW, SelectObject, SetBkMode, SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH,
    DIB_RGB_COLORS, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FW_BOLD, OUT_DEFAULT_PRECIS,
    TRANSPARENT,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList};
use windows::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, DestroyIcon, HICON, ICONINFO};

/// Рисует `label` белым на чёрном в DIB `size`×`size` (GDI, сглаженный шрифт) и
/// возвращает карту покрытия 0..=255. Цифры получаются гладкими штрихами Segoe UI,
/// а не блоками 3×5 пикселей, как раньше.
///
/// # Safety
/// `dc` — валидный совместимый DC; `pixels` указывает на `size*size` u32 DIB-секции,
/// выбранной в этот DC.
unsafe fn render_text_coverage(
    dc: windows::Win32::Graphics::Gdi::HDC,
    pixels: *mut u32,
    size: i32,
    label: &str,
) -> Vec<u8> {
    let count = (size * size) as usize;
    std::ptr::write_bytes(pixels, 0, count);

    // Высота знака ~58 % стороны: две цифры «9+» ещё помещаются в круг.
    let height = -((size as f32 * 0.58).round() as i32).max(8);
    let face: Vec<u16> = "Segoe UI".encode_utf16().chain(Some(0)).collect();
    let font = CreateFontW(
        height,
        0,
        0,
        0,
        FW_BOLD.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        ANTIALIASED_QUALITY,
        DEFAULT_PITCH.0 as u32,
        PCWSTR(face.as_ptr()),
    );
    let previous = SelectObject(dc, font.into());
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, COLORREF(0x00FF_FFFF));

    let mut text: Vec<u16> = label.encode_utf16().collect();
    let mut rect = RECT { left: 0, top: 0, right: size, bottom: size };
    DrawTextW(dc, &mut text, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    SelectObject(dc, previous);
    let _ = DeleteObject(font.into());

    // Серый на чёрном: любой цветовой канал — это покрытие.
    let raw = std::slice::from_raw_parts(pixels, count);
    raw.iter().map(|px| ((px >> 8) & 0xFF) as u8).collect()
}

/// Строит иконку-бейдж `size`×`size` с подписью `label`. `None` — при любой
/// ошибке GDI.
fn build_badge_icon(label: &str, size: i32) -> Option<HICON> {
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = size;
    bmi.bmiHeader.biHeight = -size; // negative height = top-down DIB
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0 as u32;

    let dc = unsafe { CreateCompatibleDC(None) };
    let mut bits_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let color_bitmap = unsafe { CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits_ptr, None, 0) };
    let Ok(color_bitmap) = color_bitmap else {
        unsafe {
            let _ = DeleteDC(dc);
        }
        return None;
    };
    if bits_ptr.is_null() {
        unsafe {
            let _ = DeleteObject(color_bitmap.into());
            let _ = DeleteDC(dc);
        }
        return None;
    }

    let pixel_ptr = bits_ptr as *mut u32;
    let coverage = unsafe {
        let previous = SelectObject(dc, color_bitmap.into());
        let coverage = render_text_coverage(dc, pixel_ptr, size, label);
        SelectObject(dc, previous);
        coverage
    };

    // Круг и текст собираются в чистом коде (badge_render.rs) и пишутся в тот же
    // DIB: предумноженный ARGB, красный круг с гладким краем.
    let composed = compose_badge(size, &coverage);
    let pixels = unsafe { std::slice::from_raw_parts_mut(pixel_ptr, composed.len()) };
    pixels.copy_from_slice(&composed);

    // Fully-zero 1bpp mask: the color bitmap's own alpha channel drives
    // transparency for a 32bpp icon, so the mask just needs to not black out
    // anything. Unlike CreateDIBSection, CreateBitmap returns the handle
    // directly (not a Result) — a failure comes back as a null/invalid handle.
    let mask_bitmap = unsafe { CreateBitmap(size, size, 1, 1, None) };
    if mask_bitmap.is_invalid() {
        unsafe {
            let _ = DeleteObject(color_bitmap.into());
            let _ = DeleteDC(dc);
        }
        return None;
    }

    let icon_info = ICONINFO {
        fIcon: windows::Win32::Foundation::TRUE,
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: mask_bitmap,
        hbmColor: color_bitmap,
    };
    let hicon = unsafe { CreateIconIndirect(&icon_info) };

    unsafe {
        let _ = DeleteObject(color_bitmap.into());
        let _ = DeleteObject(mask_bitmap.into());
        let _ = DeleteDC(dc);
    }

    hicon.ok()
}

/// Sets (count > 0) or clears (count == 0) the taskbar overlay badge for the window
/// behind `hwnd_raw` (a raw HWND value, e.g. from `raw_window_handle::Win32Handle`).
/// Best-effort: any Win32/COM failure is swallowed — a missing badge is a cosmetic
/// regression, not worth taking down the app over.
pub fn set_unread_badge(hwnd_raw: isize, count: u32) {
    let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);

    let taskbar: windows::core::Result<ITaskbarList3> =
        unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_ALL) };
    let Ok(taskbar) = taskbar else {
        return;
    };
    if unsafe { taskbar.HrInit() }.is_err() {
        return;
    }

    if count == 0 {
        unsafe {
            let _ = taskbar.SetOverlayIcon(hwnd, HICON::default(), PCWSTR::null());
        }
        return;
    }

    // Размер — по DPI окна: на 150 % оболочка не растягивает 16 px до 24.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let size = badge_size_for_dpi(dpi);
    let label = badge_label(count);
    let Some(hicon) = build_badge_icon(&label, size) else {
        return;
    };
    let description: Vec<u16> = format!("{count} непрочитанных")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        let _ = taskbar.SetOverlayIcon(hwnd, hicon, PCWSTR(description.as_ptr()));
        let _ = DestroyIcon(hicon);
    }
}
