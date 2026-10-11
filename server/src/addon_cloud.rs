//! Облачное хранилище аддонов: до 10 МБ данных **на аддон** на сервере ZaliMessenger.
//!
//! Это хранилище приложения, а не личный диск человека: для аддонов, которым
//! нужна синхронизация между устройствами и людьми и сбор данных от своих
//! пользователей. Что здесь важно понимать:
//!
//! - **Один пул на аддон.** 10 МиБ — общий потолок всех данных аддона у всех
//!   его пользователей вместе, а не на человека. Чтобы один участник не
//!   занял всё, у каждого есть своя доля — 1 МиБ в «личной» области.
//!
//! - **Две области.** `user` — личная: человек пишет и читает только свою
//!   (`u:<имя>`), автор аддона может её прочитать (сбор данных); `shared` —
//!   общая: читают все, пишет только автор. Автор — владелец записи об аддоне в
//!   реестре (`addon_registry`), не «первый, кто назвался».
//!
//! - **Нужна подпись.** Хранилище открыто только аддону, закреплённому в
//!   реестре за автором: чужой `id` без записи в реестре — 403 `not_signed`.
//!   Сервер не видит файл, поэтому отпечаток сверяет клиент (как для монет);
//!   сервер же гарантирует то, что может: человек пишет только в свою область,
//!   общую и чужие читает только по праву автора.
//!
//! - **Автор видит данные своих пользователей.** Это сделано намеренно и
//!   сказано в тексте разрешения `cloud` при установке: сбор информации
//!   — назначение хранилища. Человек всегда может стереть свою область.
//!
//! - **Чтения автором журналируются.** Каждое чтение чужих данных (`collect`)
//!   пишется в `addon_cloud_audit`, а человек видит свою строку журнала в
//!   сведениях аддона: «автор читал ваши данные N раз». Чтение без следа
//!   нельзя — собирать данные можно только открыто.
//!
//! - **Смена владельца стирает облако.** Если официальная подпись перехватила
//!   `id` у самоподписи, накопленные данные пользователей не переходят новому
//!   владельцу: они были собраны на условиях прежнего автора.
//!
//! - **Отозванные сборки.** Оператор может отозвать отпечаток сборки
//!   (`addon_revocations`): приложение отказывается её запускать и давать ей
//!   облако и монеты, а сервер отказывает по заголовку `X-Zali-Addon-Digest`.
//!   Заголовок присылает приложение; обойти его может только модифицированный
//!   клиент — серверная проверка страхует честные клиенты, а не заменяет подпись.
//!
//! - **Частота ограничена.** Запись — 120 раз в минуту на пару «человек ×
//!   аддон», сбор — 60 раз в минуту на автора: пул 10 МБ не должен
//!   перемалываться непрерывной записью.
//!
//! - **Лимиты считаются в транзакции.** Пул и доля проверяются внутри
//!   `BEGIN IMMEDIATE`, как и остальные счётчики: две записи одновременно не
//!   пройдут вместе под потолок. Замена значения освобождает старый размер.

use crate::{
    addons::{addon_error, valid_addon_id},
    coins::{run_immediate_tx, CoinTxOutcome},
    AppState, AuthenticatedUser,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tracing::{error, info};

/// Потолок данных аддона у всех пользователей вместе.
pub(crate) const ADDON_CLOUD_QUOTA_BYTES: i64 = 10 * 1024 * 1024;
/// Доля одного человека в личной области аддона.
pub(crate) const ADDON_CLOUD_USER_BYTES: i64 = 1024 * 1024;
const MAX_KEYS_PER_SCOPE: i64 = 1000;
/// Строк на аддон у всех людей вместе: пустые значения весят 0 байт, но строку и ключ занимают.
const MAX_KEYS_PER_ADDON: i64 = 10_000;
const MAX_KEY_BYTES: usize = 256;
const COLLECT_PAGE_MAX: i64 = 200;
const WRITES_PER_MINUTE: usize = 120;
const COLLECTS_PER_MINUTE: usize = 60;

static LIMITER: OnceLock<Mutex<HashMap<String, VecDeque<Instant>>>> = OnceLock::new();

/// Скользящее окно в минуту; `false` — лимит исчерпан.
fn within_rate(key: String, max: usize) -> bool {
    let window = Duration::from_secs(60);
    let now = Instant::now();
    let mut map = match LIMITER.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };
    if map.len() > 20_000 {
        map.retain(|_, hits| hits.back().map_or(false, |at| now.duration_since(*at) < window));
    }
    let hits = map.entry(key).or_default();
    while hits.front().map_or(false, |at| now.duration_since(*at) >= window) {
        hits.pop_front();
    }
    if hits.len() >= max {
        return false;
    }
    hits.push_back(now);
    true
}

fn rate_limited() -> Response {
    addon_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Слишком часто: подождите минуту")
}

/// `true`, если приложение прислало отпечаток сборки, которую оператор отозвал.
pub(crate) async fn digest_revoked(state: &AppState, headers: &HeaderMap, addon_id: &str) -> bool {
    let Some(digest) = headers
        .get("x-zali-addon-digest")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_lowercase())
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return false;
    };
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM addon_revocations WHERE addon_id = ? AND digest = ?")
        .bind(addon_id)
        .bind(&digest)
        .fetch_one(&state.db)
        .await
        .map(|n| n > 0)
        .unwrap_or(false)
}

fn revoked_error() -> Response {
    addon_error(
        StatusCode::FORBIDDEN,
        "revoked",
        "Эта сборка аддона отозвана: обновите аддон до новой версии",
    )
}

/// Стереть облако аддона целиком (смена владельца записи об аддоне). Вызывается
/// внутри той же транзакции, что и смена владельца: данные не переживают её
/// ни на мгновение, а сбой стирания откатывает и саму смену.
pub(crate) async fn wipe_addon(conn: &mut sqlx::SqliteConnection, addon_id: &str) -> Result<(), sqlx::Error> {
    let removed = sqlx::query("DELETE FROM addon_cloud WHERE addon_id = ?")
        .bind(addon_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM addon_cloud_audit WHERE addon_id = ?")
        .bind(addon_id)
        .execute(&mut *conn)
        .await?;
    info!("[ADDON] cloud wiped on owner change id={} rows={}", addon_id, removed);
    Ok(())
}

async fn audit(
    state: &AppState,
    addon_id: &str,
    actor: &str,
    user: Option<&str>,
    key: &str,
    action: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO addon_cloud_audit (addon_id, actor, subject, key, action, at)
         VALUES (?, ?, ?, ?, ?, strftime('%s','now'))",
    )
    .bind(addon_id)
    .bind(actor)
    .bind(user)
    .bind(key)
    .bind(action)
    .execute(&state.db)
    .await
    .map(|_| ())
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_KEY_BYTES && !key.chars().any(|c| c.is_control())
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct CloudQuery {
    key: Option<String>,
    /// `user` (по умолчанию) или `shared`.
    scope: Option<String>,
    /// Для сбора автором: чьи данные.
    user: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PutBody {
    /// `json` — `value` это JSON-значение; `bytes` — base64 двоичных данных.
    kind: String,
    value: Value,
}

enum PutOutcome {
    Stored { pool: i64, mine: i64, keys: i64 },
    PoolFull,
    UserFull,
    TooManyKeys,
}

impl CoinTxOutcome for PutOutcome {
    fn commits(&self) -> bool {
        matches!(self, PutOutcome::Stored { .. })
    }
}

fn check_id(addon_id: &str) -> Result<(), Response> {
    if valid_addon_id(addon_id) {
        Ok(())
    } else {
        Err(addon_error(StatusCode::BAD_REQUEST, "bad_params", "Некорректный id аддона"))
    }
}

fn key_error() -> Response {
    addon_error(StatusCode::BAD_REQUEST, "bad_params", "Ключ — от 1 до 256 байт без управляющих символов")
}

fn db_error(context: &str, error: sqlx::Error) -> Response {
    error!("addon_cloud: {} err={}", context, error);
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

/// Автор аддона по реестру: `Ok(owner)`, либо готовый ответ-отказ.
async fn registered_owner(state: &AppState, addon_id: &str) -> Result<String, Response> {
    match sqlx::query_scalar::<_, String>("SELECT owner FROM addon_registry WHERE addon_id = ?")
        .bind(addon_id)
        .fetch_optional(&state.db)
        .await
    {
        Ok(Some(owner)) => Ok(owner),
        Ok(None) => Err(addon_error(
            StatusCode::FORBIDDEN,
            "not_signed",
            "Облако — только подписанным аддонам: этого аддона нет в реестре автора",
        )),
        Err(e) => Err(db_error("registry", e)),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Scope {
    User,
    Shared,
}

fn parse_scope(raw: &Option<String>) -> Result<Scope, Response> {
    match raw.as_deref().unwrap_or("user") {
        "user" => Ok(Scope::User),
        "shared" => Ok(Scope::Shared),
        _ => Err(addon_error(StatusCode::BAD_REQUEST, "bad_params", "scope — user или shared")),
    }
}

fn scope_column(scope: Scope, username: &str) -> String {
    match scope {
        Scope::Shared => "shared".to_string(),
        Scope::User => format!("u:{username}"),
    }
}

/// Запись в общую область и сбор чужих данных — только автору.
fn require_owner(owner: &str, username: &str, what: &str) -> Result<(), Response> {
    if owner == username {
        Ok(())
    } else {
        Err(addon_error(StatusCode::FORBIDDEN, "forbidden", what))
    }
}

/// `GET /api/addons/:id/cloud?scope=` — занятое место, доля и список ключей области.
pub(crate) async fn list_cloud(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Query(query): Query<CloudQuery>,
) -> Response {
    if let Err(resp) = check_id(&addon_id) {
        return resp;
    }
    if digest_revoked(&state, &headers, &addon_id).await {
        return revoked_error();
    }
    let owner = match registered_owner(&state, &addon_id).await {
        Ok(owner) => owner,
        Err(resp) => return resp,
    };
    let scope = match parse_scope(&query.scope) {
        Ok(scope) => scope,
        Err(resp) => return resp,
    };
    let column = scope_column(scope, &username);
    let mine_column = scope_column(Scope::User, &username);
    let totals: Result<(i64, i64), sqlx::Error> =
        sqlx::query_as("SELECT COALESCE(SUM(size), 0), COUNT(*) FROM addon_cloud WHERE addon_id = ?")
            .bind(&addon_id)
            .fetch_one(&state.db)
            .await;
    let mine: Result<i64, sqlx::Error> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(size), 0) FROM addon_cloud WHERE addon_id = ? AND scope = ?",
    )
    .bind(&addon_id)
    .bind(&mine_column)
    .fetch_one(&state.db)
    .await;
    let rows: Result<Vec<(String, String, i64, i64)>, sqlx::Error> = sqlx::query_as(
        "SELECT key, kind, size, updated_at FROM addon_cloud
         WHERE addon_id = ? AND scope = ? ORDER BY key LIMIT ?",
    )
    .bind(&addon_id)
    .bind(&column)
    .bind(MAX_KEYS_PER_SCOPE)
    .fetch_all(&state.db)
    .await;
    match (totals, mine, rows) {
        (Ok((pool, _)), Ok(mine), Ok(rows)) => Json(json!({
            "scope": if scope == Scope::Shared { "shared" } else { "user" },
            "bytes": pool,
            "quota": ADDON_CLOUD_QUOTA_BYTES,
            "mine": mine,
            "mineQuota": ADDON_CLOUD_USER_BYTES,
            "keys": rows.len(),
            "maxKeys": MAX_KEYS_PER_SCOPE,
            "isOwner": owner == username,
            "items": rows
                .into_iter()
                .map(|(key, kind, size, updated)| json!({ "key": key, "kind": kind, "size": size, "updatedAt": updated }))
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => db_error("list", e),
    }
}

fn value_json(kind: &str, bytes: &[u8]) -> Value {
    let value = if kind == "json" {
        serde_json::from_slice::<Value>(bytes).unwrap_or(Value::Null)
    } else {
        Value::String(B64.encode(bytes))
    };
    json!({ "kind": kind, "value": value, "size": bytes.len() })
}

/// `GET /api/addons/:id/cloud/item?key=&scope=` — значение: `{kind, value}`.
pub(crate) async fn get_cloud_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Query(query): Query<CloudQuery>,
) -> Response {
    if let Err(resp) = check_id(&addon_id) {
        return resp;
    }
    if digest_revoked(&state, &headers, &addon_id).await {
        return revoked_error();
    }
    if let Err(resp) = registered_owner(&state, &addon_id).await {
        return resp;
    }
    let scope = match parse_scope(&query.scope) {
        Ok(scope) => scope,
        Err(resp) => return resp,
    };
    let key = query.key.unwrap_or_default();
    if !valid_key(&key) {
        return key_error();
    }
    let row: Result<Option<(String, Vec<u8>)>, sqlx::Error> = sqlx::query_as(
        "SELECT kind, value FROM addon_cloud WHERE addon_id = ? AND scope = ? AND key = ?",
    )
    .bind(&addon_id)
    .bind(scope_column(scope, &username))
    .bind(&key)
    .fetch_optional(&state.db)
    .await;
    match row {
        Ok(Some((kind, bytes))) => Json(value_json(&kind, &bytes)).into_response(),
        Ok(None) => addon_error(StatusCode::NOT_FOUND, "not_found", "Нет такого ключа"),
        Err(e) => db_error("get", e),
    }
}

/// `PUT /api/addons/:id/cloud/item?key=&scope=` — записать значение.
pub(crate) async fn put_cloud_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Query(query): Query<CloudQuery>,
    Json(body): Json<PutBody>,
) -> Response {
    if let Err(resp) = check_id(&addon_id) {
        return resp;
    }
    if digest_revoked(&state, &headers, &addon_id).await {
        return revoked_error();
    }
    if !within_rate(format!("w:{username}:{addon_id}"), WRITES_PER_MINUTE) {
        return rate_limited();
    }
    let owner = match registered_owner(&state, &addon_id).await {
        Ok(owner) => owner,
        Err(resp) => return resp,
    };
    let scope = match parse_scope(&query.scope) {
        Ok(scope) => scope,
        Err(resp) => return resp,
    };
    if scope == Scope::Shared {
        if let Err(resp) = require_owner(&owner, &username, "В общую область пишет только автор аддона") {
            return resp;
        }
    }
    let key = query.key.unwrap_or_default();
    if !valid_key(&key) {
        return key_error();
    }
    let bytes: Vec<u8> = match body.kind.as_str() {
        "json" => match serde_json::to_vec(&body.value) {
            Ok(bytes) => bytes,
            Err(_) => return addon_error(StatusCode::BAD_REQUEST, "bad_params", "Значение не сериализуется в JSON"),
        },
        "bytes" => {
            let Some(text) = body.value.as_str() else {
                return addon_error(StatusCode::BAD_REQUEST, "bad_params", "Для bytes нужна строка base64");
            };
            match B64.decode(text) {
                Ok(bytes) => bytes,
                Err(_) => return addon_error(StatusCode::BAD_REQUEST, "bad_params", "Некорректный base64"),
            }
        }
        _ => return addon_error(StatusCode::BAD_REQUEST, "bad_params", "kind — json или bytes"),
    };
    let size = bytes.len() as i64;
    let personal = scope == Scope::User;
    if size > ADDON_CLOUD_QUOTA_BYTES || (personal && size > ADDON_CLOUD_USER_BYTES) {
        return addon_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "quota",
            if personal { "Значение больше доли человека — 1 МБ" } else { "Значение больше 10 МБ" },
        );
    }

    let kind = body.kind.clone();
    let column = scope_column(scope, &username);
    let (tx_addon, tx_scope, tx_key) = (addon_id.clone(), column.clone(), key.clone());
    let outcome = run_immediate_tx(state.db.clone(), move |mut conn| async move {
        let result = async {
            let old: Option<i64> = sqlx::query_scalar(
                "SELECT size FROM addon_cloud WHERE addon_id = ? AND scope = ? AND key = ?",
            )
            .bind(&tx_addon)
            .bind(&tx_scope)
            .bind(&tx_key)
            .fetch_optional(&mut *conn)
            .await?;
            let freed = old.unwrap_or(0);
            let (pool, rows): (i64, i64) =
                sqlx::query_as("SELECT COALESCE(SUM(size), 0), COUNT(*) FROM addon_cloud WHERE addon_id = ?")
                    .bind(&tx_addon)
                    .fetch_one(&mut *conn)
                    .await?;
            let (mine, keys): (i64, i64) = sqlx::query_as(
                "SELECT COALESCE(SUM(size), 0), COUNT(*) FROM addon_cloud WHERE addon_id = ? AND scope = ?",
            )
            .bind(&tx_addon)
            .bind(&tx_scope)
            .fetch_one(&mut *conn)
            .await?;
            if old.is_none() && (keys >= MAX_KEYS_PER_SCOPE || rows >= MAX_KEYS_PER_ADDON) {
                return Ok(PutOutcome::TooManyKeys);
            }
            if pool - freed + size > ADDON_CLOUD_QUOTA_BYTES {
                return Ok(PutOutcome::PoolFull);
            }
            if personal && mine - freed + size > ADDON_CLOUD_USER_BYTES {
                return Ok(PutOutcome::UserFull);
            }
            sqlx::query(
                "INSERT INTO addon_cloud (addon_id, scope, key, kind, value, size, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
                 ON CONFLICT(addon_id, scope, key)
                 DO UPDATE SET kind = excluded.kind, value = excluded.value,
                               size = excluded.size, updated_at = excluded.updated_at",
            )
            .bind(&tx_addon)
            .bind(&tx_scope)
            .bind(&tx_key)
            .bind(&kind)
            .bind(&bytes)
            .bind(size)
            .execute(&mut *conn)
            .await?;
            Ok(PutOutcome::Stored {
                pool: pool - freed + size,
                mine: mine - freed + size,
                keys: if old.is_none() { keys + 1 } else { keys },
            })
        }
        .await;
        (conn, result)
    })
    .await;
    match outcome {
        Ok(PutOutcome::Stored { pool, mine, keys }) => Json(json!({
            "ok": true,
            "bytes": pool,
            "quota": ADDON_CLOUD_QUOTA_BYTES,
            "mine": mine,
            "mineQuota": ADDON_CLOUD_USER_BYTES,
            "keys": keys,
        }))
        .into_response(),
        Ok(PutOutcome::PoolFull) => addon_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "quota",
            "Облако аддона заполнено: у аддона в облаке не больше 10 МБ на всех пользователей",
        ),
        Ok(PutOutcome::UserFull) => addon_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "quota",
            "Не хватает места: личная область человека в облаке аддона — не больше 1 МБ",
        ),
        Ok(PutOutcome::TooManyKeys) => addon_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "quota",
            "Слишком много ключей: не больше 1000 в области и 10 000 на аддон",
        ),
        Err(e) => db_error("put", e),
    }
}

/// `DELETE /api/addons/:id/cloud/item?key=&scope=`.
pub(crate) async fn delete_cloud_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Query(query): Query<CloudQuery>,
) -> Response {
    if let Err(resp) = check_id(&addon_id) {
        return resp;
    }
    if digest_revoked(&state, &headers, &addon_id).await {
        return revoked_error();
    }
    if !within_rate(format!("w:{username}:{addon_id}"), WRITES_PER_MINUTE) {
        return rate_limited();
    }
    let owner = match registered_owner(&state, &addon_id).await {
        Ok(owner) => owner,
        Err(resp) => return resp,
    };
    let scope = match parse_scope(&query.scope) {
        Ok(scope) => scope,
        Err(resp) => return resp,
    };
    if scope == Scope::Shared {
        if let Err(resp) = require_owner(&owner, &username, "Из общей области удаляет только автор аддона") {
            return resp;
        }
    }
    let key = query.key.unwrap_or_default();
    if !valid_key(&key) {
        return key_error();
    }
    match sqlx::query("DELETE FROM addon_cloud WHERE addon_id = ? AND scope = ? AND key = ?")
        .bind(&addon_id)
        .bind(scope_column(scope, &username))
        .bind(&key)
        .execute(&state.db)
        .await
    {
        Ok(done) => Json(json!({ "ok": true, "removed": done.rows_affected() > 0 })).into_response(),
        Err(e) => db_error("delete", e),
    }
}

/// `DELETE /api/addons/:id/cloud?scope=` — стереть свою область (или общую — автору).
pub(crate) async fn clear_cloud(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Query(query): Query<CloudQuery>,
) -> Response {
    if let Err(resp) = check_id(&addon_id) {
        return resp;
    }
    if digest_revoked(&state, &headers, &addon_id).await {
        return revoked_error();
    }
    // Человек стирает свою область и у аддона, которого уже нет в реестре:
    // «удалить мои данные» не должно зависеть от судьбы записи об авторе.
    let scope = match parse_scope(&query.scope) {
        Ok(scope) => scope,
        Err(resp) => return resp,
    };
    if scope == Scope::Shared {
        let owner = match registered_owner(&state, &addon_id).await {
            Ok(owner) => owner,
            Err(resp) => return resp,
        };
        if let Err(resp) = require_owner(&owner, &username, "Общую область стирает только автор аддона") {
            return resp;
        }
    }
    match sqlx::query("DELETE FROM addon_cloud WHERE addon_id = ? AND scope = ?")
        .bind(&addon_id)
        .bind(scope_column(scope, &username))
        .execute(&state.db)
        .await
    {
        Ok(done) => Json(json!({ "ok": true, "removed": done.rows_affected() })).into_response(),
        Err(e) => db_error("clear", e),
    }
}

/// `GET /api/addons/:id/cloud/collect?offset=&limit=` — автору: что сохранили
/// пользователи в личных областях.
pub(crate) async fn collect_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Query(query): Query<CloudQuery>,
) -> Response {
    if let Err(resp) = check_id(&addon_id) {
        return resp;
    }
    if digest_revoked(&state, &headers, &addon_id).await {
        return revoked_error();
    }
    let owner = match registered_owner(&state, &addon_id).await {
        Ok(owner) => owner,
        Err(resp) => return resp,
    };
    if let Err(resp) = require_owner(&owner, &username, "Данные пользователей видит только автор аддона") {
        return resp;
    }
    if !within_rate(format!("c:{username}:{addon_id}"), COLLECTS_PER_MINUTE) {
        return rate_limited();
    }
    // Чтение без следа нельзя: не записали в журнал — не отдаём.
    if let Err(e) = audit(&state, &addon_id, &username, None, "*", "list").await {
        return db_error("audit", e);
    }
    let offset = query.offset.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(100).clamp(1, COLLECT_PAGE_MAX);
    let totals: Result<(i64, i64, i64), sqlx::Error> = sqlx::query_as(
        "SELECT COALESCE(SUM(size), 0), COUNT(*), COUNT(DISTINCT scope)
         FROM addon_cloud WHERE addon_id = ? AND scope LIKE 'u:%'",
    )
    .bind(&addon_id)
    .fetch_one(&state.db)
    .await;
    let rows: Result<Vec<(String, String, String, i64, i64)>, sqlx::Error> = sqlx::query_as(
        "SELECT substr(scope, 3), key, kind, size, updated_at FROM addon_cloud
         WHERE addon_id = ? AND scope LIKE 'u:%' ORDER BY scope, key LIMIT ? OFFSET ?",
    )
    .bind(&addon_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await;
    match (totals, rows) {
        (Ok((bytes, total, users)), Ok(rows)) => Json(json!({
            "bytes": bytes,
            "total": total,
            "users": users,
            "offset": offset,
            "items": rows
                .into_iter()
                .map(|(user, key, kind, size, updated)| {
                    json!({ "user": user, "key": key, "kind": kind, "size": size, "updatedAt": updated })
                })
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        (Err(e), _) | (_, Err(e)) => db_error("collect", e),
    }
}

/// `GET /api/addons/:id/cloud/collect/item?user=&key=` — автору: значение чужого ключа.
pub(crate) async fn collect_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
    Query(query): Query<CloudQuery>,
) -> Response {
    if let Err(resp) = check_id(&addon_id) {
        return resp;
    }
    if digest_revoked(&state, &headers, &addon_id).await {
        return revoked_error();
    }
    let owner = match registered_owner(&state, &addon_id).await {
        Ok(owner) => owner,
        Err(resp) => return resp,
    };
    if let Err(resp) = require_owner(&owner, &username, "Данные пользователей видит только автор аддона") {
        return resp;
    }
    if !within_rate(format!("c:{username}:{addon_id}"), COLLECTS_PER_MINUTE) {
        return rate_limited();
    }
    let user = query.user.unwrap_or_default();
    let key = query.key.unwrap_or_default();
    if user.is_empty() || user.len() > 64 || !valid_key(&key) {
        return key_error();
    }
    if let Err(e) = audit(&state, &addon_id, &username, Some(&user), &key, "read").await {
        return db_error("audit", e);
    }
    let row: Result<Option<(String, Vec<u8>)>, sqlx::Error> = sqlx::query_as(
        "SELECT kind, value FROM addon_cloud WHERE addon_id = ? AND scope = ? AND key = ?",
    )
    .bind(&addon_id)
    .bind(scope_column(Scope::User, &user))
    .bind(&key)
    .fetch_optional(&state.db)
    .await;
    match row {
        Ok(Some((kind, bytes))) => Json(value_json(&kind, &bytes)).into_response(),
        Ok(None) => addon_error(StatusCode::NOT_FOUND, "not_found", "Нет такого ключа"),
        Err(e) => db_error("collect_item", e),
    }
}

/// `GET /api/addons/:id/cloud/audit` — человеку: сколько раз автор читал его
/// данные в облаке этого аддона и когда в последний раз.
pub(crate) async fn my_audit(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Path(addon_id): Path<String>,
) -> Response {
    if let Err(resp) = check_id(&addon_id) {
        return resp;
    }
    // Чтения именно моих ключей и просмотры списков (имена и размеры всех).
    let row: Result<(i64, i64, Option<i64>), sqlx::Error> = sqlx::query_as(
        "SELECT COALESCE(SUM(action = 'read'), 0), COALESCE(SUM(action = 'list'), 0), MAX(at)
         FROM addon_cloud_audit
         WHERE addon_id = ? AND (subject = ? OR action = 'list')",
    )
    .bind(&addon_id)
    .bind(&username)
    .fetch_one(&state.db)
    .await;
    match row {
        Ok((reads, listings, last)) => Json(json!({
            "reads": reads,
            "listings": listings,
            "lastAt": last,
        }))
        .into_response(),
        Err(e) => db_error("audit", e),
    }
}
