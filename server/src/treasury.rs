//! Казна сервера: ZaliCoin на балансе сервера, а не человека.
//!
//! Пополнить казну может любой участник сервера — своими ZaliCoin — и тот, кто
//! распоряжается казной другого сервера, — деньгами той казны. Выплачивать из
//! казны (человеку, другому серверу или всем участникам с ролью) может только
//! тот, у кого есть право «Казна»: владелец, админ или роль с
//! `can_manage_treasury`.
//!
//! Деньги по-прежнему не появляются и не исчезают: инвариант эмиссии теперь
//! `SUM(coin_balances) + SUM(server_treasuries) + удержанное в карточках = 100 000`.
//! Каждая операция — одна `BEGIN IMMEDIATE`-транзакция (`run_immediate_tx`), а
//! списание — условный `UPDATE … WHERE balance >= ?`, так что два одновременных
//! списания не могут оба пройти проверку остатка. Повтор запроса с тем же
//! `(actor, idempotency_key)` возвращает уже проведённую операцию, а не проводит
//! вторую.
//!
//! Выплата с сервера человеку пишет строку в `treasury_payouts` — из неё
//! получатель видит раздел «От серверов» на экране ZaliCoin. Имена сервера и роли
//! в операции — снимок на момент выплаты: история не должна терять смысл, когда
//! сервер переименуют или удалят.

use crate::{
    get_server_accessibility, get_server_member_role, run_immediate_tx, send_payload_to_user,
    trim_limited, AppState, AuthenticatedUser, CoinTxOutcome, ZALICOIN_TOTAL_SUPPLY,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::{collections::HashSet, sync::Arc};
use tracing::{error, info, warn};
use uuid::Uuid;

const TREASURY_NOTE_MAX_CHARS: usize = 140;
const TREASURY_HISTORY_LIMIT: i64 = 50;
const SERVER_PAYOUTS_LIMIT: i64 = 100;
const TREASURY_MEMBERS_LIMIT: i64 = 500;
/// Адресат выплаты «все участники сервера» вместо конкретной роли.
pub(crate) const TREASURY_ALL_MEMBERS: &str = "*";

const OPERATION_COLUMNS: &str = "id, actor, source_kind, source_id, source_name, target_kind, target_id, target_name, amount, recipients, total, note, created_at";

/// Право распоряжаться казной: владелец и админ — всегда, остальные — по флагу роли.
pub(crate) async fn can_manage_treasury(
    pool: &SqlitePool,
    server_id: &str,
    username: &str,
) -> Result<bool, sqlx::Error> {
    match get_server_member_role(pool, server_id, username).await?.as_deref() {
        None => Ok(false),
        Some("owner") | Some("admin") => Ok(true),
        Some(role_id) => {
            let flag: Option<i64> = sqlx::query_scalar(
                "SELECT can_manage_treasury FROM server_roles WHERE server_id = ? AND role_id = ? LIMIT 1",
            )
            .bind(server_id)
            .bind(role_id)
            .fetch_optional(pool)
            .await?;
            Ok(flag.unwrap_or(0) != 0)
        }
    }
}

pub(crate) async fn load_treasury_balance(pool: &SqlitePool, server_id: &str) -> Result<i64, sqlx::Error> {
    Ok(sqlx::query_scalar("SELECT balance FROM server_treasuries WHERE server_id = ?")
        .bind(server_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or(0))
}

async fn load_user_balance(pool: &SqlitePool, username: &str) -> i64 {
    sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// Комментарий показывается получателям одной строкой — переводы строк и прочие
/// управляющие символы в нём не нужны.
fn clean_note(note: Option<&str>) -> String {
    let flat: String = note
        .unwrap_or("")
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    trim_limited(flat, TREASURY_NOTE_MAX_CHARS)
}

fn treasury_error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(serde_json::json!({ "code": code, "message": message }))).into_response()
}

/// Имя адресата «роль» для выплаты. `owner` не адресуется ролью — это один
/// человек, для него есть выплата человеку.
async fn treasury_role_name(
    pool: &SqlitePool,
    server_id: &str,
    role_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    if role_id == TREASURY_ALL_MEMBERS {
        return Ok(Some("Все участники".to_string()));
    }
    if role_id == "owner" {
        return Ok(None);
    }
    let stored: Option<String> =
        sqlx::query_scalar("SELECT name FROM server_roles WHERE server_id = ? AND role_id = ? LIMIT 1")
            .bind(server_id)
            .bind(role_id)
            .fetch_optional(pool)
            .await?;
    Ok(stored.or_else(|| match role_id {
        "admin" => Some("Админ".to_string()),
        "member" => Some("Участник".to_string()),
        _ => None,
    }))
}

// ============================================================================
// Операция
// ============================================================================

#[derive(Debug, Clone)]
enum TreasurySource {
    User(String),
    Server { id: String, name: String },
}

#[derive(Debug, Clone)]
enum TreasuryTarget {
    User(String),
    Server { id: String, name: String },
    Role { server_id: String, role_id: String, name: String },
}

#[derive(Debug, Clone)]
struct TreasuryMove {
    actor: String,
    source: TreasurySource,
    target: TreasuryTarget,
    /// На одного получателя; у выплаты роли итог — `amount × участников`.
    amount: i64,
    note: String,
    idempotency_key: String,
}

impl TreasuryMove {
    fn source_columns(&self) -> (&'static str, &str, &str) {
        match &self.source {
            TreasurySource::User(name) => ("user", name, name),
            TreasurySource::Server { id, name } => ("server", id, name),
        }
    }

    fn target_columns(&self) -> (&'static str, &str, &str) {
        match &self.target {
            TreasuryTarget::User(name) => ("user", name, name),
            TreasuryTarget::Server { id, name } => ("server", id, name),
            TreasuryTarget::Role { role_id, name, .. } => ("role", role_id, name),
        }
    }

    /// Казны, чей баланс меняет операция.
    fn touched_servers(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let TreasurySource::Server { id, .. } = &self.source {
            out.push(id.clone());
        }
        if let TreasuryTarget::Server { id, .. } = &self.target {
            if !out.contains(id) {
                out.push(id.clone());
            }
        }
        out
    }
}

enum TreasuryOutcome {
    Done { id: String, recipients: Vec<String> },
    Replayed(String),
    InsufficientFunds,
    NoRecipients,
    TargetGone,
}

impl CoinTxOutcome for TreasuryOutcome {
    fn commits(&self) -> bool {
        matches!(self, TreasuryOutcome::Done { .. })
    }
}

/// Получатели выплаты роли. Только существующие аккаунты: строка участника
/// переживает удалённого пользователя, и монеты «на имя», которого нет,
/// фактически выпали бы из эмиссии.
async fn role_recipients(
    conn: &mut SqliteConnection,
    server_id: &str,
    role_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let mut names: Vec<String> = if role_id == TREASURY_ALL_MEMBERS {
        sqlx::query_scalar(
            "SELECT m.username FROM server_members m JOIN users u ON u.username = m.username
             WHERE m.server_id = ?
             UNION
             SELECT s.owner FROM servers s JOIN users u ON u.username = s.owner
             WHERE s.id = ?
             ORDER BY 1",
        )
        .bind(server_id)
        .bind(server_id)
        .fetch_all(&mut *conn)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT m.username FROM server_members m JOIN users u ON u.username = m.username
             WHERE m.server_id = ? AND m.role = ?
             ORDER BY m.username",
        )
        .bind(server_id)
        .bind(role_id)
        .fetch_all(&mut *conn)
        .await?
    };
    let mut seen = HashSet::new();
    names.retain(|name| seen.insert(name.clone()));
    Ok(names)
}

async fn credit_user(conn: &mut SqliteConnection, username: &str, amount: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
         ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
    )
    .bind(username)
    .bind(amount)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn credit_treasury(conn: &mut SqliteConnection, server_id: &str, amount: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO server_treasuries (server_id, balance) VALUES (?, ?)
         ON CONFLICT(server_id) DO UPDATE SET balance = balance + excluded.balance",
    )
    .bind(server_id)
    .bind(amount)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

struct OperationInsert<'a> {
    id: &'a str,
    actor: &'a str,
    source: (&'a str, &'a str, &'a str),
    target: (&'a str, &'a str, &'a str),
    amount: i64,
    recipients: i64,
    total: i64,
    note: &'a str,
    idempotency_key: &'a str,
    created_at: &'a str,
}

async fn insert_operation(conn: &mut SqliteConnection, op: OperationInsert<'_>) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "INSERT INTO treasury_operations ({}, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        OPERATION_COLUMNS
    ))
    .bind(op.id)
    .bind(op.actor)
    .bind(op.source.0)
    .bind(op.source.1)
    .bind(op.source.2)
    .bind(op.target.0)
    .bind(op.target.1)
    .bind(op.target.2)
    .bind(op.amount)
    .bind(op.recipients)
    .bind(op.total)
    .bind(op.note)
    .bind(op.created_at)
    .bind(op.idempotency_key)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn insert_payout(
    conn: &mut SqliteConnection,
    operation_id: &str,
    username: &str,
    server_id: &str,
    amount: i64,
    created_at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO treasury_payouts (operation_id, username, server_id, amount, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(operation_id)
    .bind(username)
    .bind(server_id)
    .bind(amount)
    .bind(created_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn apply_treasury_move(conn: &mut SqliteConnection, mv: &TreasuryMove) -> Result<TreasuryOutcome, sqlx::Error> {
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM treasury_operations WHERE actor = ? AND idempotency_key = ?")
            .bind(&mv.actor)
            .bind(&mv.idempotency_key)
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(id) = existing {
        return Ok(TreasuryOutcome::Replayed(id));
    }

    // Хендлер проверял сервер-получатель до транзакции. Удаление, успевшее
    // закоммититься в этот промежуток, уже вернуло казну владельцу, и зачисление
    // создало бы казну несуществующего сервера — монеты, до которых не добраться.
    if let TreasuryTarget::Server { id, .. } = &mv.target {
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM servers WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
        if exists == 0 {
            return Ok(TreasuryOutcome::TargetGone);
        }
    }

    // Состав роли читается внутри транзакции: итог списания обязан совпасть с
    // числом строк выплат, даже если роль кому-то выдали секунду назад.
    let recipients = match &mv.target {
        TreasuryTarget::User(name) => vec![name.clone()],
        TreasuryTarget::Server { .. } => Vec::new(),
        TreasuryTarget::Role { server_id, role_id, .. } => {
            let names = role_recipients(conn, server_id, role_id).await?;
            if names.is_empty() {
                return Ok(TreasuryOutcome::NoRecipients);
            }
            names
        }
    };
    let shares = recipients.len().max(1) as i64;
    let Some(total) = mv
        .amount
        .checked_mul(shares)
        .filter(|total| *total <= ZALICOIN_TOTAL_SUPPLY)
    else {
        return Ok(TreasuryOutcome::InsufficientFunds);
    };

    let debited = match &mv.source {
        TreasurySource::User(name) => {
            sqlx::query("UPDATE coin_balances SET balance = balance - ? WHERE username = ? AND balance >= ?")
                .bind(total)
                .bind(name)
                .bind(total)
                .execute(&mut *conn)
                .await?
        }
        TreasurySource::Server { id, .. } => {
            sqlx::query("UPDATE server_treasuries SET balance = balance - ? WHERE server_id = ? AND balance >= ?")
                .bind(total)
                .bind(id)
                .bind(total)
                .execute(&mut *conn)
                .await?
        }
    };
    if debited.rows_affected() != 1 {
        return Ok(TreasuryOutcome::InsufficientFunds);
    }

    match &mv.target {
        TreasuryTarget::Server { id, .. } => credit_treasury(conn, id, total).await?,
        TreasuryTarget::User(_) | TreasuryTarget::Role { .. } => {
            for name in &recipients {
                credit_user(conn, name, mv.amount).await?;
            }
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    insert_operation(
        conn,
        OperationInsert {
            id: &id,
            actor: &mv.actor,
            source: mv.source_columns(),
            target: mv.target_columns(),
            amount: mv.amount,
            recipients: recipients.len() as i64,
            total,
            note: &mv.note,
            idempotency_key: &mv.idempotency_key,
            created_at: &now,
        },
    )
    .await?;
    if let TreasurySource::Server { id: server_id, .. } = &mv.source {
        for name in &recipients {
            insert_payout(conn, &id, name, server_id, mv.amount, &now).await?;
        }
    }
    Ok(TreasuryOutcome::Done { id, recipients })
}

/// Удаление сервера не должно сжигать его казну: остаток уходит владельцу в той же
/// транзакции, что удаляет сервер, и появляется у него в «От серверов».
pub(crate) async fn refund_treasury_to_owner(
    conn: &mut SqliteConnection,
    server_id: &str,
    server_name: &str,
    owner: &str,
) -> Result<i64, sqlx::Error> {
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM server_treasuries WHERE server_id = ?")
        .bind(server_id)
        .fetch_optional(&mut *conn)
        .await?
        .unwrap_or(0);
    sqlx::query("DELETE FROM server_treasuries WHERE server_id = ?")
        .bind(server_id)
        .execute(&mut *conn)
        .await?;
    if balance <= 0 {
        return Ok(0);
    }
    credit_user(conn, owner, balance).await?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let key = format!("server-deleted:{}", server_id);
    insert_operation(
        conn,
        OperationInsert {
            id: &id,
            actor: owner,
            source: ("server", server_id, server_name),
            target: ("user", owner, owner),
            amount: balance,
            recipients: 1,
            total: balance,
            note: "Сервер удалён — остаток казны возвращён владельцу",
            idempotency_key: &key,
            created_at: &now,
        },
    )
    .await?;
    insert_payout(conn, &id, owner, server_id, balance, &now).await?;
    Ok(balance)
}

// ============================================================================
// Представления
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TreasuryOperationView {
    id: String,
    actor: String,
    /// `user` | `server`.
    source_kind: String,
    source_id: String,
    source_name: String,
    /// `user` | `server` | `role`.
    target_kind: String,
    target_id: String,
    target_name: String,
    amount: i64,
    recipients: i64,
    total: i64,
    note: String,
    created_at: String,
}

type OperationRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    String,
    String,
);

fn operation_view(row: OperationRow) -> TreasuryOperationView {
    let (
        id,
        actor,
        source_kind,
        source_id,
        source_name,
        target_kind,
        target_id,
        target_name,
        amount,
        recipients,
        total,
        note,
        created_at,
    ) = row;
    TreasuryOperationView {
        id,
        actor,
        source_kind,
        source_id,
        source_name,
        target_kind,
        target_id,
        target_name,
        amount,
        recipients,
        total,
        note,
        created_at,
    }
}

async fn load_operation(pool: &SqlitePool, id: &str) -> Result<Option<TreasuryOperationView>, sqlx::Error> {
    let row: Option<OperationRow> = sqlx::query_as(&format!(
        "SELECT {} FROM treasury_operations WHERE id = ? LIMIT 1",
        OPERATION_COLUMNS
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(operation_view))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerPayoutView {
    operation_id: String,
    server_id: String,
    /// Имя сервера на момент выплаты.
    server_name: String,
    amount: i64,
    actor: String,
    /// Роль, если выплата шла всем участникам с ролью.
    role_name: Option<String>,
    note: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreasuryRoleView {
    role_id: String,
    name: String,
    members: i64,
}

async fn treasury_roles(pool: &SqlitePool, server_id: &str) -> Result<Vec<TreasuryRoleView>, sqlx::Error> {
    let everyone: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM (
            SELECT m.username FROM server_members m JOIN users u ON u.username = m.username
            WHERE m.server_id = ?
            UNION
            SELECT s.owner FROM servers s JOIN users u ON u.username = s.owner WHERE s.id = ?
         )",
    )
    .bind(server_id)
    .bind(server_id)
    .fetch_one(pool)
    .await?;
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT m.role, COUNT(*) FROM server_members m JOIN users u ON u.username = m.username
         WHERE m.server_id = ? GROUP BY m.role",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;
    let count_of = |role_id: &str| {
        counts
            .iter()
            .find(|(role, _)| role == role_id)
            .map(|(_, count)| *count)
            .unwrap_or(0)
    };
    let stored: Vec<(String, String)> = sqlx::query_as(
        "SELECT role_id, name FROM server_roles
         WHERE server_id = ? AND role_id != 'owner'
         ORDER BY position ASC, name ASC",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;

    let mut roles = vec![TreasuryRoleView {
        role_id: TREASURY_ALL_MEMBERS.to_string(),
        name: "Все участники".to_string(),
        members: everyone,
    }];
    let mut seen: HashSet<String> = HashSet::new();
    for (role_id, name) in stored {
        seen.insert(role_id.clone());
        let members = count_of(&role_id);
        roles.push(TreasuryRoleView { role_id, name, members });
    }
    for (role_id, name) in [("admin", "Админ"), ("member", "Участник")] {
        if !seen.contains(role_id) {
            roles.push(TreasuryRoleView {
                role_id: role_id.to_string(),
                name: name.to_string(),
                members: count_of(role_id),
            });
        }
    }
    Ok(roles)
}

// ============================================================================
// Рассылка
// ============================================================================

/// Новый баланс казны — подключённым участникам сервера: у кого открыта казна,
/// тот видит изменение сразу.
async fn broadcast_treasury_balance(state: &Arc<AppState>, server_id: &str) {
    let balance = match load_treasury_balance(&state.db, server_id).await {
        Ok(balance) => balance,
        Err(e) => {
            error!("Ошибка чтения казны сервера {}: {}", server_id, e);
            return;
        }
    };
    let members: Vec<String> = match sqlx::query_scalar(
        "SELECT username FROM server_members WHERE server_id = ?
         UNION
         SELECT owner FROM servers WHERE id = ?",
    )
    .bind(server_id)
    .bind(server_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(members) => members,
        Err(e) => {
            error!("Ошибка чтения участников для казны сервера {}: {}", server_id, e);
            return;
        }
    };
    let payload = serde_json::json!({
        "type": "server_treasury_updated",
        "serverId": server_id,
        "balance": balance,
    })
    .to_string();
    for name in members {
        if state.user_connections.contains_key(&name) {
            send_payload_to_user(state, &name, payload.clone(), "server_treasury_updated").await;
        }
    }
}

async fn notify_server_payout(
    state: &Arc<AppState>,
    operation: &TreasuryOperationView,
    server_id: &str,
    recipients: &[String],
) {
    let payout = ServerPayoutView {
        operation_id: operation.id.clone(),
        server_id: server_id.to_string(),
        server_name: operation.source_name.clone(),
        amount: operation.amount,
        actor: operation.actor.clone(),
        role_name: (operation.target_kind == "role").then(|| operation.target_name.clone()),
        note: operation.note.clone(),
        created_at: operation.created_at.clone(),
    };
    let payload = serde_json::json!({ "type": "coin_server_payout", "payout": payout }).to_string();
    for name in recipients {
        send_payload_to_user(state, name, payload.clone(), "coin_server_payout").await;
    }
}

async fn execute_treasury_move(state: &Arc<AppState>, mv: TreasuryMove) -> Response {
    let tx_move = mv.clone();
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result = apply_treasury_move(&mut conn, &tx_move).await;
        (conn, result)
    })
    .await;

    let (operation_id, status, recipients) = match outcome {
        Ok(TreasuryOutcome::Done { id, recipients }) => (id, StatusCode::CREATED, Some(recipients)),
        Ok(TreasuryOutcome::Replayed(id)) => (id, StatusCode::OK, None),
        Ok(TreasuryOutcome::InsufficientFunds) => {
            let message = match mv.source {
                TreasurySource::User(_) => "Недостаточно ZaliCoin на вашем балансе",
                TreasurySource::Server { .. } => "Недостаточно ZaliCoin в казне",
            };
            return treasury_error(StatusCode::BAD_REQUEST, "insufficient_funds", message);
        }
        Ok(TreasuryOutcome::NoRecipients) => {
            return treasury_error(StatusCode::BAD_REQUEST, "no_recipients", "У этой роли пока нет участников")
        }
        Ok(TreasuryOutcome::TargetGone) => {
            return treasury_error(StatusCode::NOT_FOUND, "not_found", "Сервер не найден")
        }
        Err(e) => {
            warn!("Ошибка операции казны actor={}: {}", mv.actor, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let operation = match load_operation(&state.db, &operation_id).await {
        Ok(Some(operation)) => operation,
        Ok(None) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(e) => {
            error!("Ошибка чтения операции казны {}: {}", operation_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Some(recipients) = recipients {
        info!(
            "ZaliCoin treasury op id={} actor={} {}:{} -> {}:{} amount={} recipients={} total={}",
            operation.id,
            operation.actor,
            operation.source_kind,
            operation.source_id,
            operation.target_kind,
            operation.target_id,
            operation.amount,
            operation.recipients,
            operation.total
        );
        for server_id in mv.touched_servers() {
            broadcast_treasury_balance(state, &server_id).await;
        }
        if let TreasurySource::Server { id, .. } = &mv.source {
            if !recipients.is_empty() {
                notify_server_payout(state, &operation, id, &recipients).await;
            }
        }
    }

    let balance = load_user_balance(&state.db, &mv.actor).await;
    let mut treasuries = Vec::new();
    for server_id in mv.touched_servers() {
        let treasury = load_treasury_balance(&state.db, &server_id).await.unwrap_or(0);
        treasuries.push(serde_json::json!({ "serverId": server_id, "balance": treasury }));
    }
    (
        status,
        Json(serde_json::json!({
            "operation": operation,
            "balance": balance,
            "treasuries": treasuries,
        })),
    )
        .into_response()
}

// ============================================================================
// Хендлеры
// ============================================================================

/// Казна сервера: баланс и история видны всем участникам, роли и список
/// участников (для выплат) — только тем, кто казной распоряжается.
pub(crate) async fn get_server_treasury(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
) -> impl IntoResponse {
    let server_id = trim_limited(&server_id, 128);
    let server = match get_server_accessibility(&state.db, &server_id).await {
        Ok(Some(server)) => server,
        Ok(None) => return treasury_error(StatusCode::NOT_FOUND, "not_found", "Сервер не найден"),
        Err(e) => {
            error!("Ошибка чтения сервера {} для казны: {}", server_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let result: Result<Response, sqlx::Error> = async {
        if get_server_member_role(&state.db, &server_id, &username).await?.is_none() {
            return Ok(treasury_error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Казна видна только участникам сервера",
            ));
        }
        let can_manage = can_manage_treasury(&state.db, &server_id, &username).await?;
        let balance = load_treasury_balance(&state.db, &server_id).await?;
        let rows: Vec<OperationRow> = sqlx::query_as(&format!(
            "SELECT {} FROM treasury_operations
             WHERE (source_kind = 'server' AND source_id = ?)
                OR (target_kind = 'server' AND target_id = ?)
             ORDER BY created_at DESC
             LIMIT ?",
            OPERATION_COLUMNS
        ))
        .bind(&server_id)
        .bind(&server_id)
        .bind(TREASURY_HISTORY_LIMIT)
        .fetch_all(&state.db)
        .await?;
        let operations: Vec<TreasuryOperationView> = rows.into_iter().map(operation_view).collect();
        let (roles, members) = if can_manage {
            let members: Vec<String> = sqlx::query_scalar(
                "SELECT m.username FROM server_members m JOIN users u ON u.username = m.username
                 WHERE m.server_id = ? ORDER BY m.username LIMIT ?",
            )
            .bind(&server_id)
            .bind(TREASURY_MEMBERS_LIMIT)
            .fetch_all(&state.db)
            .await?;
            (treasury_roles(&state.db, &server_id).await?, members)
        } else {
            (Vec::new(), Vec::new())
        };
        Ok(Json(serde_json::json!({
            "serverId": server.id,
            "name": server.name,
            "balance": balance,
            "canManage": can_manage,
            "operations": operations,
            "roles": roles,
            "members": members,
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(|e| {
        error!("Ошибка чтения казны сервера {}: {}", server_id, e);
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct TreasuryDepositRequest {
    /// `user` — свои ZaliCoin, `server` — казна другого сервера.
    source: String,
    #[serde(rename = "sourceServerId", default)]
    source_server_id: Option<String>,
    amount: i64,
    #[serde(default)]
    note: Option<String>,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
}

pub(crate) async fn deposit_to_treasury(
    AuthenticatedUser(actor): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Json(body): Json<TreasuryDepositRequest>,
) -> impl IntoResponse {
    let server_id = trim_limited(&server_id, 128);
    let idempotency_key = trim_limited(&body.idempotency_key, 128);
    if idempotency_key.is_empty() {
        return treasury_error(StatusCode::BAD_REQUEST, "bad_request", "Ключ операции обязателен");
    }
    if body.amount <= 0 {
        return treasury_error(StatusCode::BAD_REQUEST, "bad_amount", "Сумма должна быть больше нуля");
    }

    let result: Result<Response, sqlx::Error> = async {
        let Some(target) = get_server_accessibility(&state.db, &server_id).await? else {
            return Ok(treasury_error(StatusCode::NOT_FOUND, "not_found", "Сервер не найден"));
        };
        if get_server_member_role(&state.db, &server_id, &actor).await?.is_none() {
            return Ok(treasury_error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Пополнять казну могут только участники сервера",
            ));
        }
        let source = match body.source.as_str() {
            "user" => TreasurySource::User(actor.clone()),
            "server" => {
                let source_id = trim_limited(body.source_server_id.as_deref().unwrap_or(""), 128);
                if source_id.is_empty() || source_id == server_id {
                    return Ok(treasury_error(
                        StatusCode::BAD_REQUEST,
                        "bad_source",
                        "Выберите казну другого сервера",
                    ));
                }
                let Some(source) = get_server_accessibility(&state.db, &source_id).await? else {
                    return Ok(treasury_error(StatusCode::NOT_FOUND, "not_found", "Сервер-источник не найден"));
                };
                if !can_manage_treasury(&state.db, &source_id, &actor).await? {
                    return Ok(treasury_error(
                        StatusCode::FORBIDDEN,
                        "forbidden",
                        "Нет права распоряжаться казной этого сервера",
                    ));
                }
                TreasurySource::Server { id: source.id, name: source.name }
            }
            _ => {
                return Ok(treasury_error(StatusCode::BAD_REQUEST, "bad_source", "Неизвестный источник"));
            }
        };
        let mv = TreasuryMove {
            actor: actor.clone(),
            source,
            target: TreasuryTarget::Server { id: target.id, name: target.name },
            amount: body.amount,
            note: clean_note(body.note.as_deref()),
            idempotency_key,
        };
        Ok(execute_treasury_move(&state, mv).await)
    }
    .await;
    result.unwrap_or_else(|e| {
        error!("Ошибка пополнения казны {} actor={}: {}", server_id, actor, e);
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct TreasuryPayoutRequest {
    /// `user` | `server` | `role`.
    target: String,
    /// Имя пользователя, id сервера или id роли (`*` — все участники).
    to: String,
    /// На одного получателя.
    amount: i64,
    #[serde(default)]
    note: Option<String>,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
}

pub(crate) async fn payout_from_treasury(
    AuthenticatedUser(actor): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Json(body): Json<TreasuryPayoutRequest>,
) -> impl IntoResponse {
    let server_id = trim_limited(&server_id, 128);
    let idempotency_key = trim_limited(&body.idempotency_key, 128);
    let to = trim_limited(&body.to, 128);
    if idempotency_key.is_empty() {
        return treasury_error(StatusCode::BAD_REQUEST, "bad_request", "Ключ операции обязателен");
    }
    if to.is_empty() {
        return treasury_error(StatusCode::BAD_REQUEST, "bad_target", "Укажите получателя");
    }
    if body.amount <= 0 {
        return treasury_error(StatusCode::BAD_REQUEST, "bad_amount", "Сумма должна быть больше нуля");
    }

    let result: Result<Response, sqlx::Error> = async {
        let Some(server) = get_server_accessibility(&state.db, &server_id).await? else {
            return Ok(treasury_error(StatusCode::NOT_FOUND, "not_found", "Сервер не найден"));
        };
        if !can_manage_treasury(&state.db, &server_id, &actor).await? {
            return Ok(treasury_error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Нет права распоряжаться казной этого сервера",
            ));
        }
        let target = match body.target.as_str() {
            "user" => {
                let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = ?")
                    .bind(&to)
                    .fetch_one(&state.db)
                    .await?;
                if exists == 0 {
                    return Ok(treasury_error(StatusCode::NOT_FOUND, "not_found", "Пользователь не найден"));
                }
                TreasuryTarget::User(to)
            }
            "server" => {
                if to == server_id {
                    return Ok(treasury_error(
                        StatusCode::BAD_REQUEST,
                        "bad_target",
                        "Нельзя перевести казну самой себе",
                    ));
                }
                let Some(target) = get_server_accessibility(&state.db, &to).await? else {
                    return Ok(treasury_error(StatusCode::NOT_FOUND, "not_found", "Сервер не найден"));
                };
                TreasuryTarget::Server { id: target.id, name: target.name }
            }
            "role" => {
                let Some(name) = treasury_role_name(&state.db, &server_id, &to).await? else {
                    return Ok(treasury_error(StatusCode::NOT_FOUND, "not_found", "Роль не найдена"));
                };
                TreasuryTarget::Role { server_id: server_id.clone(), role_id: to, name }
            }
            _ => {
                return Ok(treasury_error(StatusCode::BAD_REQUEST, "bad_target", "Неизвестный получатель"));
            }
        };
        let mv = TreasuryMove {
            actor: actor.clone(),
            source: TreasurySource::Server { id: server.id, name: server.name },
            target,
            amount: body.amount,
            note: clean_note(body.note.as_deref()),
            idempotency_key,
        };
        Ok(execute_treasury_move(&state, mv).await)
    }
    .await;
    result.unwrap_or_else(|e| {
        error!("Ошибка выплаты из казны {} actor={}: {}", server_id, actor, e);
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    })
}

/// Казны, которыми пользователь распоряжается, — источники для пополнения чужой
/// казны деньгами сервера.
pub(crate) async fn get_managed_treasuries(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let result: Result<Vec<serde_json::Value>, sqlx::Error> = async {
        let servers: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, name FROM servers
             WHERE owner = ?
                OR EXISTS (SELECT 1 FROM server_members m WHERE m.server_id = servers.id AND m.username = ?)
             ORDER BY created_at ASC, name ASC",
        )
        .bind(&username)
        .bind(&username)
        .fetch_all(&state.db)
        .await?;
        let mut out = Vec::new();
        for (id, name) in servers {
            if can_manage_treasury(&state.db, &id, &username).await? {
                let balance = load_treasury_balance(&state.db, &id).await?;
                out.push(serde_json::json!({ "serverId": id, "name": name, "balance": balance }));
            }
        }
        Ok(out)
    }
    .await;
    match result {
        Ok(treasuries) => Json(serde_json::json!({ "treasuries": treasuries })).into_response(),
        Err(e) => {
            error!("Ошибка чтения управляемых казн {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Выплаты с серверов, пришедшие пользователю, — раздел «От серверов».
pub(crate) async fn get_my_server_payouts(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let rows = sqlx::query_as::<_, (String, String, String, i64, String, String, String, String, String)>(
        "SELECT p.operation_id, p.server_id, o.source_name, p.amount, o.actor, o.target_kind, o.target_name, o.note, p.created_at
         FROM treasury_payouts p
         JOIN treasury_operations o ON o.id = p.operation_id
         WHERE p.username = ?
         ORDER BY p.created_at DESC
         LIMIT ?",
    )
    .bind(&username)
    .bind(SERVER_PAYOUTS_LIMIT)
    .fetch_all(&state.db)
    .await;
    match rows {
        Ok(rows) => {
            let payouts: Vec<ServerPayoutView> = rows
                .into_iter()
                .map(
                    |(operation_id, server_id, server_name, amount, actor, target_kind, target_name, note, created_at)| {
                        ServerPayoutView {
                            operation_id,
                            server_id,
                            server_name,
                            amount,
                            actor,
                            role_name: (target_kind == "role").then_some(target_name),
                            note,
                            created_at,
                        }
                    },
                )
                .collect();
            Json(serde_json::json!({ "payouts": payouts })).into_response()
        }
        Err(e) => {
            error!("Ошибка чтения выплат с серверов {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
