//! App release metadata for the macOS/Windows native clients' in-app update
//! prompt. Web/PWA never calls these — it always runs the latest bundled JS.
//!
//! `GET /api/version` is public (no auth) so a freshly launched client can
//! check without a session. `POST /api/version` publishes a new release and
//! is gated on `RELEASE_ADMIN_TOKEN` — unset (the default) means the route
//! always 403s, same opt-in shape as the VAPID keys in `push.rs`.
//!
//! **Три канала сборок.** Версия `MAJOR.MINOR{a|b|r}BUILD` несёт канал: `a` — alpha,
//! `b` — beta, `r` — release (числовые легаси-версии — тоже release). Сервер держит
//! **последнюю публикацию каждого канала** на платформу (`app_releases_v2`,
//! ключ `platform+channel`), поэтому выключенный у человека канал не мешает получить
//! предыдущий релиз: клиент просит `?channels=b,r`, а сервер отдаёт самую новую
//! версию среди этих каналов. Без `channels` (старые клиенты) отдаётся последний
//! release, а если релизов ещё нет — самая новая версия любого канала, как раньше.

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
    /// `a`, `b`, `r` через запятую; нет параметра — режим старых клиентов.
    #[serde(default)]
    channels: Option<String>,
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
    /// ES256 (r‖s, base64) официального ключа разработчиков над
    /// `release_signature_message`; пусто у релиза, опубликованного без подписи.
    /// Клиент без валидной подписи обновление не скачивает.
    signature: String,
    /// `a` | `b` | `r` — канал этой сборки (по версии).
    channel: String,
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
    #[serde(default)]
    signature: String,
}

/// Сообщение, которое подписывается: платформа, версия, SHA-256 и ссылка.
/// Подмена любого из полей на сервере делает подпись недействительной. Формат
/// держат вместе: сюда, `scripts/release_sign.py` и `web/src/interface/updates.js`.
pub(crate) fn release_signature_message(
    platform: &str,
    version: &str,
    sha256: &str,
    download_url: &str,
) -> String {
    format!("zali-release-sig:v1\n{platform}\n{version}\n{sha256}\n{download_url}")
}

/// Канал сборки по номеру версии: `a`/`b`/`r`; всё, что не по схеме
/// `MAJOR.MINOR{a|b|r}BUILD[.K]` (легаси `1.1.4`), — release.
pub(crate) fn channel_of(version: &str) -> char {
    parse_version(version).map(|v| v.channel).unwrap_or('r')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ParsedVersion {
    major: u64,
    minor: u64,
    channel: char,
    build: u64,
    sub: u64,
}

impl ParsedVersion {
    fn rank(&self) -> u8 {
        match self.channel {
            'a' => 0,
            'b' => 1,
            _ => 2,
        }
    }
}

/// Только версии новой схемы; легаси разбирается отдельно в `version_key`.
fn parse_version(version: &str) -> Option<ParsedVersion> {
    let v = version.trim();
    let (major, rest) = v.split_once('.')?;
    let split = rest.find(|c: char| c.is_ascii_alphabetic())?;
    let (minor, tail) = rest.split_at(split);
    let channel = tail.chars().next()?.to_ascii_lowercase();
    if !matches!(channel, 'a' | 'b' | 'r') {
        return None;
    }
    let tail = &tail[1..];
    let (build, sub) = match tail.split_once('.') {
        Some((b, k)) => (b, k),
        None => (tail, "0"),
    };
    Some(ParsedVersion {
        major: major.parse().ok()?,
        minor: minor.parse().ok()?,
        channel,
        build: build.parse().ok()?,
        sub: sub.parse().ok()?,
    })
}

/// Ключ порядка, зеркало `compareVersions` из `web/src/interface/updates.js`:
/// major, minor, канал (r > b > a), сборка, подсборка. Легаси `1.1.4` — это
/// release с `major.minor.patch`, где patch играет роль сборки.
fn version_key(version: &str) -> (u64, u64, u8, u64, u64) {
    if let Some(p) = parse_version(version) {
        return (p.major, p.minor, p.rank(), p.build, p.sub);
    }
    let mut parts = version.trim().split('.').map(|n| n.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        2,
        parts.next().unwrap_or(0),
        0,
    )
}

fn parse_channels(raw: &str) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for part in raw.split(',') {
        let c = part.trim().to_ascii_lowercase();
        if let Some(ch) = c.chars().next().filter(|ch| c.len() == 1 && matches!(ch, 'a' | 'b' | 'r')) {
            if !out.contains(&ch) {
                out.push(ch);
            }
        }
    }
    out
}

/// Создаёт `app_releases_v2` и один раз переносит в неё прежние строки
/// `app_releases` (по одной на платформу): канал берётся из версии. Старая
/// таблица остаётся нетронутой — откат бинарника не теряет данные.
pub(crate) async fn init_release_channels(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_releases_v2 (
            platform TEXT NOT NULL,
            channel TEXT NOT NULL,
            version TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            download_url TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            mandatory INTEGER NOT NULL DEFAULT 0,
            published_at INTEGER NOT NULL,
            signature TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (platform, channel)
        )",
    )
    .execute(pool)
    .await
    .expect("Ошибка создания таблицы app_releases_v2");
    let legacy = sqlx::query(
        "SELECT platform, version, notes, download_url, sha256, mandatory, published_at, signature FROM app_releases",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for row in legacy {
        let version: String = row.get("version");
        let channel = channel_of(&version).to_string();
        let result = sqlx::query(
            "INSERT OR IGNORE INTO app_releases_v2
                (platform, channel, version, notes, download_url, sha256, mandatory, published_at, signature)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(row.get::<String, _>("platform"))
        .bind(&channel)
        .bind(&version)
        .bind(row.get::<String, _>("notes"))
        .bind(row.get::<String, _>("download_url"))
        .bind(row.get::<String, _>("sha256"))
        .bind(row.get::<i64, _>("mandatory"))
        .bind(row.get::<i64, _>("published_at"))
        .bind(row.get::<String, _>("signature"))
        .execute(pool)
        .await;
        if let Err(e) = result {
            warn!("Перенос app_releases в app_releases_v2: {}", e);
        }
    }
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
            // Без Content-Length потоковое тело уходит chunked, и ни один апдейтер
            // не может посчитать процент: macOS смотрит expectedContentLength,
            // Windows — content_length(). Полоса стояла на 0% до самого конца.
            let len = file.metadata().await.ok().map(|meta| meta.len());
            let mut response = (
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
                .into_response();
            if let Some(len) = len {
                response
                    .headers_mut()
                    .insert(axum::http::header::CONTENT_LENGTH, HeaderValue::from(len));
            }
            response
        }
        Err(e) => {
            warn!("Файл релиза не найден {}: {}", path.display(), e);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

fn newest_row<'a>(candidates: Vec<&'a sqlx::sqlite::SqliteRow>) -> Option<&'a sqlx::sqlite::SqliteRow> {
    candidates
        .into_iter()
        .max_by_key(|row| version_key(&row.get::<String, _>("version")))
}

pub(crate) async fn get_latest_version(
    State(state): State<Arc<AppState>>,
    Query(query): Query<VersionQuery>,
) -> impl IntoResponse {
    let platform = query.platform.trim().to_lowercase();
    if !is_supported_platform(&platform) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let requested = query.channels.as_deref().map(parse_channels);
    // `channels=` есть, но ни одного допустимого значения — просить нечего.
    if matches!(&requested, Some(list) if list.is_empty()) {
        return StatusCode::NOT_FOUND.into_response();
    }

    let rows = sqlx::query(
        "SELECT platform, channel, version, notes, download_url, sha256, mandatory, published_at, signature
         FROM app_releases_v2 WHERE platform = ?",
    )
    .bind(&platform)
    .fetch_all(&state.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            warn!("Ошибка чтения app_releases_v2 platform={}: {}", platform, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let chosen = match &requested {
        Some(list) => newest_row(
            rows.iter()
                .filter(|row| list.iter().any(|c| row.get::<String, _>("channel") == c.to_string()))
                .collect(),
        ),
        // Старый клиент: последний release, а без релизов — самая новая из всех.
        None => newest_row(rows.iter().filter(|row| row.get::<String, _>("channel") == "r").collect())
            .or_else(|| newest_row(rows.iter().collect())),
    };

    match chosen {
        Some(row) => Json(ReleaseResponse {
            platform: row.get("platform"),
            version: row.get("version"),
            notes: row.get("notes"),
            download_url: row.get("download_url"),
            sha256: row.get("sha256"),
            mandatory: row.get::<i64, _>("mandatory") != 0,
            published_at: row.get("published_at"),
            signature: row.get("signature"),
            channel: row.get("channel"),
        })
        .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(crate) async fn publish_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PublishReleaseRequest>,
) -> impl IntoResponse {
    if !crate::operator_authorized(&state, &headers) {
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

    // Подпись, если приложена, проверяется сразу: опечатка в ссылке или не тот ключ
    // иначе всплыли бы только тем, что клиенты перестали бы обновляться.
    let signature = body.signature.trim().to_string();
    if !signature.is_empty() {
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&signature)
            .unwrap_or_default();
        let message = release_signature_message(&platform, &version, &sha256, &download_url);
        if !crate::addons::verify_es256(&crate::addons::official_public_key(), message.as_bytes(), &raw) {
            warn!("Подпись релиза не сходится platform={} version={}", platform, version);
            return (StatusCode::BAD_REQUEST, "Подпись релиза не сходится с официальным ключом").into_response();
        }
    } else {
        warn!("Релиз опубликован БЕЗ подписи platform={} version={}: клиенты не станут его скачивать", platform, version);
    }

    let published_at = chrono::Utc::now().timestamp();
    let channel = channel_of(&version).to_string();
    let result = sqlx::query(
        "INSERT INTO app_releases_v2 (platform, channel, version, notes, download_url, sha256, mandatory, published_at, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, channel) DO UPDATE SET
            version = excluded.version,
            notes = excluded.notes,
            download_url = excluded.download_url,
            sha256 = excluded.sha256,
            mandatory = excluded.mandatory,
            published_at = excluded.published_at,
            signature = excluded.signature",
    )
    .bind(&platform)
    .bind(&channel)
    .bind(&version)
    .bind(body.notes.trim())
    .bind(&download_url)
    .bind(&sha256)
    .bind(body.mandatory as i64)
    .bind(published_at)
    .bind(&signature)
    .execute(&state.db)
    .await;

    match result {
        Ok(_) => {
            info!(
                "Опубликован релиз platform={} channel={} version={}",
                platform, channel, version
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_is_read_from_version() {
        assert_eq!(channel_of("0.2a48"), 'a');
        assert_eq!(channel_of("0.2a48.1"), 'a');
        assert_eq!(channel_of("0.2b52"), 'b');
        assert_eq!(channel_of("0.3r1"), 'r');
        assert_eq!(channel_of("1.1.4"), 'r');
        assert_eq!(channel_of("мусор"), 'r');
    }

    #[test]
    fn order_mirrors_client_compare() {
        // тот же MAJOR.MINOR: release > beta > alpha
        assert!(version_key("0.2r1") > version_key("0.2b99"));
        assert!(version_key("0.2b1") > version_key("0.2a99"));
        // сборка и подсборка
        assert!(version_key("0.2b53") > version_key("0.2b52"));
        assert!(version_key("0.2a48.1") > version_key("0.2a48"));
        // minor важнее канала
        assert!(version_key("0.3a1") > version_key("0.2r9"));
        // легаси — release по major.minor.patch
        assert!(version_key("1.1.4") > version_key("1.1.3"));
    }

    #[test]
    fn channels_param_is_sanitized() {
        assert_eq!(parse_channels("b, r"), vec!['b', 'r']);
        assert_eq!(parse_channels("a,a,x,beta"), vec!['a']);
        assert!(parse_channels("").is_empty());
    }
}
