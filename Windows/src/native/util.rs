//! Filename/URL/data-URL sanitizers, download path helpers, and HTML meta
//! extraction for link previews.

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};



pub(crate) fn normalize_voice_ws_url(ws_base_url: Option<String>, api_base_url: Option<String>) -> String {
    if let Some(raw) = ws_base_url {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_string();
        }
    }

    if let Some(raw) = api_base_url {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if let Some(stripped) = trimmed.strip_prefix("https://") {
                return format!("wss://{}/ws", stripped.trim_end_matches('/'));
            }
            if let Some(stripped) = trimmed.strip_prefix("http://") {
                return format!("ws://{}/ws", stripped.trim_end_matches('/'));
            }
        }
    }

    "wss://msgs.zalikus.org/ws".to_string()
}

pub(crate) fn join_api_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim().trim_end_matches('/'),
        path.trim().trim_start_matches('/')
    )
}

pub(crate) fn json_string_literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

pub(crate) fn sanitize_file_name(name: &str, fallback_extension: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '?' | '%' | '*' | '|' | '"' | '<' | '>' => '_',
            _ => ch,
        })
        .collect();

    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return format!("attachment.{fallback_extension}");
    }
    let cleaned = trimmed.trim_start_matches('.').to_string();
    
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".to_string()
    } else {
        cleaned
    }
}

pub(crate) fn decode_data_url(value: &str) -> Option<(Vec<u8>, String, String)> {
    const MAX_DATA_URL_BYTES: usize = 100 * 1024 * 1024; // 100 MB
    if value.len() > MAX_DATA_URL_BYTES {
        return None;
    }
    let value = value.trim();
    if !value.starts_with("data:") {
        return None;
    }

    let comma = value.find(',')?;
    let meta = &value[5..comma];
    let payload = &value[comma + 1..];
    let mime_type = meta
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim();
    let file_extension = match mime_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    };

    if meta
        .split(';')
        .any(|part| part.trim().eq_ignore_ascii_case("base64"))
    {
        let bytes = BASE64_STANDARD.decode(payload).ok()?;
        return Some((bytes, mime_type.to_string(), file_extension.to_string()));
    }

    Some((
        payload.as_bytes().to_vec(),
        mime_type.to_string(),
        file_extension.to_string(),
    ))
}

pub(crate) fn sanitize_download_name(name: &str, fallback_extension: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '?' | '%' | '*' | '|' | '"' | '<' | '>' => '_',
            _ => ch,
        })
        .collect();

    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return format!("attachment.{fallback_extension}");
    }
    let cleaned = trimmed.trim_start_matches('.').to_string();
    
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".to_string()
    } else {
        cleaned
    }
}

pub(crate) fn user_downloads_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|base| base.join("Downloads"))
        .unwrap_or_else(std::env::temp_dir)
}

pub(crate) fn unique_download_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let ext = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for index in 2..10_000 {
        let next_name = if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        };
        let next = dir.join(next_name);
        if !next.exists() {
            return next;
        }
    }

    dir.join(filename)
}

pub(crate) fn save_data_url_attachment(data_url: &str, filename: &str) -> Result<PathBuf, String> {
    let (data, _mime_type, fallback_extension) =
        decode_data_url(data_url).ok_or_else(|| "Invalid attachment data URL".to_string())?;
    if data.is_empty() {
        return Err("Attachment payload is empty".to_string());
    }

    let download_dir = user_downloads_dir();
    fs::create_dir_all(&download_dir).map_err(|e| e.to_string())?;
    let safe_name = sanitize_download_name(filename, &fallback_extension);
    let destination = unique_download_path(&download_dir, &safe_name);
    if !destination.starts_with(&download_dir) {
        return Err("Path traversal detected".to_string());
    }
    fs::write(&destination, data).map_err(|e| e.to_string())?;
    Ok(destination)
}

pub(crate) fn html_search_lower(haystack: &str, needle: &str, start: usize) -> Option<usize> {
    let lower_haystack = haystack.get(start..)?.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    lower_haystack
        .find(&lower_needle)
        .map(|offset| start + offset)
}

pub(crate) fn extract_meta_content(html: &str, marker: &str) -> Option<String> {
    let marker_index = html_search_lower(html, marker, 0)?;
    let search_start = marker_index + marker.len();
    let content_index = html_search_lower(html, "content=", search_start)?;
    let after_content = html.get(content_index + "content=".len()..)?;
    let mut chars = after_content.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }

    let rest = &after_content[quote.len_utf8()..];
    let end = rest.find(quote)?;
    let value = rest[..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub(crate) fn infer_mime_and_kind(url: &str) -> (String, String) {
    let lower = url.to_ascii_lowercase();
    if lower.ends_with(".mp4") {
        return ("video/mp4".to_string(), "video".to_string());
    }
    if lower.ends_with(".webm") {
        return ("video/webm".to_string(), "video".to_string());
    }
    if lower.ends_with(".gif") {
        return ("image/gif".to_string(), "gif".to_string());
    }
    if lower.ends_with(".webp") {
        return ("image/webp".to_string(), "image".to_string());
    }
    if lower.ends_with(".png") {
        return ("image/png".to_string(), "image".to_string());
    }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        return ("image/jpeg".to_string(), "image".to_string());
    }
    ("application/octet-stream".to_string(), "file".to_string())
}
