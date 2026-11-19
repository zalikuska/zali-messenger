//! Выбор GIF в поле ввода — ключ KLIPY для клиента.
//!
//! Сервер в поиске GIF не участвует: условия KLIPY требуют, чтобы запросы к API и
//! загрузка картинок шли прямо из приложения пользователя, без прокси и кеша
//! партнёра. Сервер только хранит ключ приложения (`KLIPY_APP_KEY` в env), чтобы
//! его не было в публичном репозитории и в бандле, и отдаёт вошедшим клиентам.
//! Ключ не задан — `enabled: false`, кнопка GIF в клиенте не показывается.

use crate::{auth::AuthenticatedUser, AppState};
use axum::{extract::State, response::IntoResponse, Json};
use std::sync::Arc;

/// `GET /api/gifs/config` — провайдер и ключ приложения KLIPY.
pub(crate) async fn gifs_config(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_username): AuthenticatedUser,
) -> impl IntoResponse {
    match &state.config.klipy_app_key {
        Some(key) => Json(serde_json::json!({
            "enabled": true,
            "provider": "klipy",
            "appKey": key,
        })),
        None => Json(serde_json::json!({ "enabled": false })),
    }
}
