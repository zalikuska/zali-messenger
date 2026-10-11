//! Розыгрыши ZaliCoin — карточка в канале с кнопкой «Участвую».
//!
//! Создатель задаёт время окончания и призы по диапазонам мест: «места 1–5 —
//! Промокод, 6–20 — 500 ZaliCoin, 21–50 — 100 ZaliCoin». Монетные призы
//! замораживаются при создании (как у карточек-подарков), поэтому выигрыш
//! гарантирован. Когда время вышло, сервер один раз перемешивает участников
//! криптографическим генератором, раздаёт места и призы; монеты победителей
//! зачисляются сразу, а неразыгранные (мест больше, чем людей) возвращаются
//! создателю.
//!
//! Инварианты:
//!
//! - **Деньги не появляются и не исчезают.** Эскроу активного розыгрыша входит в
//!   «на удержании» в распределении эмиссии (`held_total`), а при итоге делится
//!   между победителями и возвратом создателю ровно в одной транзакции.
//! - **Один участник — одна запись** (UNIQUE), создатель участвовать не может.
//! - **Секрет приза (промокод) видит только победитель и создатель.** В общем
//!   виде розыгрыша есть лишь публичная подпись приза.
//! - **Итог — один раз.** Жеребьёвка выполняется в `BEGIN IMMEDIATE` и только
//!   для `status = 'active'`, так что параллельные запросы не разыграют дважды.

use crate::{
    can_access_channel, channel_belongs_to_server, get_server_accessibility, get_server_member_role,
    resolve_server_message_viewers, run_immediate_tx, send_payload_to_user, trim_limited, AppState,
    AuthenticatedUser, CoinTxOutcome, ZALICOIN_TOTAL_SUPPLY,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use rand::seq::SliceRandom;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tracing::{error, info, warn};
use uuid::Uuid;

const TITLE_MAX_CHARS: usize = 80;
const LABEL_MAX_CHARS: usize = 60;
const SECRET_MAX_CHARS: usize = 300;
const MAX_PRIZE_RANGES: usize = 8;
const MAX_PLACES: i64 = 1000;
const MAX_DURATION_SECS: i64 = 30 * 24 * 3600;
const MIN_DURATION_SECS_DEFAULT: i64 = 60;
const MAX_LOOKUP: usize = 50;
const MAX_ACTIVE_PER_USER: i64 = 10;
const WINNERS_SHOWN: i64 = 100;

fn min_duration_secs() -> i64 {
    std::env::var("ZALI_RAFFLE_MIN_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .unwrap_or(MIN_DURATION_SECS_DEFAULT)
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn raffle_error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "code": code, "message": message }))).into_response()
}

fn internal(context: &str, error: impl std::fmt::Display) -> Response {
    error!("raffles: {} err={}", context, error);
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

fn clean_line(value: &str, max: usize) -> String {
    let flat: String = value.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    trim_limited(flat.trim(), max)
}

// ============================================================================
// Эмиссия
// ============================================================================

/// Заморожено в активных розыгрышах этого человека.
pub(crate) async fn held_by(pool: &SqlitePool, username: &str) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(SUM(escrow), 0) FROM raffles WHERE creator = ? AND status = 'active'")
        .bind(username)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
}

/// Заморожено во всех активных розыгрышах — в «на удержании» распределения.
pub(crate) async fn held_total(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COALESCE(SUM(escrow), 0) FROM raffles WHERE status = 'active'")
        .fetch_one(pool)
        .await
}

// ============================================================================
// Представление
// ============================================================================

type RaffleRow = (String, String, String, String, String, i64, String, i64, i64, i64, i64);

const RAFFLE_COLUMNS: &str =
    "id, creator, server_id, channel_id, title, ends_at, status, escrow, refunded, created_at, drawn_at";

async fn load_raffle_row(pool: &SqlitePool, id: &str) -> Result<Option<RaffleRow>, sqlx::Error> {
    sqlx::query_as(&format!("SELECT {RAFFLE_COLUMNS} FROM raffles WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Общий вид розыгрыша плюс то, что относится к смотрящему (`you`). Секреты
/// чужих призов сюда не попадают.
async fn raffle_view(pool: &SqlitePool, row: RaffleRow, viewer: &str) -> Result<Value, sqlx::Error> {
    let (id, creator, server_id, channel_id, title, ends_at, status, escrow, refunded, created_at, drawn_at) = row;
    let prizes = sqlx::query_as::<_, (i64, i64, String, i64, String, String)>(
        "SELECT from_place, to_place, kind, amount, label, secret FROM raffle_prizes
         WHERE raffle_id = ? ORDER BY from_place ASC",
    )
    .bind(&id)
    .fetch_all(pool)
    .await?;
    let participants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM raffle_entries WHERE raffle_id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await?;
    let is_creator = creator == viewer;
    let prize_json = |(from, to, kind, amount, label, secret): &(i64, i64, String, i64, String, String)| {
        let mut v = json!({ "from": from, "to": to, "kind": kind, "amount": amount, "label": label });
        if is_creator {
            v["secret"] = json!(secret);
        }
        v
    };

    let mut winners = Vec::new();
    if status == "drawn" {
        let rows = sqlx::query_as::<_, (String, i64, String, i64)>(
            "SELECT username, place, prize_label, prize_amount FROM raffle_entries
             WHERE raffle_id = ? AND prize_label != '' ORDER BY place ASC LIMIT ?",
        )
        .bind(&id)
        .bind(WINNERS_SHOWN)
        .fetch_all(pool)
        .await?;
        winners = rows
            .into_iter()
            .map(|(username, place, label, amount)| json!({ "username": username, "place": place, "prize": label, "amount": amount }))
            .collect();
    }

    let mine = sqlx::query_as::<_, (i64, i64, String, String, i64)>(
        "SELECT joined_at, place, prize_label, prize_secret, prize_amount FROM raffle_entries
         WHERE raffle_id = ? AND username = ?",
    )
    .bind(&id)
    .bind(viewer)
    .fetch_optional(pool)
    .await?;
    let you = match mine {
        Some((joined_at, place, label, secret, amount)) => json!({
            "joined": true, "joinedAt": joined_at,
            "place": if place > 0 { json!(place) } else { Value::Null },
            "prize": if label.is_empty() { Value::Null } else { json!(label) },
            "amount": amount,
            "secret": if secret.is_empty() { Value::Null } else { json!(secret) },
        }),
        None => json!({ "joined": false }),
    };

    Ok(json!({
        "id": id, "creator": creator, "serverId": server_id, "channelId": channel_id,
        "title": title, "endsAt": ends_at, "status": status,
        "escrow": escrow, "refunded": refunded, "createdAt": created_at,
        "drawnAt": if drawn_at > 0 { json!(drawn_at) } else { Value::Null },
        "participants": participants,
        "prizes": prizes.iter().map(prize_json).collect::<Vec<_>>(),
        "winners": winners,
        "you": you,
    }))
}

// ============================================================================
// Рассылка
// ============================================================================

/// Сообщает всем, кто видит канал, плюс создателю и участникам, что розыгрыш
/// изменился. Содержимое клиент перечитывает сам: у каждого оно своё (`you`).
async fn broadcast_raffle(state: &Arc<AppState>, id: &str, server_id: &str, channel_id: &str, creator: &str, status: &str) {
    let candidates: Vec<String> = state.user_connections.iter().map(|entry| entry.key().clone()).collect();
    if candidates.is_empty() {
        return;
    }
    let mut viewers = match get_server_accessibility(&state.db, server_id).await {
        Ok(Some(server)) => resolve_server_message_viewers(state, &server, channel_id, &candidates)
            .await
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let entrants: Vec<String> = sqlx::query_scalar("SELECT username FROM raffle_entries WHERE raffle_id = ?")
        .bind(id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    let connected: HashSet<&str> = candidates.iter().map(String::as_str).collect();
    let mut seen: HashSet<String> = viewers.iter().cloned().collect();
    for name in std::iter::once(&creator.to_string()).chain(entrants.iter()) {
        if connected.contains(name.as_str()) && seen.insert(name.clone()) {
            viewers.push(name.clone());
        }
    }
    let payload = json!({ "type": "raffle_updated", "raffleId": id, "status": status }).to_string();
    for viewer in viewers {
        send_payload_to_user(state, &viewer, payload.clone(), "raffle_updated").await;
    }
}

// ============================================================================
// Создание
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct PrizeInput {
    from: i64,
    to: i64,
    /// `coins` или `item` (текстовый приз, например промокод).
    kind: String,
    #[serde(default)]
    amount: i64,
    #[serde(default)]
    label: String,
    #[serde(default)]
    secret: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RaffleCreateRequest {
    #[serde(rename = "serverId")]
    server_id: String,
    #[serde(rename = "channelId")]
    channel_id: String,
    title: String,
    /// Через сколько секунд подвести итог.
    #[serde(rename = "endsInSecs")]
    ends_in_secs: i64,
    prizes: Vec<PrizeInput>,
    #[serde(rename = "idempotencyKey")]
    idempotency_key: String,
}

struct Prize {
    from: i64,
    to: i64,
    kind: String,
    amount: i64,
    label: String,
    secret: String,
}

fn coin_label(amount: i64) -> String {
    format!("{} ZaliCoin", amount)
}

fn validate_prizes(input: &[PrizeInput]) -> Result<(Vec<Prize>, i64), String> {
    if input.is_empty() || input.len() > MAX_PRIZE_RANGES {
        return Err(format!("Призов — от 1 до {} диапазонов мест", MAX_PRIZE_RANGES));
    }
    let mut prizes = Vec::with_capacity(input.len());
    for p in input {
        if p.from < 1 || p.to < p.from || p.to > MAX_PLACES {
            return Err(format!("Места — от 1 до {}, «до» не меньше «от»", MAX_PLACES));
        }
        match p.kind.as_str() {
            "coins" => {
                if p.amount < 1 || p.amount > ZALICOIN_TOTAL_SUPPLY {
                    return Err("Сумма приза должна быть больше нуля".to_string());
                }
                prizes.push(Prize {
                    from: p.from, to: p.to, kind: "coins".into(), amount: p.amount,
                    label: coin_label(p.amount), secret: String::new(),
                });
            }
            "item" => {
                let label = clean_line(&p.label, LABEL_MAX_CHARS);
                if label.is_empty() {
                    return Err("У текстового приза должно быть название".to_string());
                }
                prizes.push(Prize {
                    from: p.from, to: p.to, kind: "item".into(), amount: 0, label,
                    secret: clean_line(&p.secret, SECRET_MAX_CHARS),
                });
            }
            _ => return Err("Вид приза: coins или item".to_string()),
        }
    }
    prizes.sort_by_key(|p| p.from);
    for pair in prizes.windows(2) {
        if pair[1].from <= pair[0].to {
            return Err("Диапазоны мест не должны пересекаться".to_string());
        }
    }
    let mut escrow: i64 = 0;
    for p in &prizes {
        let places = p.to - p.from + 1;
        let sum = p.amount.checked_mul(places).and_then(|v| escrow.checked_add(v));
        escrow = sum.filter(|v| *v <= ZALICOIN_TOTAL_SUPPLY).ok_or_else(|| "Недостаточно ZaliCoin".to_string())?;
    }
    Ok((prizes, escrow))
}

enum CreateOutcome {
    Created(String),
    Replayed(String),
    InsufficientFunds,
    TooMany,
}

impl CoinTxOutcome for CreateOutcome {
    fn commits(&self) -> bool {
        matches!(self, CreateOutcome::Created(_))
    }
}

/// `POST /api/raffles` — создать розыгрыш; монетные призы замораживаются.
pub(crate) async fn create_raffle(
    AuthenticatedUser(creator): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<RaffleCreateRequest>,
) -> impl IntoResponse {
    let server_id = trim_limited(&body.server_id, 128);
    let channel_id = trim_limited(&body.channel_id, 128);
    let key = trim_limited(&body.idempotency_key, 128);
    let title = clean_line(&body.title, TITLE_MAX_CHARS);
    if server_id.is_empty() || channel_id.is_empty() || key.is_empty() {
        return raffle_error(StatusCode::BAD_REQUEST, "bad_request", "Канал и ключ операции обязательны");
    }
    if title.is_empty() {
        return raffle_error(StatusCode::BAD_REQUEST, "bad_title", "Название розыгрыша обязательно");
    }
    let min = min_duration_secs();
    if body.ends_in_secs < min || body.ends_in_secs > MAX_DURATION_SECS {
        return raffle_error(
            StatusCode::BAD_REQUEST,
            "bad_duration",
            "Время розыгрыша — от минуты до 30 дней",
        );
    }
    let (prizes, escrow) = match validate_prizes(&body.prizes) {
        Ok(v) => v,
        Err(message) => return raffle_error(StatusCode::BAD_REQUEST, "bad_prizes", &message),
    };

    let allowed = match channel_belongs_to_server(&state.db, &server_id, &channel_id).await {
        Ok(true) => can_access_channel(&state.db, &server_id, &channel_id, &creator, "send").await,
        Ok(false) => Ok(false),
        Err(e) => Err(e),
    };
    match allowed {
        Ok(true) => {}
        Ok(false) => return raffle_error(StatusCode::FORBIDDEN, "forbidden", "Нет доступа к этому каналу"),
        Err(e) => return internal("create access", e),
    }

    let ends_at = now_ms() + body.ends_in_secs * 1000;
    let tx_creator = creator.clone();
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result: Result<CreateOutcome, sqlx::Error> = async {
            let existing: Option<String> =
                sqlx::query_scalar("SELECT id FROM raffles WHERE creator = ? AND idempotency_key = ?")
                    .bind(&tx_creator)
                    .bind(&key)
                    .fetch_optional(&mut *conn)
                    .await?;
            if let Some(id) = existing {
                return Ok(CreateOutcome::Replayed(id));
            }
            let active: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM raffles WHERE creator = ? AND status = 'active'")
                    .bind(&tx_creator)
                    .fetch_one(&mut *conn)
                    .await?;
            if active >= MAX_ACTIVE_PER_USER {
                return Ok(CreateOutcome::TooMany);
            }
            if escrow > 0 {
                let debited = sqlx::query(
                    "UPDATE coin_balances SET balance = balance - ? WHERE username = ? AND balance >= ?",
                )
                .bind(escrow)
                .bind(&tx_creator)
                .bind(escrow)
                .execute(&mut *conn)
                .await?;
                if debited.rows_affected() != 1 {
                    return Ok(CreateOutcome::InsufficientFunds);
                }
            }
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO raffles
                    (id, creator, server_id, channel_id, title, ends_at, status, escrow, refunded,
                     idempotency_key, created_at, drawn_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, 0)",
            )
            .bind(&id)
            .bind(&tx_creator)
            .bind(&server_id)
            .bind(&channel_id)
            .bind(&title)
            .bind(ends_at)
            .bind(escrow)
            .bind(&key)
            .bind(now_ms())
            .execute(&mut *conn)
            .await?;
            for p in &prizes {
                sqlx::query(
                    "INSERT INTO raffle_prizes (raffle_id, from_place, to_place, kind, amount, label, secret)
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&id)
                .bind(p.from)
                .bind(p.to)
                .bind(&p.kind)
                .bind(p.amount)
                .bind(&p.label)
                .bind(&p.secret)
                .execute(&mut *conn)
                .await?;
            }
            Ok(CreateOutcome::Created(id))
        }
        .await;
        (conn, result)
    })
    .await;

    let (id, status) = match outcome {
        Ok(CreateOutcome::Created(id)) => (id, StatusCode::CREATED),
        Ok(CreateOutcome::Replayed(id)) => (id, StatusCode::OK),
        Ok(CreateOutcome::InsufficientFunds) => {
            return raffle_error(StatusCode::BAD_REQUEST, "insufficient_funds", "Недостаточно ZaliCoin")
        }
        Ok(CreateOutcome::TooMany) => {
            return raffle_error(StatusCode::BAD_REQUEST, "too_many", "Одновременно — не больше десяти розыгрышей")
        }
        Err(e) => return internal("create", e),
    };
    if status == StatusCode::CREATED {
        info!("[RAFFLE] created id={} creator={} escrow={}", id, creator, escrow);
    }
    match load_raffle_row(&state.db, &id).await {
        Ok(Some(row)) => match raffle_view(&state.db, row, &creator).await {
            Ok(view) => {
                let balance: i64 = sqlx::query_scalar("SELECT balance FROM coin_balances WHERE username = ?")
                    .bind(&creator)
                    .fetch_optional(&state.db)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or(0);
                let held = crate::coins::load_held_by(&state.db, &creator).await;
                (status, Json(json!({ "raffle": view, "balance": balance, "held": held }))).into_response()
            }
            Err(e) => internal("create view", e),
        },
        Ok(None) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(e) => internal("create load", e),
    }
}

// ============================================================================
// Чтение
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct LookupQuery {
    ids: Option<String>,
}

/// `GET /api/raffles?ids=` — состояние карточек розыгрышей, которые клиент
/// рисует. Чужие каналы пропускаются, будто розыгрыша нет.
pub(crate) async fn lookup_raffles(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Query(query): Query<LookupQuery>,
) -> impl IntoResponse {
    sweep_due(&state).await;
    let mut seen = HashSet::new();
    let ids: Vec<String> = query
        .ids
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .filter(|id| seen.insert(id.to_string()))
        .take(MAX_LOOKUP)
        .map(str::to_string)
        .collect();
    let mut access: HashMap<(String, String), bool> = HashMap::new();
    let mut out = Vec::new();
    for id in ids {
        let row = match load_raffle_row(&state.db, &id).await {
            Ok(Some(row)) => row,
            Ok(None) => continue,
            Err(e) => return internal("lookup", e),
        };
        if row.1 != username {
            let key = (row.2.clone(), row.3.clone());
            let allowed = match access.get(&key) {
                Some(v) => *v,
                None => {
                    let v = can_access_channel(&state.db, &key.0, &key.1, &username, "view").await.unwrap_or(false);
                    access.insert(key, v);
                    v
                }
            };
            if !allowed {
                continue;
            }
        }
        match raffle_view(&state.db, row, &username).await {
            Ok(view) => out.push(view),
            Err(e) => return internal("lookup view", e),
        }
    }
    Json(json!({ "raffles": out })).into_response()
}

/// `GET /api/raffles/mine` — активные розыгрыши создателя: замороженное всегда
/// можно найти и отменить, даже если сообщение с карточкой не дошло.
pub(crate) async fn my_raffles(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    sweep_due(&state).await;
    let ids: Vec<String> = match sqlx::query_scalar(
        "SELECT id FROM raffles WHERE creator = ? AND status = 'active' ORDER BY created_at DESC LIMIT 50",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    {
        Ok(ids) => ids,
        Err(e) => return internal("mine", e),
    };
    let mut out = Vec::new();
    for id in ids {
        if let Ok(Some(row)) = load_raffle_row(&state.db, &id).await {
            if let Ok(view) = raffle_view(&state.db, row, &username).await {
                out.push(view);
            }
        }
    }
    Json(json!({ "raffles": out })).into_response()
}

// ============================================================================
// Участие и отмена
// ============================================================================

/// `POST /api/raffles/:id/join` — «Участвую». Один раз на аккаунт.
pub(crate) async fn join_raffle(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id = trim_limited(&id, 64);
    sweep_due(&state).await;
    let row = match load_raffle_row(&state.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return raffle_error(StatusCode::NOT_FOUND, "not_found", "Розыгрыш не найден"),
        Err(e) => return internal("join load", e),
    };
    let (_, creator, server_id, channel_id, _, ends_at, status, ..) = &row;
    if *creator == username {
        return raffle_error(StatusCode::FORBIDDEN, "own_raffle", "В своём розыгрыше участвовать нельзя");
    }
    if status != "active" || *ends_at <= now_ms() {
        return raffle_error(StatusCode::CONFLICT, "finished", "Розыгрыш уже завершён");
    }
    let member = get_server_member_role(&state.db, server_id, &username).await.map(|r| r.is_some());
    let allowed = match member {
        Ok(true) => can_access_channel(&state.db, server_id, channel_id, &username, "view").await,
        other => other,
    };
    match allowed {
        Ok(true) => {}
        Ok(false) => {
            return raffle_error(StatusCode::FORBIDDEN, "forbidden", "Участвовать могут только участники канала")
        }
        Err(e) => return internal("join access", e),
    }
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO raffle_entries (raffle_id, username, joined_at, place, prize_label, prize_secret, prize_amount)
         VALUES (?, ?, ?, 0, '', '', 0)",
    )
    .bind(&id)
    .bind(&username)
    .bind(now_ms())
    .execute(&state.db)
    .await;
    let fresh = match inserted {
        Ok(r) => r.rows_affected() == 1,
        Err(e) => return internal("join insert", e),
    };
    if fresh {
        info!("[RAFFLE] join id={} user={}", id, username);
        broadcast_raffle(&state, &id, server_id, channel_id, creator, "active").await;
    }
    match raffle_view(&state.db, row, &username).await {
        Ok(view) => (if fresh { StatusCode::CREATED } else { StatusCode::OK }, Json(json!({ "raffle": view })))
            .into_response(),
        Err(e) => internal("join view", e),
    }
}

enum CancelOutcome {
    Cancelled(i64),
    NotFound,
    NotCreator,
    NotActive,
}

impl CoinTxOutcome for CancelOutcome {
    fn commits(&self) -> bool {
        matches!(self, CancelOutcome::Cancelled(_))
    }
}

/// `POST /api/raffles/:id/cancel` — создатель отменяет до итога; заморозка
/// возвращается целиком.
pub(crate) async fn cancel_raffle(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id = trim_limited(&id, 64);
    let tx_id = id.clone();
    let tx_user = username.clone();
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result: Result<CancelOutcome, sqlx::Error> = async {
            let row: Option<(String, String, i64)> =
                sqlx::query_as("SELECT creator, status, escrow FROM raffles WHERE id = ?")
                    .bind(&tx_id)
                    .fetch_optional(&mut *conn)
                    .await?;
            let Some((creator, status, escrow)) = row else {
                return Ok(CancelOutcome::NotFound);
            };
            if creator != tx_user {
                return Ok(CancelOutcome::NotCreator);
            }
            if status != "active" {
                return Ok(CancelOutcome::NotActive);
            }
            sqlx::query("UPDATE raffles SET status = 'cancelled', escrow = 0, refunded = ?, drawn_at = ? WHERE id = ?")
                .bind(escrow)
                .bind(now_ms())
                .bind(&tx_id)
                .execute(&mut *conn)
                .await?;
            if escrow > 0 {
                sqlx::query(
                    "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
                     ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
                )
                .bind(&tx_user)
                .bind(escrow)
                .execute(&mut *conn)
                .await?;
            }
            Ok(CancelOutcome::Cancelled(escrow))
        }
        .await;
        (conn, result)
    })
    .await;
    match outcome {
        Ok(CancelOutcome::Cancelled(refund)) => {
            info!("[RAFFLE] cancelled id={} refund={}", id, refund);
            if let Ok(Some(row)) = load_raffle_row(&state.db, &id).await {
                broadcast_raffle(&state, &id, &row.2, &row.3, &row.1, "cancelled").await;
                if let Ok(view) = raffle_view(&state.db, row, &username).await {
                    return Json(json!({ "raffle": view, "refunded": refund })).into_response();
                }
            }
            StatusCode::OK.into_response()
        }
        Ok(CancelOutcome::NotFound) => raffle_error(StatusCode::NOT_FOUND, "not_found", "Розыгрыш не найден"),
        Ok(CancelOutcome::NotCreator) => {
            raffle_error(StatusCode::FORBIDDEN, "forbidden", "Отменить может только создатель")
        }
        Ok(CancelOutcome::NotActive) => {
            raffle_error(StatusCode::CONFLICT, "finished", "Розыгрыш уже завершён или отменён")
        }
        Err(e) => internal("cancel", e),
    }
}

// ============================================================================
// Жеребьёвка
// ============================================================================

enum DrawOutcome {
    Drawn,
    Skipped,
}

impl CoinTxOutcome for DrawOutcome {
    fn commits(&self) -> bool {
        matches!(self, DrawOutcome::Drawn)
    }
}

/// Подводит итог одного розыгрыша, если его время вышло. Возвращает `true`,
/// если именно этот вызов провёл жеребьёвку.
async fn draw_raffle(state: &Arc<AppState>, id: &str) -> bool {
    let tx_id = id.to_string();
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result: Result<DrawOutcome, sqlx::Error> = async {
            let row: Option<(String, String, i64, i64)> =
                sqlx::query_as("SELECT creator, status, ends_at, escrow FROM raffles WHERE id = ?")
                    .bind(&tx_id)
                    .fetch_optional(&mut *conn)
                    .await?;
            let Some((creator, status, ends_at, escrow)) = row else {
                return Ok(DrawOutcome::Skipped);
            };
            if status != "active" || ends_at > now_ms() {
                return Ok(DrawOutcome::Skipped);
            }
            let prizes = sqlx::query_as::<_, (i64, i64, String, i64, String, String)>(
                "SELECT from_place, to_place, kind, amount, label, secret FROM raffle_prizes
                 WHERE raffle_id = ? ORDER BY from_place ASC",
            )
            .bind(&tx_id)
            .fetch_all(&mut *conn)
            .await?;
            let users: Vec<String> =
                sqlx::query_scalar("SELECT username FROM raffle_entries WHERE raffle_id = ?")
                    .bind(&tx_id)
                    .fetch_all(&mut *conn)
                    .await?;
            // Перемешивание — до любого await: ThreadRng не Send.
            let order = {
                let mut v = users;
                v.shuffle(&mut rand::thread_rng());
                v
            };
            let mut paid: i64 = 0;
            for (index, user) in order.iter().enumerate() {
                let place = index as i64 + 1;
                let prize = prizes.iter().find(|p| place >= p.0 && place <= p.1);
                let (label, secret, amount) = match prize {
                    Some((_, _, kind, amount, label, secret)) => {
                        (label.clone(), secret.clone(), if kind == "coins" { *amount } else { 0 })
                    }
                    None => (String::new(), String::new(), 0),
                };
                sqlx::query(
                    "UPDATE raffle_entries SET place = ?, prize_label = ?, prize_secret = ?, prize_amount = ?
                     WHERE raffle_id = ? AND username = ?",
                )
                .bind(place)
                .bind(&label)
                .bind(&secret)
                .bind(amount)
                .bind(&tx_id)
                .bind(user)
                .execute(&mut *conn)
                .await?;
                if amount > 0 {
                    sqlx::query(
                        "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
                         ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
                    )
                    .bind(user)
                    .bind(amount)
                    .execute(&mut *conn)
                    .await?;
                    paid += amount;
                }
            }
            // Неразыгранное (мест больше, чем людей) возвращается создателю.
            let refund = (escrow - paid).max(0);
            if refund > 0 {
                sqlx::query(
                    "INSERT INTO coin_balances (username, balance) VALUES (?, ?)
                     ON CONFLICT(username) DO UPDATE SET balance = balance + excluded.balance",
                )
                .bind(&creator)
                .bind(refund)
                .execute(&mut *conn)
                .await?;
            }
            sqlx::query(
                "UPDATE raffles SET status = 'drawn', escrow = 0, refunded = ?, drawn_at = ? WHERE id = ?",
            )
            .bind(refund)
            .bind(now_ms())
            .bind(&tx_id)
            .execute(&mut *conn)
            .await?;
            Ok(DrawOutcome::Drawn)
        }
        .await;
        (conn, result)
    })
    .await;
    match outcome {
        Ok(DrawOutcome::Drawn) => {
            info!("[RAFFLE] drawn id={}", id);
            if let Ok(Some(row)) = load_raffle_row(&state.db, id).await {
                broadcast_raffle(state, id, &row.2, &row.3, &row.1, "drawn").await;
            }
            true
        }
        Ok(DrawOutcome::Skipped) => false,
        Err(e) => {
            warn!("raffles: draw id={} err={}", id, e);
            false
        }
    }
}

/// Разыгрывает всё, чьё время вышло. Зовётся фоновым циклом и перед чтением:
/// так итог виден сразу, даже если цикл ещё не отработал.
pub(crate) async fn sweep_due(state: &Arc<AppState>) {
    let due: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM raffles WHERE status = 'active' AND ends_at <= ? ORDER BY ends_at ASC LIMIT 20",
    )
    .bind(now_ms())
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for id in due {
        draw_raffle(state, &id).await;
    }
}
