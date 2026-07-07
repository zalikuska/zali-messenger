//! File-backed binary assets: user avatars and server avatars/banners,
//! including their HTTP handlers and on-disk read/write helpers.

use axum::{
    extract::{
        Multipart, Path as AxumPath,
    },
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::{DateTime, Utc};
use sqlx::{
    sqlite::SqlitePool, Row,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::fs;
use tracing::error;
use crate::{
    AppState, AuthenticatedUser, AvatarRecord, broadcast_avatar_event, can_manage_server,
    get_server_access_context, hex_encode, normalize_data_url, ServerAssetPayload,
    sniff_image_mime, StoredAssetMeta,
};

pub(crate) const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn asset_root_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("assets")
}

pub(crate) fn user_avatar_asset_dir(data_dir: &Path, username: &str) -> PathBuf {
    asset_root_dir(data_dir)
        .join("avatars")
        .join(hex_encode(username.trim().as_bytes()))
}

pub(crate) fn server_asset_dir(data_dir: &Path, server_id: &str) -> PathBuf {
    asset_root_dir(data_dir)
        .join("servers")
        .join(hex_encode(server_id.trim().as_bytes()))
}

pub(crate) fn asset_file_paths(base_dir: PathBuf, kind: &str) -> (PathBuf, PathBuf) {
    (
        base_dir.join(format!("{}.bin", kind)),
        base_dir.join(format!("{}.json", kind)),
    )
}

pub(crate) async fn read_asset_file(
    base_dir: PathBuf,
    kind: &str,
) -> Result<Option<(String, Vec<u8>, Option<DateTime<Utc>>)>, std::io::Error> {
    let (bin_path, meta_path) = asset_file_paths(base_dir, kind);
    if !fs::try_exists(&bin_path).await.unwrap_or(false) {
        return Ok(None);
    }

    let data = fs::read(&bin_path).await?;
    if data.is_empty() {
        return Ok(None);
    }

    let mime = match fs::read_to_string(&meta_path).await {
        Ok(raw) => serde_json::from_str::<StoredAssetMeta>(&raw)
            .map(|meta| meta.mime_type)
            .unwrap_or_else(|_| "application/octet-stream".to_string()),
        Err(_) => "application/octet-stream".to_string(),
    };
    let updated_at = match fs::read_to_string(&meta_path).await {
        Ok(raw) => serde_json::from_str::<StoredAssetMeta>(&raw)
            .ok()
            .and_then(|meta| meta.updated_at),
        Err(_) => None,
    };

    Ok(Some((mime, data, updated_at)))
}

pub(crate) async fn write_asset_file(
    base_dir: PathBuf,
    kind: &str,
    mime_type: &str,
    data: &[u8],
    updated_at: Option<DateTime<Utc>>,
) -> Result<(), std::io::Error> {
    let (bin_path, meta_path) = asset_file_paths(base_dir, kind);
    if let Some(parent) = bin_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(&bin_path, data).await?;
    let meta = StoredAssetMeta {
        mime_type: mime_type.to_string(),
        updated_at,
    };
    let meta_json = serde_json::to_string_pretty(&meta).unwrap_or_else(|_| {
        serde_json::json!({ "mime_type": mime_type, "updated_at": updated_at.map(|dt| dt.to_rfc3339()) }).to_string()
    });
    fs::write(&meta_path, meta_json).await?;
    Ok(())
}

pub(crate) async fn clear_asset_file(base_dir: PathBuf, kind: &str) -> Result<(), std::io::Error> {
    let (bin_path, meta_path) = asset_file_paths(base_dir, kind);
    let _ = fs::remove_file(&bin_path).await;
    let _ = fs::remove_file(&meta_path).await;
    if let Some(parent) = bin_path.parent() {
        if let Ok(mut rd) = fs::read_dir(parent).await {
            if rd.next_entry().await?.is_none() {
                let _ = fs::remove_dir(parent).await;
            }
        }
    }
    Ok(())
}

pub(crate) async fn get_server_asset(
    pool: &SqlitePool,
    data_dir: &Path,
    server_id: &str,
    kind: &str,
) -> Result<Option<(String, Vec<u8>)>, sqlx::Error> {
    if kind != "avatar" && kind != "banner" {
        return Ok(None);
    }

    let dir = server_asset_dir(data_dir, server_id);
    if let Ok(Some((mime, data, _))) = read_asset_file(dir.clone(), kind).await {
        if !mime.is_empty() && !data.is_empty() {
            return Ok(Some((mime, data)));
        }
    }

    let row = match kind {
        "avatar" => {
            sqlx::query("SELECT avatar_mime, avatar_data FROM servers WHERE id = ? LIMIT 1")
                .bind(server_id)
                .fetch_optional(pool)
                .await?
        }
        "banner" => {
            sqlx::query("SELECT banner_mime, banner_data FROM servers WHERE id = ? LIMIT 1")
                .bind(server_id)
                .fetch_optional(pool)
                .await?
        }
        _ => return Ok(None),
    };
    let asset = row.and_then(|r| {
        let mime: Option<String> = r.try_get(0).ok();
        let data: Option<Vec<u8>> = r.try_get(1).ok();
        match (mime, data) {
            (Some(m), Some(d)) if !d.is_empty() => Some((m, d)),
            _ => None,
        }
    });

    if let Some((mime, data)) = asset.as_ref() {
        let _ = write_asset_file(dir, kind, mime, data, None).await;
    }

    Ok(asset)
}

pub(crate) async fn set_server_asset(
    pool: &SqlitePool,
    data_dir: &Path,
    server_id: &str,
    kind: &str,
    data_url: &str,
) -> Result<(), sqlx::Error> {
    let (mime, data) = normalize_data_url(data_url).map_err(|_| sqlx::Error::RowNotFound)?;
    let dir = server_asset_dir(data_dir, server_id);
    write_asset_file(dir, kind, &mime, &data, None)
        .await
        .map_err(sqlx::Error::Io)?;
    match kind {
        "avatar" => {
            sqlx::query("UPDATE servers SET avatar_mime = ?, avatar_data = ? WHERE id = ?")
                .bind(mime)
                .bind(data)
                .bind(server_id)
                .execute(pool)
                .await?;
        }
        "banner" => {
            sqlx::query("UPDATE servers SET banner_mime = ?, banner_data = ? WHERE id = ?")
                .bind(mime)
                .bind(data)
                .bind(server_id)
                .execute(pool)
                .await?;
        }
        _ => return Err(sqlx::Error::RowNotFound),
    }
    Ok(())
}

pub(crate) async fn clear_server_asset(
    pool: &SqlitePool,
    data_dir: &Path,
    server_id: &str,
    kind: &str,
) -> Result<(), sqlx::Error> {
    let dir = server_asset_dir(data_dir, server_id);
    let _ = clear_asset_file(dir, kind).await;
    match kind {
        "avatar" => {
            sqlx::query("UPDATE servers SET avatar_mime = NULL, avatar_data = NULL WHERE id = ?")
                .bind(server_id)
                .execute(pool)
                .await?;
        }
        "banner" => {
            sqlx::query("UPDATE servers SET banner_mime = NULL, banner_data = NULL WHERE id = ?")
                .bind(server_id)
                .execute(pool)
                .await?;
        }
        _ => return Err(sqlx::Error::RowNotFound),
    }
    Ok(())
}

pub(crate) async fn get_server_avatar(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    match get_server_access_context(&state.db, &server_id, &auth_user).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(e) => {
            error!(
                "Ошибка проверки доступа к аватару сервера {}: {}",
                server_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    match get_server_asset(&state.db, &state.data_dir, &server_id, "avatar").await {
        Ok(Some((mime, data))) => (
            [
                (axum::http::header::CONTENT_TYPE, mime.as_str()),
                (
                    axum::http::header::CACHE_CONTROL,
                    "no-store, no-cache, must-revalidate",
                ),
                (axum::http::header::PRAGMA, "no-cache"),
            ],
            data,
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка загрузки аватара сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn set_server_avatar(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerAssetPayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if payload.data_url.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "data_url обязателен").into_response();
    }
    if let Err(e) = set_server_asset(
        &state.db,
        &state.data_dir,
        &server_id,
        "avatar",
        &payload.data_url,
    )
    .await
    {
        error!("Ошибка сохранения аватара сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(crate) async fn delete_server_avatar(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Err(e) = clear_server_asset(&state.db, &state.data_dir, &server_id, "avatar").await {
        error!("Ошибка удаления аватара сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(crate) async fn get_server_banner(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    match get_server_access_context(&state.db, &server_id, &auth_user).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(e) => {
            error!(
                "Ошибка проверки доступа к баннеру сервера {}: {}",
                server_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    match get_server_asset(&state.db, &state.data_dir, &server_id, "banner").await {
        Ok(Some((mime, data))) => (
            [
                (axum::http::header::CONTENT_TYPE, mime.as_str()),
                (
                    axum::http::header::CACHE_CONTROL,
                    "no-store, no-cache, must-revalidate",
                ),
                (axum::http::header::PRAGMA, "no-cache"),
            ],
            data,
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка загрузки баннера сервера {}: {}", server_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn set_server_banner(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
    Json(payload): Json<ServerAssetPayload>,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if payload.data_url.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "data_url обязателен").into_response();
    }
    if let Err(e) = set_server_asset(
        &state.db,
        &state.data_dir,
        &server_id,
        "banner",
        &payload.data_url,
    )
    .await
    {
        error!("Ошибка сохранения баннера сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(crate) async fn delete_server_banner(
    AxumPath(server_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(auth_user): AuthenticatedUser,
) -> impl IntoResponse {
    if !can_manage_server(&state.db, &server_id, &auth_user)
        .await
        .unwrap_or(false)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Err(e) = clear_server_asset(&state.db, &state.data_dir, &server_id, "banner").await {
        error!("Ошибка удаления баннера сервера {}: {}", server_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(crate) async fn get_avatar(
    AxumPath(username): AxumPath<String>,
    AuthenticatedUser(_auth_user): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    let file_dir = user_avatar_asset_dir(&state.data_dir, &username);
    if let Ok(Some((mime, data, _))) = read_asset_file(file_dir.clone(), "avatar").await {
        return (
            [
                (axum::http::header::CONTENT_TYPE, mime.as_str()),
                (
                    axum::http::header::CACHE_CONTROL,
                    "no-store, no-cache, must-revalidate",
                ),
                (axum::http::header::PRAGMA, "no-cache"),
            ],
            data,
        )
            .into_response();
    }

    match sqlx::query_as::<_, AvatarRecord>(
        "SELECT username, mime_type, data, updated_at FROM avatars WHERE username = ?",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(avatar)) => {
            let _ = write_asset_file(
                file_dir,
                "avatar",
                &avatar.mime_type,
                &avatar.data,
                Some(avatar.updated_at),
            )
            .await;
            (
                [
                    (axum::http::header::CONTENT_TYPE, avatar.mime_type.as_str()),
                    (
                        axum::http::header::CACHE_CONTROL,
                        "no-store, no-cache, must-revalidate",
                    ),
                    (axum::http::header::PRAGMA, "no-cache"),
                ],
                avatar.data,
            )
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка получения аватара {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn upload_avatar(
    AuthenticatedUser(username): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut file_data: Vec<u8> = Vec::new();
    let mut mime_type = String::new();

    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_string();
                if name.as_str() == "file" {
                    mime_type = field
                        .content_type()
                        .map(|m| m.to_string())
                        .unwrap_or_else(|| "image/png".to_string());
                    let mut field = field;
                    loop {
                        match field.chunk().await {
                            Ok(Some(chunk)) => {
                                if file_data.len().saturating_add(chunk.len()) > MAX_AVATAR_BYTES {
                                    return (
                                        StatusCode::PAYLOAD_TOO_LARGE,
                                        "Аватар не должен превышать 2 МБ",
                                    )
                                        .into_response();
                                }
                                file_data.extend_from_slice(&chunk);
                            }
                            Ok(None) => break,
                            Err(e) => {
                                error!("Ошибка чтения файла аватара: {}", e);
                                return StatusCode::BAD_REQUEST.into_response();
                            }
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                error!("Ошибка парсинга avatar multipart: {}", e);
                return StatusCode::BAD_REQUEST.into_response();
            }
        }
    }

    if file_data.is_empty() {
        return (StatusCode::BAD_REQUEST, "Файл аватара обязателен").into_response();
    }
    let sniffed_mime = match sniff_image_mime(&file_data) {
        Some(mime) => mime,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                "Поддерживаются только PNG, JPEG, GIF и WEBP",
            )
                .into_response();
        }
    };
    if mime_type == "image/svg+xml" || !mime_type.starts_with("image/") {
        return (StatusCode::BAD_REQUEST, "Аватар должен быть изображением").into_response();
    }
    if !mime_type.starts_with(sniffed_mime) {
        mime_type = sniffed_mime.to_string();
    }
    if file_data.len() > 2 * 1024 * 1024 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "Аватар слишком большой (макс. 2 МБ)",
        )
            .into_response();
    }

    let updated_at = Utc::now();
    let write_result = write_asset_file(
        user_avatar_asset_dir(&state.data_dir, &username),
        "avatar",
        &mime_type,
        &file_data,
        Some(updated_at),
    )
    .await;
    if let Err(e) = write_result {
        error!("Ошибка записи файла аватара {}: {}", username, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    match sqlx::query(
        "INSERT INTO avatars (username, mime_type, data, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET
            mime_type = excluded.mime_type,
            data = excluded.data,
            updated_at = excluded.updated_at",
    )
    .bind(&username)
    .bind(&mime_type)
    .bind(&file_data)
    .bind(updated_at)
    .execute(&state.db)
    .await
    {
        Ok(_) => {
            broadcast_avatar_event(&state, &username, false, Some(updated_at)).await;
            Json(serde_json::json!({
                "username": username,
                "updatedAt": updated_at.to_rfc3339(),
                "mimeType": mime_type
            }))
            .into_response()
        }
        Err(e) => {
            let _ =
                clear_asset_file(user_avatar_asset_dir(&state.data_dir, &username), "avatar").await;
            error!("Ошибка сохранения аватара {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn delete_avatar(
    AuthenticatedUser(username): AuthenticatedUser,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    let _ = clear_asset_file(user_avatar_asset_dir(&state.data_dir, &username), "avatar").await;

    match sqlx::query("DELETE FROM avatars WHERE username = ?")
        .bind(&username)
        .execute(&state.db)
        .await
    {
        Ok(_) => {
            broadcast_avatar_event(&state, &username, true, None).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            error!("Ошибка удаления аватара {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
