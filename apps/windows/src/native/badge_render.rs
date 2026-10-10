//! Растеризация кружка со счётчиком для оверлея на панели задач — без Win32, чтобы
//! её можно было проверить тестами на любой платформе (`taskbar_badge.rs` отдаёт
//! сюда только то, что умеет Windows: размер под DPI и маску цифр из GDI).
//!
//! Три вещи, из-за которых прежний значок выглядел плохо:
//! - **Цвет.** DIB 32 bpp — это `0xAARRGGBB`, а «красный» был записан как
//!   `0xFF2A2AE6`, то есть R=0x2A, B=0xE6: синий. Цвета задаются парами (r, g, b),
//!   упаковка — в одном месте (`pack`).
//! - **Размер.** Иконка всегда 16×16, а на мониторе 150–200 % оболочка растягивала
//!   её до 24–32 px. Теперь размер выводится из DPI окна.
//! - **Края и цифры.** Круг рисовался по порогу «внутри/снаружи», цифры — блоками
//!   3×5 пикселей. Теперь покрытие круга считается суперсэмплингом, а цифры
//!   приходят уже со сглаживанием от шрифта.

/// Красный бейдж непрочитанного.
pub(crate) const BADGE_RGB: (u8, u8, u8) = (0xE6, 0x2A, 0x2A);
const TEXT_RGB: (u8, u8, u8) = (0xFF, 0xFF, 0xFF);
/// Сторона суперсэмпла: 4×4 образца на пиксель — достаточно для гладкого края
/// при размерах 16–48 px и дёшево (меньше 50 тыс. проб).
const SUPERSAMPLE: i32 = 4;

/// Сторона оверлея в пикселях для окна с заданным DPI (96 = 100 %). Оверлей
/// рисуется в «малую иконку» системы: 16 px при 100 %, 20 при 125 %, 24 при 150 %.
pub(crate) fn badge_size_for_dpi(dpi: u32) -> i32 {
    let dpi = dpi.max(96);
    (((16 * dpi) + 48) / 96).clamp(16, 48) as i32
}

/// Доля пикселя `(x, y)`, лежащая внутри круга, вписанного в квадрат `size`.
fn circle_coverage(size: i32, x: i32, y: i32) -> f32 {
    let radius = size as f32 / 2.0;
    let centre = radius;
    let mut inside = 0;
    for sy in 0..SUPERSAMPLE {
        for sx in 0..SUPERSAMPLE {
            let px = x as f32 + (sx as f32 + 0.5) / SUPERSAMPLE as f32;
            let py = y as f32 + (sy as f32 + 0.5) / SUPERSAMPLE as f32;
            let dx = px - centre;
            let dy = py - centre;
            if dx * dx + dy * dy <= radius * radius {
                inside += 1;
            }
        }
    }
    inside as f32 / (SUPERSAMPLE * SUPERSAMPLE) as f32
}

fn lerp(a: u8, b: u8, t: f32) -> f32 {
    a as f32 + (b as f32 - a as f32) * t
}

/// Упаковка в DIB 32 bpp: `0xAARRGGBB`, цвет **предумножен** на альфу (так иконки
/// из CreateIconIndirect смешиваются оболочкой без тёмной каймы по краю).
fn pack(r: f32, g: f32, b: f32, alpha: f32) -> u32 {
    let a = (alpha * 255.0).round().clamp(0.0, 255.0) as u32;
    let premul = |c: f32| (c * alpha).round().clamp(0.0, 255.0) as u32;
    (a << 24) | (premul(r) << 16) | (premul(g) << 8) | premul(b)
}

/// Собирает пиксели значка: красный круг, поверх него белый текст. `text` — карта
/// покрытия цифр `size × size`, 0..=255 (из GDI: серый на чёрном).
pub(crate) fn compose_badge(size: i32, text: &[u8]) -> Vec<u32> {
    let mut out = Vec::with_capacity((size * size) as usize);
    for y in 0..size {
        for x in 0..size {
            let circle = circle_coverage(size, x, y);
            if circle <= 0.0 {
                out.push(0);
                continue;
            }
            let t = text
                .get((y * size + x) as usize)
                .copied()
                .unwrap_or(0) as f32
                / 255.0;
            let r = lerp(BADGE_RGB.0, TEXT_RGB.0, t);
            let g = lerp(BADGE_RGB.1, TEXT_RGB.1, t);
            let b = lerp(BADGE_RGB.2, TEXT_RGB.2, t);
            out.push(pack(r, g, b, circle));
        }
    }
    out
}

/// Подпись бейджа: число, а от 10 — «9+».
pub(crate) fn badge_label(count: u32) -> String {
    if count > 9 {
        "9+".to_string()
    } else {
        count.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channels(pixel: u32) -> (u32, u32, u32, u32) {
        ((pixel >> 24) & 0xFF, (pixel >> 16) & 0xFF, (pixel >> 8) & 0xFF, pixel & 0xFF)
    }

    #[test]
    fn the_badge_is_red_not_blue() {
        // Прежняя константа 0xFF2A2AE6 в ARGB — это B=0xE6: синий.
        let pixels = compose_badge(16, &vec![0u8; 256]);
        let (a, r, g, b) = channels(pixels[8 * 16 + 4]);
        assert_eq!(a, 255);
        assert!(r > 200 && g < 80 && b < 80, "expected red, got r={r} g={g} b={b}");
    }

    #[test]
    fn the_corners_are_transparent_and_the_rim_is_smooth() {
        let size = 24;
        let pixels = compose_badge(size, &vec![0u8; (size * size) as usize]);
        assert_eq!(pixels[0], 0, "corner outside the circle");
        let partial = pixels
            .iter()
            .filter(|p| {
                let a = (**p >> 24) & 0xFF;
                a > 0 && a < 255
            })
            .count();
        assert!(partial >= 16, "an anti-aliased rim needs partial alpha, got {partial} pixels");
    }

    #[test]
    fn text_coverage_turns_the_pixel_white_in_between() {
        let size = 16;
        let mut text = vec![0u8; 256];
        text[8 * 16 + 8] = 255; // полностью текст
        text[8 * 16 + 9] = 128; // край штриха
        let pixels = compose_badge(size, &text);
        let (_, r, g, b) = channels(pixels[8 * 16 + 8]);
        assert!(r > 250 && g > 250 && b > 250, "solid glyph pixel must be white");
        let (_, r, g, _) = channels(pixels[8 * 16 + 9]);
        assert!(r > 230 && g > 100 && g < 200, "half-covered pixel blends red and white, got r={r} g={g}");
    }

    #[test]
    fn the_size_follows_the_display_scale() {
        assert_eq!(badge_size_for_dpi(96), 16);
        assert_eq!(badge_size_for_dpi(120), 20);
        assert_eq!(badge_size_for_dpi(144), 24);
        assert_eq!(badge_size_for_dpi(192), 32);
        assert_eq!(badge_size_for_dpi(0), 16, "a failed DPI query falls back to 100 %");
        assert!(badge_size_for_dpi(9600) <= 48);
    }

    #[test]
    fn labels_cap_at_nine_plus() {
        assert_eq!(badge_label(1), "1");
        assert_eq!(badge_label(9), "9");
        assert_eq!(badge_label(10), "9+");
        assert_eq!(badge_label(250), "9+");
    }
}
