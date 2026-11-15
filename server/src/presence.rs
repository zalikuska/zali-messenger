//! «В сети» у собеседников: точка на аватарке в списке чатов и в шапке чата
//! (web/src/interface/presence.js). Своя точка (device_activity.js) — то же правило.
//!
//! - **В сети** — у человека есть живой сокет: запись присутствия (push.rs) с
//!   входящим кадром не старше `ONLINE_FRESH`. Все клиенты шлют свои пинги (браузер
//!   отвечает на Ping сервера раз в 20 с, Android — пинг раз в 25 с), так что
//!   полуоткрытый сокет ноутбука с закрытой крышкой гаснет за минуту, а не висит
//!   до таймаута TCP.
//! - **Неактивен** — в сети, но ни на одном устройстве давно ничего не делали:
//!   `idleMinutes` из `device_activity` (0, пока хоть одно устройство активно). Порог
//!   луны (15 минут) и её фазы решает клиент — так же, как для своей точки.
//! - **Кто видит.** Контакты (в любую сторону), собеседники по личке, друзья и
//!   участники общих серверов. Отношение симметрично, поэтому «кому разослать
//!   перемену» и «чей статус отдать» — один запрос (`presence_audience`). Всем
//!   авторизованным подряд не отдаём: по точке видно, когда человек у экрана.
//! - **Доставка.** Снимок — `GET /api/presence` (клиент берёт при подключении и раз в
//!   минуту: фазы луны и угасшие полуоткрытые сокеты). Переходы «вошёл», «вышел»,
//!   «вернулся после простоя» сервер рассылает сам кадром `user_presence`, чтобы
//!   точка загоралась сразу. Выход — с задержкой `OFFLINE_GRACE`: переподключение
//!   (закрыл старый сокет, открыл новый) не должно мигать точкой у всех.

use crate::{send_json_to_user, AppState, AuthenticatedUser};
use axum::{extract::State, response::IntoResponse, Json};
use serde_json::json;
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::warn;

/// Сокет считается живым, если входящий кадр был не позже этого.
const ONLINE_FRESH: Duration = Duration::from_secs(60);
/// Сколько ждать, прежде чем объявить «вышел»: переподключение укладывается.
const OFFLINE_GRACE: Duration = Duration::from_secs(8);
/// С какого простоя возвращение к устройству рассылается сразу: раньше клиент луны
/// не рисует, и кадр ничего бы не поменял.
pub(crate) const IDLE_NOTICE_MINUTES: i64 = 15;
/// Связи пользователя меняются редко, а спрашиваются на каждый опрос и каждую
/// перемену статуса.
const AUDIENCE_TTL: Duration = Duration::from_secs(60);
/// Потолок получателей одной рассылки — как у игрового статуса (activity.rs).
const MAX_VIEWERS: usize = 2000;

pub(crate) type AudienceCache = dashmap::DashMap<String, (Instant, Arc<HashSet<String>>)>;

/// Логины с живым сокетом — одним проходом по записям присутствия.
fn online_users(state: &AppState) -> HashSet<String> {
    state
        .push_presence
        .iter()
        .filter(|entry| entry.last_inbound.elapsed() <= ONLINE_FRESH)
        .map(|entry| entry.username.clone())
        .collect()
}

pub(crate) fn is_online(state: &AppState, username: &str) -> bool {
    state
        .push_presence
        .iter()
        .any(|entry| entry.username == username && entry.last_inbound.elapsed() <= ONLINE_FRESH)
}

/// Кто вправе видеть статус `username` (и чей статус вправе видеть он сам).
pub(crate) async fn presence_audience(state: &AppState, username: &str) -> Arc<HashSet<String>> {
    if let Some(hit) = state.presence_audience.get(username) {
        if hit.0.elapsed() < AUDIENCE_TTL {
            return hit.1.clone();
        }
    }
    let mut audience = crate::activity::related_users(state, username).await;
    match sqlx::query_scalar::<_, String>(
        "SELECT contact FROM contacts WHERE owner = ?1
         UNION SELECT owner FROM contacts WHERE contact = ?1
         UNION SELECT DISTINCT CASE WHEN sender = ?1 THEN receiver ELSE sender END
               FROM messages WHERE server_id IS NULL AND (sender = ?1 OR receiver = ?1)",
    )
    .bind(username)
    .fetch_all(&state.db)
    .await
    {
        Ok(peers) => audience.extend(peers),
        Err(e) => warn!("presence: contacts lookup failed user={} err={}", username, e),
    }
    audience.remove(username);
    let audience = Arc::new(audience);
    if state.presence_audience.len() > 5000 {
        state.presence_audience.retain(|_, entry| entry.0.elapsed() < AUDIENCE_TTL);
    }
    state
        .presence_audience
        .insert(username.to_string(), (Instant::now(), audience.clone()));
    audience
}

/// Разослать текущий статус `username` его аудитории, у кого есть сокет.
pub(crate) async fn publish_presence(state: &Arc<AppState>, username: &str) {
    let online = is_online(state, username);
    let idle = online.then(|| crate::device_activity::user_idle_minutes(state, username));
    let payload = json!({
        "type": "user_presence",
        "username": username,
        "online": online,
        "idleMinutes": idle,
    });
    let audience = presence_audience(state, username).await;
    let mut viewers: Vec<&String> = audience
        .iter()
        .filter(|viewer| {
            state
                .user_connections
                .get(viewer.as_str())
                .is_some_and(|conns| !conns.is_empty())
        })
        .collect();
    viewers.sort();
    viewers.truncate(MAX_VIEWERS);
    for viewer in viewers {
        send_json_to_user(state, viewer, payload.clone()).await;
    }
}

/// Сокет открылся: если человек до этого был не в сети — сообщить.
pub(crate) fn connection_opened(state: &Arc<AppState>, username: &str, was_online: bool) {
    if was_online {
        return;
    }
    let state = Arc::clone(state);
    let username = username.to_string();
    tokio::spawn(async move { publish_presence(&state, &username).await });
}

/// Сокет закрылся: через `OFFLINE_GRACE`, если других живых сокетов так и не
/// появилось, — «вышел».
pub(crate) fn connection_closed(state: &Arc<AppState>, username: &str) {
    if is_online(state, username) {
        return;
    }
    let state = Arc::clone(state);
    let username = username.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(OFFLINE_GRACE).await;
        if !is_online(&state, &username) {
            publish_presence(&state, &username).await;
        }
    });
}

/// `GET /api/presence` — кто из тех, кого зритель вправе видеть, сейчас в сети.
/// Не в сети — нет в ответе.
pub(crate) async fn get_presence(
    AuthenticatedUser(viewer): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let mut online = online_users(&state);
    online.remove(&viewer);
    let mut users = serde_json::Map::new();
    if !online.is_empty() {
        let audience = presence_audience(&state, &viewer).await;
        for name in online {
            if audience.contains(&name) {
                let idle = crate::device_activity::user_idle_minutes(&state, &name);
                users.insert(name, json!({ "idleMinutes": idle }));
            }
        }
    }
    Json(json!({ "users": users }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_app_state, register_connection_presence, Config};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    async fn state() -> Arc<AppState> {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("zali-presence-test-{}-{}", std::process::id(), n));
        build_app_state(dir, Config::from_env()).await
    }

    #[tokio::test]
    async fn online_needs_a_fresh_socket() {
        let state = state().await;
        assert!(!is_online(&state, "alice"));
        let id = register_connection_presence(&state, "alice");
        assert!(is_online(&state, "alice"));
        state.push_presence.get_mut(&id).unwrap().last_inbound =
            Instant::now() - ONLINE_FRESH - Duration::from_secs(1);
        assert!(!is_online(&state, "alice"), "полуоткрытый сокет не держит «в сети»");
    }

    #[tokio::test]
    async fn audience_is_contacts_dm_peers_both_ways() {
        let state = state().await;
        sqlx::query("INSERT INTO contacts (owner, contact) VALUES ('alice', 'bob')")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(presence_audience(&state, "alice").await.contains("bob"));
        // Обратная сторона: bob видит alice, раз она добавила его.
        assert!(presence_audience(&state, "bob").await.contains("alice"));
        assert!(!presence_audience(&state, "carol").await.contains("alice"));
    }
}
