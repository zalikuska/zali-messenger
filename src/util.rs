//! Small shared validation/encoding helpers (string trimming, username
//! validation, data-URL parsing, image sniffing).

use base64::Engine;

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{:02x}", byte);
    }
    out
}

pub(crate) fn normalize_data_url(value: &str) -> Result<(String, Vec<u8>), &'static str> {
    let value = value.trim();
    if !value.starts_with("data:") {
        return Err("Неверный формат data URL");
    }
    let comma = value.find(',').ok_or("Неверный формат data URL")?;
    let meta = &value[5..comma];
    let payload = &value[comma + 1..];
    let parts: Vec<&str> = meta.split(';').collect();
    let mime = parts
        .first()
        .copied()
        .unwrap_or("application/octet-stream")
        .to_string();
    if parts.contains(&"base64") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|_| "Не удалось декодировать base64")?;
        Ok((mime, bytes))
    } else {
        Err("Поддерживается только base64 data URL")
    }
}

pub(crate) fn trim_limited(value: impl AsRef<str>, max_len: usize) -> String {
    value
        .as_ref()
        .trim()
        .chars()
        .take(max_len)
        .collect::<String>()
}

pub(crate) fn is_valid_username(value: &str) -> bool {
    let len = value.chars().count();
    (3..=32).contains(&len)
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}


pub(crate) fn sniff_image_mime(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 8 && data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if data.len() >= 3 && data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if data.len() >= 6 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) {
        return Some("image/gif");
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}
