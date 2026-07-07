//! Device trust, E2E key envelope delivery, cloud vault events, and history
//! ticket / transparency log endpoints. Split out of main.rs so device-trust
//! bugs (approval/revocation races, key envelope delivery, history access
//! windows) can be found and fixed without wading through unrelated HTTP
//! handlers.

use crate::{
    trim_limited, send_payload_to_user, AppState, ApproveDevicePayload, AuthenticatedUser,
    DeviceRecord, DeviceResponse, HistoryTicketPayload, HistoryTicketRecord, HistoryTicketResponse,
    KeyEnvelopePayload, KeyEnvelopeRecord, KeyEnvelopeResponse, MessagePageQuery,
    RegisterDevicePayload, TransparencyLogRecord, VaultEventPayload, VaultEventRecord,
    VaultEventResponse,
};
use axum::{
    extract::{Path as AxumPath, Query},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::{sqlite::SqlitePool, QueryBuilder, Sqlite};
use std::sync::Arc;
use tracing::error;
use uuid::Uuid;

pub(crate) fn device_record_to_response(record: DeviceRecord) -> DeviceResponse {
    let key_package = serde_json::from_str(&record.key_package).unwrap_or_else(|_| {
        serde_json::json!({
            "raw": record.key_package
        })
    });
    DeviceResponse {
        deviceId: record.device_id,
        owner: record.owner,
        label: record.label,
        publicKey: record.public_key,
        keyPackage: key_package,
        groupEpoch: record.group_epoch,
        approved: record.approved != 0,
        revoked: record.revoked != 0,
        approvedBy: record.approved_by,
        historyDays: record.history_days,
        createdAt: record.created_at,
        approvedAt: record.approved_at,
        revokedAt: record.revoked_at,
    }
}

pub(crate) async fn next_device_epoch(pool: &SqlitePool, owner: &str) -> Result<i64, sqlx::Error> {
    let current = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(group_epoch) FROM account_devices WHERE owner = ?",
    )
    .bind(owner)
    .fetch_one(pool)
    .await?
    .unwrap_or(0);
    Ok(current + 1)
}

pub(crate) async fn load_device(
    pool: &SqlitePool,
    owner: &str,
    device_id: &str,
) -> Result<Option<DeviceRecord>, sqlx::Error> {
    sqlx::query_as::<_, DeviceRecord>(
        "SELECT device_id, owner, label, public_key, signing_key, key_package, group_epoch,
                approved, revoked, approved_by, history_days, created_at, approved_at, revoked_at
         FROM account_devices
         WHERE owner = ? AND device_id = ?
         LIMIT 1",
    )
    .bind(owner)
    .bind(device_id)
    .fetch_optional(pool)
    .await
}

pub(crate) async fn require_approved_device(
    pool: &SqlitePool,
    owner: &str,
    device_id: &str,
) -> Result<DeviceRecord, Response> {
    match load_device(pool, owner, device_id).await {
        Ok(Some(device)) if device.approved != 0 && device.revoked == 0 => Ok(device),
        Ok(Some(_)) => Err((StatusCode::FORBIDDEN, "Устройство не подтверждено").into_response()),
        Ok(None) => Err((StatusCode::NOT_FOUND, "Устройство не найдено").into_response()),
        Err(e) => {
            error!("Ошибка чтения устройства {}: {}", device_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
    }
}

pub(crate) struct TransparencyEvent<'a> {
    pub(crate) owner: &'a str,
    pub(crate) event_type: &'a str,
    pub(crate) group_epoch: i64,
    pub(crate) actor_device_id: &'a str,
    pub(crate) target_device_id: Option<&'a str>,
    pub(crate) event_json: serde_json::Value,
    pub(crate) signature: Option<&'a str>,
}

pub(crate) async fn append_transparency_log(
    pool: &SqlitePool,
    event: TransparencyEvent<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO transparency_log
         (owner, event_type, group_epoch, actor_device_id, target_device_id, event_json, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(event.owner)
    .bind(event.event_type)
    .bind(event.group_epoch)
    .bind(event.actor_device_id)
    .bind(event.target_device_id)
    .bind(event.event_json.to_string())
    .bind(event.signature.unwrap_or(""))
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn get_devices(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query_as::<_, DeviceRecord>(
        "SELECT device_id, owner, label, public_key, signing_key, key_package, group_epoch,
                approved, revoked, approved_by, history_days, created_at, approved_at, revoked_at
         FROM account_devices
         WHERE owner = ?
         ORDER BY revoked ASC, approved DESC, created_at ASC",
    )
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(devices) => Json(
            devices
                .into_iter()
                .map(device_record_to_response)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка получения устройств {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn get_user_public_devices(
    AxumPath(username): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(_requester): AuthenticatedUser,
) -> impl IntoResponse {
    let username = trim_limited(username, 64);
    if username.is_empty() {
        return (StatusCode::BAD_REQUEST, "Нужен username").into_response();
    }
    match sqlx::query_as::<_, DeviceRecord>(
        "SELECT device_id, owner, label, public_key, signing_key, key_package, group_epoch,
                approved, revoked, approved_by, history_days, created_at, approved_at, revoked_at
         FROM account_devices
         WHERE owner = ? AND revoked = 0
         ORDER BY created_at ASC",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    {
        Ok(devices) => Json(
            devices
                .into_iter()
                .map(device_record_to_response)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка получения публичных устройств {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn register_device(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<RegisterDevicePayload>,
) -> impl IntoResponse {
    let device_id = trim_limited(payload.deviceId, 128);
    if device_id.len() < 8 || device_id.chars().any(char::is_whitespace) {
        return (StatusCode::BAD_REQUEST, "Некорректный deviceId").into_response();
    }

    let label = trim_limited(
        payload.label.unwrap_or_else(|| "Zali device".to_string()),
        96,
    );
    let public_key = trim_limited(payload.publicKey.unwrap_or_default(), 4096);
    let signing_key = trim_limited(payload.signingKey.unwrap_or_default(), 4096);
    let key_package =
        serde_json::to_string(&payload.keyPackage.unwrap_or_else(|| serde_json::json!({})))
            .unwrap_or_else(|_| "{}".to_string());

    let mut conn = match state.db.acquire().await {
        Ok(conn) => conn,
        Err(e) => {
            error!(
                "Ошибка получения соединения для регистрации устройства {}: {}",
                device_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if let Err(e) = sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await {
        error!(
            "Ошибка начала блокирующей транзакции для устройства {}: {}",
            device_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let result: Result<(bool, i64), sqlx::Error> = async {
        let approved_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM account_devices WHERE owner = ? AND approved = 1 AND revoked = 0",
        )
        .bind(&owner)
        .fetch_one(&mut *conn)
        .await?;

        let first_device = approved_count == 0;
        let group_epoch = if first_device {
            1
        } else {
            sqlx::query_scalar::<_, Option<i64>>(
                "SELECT MAX(group_epoch) FROM account_devices WHERE owner = ?",
            )
            .bind(&owner)
            .fetch_one(&mut *conn)
            .await?
            .unwrap_or(1)
        };
        let approved = if first_device { 1 } else { 0 };
        let approved_by = if first_device {
            Some(device_id.clone())
        } else {
            None
        };

        sqlx::query(
            "INSERT INTO account_devices
             (owner, device_id, label, public_key, signing_key, key_package, group_epoch, approved, revoked, approved_by, approved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)
             ON CONFLICT(owner, device_id) DO UPDATE SET
                label = excluded.label,
                public_key = excluded.public_key,
                signing_key = excluded.signing_key,
                key_package = excluded.key_package,
                approved = CASE
                    WHEN account_devices.approved = 1 THEN 1
                    ELSE excluded.approved
                END,
                revoked = 0,
                approved_by = COALESCE(account_devices.approved_by, excluded.approved_by),
                approved_at = COALESCE(approved_at, excluded.approved_at),
                revoked_at = NULL,
                history_days = CASE
                    WHEN account_devices.approved = 1 THEN COALESCE(account_devices.history_days, 30)
                    ELSE COALESCE(account_devices.history_days, 30)
                END,
                group_epoch = CASE
                    WHEN account_devices.approved = 1 THEN account_devices.group_epoch
                    ELSE excluded.group_epoch
                END",
        )
        .bind(&owner)
        .bind(&device_id)
        .bind(&label)
        .bind(&public_key)
        .bind(&signing_key)
        .bind(&key_package)
        .bind(group_epoch)
        .bind(approved)
        .bind(approved_by.as_deref())
        .bind(approved)
        .execute(&mut *conn)
        .await?;

        if first_device {
            sqlx::query(
                "UPDATE account_devices
                 SET approved = 1,
                     revoked = 0,
                     approved_by = device_id,
                     approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
                     history_days = COALESCE(history_days, 3650),
                     group_epoch = 1,
                     revoked_at = NULL
                 WHERE owner = ? AND device_id = ?",
            )
            .bind(&owner)
            .bind(&device_id)
            .execute(&mut *conn)
            .await?;
        }

        sqlx::query("COMMIT").execute(&mut *conn).await?;
        Ok((first_device, group_epoch))
    }
    .await;

    let (first_device, group_epoch) = match result {
        Ok(value) => value,
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            error!("Ошибка регистрации устройства {}: {}", device_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if first_device {
        let _ = append_transparency_log(
            &state.db,
            TransparencyEvent {
                owner: &owner,
                event_type: "device_add",
                group_epoch,
                actor_device_id: &device_id,
                target_device_id: Some(&device_id),
                event_json: serde_json::json!({
                    "type": "device_add",
                    "account_id": owner,
                    "new_device_id": device_id,
                    "approved_by": device_id,
                    "device_group_epoch": group_epoch,
                    "first_device": true
                }),
                signature: None,
            },
        )
        .await;
    }

    match load_device(&state.db, &owner, &device_id).await {
        Ok(Some(device)) => Json(device_record_to_response(device)).into_response(),
        Ok(None) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(e) => {
            error!("Ошибка чтения зарегистрированного устройства: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn approve_device(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    headers: HeaderMap,
    Json(payload): Json<ApproveDevicePayload>,
) -> impl IntoResponse {
    let target_id = trim_limited(payload.deviceId, 128);
    let actor_id = trim_limited(payload.approvedByDeviceId, 128);
    let header_actor_id = match header_device_id(&headers) {
        Some(value) => value,
        None => {
            return (
                StatusCode::FORBIDDEN,
                "Нужен X-Zali-Device-ID доверенного устройства",
            )
                .into_response()
        }
    };
    if target_id.is_empty() || actor_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Нужны deviceId и approvedByDeviceId",
        )
            .into_response();
    }
    if target_id == actor_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Нельзя подтвердить собственное устройство"})),
        )
            .into_response();
    }
    if actor_id != header_actor_id {
        return (
            StatusCode::FORBIDDEN,
            "approvedByDeviceId должен совпадать с X-Zali-Device-ID",
        )
            .into_response();
    }

    if require_approved_device(&state.db, &owner, &header_actor_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            "Подтверждать может только доверенное устройство",
        )
            .into_response();
    }

    let target = match load_device(&state.db, &owner, &target_id).await {
        Ok(Some(device)) if device.revoked == 0 => device,
        Ok(Some(_)) => return (StatusCode::FORBIDDEN, "Устройство отозвано").into_response(),
        Ok(None) => return (StatusCode::NOT_FOUND, "Устройство не найдено").into_response(),
        Err(e) => {
            error!("Ошибка чтения устройства {}: {}", target_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let history_days = payload.historyDays.unwrap_or(30).clamp(0, 30);
    let group_epoch = match next_device_epoch(&state.db, &owner).await {
        Ok(epoch) => epoch,
        Err(e) => {
            error!("Ошибка расчета эпохи устройств {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let key_package = payload
        .keyPackage
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| target.key_package.clone()))
        .unwrap_or(target.key_package);

    if let Err(e) = sqlx::query(
        "UPDATE account_devices
         SET approved = 1,
             revoked = 0,
             approved_by = ?,
             history_days = ?,
             group_epoch = ?,
             key_package = ?,
             approved_at = CURRENT_TIMESTAMP,
             revoked_at = NULL
         WHERE owner = ? AND device_id = ?",
    )
    .bind(&actor_id)
    .bind(history_days)
    .bind(group_epoch)
    .bind(&key_package)
    .bind(&owner)
    .bind(&target_id)
    .execute(&state.db)
    .await
    {
        error!("Ошибка подтверждения устройства {}: {}", target_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let _ = append_transparency_log(
        &state.db,
        TransparencyEvent {
            owner: &owner,
            event_type: "device_add",
            group_epoch,
            actor_device_id: &header_actor_id,
            target_device_id: Some(&target_id),
            event_json: serde_json::json!({
                "type": "device_add",
                "account_id": owner,
                "new_device_id": target_id,
                "approved_by": header_actor_id,
                "device_group_epoch": group_epoch,
                "history_days": history_days
            }),
            signature: payload.signature.as_deref(),
        },
    )
    .await;

    match load_device(&state.db, &owner, &target_id).await {
        Ok(Some(device)) => Json(device_record_to_response(device)).into_response(),
        Ok(None) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(e) => {
            error!("Ошибка чтения подтвержденного устройства: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn revoke_device(
    AxumPath(device_id): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    headers: HeaderMap,
) -> impl IntoResponse {
    let device_id = trim_limited(device_id, 128);
    let actor_id = match header_device_id(&headers) {
        Some(value) => value,
        None => {
            return (
                StatusCode::FORBIDDEN,
                "Нужен X-Zali-Device-ID доверенного устройства",
            )
                .into_response()
        }
    };
    if require_approved_device(&state.db, &owner, &actor_id)
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            "Отзывать может только доверенное устройство",
        )
            .into_response();
    }

    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => {
            error!(
                "Ошибка получения соединения для revoke_device {}: {}",
                device_id, e
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Err(e) = sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await {
        error!(
            "Ошибка начала транзакции revoke_device {}: {}",
            device_id, e
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let revoke_result: Result<i64, sqlx::Error> = async {
        let active_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM account_devices WHERE owner = ? AND approved = 1 AND revoked = 0",
        )
        .bind(&owner)
        .fetch_one(&mut *conn)
        .await?;

        let target_approved = sqlx::query_scalar::<_, i64>(
            "SELECT approved FROM account_devices WHERE owner = ? AND device_id = ? LIMIT 1",
        )
        .bind(&owner)
        .bind(&device_id)
        .fetch_optional(&mut *conn)
        .await?;

        let target_approved = match target_approved {
            Some(v) => v,
            None => return Err(sqlx::Error::RowNotFound),
        };

        let target_revoked = sqlx::query_scalar::<_, i64>(
            "SELECT revoked FROM account_devices WHERE owner = ? AND device_id = ? LIMIT 1",
        )
        .bind(&owner)
        .bind(&device_id)
        .fetch_one(&mut *conn)
        .await?;

        if target_approved != 0 && target_revoked == 0 && active_count <= 1 {
            // Encode the "last device" constraint as a sentinel value
            return Ok(-1i64);
        }

        let group_epoch = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(group_epoch) FROM account_devices WHERE owner = ?",
        )
        .bind(&owner)
        .fetch_one(&mut *conn)
        .await?
        .unwrap_or(1)
            + 1;

        sqlx::query(
            "UPDATE account_devices
             SET revoked = 1, approved = 0, group_epoch = ?, revoked_at = CURRENT_TIMESTAMP
             WHERE owner = ? AND device_id = ?",
        )
        .bind(group_epoch)
        .bind(&owner)
        .bind(&device_id)
        .execute(&mut *conn)
        .await?;

        sqlx::query("COMMIT").execute(&mut *conn).await?;
        Ok(group_epoch)
    }
    .await;

    let group_epoch = match revoke_result {
        Ok(-1) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return (
                StatusCode::BAD_REQUEST,
                "Нельзя отозвать последнее доверенное устройство",
            )
                .into_response();
        }
        Ok(epoch) => epoch,
        Err(sqlx::Error::RowNotFound) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return (StatusCode::NOT_FOUND, "Устройство не найдено").into_response();
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            error!("Ошибка отзыва устройства {}: {}", device_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let _ = append_transparency_log(
        &state.db,
        TransparencyEvent {
            owner: &owner,
            event_type: "device_remove",
            group_epoch,
            actor_device_id: &actor_id,
            target_device_id: Some(&device_id),
            event_json: serde_json::json!({
                "type": "device_remove",
                "account_id": owner,
                "actor_device_id": actor_id,
                "removed_device_id": device_id,
                "device_group_epoch": group_epoch
            }),
            signature: None,
        },
    )
    .await;

    StatusCode::NO_CONTENT.into_response()
}

#[derive(Debug, Deserialize, Default)]
#[allow(non_snake_case)]
pub(crate) struct VaultQuery {
    deviceId: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[allow(non_snake_case)]
pub(crate) struct KeyEnvelopeQuery {
    deviceId: Option<String>,
}

pub(crate) async fn post_vault_event(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<VaultEventPayload>,
) -> impl IntoResponse {
    let device_id = trim_limited(payload.deviceId.unwrap_or_default(), 128);
    let encrypted = trim_limited(payload.encryptedVaultEvent, 262_144);
    if encrypted.len() < 16 {
        return (StatusCode::BAD_REQUEST, "Пустой encryptedVaultEvent").into_response();
    }
    if !device_id.is_empty() && device_id != "cloud"
        && require_approved_device(&state.db, &owner, &device_id).await.is_err() {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": "Устройство не подтверждено"})),
            )
                .into_response();
        }
    let event_id = Uuid::new_v4().to_string();
    let vault_epoch = payload
        .vaultEpoch
        .unwrap_or_else(|| Utc::now().timestamp())
        .max(1);
    let target = payload
        .issuedToDeviceId
        .map(|value| trim_limited(value, 128))
        .filter(|value| !value.is_empty());

    if let Err(e) = sqlx::query(
        "INSERT INTO account_vault_events
         (event_id, owner, device_id, issued_to_device_id, vault_epoch, encrypted_vault_event, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&event_id)
    .bind(&owner)
    .bind(if device_id.is_empty() { "cloud" } else { &device_id })
    .bind(target.as_deref())
    .bind(vault_epoch)
    .bind(&encrypted)
    .bind(payload.signature.as_deref().unwrap_or(""))
    .execute(&state.db)
    .await
    {
        error!("Ошибка записи vault event {}: {}", event_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    Json(serde_json::json!({
        "eventId": event_id,
        "vaultEpoch": vault_epoch
    }))
    .into_response()
}

pub(crate) async fn delete_vault_events(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query("DELETE FROM account_vault_events WHERE owner = ?")
        .bind(&owner)
        .execute(&state.db)
        .await
    {
        Ok(result) => Json(serde_json::json!({
            "deleted": result.rows_affected()
        }))
        .into_response(),
        Err(e) => {
            error!("Ошибка очистки vault events для {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn delete_key_envelopes(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query("DELETE FROM conversation_key_envelopes WHERE owner = ? OR sender = ?")
        .bind(&user)
        .bind(&user)
        .execute(&state.db)
        .await
    {
        Ok(result) => Json(serde_json::json!({
            "deleted": result.rows_affected()
        }))
        .into_response(),
        Err(e) => {
            error!("Ошибка сброса key envelopes для {}: {}", user, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) fn key_envelope_record_to_response(record: KeyEnvelopeRecord) -> KeyEnvelopeResponse {
    KeyEnvelopeResponse {
        envelopeId: record.envelope_id,
        owner: record.owner,
        scope: record.scope_key,
        sender: record.sender,
        senderDeviceId: record.sender_device_id,
        recipientDeviceId: record.recipient_device_id,
        encryptedKey: record.encrypted_key,
        createdAt: record.created_at,
    }
}

pub(crate) async fn post_key_envelope(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(sender): AuthenticatedUser,
    Json(payload): Json<KeyEnvelopePayload>,
) -> impl IntoResponse {
    let recipient = trim_limited(payload.recipient, 64);
    let scope = trim_limited(payload.scope, 256);
    let encrypted_key = trim_limited(payload.encryptedKey, 262_144);
    // Device id is no longer a real identifier here, just a dedup key for the
    // ON CONFLICT upsert below — "any" groups all envelopes for a given
    // (owner, scope, sender) into one row that gets replaced on republish,
    // same placeholder pattern as post_vault_event's "cloud".
    let sender_device_id = trim_limited(payload.senderDeviceId.unwrap_or_default(), 128);
    let sender_device_id = if sender_device_id.is_empty() { "any".to_string() } else { sender_device_id };
    let recipient_device_id = trim_limited(payload.recipientDeviceId.unwrap_or_default(), 128);
    let recipient_device_id = if recipient_device_id.is_empty() { "any".to_string() } else { recipient_device_id };
    if recipient.is_empty() || scope.is_empty() || encrypted_key.len() < 32 {
        return (StatusCode::BAD_REQUEST, "Некорректный key envelope").into_response();
    }

    let envelope_id = Uuid::new_v4().to_string();
    match sqlx::query(
        "INSERT INTO conversation_key_envelopes
         (envelope_id, owner, scope_key, sender, sender_device_id, recipient_device_id, encrypted_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, scope_key, sender_device_id, recipient_device_id) DO UPDATE SET
             encrypted_key = excluded.encrypted_key,
             created_at = CURRENT_TIMESTAMP",
    )
    .bind(&envelope_id)
    .bind(&recipient)
    .bind(&scope)
    .bind(&sender)
    .bind(&sender_device_id)
    .bind(&recipient_device_id)
    .bind(&encrypted_key)
    .execute(&state.db)
    .await
    {
        Ok(_) => {
            let notify_payload =
                serde_json::json!({ "type": "key_envelope_available" }).to_string();
            send_payload_to_user(&state, &recipient, notify_payload, "post_key_envelope").await;
            Json(serde_json::json!({ "envelopeId": envelope_id })).into_response()
        }
        Err(e) => {
            error!("Ошибка записи key envelope {} -> {}: {}", sender, recipient, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn get_key_envelopes(
    Query(query): Query<KeyEnvelopeQuery>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    let target_device = query
        .deviceId
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let rows = sqlx::query_as::<_, KeyEnvelopeRecord>(
        "SELECT envelope_id, owner, scope_key, sender, sender_device_id,
                recipient_device_id, encrypted_key, created_at
         FROM conversation_key_envelopes
         WHERE owner = ? AND (? IS NULL OR recipient_device_id = ?)
         ORDER BY created_at ASC",
    )
    .bind(&owner)
    .bind(target_device.as_deref())
    .bind(target_device.as_deref())
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(key_envelope_record_to_response)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка чтения key envelopes {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn get_vault_events(
    Query(query): Query<VaultQuery>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    let target_device = query
        .deviceId
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let rows = sqlx::query_as::<_, VaultEventRecord>(
        "SELECT event_id, owner, device_id, issued_to_device_id, vault_epoch,
                encrypted_vault_event, signature, created_at
         FROM account_vault_events
         WHERE owner = ? AND (? IS NULL OR issued_to_device_id IS NULL OR issued_to_device_id = ?)
         ORDER BY vault_epoch ASC, created_at ASC",
    )
    .bind(&owner)
    .bind(target_device.as_deref())
    .bind(target_device.as_deref())
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|row| VaultEventResponse {
                    eventId: row.event_id,
                    owner: row.owner,
                    deviceId: row.device_id,
                    issuedToDeviceId: row.issued_to_device_id,
                    vaultEpoch: row.vault_epoch,
                    encryptedVaultEvent: row.encrypted_vault_event,
                    signature: row.signature,
                    createdAt: row.created_at,
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка чтения vault events {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) fn parse_rfc3339_utc(value: &str) -> Result<DateTime<Utc>, Box<Response>> {
    DateTime::parse_from_rfc3339(value.trim())
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| Box::new((StatusCode::BAD_REQUEST, "Дата должна быть RFC3339").into_response()))
}

#[derive(Debug, Clone, Copy)]
struct HistoryWindow {
    from: DateTime<Utc>,
    to: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub(crate) struct HistoryAccess {
    base_since: Option<DateTime<Utc>>,
    ticket_windows: Vec<HistoryWindow>,
}

pub(crate) async fn resolve_history_access(
    _pool: &SqlitePool,
    _owner: &str,
    page: &MessagePageQuery,
    _headers: &HeaderMap,
    _conversation_id: Option<&str>,
) -> Result<HistoryAccess, Response> {
    let explicit_since = match page
        .since
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(value) => Some(parse_rfc3339_utc(value).map_err(|response| *response)?),
        None => None,
    };
    Ok(HistoryAccess {
        base_since: explicit_since,
        ticket_windows: Vec::new(),
    })
}

pub(crate) fn history_access_matches(timestamp: DateTime<Utc>, access: &HistoryAccess) -> bool {
    if access.base_since.is_none() {
        return true;
    }
    if access.base_since.is_some_and(|since| timestamp >= since) {
        return true;
    }
    access
        .ticket_windows
        .iter()
        .any(|window| timestamp >= window.from && timestamp <= window.to)
}

pub(crate) fn push_history_access_predicate(builder: &mut QueryBuilder<'_, Sqlite>, access: &HistoryAccess) {
    let has_base = access.base_since.is_some();
    let has_tickets = !access.ticket_windows.is_empty();
    if !has_base && !has_tickets {
        return;
    }

    builder.push(" AND (");
    let mut needs_or = false;
    if let Some(base_since) = access.base_since {
        builder.push("timestamp >= ");
        builder.push_bind(base_since);
        needs_or = true;
    }

    for window in &access.ticket_windows {
        if needs_or {
            builder.push(" OR ");
        }
        builder.push("(");
        builder.push("timestamp >= ");
        builder.push_bind(window.from);
        builder.push(" AND timestamp <= ");
        builder.push_bind(window.to);
        builder.push(")");
        needs_or = true;
    }

    builder.push(")");
}

pub(crate) fn header_device_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-zali-device-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

pub(crate) fn dm_conversation_scope(a: &str, b: &str) -> String {
    let mut pair = [a.trim().to_string(), b.trim().to_string()];
    pair.sort();
    format!("dm:{}:{}", pair[0], pair[1])
}

pub(crate) fn server_conversation_scope(server_id: &str, channel_id: &str) -> String {
    format!("server:{}:{}", server_id.trim(), channel_id.trim())
}

pub(crate) async fn create_history_ticket(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<HistoryTicketPayload>,
) -> impl IntoResponse {
    let issued_by = trim_limited(payload.issuedByDeviceId, 128);
    let issued_to = trim_limited(payload.issuedToDeviceId, 128);
    let from_time = match parse_rfc3339_utc(&payload.fromTime) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let to_time = match parse_rfc3339_utc(&payload.toTime) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let expires_at = match parse_rfc3339_utc(&payload.expiresAt) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if from_time > to_time || expires_at <= Utc::now() {
        return (StatusCode::BAD_REQUEST, "Некорректное окно History Ticket").into_response();
    }

    let ticket_id = Uuid::new_v4().to_string();
    let conversation_id = trim_limited(payload.conversationId, 256);
    let encrypted = trim_limited(payload.encryptedExportSecrets, 262_144);
    if conversation_id.is_empty() || encrypted.len() < 16 {
        return (
            StatusCode::BAD_REQUEST,
            "Пустой conversationId или encryptedExportSecrets",
        )
            .into_response();
    }

    if let Err(e) = sqlx::query(
        "INSERT INTO history_tickets
         (ticket_id, owner, issued_by_device_id, issued_to_device_id, conversation_id,
          from_time, to_time, expires_at, encrypted_export_secrets, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&ticket_id)
    .bind(&owner)
    .bind(&issued_by)
    .bind(&issued_to)
    .bind(&conversation_id)
    .bind(from_time)
    .bind(to_time)
    .bind(expires_at)
    .bind(&encrypted)
    .bind(payload.signature.as_deref().unwrap_or(""))
    .execute(&state.db)
    .await
    {
        error!("Ошибка записи history ticket {}: {}", ticket_id, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    Json(serde_json::json!({
        "ticketId": ticket_id,
        "conversationId": conversation_id
    }))
    .into_response()
}

pub(crate) async fn get_history_tickets(
    Query(query): Query<VaultQuery>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    let device_id = query
        .deviceId
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let rows = sqlx::query_as::<_, HistoryTicketRecord>(
        "SELECT ticket_id, owner, issued_by_device_id, issued_to_device_id, conversation_id,
                from_time, to_time, expires_at, encrypted_export_secrets, signature, revoked, created_at
         FROM history_tickets
         WHERE owner = ? AND (? IS NULL OR issued_to_device_id = ?)
         ORDER BY created_at DESC",
    )
    .bind(&owner)
    .bind(device_id.as_deref())
    .bind(device_id.as_deref())
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|row| HistoryTicketResponse {
                    ticketId: row.ticket_id,
                    owner: row.owner,
                    issuedByDeviceId: row.issued_by_device_id,
                    issuedToDeviceId: row.issued_to_device_id,
                    conversationId: row.conversation_id,
                    fromTime: row.from_time,
                    toTime: row.to_time,
                    expiresAt: row.expires_at,
                    encryptedExportSecrets: row.encrypted_export_secrets,
                    signature: row.signature,
                    revoked: row.revoked != 0,
                    createdAt: row.created_at,
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            error!("Ошибка чтения history tickets {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn get_transparency_log(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    match sqlx::query_as::<_, TransparencyLogRecord>(
        "SELECT seq, owner, event_type, group_epoch, actor_device_id, target_device_id,
                event_json, signature, created_at
         FROM transparency_log
         WHERE owner = ?
         ORDER BY seq ASC",
    )
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            error!("Ошибка чтения transparency log {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
