//! Платформенно-независимая часть нативного захвата: формат кадра, раскладка NV12,
//! перевод BGRA → NV12, выбор режима камеры, размеры и коды ошибок. Тестируется на
//! любой платформе (`cargo test media`), весь Windows-код — в соседних модулях.
//!
//! Формат кадра — `.claude/skills/voice-calls/native-capture.md`, раздел «Кадры»;
//! разбор на стороне страницы — `zaliParseMediaFrame` в `web/src/interface/native_media.js`.

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

pub const MAGIC: u8 = 0x5A;
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 32;
pub const KIND_AUDIO: u8 = 1;
pub const KIND_VIDEO: u8 = 2;
pub const CODEC_PCM_F32: u8 = 1;
pub const CODEC_NV12: u8 = 2;
pub const FLAG_KEYFRAME: u8 = 1;

/// Заголовок кадра; `length` выставляет `encode_header` по длине данных.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameHeader {
    pub kind: u8,
    pub codec: u8,
    pub stream: u32,
    pub timestamp_us: u64,
    pub width: u16,
    pub height: u16,
    pub flags: u8,
    pub channels: u8,
    pub seq: u32,
}

impl FrameHeader {
    pub fn audio(stream: u32, timestamp_us: u64, channels: u8, seq: u32) -> Self {
        Self {
            kind: KIND_AUDIO,
            codec: CODEC_PCM_F32,
            stream,
            timestamp_us,
            channels,
            seq,
            ..Self::default()
        }
    }

    /// NV12 — каждый кадр самодостаточен, поэтому всегда «ключевой».
    pub fn nv12(stream: u32, timestamp_us: u64, width: u16, height: u16, seq: u32) -> Self {
        Self {
            kind: KIND_VIDEO,
            codec: CODEC_NV12,
            stream,
            timestamp_us,
            width,
            height,
            flags: FLAG_KEYFRAME,
            seq,
            ..Self::default()
        }
    }
}

/// Пишет 32 байта заголовка (little-endian) для данных длиной `payload_len`.
pub fn encode_header(h: &FrameHeader, payload_len: usize, out: &mut [u8]) {
    assert!(out.len() >= HEADER_LEN);
    out[0] = MAGIC;
    out[1] = VERSION;
    out[2] = h.kind;
    out[3] = h.codec;
    out[4..8].copy_from_slice(&h.stream.to_le_bytes());
    out[8..16].copy_from_slice(&h.timestamp_us.to_le_bytes());
    out[16..18].copy_from_slice(&h.width.to_le_bytes());
    out[18..20].copy_from_slice(&h.height.to_le_bytes());
    out[20] = h.flags;
    out[21] = h.channels;
    out[22..24].copy_from_slice(&0u16.to_le_bytes());
    out[24..28].copy_from_slice(&(payload_len as u32).to_le_bytes());
    out[28..32].copy_from_slice(&h.seq.to_le_bytes());
}

/// Обратный разбор — для тестов и самопроверки (страница делает то же самое).
#[cfg_attr(not(test), allow(dead_code))]
pub fn decode_header(bytes: &[u8]) -> Option<(FrameHeader, &[u8])> {
    if bytes.len() < HEADER_LEN || bytes[0] != MAGIC || bytes[1] != VERSION {
        return None;
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
    let len = u32_at(24) as usize;
    if HEADER_LEN + len > bytes.len() {
        return None;
    }
    let h = FrameHeader {
        kind: bytes[2],
        codec: bytes[3],
        stream: u32_at(4),
        timestamp_us: u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        width: u16_at(16),
        height: u16_at(18),
        flags: bytes[20],
        channels: bytes[21],
        seq: u32_at(28),
    };
    Some((h, &bytes[HEADER_LEN..HEADER_LEN + len]))
}

/// Кадр целиком: заголовок + f32-отсчёты (little-endian, как в памяти x86/ARM).
pub fn audio_frame(h: &FrameHeader, samples: &[f32]) -> Vec<u8> {
    let payload_len = samples.len() * 4;
    let mut out = vec![0u8; HEADER_LEN + payload_len];
    encode_header(h, payload_len, &mut out[..HEADER_LEN]);
    for (dst, s) in out[HEADER_LEN..].chunks_exact_mut(4).zip(samples) {
        dst.copy_from_slice(&s.to_le_bytes());
    }
    out
}

/// Размер NV12 плотной упаковки: Y w×h + UV w×h/2.
pub fn nv12_len(width: usize, height: usize) -> usize {
    width * height + width * (height / 2)
}

/// Плотная упаковка NV12 из плоскостей с шагом строки (`Lock2D`, `Map` D3D11 и т.п.).
/// `width`/`height` должны быть чётными. Дописывает в `out` ровно `nv12_len` байт.
pub fn pack_nv12(
    y_plane: &[u8],
    y_stride: usize,
    uv_plane: &[u8],
    uv_stride: usize,
    width: usize,
    height: usize,
    out: &mut Vec<u8>,
) -> bool {
    if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
        return false;
    }
    if y_stride < width || uv_stride < width {
        return false;
    }
    let uv_rows = height / 2;
    if y_plane.len() < y_stride * (height - 1) + width || uv_plane.len() < uv_stride * (uv_rows - 1) + width {
        return false;
    }
    out.reserve(nv12_len(width, height));
    for row in 0..height {
        let start = row * y_stride;
        out.extend_from_slice(&y_plane[start..start + width]);
    }
    for row in 0..uv_rows {
        let start = row * uv_stride;
        out.extend_from_slice(&uv_plane[start..start + width]);
    }
    true
}

/// Где в буфере кадра NV12 начинается плоскость UV. Media Foundation кладёт её сразу
/// за Y, но высоту Y-плоскости иногда выравнивает (1080 → 1088 для блоков 16×16 у
/// аппаратных преобразователей). Высоту с выравниванием выводим из длины буфера:
/// `длина = шаг × (h' + h'/2)`; принимаем только h' ∈ [h, h + 32], иначе считаем, что
/// выравнивания нет.
pub fn nv12_uv_offset(buffer_len: usize, pitch: usize, height: usize) -> Option<usize> {
    if pitch == 0 || height == 0 || height % 2 != 0 {
        return None;
    }
    let plain = pitch * height;
    if buffer_len < plain + pitch * (height / 2) {
        return None;
    }
    let rows = buffer_len / pitch;
    let aligned = (rows * 2 / 3) & !1;
    if aligned > height && aligned <= height + 32 && pitch * (aligned + aligned / 2) <= buffer_len {
        Some(pitch * aligned)
    } else {
        Some(plain)
    }
}

/// BGRA (как отдают WGC/DXGI) → NV12, BT.709 limited range — цветовое пространство,
/// которое Chromium по умолчанию приписывает YUV-кадру `VideoFrame` без `colorSpace`
/// (WebCodecs «Pick Color Space»: не RGB → REC709). Запасной путь, если D3D11
/// VideoProcessor недоступен; заодно эталон для проверки GPU-пути.
/// Нечётные `width`/`height` усекаются до чётных.
pub fn bgra_to_nv12(src: &[u8], stride: usize, width: usize, height: usize, out: &mut Vec<u8>) -> (usize, usize) {
    let w = width & !1;
    let h = height & !1;
    if w == 0 || h == 0 || stride < width * 4 || src.len() < stride * (height - 1) + width * 4 {
        return (0, 0);
    }
    let base = out.len();
    out.resize(base + nv12_len(w, h), 0);
    let (y_out, uv_out) = out[base..].split_at_mut(w * h);
    // Коэффициенты BT.709, studio swing: Y 16..235, Cb/Cr 16..240, фиксированная точка ×256.
    #[inline]
    fn luma(r: i32, g: i32, b: i32) -> u8 {
        (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16).clamp(0, 255) as u8
    }
    for row in 0..h {
        let line = &src[row * stride..row * stride + w * 4];
        let dst = &mut y_out[row * w..row * w + w];
        for (x, px) in line.chunks_exact(4).enumerate() {
            dst[x] = luma(px[2] as i32, px[1] as i32, px[0] as i32);
        }
    }
    for row in 0..h / 2 {
        let l0 = &src[(row * 2) * stride..];
        let l1 = &src[(row * 2 + 1) * stride..];
        let dst = &mut uv_out[row * w..row * w + w];
        for cx in 0..w / 2 {
            let mut r = 0i32;
            let mut g = 0i32;
            let mut b = 0i32;
            for line in [l0, l1] {
                for dx in 0..2 {
                    let p = &line[(cx * 2 + dx) * 4..(cx * 2 + dx) * 4 + 4];
                    b += p[0] as i32;
                    g += p[1] as i32;
                    r += p[2] as i32;
                }
            }
            r = (r + 2) >> 2;
            g = (g + 2) >> 2;
            b = (b + 2) >> 2;
            let cb = ((-26 * r - 87 * g + 112 * b + 128) >> 8) + 128;
            let cr = ((112 * r - 102 * g - 10 * b + 128) >> 8) + 128;
            dst[cx * 2] = cb.clamp(0, 255) as u8;
            dst[cx * 2 + 1] = cr.clamp(0, 255) as u8;
        }
    }
    (w, h)
}

/// Размер кадра экрана: вписать в `max_height` (0 = оригинал) с сохранением пропорций,
/// обе стороны чётные и не меньше 2, ширина ≤ 65534 (поле u16).
pub fn fit_even(src_w: u32, src_h: u32, max_height: u32) -> (u32, u32) {
    if src_w == 0 || src_h == 0 {
        return (0, 0);
    }
    let (mut w, mut h) = (src_w as u64, src_h as u64);
    if max_height > 0 && h > max_height as u64 {
        w = (w * max_height as u64 + h / 2) / h;
        h = max_height as u64;
    }
    let clamp_even = |v: u64| ((v.min(65534) as u32) & !1).max(2);
    (clamp_even(w), clamp_even(h))
}

/// Режим камеры, который отдаёт устройство.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraMode {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// Подтип без перекодирования в NV12 дешевле: NV12 > YUY2 > прочее (MJPG и т.д.).
    pub subtype_rank: u8,
}

/// Выбор режима камеры под запрос (`width`, `height`, `fps`; 0 = «не важно»).
/// Предпочтение: не меньше запрошенного разрешения и ближе всего к нему, затем
/// частота кадров не ниже запрошенной, затем подтип без декодирования.
pub fn choose_camera_mode(modes: &[CameraMode], want_w: u32, want_h: u32, want_fps: f64) -> Option<usize> {
    let want_w = if want_w == 0 { 1280 } else { want_w };
    let want_h = if want_h == 0 { 720 } else { want_h };
    let want_fps = if want_fps <= 0.0 { 30.0 } else { want_fps };
    let want_area = (want_w as f64) * (want_h as f64);
    let score = |m: &CameraMode| -> (u8, u64, u8, u64, u8) {
        let area = (m.width as f64) * (m.height as f64);
        let big_enough = m.width >= want_w && m.height >= want_h;
        // Меньше — лучше по каждому полю, сравниваем кортежем.
        let res_miss = if big_enough { 0 } else { 1 };
        let res_dist = ((area - want_area).abs()) as u64;
        let fps_ok = if m.fps + 0.5 >= want_fps { 0 } else { 1 };
        let fps_dist = ((m.fps - want_fps).abs() * 100.0) as u64;
        (res_miss, res_dist, fps_ok, fps_dist, m.subtype_rank)
    };
    modes
        .iter()
        .enumerate()
        .filter(|(_, m)| m.width >= 2 && m.height >= 2 && m.fps > 0.0)
        .min_by_key(|(_, m)| score(m))
        .map(|(i, _)| i)
}

/// Код ошибки протокола по HRESULT (`permission`/`not_found`/`busy`/`unsupported`/`failed`).
pub fn error_code_for_hresult(hr: i32) -> &'static str {
    match hr as u32 {
        // E_ACCESSDENIED: «Конфиденциальность → Микрофон/Камера» запрещает приложениям.
        0x8007_0005 => "permission",
        // ERROR_NOT_FOUND, ERROR_FILE_NOT_FOUND, E_NOTFOUND-подобные, AUDCLNT_E_DEVICE_INVALIDATED,
        // MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED.
        0x8007_0490 | 0x8007_0002 | 0x8889_0004 | 0xC00D_3EA2 => "not_found",
        // AUDCLNT_E_DEVICE_IN_USE, MF_E_HW_MFT_FAILED_START_STREAMING,
        // MF_E_VIDEO_RECORDING_DEVICE_PREEMPTED, ERROR_SHARING_VIOLATION.
        0x8889_000A | 0xC00D_3704 | 0xC00D_3EA3 | 0x8007_0020 => "busy",
        // E_NOTIMPL, E_NOINTERFACE, AUDCLNT_E_UNSUPPORTED_FORMAT, MF_E_INVALIDMEDIATYPE,
        // MF_E_UNSUPPORTED_D3D_TYPE, REGDB_E_CLASSNOTREG.
        0x8000_4001 | 0x8000_4002 | 0x8889_0008 | 0xC00D_36B4 | 0xC00D_6D76 | 0x8004_0154 => "unsupported",
        _ => "failed",
    }
}

/// Набор обработок микрофона из `options` запроса.
/// `start` присылает `{processing: bool}` или `{processing: {aec, ns, agc}}`;
/// `set_processing` — `{aec, ns, agc}` прямо в `options`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Processing {
    pub aec: bool,
    pub ns: bool,
    pub agc: bool,
}

impl Processing {
    pub const ALL: Self = Self { aec: true, ns: true, agc: true };

    pub fn from_flags(value: &serde_json::Value, fallback: Self) -> Self {
        let get = |key: &str, cur: bool| value.get(key).and_then(serde_json::Value::as_bool).unwrap_or(cur);
        Self {
            aec: get("aec", fallback.aec),
            ns: get("ns", fallback.ns),
            agc: get("agc", fallback.agc),
        }
    }

    pub fn from_start_options(options: &serde_json::Value, fallback: Self) -> Self {
        match options.get("processing") {
            Some(serde_json::Value::Bool(on)) => Self { aec: *on, ns: *on, agc: *on },
            Some(obj @ serde_json::Value::Object(_)) => Self::from_flags(obj, fallback),
            _ => fallback,
        }
    }
}

/// Уменьшение BGRA для превью окна выбора: усреднение блока (без внешних крейтов).
/// Возвращает BGRA `dst_w × dst_h`, плотно; `dst_w ≤ max_w`, пропорции сохранены.
pub fn downscale_bgra(src: &[u8], stride: usize, width: usize, height: usize, max_w: usize) -> (Vec<u8>, usize, usize) {
    if width == 0 || height == 0 || stride < width * 4 || src.len() < stride * (height - 1) + width * 4 {
        return (Vec::new(), 0, 0);
    }
    let max_w = max_w.clamp(16, 1920);
    let (dw, dh) = if width <= max_w {
        (width, height)
    } else {
        (max_w, ((height * max_w + width / 2) / width).max(1))
    };
    let mut out = vec![0u8; dw * dh * 4];
    for y in 0..dh {
        let sy0 = y * height / dh;
        let sy1 = ((y + 1) * height / dh).max(sy0 + 1).min(height);
        for x in 0..dw {
            let sx0 = x * width / dw;
            let sx1 = ((x + 1) * width / dw).max(sx0 + 1).min(width);
            let mut acc = [0u32; 4];
            let mut n = 0u32;
            // Не больше 4×4 выборок на пиксель: на 4K-мониторе это и так ~1 мс.
            let step_y = ((sy1 - sy0) / 4).max(1);
            let step_x = ((sx1 - sx0) / 4).max(1);
            let mut sy = sy0;
            while sy < sy1 {
                let mut sx = sx0;
                while sx < sx1 {
                    let p = &src[sy * stride + sx * 4..sy * stride + sx * 4 + 4];
                    for c in 0..4 {
                        acc[c] += p[c] as u32;
                    }
                    n += 1;
                    sx += step_x;
                }
                sy += step_y;
            }
            let d = &mut out[(y * dw + x) * 4..(y * dw + x) * 4 + 4];
            for c in 0..4 {
                d[c] = (acc[c] / n.max(1)) as u8;
            }
            d[3] = 255;
        }
    }
    (out, dw, dh)
}

/// Кадры отдаём только нашему документу (`zali://localhost` в WebView2 — это
/// `http(s)://zali.localhost/`), а не странице, которая вдруг оказалась в вебвью.
pub fn is_app_document(url: &str) -> bool {
    let lowered = url.trim().to_ascii_lowercase();
    lowered.starts_with("http://zali.localhost/") || lowered.starts_with("https://zali.localhost/")
}

/// Источник демонстрации: `display:<HMONITOR>` / `window:<HWND>` (числа — сырые
/// дескрипторы, стабильны, пока источник жив).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Display(isize),
    Window(isize),
}

impl Source {
    pub fn parse(id: &str) -> Option<Self> {
        let (kind, raw) = id.split_once(':')?;
        let value: isize = raw.parse().ok()?;
        if value == 0 {
            return None;
        }
        match kind {
            "display" => Some(Self::Display(value)),
            "window" => Some(Self::Window(value)),
            _ => None,
        }
    }

    pub fn id(&self) -> String {
        match self {
            Self::Display(h) => format!("display:{h}"),
            Self::Window(h) => format!("window:{h}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_bundled_document_receives_frames() {
        assert!(is_app_document("http://zali.localhost/index.html"));
        assert!(is_app_document("https://zali.localhost/index.html#chat"));
        assert!(!is_app_document("http://zali.localhost.evil.com/"));
        assert!(!is_app_document("https://example.com/?u=http://zali.localhost/"));
        assert!(!is_app_document(""));
    }

    #[test]
    fn source_ids_roundtrip() {
        for s in [Source::Display(65537), Source::Window(0x1234), Source::Window(-5)] {
            assert_eq!(Source::parse(&s.id()), Some(s));
        }
        assert_eq!(Source::parse("display:0"), None);
        assert_eq!(Source::parse("tab:1"), None);
        assert_eq!(Source::parse("window:abc"), None);
        assert_eq!(Source::parse(""), None);
    }

    #[test]
    fn header_layout_matches_the_spec() {
        let h = FrameHeader {
            kind: KIND_VIDEO,
            codec: CODEC_NV12,
            stream: 0x0102_0304,
            timestamp_us: 0x1122_3344_5566_7788,
            width: 1920,
            height: 1080,
            flags: FLAG_KEYFRAME,
            channels: 0,
            seq: 7,
        };
        let mut buf = [0u8; 32];
        encode_header(&h, 100, &mut buf);
        assert_eq!(buf[0], 0x5A);
        assert_eq!(buf[1], 1);
        assert_eq!(buf[2], 2);
        assert_eq!(buf[3], 2);
        assert_eq!(&buf[4..8], &[0x04, 0x03, 0x02, 0x01]);
        assert_eq!(&buf[8..16], &0x1122_3344_5566_7788u64.to_le_bytes());
        assert_eq!(&buf[16..18], &1920u16.to_le_bytes());
        assert_eq!(&buf[18..20], &1080u16.to_le_bytes());
        assert_eq!(buf[20], 1);
        assert_eq!(buf[21], 0);
        assert_eq!(&buf[22..24], &[0, 0]);
        assert_eq!(&buf[24..28], &100u32.to_le_bytes());
        assert_eq!(&buf[28..32], &7u32.to_le_bytes());
    }

    #[test]
    fn audio_frame_roundtrips() {
        let samples = [0.0f32, 0.5, -1.0, 0.25];
        let bytes = audio_frame(&FrameHeader::audio(3, 1234, 2, 9), &samples);
        assert_eq!(bytes.len(), 32 + 16);
        let (h, payload) = decode_header(&bytes).unwrap();
        assert_eq!(h.kind, KIND_AUDIO);
        assert_eq!(h.codec, CODEC_PCM_F32);
        assert_eq!(h.stream, 3);
        assert_eq!(h.timestamp_us, 1234);
        assert_eq!(h.channels, 2);
        assert_eq!(h.seq, 9);
        let back: Vec<f32> = payload.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        assert_eq!(back, samples);
    }

    #[test]
    fn decode_rejects_truncated_or_foreign_frames() {
        let bytes = audio_frame(&FrameHeader::audio(1, 0, 1, 0), &[1.0, 2.0]);
        assert!(decode_header(&bytes[..bytes.len() - 1]).is_none());
        let mut bad = bytes.clone();
        bad[0] = 0;
        assert!(decode_header(&bad).is_none());
        let mut bad = bytes;
        bad[1] = 2;
        assert!(decode_header(&bad).is_none());
    }

    #[test]
    fn nv12_packing_drops_row_padding() {
        // 4×2 кадр, шаг строки 8: Y-строки [1,2,3,4,x,x,x,x], [5,6,7,8,…]; UV одна строка.
        let y = [1, 2, 3, 4, 99, 99, 99, 99, 5, 6, 7, 8, 99, 99, 99, 99];
        let uv = [10, 11, 12, 13, 99, 99, 99, 99];
        let mut out = Vec::new();
        assert!(pack_nv12(&y, 8, &uv, 8, 4, 2, &mut out));
        assert_eq!(out, vec![1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13]);
        assert_eq!(out.len(), nv12_len(4, 2));
    }

    #[test]
    fn nv12_packing_rejects_odd_or_short_input() {
        let mut out = Vec::new();
        assert!(!pack_nv12(&[0; 64], 8, &[0; 32], 8, 3, 2, &mut out));
        assert!(!pack_nv12(&[0; 64], 8, &[0; 32], 8, 4, 3, &mut out));
        assert!(!pack_nv12(&[0; 4], 8, &[0; 32], 8, 4, 2, &mut out));
        assert!(!pack_nv12(&[0; 64], 2, &[0; 32], 8, 4, 2, &mut out));
        assert!(out.is_empty());
    }

    #[test]
    fn nv12_uv_offset_detects_aligned_height() {
        // Ровно 1080 строк Y: UV сразу за ними.
        assert_eq!(nv12_uv_offset(1920 * 1620, 1920, 1080), Some(1920 * 1080));
        // Выравнивание до 1088 (16×16 блоки).
        assert_eq!(nv12_uv_offset(1920 * 1632, 1920, 1080), Some(1920 * 1088));
        // Хвост мусора, не похожий на выравнивание, — UV всё равно сразу за Y.
        assert_eq!(nv12_uv_offset(1920 * 4000, 1920, 1080), Some(1920 * 1080));
        // Буфер короче кадра — разбирать нечего.
        assert_eq!(nv12_uv_offset(1920 * 1000, 1920, 1080), None);
        assert_eq!(nv12_uv_offset(100, 0, 2), None);
    }

    fn solid_bgra(w: usize, h: usize, b: u8, g: u8, r: u8) -> Vec<u8> {
        (0..w * h).flat_map(|_| [b, g, r, 255]).collect()
    }

    #[test]
    fn bgra_to_nv12_uses_bt709_limited_range() {
        let mut out = Vec::new();
        // Белый → Y 235, чёрный → Y 16, нейтральный цвет → Cb = Cr = 128.
        assert_eq!(bgra_to_nv12(&solid_bgra(4, 2, 255, 255, 255), 16, 4, 2, &mut out), (4, 2));
        assert!(out[..8].iter().all(|&y| (234..=236).contains(&y)), "{:?}", &out[..8]);
        assert!(out[8..].iter().all(|&c| (127..=129).contains(&c)));
        out.clear();
        bgra_to_nv12(&solid_bgra(4, 2, 0, 0, 0), 16, 4, 2, &mut out);
        assert!(out[..8].iter().all(|&y| y == 16));
        out.clear();
        // Чистый красный BT.709: Y ≈ 63, Cb ≈ 102, Cr = 240.
        bgra_to_nv12(&solid_bgra(2, 2, 0, 0, 255), 8, 2, 2, &mut out);
        assert!((62..=64).contains(&out[0]), "Y={}", out[0]);
        assert!((101..=103).contains(&out[4]), "Cb={}", out[4]);
        assert!((239..=241).contains(&out[5]), "Cr={}", out[5]);
    }

    #[test]
    fn bgra_to_nv12_truncates_odd_sizes_and_honours_stride() {
        let mut src = solid_bgra(5, 3, 0, 0, 0);
        // Шаг строки с запасом: 5 пикселей × 4 + 4 байта мусора.
        let stride = 24;
        let mut padded = vec![0xFFu8; stride * 3];
        for row in 0..3 {
            padded[row * stride..row * stride + 20].copy_from_slice(&src[row * 20..row * 20 + 20]);
        }
        src.clear();
        let mut out = Vec::new();
        assert_eq!(bgra_to_nv12(&padded, stride, 5, 3, &mut out), (4, 2));
        assert_eq!(out.len(), nv12_len(4, 2));
        assert!(out[..8].iter().all(|&y| y == 16), "мусор из запаса строки попал в кадр");
    }

    #[test]
    fn fit_even_keeps_aspect_and_evenness() {
        assert_eq!(fit_even(1920, 1080, 0), (1920, 1080));
        assert_eq!(fit_even(1920, 1080, 720), (1280, 720));
        assert_eq!(fit_even(2560, 1440, 1080), (1920, 1080));
        assert_eq!(fit_even(1366, 768, 720), (1280, 720));
        assert_eq!(fit_even(1001, 777, 0), (1000, 776));
        assert_eq!(fit_even(800, 600, 1080), (800, 600));
        assert_eq!(fit_even(1, 1, 0), (2, 2));
        assert_eq!(fit_even(0, 100, 0), (0, 0));
    }

    fn mode(width: u32, height: u32, fps: f64, subtype_rank: u8) -> CameraMode {
        CameraMode { width, height, fps, subtype_rank }
    }

    #[test]
    fn camera_mode_prefers_requested_size_then_fps_then_cheap_subtype() {
        let modes = [
            mode(640, 480, 30.0, 1),
            mode(1280, 720, 30.0, 2),  // MJPG
            mode(1280, 720, 30.0, 0),  // NV12
            mode(1280, 720, 15.0, 0),
            mode(1920, 1080, 30.0, 0),
        ];
        assert_eq!(choose_camera_mode(&modes, 1280, 720, 30.0), Some(2));
        // 0 = «по умолчанию» = 1280×720@30.
        assert_eq!(choose_camera_mode(&modes, 0, 0, 0.0), Some(2));
        assert_eq!(choose_camera_mode(&modes, 1920, 1080, 30.0), Some(4));
        assert_eq!(choose_camera_mode(&modes, 640, 480, 30.0), Some(0));
    }

    #[test]
    fn camera_mode_falls_back_to_the_largest_close_mode() {
        let modes = [mode(640, 480, 30.0, 1), mode(320, 240, 30.0, 1)];
        // Камера не умеет 720p — берём ближайшее, а не крошечное.
        assert_eq!(choose_camera_mode(&modes, 1280, 720, 30.0), Some(0));
        assert_eq!(choose_camera_mode(&[], 1280, 720, 30.0), None);
        assert_eq!(choose_camera_mode(&[mode(0, 0, 30.0, 0)], 1280, 720, 30.0), None);
    }

    #[test]
    fn camera_mode_prefers_full_fps_over_exact_size_miss() {
        let modes = [mode(1280, 720, 10.0, 0), mode(1280, 720, 30.0, 1)];
        assert_eq!(choose_camera_mode(&modes, 1280, 720, 30.0), Some(1));
    }

    #[test]
    fn hresults_map_to_protocol_codes() {
        assert_eq!(error_code_for_hresult(0x8007_0005u32 as i32), "permission");
        assert_eq!(error_code_for_hresult(0x8889_000Au32 as i32), "busy");
        assert_eq!(error_code_for_hresult(0x8007_0490u32 as i32), "not_found");
        assert_eq!(error_code_for_hresult(0x8889_0004u32 as i32), "not_found");
        assert_eq!(error_code_for_hresult(0x8000_4001u32 as i32), "unsupported");
        assert_eq!(error_code_for_hresult(0x8000_4005u32 as i32), "failed");
    }

    #[test]
    fn processing_options_accept_bool_and_object() {
        let all = Processing::ALL;
        let off = Processing { aec: false, ns: false, agc: false };
        assert_eq!(Processing::from_start_options(&serde_json::json!({"processing": false}), all), off);
        assert_eq!(Processing::from_start_options(&serde_json::json!({"processing": true}), off), all);
        assert_eq!(
            Processing::from_start_options(&serde_json::json!({"processing": {"aec": false}}), all),
            Processing { aec: false, ns: true, agc: true }
        );
        assert_eq!(Processing::from_start_options(&serde_json::json!({}), all), all);
        assert_eq!(
            Processing::from_flags(&serde_json::json!({"aec": true, "ns": false, "agc": true}), off),
            Processing { aec: true, ns: false, agc: true }
        );
    }

    #[test]
    fn downscale_keeps_aspect_and_averages() {
        // 4×2: левая половина чёрная, правая белая → 2×1: [чёрный, белый].
        let mut src = Vec::new();
        for _ in 0..2 {
            for x in 0..4 {
                let v = if x < 2 { 0 } else { 255 };
                src.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let (out, w, h) = downscale_bgra(&src, 16, 4, 2, 16);
        assert_eq!((w, h), (4, 2), "меньше потолка — без уменьшения");
        assert_eq!(out, src);
        let big: Vec<u8> = (0..64 * 32).flat_map(|i| if i % 64 < 32 { [0, 0, 0, 255] } else { [255, 255, 255, 255] }).collect();
        let (out, w, h) = downscale_bgra(&big, 64 * 4, 64, 32, 16);
        assert_eq!((w, h), (16, 8));
        assert_eq!(out[0], 0);
        assert_eq!(out[(15) * 4], 255);
    }
}
