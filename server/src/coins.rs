//! ZaliCoin: a fixed-supply (100 000) in-app currency ledger. Coins only ever
//! move between existing users via `transfer_coins` — nothing mints or burns
//! them after `seed_zalicoin` grants the whole supply to `zalikus` on first
//! run (see `storage.rs`), so `SUM(balance)` in `coin_balances` is invariant.
//!
//! Anti-dupe: every transfer is wrapped in a single `BEGIN IMMEDIATE`
//! transaction (balance check + both-side balance mutation + ledger insert),
//! so concurrent requests from the same sender can't race past the balance
//! check. Retries are made safe by a client-supplied idempotency key: it's
//! stored per (sender, key) with a UNIQUE constraint, so a resubmitted
//! request (e.g. a network retry after the response was lost) is detected
//! and short-circuited to the current balance instead of transferring twice.

use crate::{trim_limited, AppState, AuthenticatedUser};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{error, warn};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub(crate) struct CoinBalanceResponse {
    balance: i64,
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
}

#[derive(Debug, Deserialize)]
pub(crate) struct CoinTransferRequest {
    to: String,
    amount: i64,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
}

pub(crate) const ZALICOIN_TOTAL_SUPPLY: i64 = 100_000;

pub(crate) async fn get_coin_balance(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
        .bind(&username)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(Some(0))
        .unwrap_or(0);
    Json(CoinBalanceResponse { balance }).into_response()
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

    match rows {
        Ok(rows) => Json(CoinDistributionResponse {
            total_supply: ZALICOIN_TOTAL_SUPPLY,
            holders: rows
                .into_iter()
                .map(|(username, balance)| CoinHolder { username, balance })
                .collect(),
        })
        .into_response(),
        Err(e) => {
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
    let transfer_result: Result<i64, sqlx::Error> = async {
        let already_applied: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM coin_transactions WHERE from_user = ? AND idempotency_key = ?",
        )
        .bind(&sender)
        .bind(&idempotency_key)
        .fetch_one(&mut *conn)
        .await?;
        if already_applied > 0 {
            return Ok(-1);
        }

        let sender_balance: i64 =
            sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
                .bind(&sender)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or(0);

        if sender_balance < amount {
            return Ok(-2);
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
            "INSERT INTO coin_transactions (id, from_user, to_user, amount, idempotency_key)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&sender)
        .bind(&to)
        .bind(amount)
        .bind(&idempotency_key)
        .execute(&mut *conn)
        .await?;

        let new_balance = sender_balance - amount;
        sqlx::query("COMMIT").execute(&mut *conn).await?;
        Ok(new_balance)
    }
    .await;

    match transfer_result {
        Ok(-2) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            (StatusCode::BAD_REQUEST, "Недостаточно ZaliCoin для перевода").into_response()
        }
        Ok(-1) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            let balance: i64 =
                sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
                    .bind(&sender)
                    .fetch_optional(&state.db)
                    .await
                    .unwrap_or(Some(0))
                    .unwrap_or(0);
            Json(CoinBalanceResponse { balance }).into_response()
        }
        Ok(new_balance) => Json(CoinBalanceResponse { balance: new_balance }).into_response(),
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            warn!("Ошибка перевода ZaliCoin from={} to={}: {}", sender, to, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
