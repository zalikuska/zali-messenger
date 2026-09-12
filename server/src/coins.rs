//! ZaliCoin: a fixed-supply (100 000) in-app currency ledger. Coins only ever
//! move between existing users via `transfer_coins` and channel gift cards
//! (`coin_gifts`) — nothing mints or burns them after `seed_zalicoin` grants
//! the whole supply to `zalikus` on first run (see `storage.rs`), so
//! `SUM(balance)` in `coin_balances` plus everything on hold in active gift
//! cards is invariant.
//!
//! Anti-dupe: every transfer is wrapped in a single `BEGIN IMMEDIATE`
//! transaction (balance check + both-side balance mutation + ledger insert),
//! so concurrent requests from the same sender can't race past the balance
//! check. Retries are made safe by a client-supplied idempotency key: it's
//! stored per (sender, key) with a UNIQUE constraint, so a resubmitted
//! request (e.g. a network retry after the response was lost) is detected
//! and short-circuited to the current balance instead of transferring twice.
//!
//! Gift cards («ZaliCoin-карточка» в канале): создание снимает
//! `amount * claims` с баланса отправителя на удержание, каждая активация
//! переводит `amount` с удержания активировавшему, отмена возвращает
//! отправителю только неактивированные заряды. Всё это — одна `BEGIN IMMEDIATE`
//! транзакция на операцию, поэтому два одновременных «Получить» на карточке с
//! одним зарядом не могут оба пройти проверку остатка; сверху это же держат
//! условный `UPDATE ... WHERE claimed_count < total_claims` и первичный ключ
//! `(gift_id, username)`, который и есть «один заряд на аккаунт».

use crate::{
    can_access_channel, channel_belongs_to_server, get_server_accessibility,
    get_server_member_role, resolve_server_message_viewers, send_payload_to_user, trim_limited,
    AppState, AuthenticatedUser,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{pool::PoolConnection, QueryBuilder, Sqlite, SqlitePool};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::Arc,
};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub(crate) struct CoinBalanceResponse {
    balance: i64,
    /// Своё на удержании: неактивированные заряды активных карточек.
    held: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct CoinTransferResponse {
    balance: i64,
    /// Id записи в `coin_transactions` — карточка перевода в личном чате ссылается
    /// на него, чтобы получатель мог сверить перевод с сервером, а не верить тексту.
    #[serde(rename = "transactionId")]
    transaction_id: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CoinHolder {
    username: String,
    balance: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct CoinDistributionResponse {
    #[serde(rename = "totalSupply")]
    total_supply: i64,
    holders: Vec<CoinHolder>,
    /// Всё, что сейчас лежит на удержании в активных карточках, — отдельной
    /// строкой, иначе эти монеты выглядели бы в статистике «нераспределёнными».
    held: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CoinTransferRequest {
    to: String,
    amount: i64,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
    /// clientId сообщения-карточки, которое клиент отправит в чат об этом переводе.
    /// Квитанция подтверждает только сообщение с этим clientId, а два сообщения с
    /// одним client_id в одну переписку сервер не пускает (idx_messages_client_scope),
    /// так что повторить подтверждённую карточку нельзя — ни в загруженной истории,
    /// ни за её пределами, ни подкрутив часы.
    #[serde(rename = "cardClientId", default)]
    card_client_id: Option<String>,
}

pub(crate) const ZALICOIN_TOTAL_SUPPLY: i64 = 100_000;
/// Потолок зарядов у одной карточки.
pub(crate) const MAX_COIN_GIFT_CLAIMS: i64 = 100;
const MAX_COIN_GIFT_LOOKUP: usize = 50;

async fn load_balance(pool: &SqlitePool, username: &str) -> i64 {
    sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await
        .unwrap_or(Some(0))
        .unwrap_or(0)
}

async fn load_held_by(pool: &SqlitePool, username: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount * (total_claims - claimed_count)), 0)
         FROM coin_gifts WHERE sender = ? AND status = 'active'",
    )
    .bind(username)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
}

pub(crate) async fn get_coin_balance(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let balance = load_balance(&state.db, &username).await;
    let held = load_held_by(&state.db, &username).await;
    Json(CoinBalanceResponse { balance, held }).into_response()
}

pub(crate) async fn get_coin_distribution(
    _auth: AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let rows = sqlx::query_as::<_, (String, i64)>(
        "SELECT username, balance FROM coin_balances WHERE balance > 0 ORDER BY balance DESC",
    )
    .fetch_all(&state.db)
    .await;
    let held = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(amount * (total_claims - claimed_count)), 0)
         FROM coin_gifts WHERE status = 'active'",
    )
    .fetch_one(&state.db)
    .await;

    match (rows, held) {
        (Ok(rows), Ok(held)) => Json(CoinDistributionResponse {
            total_supply: ZALICOIN_TOTAL_SUPPLY,
            holders: rows
                .into_iter()
                .map(|(username, balance)| CoinHolder { username, balance })
                .collect(),
            held,
        })
        .into_response(),
        (Err(e), _) | (_, Err(e)) => {
            error!("Ошибка чтения распределения ZaliCoin: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn transfer_coins(
    AuthenticatedUser(sender): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<CoinTransferRequest>,
) -> impl IntoResponse {
    let to = trim_limited(&body.to, 64);
    let idempotency_key = trim_limited(&body.idempotency_key, 128);
    let amount = body.amount;
    // Пустая строка (а не NULL) — «карточки не будет»: перевод из кошелька. NULL
    // остаётся только у переводов, сделанных до появления привязки.
    let card_client_id = trim_limited(body.card_client_id.as_deref().unwrap_or(""), 128);

    if to.is_empty() || idempotency_key.is_empty() {
        return (StatusCode::BAD_REQUEST, "Получатель и ключ операции обязательны").into_response();
    }
    if amount <= 0 {
        return (StatusCode::BAD_REQUEST, "Сумма перевода должна быть положительной").into_response();
    }
    if to == sender {
        return (StatusCode::BAD_REQUEST, "Нельзя перевести ZaliCoin самому себе").into_response();
    }

    let recipient_exists: i64 = match sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = ?")
        .bind(&to)
        .fetch_one(&state.db)
        .await
    {
        Ok(count) => count,
        Err(e) => {
            error!("Ошибка проверки получателя ZaliCoin {}: {}", to, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if recipient_exists == 0 {
        return (StatusCode::NOT_FOUND, "Получатель не найден").into_response();
    }

    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => {
            error!("Ошибка получения соединения для transfer_coins: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Err(e) = sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await {
        error!("Ошибка начала транзакции transfer_coins: {}", e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    // Sentinel `Ok` values distinguish outcomes without invoking `?` past
    // COMMIT: -1 = already-applied retry (idempotent no-op), -2 = insufficient funds.
    let transfer_result: Result<(i64, String), sqlx::Error> = async {
        let already_applied: Option<String> = sqlx::query_scalar(
            "SELECT id FROM coin_transactions WHERE from_user = ? AND idempotency_key = ?",
        )
        .bind(&sender)
        .bind(&idempotency_key)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(existing_id) = already_applied {
            return Ok((-1, existing_id));
        }

        let sender_balance: i64 =
            sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
                .bind(&sender)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or(0);

        if sender_balance < amount {
            return Ok((-2, String::new()));
        }

        sqlx::query("UPDATE coin_balances SET balance = balance - ? WHERE username = ?")
            .bind(amount)
            .bind(&sender)
            .execute(&mut *conn)
            .await?;

        sqlx::query(
            "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
             ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
        )
        .bind(&to)
        .bind(amount)
        .execute(&mut *conn)
        .await?;

        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO coin_transactions (id, from_user, to_user, amount, idempotency_key, card_client_id)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&sender)
        .bind(&to)
        .bind(amount)
        .bind(&idempotency_key)
        .bind(&card_client_id)
        .execute(&mut *conn)
        .await?;

        let new_balance = sender_balance - amount;
        sqlx::query("COMMIT").execute(&mut *conn).await?;
        Ok((new_balance, id))
    }
    .await;

    match transfer_result {
        Ok((-2, _)) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            (StatusCode::BAD_REQUEST, "Недостаточно ZaliCoin для перевода").into_response()
        }
        Ok((-1, transaction_id)) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            let balance = load_balance(&state.db, &sender).await;
            Json(CoinTransferResponse { balance, transaction_id }).into_response()
        }
        Ok((new_balance, transaction_id)) => Json(CoinTransferResponse {
            balance: new_balance,
            transaction_id,
        })
        .into_response(),
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            warn!("Ошибка перевода ZaliCoin from={} to={}: {}", sender, to, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Квитанция перевода для карточки в личном чате. Видна только двум сторонам
/// перевода: всем остальным — 404, как будто перевода нет вовсе.
pub(crate) async fn get_coin_transfer(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> impl IntoResponse {
    let transfer_id = trim_limited(&transfer_id, 64);
    let row = sqlx::query_as::<_, (String, String, String, i64, String, Option<String>)>(
        "SELECT id, from_user, to_user, amount, CAST(created_at AS TEXT), card_client_id
         FROM coin_transactions WHERE id = ? LIMIT 1",
    )
    .bind(&transfer_id)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some((id, from, to, amount, created_at, card_client_id))) if from == username || to == username => {
            Json(serde_json::json!({
                "id": id,
                "from": from,
                "to": to,
                "amount": amount,
                "createdAt": created_at,
                "cardClientId": card_client_id,
            }))
            .into_response()
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            error!("Ошибка чтения перевода ZaliCoin {}: {}", transfer_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ============================================================================
// Gift cards
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoinGiftClaimView {
    username: String,
    amount: i64,
    claimed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoinGiftView {
    id: String,
    sender: String,
    server_id: String,
    channel_id: String,
    /// Сколько получает каждый активировавший.
    amount: i64,
    total_claims: i64,
    claimed_count: i64,
    /// `active` | `exhausted` (все заряды активированы) | `cancelled`.
    status: String,
    held: i64,
    refunded: i64,
    created_at: String,
    finished_at: Option<String>,
    claims: Vec<CoinGiftClaimView>,
}

type CoinGiftRow = (
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    String,
    String,
    Option<String>,
);

fn coin_gift_view(row: CoinGiftRow, claims: Vec<CoinGiftClaimView>) -> CoinGiftView {
    let (id, sender, server_id, channel_id, amount, total_claims, claimed_count, status, created_at, finished_at) =
        row;
    let remaining = (total_claims - claimed_count).max(0);
    let (held, refunded) = match status.as_str() {
        "active" => (amount * remaining, 0),
        "cancelled" => (0, amount * remaining),
        _ => (0, 0),
    };
    CoinGiftView {
        id,
        sender,
        server_id,
        channel_id,
        amount,
        total_claims,
        claimed_count,
        status,
        held,
        refunded,
        created_at,
        finished_at,
        claims,
    }
}

/// Загружает карточки вместе с активациями, сохраняя порядок `ids`;
/// несуществующие молча пропускаются.
async fn load_coin_gifts(pool: &SqlitePool, ids: &[String]) -> Result<Vec<CoinGiftView>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut gifts_query = QueryBuilder::<Sqlite>::new(
        "SELECT id, sender, server_id, channel_id, amount, total_claims, claimed_count, status, created_at, finished_at
         FROM coin_gifts WHERE id IN (",
    );
    let mut separated = gifts_query.separated(", ");
    for id in ids {
        separated.push_bind(id);
    }
    separated.push_unseparated(")");
    let rows: Vec<CoinGiftRow> = gifts_query.build_query_as().fetch_all(pool).await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let mut claims_query = QueryBuilder::<Sqlite>::new(
        "SELECT gift_id, username, amount, claimed_at FROM coin_gift_claims WHERE gift_id IN (",
    );
    let mut separated = claims_query.separated(", ");
    for row in &rows {
        separated.push_bind(&row.0);
    }
    separated.push_unseparated(") ORDER BY claimed_at ASC, username ASC");
    let claim_rows: Vec<(String, String, i64, String)> =
        claims_query.build_query_as().fetch_all(pool).await?;

    let mut claims_by_gift: HashMap<String, Vec<CoinGiftClaimView>> = HashMap::new();
    for (gift_id, username, amount, claimed_at) in claim_rows {
        claims_by_gift.entry(gift_id).or_default().push(CoinGiftClaimView {
            username,
            amount,
            claimed_at,
        });
    }

    let mut by_id: HashMap<String, CoinGiftView> = rows
        .into_iter()
        .map(|row| {
            let claims = claims_by_gift.remove(&row.0).unwrap_or_default();
            (row.0.clone(), coin_gift_view(row, claims))
        })
        .collect();
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

async fn load_coin_gift(pool: &SqlitePool, id: &str) -> Result<Option<CoinGiftView>, sqlx::Error> {
    Ok(load_coin_gifts(pool, &[id.to_string()]).await?.pop())
}

fn coin_gift_error(status: StatusCode, code: &str, message: &str, gift: Option<CoinGiftView>) -> Response {
    (
        status,
        Json(serde_json::json!({ "code": code, "message": message, "gift": gift })),
    )
        .into_response()
}

/// Результат транзакции: коммитить ли её. Отказы (нет денег, уже активировано)
/// откатываются, чтобы не оставлять после себя ни одной частичной записи.
trait CoinTxOutcome {
    fn commits(&self) -> bool;
}

/// `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` в отдельной задаче.
///
/// Отдельная задача — не украшение: axum роняет future хендлера, когда клиент
/// рвёт соединение, и такой drop между `BEGIN IMMEDIATE` и `COMMIT` вернул бы в
/// пул соединение с удерживаемой блокировкой записи sqlite (см. hash_chain.rs).
async fn run_immediate_tx<T, F, Fut>(pool: SqlitePool, body: F) -> Result<T, sqlx::Error>
where
    T: CoinTxOutcome + Send + 'static,
    F: FnOnce(PoolConnection<Sqlite>) -> Fut + Send + 'static,
    Fut: Future<Output = (PoolConnection<Sqlite>, Result<T, sqlx::Error>)> + Send + 'static,
{
    tokio::spawn(async move {
        let mut conn = pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        let (mut conn, result) = body(conn).await;
        match result {
            Ok(outcome) if outcome.commits() => {
                if let Err(e) = sqlx::query("COMMIT").execute(&mut *conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(e);
                }
                Ok(outcome)
            }
            other => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                other
            }
        }
    })
    .await
    .unwrap_or_else(|e| {
        Err(sqlx::Error::Protocol(format!(
            "транзакция ZaliCoin не завершилась: {}",
            e
        )))
    })
}

/// Рассылает актуальное состояние карточки всем подключённым, кто видит канал,
/// плюс отправителю и активировавшим — они должны увидеть итог своей операции,
/// даже если доступ к каналу у них с тех пор отняли.
async fn broadcast_coin_gift(state: &Arc<AppState>, gift: &CoinGiftView) {
    let candidates: Vec<String> = state
        .user_connections
        .iter()
        .map(|entry| entry.key().clone())
        .collect();
    if candidates.is_empty() {
        return;
    }
    let mut viewers = match get_server_accessibility(&state.db, &gift.server_id).await {
        Ok(Some(server)) => {
            match resolve_server_message_viewers(state, &server, &gift.channel_id, &candidates).await {
                Ok(allowed) => allowed,
                Err(e) => {
                    error!("Ошибка расчёта зрителей карточки ZaliCoin {}: {}", gift.id, e);
                    Vec::new()
                }
            }
        }
        Ok(None) => Vec::new(),
        Err(e) => {
            error!("Ошибка чтения сервера карточки ZaliCoin {}: {}", gift.id, e);
            Vec::new()
        }
    };
    let connected: HashSet<&str> = candidates.iter().map(String::as_str).collect();
    let mut seen: HashSet<String> = viewers.iter().cloned().collect();
    for name in std::iter::once(&gift.sender).chain(gift.claims.iter().map(|claim| &claim.username)) {
        if connected.contains(name.as_str()) && seen.insert(name.clone()) {
            viewers.push(name.clone());
        }
    }

    let payload = serde_json::json!({
        "type": "coin_gift_updated",
        "gift": gift,
    })
    .to_string();
    for viewer in viewers {
        send_payload_to_user(state, &viewer, payload.clone(), "coin_gift_updated").await;
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct CoinGiftCreateRequest {
    #[serde(rename = "serverId")]
    server_id: String,
    #[serde(rename = "channelId")]
    channel_id: String,
    /// Сумма на один заряд.
    amount: i64,
    /// Сколько человек смогут активировать.
    claims: i64,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
}

enum GiftCreateOutcome {
    Created(String),
    Replayed(String),
    InsufficientFunds,
}

impl CoinTxOutcome for GiftCreateOutcome {
    fn commits(&self) -> bool {
        matches!(self, GiftCreateOutcome::Created(_))
    }
}

pub(crate) async fn create_coin_gift(
    AuthenticatedUser(sender): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<CoinGiftCreateRequest>,
) -> impl IntoResponse {
    let server_id = trim_limited(&body.server_id, 128);
    let channel_id = trim_limited(&body.channel_id, 128);
    let idempotency_key = trim_limited(&body.idempotency_key, 128);
    let amount = body.amount;
    let claims = body.claims;

    if server_id.is_empty() || channel_id.is_empty() || idempotency_key.is_empty() {
        return coin_gift_error(StatusCode::BAD_REQUEST, "bad_request", "Канал и ключ операции обязательны", None);
    }
    if amount <= 0 {
        return coin_gift_error(StatusCode::BAD_REQUEST, "bad_amount", "Сумма должна быть больше нуля", None);
    }
    if !(1..=MAX_COIN_GIFT_CLAIMS).contains(&claims) {
        return coin_gift_error(
            StatusCode::BAD_REQUEST,
            "bad_claims",
            &format!("Число активаций — от 1 до {}", MAX_COIN_GIFT_CLAIMS),
            None,
        );
    }
    let Some(total) = amount.checked_mul(claims).filter(|total| *total <= ZALICOIN_TOTAL_SUPPLY) else {
        return coin_gift_error(StatusCode::BAD_REQUEST, "insufficient_funds", "Недостаточно ZaliCoin", None);
    };

    let allowed = match channel_belongs_to_server(&state.db, &server_id, &channel_id).await {
        Ok(true) => can_access_channel(&state.db, &server_id, &channel_id, &sender, "send").await,
        Ok(false) => Ok(false),
        Err(e) => Err(e),
    };
    match allowed {
        Ok(true) => {}
        Ok(false) => {
            return coin_gift_error(StatusCode::FORBIDDEN, "forbidden", "Нет доступа к этому каналу", None)
        }
        Err(e) => {
            error!("Ошибка проверки доступа к каналу для карточки ZaliCoin: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let tx_sender = sender.clone();
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result: Result<GiftCreateOutcome, sqlx::Error> = async {
            let existing: Option<String> = sqlx::query_scalar(
                "SELECT id FROM coin_gifts WHERE sender = ? AND idempotency_key = ?",
            )
            .bind(&tx_sender)
            .bind(&idempotency_key)
            .fetch_optional(&mut *conn)
            .await?;
            if let Some(id) = existing {
                return Ok(GiftCreateOutcome::Replayed(id));
            }

            let balance: i64 = sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
                .bind(&tx_sender)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or(0);
            if balance < total {
                return Ok(GiftCreateOutcome::InsufficientFunds);
            }

            sqlx::query("UPDATE coin_balances SET balance = balance - ? WHERE username = ?")
                .bind(total)
                .bind(&tx_sender)
                .execute(&mut *conn)
                .await?;

            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO coin_gifts
                    (id, sender, server_id, channel_id, amount, total_claims, claimed_count, status, idempotency_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)",
            )
            .bind(&id)
            .bind(&tx_sender)
            .bind(&server_id)
            .bind(&channel_id)
            .bind(amount)
            .bind(claims)
            .bind(&idempotency_key)
            .bind(Utc::now().to_rfc3339())
            .execute(&mut *conn)
            .await?;
            Ok(GiftCreateOutcome::Created(id))
        }
        .await;
        (conn, result)
    })
    .await;

    let (gift_id, status) = match outcome {
        Ok(GiftCreateOutcome::Created(id)) => (id, StatusCode::CREATED),
        Ok(GiftCreateOutcome::Replayed(id)) => (id, StatusCode::OK),
        Ok(GiftCreateOutcome::InsufficientFunds) => {
            return coin_gift_error(StatusCode::BAD_REQUEST, "insufficient_funds", "Недостаточно ZaliCoin", None)
        }
        Err(e) => {
            warn!("Ошибка создания карточки ZaliCoin sender={}: {}", sender, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let gift = match load_coin_gift(&state.db, &gift_id).await {
        Ok(Some(gift)) => gift,
        Ok(None) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(e) => {
            error!("Ошибка чтения карточки ZaliCoin {}: {}", gift_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if status == StatusCode::CREATED {
        info!(
            "ZaliCoin gift created id={} sender={} amount={} claims={}",
            gift.id, gift.sender, gift.amount, gift.total_claims
        );
    }
    let balance = load_balance(&state.db, &sender).await;
    let held = load_held_by(&state.db, &sender).await;
    (
        status,
        Json(serde_json::json!({ "gift": gift, "balance": balance, "held": held })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub(crate) struct CoinGiftLookupQuery {
    ids: Option<String>,
}

/// Состояние карточек, которые клиент сейчас рисует. Отдаёт только те, чей
/// канал запрашивающий видит (или которые он сам отправил) — остальные
/// пропускаются, будто их нет.
pub(crate) async fn lookup_coin_gifts(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Query(query): Query<CoinGiftLookupQuery>,
) -> impl IntoResponse {
    let mut seen = HashSet::new();
    let ids: Vec<String> = query
        .ids
        .unwrap_or_default()
        .split(',')
        .map(|id| id.trim())
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .filter(|id| seen.insert(id.to_string()))
        .take(MAX_COIN_GIFT_LOOKUP)
        .map(str::to_string)
        .collect();

    let gifts = match load_coin_gifts(&state.db, &ids).await {
        Ok(gifts) => gifts,
        Err(e) => {
            error!("Ошибка чтения карточек ZaliCoin: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let mut access: HashMap<(String, String), bool> = HashMap::new();
    let mut visible = Vec::with_capacity(gifts.len());
    for gift in gifts {
        if gift.sender == username {
            visible.push(gift);
            continue;
        }
        let key = (gift.server_id.clone(), gift.channel_id.clone());
        let allowed = match access.get(&key) {
            Some(allowed) => *allowed,
            None => {
                let allowed = can_access_channel(&state.db, &key.0, &key.1, &username, "view")
                    .await
                    .unwrap_or(false);
                access.insert(key, allowed);
                allowed
            }
        };
        if allowed {
            visible.push(gift);
        }
    }

    Json(serde_json::json!({ "gifts": visible })).into_response()
}

/// Активные карточки отправителя — чтобы удержанное всегда можно было вернуть,
/// даже если сообщение с карточкой не дошло до чата или было удалено.
pub(crate) async fn get_my_active_coin_gifts(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let ids: Vec<String> = match sqlx::query_scalar(
        "SELECT id FROM coin_gifts WHERE sender = ? AND status = 'active' ORDER BY created_at DESC LIMIT 100",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    {
        Ok(ids) => ids,
        Err(e) => {
            error!("Ошибка чтения активных карточек ZaliCoin {}: {}", username, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    match load_coin_gifts(&state.db, &ids).await {
        Ok(gifts) => Json(serde_json::json!({ "gifts": gifts })).into_response(),
        Err(e) => {
            error!("Ошибка чтения активных карточек ZaliCoin {}: {}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Строка карточки внутри транзакции: sender, amount, total_claims, claimed_count, status.
type CoinGiftTxRow = (String, i64, i64, i64, String);

async fn load_coin_gift_for_tx(
    conn: &mut PoolConnection<Sqlite>,
    gift_id: &str,
) -> Result<Option<CoinGiftTxRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT sender, amount, total_claims, claimed_count, status FROM coin_gifts WHERE id = ? LIMIT 1",
    )
    .bind(gift_id)
    .fetch_optional(&mut **conn)
    .await
}

enum GiftClaimOutcome {
    Claimed,
    NotFound,
    OwnGift,
    AlreadyClaimed,
    Exhausted,
    Cancelled,
}

impl CoinTxOutcome for GiftClaimOutcome {
    fn commits(&self) -> bool {
        matches!(self, GiftClaimOutcome::Claimed)
    }
}

pub(crate) async fn claim_coin_gift(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Path(gift_id): Path<String>,
) -> impl IntoResponse {
    let gift_id = trim_limited(&gift_id, 64);
    let gift = match load_coin_gift(&state.db, &gift_id).await {
        Ok(Some(gift)) => gift,
        Ok(None) => return coin_gift_error(StatusCode::NOT_FOUND, "not_found", "Карточка не найдена", None),
        Err(e) => {
            error!("Ошибка чтения карточки ZaliCoin {}: {}", gift_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if gift.sender == username {
        return coin_gift_error(
            StatusCode::FORBIDDEN,
            "own_gift",
            "Свою карточку активировать нельзя",
            Some(gift),
        );
    }

    // Активировать может только участник сервера, который видит канал: публичный
    // сервер показывает канал и гостям, но гость карточку не получает.
    let member = get_server_member_role(&state.db, &gift.server_id, &username)
        .await
        .map(|role| role.is_some());
    let allowed = match member {
        Ok(true) => can_access_channel(&state.db, &gift.server_id, &gift.channel_id, &username, "view").await,
        other => other,
    };
    match allowed {
        Ok(true) => {}
        Ok(false) => {
            return coin_gift_error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Карточку могут получить только участники канала",
                None,
            )
        }
        Err(e) => {
            error!("Ошибка проверки доступа к карточке ZaliCoin {}: {}", gift_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let tx_gift_id = gift_id.clone();
    let tx_username = username.clone();
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result: Result<GiftClaimOutcome, sqlx::Error> = async {
            let Some((sender, amount, _total, _claimed, status)) =
                load_coin_gift_for_tx(&mut conn, &tx_gift_id).await?
            else {
                return Ok(GiftClaimOutcome::NotFound);
            };
            if sender == tx_username {
                return Ok(GiftClaimOutcome::OwnGift);
            }
            let already: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM coin_gift_claims WHERE gift_id = ? AND username = ?",
            )
            .bind(&tx_gift_id)
            .bind(&tx_username)
            .fetch_one(&mut *conn)
            .await?;
            if already > 0 {
                return Ok(GiftClaimOutcome::AlreadyClaimed);
            }
            if status == "cancelled" {
                return Ok(GiftClaimOutcome::Cancelled);
            }

            let now = Utc::now().to_rfc3339();
            // Условие в WHERE — последний рубеж: даже если бы две активации как-то
            // оказались в одной точке, второй UPDATE не найдёт строку с остатком.
            let updated = sqlx::query(
                "UPDATE coin_gifts
                 SET claimed_count = claimed_count + 1,
                     status = CASE WHEN claimed_count + 1 >= total_claims THEN 'exhausted' ELSE status END,
                     finished_at = CASE WHEN claimed_count + 1 >= total_claims THEN ? ELSE finished_at END
                 WHERE id = ? AND status = 'active' AND claimed_count < total_claims",
            )
            .bind(&now)
            .bind(&tx_gift_id)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Ok(GiftClaimOutcome::Exhausted);
            }

            sqlx::query(
                "INSERT INTO coin_gift_claims (gift_id, username, amount, claimed_at) VALUES (?, ?, ?, ?)",
            )
            .bind(&tx_gift_id)
            .bind(&tx_username)
            .bind(amount)
            .bind(&now)
            .execute(&mut *conn)
            .await?;

            sqlx::query(
                "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
                 ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
            )
            .bind(&tx_username)
            .bind(amount)
            .execute(&mut *conn)
            .await?;
            Ok(GiftClaimOutcome::Claimed)
        }
        .await;
        (conn, result)
    })
    .await;

    let fresh = load_coin_gift(&state.db, &gift_id).await.ok().flatten();
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(e) => {
            warn!("Ошибка активации карточки ZaliCoin {} user={}: {}", gift_id, username, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    match outcome {
        GiftClaimOutcome::Claimed => {
            let Some(gift) = fresh else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            info!("ZaliCoin gift claimed id={} user={} amount={}", gift.id, username, gift.amount);
            broadcast_coin_gift(&state, &gift).await;
            let balance = load_balance(&state.db, &username).await;
            Json(serde_json::json!({ "gift": gift, "balance": balance })).into_response()
        }
        GiftClaimOutcome::NotFound => {
            coin_gift_error(StatusCode::NOT_FOUND, "not_found", "Карточка не найдена", None)
        }
        GiftClaimOutcome::OwnGift => coin_gift_error(
            StatusCode::FORBIDDEN,
            "own_gift",
            "Свою карточку активировать нельзя",
            fresh,
        ),
        GiftClaimOutcome::AlreadyClaimed => coin_gift_error(
            StatusCode::CONFLICT,
            "already_claimed",
            "Вы уже получили ZaliCoin с этой карточки",
            fresh,
        ),
        GiftClaimOutcome::Exhausted => coin_gift_error(
            StatusCode::CONFLICT,
            "gift_exhausted",
            "Все активации этой карточки уже использованы",
            fresh,
        ),
        GiftClaimOutcome::Cancelled => coin_gift_error(
            StatusCode::CONFLICT,
            "gift_cancelled",
            "Отправитель отменил карточку",
            fresh,
        ),
    }
}

enum GiftCancelOutcome {
    Cancelled(i64),
    NotFound,
    NotSender,
    AlreadyCancelled,
    Exhausted,
}

impl CoinTxOutcome for GiftCancelOutcome {
    fn commits(&self) -> bool {
        matches!(self, GiftCancelOutcome::Cancelled(_))
    }
}

pub(crate) async fn cancel_coin_gift(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Path(gift_id): Path<String>,
) -> impl IntoResponse {
    let gift_id = trim_limited(&gift_id, 64);
    let tx_gift_id = gift_id.clone();
    let tx_username = username.clone();
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result: Result<GiftCancelOutcome, sqlx::Error> = async {
            let Some((sender, amount, total, claimed, status)) =
                load_coin_gift_for_tx(&mut conn, &tx_gift_id).await?
            else {
                return Ok(GiftCancelOutcome::NotFound);
            };
            if sender != tx_username {
                return Ok(GiftCancelOutcome::NotSender);
            }
            if status == "cancelled" {
                return Ok(GiftCancelOutcome::AlreadyCancelled);
            }
            if status != "active" {
                return Ok(GiftCancelOutcome::Exhausted);
            }

            let updated = sqlx::query(
                "UPDATE coin_gifts SET status = 'cancelled', finished_at = ?
                 WHERE id = ? AND status = 'active'",
            )
            .bind(Utc::now().to_rfc3339())
            .bind(&tx_gift_id)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Ok(GiftCancelOutcome::Exhausted);
            }

            // Возвращаются только неактивированные заряды: активированное уже
            // лежит на балансах получивших и назад не забирается.
            let refund = amount * (total - claimed).max(0);
            if refund > 0 {
                sqlx::query(
                    "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
                     ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
                )
                .bind(&tx_username)
                .bind(refund)
                .execute(&mut *conn)
                .await?;
            }
            Ok(GiftCancelOutcome::Cancelled(refund))
        }
        .await;
        (conn, result)
    })
    .await;

    let fresh = load_coin_gift(&state.db, &gift_id).await.ok().flatten();
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(e) => {
            warn!("Ошибка отмены карточки ZaliCoin {} user={}: {}", gift_id, username, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    match outcome {
        GiftCancelOutcome::Cancelled(refunded) => {
            let Some(gift) = fresh else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            info!("ZaliCoin gift cancelled id={} refunded={}", gift.id, refunded);
            broadcast_coin_gift(&state, &gift).await;
            let balance = load_balance(&state.db, &username).await;
            let held = load_held_by(&state.db, &username).await;
            Json(serde_json::json!({
                "gift": gift,
                "balance": balance,
                "held": held,
                "refunded": refunded,
            }))
            .into_response()
        }
        GiftCancelOutcome::NotFound => {
            coin_gift_error(StatusCode::NOT_FOUND, "not_found", "Карточка не найдена", None)
        }
        // Чужой карточке не отдаём её состояние через этот путь — для этого есть lookup
        // с проверкой доступа к каналу.
        GiftCancelOutcome::NotSender => coin_gift_error(
            StatusCode::FORBIDDEN,
            "not_sender",
            "Отменить карточку может только отправитель",
            None,
        ),
        GiftCancelOutcome::AlreadyCancelled => coin_gift_error(
            StatusCode::CONFLICT,
            "gift_cancelled",
            "Карточка уже отменена",
            fresh,
        ),
        GiftCancelOutcome::Exhausted => coin_gift_error(
            StatusCode::CONFLICT,
            "gift_exhausted",
            "Все активации уже использованы — отменять нечего",
            fresh,
        ),
    }
}
