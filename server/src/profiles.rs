//! Публичные профили пользователей: карточка профиля, подписки (follow),
//! дружба, комментарии и векторные автографы на стене.
//!
//! Что здесь важно понимать:
//!
//! - **Аудитория — один общий тип для всех разрешений.** Кто может
//!   комментировать, кто может оставлять автограф и чьи автографы одобряются
//!   автоматически — это три независимые настройки, но выбор в каждой один и
//!   тот же (`Audience`). Одна функция `audience_allows` решает их все, иначе
//!   три копии одной проверки неизбежно разъехались бы (как разъехались бы
//!   `isPoliteVoicePeer`/`shouldInitiateVoiceOffer`, см. CLAUDE.md).
//!
//! - **Автографы хранятся вектором, а не картинкой.** В базе лежит JSON со
//!   списком штрихов (`d` в синтаксисе SVG path, цвет, толщина) и положение
//!   на стене в **долях** ширины/высоты, а не в пикселях. Поэтому стена
//!   одинаково выглядит на телефоне и на 5K-мониторе, а автограф можно
//!   отмасштабировать без потери качества. Растр сюда не принимается вообще.
//!
//! - **`d` валидируется на сервере, а не только экранируется на клиенте.**
//!   Клиент подставляет строку прямо в атрибут `<path d="...">`, поэтому
//!   допускается только алфавит команд SVG-пути и числа. Экранирование на
//!   клиенте остаётся (оно и есть основная защита), но пускать в базу заведомо
//!   негодную строку незачем: один плохой клиент — и она разъедется по всем
//!   зрителям стены.
//!
//! - **Дружба хранится нормализованной парой** (`user_low`/`user_high`,
//!   лексикографически), а не двумя строками. Две строки пришлось бы держать
//!   согласованными при каждом удалении, и рассинхрон дал бы «друг у одного,
//!   не друг у другого» — состояние, из которого UI не выбирается.

use crate::{
    contact_exists, is_valid_username, send_payload_to_user, trim_limited, AppState,
    AuthenticatedUser,
};
use axum::{
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use std::sync::Arc;
use tracing::{error, info};
use uuid::Uuid;

// ============================================================
// ЛИМИТЫ
// ============================================================

const MAX_DISPLAY_NAME: usize = 64;
const MAX_BIO: usize = 600;
const MAX_STATUS: usize = 120;
const MAX_LOCATION: usize = 64;
const MAX_LINK_LABEL: usize = 48;
const MAX_LINK_URL: usize = 300;
const MAX_LINKS: usize = 6;
const MAX_COMMENT: usize = 2000;
const MAX_COMMENTS_PAGE: i64 = 200;
const MAX_REQUEST_MESSAGE: usize = 300;

/// Потолки на один автограф. Стена рендерится целиком в один inline-SVG, так что
/// «нарисовал полчаса без отрыва» не должен превращаться в мегабайтный документ,
/// который повесит вкладку каждому зрителю.
const MAX_STROKES: usize = 400;
const MAX_PATH_CHARS: usize = 64000;
const MAX_AUTOGRAPH_CHARS: usize = 200_000;
const MAX_WALL_AUTOGRAPHS: i64 = 300;

// ============================================================
// АУДИТОРИЯ
// ============================================================

/// Кому что-то разрешено. Владелец профиля выбирает это значение в трёх местах
/// (комментарии, право оставить автограф, автоодобрение автографов), поэтому
/// разбор и проверка живут в одном месте.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Audience {
    /// Любой авторизованный пользователь.
    Anyone,
    /// Контакты владельца профиля — то есть те, кого владелец добавил себе сам.
    Contacts,
    /// Те, кто подписан на владельца.
    Followers,
    /// Взаимно подтверждённые друзья.
    Friends,
    /// Никто, кроме самого владельца. Для автоодобрения это и есть режим
    /// «одобрять руками».
    Nobody,
}

impl Audience {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "anyone" | "all" | "everyone" => Some(Audience::Anyone),
            "contacts" => Some(Audience::Contacts),
            "followers" => Some(Audience::Followers),
            "friends" => Some(Audience::Friends),
            // `manual` — это название той же настройки со стороны автографов:
            // «никто автоматически, решаю сам».
            "nobody" | "manual" | "none" => Some(Audience::Nobody),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Audience::Anyone => "anyone",
            Audience::Contacts => "contacts",
            Audience::Followers => "followers",
            Audience::Friends => "friends",
            Audience::Nobody => "nobody",
        }
    }
}

/// Лексикографически упорядоченная пара — канонический ключ дружбы.
fn friend_pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

pub(crate) async fn is_following(
    pool: &SqlitePool,
    follower: &str,
    target: &str,
) -> Result<bool, sqlx::Error> {
    let found = sqlx::query_scalar::<_, String>(
        "SELECT follower FROM user_follows WHERE follower = ? AND target = ? LIMIT 1",
    )
    .bind(follower)
    .bind(target)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

pub(crate) async fn are_friends(
    pool: &SqlitePool,
    a: &str,
    b: &str,
) -> Result<bool, sqlx::Error> {
    let (low, high) = friend_pair(a, b);
    let found = sqlx::query_scalar::<_, String>(
        "SELECT user_low FROM friend_links WHERE user_low = ? AND user_high = ? LIMIT 1",
    )
    .bind(low)
    .bind(high)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

/// Единственная точка, отвечающая на вопрос «можно ли зрителю `viewer` то, что
/// владелец `owner` открыл аудитории `audience`».
///
/// Владелец всегда проходит любую проверку: настройка ограничивает чужих, а не
/// его самого (иначе `Nobody` заперло бы человека на собственной стене).
async fn audience_allows(
    pool: &SqlitePool,
    owner: &str,
    viewer: &str,
    audience: Audience,
) -> Result<bool, sqlx::Error> {
    if owner == viewer {
        return Ok(true);
    }
    match audience {
        Audience::Anyone => Ok(true),
        Audience::Contacts => contact_exists(pool, owner, viewer).await,
        Audience::Followers => is_following(pool, viewer, owner).await,
        Audience::Friends => are_friends(pool, owner, viewer).await,
        Audience::Nobody => Ok(false),
    }
}

// ============================================================
// DTO
// ============================================================

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProfileLink {
    label: String,
    url: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProfileLinkInput {
    #[serde(default)]
    label: String,
    #[serde(default)]
    url: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ProfileResponse {
    username: String,
    #[serde(rename = "displayName")]
    display_name: String,
    bio: String,
    status: String,
    location: String,
    links: Vec<ProfileLink>,
    #[serde(rename = "accentColor")]
    accent_color: String,
    #[serde(rename = "commentPolicy")]
    comment_policy: String,
    #[serde(rename = "autographPolicy")]
    autograph_policy: String,
    #[serde(rename = "autographAutoApprove")]
    autograph_auto_approve: String,
    followers: i64,
    following: i64,
    friends: i64,
    #[serde(rename = "isSelf")]
    is_self: bool,
    #[serde(rename = "isFollowing")]
    is_following: bool,
    #[serde(rename = "followsYou")]
    follows_you: bool,
    #[serde(rename = "isContact")]
    is_contact: bool,
    #[serde(rename = "isFriend")]
    is_friend: bool,
    /// `null`, `"incoming"` или `"outgoing"` — только для заявок в состоянии
    /// `pending`. Отклонённая заявка не показывается вовсе: она не блокирует
    /// повторную отправку и в UI была бы просто шумом.
    #[serde(rename = "friendRequest")]
    friend_request: Option<FriendRequestSummary>,
    #[serde(rename = "canComment")]
    can_comment: bool,
    #[serde(rename = "canAutograph")]
    can_autograph: bool,
    /// Сколько автографов ждёт решения. Владельцу — его собственная очередь,
    /// всем остальным всегда 0 (чужая очередь модерации не их дело).
    #[serde(rename = "pendingAutographs")]
    pending_autographs: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct FriendRequestSummary {
    id: String,
    direction: &'static str,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProfileUpdatePayload {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    bio: Option<String>,
    status: Option<String>,
    location: Option<String>,
    links: Option<Vec<ProfileLinkInput>>,
    #[serde(rename = "accentColor")]
    accent_color: Option<String>,
    #[serde(rename = "commentPolicy")]
    comment_policy: Option<String>,
    #[serde(rename = "autographPolicy")]
    autograph_policy: Option<String>,
    #[serde(rename = "autographAutoApprove")]
    autograph_auto_approve: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ProfileCommentResponse {
    id: String,
    author: String,
    body: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "canDelete")]
    can_delete: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CommentPayload {
    body: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct AutographStroke {
    d: String,
    color: String,
    width: f64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AutographStrokeInput {
    d: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    width: f64,
}

#[derive(Debug, Serialize)]
pub(crate) struct AutographResponse {
    id: String,
    author: String,
    strokes: Vec<AutographStroke>,
    /// Собственная система координат рисунка (`"0 0 W H"`). Положение на стене
    /// задаётся отдельно долями — так один и тот же рисунок можно двигать и
    /// масштабировать, не трогая штрихи.
    #[serde(rename = "viewBox")]
    view_box: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    status: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "canRemove")]
    can_remove: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AutographPayload {
    strokes: Vec<AutographStrokeInput>,
    #[serde(rename = "viewBox")]
    view_box: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    rotation: f64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ModerationPayload {
    action: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FriendRequestPayload {
    #[serde(rename = "to")]
    to: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct FriendRequestRow {
    id: String,
    requester: String,
    target: String,
    message: String,
    #[serde(rename = "createdAt")]
    created_at: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct FriendRequestsResponse {
    incoming: Vec<FriendRequestRow>,
    outgoing: Vec<FriendRequestRow>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AutographListQuery {
    status: Option<String>,
}

// ============================================================
// ЧТЕНИЕ ПРОФИЛЯ
// ============================================================

/// Профиль в том виде, в каком он лежит в базе. Строка может отсутствовать —
/// профиль создаётся лениво при первом сохранении, а до этого отдаются
/// дефолты, чтобы «ещё ничего не заполнил» и «нет такого пользователя»
/// не путались между собой.
struct StoredProfile {
    display_name: String,
    bio: String,
    status: String,
    location: String,
    links: Vec<ProfileLink>,
    accent_color: String,
    comment_policy: Audience,
    autograph_policy: Audience,
    autograph_auto_approve: Audience,
}

impl Default for StoredProfile {
    fn default() -> Self {
        Self {
            display_name: String::new(),
            bio: String::new(),
            status: String::new(),
            location: String::new(),
            links: Vec::new(),
            accent_color: String::new(),
            comment_policy: Audience::Anyone,
            autograph_policy: Audience::Anyone,
            // По умолчанию — ручное одобрение. Стена видна всем, и молча
            // публиковать на ней чужой рисунок без ведома владельца — не то
            // умолчание, которое стоит выбирать за человека.
            autograph_auto_approve: Audience::Nobody,
        }
    }
}

fn parse_links(raw: &str) -> Vec<ProfileLink> {
    serde_json::from_str::<Vec<serde_json::Value>>(raw)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let label = item.get("label")?.as_str().unwrap_or("").to_string();
            let url = item.get("url")?.as_str().unwrap_or("").to_string();
            if url.is_empty() {
                return None;
            }
            Some(ProfileLink { label, url })
        })
        .collect()
}

async fn load_profile(pool: &SqlitePool, username: &str) -> Result<StoredProfile, sqlx::Error> {
    let row = sqlx::query(
        "SELECT display_name, bio, status, location, links, accent_color,
                comment_policy, autograph_policy, autograph_auto_approve
         FROM user_profiles WHERE username = ? LIMIT 1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(StoredProfile::default());
    };

    let defaults = StoredProfile::default();
    Ok(StoredProfile {
        display_name: row.try_get::<String, _>("display_name").unwrap_or_default(),
        bio: row.try_get::<String, _>("bio").unwrap_or_default(),
        status: row.try_get::<String, _>("status").unwrap_or_default(),
        location: row.try_get::<String, _>("location").unwrap_or_default(),
        links: parse_links(&row.try_get::<String, _>("links").unwrap_or_default()),
        accent_color: row.try_get::<String, _>("accent_color").unwrap_or_default(),
        comment_policy: Audience::parse(&row.try_get::<String, _>("comment_policy").unwrap_or_default())
            .unwrap_or(defaults.comment_policy),
        autograph_policy: Audience::parse(
            &row.try_get::<String, _>("autograph_policy").unwrap_or_default(),
        )
        .unwrap_or(defaults.autograph_policy),
        autograph_auto_approve: Audience::parse(
            &row.try_get::<String, _>("autograph_auto_approve")
                .unwrap_or_default(),
        )
        .unwrap_or(defaults.autograph_auto_approve),
    })
}

async fn user_exists(pool: &SqlitePool, username: &str) -> Result<bool, sqlx::Error> {
    let found = sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE username = ? LIMIT 1")
        .bind(username)
        .fetch_optional(pool)
        .await?;
    Ok(found.is_some())
}

async fn count_scalar(pool: &SqlitePool, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(sql)
        .bind(bind)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
}

async fn build_profile_response(
    state: &Arc<AppState>,
    owner: &str,
    viewer: &str,
) -> Result<ProfileResponse, sqlx::Error> {
    let pool = &state.db;
    let profile = load_profile(pool, owner).await?;

    let followers = count_scalar(
        pool,
        "SELECT COUNT(*) FROM user_follows WHERE target = ?",
        owner,
    )
    .await;
    let following = count_scalar(
        pool,
        "SELECT COUNT(*) FROM user_follows WHERE follower = ?",
        owner,
    )
    .await;
    let friends = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM friend_links WHERE user_low = ? OR user_high = ?",
    )
    .bind(owner)
    .bind(owner)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    let is_self = owner == viewer;
    let is_friend = are_friends(pool, owner, viewer).await.unwrap_or(false);

    let friend_request = if is_self || is_friend {
        None
    } else {
        let outgoing = sqlx::query_scalar::<_, String>(
            "SELECT id FROM friend_requests WHERE requester = ? AND target = ? AND status = 'pending' LIMIT 1",
        )
        .bind(viewer)
        .bind(owner)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        match outgoing {
            Some(id) => Some(FriendRequestSummary {
                id,
                direction: "outgoing",
            }),
            None => sqlx::query_scalar::<_, String>(
                "SELECT id FROM friend_requests WHERE requester = ? AND target = ? AND status = 'pending' LIMIT 1",
            )
            .bind(owner)
            .bind(viewer)
            .fetch_optional(pool)
            .await
            .unwrap_or(None)
            .map(|id| FriendRequestSummary {
                id,
                direction: "incoming",
            }),
        }
    };

    let pending_autographs = if is_self {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM profile_autographs WHERE profile_username = ? AND status = 'pending'",
        )
        .bind(owner)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
    } else {
        0
    };

    Ok(ProfileResponse {
        username: owner.to_string(),
        display_name: profile.display_name,
        bio: profile.bio,
        status: profile.status,
        location: profile.location,
        links: profile.links,
        accent_color: profile.accent_color,
        comment_policy: profile.comment_policy.as_str().to_string(),
        autograph_policy: profile.autograph_policy.as_str().to_string(),
        autograph_auto_approve: profile.autograph_auto_approve.as_str().to_string(),
        followers,
        following,
        friends,
        is_self,
        is_following: is_following(pool, viewer, owner).await.unwrap_or(false),
        follows_you: is_following(pool, owner, viewer).await.unwrap_or(false),
        is_contact: contact_exists(pool, owner, viewer).await.unwrap_or(false),
        is_friend,
        friend_request,
        can_comment: audience_allows(pool, owner, viewer, profile.comment_policy)
            .await
            .unwrap_or(false),
        can_autograph: audience_allows(pool, owner, viewer, profile.autograph_policy)
            .await
            .unwrap_or(false),
        pending_autographs,
    })
}

pub(crate) async fn get_profile(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(viewer): AuthenticatedUser,
) -> impl IntoResponse {
    let owner = trim_limited(&username, 64);
    if owner.is_empty() {
        return (StatusCode::BAD_REQUEST, "Имя пользователя обязательно").into_response();
    }

    match user_exists(&state.db, &owner).await {
        Ok(true) => {}
        Ok(false) => return (StatusCode::NOT_FOUND, "Пользователь не найден").into_response(),
        Err(e) => {
            error!("Ошибка проверки пользователя {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    match build_profile_response(&state, &owner, &viewer).await {
        Ok(profile) => Json(profile).into_response(),
        Err(e) => {
            error!("Ошибка сборки профиля {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ============================================================
// РЕДАКТИРОВАНИЕ СВОЕГО ПРОФИЛЯ
// ============================================================

/// Ссылки принимаются только с http/https-схемой. `javascript:` в href на
/// чужой странице — это XSS, и то, что клиент сейчас рендерит их через `esc()`,
/// не повод пускать такое в базу.
fn sanitize_links(input: Vec<ProfileLinkInput>) -> Vec<ProfileLink> {
    input
        .into_iter()
        .filter_map(|link| {
            let url = trim_limited(&link.url, MAX_LINK_URL);
            let lowered = url.to_lowercase();
            if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
                return None;
            }
            let label = trim_limited(&link.label, MAX_LINK_LABEL);
            Some(ProfileLink { label, url })
        })
        .take(MAX_LINKS)
        .collect()
}

/// Только `#rgb`/`#rrggbb`. Значение уходит в inline-стиль на клиенте, где
/// произвольная строка означала бы инъекцию CSS.
fn sanitize_color(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    let body = value.strip_prefix('#').unwrap_or("");
    let ok = (body.len() == 3 || body.len() == 6) && body.chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        format!("#{}", body.to_lowercase())
    } else {
        String::new()
    }
}

pub(crate) async fn update_profile(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(owner): AuthenticatedUser,
    Json(payload): Json<ProfileUpdatePayload>,
) -> impl IntoResponse {
    let current = match load_profile(&state.db, &owner).await {
        Ok(profile) => profile,
        Err(e) => {
            error!("Ошибка чтения профиля {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    // Пропущенное поле означает «не трогай», а не «очисти»: клиент шлёт только
    // изменённую секцию формы, и полная замена стирала бы всё остальное.
    let display_name = payload
        .display_name
        .map(|v| trim_limited(v, MAX_DISPLAY_NAME))
        .unwrap_or(current.display_name);
    let bio = payload
        .bio
        .map(|v| trim_limited(v, MAX_BIO))
        .unwrap_or(current.bio);
    let status = payload
        .status
        .map(|v| trim_limited(v, MAX_STATUS))
        .unwrap_or(current.status);
    let location = payload
        .location
        .map(|v| trim_limited(v, MAX_LOCATION))
        .unwrap_or(current.location);
    let links = payload.links.map(sanitize_links).unwrap_or(current.links);
    let accent_color = payload
        .accent_color
        .map(|v| sanitize_color(&v))
        .unwrap_or(current.accent_color);

    // Неизвестное значение политики — это ошибка запроса, а не повод молча
    // оставить старое: клиент решил бы, что настройка применилась.
    let comment_policy = match payload.comment_policy {
        Some(ref value) => match Audience::parse(value) {
            Some(audience) => audience,
            None => return (StatusCode::BAD_REQUEST, "Неизвестная аудитория комментариев").into_response(),
        },
        None => current.comment_policy,
    };
    let autograph_policy = match payload.autograph_policy {
        Some(ref value) => match Audience::parse(value) {
            Some(audience) => audience,
            None => return (StatusCode::BAD_REQUEST, "Неизвестная аудитория автографов").into_response(),
        },
        None => current.autograph_policy,
    };
    let autograph_auto_approve = match payload.autograph_auto_approve {
        Some(ref value) => match Audience::parse(value) {
            Some(audience) => audience,
            None => {
                return (StatusCode::BAD_REQUEST, "Неизвестный режим одобрения автографов")
                    .into_response()
            }
        },
        None => current.autograph_auto_approve,
    };

    let links_json = serde_json::to_string(
        &links
            .iter()
            .map(|link| json!({ "label": link.label, "url": link.url }))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());

    let result = sqlx::query(
        "INSERT INTO user_profiles
            (username, display_name, bio, status, location, links, accent_color,
             comment_policy, autograph_policy, autograph_auto_approve, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(username) DO UPDATE SET
            display_name = excluded.display_name,
            bio = excluded.bio,
            status = excluded.status,
            location = excluded.location,
            links = excluded.links,
            accent_color = excluded.accent_color,
            comment_policy = excluded.comment_policy,
            autograph_policy = excluded.autograph_policy,
            autograph_auto_approve = excluded.autograph_auto_approve,
            updated_at = CURRENT_TIMESTAMP",
    )
    .bind(&owner)
    .bind(&display_name)
    .bind(&bio)
    .bind(&status)
    .bind(&location)
    .bind(&links_json)
    .bind(&accent_color)
    .bind(comment_policy.as_str())
    .bind(autograph_policy.as_str())
    .bind(autograph_auto_approve.as_str())
    .execute(&state.db)
    .await;

    if let Err(e) = result {
        error!("Ошибка сохранения профиля {}: {}", owner, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    info!("API update_profile saved owner={}", owner);
    match build_profile_response(&state, &owner, &owner).await {
        Ok(profile) => Json(profile).into_response(),
        Err(e) => {
            error!("Ошибка сборки профиля после сохранения {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ============================================================
// ПОДПИСКИ
// ============================================================

pub(crate) async fn follow_user(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(follower): AuthenticatedUser,
) -> impl IntoResponse {
    let target = trim_limited(&username, 64);
    if target == follower {
        return (StatusCode::BAD_REQUEST, "Нельзя подписаться на себя").into_response();
    }
    match user_exists(&state.db, &target).await {
        Ok(true) => {}
        Ok(false) => return (StatusCode::NOT_FOUND, "Пользователь не найден").into_response(),
        Err(e) => {
            error!("Ошибка проверки пользователя {}: {}", target, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    if let Err(e) = sqlx::query("INSERT OR IGNORE INTO user_follows (follower, target) VALUES (?, ?)")
        .bind(&follower)
        .bind(&target)
        .execute(&state.db)
        .await
    {
        error!("Ошибка подписки {} -> {}: {}", follower, target, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    info!("API follow_user {} -> {}", follower, target);
    notify_profile_event(&state, &target, "profile_follow", json!({ "from": follower })).await;

    match build_profile_response(&state, &target, &follower).await {
        Ok(profile) => Json(profile).into_response(),
        Err(e) => {
            error!("Ошибка сборки профиля {}: {}", target, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn unfollow_user(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(follower): AuthenticatedUser,
) -> impl IntoResponse {
    let target = trim_limited(&username, 64);
    if let Err(e) = sqlx::query("DELETE FROM user_follows WHERE follower = ? AND target = ?")
        .bind(&follower)
        .bind(&target)
        .execute(&state.db)
        .await
    {
        error!("Ошибка отписки {} -> {}: {}", follower, target, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    info!("API unfollow_user {} -> {}", follower, target);

    match build_profile_response(&state, &target, &follower).await {
        Ok(profile) => Json(profile).into_response(),
        Err(e) => {
            error!("Ошибка сборки профиля {}: {}", target, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn get_followers(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    _auth: AuthenticatedUser,
) -> impl IntoResponse {
    let target = trim_limited(&username, 64);
    let followers = sqlx::query_scalar::<_, String>(
        "SELECT follower FROM user_follows WHERE target = ? ORDER BY created_at DESC LIMIT 500",
    )
    .bind(&target)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let following = sqlx::query_scalar::<_, String>(
        "SELECT target FROM user_follows WHERE follower = ? ORDER BY created_at DESC LIMIT 500",
    )
    .bind(&target)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    Json(json!({ "followers": followers, "following": following })).into_response()
}

// ============================================================
// ДРУЖБА
// ============================================================

pub(crate) async fn get_friends(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(me): AuthenticatedUser,
) -> impl IntoResponse {
    let friends = sqlx::query_scalar::<_, String>(
        "SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END AS friend
         FROM friend_links WHERE user_low = ? OR user_high = ?
         ORDER BY created_at DESC",
    )
    .bind(&me)
    .bind(&me)
    .bind(&me)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    Json(json!({ "friends": friends })).into_response()
}

pub(crate) async fn remove_friend(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(me): AuthenticatedUser,
) -> impl IntoResponse {
    let other = trim_limited(&username, 64);
    let (low, high) = friend_pair(&me, &other);
    if let Err(e) = sqlx::query("DELETE FROM friend_links WHERE user_low = ? AND user_high = ?")
        .bind(&low)
        .bind(&high)
        .execute(&state.db)
        .await
    {
        error!("Ошибка удаления дружбы {} / {}: {}", me, other, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    info!("API remove_friend {} / {}", me, other);
    Json(json!({ "ok": true })).into_response()
}

pub(crate) async fn get_friend_requests(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(me): AuthenticatedUser,
) -> impl IntoResponse {
    let fetch = |sql: &'static str, bind: String| {
        let pool = state.db.clone();
        async move {
            sqlx::query_as::<_, (String, String, String, String, String)>(sql)
                .bind(bind)
                .fetch_all(&pool)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(
                    |(id, requester, target, message, created_at)| FriendRequestRow {
                        id,
                        requester,
                        target,
                        message,
                        created_at,
                    },
                )
                .collect::<Vec<_>>()
        }
    };

    let incoming = fetch(
        "SELECT id, requester, target, message, created_at FROM friend_requests
         WHERE target = ? AND status = 'pending' ORDER BY created_at DESC",
        me.clone(),
    )
    .await;
    let outgoing = fetch(
        "SELECT id, requester, target, message, created_at FROM friend_requests
         WHERE requester = ? AND status = 'pending' ORDER BY created_at DESC",
        me.clone(),
    )
    .await;

    Json(FriendRequestsResponse { incoming, outgoing }).into_response()
}

pub(crate) async fn create_friend_request(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(requester): AuthenticatedUser,
    Json(payload): Json<FriendRequestPayload>,
) -> impl IntoResponse {
    let target = trim_limited(&payload.to, 64);
    let message = trim_limited(&payload.message, MAX_REQUEST_MESSAGE);

    if target.is_empty() || !is_valid_username(&target) {
        return (StatusCode::BAD_REQUEST, "Некорректное имя пользователя").into_response();
    }
    if target == requester {
        return (StatusCode::BAD_REQUEST, "Нельзя дружить с самим собой").into_response();
    }
    match user_exists(&state.db, &target).await {
        Ok(true) => {}
        Ok(false) => return (StatusCode::NOT_FOUND, "Пользователь не найден").into_response(),
        Err(e) => {
            error!("Ошибка проверки пользователя {}: {}", target, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if are_friends(&state.db, &requester, &target).await.unwrap_or(false) {
        return (StatusCode::CONFLICT, "Вы уже друзья").into_response();
    }

    // Встречная заявка — это согласие обеих сторон, выраженное дважды. Плодить
    // из неё вторую заявку и требовать, чтобы кто-то ещё нажал «принять»,
    // бессмысленно: сразу оформляем дружбу.
    let counter = sqlx::query_scalar::<_, String>(
        "SELECT id FROM friend_requests WHERE requester = ? AND target = ? AND status = 'pending' LIMIT 1",
    )
    .bind(&target)
    .bind(&requester)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);

    if let Some(id) = counter {
        return match accept_friend_request_inner(&state, &id, &requester).await {
            Ok(_) => {
                notify_profile_event(
                    &state,
                    &target,
                    "friend_accepted",
                    json!({ "from": requester }),
                )
                .await;
                Json(json!({ "status": "accepted", "friend": target })).into_response()
            }
            Err(status) => status.into_response(),
        };
    }

    let id = Uuid::new_v4().to_string();
    let insert = sqlx::query(
        "INSERT INTO friend_requests (id, requester, target, status, message)
         VALUES (?, ?, ?, 'pending', ?)",
    )
    .bind(&id)
    .bind(&requester)
    .bind(&target)
    .bind(&message)
    .execute(&state.db)
    .await;

    match insert {
        Ok(_) => {}
        // Партиальный UNIQUE-индекс по (requester, target, status='pending'):
        // повторное нажатие «попроситься в друзья» не должно плодить заявки.
        Err(sqlx::Error::Database(_)) => {
            return (StatusCode::CONFLICT, "Заявка уже отправлена").into_response();
        }
        Err(e) => {
            error!("Ошибка создания заявки в друзья {} -> {}: {}", requester, target, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    info!("API create_friend_request {} -> {}", requester, target);
    notify_profile_event(
        &state,
        &target,
        "friend_request",
        json!({ "from": requester, "id": id }),
    )
    .await;

    Json(json!({ "status": "pending", "id": id })).into_response()
}

/// Общая часть «принять заявку»: используется и явным `accept`, и
/// автосведением встречных заявок в `create_friend_request`.
async fn accept_friend_request_inner(
    state: &Arc<AppState>,
    request_id: &str,
    actor: &str,
) -> Result<(String, String), StatusCode> {
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT requester, target, status FROM friend_requests WHERE id = ? LIMIT 1",
    )
    .bind(request_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        error!("Ошибка чтения заявки {}: {}", request_id, e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let Some((requester, target, status)) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    if status != "pending" {
        return Err(StatusCode::CONFLICT);
    }
    // Принять заявку может только тот, кому она адресована. Иначе отправитель
    // «принимал» бы собственную заявку и назначал себя в друзья кому угодно.
    if target != actor {
        return Err(StatusCode::FORBIDDEN);
    }

    let (low, high) = friend_pair(&requester, &target);
    let mut tx = state.db.begin().await.map_err(|e| {
        error!("Ошибка открытия транзакции дружбы: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    sqlx::query("UPDATE friend_requests SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
        .bind(request_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            error!("Ошибка обновления заявки {}: {}", request_id, e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    sqlx::query("INSERT OR IGNORE INTO friend_links (user_low, user_high) VALUES (?, ?)")
        .bind(&low)
        .bind(&high)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            error!("Ошибка создания дружбы {} / {}: {}", low, high, e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    tx.commit().await.map_err(|e| {
        error!("Ошибка коммита дружбы: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok((requester, target))
}

pub(crate) async fn respond_friend_request(
    AxumPath(request_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(actor): AuthenticatedUser,
    Json(payload): Json<ModerationPayload>,
) -> impl IntoResponse {
    match payload.action.trim() {
        "accept" => match accept_friend_request_inner(&state, &request_id, &actor).await {
            Ok((requester, _)) => {
                info!("API respond_friend_request accept id={} actor={}", request_id, actor);
                notify_profile_event(
                    &state,
                    &requester,
                    "friend_accepted",
                    json!({ "from": actor }),
                )
                .await;
                Json(json!({ "status": "accepted", "friend": requester })).into_response()
            }
            Err(status) => status.into_response(),
        },
        "decline" => {
            let updated = sqlx::query(
                "UPDATE friend_requests SET status = 'declined', responded_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND target = ? AND status = 'pending'",
            )
            .bind(&request_id)
            .bind(&actor)
            .execute(&state.db)
            .await;
            match updated {
                Ok(result) if result.rows_affected() > 0 => {
                    info!("API respond_friend_request decline id={}", request_id);
                    Json(json!({ "status": "declined" })).into_response()
                }
                Ok(_) => (StatusCode::NOT_FOUND, "Заявка не найдена").into_response(),
                Err(e) => {
                    error!("Ошибка отклонения заявки {}: {}", request_id, e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        // Отправитель отзывает собственную заявку.
        "cancel" => {
            let updated = sqlx::query(
                "DELETE FROM friend_requests WHERE id = ? AND requester = ? AND status = 'pending'",
            )
            .bind(&request_id)
            .bind(&actor)
            .execute(&state.db)
            .await;
            match updated {
                Ok(result) if result.rows_affected() > 0 => {
                    Json(json!({ "status": "cancelled" })).into_response()
                }
                Ok(_) => (StatusCode::NOT_FOUND, "Заявка не найдена").into_response(),
                Err(e) => {
                    error!("Ошибка отзыва заявки {}: {}", request_id, e);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        _ => (StatusCode::BAD_REQUEST, "Неизвестное действие").into_response(),
    }
}

// ============================================================
// КОММЕНТАРИИ
// ============================================================

pub(crate) async fn get_profile_comments(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(viewer): AuthenticatedUser,
) -> impl IntoResponse {
    let owner = trim_limited(&username, 64);
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT id, author, body, created_at FROM profile_comments
         WHERE profile_username = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(&owner)
    .bind(MAX_COMMENTS_PAGE)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(rows) => {
            let comments = rows
                .into_iter()
                .map(|(id, author, body, created_at)| ProfileCommentResponse {
                    // Удалять может автор комментария и владелец стены —
                    // ровно как с сообщениями в канале (см. can_delete_message).
                    can_delete: author == viewer || owner == viewer,
                    id,
                    author,
                    body,
                    created_at,
                })
                .collect::<Vec<_>>();
            Json(json!({ "comments": comments })).into_response()
        }
        Err(e) => {
            error!("Ошибка чтения комментариев {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn create_profile_comment(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(author): AuthenticatedUser,
    Json(payload): Json<CommentPayload>,
) -> impl IntoResponse {
    let owner = trim_limited(&username, 64);
    let body = trim_limited(&payload.body, MAX_COMMENT);
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Комментарий не может быть пустым").into_response();
    }
    match user_exists(&state.db, &owner).await {
        Ok(true) => {}
        Ok(false) => return (StatusCode::NOT_FOUND, "Пользователь не найден").into_response(),
        Err(e) => {
            error!("Ошибка проверки пользователя {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let profile = match load_profile(&state.db, &owner).await {
        Ok(profile) => profile,
        Err(e) => {
            error!("Ошибка чтения профиля {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // Проверка на сервере, а не только скрытая форма на клиенте: политика
    // «только друзья» ничего не стоит, если POST принимается от кого угодно.
    if !audience_allows(&state.db, &owner, &author, profile.comment_policy)
        .await
        .unwrap_or(false)
    {
        return (StatusCode::FORBIDDEN, "Комментарии закрыты для вас").into_response();
    }

    let id = Uuid::new_v4().to_string();
    if let Err(e) = sqlx::query(
        "INSERT INTO profile_comments (id, profile_username, author, body) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&owner)
    .bind(&author)
    .bind(&body)
    .execute(&state.db)
    .await
    {
        error!("Ошибка добавления комментария {} -> {}: {}", author, owner, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    info!("API create_profile_comment owner={} author={}", owner, author);
    notify_profile_event(
        &state,
        &owner,
        "profile_comment",
        json!({ "from": author, "id": id }),
    )
    .await;

    get_profile_comments(
        AxumPath(owner),
        State(state),
        AuthenticatedUser(author),
    )
    .await
    .into_response()
}

pub(crate) async fn delete_profile_comment(
    AxumPath(comment_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(actor): AuthenticatedUser,
) -> impl IntoResponse {
    let deleted = sqlx::query(
        "DELETE FROM profile_comments WHERE id = ? AND (author = ? OR profile_username = ?)",
    )
    .bind(&comment_id)
    .bind(&actor)
    .bind(&actor)
    .execute(&state.db)
    .await;

    match deleted {
        Ok(result) if result.rows_affected() > 0 => Json(json!({ "ok": true })).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, "Комментарий не найден").into_response(),
        Err(e) => {
            error!("Ошибка удаления комментария {}: {}", comment_id, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ============================================================
// АВТОГРАФЫ (векторная стена)
// ============================================================

/// Допускает только то, из чего состоит путь SVG: команды `MmLlHhVvCcSsQqTtAaZz`,
/// числа, разделители. Ничего похожего на кавычку или угловую скобку сюда не
/// пройдёт, поэтому строку нельзя использовать для выхода из атрибута.
fn is_safe_path_data(d: &str) -> bool {
    if d.is_empty() || d.len() > MAX_PATH_CHARS {
        return false;
    }
    d.chars().all(|c| {
        matches!(
            c,
            'M' | 'm' | 'L' | 'l' | 'H' | 'h' | 'V' | 'v' | 'C' | 'c' | 'S' | 's' | 'Q' | 'q'
                | 'T' | 't' | 'A' | 'a' | 'Z' | 'z'
        ) || c.is_ascii_digit()
            || matches!(c, '.' | ',' | ' ' | '-' | '+' | 'e' | 'E')
    })
}

/// `"0 0 W H"` и ничего больше: viewBox уходит в атрибут SVG.
fn is_safe_view_box(value: &str) -> bool {
    let parts: Vec<&str> = value.split_whitespace().collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            part.parse::<f64>()
                .map(|n| n.is_finite() && n.abs() <= 100_000.0)
                .unwrap_or(false)
        })
}

fn clamp_fraction(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    value.clamp(min, max)
}

fn sanitize_strokes(input: &[AutographStrokeInput]) -> Result<Vec<AutographStroke>, &'static str> {
    if input.is_empty() {
        return Err("Автограф пустой");
    }
    if input.len() > MAX_STROKES {
        return Err("Слишком много штрихов");
    }
    let mut total = 0usize;
    let mut strokes = Vec::with_capacity(input.len());
    for stroke in input {
        let d = stroke.d.trim();
        if !is_safe_path_data(d) {
            return Err("Некорректные данные штриха");
        }
        total += d.len();
        if total > MAX_AUTOGRAPH_CHARS {
            return Err("Автограф слишком большой");
        }
        let color = sanitize_color(&stroke.color);
        strokes.push(AutographStroke {
            d: d.to_string(),
            color: if color.is_empty() {
                "#cbff00".to_string()
            } else {
                color
            },
            width: clamp_fraction(stroke.width, 0.2, 40.0),
        });
    }
    Ok(strokes)
}

fn parse_strokes(raw: &str) -> Vec<AutographStroke> {
    serde_json::from_str::<Vec<serde_json::Value>>(raw)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let d = item.get("d")?.as_str()?.to_string();
            if !is_safe_path_data(&d) {
                return None;
            }
            Some(AutographStroke {
                d,
                color: item
                    .get("color")
                    .and_then(|c| c.as_str())
                    .map(sanitize_color)
                    .filter(|c| !c.is_empty())
                    .unwrap_or_else(|| "#cbff00".to_string()),
                width: item
                    .get("width")
                    .and_then(|w| w.as_f64())
                    .map(|w| clamp_fraction(w, 0.2, 40.0))
                    .unwrap_or(2.0),
            })
        })
        .collect()
}

pub(crate) async fn get_autographs(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(viewer): AuthenticatedUser,
    Query(query): Query<AutographListQuery>,
) -> impl IntoResponse {
    let owner = trim_limited(&username, 64);
    let requested = query.status.unwrap_or_else(|| "approved".to_string());
    let is_owner = owner == viewer;

    // Очередь модерации — приватная. Чужие неодобренные автографы не видны
    // никому, включая их авторов: одобрение — решение владельца стены, и
    // подглядывать за ним «а что там ещё висит» посторонним незачем.
    let status_filter = match requested.trim() {
        "pending" if is_owner => "pending",
        "all" if is_owner => "all",
        _ => "approved",
    };

    let rows = if status_filter == "all" {
        sqlx::query_as::<_, (String, String, String, String, f64, f64, f64, f64, f64, String, String)>(
            "SELECT id, author, paths, view_box, x, y, width, height, rotation, status, created_at
             FROM profile_autographs WHERE profile_username = ?
             ORDER BY created_at ASC LIMIT ?",
        )
        .bind(&owner)
        .bind(MAX_WALL_AUTOGRAPHS)
        .fetch_all(&state.db)
        .await
    } else {
        sqlx::query_as::<_, (String, String, String, String, f64, f64, f64, f64, f64, String, String)>(
            "SELECT id, author, paths, view_box, x, y, width, height, rotation, status, created_at
             FROM profile_autographs WHERE profile_username = ? AND status = ?
             ORDER BY created_at ASC LIMIT ?",
        )
        .bind(&owner)
        .bind(status_filter)
        .bind(MAX_WALL_AUTOGRAPHS)
        .fetch_all(&state.db)
        .await
    };

    match rows {
        Ok(rows) => {
            let autographs = rows
                .into_iter()
                .map(
                    |(id, author, paths, view_box, x, y, width, height, rotation, status, created_at)| {
                        AutographResponse {
                            strokes: parse_strokes(&paths),
                            can_remove: is_owner || author == viewer,
                            id,
                            author,
                            view_box,
                            x,
                            y,
                            width,
                            height,
                            rotation,
                            status,
                            created_at,
                        }
                    },
                )
                .collect::<Vec<_>>();
            Json(json!({ "autographs": autographs })).into_response()
        }
        Err(e) => {
            error!("Ошибка чтения автографов {}: {}", owner, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub(crate) async fn create_autograph(
    AxumPath(username): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(author): AuthenticatedUser,
    Json(payload): Json<AutographPayload>,
) -> impl IntoResponse {
    let owner = trim_limited(&username, 64);
    match user_exists(&state.db, &owner).await {
        Ok(true) => {}
        Ok(false) => return (StatusCode::NOT_FOUND, "Пользователь не найден").into_response(),
        Err(e) => {
            error!("Ошибка проверки пользователя {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let profile = match load_profile(&state.db, &owner).await {
        Ok(profile) => profile,
        Err(e) => {
            error!("Ошибка чтения профиля {}: {}", owner, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if !audience_allows(&state.db, &owner, &author, profile.autograph_policy)
        .await
        .unwrap_or(false)
    {
        return (StatusCode::FORBIDDEN, "Автографы закрыты для вас").into_response();
    }

    let strokes = match sanitize_strokes(&payload.strokes) {
        Ok(strokes) => strokes,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };

    let view_box = payload
        .view_box
        .as_deref()
        .map(str::trim)
        .filter(|v| is_safe_view_box(v))
        .unwrap_or("0 0 100 100")
        .to_string();

    // Положение и размер — доли стены, поэтому зажимаются в [0, 1]. Размер
    // отдельно не даёт схлопнуться в невидимую точку.
    let x = clamp_fraction(payload.x, 0.0, 1.0);
    let y = clamp_fraction(payload.y, 0.0, 1.0);
    let width = clamp_fraction(payload.width, 0.02, 1.0);
    let height = clamp_fraction(payload.height, 0.02, 1.0);
    let rotation = clamp_fraction(payload.rotation, -180.0, 180.0);

    // Автоодобрение — отдельная от «кто может оставить» настройка: можно
    // разрешить рисовать всем, но публиковать только автографы друзей.
    let auto_approved = audience_allows(&state.db, &owner, &author, profile.autograph_auto_approve)
        .await
        .unwrap_or(false);
    let status = if auto_approved { "approved" } else { "pending" };

    let paths_json = serde_json::to_string(
        &strokes
            .iter()
            .map(|s| json!({ "d": s.d, "color": s.color, "width": s.width }))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());

    let id = Uuid::new_v4().to_string();
    if let Err(e) = sqlx::query(
        "INSERT INTO profile_autographs
            (id, profile_username, author, paths, view_box, x, y, width, height, rotation, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&owner)
    .bind(&author)
    .bind(&paths_json)
    .bind(&view_box)
    .bind(x)
    .bind(y)
    .bind(width)
    .bind(height)
    .bind(rotation)
    .bind(status)
    .execute(&state.db)
    .await
    {
        error!("Ошибка сохранения автографа {} -> {}: {}", author, owner, e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    info!(
        "API create_autograph owner={} author={} status={}",
        owner, author, status
    );
    notify_profile_event(
        &state,
        &owner,
        "profile_autograph",
        json!({ "from": author, "id": id, "status": status }),
    )
    .await;

    Json(json!({ "id": id, "status": status })).into_response()
}

pub(crate) async fn moderate_autograph(
    AxumPath(autograph_id): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(actor): AuthenticatedUser,
    Json(payload): Json<ModerationPayload>,
) -> impl IntoResponse {
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT profile_username, author FROM profile_autographs WHERE id = ? LIMIT 1",
    )
    .bind(&autograph_id)
    .fetch_optional(&state.db)
    .await;

    let (owner, author) = match row {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "Автограф не найден").into_response(),
        Err(e) => {
            error!("Ошибка чтения автографа {}: {}", autograph_id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    match payload.action.trim() {
        "approve" => {
            if owner != actor {
                return (StatusCode::FORBIDDEN, "Это не ваша стена").into_response();
            }
            if let Err(e) = sqlx::query(
                "UPDATE profile_autographs SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
            )
            .bind(&autograph_id)
            .execute(&state.db)
            .await
            {
                error!("Ошибка одобрения автографа {}: {}", autograph_id, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            notify_profile_event(
                &state,
                &author,
                "autograph_approved",
                json!({ "wall": owner, "id": autograph_id }),
            )
            .await;
            Json(json!({ "status": "approved" })).into_response()
        }
        // Отклонение и удаление — одно и то же действие с точки зрения базы:
        // хранить отвергнутый рисунок незачем, а держать его в статусе
        // `rejected` означало бы, что автор может переспросить и увидеть, что
        // ему отказали именно сейчас.
        "reject" | "delete" => {
            if owner != actor && author != actor {
                return (StatusCode::FORBIDDEN, "Недостаточно прав").into_response();
            }
            if let Err(e) = sqlx::query("DELETE FROM profile_autographs WHERE id = ?")
                .bind(&autograph_id)
                .execute(&state.db)
                .await
            {
                error!("Ошибка удаления автографа {}: {}", autograph_id, e);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            Json(json!({ "status": "removed" })).into_response()
        }
        _ => (StatusCode::BAD_REQUEST, "Неизвестное действие").into_response(),
    }
}

// ============================================================
// УВЕДОМЛЕНИЯ
// ============================================================

/// Живое уведомление в WS. Best-effort: адресат может быть офлайн, и это
/// нормально — данные всё равно лежат в базе и подтянутся при следующем
/// открытии профиля. Ошибка отправки не должна валить сам запрос.
///
/// Клиенты, не знающие этих типов, их игнорируют: ветка доставки сообщения в
/// вебе требует ОТСУТСТВИЯ поля `type`, а нативные — наличия `id`/`filename`.
async fn notify_profile_event(
    state: &Arc<AppState>,
    username: &str,
    event_type: &str,
    mut payload: serde_json::Value,
) {
    if let Some(object) = payload.as_object_mut() {
        object.insert("type".to_string(), json!(event_type));
    }
    let Ok(text) = serde_json::to_string(&payload) else {
        return;
    };
    send_payload_to_user(state, username, text, event_type).await;
}
