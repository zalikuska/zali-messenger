//! Режим «в игре»: уведомления о личных сообщениях откладываются до конца
//! игровой сессии или приходят без звука.
//!
//! Что здесь важно понимать:
//!
//! - **Откладывается уведомление, а не сообщение.** Переписка сквозная: сервер
//!   не читает её и доставляет сообщение сразу, как обычно. Режим решает только
//!   одно — шуметь ли поверх игры. Поэтому в чате у получателя сообщение уже
//!   есть, счётчик непрочитанного растёт, а тост, звук и пуш — по правилам
//!   ниже.
//!
//! - **Решает сервер, потому что только он знает всё сразу:** во что играет
//!   получатель (`activity.rs`), дружит ли он с отправителем и какие у него
//!   настройки. Клиент получает готовое решение событием `notify_policy`
//!   **раньше самого сообщения** (на одном соединении порядок сохраняется), а
//!   отправитель — `delivery_note`, из которого рисует заметку над полем ввода.
//!
//! - **Два режима.** `silent` — уведомление есть, но без звука (пуш уходит с
//!   `silent`, клиент не играет сигнал). `defer` — уведомления нет вообще: пуш
//!   не уходит, клиент прячет тост; когда сессия кончилась, приходит один
//!   сводный пуш на отправителя и событие `focus_flush`.
//!
//! - **«Всё равно оповестить»** — `POST /api/message/:id/notify-now`: снимает
//!   отсрочку с одного сообщения. Работает только пока сообщение «в ожидании»
//!   (`focus_pending`) и только у его отправителя; повтор — 404, поэтому
//!   кнопкой нельзя завалить получателя одним и тем же сообщением.
//!
//! - **Конец сессии — с задержкой.** Игра закрылась и через секунду открылась
//!   снова (лаунчер, перезапуск) — это одна сессия. Поэтому сброс ждёт
//!   `FLUSH_GRACE` и перепроверяет, что игры по-прежнему нет.
//!
//! - **В памяти и не переживает рестарт сервера.** Потеряется только отсрочка
//!   пуша; сами сообщения лежат в чате.

use crate::{
    activity::user_activity, is_valid_username, profiles::are_friends, send_json_to_user,
    send_push, AppState, AuthenticatedUser, PushNotification,
};
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::{info, warn};

const MAX_GAMES: usize = 50;
const MAX_PEOPLE: usize = 100;
const MAX_GAME_NAME_CHARS: usize = 64;
/// Сколько ждать после «игры нет», прежде чем считать сессию оконченной.
const DEFAULT_FLUSH_GRACE_MS: u64 = 20_000;
/// Ожидающие записи старше этого срока выбрасываются: отсрочка не вечная.
const PENDING_TTL: Duration = Duration::from_secs(12 * 3600);
const PENDING_SWEEP_THRESHOLD: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FocusMode {
    Off,
    /// Не уведомлять до конца игровой сессии.
    Defer,
    /// Уведомлять, но без звука.
    Silent,
}

impl FocusMode {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "off" | "" => Some(FocusMode::Off),
            "defer" | "deferred" => Some(FocusMode::Defer),
            "silent" | "quiet" => Some(FocusMode::Silent),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            FocusMode::Off => "off",
            FocusMode::Defer => "defer",
            FocusMode::Silent => "silent",
        }
    }
}

/// Чьи сообщения попадают под режим.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FocusAudience {
    Everyone,
    Friends,
    /// Только перечисленные в `people`.
    Only,
    /// Все, кроме перечисленных в `people`.
    Except,
    Nobody,
}

impl FocusAudience {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_lowercase().as_str() {
            "everyone" | "all" | "" => Some(FocusAudience::Everyone),
            "friends" => Some(FocusAudience::Friends),
            "only" => Some(FocusAudience::Only),
            "except" => Some(FocusAudience::Except),
            "nobody" | "none" => Some(FocusAudience::Nobody),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            FocusAudience::Everyone => "everyone",
            FocusAudience::Friends => "friends",
            FocusAudience::Only => "only",
            FocusAudience::Except => "except",
            FocusAudience::Nobody => "nobody",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FocusSettings {
    pub(crate) mode: FocusMode,
    pub(crate) audience: FocusAudience,
    /// Пусто — в любой игре.
    pub(crate) games: Vec<String>,
    pub(crate) people: Vec<String>,
}

impl Default for FocusSettings {
    fn default() -> Self {
        Self {
            mode: FocusMode::Off,
            audience: FocusAudience::Everyone,
            games: Vec::new(),
            people: Vec::new(),
        }
    }
}

impl FocusSettings {
    fn to_json(&self) -> Value {
        json!({
            "mode": self.mode.as_str(),
            "audience": self.audience.as_str(),
            "games": self.games,
            "people": self.people,
        })
    }
}

/// Разбор тела PUT. Любое непонятное значение — ошибка, а не молчаливое «выкл»:
/// человек должен видеть, что настройка не сохранилась.
pub(crate) fn parse_settings(body: &Value, owner: &str) -> Result<FocusSettings, &'static str> {
    let object = body.as_object().ok_or("Ожидался объект")?;
    let mode = FocusMode::parse(object.get("mode").and_then(Value::as_str).unwrap_or("off"))
        .ok_or("Неизвестный режим")?;
    let audience = FocusAudience::parse(
        object
            .get("audience")
            .and_then(Value::as_str)
            .unwrap_or("everyone"),
    )
    .ok_or("Неизвестная аудитория")?;

    let mut games: Vec<String> = Vec::new();
    for raw in object
        .get("games")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let name: String = raw
            .as_str()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control())
            .collect::<String>()
            .trim()
            .chars()
            .take(MAX_GAME_NAME_CHARS)
            .collect();
        if name.is_empty() || games.iter().any(|g| g.to_lowercase() == name.to_lowercase()) {
            continue;
        }
        games.push(name);
    }
    if games.len() > MAX_GAMES {
        return Err("Слишком много игр в списке");
    }

    let mut people: Vec<String> = Vec::new();
    for raw in object
        .get("people")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let name = raw.as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || name == owner || !is_valid_username(&name) || people.contains(&name) {
            continue;
        }
        people.push(name);
    }
    if people.len() > MAX_PEOPLE {
        return Err("Слишком много людей в списке");
    }

    Ok(FocusSettings { mode, audience, games, people })
}

async fn load_settings(state: &AppState, username: &str) -> FocusSettings {
    let row = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT mode, audience, games, people FROM game_focus_settings WHERE username = ?",
    )
    .bind(username)
    .fetch_optional(&state.db)
    .await;
    match row {
        Ok(Some((mode, audience, games, people))) => FocusSettings {
            mode: FocusMode::parse(&mode).unwrap_or(FocusMode::Off),
            audience: FocusAudience::parse(&audience).unwrap_or(FocusAudience::Everyone),
            games: serde_json::from_str(&games).unwrap_or_default(),
            people: serde_json::from_str(&people).unwrap_or_default(),
        },
        Ok(None) => FocusSettings::default(),
        Err(e) => {
            warn!("focus: чтение настроек username={} err={}", username, e);
            FocusSettings::default()
        }
    }
}

/// Сообщение, о котором получатель пока не уведомлён (или уведомлён тихо).
#[derive(Debug, Clone)]
pub(crate) struct PendingFocus {
    sender: String,
    recipient: String,
    mode: FocusMode,
    at: Instant,
}

pub(crate) type PendingMap = dashmap::DashMap<String, PendingFocus>;

/// Применяется ли режим получателя `recipient` к сообщению от `sender` сейчас.
/// `None` — нет, уведомление идёт как обычно.
pub(crate) async fn decide(state: &AppState, sender: &str, recipient: &str) -> Option<FocusMode> {
    if sender == recipient {
        return None;
    }
    let settings = load_settings(state, recipient).await;
    if settings.mode == FocusMode::Off || settings.audience == FocusAudience::Nobody {
        return None;
    }
    // «В игре» — по сырому статусу: показывать его другим для этого не нужно.
    let playing = user_activity(state, recipient)?;
    if !settings.games.is_empty()
        && !settings
            .games
            .iter()
            .any(|game| game.to_lowercase() == playing.name.to_lowercase())
    {
        return None;
    }
    let applies = match settings.audience {
        FocusAudience::Everyone => true,
        FocusAudience::Friends => are_friends(&state.db, sender, recipient).await.unwrap_or(false),
        FocusAudience::Only => settings.people.iter().any(|p| p == sender),
        FocusAudience::Except => !settings.people.iter().any(|p| p == sender),
        FocusAudience::Nobody => false,
    };
    applies.then_some(settings.mode)
}

/// Вызывается из `deliver_to_user` ПЕРЕД отправкой самого сообщения получателю:
/// клиент должен узнать политику раньше, чем решит, показывать ли тост.
pub(crate) async fn apply_to_delivery(
    state: &Arc<AppState>,
    sender: &str,
    recipient: &str,
    message_id: &str,
) -> Option<FocusMode> {
    let mode = decide(state, sender, recipient).await?;
    if state.focus_pending.len() > PENDING_SWEEP_THRESHOLD {
        state
            .focus_pending
            .retain(|_, pending| pending.at.elapsed() < PENDING_TTL);
    }
    state.focus_pending.insert(
        message_id.to_string(),
        PendingFocus {
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            mode,
            at: Instant::now(),
        },
    );
    send_json_to_user(
        state,
        recipient,
        json!({
            "type": "notify_policy",
            "messageId": message_id,
            "from": sender,
            "mode": mode.as_str(),
        }),
    )
    .await;
    // Отправителю — только факт «получатель сейчас в игре», без названия игры:
    // название он увидит сам, если получатель ему его показывает.
    send_json_to_user(
        state,
        sender,
        json!({
            "type": "delivery_note",
            "messageId": message_id,
            "to": recipient,
            "mode": mode.as_str(),
        }),
    )
    .await;
    info!(
        "[FOCUS] message={} {} -> {} mode={}",
        message_id,
        sender,
        recipient,
        mode.as_str()
    );
    Some(mode)
}

fn flush_grace() -> Duration {
    // Переменная — для тестов; в проде значение по умолчанию.
    let ms = std::env::var("ZALI_FOCUS_FLUSH_GRACE_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_FLUSH_GRACE_MS);
    Duration::from_millis(ms)
}

/// У `username` не осталось ни одного соединения с игрой. Сессию заканчивает не
/// первая же пустота, а пустота, продержавшаяся `FLUSH_GRACE`.
pub(crate) fn on_session_ended(state: &Arc<AppState>, username: &str) {
    let has_pending = state
        .focus_pending
        .iter()
        .any(|entry| entry.recipient == username);
    if !has_pending {
        return;
    }
    let state = Arc::clone(state);
    let username = username.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(flush_grace()).await;
        if user_activity(&state, &username).is_some() {
            return;
        }
        release_for_recipient(&state, &username).await;
    });
}

/// Сессия кончилась: один сводный пуш на каждого отправителя, события клиентам.
async fn release_for_recipient(state: &Arc<AppState>, recipient: &str) {
    let mut by_sender: HashMap<String, Vec<String>> = HashMap::new();
    let mut silent_ids: Vec<(String, String)> = Vec::new();
    let keys: Vec<String> = state
        .focus_pending
        .iter()
        .filter(|entry| entry.recipient == recipient)
        .map(|entry| entry.key().clone())
        .collect();
    for key in keys {
        let Some((id, pending)) = state.focus_pending.remove(&key) else {
            continue;
        };
        match pending.mode {
            FocusMode::Defer => by_sender.entry(pending.sender).or_default().push(id),
            _ => silent_ids.push((pending.sender, id)),
        }
    }
    if by_sender.is_empty() && silent_ids.is_empty() {
        return;
    }
    info!(
        "[FOCUS] сессия {} закончилась: отложено от {} отправителей",
        recipient,
        by_sender.len()
    );
    // Сначала событие клиентам: открытое приложение покажет сводку локально, а пуш
    // с тем же tag не задвоит её (общий tag переписки, см. notifications).
    send_json_to_user(state, recipient, json!({ "type": "focus_flush" })).await;
    let mut done: HashMap<String, Vec<String>> = HashMap::new();
    for (sender, ids) in by_sender {
        if let Some(last) = ids.last() {
            let notification = PushNotification::direct_message(&sender, last);
            send_push(state, recipient, &notification).await;
        }
        done.entry(sender).or_default().extend(ids);
    }
    for (sender, id) in silent_ids {
        done.entry(sender).or_default().push(id);
    }
    for (sender, ids) in done {
        send_json_to_user(
            state,
            &sender,
            json!({ "type": "delivery_note_done", "to": recipient, "messageIds": ids }),
        )
        .await;
    }
}

/// `POST /api/message/:id/notify-now` — «Всё равно оповестить».
pub(crate) async fn notify_now(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    AxumPath(message_id): AxumPath<String>,
) -> impl IntoResponse {
    let owned = state
        .focus_pending
        .get(&message_id)
        .map(|pending| pending.sender == username)
        .unwrap_or(false);
    // Чужое и несуществующее неотличимы: id сообщений не должен уметь угадывать кто попало.
    if !owned {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some((_, pending)) = state.focus_pending.remove(&message_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    send_json_to_user(
        &state,
        &pending.recipient,
        json!({ "type": "notify_now", "messageId": message_id, "from": pending.sender }),
    )
    .await;
    let notification = PushNotification::direct_message(&pending.sender, &message_id).forced();
    {
        let state = Arc::clone(&state);
        let recipient = pending.recipient.clone();
        tokio::spawn(async move {
            send_push(&state, &recipient, &notification).await;
        });
    }
    send_json_to_user(
        &state,
        &pending.sender,
        json!({ "type": "delivery_note_done", "to": pending.recipient, "messageIds": [message_id] }),
    )
    .await;
    info!("[FOCUS] notify-now message={} by {}", message_id, username);
    Json(json!({ "ok": true })).into_response()
}

/// `GET /api/game-focus`.
pub(crate) async fn get_settings(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
) -> impl IntoResponse {
    Json(load_settings(&state, &username).await.to_json())
}

/// `PUT /api/game-focus`.
pub(crate) async fn put_settings(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(username): AuthenticatedUser,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let settings = match parse_settings(&body, &username) {
        Ok(settings) => settings,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let games = serde_json::to_string(&settings.games).unwrap_or_else(|_| "[]".to_string());
    let people = serde_json::to_string(&settings.people).unwrap_or_else(|_| "[]".to_string());
    let result = sqlx::query(
        "INSERT INTO game_focus_settings (username, mode, audience, games, people, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(username) DO UPDATE SET
            mode = excluded.mode,
            audience = excluded.audience,
            games = excluded.games,
            people = excluded.people,
            updated_at = CURRENT_TIMESTAMP",
    )
    .bind(&username)
    .bind(settings.mode.as_str())
    .bind(settings.audience.as_str())
    .bind(games)
    .bind(people)
    .execute(&state.db)
    .await;
    match result {
        Ok(_) => {
            // Режим выключили — ждать уже нечего: всё накопленное отдаётся сразу.
            if settings.mode == FocusMode::Off {
                release_for_recipient(&state, &username).await;
            }
            Json(settings.to_json()).into_response()
        }
        Err(e) => {
            warn!("focus: запись настроек username={} err={}", username, e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
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
            "zali-focus-test-{}-{}",
            std::process::id(),
            n
        ));
        build_app_state(dir, Config::from_env()).await
    }

    async fn save(state: &Arc<AppState>, user: &str, body: Value) {
        let settings = parse_settings(&body, user).expect("valid settings");
        sqlx::query(
            "INSERT INTO game_focus_settings (username, mode, audience, games, people)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(user)
        .bind(settings.mode.as_str())
        .bind(settings.audience.as_str())
        .bind(serde_json::to_string(&settings.games).unwrap())
        .bind(serde_json::to_string(&settings.people).unwrap())
        .execute(&state.db)
        .await
        .expect("insert settings");
    }

    async fn befriend(state: &Arc<AppState>, a: &str, b: &str) {
        let (low, high) = if a <= b { (a, b) } else { (b, a) };
        sqlx::query("INSERT INTO friend_links (user_low, user_high) VALUES (?, ?)")
            .bind(low)
            .bind(high)
            .execute(&state.db)
            .await
            .expect("friend link");
    }

    /// Получатель «в игре»: соединение с записанным статусом.
    fn play(state: &Arc<AppState>, user: &str, game: &str) -> u64 {
        let id = register_connection_presence(state, user);
        state.push_presence.get_mut(&id).unwrap().activity =
            Some(crate::activity::ConnectionActivity {
                activity: Some(crate::activity::GameActivity {
                    name: game.to_string(),
                    id: String::new(),
                    source: "process".to_string(),
                    since: 0,
                    shared: false,
                }),
                updated_at: Instant::now(),
            });
        id
    }

    #[test]
    fn settings_are_validated_and_cleaned() {
        let ok = parse_settings(
            &json!({
                "mode": "defer", "audience": "except",
                "games": ["  Dota 2 ", "dota 2", "", "CS2"],
                "people": ["bob", "bob", "me", "bad name!"]
            }),
            "me",
        )
        .unwrap();
        assert_eq!(ok.games, vec!["Dota 2".to_string(), "CS2".to_string()]);
        assert_eq!(ok.people, vec!["bob".to_string()]);
        assert!(parse_settings(&json!({ "mode": "loud" }), "me").is_err());
        assert!(parse_settings(&json!({ "audience": "enemies" }), "me").is_err());
        assert!(parse_settings(&json!("nope"), "me").is_err());
    }

    #[tokio::test]
    async fn off_by_default_and_not_playing_means_normal_notification() {
        let state = test_state().await;
        play(&state, "bob", "Dota 2");
        // Настроек нет — режим выключен.
        assert_eq!(decide(&state, "alice", "bob").await, None);
        save(&state, "bob", json!({ "mode": "defer" })).await;
        assert_eq!(decide(&state, "alice", "bob").await, Some(FocusMode::Defer));
        // Игры нет — обычное уведомление.
        assert_eq!(decide(&state, "alice", "carol").await, None);
    }

    #[tokio::test]
    async fn the_audience_decides_whose_messages_are_held() {
        let state = test_state().await;
        play(&state, "bob", "Dota 2");
        befriend(&state, "alice", "bob").await;

        save(&state, "bob", json!({ "mode": "silent", "audience": "friends" })).await;
        assert_eq!(decide(&state, "alice", "bob").await, Some(FocusMode::Silent));
        assert_eq!(decide(&state, "eve", "bob").await, None, "stranger is not a friend");

        sqlx::query("UPDATE game_focus_settings SET audience = 'only', people = '[\"eve\"]' WHERE username = 'bob'")
            .execute(&state.db).await.unwrap();
        assert_eq!(decide(&state, "eve", "bob").await, Some(FocusMode::Silent));
        assert_eq!(decide(&state, "alice", "bob").await, None);

        sqlx::query("UPDATE game_focus_settings SET audience = 'except' WHERE username = 'bob'")
            .execute(&state.db).await.unwrap();
        assert_eq!(decide(&state, "eve", "bob").await, None);
        assert_eq!(decide(&state, "alice", "bob").await, Some(FocusMode::Silent));

        sqlx::query("UPDATE game_focus_settings SET audience = 'nobody' WHERE username = 'bob'")
            .execute(&state.db).await.unwrap();
        assert_eq!(decide(&state, "alice", "bob").await, None);
    }

    #[tokio::test]
    async fn only_the_listed_games_trigger_the_mode() {
        let state = test_state().await;
        save(&state, "bob", json!({ "mode": "defer", "games": ["dota 2"] })).await;
        let conn = play(&state, "bob", "Dota 2");
        assert_eq!(decide(&state, "alice", "bob").await, Some(FocusMode::Defer));
        state.push_presence.get_mut(&conn).unwrap().activity.as_mut().unwrap()
            .activity.as_mut().unwrap().name = "Factorio".to_string();
        assert_eq!(decide(&state, "alice", "bob").await, None);
    }

    #[tokio::test]
    async fn the_recipient_hears_the_policy_before_the_message_and_the_sender_gets_a_note() {
        let state = test_state().await;
        save(&state, "bob", json!({ "mode": "defer" })).await;
        play(&state, "bob", "Dota 2");
        let (bob_tx, mut bob_rx) = tokio::sync::mpsc::channel(8);
        let (alice_tx, mut alice_rx) = tokio::sync::mpsc::channel(8);
        state.user_connections.entry("bob".into()).or_default().push(bob_tx);
        state.user_connections.entry("alice".into()).or_default().push(alice_tx);

        let mode = apply_to_delivery(&state, "alice", "bob", "m1").await;

        assert_eq!(mode, Some(FocusMode::Defer));
        let policy: Value = serde_json::from_str(&bob_rx.try_recv().unwrap()).unwrap();
        assert_eq!(policy["type"], "notify_policy");
        assert_eq!(policy["messageId"], "m1");
        assert_eq!(policy["mode"], "defer");
        let note: Value = serde_json::from_str(&alice_rx.try_recv().unwrap()).unwrap();
        assert_eq!(note["type"], "delivery_note");
        assert_eq!(note["to"], "bob");
        assert!(note.get("game").is_none(), "the game name must not leak to the sender");
        assert!(state.focus_pending.contains_key("m1"));
    }

    #[tokio::test]
    async fn the_session_ending_releases_the_held_messages_once() {
        std::env::set_var("ZALI_FOCUS_FLUSH_GRACE_MS", "30");
        let state = test_state().await;
        save(&state, "bob", json!({ "mode": "defer" })).await;
        let conn = play(&state, "bob", "Dota 2");
        let (bob_tx, mut bob_rx) = tokio::sync::mpsc::channel(8);
        let (alice_tx, mut alice_rx) = tokio::sync::mpsc::channel(8);
        state.user_connections.entry("bob".into()).or_default().push(bob_tx);
        state.user_connections.entry("alice".into()).or_default().push(alice_tx);
        apply_to_delivery(&state, "alice", "bob", "m1").await;
        let _ = (bob_rx.try_recv(), alice_rx.try_recv());

        // Игра закрылась (раньше MIN_UPDATE_INTERVAL смену сервер не принимает).
        state.push_presence.get_mut(&conn).unwrap().activity.as_mut().unwrap().updated_at =
            Instant::now()
                .checked_sub(Duration::from_secs(10))
                .expect("monotonic clock is past the throttle window");
        crate::activity::set_connection_activity(&state, conn, "bob", &Value::Null).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let flush: Value = serde_json::from_str(&bob_rx.try_recv().expect("flush")).unwrap();
        assert_eq!(flush["type"], "focus_flush");
        let done: Value = serde_json::from_str(&alice_rx.try_recv().expect("done")).unwrap();
        assert_eq!(done["type"], "delivery_note_done");
        assert_eq!(done["messageIds"][0], "m1");
        assert!(state.focus_pending.is_empty());
    }
}
