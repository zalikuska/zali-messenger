//! Игровой статус «Играет в …».
//!
//! Что здесь важно понимать:
//!
//! - **Статус живёт только в памяти и принадлежит соединению, а не аккаунту.**
//!   Клиент присылает `client_activity` по своему сокету; запись лежит в
//!   `ConnectionPresence` (push.rs) рядом с отметкой «смотрю в приложение». У
//!   аккаунта может быть несколько сокетов (сообщения + голос, несколько
//!   устройств) — статус аккаунта это самая свежая запись среди его живых
//!   соединений. Закрылся сокет — запись ушла вместе с ним, ни БД, ни TTL, ни
//!   «призраков» после падения клиента.
//!
//! - **Сервер ничего не определяет сам.** Что запущена игра, знает только
//!   клиент (нативная оболочка читает процессы, JS применяет настройки
//!   приватности). Сюда приходит уже готовое «название + источник». Поэтому
//!   каждое поле санитизируется как недоверенный ввод: оно уйдёт всем зрителям
//!   и попадёт в их DOM.
//!
//! - **Зритель — друг или участник общего сервера.** Отношение симметрично, так
//!   что «кому разослать» и «чьи статусы показать при подключении» — один и тот
//!   же запрос (`related_users`). Раздавать статус вообще всем авторизованным
//!   нельзя: по нему видно, чем человек занят прямо сейчас.
//!
//! - **Рассылка только по изменению.** Клиент для надёжности повторяет текущий
//!   статус раз в ~25 с (новый сокет после реконнекта ничего не знает), и без
//!   сравнения до/после каждое повторение превращалось бы в рассылку на всех
//!   друзей и весь сервер.

use crate::{push::remove_connection_presence, send_json_to_user, AppState, AuthenticatedUser};
use axum::{extract::State, response::IntoResponse, Json};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::{info, warn};

const MAX_NAME_CHARS: usize = 64;
const MAX_ID_CHARS: usize = 64;
/// Потолок получателей одной рассылки. Публичный сервер на десятки тысяч человек
/// не должен превращать «запустил игру» в десятки тысяч кадров.
const MAX_VIEWERS: usize = 2000;
/// Чаще смена статуса одним соединением не принимается: настоящий запуск игры
/// происходит раз в минуты, а флуд из модифицированного клиента стоил бы серверу
/// запросов в БД на каждую смену. Потерянное из-за этого обновление догонит
/// повтор клиента.
const MIN_UPDATE_INTERVAL: Duration = Duration::from_secs(2);
/// `since` из будущего или старше недели — мусор; тогда берём «сейчас».
const MAX_SINCE_AGE_MS: i64 = 7 * 24 * 3600 * 1000;

const SOURCES: [&str; 3] = ["process", "steam", "manual"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct GameActivity {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) id: String,
    pub(crate) source: String,
    /// Unix-время начала, мс. Нужно зрителю для «играет 2 ч».
    pub(crate) since: i64,
    /// Показывать ли статус зрителям. Режим «в игре» (focus.rs) нужен серверу и
    /// у тех, кто своё имя игры никому показывать не хочет: тогда статус живёт
    /// только для решения об уведомлениях и никуда не рассылается. Клиент без
    /// этого поля (старый) присылал статус только при включённом показе.
    #[serde(skip)]
    pub(crate) shared: bool,
}

/// Статус соединения и когда его последний раз меняли.
#[derive(Debug, Clone)]
pub(crate) struct ConnectionActivity {
    pub(crate) activity: Option<GameActivity>,
    pub(crate) updated_at: Instant,
}

fn clean_text(raw: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut last_space = true;
    for ch in raw.chars() {
        let ch = if ch.is_control() || ch.is_whitespace() { ' ' } else { ch };
        if ch == ' ' {
            if last_space {
                continue;
            }
            last_space = true;
        } else {
            last_space = false;
        }
        out.push(ch);
        if out.chars().count() >= max_chars {
            break;
        }
    }
    out.trim().to_string()
}

/// Разбор поля `activity` из кадра `client_activity`. `None` — «ничего не
/// играет» (в том числе для любого непонятного значения: лучше не показывать,
/// чем показать мусор).
pub(crate) fn parse_activity(value: &Value, now_ms: i64) -> Option<GameActivity> {
    let object = value.as_object()?;
    if let Some(kind) = object.get("kind").and_then(Value::as_str) {
        if kind != "game" {
            return None;
        }
    }
    let name = clean_text(object.get("name").and_then(Value::as_str).unwrap_or(""), MAX_NAME_CHARS);
    if name.is_empty() {
        return None;
    }
    let id = clean_text(object.get("id").and_then(Value::as_str).unwrap_or(""), MAX_ID_CHARS);
    let source = object
        .get("source")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| SOURCES.contains(&s.as_str()))
        .unwrap_or_else(|| "process".to_string());
    let since = object
        .get("since")
        .and_then(Value::as_i64)
        .filter(|since| *since <= now_ms && now_ms - *since <= MAX_SINCE_AGE_MS)
        .unwrap_or(now_ms);
    let shared = object.get("share").and_then(Value::as_bool).unwrap_or(true);
    Some(GameActivity { name, id, source, since, shared })
}

/// То, что видят зрители: статус аккаунта, если он разрешил его показывать.
pub(crate) fn public_activity(state: &AppState, username: &str) -> Option<GameActivity> {
    user_activity(state, username).filter(|activity| activity.shared)
}

/// Статус аккаунта: самая свежая запись среди его соединений. Для решения об
/// уведомлениях (focus.rs); зрителям отдаётся только `public_activity`.
pub(crate) fn user_activity(state: &AppState, username: &str) -> Option<GameActivity> {
    state
        .push_presence
        .iter()
        .filter(|entry| entry.username == username)
        .filter_map(|entry| {
            entry
                .activity
                .as_ref()
                .and_then(|current| current.activity.clone().map(|a| (current.updated_at, a)))
        })
        .max_by_key(|(updated_at, _)| *updated_at)
        .map(|(_, activity)| activity)
}

/// Друзья и участники общих серверов. Отношение симметрично.
pub(crate) async fn related_users(state: &AppState, username: &str) -> HashSet<String> {
    let mut related: HashSet<String> = HashSet::new();
    match sqlx::query_scalar::<_, String>(
        "SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END
         FROM friend_links WHERE user_low = ? OR user_high = ?",
    )
    .bind(username)
    .bind(username)
    .bind(username)
    .fetch_all(&state.db)
    .await
    {
        Ok(friends) => related.extend(friends),
        Err(e) => warn!("activity: friends lookup failed user={} err={}", username, e),
    }
    match sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT other.username
         FROM server_members me
         JOIN server_members other ON other.server_id = me.server_id
         WHERE me.username = ? AND other.username <> ?",
    )
    .bind(username)
    .bind(username)
    .fetch_all(&state.db)
    .await
    {
        Ok(members) => related.extend(members),
        Err(e) => warn!("activity: co-members lookup failed user={} err={}", username, e),
    }
    related.remove(username);
    related
}

fn activity_payload(username: &str, activity: Option<&GameActivity>) -> Value {
    json!({
        "type": "user_activity",
        "username": username,
        "activity": activity,
    })
}

/// Разослать новое состояние `username` тем, кто его видит, и ему самому
/// (чтобы остальные его устройства показали то же самое).
async fn publish(state: &Arc<AppState>, username: &str, activity: Option<&GameActivity>) {
    let mut viewers: Vec<String> = related_users(state, username)
        .await
        .into_iter()
        .filter(|viewer| {
            state
                .user_connections
                .get(viewer)
                .map(|conns| !conns.is_empty())
                .unwrap_or(false)
        })
        .collect();
    viewers.sort();
    viewers.truncate(MAX_VIEWERS);
    viewers.push(username.to_string());
    let payload = activity_payload(username, activity);
    for viewer in viewers {
        send_json_to_user(state, &viewer, payload.clone()).await;
    }
}

/// Принять `client_activity` от соединения `connection_id`.
pub(crate) async fn set_connection_activity(
    state: &Arc<AppState>,
    connection_id: u64,
    username: &str,
    raw: &Value,
) {
    let now_ms = Utc::now().timestamp_millis();
    let next = parse_activity(raw, now_ms);
    let before = public_activity(state, username);
    let session_before = user_activity(state, username).is_some();
    {
        let Some(mut entry) = state.push_presence.get_mut(&connection_id) else {
            return;
        };
        let current = entry.activity.as_ref().and_then(|c| c.activity.clone());
        if current == next {
            // Повтор клиента — ничего не менять и никого не будить.
            return;
        }
        if let Some(previous) = entry.activity.as_ref() {
            if previous.updated_at.elapsed() < MIN_UPDATE_INTERVAL {
                return;
            }
        }
        entry.activity = Some(ConnectionActivity {
            activity: next,
            updated_at: Instant::now(),
        });
    }
    let after = public_activity(state, username);
    if before != after {
        info!(
            "[ACTIVITY] user={} game={:?}",
            username,
            after.as_ref().map(|a| a.name.as_str())
        );
        publish(state, username, after.as_ref()).await;
    }
    if session_before && user_activity(state, username).is_none() {
        crate::focus::on_session_ended(state, username);
    }
}

/// Сокет закрылся: убрать его запись присутствия и, если от этого поменялся
/// статус аккаунта, сообщить зрителям.
pub(crate) async fn connection_closed(state: &Arc<AppState>, connection_id: u64, username: &str) {
    let before = public_activity(state, username);
    let session_before = user_activity(state, username).is_some();
    remove_connection_presence(state, connection_id);
    if before.is_some() {
        let after = public_activity(state, username);
        if before != after {
            publish(state, username, after.as_ref()).await;
        }
    }
    if session_before && user_activity(state, username).is_none() {
        crate::focus::on_session_ended(state, username);
    }
}

/// Статусы всех, кого `viewer` вправе видеть.
async fn visible_activities(state: &AppState, viewer: &str) -> HashMap<String, GameActivity> {
    let candidates: HashSet<String> = state
        .push_presence
        .iter()
        .filter(|entry| {
            entry
                .activity
                .as_ref()
                .and_then(|current| current.activity.as_ref())
                .map(|activity| activity.shared)
                .unwrap_or(false)
        })
        .map(|entry| entry.username.clone())
        .collect();
    if candidates.is_empty() {
        return HashMap::new();
    }
    let related = related_users(state, viewer).await;
    candidates
        .into_iter()
        .filter(|name| name != viewer && related.contains(name))
        .filter_map(|name| public_activity(state, &name).map(|activity| (name, activity)))
        .collect()
}

/// Первый кадр после подключения: текущие статусы друзей и соседей по серверам.
pub(crate) async fn send_activity_snapshot_to_user(state: &Arc<AppState>, viewer: &str) {
    let activities = visible_activities(state, viewer).await;
    if activities.is_empty() {
        return;
    }
    send_json_to_user(
        state,
        viewer,
        json!({ "type": "activity_snapshot", "activities": activities }),
    )
    .await;
}

/// `GET /api/activity` — тот же снимок по HTTP, для ручного обновления.
pub(crate) async fn get_activity(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(viewer): AuthenticatedUser,
) -> impl IntoResponse {
    Json(json!({ "activities": visible_activities(&state, &viewer).await }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_app_state, push::register_connection_presence, Config};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    async fn test_state() -> Arc<AppState> {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "zali-activity-test-{}-{}",
            std::process::id(),
            n
        ));
        build_app_state(dir, Config::from_env()).await
    }

    async fn befriend(state: &Arc<AppState>, a: &str, b: &str) {
        let (low, high) = if a <= b { (a, b) } else { (b, a) };
        sqlx::query("INSERT INTO friend_links (user_low, user_high) VALUES (?, ?)")
            .bind(low)
            .bind(high)
            .execute(&state.db)
            .await
            .expect("insert friend link");
    }

    fn connect(state: &Arc<AppState>, username: &str) -> (u64, tokio::sync::mpsc::Receiver<String>) {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        state
            .user_connections
            .entry(username.to_string())
            .or_default()
            .push(tx);
        (register_connection_presence(state, username), rx)
    }

    fn game(name: &str) -> Value {
        json!({ "kind": "game", "name": name, "source": "process" })
    }

    #[test]
    fn a_game_name_is_cleaned_like_untrusted_input() {
        let parsed = parse_activity(
            &json!({ "name": "  Half\u{0}-Life \n\t 2  ", "id": "steam:220", "source": "STEAM" }),
            1_000,
        )
        .expect("activity");
        assert_eq!(parsed.name, "Half -Life 2");
        assert_eq!(parsed.id, "steam:220");
        assert_eq!(parsed.source, "steam");
        assert_eq!(parsed.since, 1_000);
    }

    #[test]
    fn nonsense_means_not_playing() {
        assert!(parse_activity(&Value::Null, 0).is_none());
        assert!(parse_activity(&json!("Quake"), 0).is_none());
        assert!(parse_activity(&json!({ "name": "   " }), 0).is_none());
        assert!(parse_activity(&json!({ "kind": "music", "name": "Song" }), 0).is_none());
    }

    #[test]
    fn name_is_capped_and_unknown_source_is_demoted() {
        let long = "я".repeat(500);
        let parsed = parse_activity(&json!({ "name": long, "source": "evil" }), 5).expect("activity");
        assert_eq!(parsed.name.chars().count(), MAX_NAME_CHARS);
        assert_eq!(parsed.source, "process");
    }

    #[test]
    fn since_from_the_future_or_the_distant_past_is_replaced_by_now() {
        let now = 10_000_000_000;
        let future = parse_activity(&json!({ "name": "G", "since": now + 5 }), now).unwrap();
        assert_eq!(future.since, now);
        let ancient = parse_activity(&json!({ "name": "G", "since": 1 }), now).unwrap();
        assert_eq!(ancient.since, now);
        let fine = parse_activity(&json!({ "name": "G", "since": now - 60_000 }), now).unwrap();
        assert_eq!(fine.since, now - 60_000);
    }

    #[tokio::test]
    async fn a_friend_sees_the_game_and_a_stranger_does_not() {
        let state = test_state().await;
        befriend(&state, "alice", "bob").await;
        let (alice_conn, _alice_rx) = connect(&state, "alice");
        let (_bob_conn, mut bob_rx) = connect(&state, "bob");
        let (_eve_conn, mut eve_rx) = connect(&state, "eve");

        set_connection_activity(&state, alice_conn, "alice", &game("Dota 2")).await;

        let frame: Value =
            serde_json::from_str(&bob_rx.try_recv().expect("bob got a frame")).expect("json");
        assert_eq!(frame["type"], "user_activity");
        assert_eq!(frame["username"], "alice");
        assert_eq!(frame["activity"]["name"], "Dota 2");
        assert!(eve_rx.try_recv().is_err(), "a stranger must not receive it");
        assert!(visible_activities(&state, "eve").await.is_empty());
        assert!(visible_activities(&state, "bob").await.contains_key("alice"));
    }

    #[tokio::test]
    async fn people_on_a_common_server_see_each_other() {
        let state = test_state().await;
        for user in ["alice", "carol"] {
            sqlx::query(
                "INSERT INTO server_members (server_id, username, role, joined_at)
                 VALUES ('srv1', ?, 'member', CURRENT_TIMESTAMP)",
            )
            .bind(user)
            .execute(&state.db)
            .await
            .expect("insert member");
        }
        let (alice_conn, _rx) = connect(&state, "alice");
        let (_carol_conn, _carol_rx) = connect(&state, "carol");

        set_connection_activity(&state, alice_conn, "alice", &game("Factorio")).await;

        assert!(visible_activities(&state, "carol").await.contains_key("alice"));
    }

    #[tokio::test]
    async fn a_repeat_is_not_rebroadcast_and_a_clear_is() {
        let state = test_state().await;
        befriend(&state, "alice", "bob").await;
        let (alice_conn, _alice_rx) = connect(&state, "alice");
        let (_bob_conn, mut bob_rx) = connect(&state, "bob");
        let payload = json!({ "kind": "game", "name": "Celeste", "since": Utc::now().timestamp_millis() });

        set_connection_activity(&state, alice_conn, "alice", &payload).await;
        assert!(bob_rx.try_recv().is_ok());
        set_connection_activity(&state, alice_conn, "alice", &payload).await;
        assert!(bob_rx.try_recv().is_err(), "identical repeat must stay silent");

        // Раньше MIN_UPDATE_INTERVAL смена не принимается; обходим часы руками.
        state.push_presence.get_mut(&alice_conn).unwrap().activity.as_mut().unwrap().updated_at =
            Instant::now()
                .checked_sub(MIN_UPDATE_INTERVAL * 2)
                .expect("monotonic clock is past the throttle window");
        set_connection_activity(&state, alice_conn, "alice", &Value::Null).await;
        let frame: Value = serde_json::from_str(&bob_rx.try_recv().expect("clear")).unwrap();
        assert!(frame["activity"].is_null());
    }

    #[tokio::test]
    async fn a_flood_of_changes_is_throttled() {
        let state = test_state().await;
        let (conn, _rx) = connect(&state, "alice");
        set_connection_activity(&state, conn, "alice", &game("One")).await;
        set_connection_activity(&state, conn, "alice", &game("Two")).await;
        assert_eq!(user_activity(&state, "alice").unwrap().name, "One");
    }

    #[tokio::test]
    async fn a_status_marked_not_shared_reaches_nobody_but_still_counts_as_playing() {
        let state = test_state().await;
        befriend(&state, "alice", "bob").await;
        let (alice_conn, _alice_rx) = connect(&state, "alice");
        let (_bob_conn, mut bob_rx) = connect(&state, "bob");
        let hidden = json!({ "kind": "game", "name": "Hades", "share": false });

        set_connection_activity(&state, alice_conn, "alice", &hidden).await;

        assert!(bob_rx.try_recv().is_err(), "a private status must not be broadcast");
        assert!(visible_activities(&state, "bob").await.is_empty());
        assert!(public_activity(&state, "alice").is_none());
        // Для режима «в игре» (focus.rs) она по-прежнему есть.
        assert_eq!(user_activity(&state, "alice").unwrap().name, "Hades");
    }

    #[tokio::test]
    async fn closing_the_socket_clears_the_status_for_friends() {
        let state = test_state().await;
        befriend(&state, "alice", "bob").await;
        let (alice_conn, _alice_rx) = connect(&state, "alice");
        let (_bob_conn, mut bob_rx) = connect(&state, "bob");
        set_connection_activity(&state, alice_conn, "alice", &game("Hades")).await;
        let _ = bob_rx.try_recv();

        connection_closed(&state, alice_conn, "alice").await;

        let frame: Value = serde_json::from_str(&bob_rx.try_recv().expect("clear")).unwrap();
        assert_eq!(frame["username"], "alice");
        assert!(frame["activity"].is_null());
        assert!(user_activity(&state, "alice").is_none());
    }

    #[tokio::test]
    async fn another_socket_keeps_the_status_alive() {
        let state = test_state().await;
        let (first, _rx1) = connect(&state, "alice");
        let (second, _rx2) = connect(&state, "alice");
        set_connection_activity(&state, first, "alice", &game("Portal")).await;

        connection_closed(&state, second, "alice").await;

        assert_eq!(user_activity(&state, "alice").unwrap().name, "Portal");
    }
}
