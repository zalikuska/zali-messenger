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
#![cfg_attr(not(target_os = "windows"), allow(dead_code))] // потребители — только в Windows-сборке

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

/// Порог «здесь есть чернила» для границ знака: слабый ореол сглаживания (меньше ~10 %)
/// не должен двигать центр.
const INK_THRESHOLD: u8 = 26;

/// Сдвигает карту покрытия так, чтобы **нарисованные пиксели** — а не строка шрифта —
/// стояли по центру круга.
///
/// GDI `DT_VCENTER` центрует строку по высоте шрифта (подъём + спуск + внутренний
/// интерлиньяж). У цифр и «+» нет ничего под базовой линией, поэтому знак оказывался
/// заметно выше центра, а `DT_CENTER` центрует ширину **продвижения** с боковыми
/// зазорами глифа: «1» и «9+» стояли каждый со своим сдвигом влево или вправо.
///
/// Края знака берутся с учётом сглаживания: крайний столбец с покрытием 50 % значит,
/// что штрих начинается на полпикселя вглубь него. По горизонтали сдвиг дробный, с шагом
/// в четверть пикселя (линейная интерполяция соседних столбцов) — на 16–24 px полпикселя
/// ошибки уже видны глазом. По вертикали сдвиг целый: карта уже сглажена шрифтом, а
/// плоские верх и низ цифр не должны расплываться. Знак не выходит за край карты.
/// Пустая карта возвращается как есть.
pub(crate) fn center_mask(size: i32, mask: &[u8]) -> Vec<u8> {
    let n = size.max(0) as usize;
    if n == 0 || mask.len() != n * n {
        return mask.to_vec();
    }
    // Максимум покрытия по столбцам и строкам.
    let mut col = vec![0u8; n];
    let mut row = vec![0u8; n];
    for y in 0..n {
        for x in 0..n {
            let v = mask[y * n + x];
            col[x] = col[x].max(v);
            row[y] = row[y].max(v);
        }
    }
    // Крайние позиции штриха в долях пикселя: [от, до) по оси.
    let edges = |axis: &[u8]| -> Option<(f32, f32)> {
        let first = axis.iter().position(|v| *v >= INK_THRESHOLD)?;
        let last = axis.iter().rposition(|v| *v >= INK_THRESHOLD)?;
        let start = first as f32 + (1.0 - axis[first] as f32 / 255.0);
        let end = last as f32 + axis[last] as f32 / 255.0;
        Some((start, end.max(start)))
    };
    let (Some((x0, x1)), Some((y0, y1))) = (edges(&col), edges(&row)) else {
        return mask.to_vec();
    };
    let centre = size as f32 / 2.0;
    let limit = size as f32;
    // Не выпускаем знак за карту: сдвиг ограничен свободным местом с каждой стороны.
    let dx = (centre - (x0 + x1) / 2.0).clamp(-x0, limit - x1);
    let dy = ((centre - (y0 + y1) / 2.0).clamp(-y0, limit - y1)).round() as i32;
    let dx = (dx * 4.0).round() / 4.0;

    let whole = dx.floor();
    let frac = dx - whole;
    let whole = whole as i32;
    let at = |y: i32, x: i32| -> f32 {
        if (0..n as i32).contains(&x) && (0..n as i32).contains(&y) {
            mask[y as usize * n + x as usize] as f32
        } else {
            0.0
        }
    };
    let mut out = vec![0u8; n * n];
    for y in 0..n as i32 {
        for x in 0..n as i32 {
            // Пиксель (x, y) нового кадра берётся из (x - dx, y - dy) старого.
            let sy = y - dy;
            let sx = x - whole;
            let v = at(sy, sx) * (1.0 - frac) + at(sy, sx - 1) * frac;
            out[y as usize * n + x as usize] = v.round().clamp(0.0, 255.0) as u8;
        }
    }
    out
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

    /// Рамка пикселей с покрытием выше порога: (x0, x1, y0, y1) включительно.
    fn ink_box(size: i32, mask: &[u8]) -> (i32, i32, i32, i32) {
        let (mut x0, mut x1, mut y0, mut y1) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
        for y in 0..size {
            for x in 0..size {
                if mask[(y * size + x) as usize] >= INK_THRESHOLD {
                    x0 = x0.min(x);
                    x1 = x1.max(x);
                    y0 = y0.min(y);
                    y1 = y1.max(y);
                }
            }
        }
        (x0, x1, y0, y1)
    }

    #[test]
    fn a_glyph_drawn_high_and_left_is_pulled_to_the_centre() {
        // «Цифра», как её отдаёт DT_VCENTER: выше центра и левее.
        let size = 16;
        let mut mask = vec![0u8; 256];
        for y in 2..9 {
            for x in 3..7 {
                mask[y * 16 + x] = 255;
            }
        }
        let moved = center_mask(size, &mask);
        let (x0, x1, y0, y1) = ink_box(size, &moved);
        // Рамка 4×7 в карте 16×16: по обе стороны остаётся поровну (±1 пиксель).
        assert!(((x0) - (15 - x1)).abs() <= 1, "horizontally off-centre: {x0}..{x1}");
        assert!(((y0) - (15 - y1)).abs() <= 1, "vertically off-centre: {y0}..{y1}");
        // Ничего не потеряно и не добавлено.
        assert_eq!(moved.iter().filter(|v| **v == 255).count(), 4 * 7);
    }

    #[test]
    fn an_already_centred_glyph_does_not_move() {
        let size = 16;
        let mut mask = vec![0u8; 256];
        for y in 5..11 {
            for x in 6..10 {
                mask[y * 16 + x] = 200;
            }
        }
        assert_eq!(center_mask(size, &mask), mask);
    }

    #[test]
    fn a_faint_halo_does_not_pull_the_centre() {
        let size = 16;
        let mut mask = vec![0u8; 256];
        for y in 5..11 {
            for x in 6..10 {
                mask[y * 16 + x] = 255;
            }
        }
        mask[0] = 10; // слабый шум в углу, ниже порога
        let moved = center_mask(size, &mask);
        let (x0, x1, y0, y1) = ink_box(size, &moved);
        assert_eq!((x0, x1, y0, y1), (6, 9, 5, 10));
    }

    /// Центр знака по яркости краёв: (x, y) в долях пикселя.
    fn ink_centre(size: i32, mask: &[u8]) -> (f32, f32) {
        let n = size as usize;
        let (mut sx, mut sy, mut sum) = (0f32, 0f32, 0f32);
        for y in 0..n {
            for x in 0..n {
                let v = mask[y * n + x] as f32;
                sx += (x as f32 + 0.5) * v;
                sy += (y as f32 + 0.5) * v;
                sum += v;
            }
        }
        (sx / sum, sy / sum)
    }

    #[test]
    fn a_half_pixel_horizontal_error_is_corrected_with_a_fractional_shift() {
        // Штрих 4 px шириной, левый край заходит на полпикселя вглубь столбца 5 (покрытие 50 %),
        // правый край — на 50 % столбца 10: рамка [5.5, 10.5), центр 8.0 при центре круга 8.0…
        let size = 16;
        let mut mask = vec![0u8; 256];
        for y in 5..11 {
            mask[y * 16 + 5] = 128;
            for x in 6..10 {
                mask[y * 16 + x] = 255;
            }
            mask[y * 16 + 10] = 128;
        }
        let (cx, _) = ink_centre(size, &mask);
        assert!((cx - 8.0).abs() < 0.05, "fixture must start centred, got {cx}");
        // …а теперь сдвигаем фикстуру на 3/4 пикселя влево и просим вернуть.
        let mut shifted = vec![0u8; 256];
        for y in 5..11 {
            // 3/4 px влево: 25 % из столбца справа-налево перетекает в соседний.
            for x in 0..15 {
                let a = mask[y * 16 + x] as f32;
                let b = mask[y * 16 + x + 1] as f32;
                shifted[y * 16 + x] = (a * 0.25 + b * 0.75).round() as u8;
            }
        }
        let (before, _) = ink_centre(size, &shifted);
        assert!((before - 8.0).abs() > 0.5, "fixture must start off-centre, got {before}");
        let fixed = center_mask(size, &shifted);
        let (after, _) = ink_centre(size, &fixed);
        assert!((after - 8.0).abs() <= 0.15, "centre must land within 1/8 px of 8.0, got {after}");
    }

    #[test]
    fn a_wide_label_and_a_narrow_digit_both_end_up_centred() {
        // «9+»: широкий знак у левого края; «1»: узкий у правого. Оба — к центру.
        let size = 24;
        let draw = |x_from: usize, x_to: usize| {
            let mut m = vec![0u8; 576];
            for y in 7..17 {
                for x in x_from..x_to {
                    m[y * 24 + x] = 255;
                }
            }
            m
        };
        for mask in [draw(2, 14), draw(15, 18)] {
            let fixed = center_mask(size, &mask);
            let (cx, cy) = ink_centre(size, &fixed);
            assert!((cx - 12.0).abs() <= 0.2, "x centre {cx}");
            assert!((cy - 12.0).abs() <= 0.6, "y centre {cy}");
        }
    }

    #[test]
    fn empty_and_malformed_masks_are_returned_untouched() {
        assert_eq!(center_mask(16, &vec![0u8; 256]), vec![0u8; 256]);
        assert_eq!(center_mask(16, &[1, 2, 3]), vec![1, 2, 3]);
        assert!(center_mask(0, &[]).is_empty());
    }

    #[test]
    fn the_glyph_never_leaves_the_map() {
        let size = 16;
        let mut mask = vec![0u8; 256];
        // Знак у самого края: после сдвига к центру он целиком внутри карты.
        for y in 0..3 {
            for x in 13..16 {
                mask[y * 16 + x] = 255;
            }
        }
        let moved = center_mask(size, &mask);
        // Дробный сдвиг смешивает соседние столбцы, но суммарное покрытие сохраняется:
        // знак не обрезан и не потерял яркость.
        let sum = |m: &[u8]| m.iter().map(|v| *v as u32).sum::<u32>();
        let diff = (sum(&moved) as i64 - sum(&mask) as i64).abs();
        assert!(diff <= 9, "coverage lost or gained: {} -> {}", sum(&mask), sum(&moved));
    }

    #[test]
    fn labels_cap_at_nine_plus() {
        assert_eq!(badge_label(1), "1");
        assert_eq!(badge_label(9), "9");
        assert_eq!(badge_label(10), "9+");
        assert_eq!(badge_label(250), "9+");
    }
}
