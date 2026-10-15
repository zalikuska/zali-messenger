//! Активность устройств и маршрут уведомлений: на какие устройства пользователя слать
//! уведомление о новом сообщении.
//!
//! **Правило.** Устройство активно, если человек что-то делал на нём меньше
//! `ACTIVE_WINDOW` назад: на компьютере — любой ввод в системе вообще (мышь,
//! клавиатура, не только в окне мессенджера), на телефоне — касание приложения,
//! его открытие, сворачивание или закрытие. Если активные устройства есть,
//! уведомление (пуш и локальное) уходит только на них; если бездельничают все —
//! на все. Раньше уведомление приходило на каждое устройство разом: человек за
//! компьютером получал ещё и вибрацию телефона в кармане.
//!
//! **Кто сообщает.** Каждый клиент шлёт по своему WebSocket `client_idle
//! {deviceId, idleSeconds}`: macOS и Windows — из нативного таймера по системному
//! простою (`CGEventSource` / `GetLastInputInfo`), Android — из нативного слоя по
//! касаниям и переходам жизненного цикла, браузер — из вкладки по своим событиям
//! ввода (системного простоя ему не узнать). Пока человек активен, отчёт идёт раз в
//! ~30 с; перестал — отчёты прекращаются, и простой растёт сам. Сервер хранит
//! момент последнего действия на устройство (в памяти и в `device_activity`, чтобы
//! перезапуск его не стирал) и отдаёт простой в целых минутах, округлённых вниз
//! (`GET /api/devices/activity`).
//!
//! **Достижимость.** Активное устройство считается адресатом, только если до него
//! есть путь прямо сейчас: живой сокет, недавно подтверждённый входящим кадром, или
//! пуш-канал (Web Push / FCM). Иначе ноутбук, у которого только что закрыли крышку,
//! ещё две минуты «активен» по полуоткрытому сокету — и телефон молчал бы.
//!
//! **Чат открыт прямо сейчас** — единственное исключение: если переписка на экране
//! активного устройства и окно перед глазами (`client_view`), не звенит ни одно
//! устройство, ни пушем, ни системным уведомлением.
//!
//! **Как узнаёт клиент.** Перед самим сообщением сервер шлёт всем соединениям
//! получателя `notify_route {messageId, devices}` — только когда уведомлять надо не
//! все устройства. Веб сверяет свой `deviceId` и, если его в списке нет, лишь
//! наращивает счётчик непрочитанного (web/src/interface/notifications.js).

use crate::{AppState, AuthenticatedUser};
use axum::{extract::State, response::IntoResponse, Json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tracing::warn;

/// «Что-то делал меньше двух минут назад».
pub(crate) const ACTIVE_WINDOW_SECS: i64 = 120;
/// Сокет годится в путь до устройства, только если входящий кадр был не позже этого.
/// Клиенты отвечают на Ping сервера (раз в 20 с), активные ещё и шлют `client_idle`
/// раз в ~30 с.
const SOCKET_FRESH: Duration = Duration::from_secs(45);
/// Открытый чат держится без подтверждения не дольше: вкладка с открытым чатом
/// повторяет `client_view` раз в 25 с.
const VIEW_FRESH: Duration = Duration::from_secs(60);
/// Не писать в базу чаще: активное устройство отчитывается раз в ~30 с.
const PERSIST_STEP_SECS: i64 = 60;
/// Простой больше этого — «давно»: клиенту незачем присылать точнее.
const MAX_IDLE_SECS: u64 = 365 * 24 * 3600;

#[derive(Debug, Clone, Copy)]
pub(crate) struct DeviceActivity {
    /// Unix-время последнего действия, секунды.
    pub(crate) last_active: i64,
    /// Что из этого уже лежит в базе.
    persisted: i64,
}

/// Логин → устройство → активность.
pub(crate) type DeviceActivityMap = dashmap::DashMap<String, HashMap<String, DeviceActivity>>;

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

pub(crate) async fn load_device_activity(pool: &sqlx::SqlitePool) -> DeviceActivityMap {
    let map = DeviceActivityMap::new();
    let rows = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT username, device_id, last_active_at FROM device_activity",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for (username, device_id, last_active) in rows {
        map.entry(username).or_default().insert(
            device_id,
            DeviceActivity {
                last_active,
                persisted: last_active,
            },
        );
    }
    map
}

/// Отчёт клиента: на устройстве `device_id` последнее действие было `idle_secs` назад.
/// Время считает сервер — часам клиента верить незачем.
pub(crate) fn note_device_activity(
    state: &Arc<AppState>,
    username: &str,
    device_id: &str,
    idle_secs: u64,
) {
    let device_id = device_id.trim();
    if username.is_empty() || device_id.is_empty() || device_id.len() > 128 {
        return;
    }
    let last_active = now_secs() - idle_secs.min(MAX_IDLE_SECS) as i64;
    let persist = {
        let mut devices = state.device_activity.entry(username.to_string()).or_default();
        let entry = devices.entry(device_id.to_string()).or_insert(DeviceActivity {
            last_active: i64::MIN,
            persisted: i64::MIN,
        });
        // Отчёты по двум сокетам одного устройства и очередь реконнекта могут прийти
        // не по порядку — назад время не идёт.
        if last_active <= entry.last_active {
            return;
        }
        entry.last_active = last_active;
        if entry.persisted == i64::MIN || last_active - entry.persisted >= PERSIST_STEP_SECS {
            entry.persisted = last_active;
            true
        } else {
            false
        }
    };
    if persist {
        let state = Arc::clone(state);
        let username = username.to_string();
        let device_id = device_id.to_string();
        tokio::spawn(async move {
            if let Err(e) = sqlx::query(
                "INSERT INTO device_activity (username, device_id, last_active_at) VALUES (?, ?, ?)
                 ON CONFLICT(username, device_id) DO UPDATE SET
                    last_active_at = MAX(last_active_at, excluded.last_active_at)",
            )
            .bind(&username)
            .bind(&device_id)
            .bind(last_active)
            .execute(&state.db)
            .await
            {
                warn!("Ошибка записи активности устройства username={}: {}", username, e);
            }
        });
    }
}

/// Простой устройства в целых минутах, округлённых вниз. None — устройство не отчитывалось.
pub(crate) fn device_idle_minutes(state: &AppState, username: &str, device_id: &str) -> Option<i64> {
    let last_active = state.device_activity.get(username)?.get(device_id)?.last_active;
    Some((now_secs() - last_active).max(0) / 60)
}

fn active_devices(state: &AppState, username: &str) -> HashSet<String> {
    let cutoff = now_secs() - ACTIVE_WINDOW_SECS;
    state
        .device_activity
        .get(username)
        .map(|devices| {
            devices
                .iter()
                .filter(|(_, activity)| activity.last_active > cutoff)
                .map(|(device, _)| device.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Устройства пользователя с живым сокетом, недавно подтверждённым входящим кадром.
fn socket_devices(state: &AppState, username: &str) -> HashSet<String> {
    state
        .push_presence
        .iter()
        .filter(|entry| entry.username == username && entry.last_inbound.elapsed() <= SOCKET_FRESH)
        .filter_map(|entry| entry.device_id.clone())
        .collect()
}

async fn push_devices(state: &AppState, username: &str) -> HashSet<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT device_id FROM push_subscriptions WHERE username = ? AND device_id IS NOT NULL
         UNION SELECT device_id FROM fcm_tokens WHERE username = ?",
    )
    .bind(username)
    .bind(username)
    .fetch_all(&state.db)
    .await
    .map(|rows| rows.into_iter().collect())
    .unwrap_or_default()
}

/// На какие устройства уведомлять о новом сообщении.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NotifyRoute {
    /// Активных (и достижимых) устройств нет — на все.
    All,
    /// Только на эти: на них человек что-то делал меньше двух минут назад. Пусто —
    /// ни на какие: переписка открыта у человека перед глазами.
    Only(HashSet<String>),
}

impl NotifyRoute {
    /// Уведомлять ли устройство `device_id`. Устройство без id (подписка старого
    /// клиента) уведомляется, только когда уведомляются все.
    pub(crate) fn allows(&self, device_id: Option<&str>) -> bool {
        match self {
            NotifyRoute::All => true,
            NotifyRoute::Only(devices) => device_id
                .map(str::trim)
                .is_some_and(|device| devices.contains(device)),
        }
    }
}

/// Переписка `conversation` открыта прямо сейчас перед глазами человека: на экране
/// соединения, окно в фокусе (`client_view` шлётся только тогда), сокет подтверждён
/// недавно и устройство активно. Тогда не звенит ни одно устройство — человек и так
/// читает.
///
/// Требование активности — чтобы чат, оставленный открытым на компьютере, от которого
/// ушли, не глушил телефон в руках.
fn conversation_open(state: &AppState, username: &str, conversation: &str, active: &HashSet<String>) -> bool {
    state.push_presence.iter().any(|entry| {
        entry.username == username
            && entry.viewing.as_deref() == Some(conversation)
            && entry.last_inbound.elapsed() <= VIEW_FRESH
            && entry.device_id.as_ref().is_some_and(|device| active.contains(device))
    })
}

/// `conversation` — ключ переписки (`PushNotification::conversation`); None — не проверять,
/// открыта ли она.
pub(crate) async fn notify_route_for(state: &AppState, username: &str, conversation: Option<&str>) -> NotifyRoute {
    let active = active_devices(state, username);
    if conversation.is_some_and(|key| conversation_open(state, username, key, &active)) {
        return NotifyRoute::Only(HashSet::new());
    }
    if active.is_empty() {
        return NotifyRoute::All;
    }
    let mut reachable = socket_devices(state, username);
    reachable.extend(push_devices(state, username).await);
    let targets: HashSet<String> = active.intersection(&reachable).cloned().collect();
    if targets.is_empty() {
        NotifyRoute::All
    } else {
        NotifyRoute::Only(targets)
    }
}

/// Сообщает соединениям `username`, какие из его устройств уведомлять о сообщении
/// `message_id`. Идёт раньше самого сообщения — порядок в одном соединении сохраняется.
/// `All` не шлётся: без маршрута клиент уведомляет, как раньше.
pub(crate) async fn send_notify_route(
    state: &Arc<AppState>,
    username: &str,
    message_id: &str,
    route: &NotifyRoute,
) {
    let NotifyRoute::Only(devices) = route else {
        return;
    };
    let mut devices: Vec<&String> = devices.iter().collect();
    devices.sort();
    crate::send_json_to_user(
        state,
        username,
        serde_json::json!({
            "type": "notify_route",
            "messageId": message_id,
            "devices": devices,
        }),
    )
    .await;
}

/// Простой своих устройств — для интерфейса и диагностики.
pub(crate) async fn get_device_activity(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let device_ids: Vec<String> = state
        .device_activity
        .get(&username)
        .map(|devices| devices.keys().cloned().collect())
        .unwrap_or_default();
    let active = active_devices(&state, &username);
    let mut devices: Vec<serde_json::Value> = device_ids
        .into_iter()
        .filter_map(|device_id| {
            let idle_minutes = device_idle_minutes(&state, &username, &device_id)?;
            Some(serde_json::json!({
                "deviceId": device_id,
                "idleMinutes": idle_minutes,
                "active": active.contains(&device_id),
            }))
        })
        .collect();
    devices.sort_by_key(|device| device["idleMinutes"].as_i64().unwrap_or(i64::MAX));
    let route = notify_route_for(&state, &username, None).await;
    let notify: Option<Vec<String>> = match route {
        NotifyRoute::All => None,
        NotifyRoute::Only(set) => {
            let mut list: Vec<String> = set.into_iter().collect();
            list.sort();
            Some(list)
        }
    };
    Json(serde_json::json!({ "devices": devices, "notifyOnly": notify }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        build_app_state, register_connection_presence, update_connection_presence, update_connection_view, Config,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    async fn test_state() -> Arc<AppState> {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "zali-device-activity-test-{}-{}",
            std::process::id(),
            n
        ));
        build_app_state(dir, Config::from_env()).await
    }

    fn connect(state: &Arc<AppState>, username: &str, device: &str) -> u64 {
        let id = register_connection_presence(state, username);
        update_connection_presence(state, id, false, Some(device));
        id
    }

    async fn fcm(state: &Arc<AppState>, username: &str, device: &str) {
        sqlx::query("INSERT INTO fcm_tokens (token, username, device_id) VALUES (?, ?, ?)")
            .bind(format!("tok-{device}"))
            .bind(username)
            .bind(device)
            .execute(&state.db)
            .await
            .expect("insert token");
    }

    fn only(devices: &[&str]) -> NotifyRoute {
        NotifyRoute::Only(devices.iter().map(|d| d.to_string()).collect())
    }

    #[tokio::test]
    async fn everyone_idle_means_every_device() {
        let state = test_state().await;
        connect(&state, "alice", "mac");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "alice", "mac", 600);
        note_device_activity(&state, "alice", "phone", 3600);
        assert_eq!(notify_route_for(&state, "alice", None).await, NotifyRoute::All);
    }

    #[tokio::test]
    async fn the_device_in_use_takes_the_notification_alone() {
        let state = test_state().await;
        connect(&state, "alice", "mac");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "alice", "mac", 5);
        note_device_activity(&state, "alice", "phone", 3600);
        let route = notify_route_for(&state, "alice", None).await;
        assert_eq!(route, only(&["mac"]));
        assert!(!route.allows(Some("phone")));
        assert!(!route.allows(None));
    }

    #[tokio::test]
    async fn a_phone_closed_a_minute_ago_still_counts_through_its_push_channel() {
        let state = test_state().await;
        connect(&state, "alice", "mac");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "alice", "mac", 900);
        // Свернули приложение минуту назад — сокета уже нет, FCM есть.
        note_device_activity(&state, "alice", "phone", 60);
        assert_eq!(notify_route_for(&state, "alice", None).await, only(&["phone"]));
    }

    #[tokio::test]
    async fn two_minutes_without_action_is_idle() {
        let state = test_state().await;
        connect(&state, "alice", "mac");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "alice", "mac", ACTIVE_WINDOW_SECS as u64);
        assert_eq!(notify_route_for(&state, "alice", None).await, NotifyRoute::All);
    }

    #[tokio::test]
    async fn an_active_device_nobody_can_reach_does_not_swallow_the_notification() {
        let state = test_state().await;
        let mac = connect(&state, "alice", "mac");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "alice", "mac", 10);
        // Крышку закрыли: сокет полуоткрыт и молчит.
        state.push_presence.get_mut(&mac).unwrap().last_inbound =
            Instant::now().checked_sub(SOCKET_FRESH * 2).unwrap();
        assert_eq!(notify_route_for(&state, "alice", None).await, NotifyRoute::All);
    }

    #[tokio::test]
    async fn activity_never_goes_back_and_reports_whole_minutes() {
        let state = test_state().await;
        note_device_activity(&state, "alice", "mac", 30);
        note_device_activity(&state, "alice", "mac", 3000);
        assert_eq!(device_idle_minutes(&state, "alice", "mac"), Some(0));
        note_device_activity(&state, "bob", "pc", 179);
        assert_eq!(device_idle_minutes(&state, "bob", "pc"), Some(2));
        assert_eq!(device_idle_minutes(&state, "bob", "phone"), None);
    }

    #[tokio::test]
    async fn activity_survives_a_restart() {
        let state = test_state().await;
        note_device_activity(&state, "alice", "mac", 30);
        // Запись в базу — фоновая задача.
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_activity")
                .fetch_one(&state.db)
                .await
                .unwrap();
            if rows > 0 {
                break;
            }
        }
        let reloaded = load_device_activity(&state.db).await;
        let last = reloaded.get("alice").unwrap().get("mac").unwrap().last_active;
        assert!((now_secs() - last - 30).abs() <= 2);
    }

    #[tokio::test]
    async fn another_accounts_activity_on_the_same_machine_does_not_count() {
        let state = test_state().await;
        connect(&state, "alice", "mac");
        connect(&state, "bob", "mac");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "bob", "mac", 1);
        assert_eq!(notify_route_for(&state, "alice", None).await, NotifyRoute::All);
        let attended = connect(&state, "alice", "laptop");
        update_connection_presence(&state, attended, true, Some("laptop"));
        note_device_activity(&state, "alice", "laptop", 1);
        assert_eq!(notify_route_for(&state, "alice", None).await, only(&["laptop"]));
    }

    #[tokio::test]
    async fn an_open_chat_silences_every_device() {
        let state = test_state().await;
        let mac = connect(&state, "alice", "mac");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "alice", "mac", 5);
        note_device_activity(&state, "alice", "phone", 30);
        update_connection_view(&state, mac, Some("dm:bob"));

        let route = notify_route_for(&state, "alice", Some("dm:bob")).await;
        assert_eq!(route, only(&[]));
        assert!(!route.allows(Some("phone")) && !route.allows(Some("mac")));
        // Другая переписка — обычный маршрут.
        assert_eq!(notify_route_for(&state, "alice", Some("dm:carol")).await, only(&["mac", "phone"]));
    }

    #[tokio::test]
    async fn a_chat_left_open_on_an_idle_device_does_not_silence_the_phone() {
        let state = test_state().await;
        let mac = connect(&state, "alice", "mac");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "alice", "mac", 900);
        note_device_activity(&state, "alice", "phone", 10);
        update_connection_view(&state, mac, Some("dm:bob"));
        assert_eq!(notify_route_for(&state, "alice", Some("dm:bob")).await, only(&["phone"]));
    }

    #[tokio::test]
    async fn leaving_the_screen_closes_the_chat_for_every_socket_of_the_device() {
        let state = test_state().await;
        // Android: вебвью говорит про чат по своему сокету, натив — про экран по своему.
        let webview = connect(&state, "alice", "phone");
        let native = connect(&state, "alice", "phone");
        fcm(&state, "alice", "phone").await;
        note_device_activity(&state, "alice", "phone", 1);
        update_connection_view(&state, webview, Some("s1:c1"));
        assert_eq!(notify_route_for(&state, "alice", Some("s1:c1")).await, only(&[]));

        update_connection_presence(&state, native, false, Some("phone"));
        assert_eq!(notify_route_for(&state, "alice", Some("s1:c1")).await, only(&["phone"]));
    }

    #[tokio::test]
    async fn an_unconfirmed_open_chat_expires() {
        let state = test_state().await;
        let mac = connect(&state, "alice", "mac");
        note_device_activity(&state, "alice", "mac", 1);
        update_connection_view(&state, mac, Some("dm:bob"));
        state.push_presence.get_mut(&mac).unwrap().last_inbound =
            Instant::now().checked_sub(VIEW_FRESH * 2).unwrap();
        assert_eq!(notify_route_for(&state, "alice", Some("dm:bob")).await, NotifyRoute::All);
    }

    #[test]
    fn the_push_tag_names_the_same_conversation_the_client_reports() {
        assert_eq!(crate::PushNotification::direct_message("bob", "m1").conversation(), "dm:bob");
        assert_eq!(crate::PushNotification::channel_message("bob", "s1", "c1", "m2").conversation(), "s1:c1");
    }
}
