//! Сообщения об ошибках от пользователей (кнопка «Сообщить об ошибке» слева от
//! шестерёнки настроек): текст и до пяти картинок-скриншотов.
//!
//! Это не жалоба на пользователя (`moderation.rs`) и не автоматический снимок
//! состояния клиента (`diagnostics.rs`): человек сам описывает, что сломалось.
//! Поэтому тело — строгая структура, а не непрозрачный JSON, а картинки лежат в
//! БД отдельными строками (BLOB), чтобы список отчётов не тянул за собой мегабайты.
//!
//! Картинки идут base64 внутри JSON — как файлы аддонов и облако аддонов: так они
//! одинаково проходят через HTTP-мост каждого нативного шелла, без multipart.
//! Тип картинки определяется по сигнатуре байтов, а не по тому, что заявил клиент.
//!
//! К сообщению можно приложить журнал клиента (`log`) — тот же обезличенный снимок
//! состояния, что у «Отправить диагностику» (diagnostics.rs).
//!
//! Читает оператор: GET /api/bug-reports, …/:id и …/:id/images/:idx за тем же
//! RELEASE_ADMIN_TOKEN, что и диагностика (scripts/diag_reports.py bugs|bug).

use crate::{operator_authorized, rate_allow_weighted, AppState, AuthenticatedUser};
use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::{sync::Arc, time::Duration};
use tracing::warn;
use uuid::Uuid;

/// Потолок на текст в символах. Описание бага, а не роман.
pub(crate) const MAX_TEXT_CHARS: usize = 4000;
/// Сколько картинок в одном сообщении.
pub(crate) const MAX_IMAGES: usize = 5;
/// Размер одной картинки после декодирования. Клиент ужимает скриншоты сам;
/// это предел для тех, кто шлёт мимо клиента.
pub(crate) const MAX_IMAGE_BYTES: usize = 3 * 1024 * 1024;
/// Потолок тела запроса: 5 картинок по 3 МиБ в base64 (×4/3) плюс текст.
pub(crate) const MAX_BODY_BYTES: usize = MAX_IMAGES * MAX_IMAGE_BYTES * 4 / 3 + 64 * 1024;
/// Прикреплённый журнал — тот же снимок состояния клиента, что у «Отправить
/// диагностику» (diagnostics.rs: 256 КиБ), без переписки и ключей.
pub(crate) const MAX_LOG_BYTES: usize = 256 * 1024;
/// Сообщений в час с одного аккаунта. Больше — это уже не баги, а спам.
const MAX_REPORTS_PER_HOUR: usize = 5;

#[derive(Debug, Deserialize)]
pub(crate) struct BugImage {
    /// Чистый base64 без префикса `data:`.
    #[serde(default)]
    data: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BugReport {
    #[serde(default)]
    text: String,
    #[serde(default, rename = "appVersion")]
    app_version: String,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    images: Vec<BugImage>,
    /// Журнал клиента (необязательно): непрозрачный JSON, как у диагностики.
    #[serde(default)]
    log: Option<Value>,
}

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

/// MIME по сигнатуре. Только растровые форматы, которые умеют показывать все
/// браузеры; SVG и прочее, способное нести скрипты, не принимаем.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn bad(code: &str) -> axum::response::Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": code }))).into_response()
}

pub(crate) async fn submit(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if body.len() > MAX_BODY_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let report: BugReport = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            warn!("bug report: неразбираемое тело username={}: {}", username, e);
            return bad("invalid_body");
        }
    };

    let text = report.text.trim().to_string();
    if text.chars().count() < 3 {
        return bad("text_required");
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return bad("text_too_long");
    }
    if report.images.len() > MAX_IMAGES {
        return bad("too_many_images");
    }
    // Журнал — только объект (снимок состояния); размер считаем по сериализации.
    let log: Option<String> = match &report.log {
        None | Some(Value::Null) => None,
        Some(v @ Value::Object(_)) => {
            let text = serde_json::to_string(v).unwrap_or_default();
            if text.len() > MAX_LOG_BYTES {
                return bad("log_too_large");
            }
            Some(text)
        }
        Some(_) => return bad("invalid_log"),
    };

    // Сначала разбираем все картинки, и только потом считаем квоту: отклонённое
    // сообщение не должно съедать попытку.
    let mut images: Vec<(&'static str, Vec<u8>)> = Vec::with_capacity(report.images.len());
    for image in &report.images {
        let bytes = match B64.decode(image.data.trim()) {
            Ok(b) if !b.is_empty() => b,
            _ => return bad("invalid_image"),
        };
        if bytes.len() > MAX_IMAGE_BYTES {
            return bad("image_too_large");
        }
        let Some(mime) = sniff_image(&bytes) else {
            return bad("unsupported_image");
        };
        images.push((mime, bytes));
    }

    if !rate_allow_weighted(
        &state,
        format!("bug-report:{}", username.to_lowercase()),
        1,
        MAX_REPORTS_PER_HOUR,
        Duration::from_secs(3600),
    ) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    let id = Uuid::new_v4().to_string();
    let app_version = clip(&report.app_version, 32);
    let platform = clip(&report.platform, 32);

    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            warn!("bug report: begin username={}: {}", username, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO bug_reports (id, reported_by, body, app_version, platform, log)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&username)
    .bind(&text)
    .bind(&app_version)
    .bind(&platform)
    .bind(&log)
    .execute(&mut *tx)
    .await;
    if let Err(e) = inserted {
        warn!("bug report: запись username={}: {}", username, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    for (idx, (mime, bytes)) in images.iter().enumerate() {
        let res = sqlx::query(
            "INSERT INTO bug_report_images (report_id, idx, mime, data) VALUES (?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(idx as i64)
        .bind(*mime)
        .bind(bytes)
        .execute(&mut *tx)
        .await;
        if let Err(e) = res {
            warn!("bug report: картинка username={} idx={}: {}", username, idx, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if let Err(e) = tx.commit().await {
        warn!("bug report: commit username={}: {}", username, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    warn!(
        "bug report принят username={} platform={} version={} id={} chars={} images={} log={}",
        username,
        platform,
        app_version,
        id,
        text.chars().count(),
        images.len(),
        log.as_ref().map_or(0, |l| l.len())
    );
    (StatusCode::CREATED, Json(json!({ "id": id }))).into_response()
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct ListQuery {
    user: Option<String>,
    limit: Option<i64>,
}

/// Список для оператора, новые сверху. Текст обрезан до превью — целиком по id.
pub(crate) async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let user = q.user.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let rows = sqlx::query(
        "SELECT r.id, r.reported_by, r.body, r.app_version, r.platform, r.created_at,
                (SELECT COUNT(*) FROM bug_report_images i WHERE i.report_id = r.id) AS images,
                r.log IS NOT NULL AS has_log
         FROM bug_reports r
         WHERE (? IS NULL OR r.reported_by = ?)
         ORDER BY r.created_at DESC, r.rowid DESC
         LIMIT ?",
    )
    .bind(&user)
    .bind(&user)
    .bind(limit)
    .fetch_all(&state.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            warn!("bug_reports::list: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let body: String = row.get("body");
            json!({
                "id": row.get::<String, _>("id"),
                "user": row.get::<String, _>("reported_by"),
                "preview": body.chars().take(140).collect::<String>(),
                "appVersion": row.get::<String, _>("app_version"),
                "platform": row.get::<String, _>("platform"),
                "createdAt": row.get::<String, _>("created_at"),
                "images": row.get::<i64, _>("images"),
                "hasLog": row.get::<bool, _>("has_log"),
            })
        })
        .collect();
    Json(json!({ "count": items.len(), "items": items })).into_response()
}

/// Одно сообщение целиком (картинки — отдельными запросами).
pub(crate) async fn get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let row = sqlx::query(
        "SELECT reported_by, body, app_version, platform, created_at, log
         FROM bug_reports WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            warn!("bug_reports::get: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let images = sqlx::query(
        "SELECT idx, mime, length(data) AS bytes FROM bug_report_images
         WHERE report_id = ? ORDER BY idx",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let images: Vec<Value> = images
        .iter()
        .map(|r| {
            json!({
                "idx": r.get::<i64, _>("idx"),
                "mime": r.get::<String, _>("mime"),
                "bytes": r.get::<i64, _>("bytes"),
            })
        })
        .collect();
    let log: Option<String> = row.get("log");
    let log: Value = log
        .map(|text| serde_json::from_str(&text).unwrap_or(Value::String(text)))
        .unwrap_or(Value::Null);
    Json(json!({
        "id": id,
        "user": row.get::<String, _>("reported_by"),
        "text": row.get::<String, _>("body"),
        "appVersion": row.get::<String, _>("app_version"),
        "platform": row.get::<String, _>("platform"),
        "createdAt": row.get::<String, _>("created_at"),
        "images": images,
        "log": log,
    }))
    .into_response()
}

/// Байты картинки. `nosniff` и `attachment`: даже если в БД окажется не то, что
/// ожидалось, браузер оператора ничего не исполнит.
pub(crate) async fn image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((id, idx)): AxumPath<(String, i64)>,
) -> impl IntoResponse {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let row = sqlx::query("SELECT mime, data FROM bug_report_images WHERE report_id = ? AND idx = ?")
        .bind(&id)
        .bind(idx)
        .fetch_optional(&state.db)
        .await;
    match row {
        Ok(Some(row)) => {
            let mime: String = row.get("mime");
            let data: Vec<u8> = row.get("data");
            let mut resp = data.into_response();
            if let Ok(value) = HeaderValue::from_str(&mime) {
                resp.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            resp.headers_mut()
                .insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            resp.headers_mut()
                .insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
            resp
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            warn!("bug_reports::image: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
