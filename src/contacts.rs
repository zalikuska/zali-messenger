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

pub(crate) async fn get_users(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    _auth: AuthenticatedUser,
    Query(query): Query<UserSearchQuery>,
) -> impl IntoResponse {
    let query = query.q.unwrap_or_default().trim().to_lowercase();
    if query.len() < 3 {
        info!("API get_users short_query len={}", query.len());
        return Json(Vec::<String>::new()).into_response();
    }

    info!("API get_users start query={}", query);
    let like = format!("%{}%", query);
    match sqlx::query_scalar::<_, String>(
        "SELECT username FROM users WHERE lower(username) LIKE ? ORDER BY username LIMIT 50",
    )
    .bind(like)
    .fetch_all(&state.db)
    .await
    {
        Ok(users) => {
            info!("API get_users query={} count={}", query, users.len());
            Json(users).into_response()
        }
        Err(e) => {
            error!("Ошибка получения списка пользователей: {}", e);
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
