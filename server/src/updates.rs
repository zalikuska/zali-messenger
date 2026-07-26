//! App release metadata for the macOS/Windows native clients' in-app update
//! prompt. Web/PWA never calls these — it always runs the latest bundled JS.
//!
//! `GET /api/version` is public (no auth) so a freshly launched client can
//! check without a session. `POST /api/version` publishes a new release and
//! is gated on `RELEASE_ADMIN_TOKEN` — unset (the default) means the route
//! always 403s, same opt-in shape as the VAPID keys in `push.rs`.

use crate::AppState;
use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::Arc;
use tokio::fs;
use tokio_util::io::ReaderStream;
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
pub(crate) struct VersionQuery {
    platform: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReleaseResponse {
    platform: String,
    version: String,
    notes: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    sha256: String,
    mandatory: bool,
    #[serde(rename = "publishedAt")]
    published_at: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PublishReleaseRequest {
    platform: String,
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    sha256: String,
    #[serde(default)]
    mandatory: bool,
}

fn is_supported_platform(platform: &str) -> bool {
    matches!(platform, "macos" | "windows")
}

/// Strict allowlist for `/releases/:filename`. This route is unauthenticated, so
/// the name is never trusted: anything outside `[A-Za-z0-9._-]` is rejected
/// outright rather than sanitized. That makes `..`, any separator (`/`, `\`),
/// URL-encoded variants, NUL, and absolute paths unrepresentable instead of
/// merely filtered, so no traversal can reach outside `releases_dir`. A leading
/// dot is also refused, which keeps dotfiles and the `..` entry out.
fn is_safe_release_filename(filename: &str) -> bool {
    !filename.is_empty()
        && filename.len() <= 128
        && !filename.starts_with('.')
        && filename
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Serves a client release artifact. Unauthenticated by necessity — both the
/// in-app updater and the Inno Setup online installer download with no
/// Authorization header — and therefore backed by its own directory, never
/// `uploads_dir`, which holds user attachments guarded by per-message access
/// checks. Only what an operator puts in `releases_dir` is reachable, and the
/// directory itself is not listable: there is no index route.
pub(crate) async fn download_release_file(
    AxumPath(filename): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if !is_safe_release_filename(&filename) {
        warn!("Отклонено имя файла релиза: {:?}", filename);
        return StatusCode::BAD_REQUEST.into_response();
    }

    let path = state.releases_dir.join(&filename);
    match fs::File::open(&path).await {
        Ok(file) => {
            info!("RELEASE download file={}", filename);
            (
                [
                    (
                        axum::http::header::CONTENT_TYPE,
                        HeaderValue::from_static("application/octet-stream"),
                    ),
                    (
                        axum::http::header::CONTENT_DISPOSITION,
                        HeaderValue::from_str(&format!("attachment; filename=\"{}\"", filename))
                            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
                    ),
                ],
                Body::from_stream(ReaderStream::new(file)),
            )
                .into_response()
        }
        Err(e) => {
            warn!("Файл релиза не найден {}: {}", path.display(), e);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// Byte-wise comparison with no early exit, so a wrong RELEASE_ADMIN_TOKEN guess
/// can't be narrowed down via response-timing measurements the way `!=` allows.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub(crate) async fn get_latest_version(
    State(state): State<Arc<AppState>>,
    Query(query): Query<VersionQuery>,
) -> impl IntoResponse {
    let platform = query.platform.trim().to_lowercase();
    if !is_supported_platform(&platform) {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let row = sqlx::query(
        "SELECT platform, version, notes, download_url, sha256, mandatory, published_at
         FROM app_releases WHERE platform = ?",
    )
    .bind(&platform)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(row)) => Json(ReleaseResponse {
            platform: row.get("platform"),
            version: row.get("version"),
            notes: row.get("notes"),
            download_url: row.get("download_url"),
            sha256: row.get("sha256"),
            mandatory: row.get::<i64, _>("mandatory") != 0,
            published_at: row.get("published_at"),
        })
        .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            warn!("Ошибка чтения app_releases platform={}: {}", platform, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn publish_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PublishReleaseRequest>,
) -> impl IntoResponse {
    let expected_token = match &state.config.release_admin_token {
        Some(token) => token,
        None => return StatusCode::FORBIDDEN.into_response(),
    };
    let provided_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let authorized = provided_token
        .map(|token| constant_time_eq(token.as_bytes(), expected_token.as_bytes()))
        .unwrap_or(false);
    if !authorized {
        return StatusCode::FORBIDDEN.into_response();
    }

    let platform = body.platform.trim().to_lowercase();
    let version = body.version.trim().to_string();
    let download_url = body.download_url.trim().to_string();
    let sha256 = body.sha256.trim().to_lowercase();
    if !is_supported_platform(&platform)
        || version.is_empty()
        || download_url.is_empty()
        || sha256.len() != 64
        || !sha256.chars().all(|c| c.is_ascii_hexdigit())
    {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let published_at = chrono::Utc::now().timestamp();
    let result = sqlx::query(
        "INSERT INTO app_releases (platform, version, notes, download_url, sha256, mandatory, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform) DO UPDATE SET
            version = excluded.version,
            notes = excluded.notes,
            download_url = excluded.download_url,
            sha256 = excluded.sha256,
            mandatory = excluded.mandatory,
            published_at = excluded.published_at",
    )
    .bind(&platform)
    .bind(&version)
    .bind(body.notes.trim())
    .bind(&download_url)
    .bind(&sha256)
    .bind(body.mandatory as i64)
    .bind(published_at)
    .execute(&state.db)
    .await;

    match result {
        Ok(_) => {
            info!(
                "Опубликован релиз platform={} version={}",
                platform, version
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            warn!(
                "Ошибка публикации релиза platform={} version={}: {}",
                platform, version, e
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
