//! User directory and contact list endpoints.

use crate::{AppState, AuthenticatedUser, ContactListResponse, ContactPayload, UserSearchQuery};
use axum::{
    extract::{Path as AxumPath, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tracing::{error, info};

const RELATIONS_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// Что известно о связи зрителя с одним пользователем: из этого строится
/// порядок подсказок.
#[derive(Default, Clone)]
pub(crate) struct Relation {
    /// Сообщений в личке за последние полгода (в обе стороны).
    dm: i64,
    /// Переводов ZaliCoin от зрителя этому пользователю.
    paid: i64,
    friend: bool,
    contact: bool,
    /// Общих серверов.
    shared: i64,
    /// Общих друзей.
    mutual: i64,
}

impl Relation {
    fn score(&self) -> f64 {
        // «Часто используемые тобой» важнее всего, затем друзья, затем общие друзья.
        let used = ((self.dm as f64).ln_1p() * 20.0) + ((self.paid as f64).ln_1p() * 24.0);
        let friend = if self.friend { 30.0 } else { 0.0 };
        let mutual = (self.mutual.min(10) as f64) * 4.0;
        let contact = if self.contact { 8.0 } else { 0.0 };
        let shared = (self.shared.min(5) as f64) * 2.0;
        used + friend + mutual + contact + shared
    }

    fn reason(&self) -> Option<String> {
        if self.dm >= 5 {
            Some("часто общаетесь".to_string())
        } else if self.paid >= 2 {
            Some("часто переводите".to_string())
        } else if self.friend {
            Some("друг".to_string())
        } else if self.mutual > 0 {
            Some(format!("общих друзей: {}", self.mutual))
        } else if self.contact {
            Some("в контактах".to_string())
        } else if self.shared > 0 {
            Some("общий сервер".to_string())
        } else if self.dm > 0 || self.paid > 0 {
            Some("вы общались".to_string())
        } else {
            None
        }
    }
}

async fn relations_of(
    pool: &SqlitePool,
    me: &str,
) -> Result<std::collections::HashMap<String, Relation>, sqlx::Error> {
    use std::collections::HashMap;
    let mut map: HashMap<String, Relation> = HashMap::new();
    let since = chrono::Utc::now() - chrono::Duration::days(180);

    let dm: Vec<(String, i64)> = sqlx::query_as(
        "SELECT CASE WHEN sender = ?1 THEN receiver ELSE sender END AS peer, COUNT(*) AS n
         FROM messages
         WHERE server_id IS NULL AND (sender = ?1 OR receiver = ?1) AND timestamp > ?2
         GROUP BY peer ORDER BY n DESC LIMIT 200",
    )
    .bind(me)
    .bind(since)
    .fetch_all(pool)
    .await?;
    for (peer, n) in dm {
        map.entry(peer).or_default().dm = n;
    }

    let paid: Vec<(String, i64)> = sqlx::query_as(
        "SELECT to_user, COUNT(*) FROM coin_transactions WHERE from_user = ? GROUP BY to_user LIMIT 200",
    )
    .bind(me)
    .fetch_all(pool)
    .await?;
    for (peer, n) in paid {
        map.entry(peer).or_default().paid = n;
    }

    let friends: Vec<String> = sqlx::query_scalar(
        "SELECT CASE WHEN user_low = ?1 THEN user_high ELSE user_low END
         FROM friend_links WHERE user_low = ?1 OR user_high = ?1 LIMIT 500",
    )
    .bind(me)
    .fetch_all(pool)
    .await?;
    for peer in friends {
        map.entry(peer).or_default().friend = true;
    }

    let contacts: Vec<String> =
        sqlx::query_scalar("SELECT contact FROM contacts WHERE owner = ? LIMIT 500")
            .bind(me)
            .fetch_all(pool)
            .await?;
    for peer in contacts {
        map.entry(peer).or_default().contact = true;
    }

    let shared: Vec<(String, i64)> = sqlx::query_as(
        "SELECT m2.username, COUNT(*) FROM server_members m1
         JOIN server_members m2 ON m1.server_id = m2.server_id
         WHERE m1.username = ?1 AND m2.username != ?1
         GROUP BY m2.username LIMIT 500",
    )
    .bind(me)
    .fetch_all(pool)
    .await?;
    for (peer, n) in shared {
        map.entry(peer).or_default().shared = n;
    }

    let mutual: Vec<(String, i64)> = sqlx::query_as(
        "WITH mine AS (
             SELECT CASE WHEN user_low = ?1 THEN user_high ELSE user_low END AS f
             FROM friend_links WHERE user_low = ?1 OR user_high = ?1
         )
         SELECT CASE WHEN fl.user_low = mine.f THEN fl.user_high ELSE fl.user_low END AS other, COUNT(*) AS n
         FROM friend_links fl JOIN mine ON fl.user_low = mine.f OR fl.user_high = mine.f
         GROUP BY other HAVING other != ?1
         ORDER BY n DESC LIMIT 300",
    )
    .bind(me)
    .fetch_all(pool)
    .await?;
    for (peer, n) in mutual {
        map.entry(peer).or_default().mutual = n;
    }
    map.remove(me);
    Ok(map)
}

/// Связи зрителя с кешем на несколько секунд: набор в поле шлёт запрос на каждую
/// букву, а считаются они агрегатами по сообщениям и друзьям.
async fn cached_relations(
    state: &AppState,
    me: &str,
) -> Result<Arc<std::collections::HashMap<String, Relation>>, sqlx::Error> {
    if let Some(hit) = state.suggest_relations.get(me) {
        if hit.0.elapsed() < RELATIONS_TTL {
            return Ok(hit.1.clone());
        }
    }
    let fresh = Arc::new(relations_of(&state.db, me).await?);
    if state.suggest_relations.len() > 2000 {
        state.suggest_relations.retain(|_, entry| entry.0.elapsed() < RELATIONS_TTL);
    }
    state
        .suggest_relations
        .insert(me.to_string(), (std::time::Instant::now(), fresh.clone()));
    Ok(fresh)
}

/// Какие из имён есть в таблице пользователей — одним запросом.
async fn existing_users(
    pool: &SqlitePool,
    names: &[String],
) -> Result<std::collections::HashSet<String>, sqlx::Error> {
    if names.is_empty() {
        return Ok(std::collections::HashSet::new());
    }
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT username FROM users WHERE username IN (");
    {
        let mut separated = builder.separated(", ");
        for name in names {
            separated.push_bind(name);
        }
    }
    builder.push(")");
    let rows: Vec<String> = builder.build_query_scalar().fetch_all(pool).await?;
    Ok(rows.into_iter().collect())
}

pub(crate) struct UserSuggestion {
    pub(crate) username: String,
    pub(crate) reason: Option<String>,
}

/// Подсказки имён: пустой запрос — те, с кем у зрителя есть связь, по убыванию
/// «насколько часто он ими пользуется»; непустой — совпадения по имени, у которых
/// связь поднимает выше (точное совпадение — всегда первым).
async fn rank_users(
    state: &AppState,
    me: &str,
    query: &str,
    limit: usize,
    fill_alphabetical: bool,
) -> Result<Vec<UserSuggestion>, sqlx::Error> {
    let pool = &state.db;
    let relations = cached_relations(state, me).await?;
    let mut scored: Vec<(f64, String, Option<String>)> = Vec::new();

    if query.is_empty() {
        let mut names: Vec<(&String, f64)> = relations.iter().map(|(n, r)| (n, r.score())).collect();
        names.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(b.0)));
        // Берём с запасом: часть имён в сообщениях могла уже не существовать.
        for (name, score) in names.into_iter().take(limit * 3 + 10) {
            if score > 0.0 {
                scored.push((score, name.clone(), relations[name].reason()));
            }
        }
    } else {
        let like = format!("%{}%", query);
        // Точное совпадение и префикс — первыми, иначе они могли бы не попасть в 100 строк.
        let mut found: Vec<String> = sqlx::query_scalar(
            "SELECT username FROM users WHERE lower(username) LIKE ?1 AND username != ?2
             ORDER BY (lower(username) = ?3) DESC, (lower(username) LIKE ?4) DESC, username LIMIT 100",
        )
        .bind(like)
        .bind(me)
        .bind(query)
        .bind(format!("{}%", query))
        .fetch_all(pool)
        .await?;
        // Люди со связью с зрителем не должны выпадать из-за урезанной выборки.
        let have: std::collections::HashSet<String> = found.iter().cloned().collect();
        let related: Vec<String> = relations
            .iter()
            .filter(|(name, rel)| {
                rel.score() > 0.0 && name.to_lowercase().contains(query) && !have.contains(*name)
            })
            .map(|(name, _)| name.clone())
            .collect();
        found.extend(existing_users(pool, &related).await?.into_iter());
        for name in found {
            let lower = name.to_lowercase();
            let rel = relations.get(&name).cloned().unwrap_or_default();
            let mut score = rel.score();
            if lower == query {
                score += 1000.0;
            } else if lower.starts_with(query) {
                score += 60.0;
            } else {
                score += 20.0;
            }
            scored.push((score, name, rel.reason()));
        }
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));

    // Имена из сообщений/переводов проверяем по таблице пользователей.
    let mut out: Vec<UserSuggestion> = Vec::new();
    if query.is_empty() {
        // Имена из сообщений существуют не обязательно: проверяем разом, не по одному.
        let candidates: Vec<String> = scored.iter().map(|(_, name, _)| name.clone()).collect();
        let existing = existing_users(pool, &candidates).await?;
        for (_, name, reason) in scored {
            if out.len() >= limit {
                break;
            }
            if existing.contains(&name) {
                out.push(UserSuggestion { username: name, reason });
            }
        }
        if fill_alphabetical && out.len() < limit {
            let have: std::collections::HashSet<String> = out.iter().map(|u| u.username.clone()).collect();
            let rest: Vec<String> = sqlx::query_scalar(
                "SELECT username FROM users WHERE username != ? ORDER BY username LIMIT ?",
            )
            .bind(me)
            .bind((limit * 2) as i64)
            .fetch_all(pool)
            .await?;
            for name in rest {
                if out.len() >= limit {
                    break;
                }
                if !have.contains(&name) {
                    out.push(UserSuggestion { username: name, reason: None });
                }
            }
        }
    } else {
        for (_, name, reason) in scored.into_iter().take(limit) {
            out.push(UserSuggestion { username: name, reason });
        }
    }
    Ok(out)
}

pub(crate) async fn get_users(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(me): AuthenticatedUser,
    Query(query): Query<UserSearchQuery>,
) -> impl IntoResponse {
    let query = query.q.unwrap_or_default().trim().to_lowercase();
    match rank_users(&state, &me, &query, 5, true).await {
        Ok(users) => {
            info!("API get_users query={} count={}", query, users.len());
            Json(users.into_iter().map(|u| u.username).collect::<Vec<String>>()).into_response()
        }
        Err(e) => {
            error!("Ошибка получения списка пользователей: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Debug, serde::Deserialize, Default)]
pub(crate) struct UserSuggestQuery {
    q: Option<String>,
    limit: Option<usize>,
}

/// Подсказки для полей ввода имени: с пояснением, почему этот человек в списке.
pub(crate) async fn suggest_users(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(me): AuthenticatedUser,
    Query(query): Query<UserSuggestQuery>,
) -> impl IntoResponse {
    let q = query.q.unwrap_or_default().trim().to_lowercase();
    let limit = query.limit.unwrap_or(6).clamp(1, 10);
    match rank_users(&state, &me, &q, limit, false).await {
        Ok(users) => Json(serde_json::json!({
            "users": users
                .into_iter()
                .map(|u| serde_json::json!({ "username": u.username, "reason": u.reason }))
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => {
            error!("Ошибка подсказок пользователей: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn get_contacts(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    info!("API get_contacts start owner={}", owner);
    let explicit_contacts = match sqlx::query_scalar::<_, String>(
        "SELECT contact FROM contacts WHERE owner = ? ORDER BY contact ASC",
    )
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(contacts) => contacts,
        Err(e) => {
            error!("Ошибка получения контактов для {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let message_contacts = match sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT CASE
            WHEN sender = ? THEN receiver
            ELSE sender
         END AS contact
         FROM messages
         WHERE server_id IS NULL
           AND (sender = ? OR receiver = ?)
           AND CASE WHEN sender = ? THEN receiver ELSE sender END <> ?",
    )
    .bind(&owner)
    .bind(&owner)
    .bind(&owner)
    .bind(&owner)
    .bind(&owner)
    .fetch_all(&state.db)
    .await
    {
        Ok(contacts) => contacts,
        Err(e) => {
            error!("Ошибка получения контактов из истории для {}: {}", owner, e);
            Vec::new()
        }
    };

    let mut contacts = explicit_contacts;
    for contact in message_contacts {
        if !contacts.iter().any(|existing| existing == &contact) {
            contacts.push(contact);
        }
    }
    contacts.sort();

    info!(
        "API get_contacts owner={} count={} contacts={}",
        owner,
        contacts.len(),
        contacts.join(",")
    );
    Json(ContactListResponse { contacts }).into_response()
}

pub(crate) async fn add_contact(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<ContactPayload>,
) -> impl IntoResponse {
    let contact = payload.username.trim();
    info!("API add_contact start owner={} contact={}", owner, contact);
    if contact.is_empty() {
        return (StatusCode::BAD_REQUEST, "Имя контакта не может быть пустым").into_response();
    }

    if contact == owner {
        return (StatusCode::BAD_REQUEST, "Нельзя добавить самого себя").into_response();
    }

    let exists =
        sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE username = ? LIMIT 1")
            .bind(contact)
            .fetch_optional(&state.db)
            .await;

    match exists {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "Пользователь не найден").into_response();
        }
        Err(e) => {
            error!("Ошибка проверки пользователя {}: {}", contact, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    if let Err(e) = sqlx::query("INSERT OR IGNORE INTO contacts (owner, contact) VALUES (?, ?)")
        .bind(&owner)
        .bind(contact)
        .execute(&state.db)
        .await
    {
        error!("Ошибка добавления контакта {} -> {}: {}", owner, contact, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    info!("API add_contact saved owner={} contact={}", owner, contact);

    get_contacts(axum::extract::State(state), AuthenticatedUser(owner))
        .await
        .into_response()
}

pub(crate) async fn delete_contact(
    AxumPath(username): AxumPath<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
) -> impl IntoResponse {
    info!(
        "API delete_contact start owner={} contact={}",
        owner, username
    );
    if let Err(e) = sqlx::query("DELETE FROM contacts WHERE owner = ? AND contact = ?")
        .bind(&owner)
        .bind(&username)
        .execute(&state.db)
        .await
    {
        error!("Ошибка удаления контакта {} -> {}: {}", owner, username, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    info!(
        "API delete_contact removed owner={} contact={}",
        owner, username
    );

    get_contacts(axum::extract::State(state), AuthenticatedUser(owner))
        .await
        .into_response()
}

pub(crate) async fn contact_exists(
    pool: &SqlitePool,
    owner: &str,
    contact: &str,
) -> Result<bool, sqlx::Error> {
    let exists = sqlx::query_scalar::<_, String>(
        "SELECT contact FROM contacts WHERE owner = ? AND contact = ? LIMIT 1",
    )
    .bind(owner)
    .bind(contact)
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}
