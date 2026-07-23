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

use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList};
use windows::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, DestroyIcon, HICON, ICONINFO};

const SIZE: i32 = 16;

/// 3x5 bitmap font, one row per byte, 3 bits per row (bit 2 = leftmost column).
fn glyph_rows(ch: char) -> [u8; 5] {
    match ch {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0, 0, 0, 0, 0],
    }
}

/// Draws `ch` at (origin_x, origin_y) into a `canvas_size`-square top-down BGRA pixel
/// buffer, each font pixel scaled to a `scale`x`scale` block.
fn draw_glyph(pixels: &mut [u32], canvas_size: i32, ch: char, origin_x: i32, origin_y: i32, scale: i32, color: u32) {
    for (row_idx, row) in glyph_rows(ch).iter().enumerate() {
        for col in 0..3 {
            if (row >> (2 - col)) & 1 == 0 {
                continue;
            }
            for sy in 0..scale {
                for sx in 0..scale {
                    let x = origin_x + col * scale + sx;
                    let y = origin_y + row_idx as i32 * scale + sy;
                    if x >= 0 && y >= 0 && x < canvas_size && y < canvas_size {
                        pixels[(y * canvas_size + x) as usize] = color;
                    }
                }
            }
        }
    }
}

/// Builds a 16x16 red-circle badge icon with `label` (1-2 characters, e.g. "9" or
/// "9+") in white. Returns `None` on any GDI failure.
fn build_badge_icon(label: &str) -> Option<HICON> {
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = SIZE;
    bmi.bmiHeader.biHeight = -SIZE; // negative height = top-down DIB
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

    let pixel_count = (SIZE * SIZE) as usize;
    let pixels = unsafe { std::slice::from_raw_parts_mut(bits_ptr as *mut u32, pixel_count) };

    // BGRA, one solid red circle; fully transparent outside it.
    const RED: u32 = 0xFF2A2AE6;
    const WHITE: u32 = 0xFFFFFFFF;
    let radius = SIZE as f32 / 2.0;
    let center = radius - 0.5;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let inside = (dx * dx + dy * dy).sqrt() <= radius;
            pixels[(y * SIZE + x) as usize] = if inside { RED } else { 0 };
        }
    }

    let chars: Vec<char> = label.chars().take(2).collect();
    match chars.as_slice() {
        [a] => draw_glyph(pixels, SIZE, *a, 5, 3, 2, WHITE),
        [a, b] => {
            draw_glyph(pixels, SIZE, *a, 1, 3, 2, WHITE);
            draw_glyph(pixels, SIZE, *b, 9, 3, 2, WHITE);
        }
        _ => {}
    }

    // Fully-zero 1bpp mask: the color bitmap's own alpha channel drives
    // transparency for a 32bpp icon, so the mask just needs to not black out
    // anything. Unlike CreateDIBSection, CreateBitmap returns the handle
    // directly (not a Result) — a failure comes back as a null/invalid handle.
    let mask_bitmap = unsafe { CreateBitmap(SIZE, SIZE, 1, 1, None) };
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

    let label = if count > 9 { "9+".to_string() } else { count.to_string() };
    let Some(hicon) = build_badge_icon(&label) else {
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
