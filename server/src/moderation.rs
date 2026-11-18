//! Жалобы на сообщения и автоматическая модерация (2026-11-18).
//!
//! Путь жалобы. ПКМ по сообщению → «Пожаловаться» → человек двигает палочки
//! красной зоны (где нарушение) и, по желанию, оранжевой (важный для
//! рассмотрения контекст). Клиент присылает сообщения обеих зон плюс по 20
//! сверху и снизу от каждой (объединение). Сервер:
//!
//! 1. проверяет, что все сообщения существуют, лежат в одной переписке и видны
//!    заявителю; отправителя и время берёт из своей БД, а не из тела жалобы.
//!    Обвиняемый — автор сообщения, по которому нажали ПКМ;
//! 2. сверяет тексты канала с архивами (ключ канала выводится из scope, см.
//!    `deriveServerChannelKey` в клиенте) — подделку текста в канале видно.
//!    Личная переписка зашифрована сквозным ключом, её текст сервер проверить
//!    не может и берёт со слов участника (п. 5.2 Правил сообщества);
//! 3. ставит жалобу в очередь. Классификатор из обработчика запроса не зовётся
//!    никогда — только фоновой задачей, по одной, с лимитами ниже;
//! 4. Jev (`typesafe/jev-*`, OpenRouter Decisions API) отвечает вероятностями:
//!    нарушил ли автор правила в красной зоне, какой пункт, насколько грубо;
//! 5. по порогам выносится решение; сомнительное уходит администрации.
//!
//! Меры — три тира ([`Tier`]), у каждого свой срок:
//! предупреждение (1 месяц, на состояние не влияет), нарушение (2 месяца,
//! засчитывается в шкалу) и серьёзное нарушение (3 месяца, аккаунт приостановлен,
//! пока оно действует). Состояние аккаунта — чистая функция действующих мер
//! ([`standing_level`]): три нарушения — временные ограничения, пока их три;
//! серьёзное — приостановка. Отдельного «срока наказания» нет — есть срок нарушения.
//!
//! Защита бесплатного тира OpenRouter (20 запросов в минуту, 50 в сутки при
//! покупках меньше $10): свой счётчик в минуту и в сутки (UTC, в БД — переживает
//! перезапуск) с запасом ниже лимита, один запрос в полёте, пауза по `Retry-After`
//! / `X-RateLimit-Reset` на 429 и 402, а до классификатора жалоба доходит не
//! всегда: квоты заявителя, слияние жалоб на одни и те же сообщения в один
//! случай, пауза для тех, чьи жалобы раз за разом необоснованны.
//!
//! Все времена здесь — RFC 3339 (`ts()`), сравниваются строками. `datetime('now')`
//! SQLite не использовать: его формат с пробелом вместо `T` сравнивается со
//! строками RFC 3339 неверно.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{Path as AxumPath, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{sqlite::SqlitePool, Row};
use tokio::sync::Notify;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    can_access_message, diagnostics::operator_authorized, hash_chain::conversation_scope_for,
    realtime::send_json_to_user, AppState, AuthenticatedUser, Message,
};

// ── Жалоба ────────────────────────────────────────────────────────────────

/// Сколько соседних сообщений клиент прикладывает с каждой стороны зоны.
pub(crate) const CONTEXT_EACH_SIDE: usize = 20;
/// Максимум сообщений в красной зоне и во всём важном контексте вместе.
pub(crate) const MAX_ZONE_MESSAGES: usize = 30;
/// Важный контекст — несколько отрезков где угодно в переписке (до нарушения,
/// после, вперемешку с чужими репликами), а не одна зона рядом с красной.
pub(crate) const MAX_CONTEXT_ZONES: usize = 5;
/// Красная зона, весь контекст и по 20 сообщений вокруг каждого отрезка.
const MAX_TOTAL_MESSAGES: usize = 2 * MAX_ZONE_MESSAGES + 2 * CONTEXT_EACH_SIDE * (1 + MAX_CONTEXT_ZONES);
const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_TEXT_CHARS: usize = 2000;
const MAX_COMMENT_CHARS: usize = 500;
const MAX_ATTACHMENTS_PER_MESSAGE: usize = 10;

// ── Квоты заявителя (до классификатора жалоба доходит не всегда) ─────────

const REPORTS_PER_HOUR: i64 = 3;
const REPORTS_PER_DAY: i64 = 10;
/// Жалоб одного заявителя, ждущих классификатора, одновременно.
const MAX_OPEN_PER_REPORTER: i64 = 3;
/// Длина очереди целиком: дальше новые жалобы отклоняются, а не копятся.
const MAX_QUEUE: i64 = 500;
/// Столько необоснованных жалоб за окно — и подача приостанавливается.
const GROUNDLESS_LIMIT: i64 = 3;
const GROUNDLESS_WINDOW_DAYS: i64 = 7;
/// Жалобы на сообщения, по которым уже было решение за этот срок, сливаются
/// с тем случаем, а не идут в классификатор повторно.
const MERGE_WINDOW_DAYS: i64 = 30;
/// Сколько разных людей должны пожаловаться на отклонённый случай, чтобы его
/// пересмотрел человек.
const SECOND_OPINION_REPORTERS: i64 = 3;

// ── Шкала ──────────────────────────────────────────────────────────────────

/// Столько действующих нарушений — и аккаунт ограничен, пока их столько.
pub(crate) const VIOLATIONS_FOR_RESTRICTION: usize = 3;

// ── Пороги решения по ответу Jev ───────────────────────────────────────────

/// Вероятность нарушения, с которой мера применяется без человека.
const AUTO_ACTION_THRESHOLD: f64 = 0.85;
/// Ниже основного порога мера всё равно применяется, если три ответа Jev согласны:
/// нарушение вероятно (≥ 0,75), пункт выбран уверенно (≥ 0,85) и тяжесть не ниже
/// «явного» (≥ 2). Первый живой прогон: явный фишинг — violates 0,84, пункт fraud
/// 0,91, тяжесть 2,87 — уходил человеку из-за сотой доли от порога.
const AGREEMENT_VIOLATES: f64 = 0.75;
const AGREEMENT_RULE_PROBABILITY: f64 = 0.85;
const AGREEMENT_SEVERITY: f64 = 2.0;
/// Ниже — жалоба отклоняется как необоснованная.
const REJECT_THRESHOLD: f64 = 0.35;
/// Для п. 3.1.1 аккаунт приостанавливается уже с этой вероятности — до проверки
/// человеком: цена промедления здесь выше цены ошибки, которую снимет администрация.
const SEVERE_PROTECTIVE_THRESHOLD: f64 = 0.6;
/// Вероятность, с которой Jev должен выбрать пункт правил.
const RULE_MIN_PROBABILITY: f64 = 0.5;
/// Позиция на шкале тяжести (0–3): с какой нарушение грубое, до какой — мелкое.
const GROSS_SEVERITY: f64 = 2.5;
const MINOR_SEVERITY: f64 = 1.5;

// ── Классификатор ──────────────────────────────────────────────────────────

/// До ~32 КБ текста Jev работает в обычном режиме; длиннее — «long-context»,
/// медленнее и менее точно (документация OpenRouter). Держимся ниже.
const MAX_STATE_TEXT_BYTES: usize = 28 * 1024;
const STATE_TEXT_CHARS: usize = 1000;
const MAX_VERIFY_MESSAGES: usize = 10;
const MAX_ATTEMPTS: i64 = 8;
const IDLE_SLEEP: Duration = Duration::from_secs(600);
/// 401/403/402 «кончились кредиты» — ждать бессмысленно часто.
const HALT_SLEEP: Duration = Duration::from_secs(3600);

// ── Фрагмент переписки на странице нарушения ───────────────────────────────

const FRAGMENT_CONTEXT: usize = 2;
const FRAGMENT_MAX: usize = 14;
const FRAGMENT_TEXT_CHARS: usize = 500;

// ════════════════════════════════════════════════════════════════════════════
// Тиры и пункты правил
// ════════════════════════════════════════════════════════════════════════════

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tier {
    /// 1 месяц, на состояние аккаунта не влияет.
    Warning,
    /// 2 месяца, засчитывается в шкалу.
    Violation,
    /// 3 месяца, аккаунт приостановлен, пока действует.
    Serious,
}

impl Tier {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Tier::Warning => "warning",
            Tier::Violation => "violation",
            Tier::Serious => "serious",
        }
    }

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "warning" => Some(Tier::Warning),
            "violation" => Some(Tier::Violation),
            "serious" => Some(Tier::Serious),
            _ => None,
        }
    }

    pub(crate) fn title(self) -> &'static str {
        match self {
            Tier::Warning => "Предупреждение",
            Tier::Violation => "Нарушение",
            Tier::Serious => "Серьёзное нарушение",
        }
    }

    pub(crate) fn ttl_days(self) -> i64 {
        match self {
            Tier::Warning => 30,
            Tier::Violation => 60,
            Tier::Serious => 90,
        }
    }

    pub(crate) fn effect(self) -> &'static str {
        match self {
            Tier::Warning => "Не влияет на состояние аккаунта",
            Tier::Violation => "Засчитывается в шкалу: три действующих нарушения — временные ограничения",
            Tier::Serious => "Аккаунт приостановлен, пока нарушение действует",
        }
    }
}

#[derive(Debug)]
pub(crate) struct Category {
    pub(crate) key: &'static str,
    /// Пункт docs/legal/RULES.md.
    pub(crate) rule: &'static str,
    pub(crate) title: &'static str,
    /// Определение для Jev (английский: так модель понимает инструкции надёжнее,
    /// а сами сообщения остаются на языке переписки).
    criterion: &'static str,
    pub(crate) base: Tier,
    pub(crate) gross: Tier,
    /// Первый случай при чистой истории — предупреждение, а не нарушение.
    pub(crate) lenient_first: bool,
    /// П. 6.2 Правил: срока нет, приостановка бессрочная.
    pub(crate) permanent: bool,
}

/// Наказания за все нарушения. Единственный источник: отсюда же их показывает
/// клиент (раздел «Поддержка» хаба получает таблицу в `GET /api/moderation/standing`).
/// Наказывается только самое тяжёлое (п. 3.1 Правил): оскорбления, ругань, грубость,
/// шутки, троллинг, споры и «угрозы» в шутку — не нарушение (п. 1.4), за них мер нет.
/// П. 3.1.8 (авторские права) и 3.2 (атаки на Сервис) сюда не входят: первое
/// рассматривается только по обращению правообладателя, второе по переписке не
/// определить — это дело администрации, а не жалобы на сообщение.
pub(crate) const CATEGORIES: &[Category] = &[
    Category {
        key: "csam",
        rule: "3.1.1",
        title: "Сексуальные материалы с несовершеннолетними",
        criterion: "3.1.1 Sexual content involving or depicting minors, including drawn or AI-generated material.",
        base: Tier::Serious,
        gross: Tier::Serious,
        lenient_first: false,
        permanent: true,
    },
    Category {
        key: "terrorism",
        rule: "3.1.2",
        title: "Терроризм, вербовка и координация насилия",
        criterion: "3.1.2 Calls for or justification of terrorism, or recruitment, training or coordination of violent crimes.",
        base: Tier::Violation,
        gross: Tier::Serious,
        lenient_first: false,
        permanent: false,
    },
    Category {
        key: "violence_call",
        rule: "3.1.3",
        title: "Призывы причинить вред конкретным людям",
        criterion: "3.1.3 Serious, direct calls to physically harm the life or health of specific real people or groups, meant to be acted on. Insults, rudeness, hyperbole (\"I'll kill you\", \"I hope you die\"), banter, dark humor and game talk are NOT calls to harm.",
        base: Tier::Violation,
        gross: Tier::Serious,
        lenient_first: false,
        permanent: false,
    },
    Category {
        key: "illegal_trade",
        rule: "3.1.4",
        title: "Незаконный оборот: наркотики, оружие, документы, чужие данные",
        criterion: "3.1.4 Offering or facilitating the sale of drugs, weapons, forged documents, stolen personal or payment data, or other prohibited goods.",
        base: Tier::Violation,
        gross: Tier::Serious,
        lenient_first: false,
        permanent: false,
    },
    Category {
        key: "fraud",
        rule: "3.1.5",
        title: "Мошенничество, фишинг, вредоносные программы",
        criterion: "3.1.5 Malware, phishing, or scams aimed at stealing money, property or account credentials.",
        base: Tier::Violation,
        gross: Tier::Serious,
        lenient_first: false,
        permanent: false,
    },
    Category {
        key: "doxxing",
        rule: "3.1.6",
        title: "Публикация чужих персональных данных для травли",
        criterion: "3.1.6 Publishing someone's personal data (home address, phone number, documents) without consent in order to harass, intimidate or harm them.",
        base: Tier::Violation,
        gross: Tier::Serious,
        lenient_first: false,
        permanent: false,
    },
    Category {
        key: "intimate",
        rule: "3.1.7",
        title: "Интимные материалы без согласия",
        criterion: "3.1.7 Sharing intimate images or videos of another person without their consent.",
        base: Tier::Serious,
        gross: Tier::Serious,
        lenient_first: false,
        permanent: false,
    },
];

/// Пункт убрали из Правил — меры по нему снимаются при старте: наказание за то,
/// что больше не запрещено, держать нельзя.
async fn revoke_retired_categories(pool: &SqlitePool) {
    let keys: Vec<&str> = CATEGORIES.iter().map(|c| c.key).collect();
    let sql = format!(
        "UPDATE moderation_violations SET revoked_at = ?, revoked_reason = ?
         WHERE revoked_at IS NULL AND category NOT IN ({})",
        placeholders(keys.len())
    );
    let mut query = sqlx::query(&sql).bind(ts(Utc::now())).bind("Пункт отменён: по новой редакции Правил это не нарушение");
    for key in &keys {
        query = query.bind(*key);
    }
    match query.execute(pool).await {
        Ok(done) if done.rows_affected() > 0 => {
            info!("moderation: снято мер по отменённым пунктам: {}", done.rows_affected());
        }
        Ok(_) => {}
        Err(e) => error!("moderation: снятие мер по отменённым пунктам: {}", e),
    }
}

pub(crate) fn category_by_key(key: &str) -> Option<&'static Category> {
    CATEGORIES.iter().find(|c| c.key == key)
}

/// Тир за подтверждённое нарушение.
///
/// Грубое — тир «грубого» случая пункта. Иначе нарушение пункта с тиром
/// «Нарушение» становится предупреждением, если оно мелкое (шкала тяжести ниже
/// [`MINOR_SEVERITY`]) или если это первый случай лёгкого пункта при чистой
/// истории (нет ни одной действующей меры).
pub(crate) fn assign_tier(category: &Category, gross: bool, minor: bool, has_active_record: bool) -> Tier {
    if gross {
        return category.gross;
    }
    if category.base == Tier::Violation && (minor || (category.lenient_first && !has_active_record)) {
        return Tier::Warning;
    }
    category.base
}

/// Состояние аккаунта — полоска в хабе.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Level {
    Ok,
    /// 1–2 действующих нарушения.
    Warnings(usize),
    /// Три и больше: ограничен, пока их не станет меньше трёх.
    Restricted(DateTime<Utc>),
    /// Действует серьёзное нарушение; `None` — бессрочно.
    Suspended(Option<DateTime<Utc>>),
}

/// Состояние из действующих мер: `(тир, истекает)`, `None` — бессрочно.
pub(crate) fn standing_level(active: &[(Tier, Option<DateTime<Utc>>)]) -> Level {
    let serious: Vec<Option<DateTime<Utc>>> =
        active.iter().filter(|(tier, _)| *tier == Tier::Serious).map(|(_, end)| *end).collect();
    if !serious.is_empty() {
        let until = if serious.iter().any(Option::is_none) { None } else { serious.into_iter().flatten().max() };
        return Level::Suspended(until);
    }
    let mut ends: Vec<DateTime<Utc>> = active
        .iter()
        .filter(|(tier, _)| *tier == Tier::Violation)
        .filter_map(|(_, end)| *end)
        .collect();
    ends.sort();
    let n = ends.len();
    if n >= VIOLATIONS_FOR_RESTRICTION {
        // Ограничения снимаются, когда истечёт столько нарушений, что их станет
        // меньше трёх: при n действующих — в момент истечения (n−2)-го по счёту.
        return Level::Restricted(ends[n - VIOLATIONS_FOR_RESTRICTION]);
    }
    if n > 0 {
        return Level::Warnings(n);
    }
    Level::Ok
}

// ════════════════════════════════════════════════════════════════════════════
// Состояние в памяти: действующие ограничения, лимиты, будильник очереди
// ════════════════════════════════════════════════════════════════════════════

#[derive(Clone, Copy, Debug)]
struct ActiveRestriction {
    suspended: bool,
    /// `None` — бессрочно (только приостановка).
    until: Option<DateTime<Utc>>,
}

#[derive(Default)]
struct RateGate {
    /// Отправленные запросы за последнюю минуту.
    recent: VecDeque<Instant>,
    /// Общая пауза после 429/402/сбоя.
    paused_until: Option<Instant>,
}

pub(crate) struct ModerationRuntime {
    /// Только аккаунты с действующими ограничениями: проверка на каждом изменяющем
    /// запросе (`blocked_action`) не ходит в БД.
    restrictions: DashMap<String, ActiveRestriction>,
    wake: Notify,
    gate: Mutex<RateGate>,
    http: reqwest::Client,
    /// Подача жалоб идёт по одной: квота «посчитал → вставил» без этого
    /// превышалась параллельными запросами.
    submit: tokio::sync::Mutex<()>,
}

impl ModerationRuntime {
    /// Создаёт таблицы (идемпотентно) и поднимает в память действующие ограничения.
    pub(crate) async fn load(pool: &SqlitePool) -> Self {
        init_schema(pool).await;
        let runtime = Self {
            restrictions: DashMap::new(),
            wake: Notify::new(),
            gate: Mutex::new(RateGate::default()),
            submit: tokio::sync::Mutex::new(()),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        };
        revoke_retired_categories(pool).await;
        let users: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT username FROM moderation_violations
             WHERE revoked_at IS NULL AND tier IN ('violation', 'serious')
               AND (expires_at IS NULL OR expires_at > ?)",
        )
        .bind(ts(Utc::now()))
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        for user in users {
            if let Some(active) = load_active_restriction(pool, &user).await {
                runtime.restrictions.insert(user, active);
            }
        }
        runtime
    }

    fn gate_wait(&self, per_minute: u32) -> Option<Duration> {
        let mut gate = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        if let Some(until) = gate.paused_until {
            if until > now {
                return Some(until - now);
            }
            gate.paused_until = None;
        }
        let minute = Duration::from_secs(60);
        while gate.recent.front().is_some_and(|t| now.duration_since(*t) >= minute) {
            gate.recent.pop_front();
        }
        if gate.recent.len() as u32 >= per_minute.max(1) {
            let oldest = *gate.recent.front()?;
            return Some(minute.saturating_sub(now.duration_since(oldest)) + Duration::from_millis(20));
        }
        None
    }

    fn note_request(&self) {
        let mut gate = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        gate.recent.push_back(Instant::now());
    }

    fn pause_for(&self, wait: Duration) {
        let mut gate = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        let until = Instant::now() + wait;
        gate.paused_until = Some(gate.paused_until.map_or(until, |p| p.max(until)));
    }
}

async fn init_schema(pool: &SqlitePool) {
    let statements = [
        // Случай: одно нарушение одного человека. Жалобы других людей на те же
        // сообщения присоединяются к нему (moderation_report_reporters), а не
        // заводят новый — классификатор зовётся один раз на случай.
        "CREATE TABLE IF NOT EXISTS moderation_reports (
            id TEXT PRIMARY KEY,
            reporter TEXT NOT NULL,
            accused TEXT NOT NULL,
            scope TEXT NOT NULL,
            anchor_message_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            verification TEXT NOT NULL,
            status TEXT NOT NULL,
            reason TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT,
            category TEXT,
            violates REAL,
            verdict TEXT,
            violation_id TEXT,
            created_at TEXT NOT NULL,
            decided_at TEXT
        )",
        "CREATE INDEX IF NOT EXISTS idx_moderation_reports_status ON moderation_reports(status, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_moderation_reports_accused ON moderation_reports(accused, created_at)",
        "CREATE TABLE IF NOT EXISTS moderation_report_reporters (
            report_id TEXT NOT NULL,
            reporter TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (report_id, reporter)
        )",
        "CREATE INDEX IF NOT EXISTS idx_moderation_reporters_user ON moderation_report_reporters(reporter, created_at)",
        // Сообщения обвиняемого в красной зоне — по ним жалобы сливаются в случай.
        "CREATE TABLE IF NOT EXISTS moderation_report_messages (
            report_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            PRIMARY KEY (report_id, message_id)
        )",
        "CREATE INDEX IF NOT EXISTS idx_moderation_report_messages_msg ON moderation_report_messages(message_id)",
        // Мера. `expires_at` NULL — бессрочно (п. 6.2). `place` и `fragment` —
        // снимок на момент решения для страницы нарушения: где получено и что
        // именно (красная зона и пара сообщений вокруг).
        "CREATE TABLE IF NOT EXISTS moderation_violations (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            report_id TEXT,
            category TEXT NOT NULL,
            tier TEXT NOT NULL,
            gross INTEGER NOT NULL DEFAULT 0,
            expires_at TEXT,
            review_pending INTEGER NOT NULL DEFAULT 0,
            place TEXT NOT NULL DEFAULT '{}',
            fragment TEXT NOT NULL DEFAULT '[]',
            source TEXT NOT NULL,
            appeal_text TEXT,
            appeal_at TEXT,
            appeal_status TEXT,
            revoked_at TEXT,
            revoked_reason TEXT,
            created_at TEXT NOT NULL
        )",
        "CREATE INDEX IF NOT EXISTS idx_moderation_violations_user ON moderation_violations(username, created_at)",
        "CREATE TABLE IF NOT EXISTS moderation_api_usage (
            day TEXT PRIMARY KEY,
            requests INTEGER NOT NULL DEFAULT 0,
            cost REAL NOT NULL DEFAULT 0
        )",
    ];
    for sql in statements {
        sqlx::query(sql)
            .execute(pool)
            .await
            .expect("Ошибка создания таблиц модерации");
    }
}

pub(crate) fn ts(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|d| d.with_timezone(&Utc))
}

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": code, "message": message }))).into_response()
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

// ════════════════════════════════════════════════════════════════════════════
// Ограничения аккаунта: что нельзя делать
// ════════════════════════════════════════════════════════════════════════════

/// «Временные ограничения» — только чтение в общении: писать, реагировать,
/// заводить новые знакомства и менять публичное лицо нельзя. Удалять своё,
/// читать, звонить уже знакомым, настраивать ключи и устройства — можно.
const RESTRICTED_ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/upload"),
    ("POST", "/api/servers/*/channels/*/messages"),
    ("PUT", "/api/message/*"),
    ("POST", "/api/message/*/reaction"),
    ("POST", "/api/servers"),
    ("POST", "/api/servers/*/invites"),
    ("POST", "/api/contacts"),
    ("POST", "/api/friends/requests"),
    ("POST", "/api/profile/*/comments"),
    ("POST", "/api/profile/*/autographs"),
    ("PUT", "/api/profile"),
    ("POST", "/api/avatar"),
];

/// Приостановленный аккаунт может только читать, удалять своё и обслуживать
/// безопасность (ключи шифрования, устройства, пароль, выход) — иначе он не
/// дочитал бы свою же историю. Любой другой изменяющий запрос отклоняется.
const SUSPENDED_ALLOWED_PREFIXES: &[&str] = &[
    "/api/auth/",
    "/api/devices",
    "/api/vault/",
    "/api/key-envelopes",
    "/api/conversation-keys",
    "/api/history-tickets",
    "/api/push/",
    "/api/diagnostics/",
    "/api/moderation/",
    "/api/settings-sync",
    "/api/game-focus",
];

pub(crate) const RESTRICTED_SUMMARY: &[&str] = &[
    "отправка сообщений и реакций",
    "правка сообщений",
    "новые контакты и заявки в друзья",
    "создание серверов и приглашений",
    "изменение профиля и аватара",
];

fn route_matches(path: &str, pattern: &str) -> bool {
    let mut actual = path.trim_end_matches('/').split('/');
    let mut expected = pattern.split('/');
    loop {
        match (actual.next(), expected.next()) {
            (None, None) => return true,
            (Some(a), Some("*")) if !a.is_empty() => continue,
            (Some(a), Some(e)) if a == e => continue,
            _ => return false,
        }
    }
}

pub(crate) fn restricted_blocks(method: &Method, path: &str) -> bool {
    RESTRICTED_ROUTES
        .iter()
        .any(|(m, pattern)| method.as_str() == *m && route_matches(path, pattern))
}

pub(crate) fn suspended_blocks(method: &Method, path: &str) -> bool {
    if !matches!(*method, Method::POST | Method::PUT | Method::PATCH) {
        return false;
    }
    !SUSPENDED_ALLOWED_PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

/// Аккаунт сейчас заблокирован целиком. WS-события (звонки, инвайты, сигналинг)
/// HTTP-проверку `blocked_action` не проходят, поэтому `handle_voice_event` спрашивает
/// это отдельно.
pub(crate) fn is_suspended(state: &AppState, username: &str) -> bool {
    let Some(active) = state.moderation.restrictions.get(username).map(|entry| *entry) else {
        return false;
    };
    active.suspended && !active.until.is_some_and(|until| until <= Utc::now())
}

/// Зовётся из `AuthenticatedUser` на каждом запросе: `Some(код)` — запрос
/// отклоняется с 403 и этим кодом в теле. Чтение не проверяется вовсе.
pub(crate) fn blocked_action(
    state: &AppState,
    username: &str,
    method: &Method,
    path: &str,
) -> Option<&'static str> {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return None;
    }
    // Копия значения: держать guard DashMap и удалять тот же ключ — взаимоблокировка.
    let active = state.moderation.restrictions.get(username).map(|entry| *entry)?;
    if active.until.is_some_and(|until| until <= Utc::now()) {
        state.moderation.restrictions.remove(username);
        return None;
    }
    if active.suspended {
        suspended_blocks(method, path).then_some("account_suspended")
    } else {
        restricted_blocks(method, path).then_some("account_restricted")
    }
}

/// Действующие меры: `(id, тир, истекает, ждёт проверки)`.
async fn active_measures(
    pool: &SqlitePool,
    username: &str,
    now: DateTime<Utc>,
) -> Vec<(String, Tier, Option<DateTime<Utc>>, bool)> {
    sqlx::query(
        "SELECT id, tier, expires_at, review_pending FROM moderation_violations
         WHERE username = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(username)
    .bind(ts(now))
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .iter()
    .filter_map(|row| {
        let tier = Tier::parse(&row.get::<String, _>("tier"))?;
        Some((
            row.get::<String, _>("id"),
            tier,
            row.get::<Option<String>, _>("expires_at").as_deref().and_then(parse_ts),
            row.get::<i64, _>("review_pending") != 0,
        ))
    })
    .collect()
}

async fn load_active_restriction(pool: &SqlitePool, username: &str) -> Option<ActiveRestriction> {
    let active = active_measures(pool, username, Utc::now()).await;
    let pairs: Vec<(Tier, Option<DateTime<Utc>>)> = active.iter().map(|(_, t, e, _)| (*t, *e)).collect();
    match standing_level(&pairs) {
        Level::Suspended(until) => Some(ActiveRestriction { suspended: true, until }),
        Level::Restricted(until) => Some(ActiveRestriction { suspended: false, until: Some(until) }),
        Level::Ok | Level::Warnings(_) => None,
    }
}

async fn refresh_restriction_cache(state: &AppState, username: &str) {
    match load_active_restriction(&state.db, username).await {
        Some(active) => {
            let suspended = active.suspended;
            state.moderation.restrictions.insert(username.to_string(), active);
            if suspended {
                crate::disconnect_user_sockets(state, username);
            }
        }
        None => {
            state.moderation.restrictions.remove(username);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/moderation/reports
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize)]
pub(crate) struct ReportAttachmentInput {
    #[serde(default)]
    name: String,
    #[serde(default)]
    kind: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReportMessageInput {
    id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    attachments: Vec<ReportAttachmentInput>,
    #[serde(default)]
    zone: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReportInput {
    #[serde(rename = "anchorMessageId")]
    anchor_message_id: String,
    messages: Vec<ReportMessageInput>,
    #[serde(default)]
    comment: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Zone {
    Red,
    Orange,
    Context,
}

impl Zone {
    fn parse(raw: &str) -> Self {
        match raw.trim() {
            "red" => Zone::Red,
            "orange" => Zone::Orange,
            _ => Zone::Context,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Zone::Red => "red",
            Zone::Orange => "orange",
            Zone::Context => "context",
        }
    }
}

/// Позиции зоны в упорядоченном по времени списке идут подряд.
fn zone_is_contiguous(zones: &[Zone], zone: Zone) -> bool {
    let positions: Vec<usize> = zones
        .iter()
        .enumerate()
        .filter(|(_, z)| **z == zone)
        .map(|(i, _)| i)
        .collect();
    positions.windows(2).all(|w| w[1] == w[0] + 1)
}

/// Сколько непрерывных отрезков у зоны в упорядоченном по времени списке.
fn zone_runs(zones: &[Zone], zone: Zone) -> usize {
    zones
        .iter()
        .enumerate()
        .filter(|(i, z)| **z == zone && (*i == 0 || zones[i - 1] != zone))
        .count()
}

async fn count_since(pool: &SqlitePool, sql: &str, user: &str, since: DateTime<Utc>) -> i64 {
    sqlx::query_scalar(sql)
        .bind(user)
        .bind(ts(since))
        .fetch_one(pool)
        .await
        .unwrap_or(0)
}

/// До какого времени подача жалоб приостановлена за необоснованные.
async fn groundless_cooldown(pool: &SqlitePool, reporter: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let decided: Vec<String> = sqlx::query_scalar(
        "SELECT r.decided_at FROM moderation_report_reporters rr
         JOIN moderation_reports r ON r.id = rr.report_id
         WHERE rr.reporter = ? AND r.status = 'rejected' AND r.decided_at >= ?
         ORDER BY r.decided_at DESC LIMIT ?",
    )
    .bind(reporter)
    .bind(ts(now - ChronoDuration::days(GROUNDLESS_WINDOW_DAYS)))
    .bind(GROUNDLESS_LIMIT)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if (decided.len() as i64) < GROUNDLESS_LIMIT {
        return None;
    }
    let oldest = decided.last().and_then(|v| parse_ts(v))?;
    Some(oldest + ChronoDuration::days(GROUNDLESS_WINDOW_DAYS))
}

struct Quota {
    hour_left: i64,
    day_left: i64,
    open: i64,
    cooldown_until: Option<DateTime<Utc>>,
}

async fn reporter_quota(pool: &SqlitePool, reporter: &str, now: DateTime<Utc>) -> Quota {
    let per = "SELECT COUNT(*) FROM moderation_report_reporters WHERE reporter = ? AND created_at >= ?";
    let hour = count_since(pool, per, reporter, now - ChronoDuration::hours(1)).await;
    let day = count_since(pool, per, reporter, now - ChronoDuration::days(1)).await;
    let open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM moderation_reports WHERE reporter = ? AND status IN ('queued', 'processing')",
    )
    .bind(reporter)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    Quota {
        hour_left: (REPORTS_PER_HOUR - hour).max(0),
        day_left: (REPORTS_PER_DAY - day).max(0),
        open,
        cooldown_until: groundless_cooldown(pool, reporter, now).await,
    }
}

struct LoadedItem {
    message: Message,
    zone: Zone,
    text: String,
    attachments: Vec<Value>,
}

pub(crate) async fn submit_report(
    AuthenticatedUser(reporter): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "Жалоба слишком большая");
    }
    let input: ReportInput = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return api_error(StatusCode::BAD_REQUEST, "bad_request", "Не удалось разобрать жалобу"),
    };
    let _submit_guard = state.moderation.submit.lock().await;
    let now = Utc::now();

    let quota = reporter_quota(&state.db, &reporter, now).await;
    if let Some(until) = quota.cooldown_until {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": "reports_paused",
                "message": "Несколько ваших жалоб подряд оказались необоснованными — подача жалоб временно приостановлена",
                "until": ts(until),
            })),
        )
            .into_response();
    }
    if quota.hour_left <= 0 || quota.day_left <= 0 {
        let message = if quota.hour_left <= 0 {
            format!("Не больше {REPORTS_PER_HOUR} жалоб в час — попробуйте позже")
        } else {
            format!("Не больше {REPORTS_PER_DAY} жалоб в сутки — попробуйте завтра")
        };
        return api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited", &message);
    }

    // ── Форма жалобы ──
    let anchor_id = input.anchor_message_id.trim().to_string();
    if anchor_id.is_empty() || input.messages.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "bad_request", "В жалобе нет сообщений");
    }
    if input.messages.len() > MAX_TOTAL_MESSAGES {
        return api_error(StatusCode::BAD_REQUEST, "too_many_messages", "Слишком много сообщений в жалобе");
    }
    let mut seen = HashSet::new();
    let mut submitted: Vec<ReportMessageInput> = Vec::with_capacity(input.messages.len());
    for item in input.messages {
        let id = item.id.trim().to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        submitted.push(ReportMessageInput { id, ..item });
    }
    let red_count = submitted.iter().filter(|m| Zone::parse(&m.zone) == Zone::Red).count();
    let orange_count = submitted.iter().filter(|m| Zone::parse(&m.zone) == Zone::Orange).count();
    if red_count == 0 || red_count > MAX_ZONE_MESSAGES || orange_count > MAX_ZONE_MESSAGES {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad_zones",
            &format!("В красной зоне должно быть от 1 до {MAX_ZONE_MESSAGES} сообщений"),
        );
    }
    if !submitted.iter().any(|m| m.id == anchor_id && Zone::parse(&m.zone) == Zone::Red) {
        return api_error(StatusCode::BAD_REQUEST, "bad_zones", "Сообщение, на которое жалуются, должно быть в красной зоне");
    }

    // ── Сверка с БД: всё существует, одна переписка, видна заявителю ──
    let ids: Vec<String> = submitted.iter().map(|m| m.id.clone()).collect();
    let sql = format!("SELECT * FROM messages WHERE id IN ({})", placeholders(ids.len()));
    let mut query = sqlx::query_as::<_, Message>(&sql);
    for id in &ids {
        query = query.bind(id);
    }
    let rows = match query.fetch_all(&state.db).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!("moderation: чтение сообщений жалобы: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if rows.len() != ids.len() {
        return api_error(
            StatusCode::CONFLICT,
            "messages_missing",
            "Часть сообщений уже удалена — откройте переписку заново и повторите",
        );
    }
    let by_id: HashMap<String, Message> = rows.into_iter().map(|m| (m.id.clone(), m)).collect();
    let anchor = by_id[&anchor_id].clone();
    let scope = conversation_scope_for(&anchor);
    if by_id.values().any(|m| conversation_scope_for(m) != scope) {
        return api_error(StatusCode::BAD_REQUEST, "mixed_scope", "Сообщения из разных переписок");
    }
    match can_access_message(&state, &anchor, &reporter).await {
        Ok(true) => {}
        Ok(false) => return api_error(StatusCode::FORBIDDEN, "forbidden", "Нет доступа к этой переписке"),
        Err(e) => {
            warn!("moderation: проверка доступа: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    let accused = anchor.sender.clone();
    if accused == reporter {
        return api_error(StatusCode::BAD_REQUEST, "own_message", "Нельзя пожаловаться на своё сообщение");
    }

    // ── Порядок — по времени сервера; зоны — непрерывные отрезки ──
    let mut items: Vec<LoadedItem> = submitted
        .into_iter()
        .map(|m| {
            let attachments = m
                .attachments
                .iter()
                .take(MAX_ATTACHMENTS_PER_MESSAGE)
                .map(|a| json!({ "name": clip(&a.name, 120), "kind": clip(&a.kind, 32) }))
                .collect();
            LoadedItem {
                message: by_id[&m.id].clone(),
                zone: Zone::parse(&m.zone),
                text: clip(&m.text, MAX_TEXT_CHARS),
                attachments,
            }
        })
        .collect();
    items.sort_by(|a, b| {
        a.message
            .timestamp
            .cmp(&b.message.timestamp)
            .then_with(|| a.message.id.cmp(&b.message.id))
    });
    let zones: Vec<Zone> = items.iter().map(|i| i.zone).collect();
    if !zone_is_contiguous(&zones, Zone::Red) {
        return api_error(StatusCode::BAD_REQUEST, "bad_zones", "Зона нарушения должна быть непрерывной");
    }
    if zone_runs(&zones, Zone::Orange) > MAX_CONTEXT_ZONES {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad_zones",
            &format!("Важный контекст — не больше {MAX_CONTEXT_ZONES} отрезков"),
        );
    }
    let accused_red: Vec<String> = items
        .iter()
        .filter(|i| i.zone == Zone::Red && i.message.sender == accused)
        .map(|i| i.message.id.clone())
        .collect();

    // Сообщения переписки внутри присланного отрезка, которых в жалобе нет:
    // классификатор узнаёт, что контекст неполный (вырезанная реплика заявителя).
    let omitted = count_omitted(&state.db, &anchor, &items).await;

    // ── Те же сообщения уже рассматриваются или рассмотрены — присоединиться ──
    if let Some(resp) = merge_into_existing_case(&state, &reporter, &accused, &accused_red, now).await {
        return resp;
    }

    let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM moderation_reports WHERE status = 'queued'")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    if queued >= MAX_QUEUE {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "queue_full",
            "Очередь жалоб переполнена — попробуйте через несколько часов",
        );
    }
    if quota.open >= MAX_OPEN_PER_REPORTER {
        return api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_open",
            "Дождитесь решения по предыдущим жалобам",
        );
    }

    let comment = clip(&input.comment, MAX_COMMENT_CHARS);
    let payload = json!({
        "kind": if anchor.server_id.is_some() { "channel" } else { "dm" },
        "comment": comment,
        "omitted": omitted,
        "messages": items.iter().map(|i| json!({
            "id": i.message.id,
            "sender": i.message.sender,
            "ts": ts(i.message.timestamp),
            "zone": i.zone.as_str(),
            "text": i.text,
            "attachments": i.attachments,
        })).collect::<Vec<_>>(),
    });
    let verification = if anchor.server_id.is_some() { "pending" } else { "reporter" };
    let id = Uuid::new_v4().to_string();
    let created = ts(now);

    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            warn!("moderation: транзакция: {}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO moderation_reports
            (id, reporter, accused, scope, anchor_message_id, payload, verification, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
    )
    .bind(&id)
    .bind(&reporter)
    .bind(&accused)
    .bind(&scope)
    .bind(&anchor_id)
    .bind(payload.to_string())
    .bind(verification)
    .bind(&created)
    .execute(&mut *tx)
    .await;
    if let Err(e) = inserted {
        warn!("moderation: запись жалобы: {}", e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    for message_id in &accused_red {
        let _ = sqlx::query("INSERT OR IGNORE INTO moderation_report_messages (report_id, message_id) VALUES (?, ?)")
            .bind(&id)
            .bind(message_id)
            .execute(&mut *tx)
            .await;
    }
    let _ = sqlx::query("INSERT INTO moderation_report_reporters (report_id, reporter, created_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&reporter)
        .bind(&created)
        .execute(&mut *tx)
        .await;
    if let Err(e) = tx.commit().await {
        warn!("moderation: commit жалобы: {}", e);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    info!(
        "moderation: жалоба {} от {} на {} ({} сообщений, красных {}, оранжевых {})",
        id,
        reporter,
        accused,
        items.len(),
        red_count,
        orange_count
    );
    state.moderation.wake.notify_one();
    (
        StatusCode::CREATED,
        Json(json!({ "id": id, "status": "queued", "statusLabel": status_label("queued"), "merged": false })),
    )
        .into_response()
}

async fn count_omitted(pool: &SqlitePool, anchor: &Message, items: &[LoadedItem]) -> i64 {
    let (Some(first), Some(last)) = (items.first(), items.last()) else {
        return 0;
    };
    let present: HashSet<&str> = items.iter().map(|i| i.message.id.as_str()).collect();
    let ids: Vec<String> = if let Some(server_id) = anchor.server_id.as_deref() {
        sqlx::query_scalar(
            "SELECT id FROM messages WHERE server_id = ? AND channel_id = ?
             AND timestamp >= ? AND timestamp <= ? LIMIT 1000",
        )
        .bind(server_id)
        .bind(anchor.channel_id.as_deref().unwrap_or(""))
        .bind(first.message.timestamp)
        .bind(last.message.timestamp)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query_scalar(
            "SELECT id FROM messages WHERE server_id IS NULL
             AND ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
             AND timestamp >= ? AND timestamp <= ? LIMIT 1000",
        )
        .bind(&anchor.sender)
        .bind(&anchor.receiver)
        .bind(&anchor.receiver)
        .bind(&anchor.sender)
        .bind(first.message.timestamp)
        .bind(last.message.timestamp)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    };
    ids.iter().filter(|id| !present.contains(id.as_str())).count() as i64
}

async fn merge_into_existing_case(
    state: &Arc<AppState>,
    reporter: &str,
    accused: &str,
    accused_red: &[String],
    now: DateTime<Utc>,
) -> Option<Response> {
    if accused_red.is_empty() {
        return None;
    }
    let sql = format!(
        "SELECT r.id, r.status FROM moderation_report_messages m
         JOIN moderation_reports r ON r.id = m.report_id
         WHERE r.accused = ? AND m.message_id IN ({})
           AND (r.status IN ('queued', 'processing', 'review') OR r.decided_at >= ?)
         ORDER BY r.created_at ASC LIMIT 1",
        placeholders(accused_red.len())
    );
    let mut query = sqlx::query(&sql).bind(accused);
    for id in accused_red {
        query = query.bind(id);
    }
    let row = query
        .bind(ts(now - ChronoDuration::days(MERGE_WINDOW_DAYS)))
        .fetch_optional(&state.db)
        .await
        .ok()??;
    let case_id: String = row.get("id");
    let mut status: String = row.get("status");

    let added = sqlx::query(
        "INSERT OR IGNORE INTO moderation_report_reporters (report_id, reporter, created_at) VALUES (?, ?, ?)",
    )
    .bind(&case_id)
    .bind(reporter)
    .bind(ts(now))
    .execute(&state.db)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);
    if added == 0 {
        return Some(api_error(StatusCode::CONFLICT, "already_reported", "Вы уже пожаловались на это"));
    }
    // Несколько разных людей не согласны с «нарушений нет» — смотрит человек.
    if status == "rejected" {
        let reporters: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM moderation_report_reporters WHERE report_id = ?")
            .bind(&case_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);
        if reporters >= SECOND_OPINION_REPORTERS {
            let _ = sqlx::query("UPDATE moderation_reports SET status = 'review', reason = 'second_opinion' WHERE id = ?")
                .bind(&case_id)
                .execute(&state.db)
                .await;
            status = "review".to_string();
        }
    }
    info!("moderation: жалоба {} присоединена к случаю {} ({})", reporter, case_id, status);
    Some(
        (
            StatusCode::OK,
            Json(json!({ "id": case_id, "status": status, "statusLabel": status_label(&status), "merged": true })),
        )
            .into_response(),
    )
}

pub(crate) fn status_label(status: &str) -> &'static str {
    match status {
        "queued" | "processing" => "На проверке",
        "actioned" => "Нарушение подтверждено",
        "rejected" => "Нарушений не найдено",
        "review" => "Передано администрации",
        _ => "На проверке",
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Очередь: фоновая задача, лимиты OpenRouter, Jev
// ════════════════════════════════════════════════════════════════════════════

/// Запускает обработку очереди. Без `OPENROUTER_API_KEY` жалобы просто копятся
/// и будут разобраны, когда ключ появится.
pub(crate) fn spawn_worker(state: Arc<AppState>) {
    if state.config.openrouter_api_key.is_none() {
        info!("moderation: OPENROUTER_API_KEY не задан — жалобы копятся в очереди без классификатора");
        return;
    }
    if state.config.moderation_max_per_minute > 20 || state.config.moderation_max_per_day > 50 {
        warn!(
            "moderation: лимиты {}/мин и {}/сутки выше бесплатного тира OpenRouter (20/мин, 50/сутки без покупки $10)",
            state.config.moderation_max_per_minute, state.config.moderation_max_per_day
        );
    }
    tokio::spawn(async move {
        // Упали посреди запроса — жалоба возвращается в очередь.
        let _ = sqlx::query("UPDATE moderation_reports SET status = 'queued' WHERE status = 'processing'")
            .execute(&state.db)
            .await;
        loop {
            let pause = tick(&state).await;
            tokio::select! {
                _ = state.moderation.wake.notified() => {}
                _ = tokio::time::sleep(pause) => {}
            }
        }
    });
}

fn utc_day(now: DateTime<Utc>) -> String {
    now.format("%Y-%m-%d").to_string()
}

fn until_next_utc_day(now: DateTime<Utc>) -> Duration {
    let tomorrow = (now + ChronoDuration::days(1))
        .date_naive()
        .and_hms_opt(0, 0, 5)
        .map(|naive| naive.and_utc())
        .unwrap_or(now + ChronoDuration::hours(1));
    (tomorrow - now).to_std().unwrap_or(Duration::from_secs(3600))
}

async fn requests_today(pool: &SqlitePool, now: DateTime<Utc>) -> i64 {
    sqlx::query_scalar("SELECT requests FROM moderation_api_usage WHERE day = ?")
        .bind(utc_day(now))
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// Один шаг очереди. Возвращает, сколько ждать до следующего.
async fn tick(state: &Arc<AppState>) -> Duration {
    let per_minute = state.config.moderation_max_per_minute.max(1);
    let per_day = state.config.moderation_max_per_day.max(1) as i64;
    if let Some(wait) = state.moderation.gate_wait(per_minute) {
        return wait;
    }
    let now = Utc::now();
    if requests_today(&state.db, now).await >= per_day {
        return until_next_utc_day(now);
    }

    let next: Option<String> = sqlx::query_scalar(
        "SELECT id FROM moderation_reports
         WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(ts(now))
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let Some(id) = next else {
        let scheduled: Option<String> =
            sqlx::query_scalar("SELECT MIN(next_attempt_at) FROM moderation_reports WHERE status = 'queued'")
                .fetch_one(&state.db)
                .await
                .ok()
                .flatten();
        return scheduled
            .as_deref()
            .and_then(parse_ts)
            .and_then(|at| (at - now).to_std().ok())
            .map(|wait| wait.clamp(Duration::from_secs(1), IDLE_SLEEP))
            .unwrap_or(IDLE_SLEEP);
    };
    let claimed = sqlx::query("UPDATE moderation_reports SET status = 'processing' WHERE id = ? AND status = 'queued'")
        .bind(&id)
        .execute(&state.db)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);
    if claimed == 1 {
        process_report(state, &id).await;
    }
    Duration::from_millis(60_000 / u64::from(per_minute))
}

#[derive(Clone, Debug)]
struct PayloadMessage {
    id: String,
    sender: String,
    ts: String,
    zone: String,
    text: String,
    attachments: Vec<(String, String)>,
}

fn payload_messages(payload: &Value) -> Vec<PayloadMessage> {
    payload["messages"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|m| PayloadMessage {
                    id: m["id"].as_str().unwrap_or_default().to_string(),
                    sender: m["sender"].as_str().unwrap_or_default().to_string(),
                    ts: m["ts"].as_str().unwrap_or_default().to_string(),
                    zone: m["zone"].as_str().unwrap_or("context").to_string(),
                    text: m["text"].as_str().unwrap_or_default().to_string(),
                    attachments: m["attachments"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|x| {
                                    (
                                        x["kind"].as_str().unwrap_or("file").to_string(),
                                        x["name"].as_str().unwrap_or_default().to_string(),
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn process_report(state: &Arc<AppState>, id: &str) {
    let row = match sqlx::query(
        "SELECT reporter, accused, scope, payload, verification, attempts FROM moderation_reports WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(row)) => row,
        _ => return,
    };
    let accused: String = row.get("accused");
    let reporter: String = row.get("reporter");
    let scope: String = row.get("scope");
    let attempts: i64 = row.get("attempts");
    let mut verification: String = row.get("verification");
    let mut payload: Value = serde_json::from_str(&row.get::<String, _>("payload")).unwrap_or(Value::Null);

    // ── Канал: тексты обвиняемого сверяются с архивами на сервере ──
    if verification == "pending" {
        match verify_channel_payload(state, &scope, &accused, &mut payload).await {
            ChannelVerification::Mismatch => {
                finish_report(state, id, "review", Some("text_mismatch"), None, None, None).await;
                return;
            }
            ChannelVerification::Done(result) => {
                verification = result.to_string();
                let _ = sqlx::query("UPDATE moderation_reports SET verification = ?, payload = ? WHERE id = ?")
                    .bind(&verification)
                    .bind(payload.to_string())
                    .bind(id)
                    .execute(&state.db)
                    .await;
            }
        }
    }

    let messages = payload_messages(&payload);
    let has_media = messages
        .iter()
        .any(|m| m.zone == "red" && m.sender == accused && !m.attachments.is_empty());
    let jev_state = build_jev_state(
        &accused,
        &reporter,
        payload["kind"].as_str().unwrap_or("dm"),
        &messages,
        payload["comment"].as_str().unwrap_or_default(),
        payload["omitted"].as_i64().unwrap_or(0),
    );

    // Запрос считается до отправки: упавший по таймауту OpenRouter тоже засчитывает.
    state.moderation.note_request();
    let now = Utc::now();
    let _ = sqlx::query(
        "INSERT INTO moderation_api_usage (day, requests, cost) VALUES (?, 1, 0)
         ON CONFLICT(day) DO UPDATE SET requests = requests + 1",
    )
    .bind(utc_day(now))
    .execute(&state.db)
    .await;

    match call_jev(state, &jev_state, attempts).await {
        Ok(verdict) => {
            let _ = sqlx::query("UPDATE moderation_api_usage SET cost = cost + ? WHERE day = ?")
                .bind(verdict.cost)
                .bind(utc_day(now))
                .execute(&state.db)
                .await;
            let decision = decide(&verdict, has_media);
            info!(
                "moderation: {} → violates={:?} rule={:?} p={:.2} severity={:?} → {:?}",
                id,
                verdict.violates,
                verdict.rule,
                verdict.rule_probability,
                verdict.severity,
                decision
            );
            apply_decision(state, id, &accused, decision, Some(&verdict), &messages, &verification, "jev").await;
        }
        Err(JevError::Retry(after)) => {
            state.moderation.pause_for(after);
            if attempts + 1 >= MAX_ATTEMPTS {
                warn!("moderation: {} — {} попыток без ответа, передано администрации", id, attempts + 1);
                finish_report(state, id, "review", Some("classifier_unavailable"), None, None, None).await;
            } else {
                requeue(state, id, attempts + 1, after).await;
            }
        }
        Err(JevError::Halt(after, reason)) => {
            error!("moderation: OpenRouter отказал ({}), очередь на паузе {:?}", reason, after);
            state.moderation.pause_for(after);
            requeue(state, id, attempts, after).await;
        }
        Err(JevError::Fatal(reason)) => {
            warn!("moderation: {} — классификатор не принял запрос: {}", id, reason);
            finish_report(state, id, "review", Some("classifier_error"), None, None, None).await;
        }
    }
}

async fn requeue(state: &Arc<AppState>, id: &str, attempts: i64, after: Duration) {
    let at = Utc::now() + ChronoDuration::from_std(after).unwrap_or(ChronoDuration::minutes(1));
    let _ = sqlx::query(
        "UPDATE moderation_reports SET status = 'queued', attempts = ?, next_attempt_at = ? WHERE id = ?",
    )
    .bind(attempts)
    .bind(ts(at))
    .bind(id)
    .execute(&state.db)
    .await;
}

enum ChannelVerification {
    /// `server` — все тексты обвиняемого подтверждены, `partial` — часть,
    /// `reporter` — ни одного (старый ключ канала, вложение без текста…).
    Done(&'static str),
    /// Архив расшифровался, а текст другой: подделка или правка после жалобы.
    /// Ни то, ни другое автоматически не решить — смотрит человек.
    Mismatch,
}

fn derived_channel_key(scope: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("zali-channel-key-v1:{scope}").as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n").trim().to_string()
}

async fn verify_channel_payload(
    state: &Arc<AppState>,
    scope: &str,
    accused: &str,
    payload: &mut Value,
) -> ChannelVerification {
    let Some(list) = payload["messages"].as_array() else {
        return ChannelVerification::Done("reporter");
    };
    let targets: Vec<(usize, String)> = list
        .iter()
        .enumerate()
        .filter(|(_, m)| m["zone"] == "red" && m["sender"] == accused)
        .take(MAX_VERIFY_MESSAGES)
        .map(|(i, m)| (i, m["id"].as_str().unwrap_or_default().to_string()))
        .collect();
    if targets.is_empty() {
        return ChannelVerification::Done("reporter");
    }
    let sql = format!("SELECT id, filename FROM messages WHERE id IN ({})", placeholders(targets.len()));
    let mut query = sqlx::query(&sql);
    for (_, id) in &targets {
        query = query.bind(id);
    }
    let files: HashMap<String, String> = query
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|row| (row.get::<String, _>("id"), row.get::<String, _>("filename")))
        .collect();
    let jobs: Vec<(usize, PathBuf)> = targets
        .iter()
        .filter_map(|(i, id)| files.get(id).map(|f| (*i, state.uploads_dir.join(f))))
        .collect();
    let key = derived_channel_key(scope);
    // PBKDF2 на 210 000 итераций на каждый архив — не в рантайме tokio.
    let decrypted: Vec<(usize, Option<String>)> = tokio::task::spawn_blocking(move || {
        jobs.into_iter()
            .map(|(i, path)| {
                let text = std::fs::read(&path)
                    .ok()
                    .and_then(|bytes| zali_messenger_core::net::unpack_message_bytes(&bytes, &key).ok())
                    .map(|message| message.text);
                (i, text)
            })
            .collect()
    })
    .await
    .unwrap_or_default();

    let mut verified = 0usize;
    let Some(list) = payload["messages"].as_array_mut() else {
        return ChannelVerification::Done("reporter");
    };
    for (index, actual) in decrypted {
        let Some(actual) = actual else { continue };
        let claimed = list[index]["text"].as_str().unwrap_or_default();
        if normalize_text(claimed) != normalize_text(&actual) {
            return ChannelVerification::Mismatch;
        }
        list[index]["text"] = Value::String(clip(&actual, MAX_TEXT_CHARS));
        verified += 1;
    }
    ChannelVerification::Done(match verified {
        0 => "reporter",
        n if n == targets.len() => "server",
        _ => "partial",
    })
}

/// Состояние для Jev. Имена заменены метками (A — обвиняемый, R — заявитель,
/// U1, U2… — остальные): классификатору они не нужны, а OpenRouter и TypeSafe —
/// третьи лица.
fn build_jev_state(
    accused: &str,
    reporter: &str,
    kind: &str,
    messages: &[PayloadMessage],
    comment: &str,
    omitted: i64,
) -> Value {
    let mut aliases: HashMap<String, String> = HashMap::new();
    aliases.insert(accused.to_string(), "A".to_string());
    aliases.insert(reporter.to_string(), "R".to_string());
    for m in messages {
        if !aliases.contains_key(&m.sender) {
            let label = format!("U{}", aliases.len() - 1);
            aliases.insert(m.sender.clone(), label);
        }
    }
    // Длинные имена — первыми, чтобы «ann» не съело часть «anna».
    let mut names: Vec<(&String, &String)> = aliases.iter().filter(|(n, _)| n.chars().count() >= 3).collect();
    names.sort_by_key(|(n, _)| std::cmp::Reverse(n.len()));
    let anonymize = |text: &str| {
        let mut out = text.to_string();
        for (name, alias) in &names {
            out = out.replace(name.as_str(), alias);
        }
        out
    };

    let mut lines: Vec<(usize, Value)> = messages
        .iter()
        .enumerate()
        .map(|(n, m)| {
            let mut text = anonymize(&m.text.chars().take(STATE_TEXT_CHARS).collect::<String>());
            for (kind, name) in &m.attachments {
                text.push_str(&format!(" [attachment: {} «{}»]", kind, anonymize(name)));
            }
            (
                n,
                json!({
                    "n": n + 1,
                    "author": aliases.get(&m.sender).cloned().unwrap_or_else(|| "U?".to_string()),
                    "zone": m.zone,
                    "text": text,
                }),
            )
        })
        .collect();

    // Длинная жалоба: выкидываем контекст дальше всего от красной зоны, пока
    // текст не уложится в обычный режим Jev. Сами зоны не трогаем.
    let red: Vec<usize> = messages.iter().enumerate().filter(|(_, m)| m.zone == "red").map(|(i, _)| i).collect();
    let (red_lo, red_hi) = (red.first().copied().unwrap_or(0), red.last().copied().unwrap_or(0));
    let size = |lines: &[(usize, Value)]| lines.iter().map(|(_, v)| v.to_string().len()).sum::<usize>();
    while size(&lines) > MAX_STATE_TEXT_BYTES {
        let farthest = lines
            .iter()
            .enumerate()
            .filter(|(_, (_, v))| v["zone"] == "context")
            .max_by_key(|(_, (n, _))| if *n < red_lo { red_lo - n } else { n.saturating_sub(red_hi) })
            .map(|(pos, _)| pos);
        match farthest {
            Some(pos) => {
                lines.remove(pos);
            }
            None => break,
        }
    }

    let mut state = json!({
        "task": "A messenger user reported messages written by author A. Decide whether A's own messages inside the red zone break the community rules.",
        "conversation": if kind == "channel" { "a channel of a community server" } else { "private messages between two users" },
        "zones": "red = where the reporter says the violation happened; orange = context the reporter marked as important; context = surrounding messages. Authors: A = the reported user, R = the reporter, U1, U2… = other people.",
        "allowed_speech": "Criticism, opinions on politics and religion, profanity, rudeness, jokes, satire, memes, and consensual adult content between adults in private messages are allowed.",
        "transcript": lines.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
    });
    if !comment.trim().is_empty() {
        state["reporter_note"] = Value::String(anonymize(comment));
    }
    if omitted > 0 {
        state["omitted_messages"] = json!(format!(
            "{omitted} messages inside this range were not included by the reporter"
        ));
    }
    state
}

fn jev_questions() -> Value {
    let mut rules = serde_json::Map::new();
    rules.insert(
        "none".to_string(),
        Value::String("No rule from this list is broken by A's red-zone messages. This includes insults, name-calling, rudeness, profanity, arguments, trolling, annoying or repeated messages, criticism, opinions, jokes, dark humor, sarcasm, satire, memes, exaggerated or joking threats, and adult content of any kind between adults. Only the listed grave crimes count.".to_string()),
    );
    for category in CATEGORIES {
        rules.insert(category.key.to_string(), Value::String(category.criterion.to_string()));
    }
    json!({
        "violates": {
            "type": "noul",
            "instructions": "Do the messages written by author A inside the red zone break at least one of the community rules defined in the `rule` question? Messages by other authors and outside the red zone are context only.",
            "criteria": {
                "true": "A's own red-zone messages clearly contain prohibited content or a prohibited action.",
                "false": "A's red-zone messages are allowed speech: insults, rudeness, profanity, trolling, a joke or joking threat, hyperbole, a quote, or the report is an ordinary quarrel. When unsure whether it is serious, answer false."
            }
        },
        "rule": {
            "type": "choice",
            "instructions": "Which rule do A's red-zone messages break most seriously?",
            "criteria": Value::Object(rules)
        },
        "severity": {
            "type": "score",
            "instructions": "How serious is the violation in A's red-zone messages?",
            "criteria": [
                "No violation",
                "Minor or borderline violation",
                "Clear violation",
                "Gross violation: serious, deliberate, targeted, repeated, or creating real-world danger"
            ]
        }
    })
}

#[derive(Debug)]
enum JevError {
    /// 429, 5xx, обрыв, 402 «in-flight budget»: подождать и повторить.
    Retry(Duration),
    /// Ключ не принят или кончились кредиты: пауза надолго, жалоба ждёт.
    Halt(Duration, String),
    /// Запрос неверен (400 и т. п.) — повтор не поможет.
    Fatal(String),
}

#[derive(Debug)]
struct Verdict {
    violates: Option<f64>,
    rule: Option<String>,
    rule_probability: f64,
    severity: Option<f64>,
    cost: f64,
    raw: Value,
}

fn backoff(attempts: i64) -> Duration {
    let secs = 30u64.saturating_mul(1u64 << attempts.clamp(0, 5));
    Duration::from_secs(secs.min(15 * 60))
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    if let Some(secs) = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
    {
        return Some(Duration::from_secs_f64(secs.min(86_400.0)));
    }
    // OpenRouter на лимитах бесплатного тира: момент сброса в мс от эпохи.
    let reset_ms = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok())?;
    let wait = reset_ms - Utc::now().timestamp_millis();
    (wait > 0).then(|| Duration::from_millis((wait as u64).min(86_400_000)))
}

async fn call_jev(state: &AppState, jev_state: &Value, attempts: i64) -> Result<Verdict, JevError> {
    let Some(key) = state.config.openrouter_api_key.as_deref() else {
        return Err(JevError::Halt(HALT_SLEEP, "OPENROUTER_API_KEY не задан".to_string()));
    };
    let url = format!("{}/alpha/decisions", state.config.openrouter_base_url.trim_end_matches('/'));
    let body = json!({
        "model": state.config.moderation_model,
        "state": jev_state,
        "questions": jev_questions(),
    });
    let response = state
        .moderation
        .http
        .post(&url)
        .bearer_auth(key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| {
            warn!("moderation: OpenRouter недоступен: {}", e);
            JevError::Retry(backoff(attempts))
        })?;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.bytes().await.map_err(|_| JevError::Retry(backoff(attempts)))?;
    let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);

    if !status.is_success() {
        let message = json["error"]["message"].as_str().unwrap_or("").chars().take(200).collect::<String>();
        let limit_source = json["error"]["metadata"]["limit_source"].as_str().unwrap_or("");
        return Err(match status.as_u16() {
            429 => JevError::Retry(retry_after(&headers).unwrap_or_else(|| backoff(attempts).max(Duration::from_secs(60)))),
            402 if limit_source == "openrouter_in_flight_budget" => {
                JevError::Retry(retry_after(&headers).unwrap_or(Duration::from_secs(30)))
            }
            401 | 402 | 403 => JevError::Halt(HALT_SLEEP, format!("{status}: {message}")),
            408 | 500..=599 => JevError::Retry(retry_after(&headers).unwrap_or_else(|| backoff(attempts))),
            _ => JevError::Fatal(format!("{status}: {message}")),
        });
    }

    let answers = &json["answers"];
    if !answers.is_object() {
        return Err(JevError::Fatal("в ответе нет answers".to_string()));
    }
    let violates = (answers["violates"]["type"] == "noul")
        .then(|| answers["violates"]["noul"].as_f64())
        .flatten()
        .map(|p| p.clamp(0.0, 1.0));
    let rule = (answers["rule"]["type"] == "choice")
        .then(|| answers["rule"]["choice"].as_str().map(str::to_string))
        .flatten();
    let rule_probability = rule
        .as_deref()
        .and_then(|r| answers["rule"]["probabilities"][r].as_f64())
        .or_else(|| answers["rule"]["confidence"].as_f64())
        .unwrap_or(0.0);
    let severity = (answers["severity"]["type"] == "score")
        .then(|| answers["severity"]["score"].as_f64())
        .flatten();
    Ok(Verdict {
        violates,
        rule,
        rule_probability,
        severity,
        cost: json["usage"]["cost"].as_f64().unwrap_or(0.0),
        raw: json!({ "model": json["model"], "answers": answers, "usage": json["usage"] }),
    })
}

#[derive(Debug)]
enum Decision {
    Violation {
        category: &'static Category,
        gross: bool,
        minor: bool,
        /// Тир, выбранный администрацией вручную (иначе — по [`assign_tier`]).
        tier: Option<Tier>,
    },
    Reject,
    Review(&'static str),
}

fn decide(verdict: &Verdict, has_media: bool) -> Decision {
    let (Some(p), Some(rule)) = (verdict.violates, verdict.rule.as_deref()) else {
        return Decision::Review("refusal");
    };
    let category = category_by_key(rule);
    let gross = verdict.severity.is_some_and(|s| s >= GROSS_SEVERITY);
    let minor = verdict.severity.is_some_and(|s| s < MINOR_SEVERITY);
    match category {
        Some(category)
            if category.permanent
                && p >= SEVERE_PROTECTIVE_THRESHOLD
                && verdict.rule_probability >= RULE_MIN_PROBABILITY =>
        {
            Decision::Violation { category, gross: true, minor: false, tier: None }
        }
        Some(category) if p >= AUTO_ACTION_THRESHOLD && verdict.rule_probability >= RULE_MIN_PROBABILITY => {
            Decision::Violation { category, gross, minor, tier: None }
        }
        Some(category)
            if p >= AGREEMENT_VIOLATES
                && verdict.rule_probability >= AGREEMENT_RULE_PROBABILITY
                && verdict.severity.is_some_and(|s| s >= AGREEMENT_SEVERITY) =>
        {
            Decision::Violation { category, gross, minor, tier: None }
        }
        // Нарушение может быть в картинке, а Jev видит только подпись к ней.
        _ if p < REJECT_THRESHOLD && has_media => Decision::Review("media"),
        _ if p < REJECT_THRESHOLD => Decision::Reject,
        _ => Decision::Review("uncertain"),
    }
}

async fn finish_report(
    state: &Arc<AppState>,
    id: &str,
    status: &str,
    reason: Option<&str>,
    category: Option<&str>,
    verdict: Option<&Verdict>,
    violation_id: Option<&str>,
) {
    let _ = sqlx::query(
        "UPDATE moderation_reports
         SET status = ?, reason = ?, category = ?, violates = ?, verdict = ?, violation_id = ?, decided_at = ?
         WHERE id = ?",
    )
    .bind(status)
    .bind(reason)
    .bind(category)
    .bind(verdict.and_then(|v| v.violates))
    .bind(verdict.map(|v| v.raw.to_string()))
    .bind(violation_id)
    .bind(ts(Utc::now()))
    .bind(id)
    .execute(&state.db)
    .await;
    let reporters: Vec<String> = sqlx::query_scalar("SELECT reporter FROM moderation_report_reporters WHERE report_id = ?")
        .bind(id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    for reporter in reporters {
        send_json_to_user(
            state,
            &reporter,
            json!({ "type": "moderation_report_update", "id": id, "status": status, "statusLabel": status_label(status) }),
        )
        .await;
    }
}

/// Где получено нарушение: снимок имён на момент решения.
async fn resolve_place(pool: &SqlitePool, scope: &str, accused: &str) -> Value {
    let parts: Vec<&str> = scope.splitn(3, ':').collect();
    match parts.as_slice() {
        ["server", server_id, channel_id] => {
            let server_name: Option<String> = sqlx::query_scalar("SELECT name FROM servers WHERE id = ?")
                .bind(server_id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten();
            let channel_name: Option<String> = sqlx::query_scalar("SELECT name FROM channels WHERE id = ?")
                .bind(channel_id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten();
            json!({
                "kind": "channel",
                "serverId": server_id,
                "channelId": channel_id,
                "serverName": server_name.unwrap_or_else(|| "Сервер".to_string()),
                "channelName": channel_name.unwrap_or_else(|| "канал".to_string()),
            })
        }
        ["dm", a, b] => {
            let peer = if *a == accused { *b } else { *a };
            json!({ "kind": "dm", "peer": peer })
        }
        _ => json!({ "kind": "unknown" }),
    }
}

fn place_label(place: &Value) -> String {
    match place["kind"].as_str() {
        Some("channel") => format!(
            "{} · #{}",
            place["serverName"].as_str().unwrap_or("Сервер"),
            place["channelName"].as_str().unwrap_or("канал")
        ),
        Some("dm") => format!("Личная переписка с {}", place["peer"].as_str().unwrap_or("собеседником")),
        _ => "Переписка".to_string(),
    }
}

/// Фрагмент для страницы нарушения: красная зона и пара сообщений вокруг.
fn build_fragment(messages: &[PayloadMessage]) -> Value {
    let red: Vec<usize> = messages.iter().enumerate().filter(|(_, m)| m.zone == "red").map(|(i, _)| i).collect();
    let (Some(&lo), Some(&hi)) = (red.first(), red.last()) else {
        return json!([]);
    };
    let start = lo.saturating_sub(FRAGMENT_CONTEXT);
    let end = (hi + FRAGMENT_CONTEXT + 1).min(messages.len()).min(start + FRAGMENT_MAX);
    Value::Array(
        messages[start..end]
            .iter()
            .map(|m| {
                json!({
                    "sender": m.sender,
                    "ts": m.ts,
                    "zone": m.zone,
                    "text": clip(&m.text, FRAGMENT_TEXT_CHARS),
                    "attachments": m.attachments.iter().map(|(kind, name)| json!({ "kind": kind, "name": name })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

#[allow(clippy::too_many_arguments)]
async fn apply_decision(
    state: &Arc<AppState>,
    report_id: &str,
    accused: &str,
    decision: Decision,
    verdict: Option<&Verdict>,
    messages: &[PayloadMessage],
    verification: &str,
    source: &str,
) {
    let (category, gross, minor, forced_tier) = match decision {
        Decision::Reject => {
            finish_report(state, report_id, "rejected", None, verdict.and_then(|v| v.rule.as_deref()), verdict, None).await;
            return;
        }
        Decision::Review(reason) => {
            finish_report(state, report_id, "review", Some(reason), verdict.and_then(|v| v.rule.as_deref()), verdict, None).await;
            return;
        }
        // Текст ЛС сервер проверить не может (E2E): его прислал сам жалобщик. По такому
        // тексту авто-наказания нет — только ручная проверка. Раньше выдуманный текст
        // под реальными id сообщений давал жертве нарушение (аудит 2026-11-18).
        Decision::Violation { .. } if source != "operator" && verification == "reporter" => {
            finish_report(state, report_id, "review", Some("unverified"), verdict.and_then(|v| v.rule.as_deref()), verdict, None).await;
            return;
        }
        Decision::Violation { category, gross, minor, tier } => (category, gross, minor, tier),
    };

    // За одни и те же сообщения дважды не наказывают.
    let accused_red: Vec<&PayloadMessage> =
        messages.iter().filter(|m| m.zone == "red" && m.sender == accused).collect();
    if !accused_red.is_empty() {
        let sql = format!(
            "SELECT v.id FROM moderation_violations v
             JOIN moderation_report_messages m ON m.report_id = v.report_id
             WHERE v.username = ? AND v.revoked_at IS NULL AND v.report_id != ? AND m.message_id IN ({}) LIMIT 1",
            placeholders(accused_red.len())
        );
        let mut query = sqlx::query_scalar::<_, String>(&sql).bind(accused).bind(report_id);
        for m in &accused_red {
            query = query.bind(&m.id);
        }
        if let Ok(Some(existing)) = query.fetch_optional(&state.db).await {
            finish_report(state, report_id, "actioned", Some("already_punished"), Some(category.key), verdict, Some(&existing)).await;
            return;
        }
    }

    let now = Utc::now();
    let has_active_record = !active_measures(&state.db, accused, now).await.is_empty();
    let tier = forced_tier.unwrap_or_else(|| assign_tier(category, gross, minor, has_active_record));
    let expires_at = if tier == Tier::Serious && category.permanent {
        None
    } else {
        Some(ts(now + ChronoDuration::days(tier.ttl_days())))
    };
    // Автоматическая приостановка всегда ждёт подтверждения человеком.
    let review_pending = tier == Tier::Serious && source != "operator";
    let scope: String = sqlx::query_scalar("SELECT scope FROM moderation_reports WHERE id = ?")
        .bind(report_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let place = resolve_place(&state.db, &scope, accused).await;
    let fragment = build_fragment(messages);
    let violation_id = Uuid::new_v4().to_string();

    let inserted = sqlx::query(
        "INSERT INTO moderation_violations
            (id, username, report_id, category, tier, gross, expires_at, review_pending,
             place, fragment, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&violation_id)
    .bind(accused)
    .bind(report_id)
    .bind(category.key)
    .bind(tier.key())
    .bind(gross)
    .bind(&expires_at)
    .bind(review_pending)
    .bind(place.to_string())
    .bind(fragment.to_string())
    .bind(source)
    .bind(ts(now))
    .execute(&state.db)
    .await;
    if let Err(e) = inserted {
        error!("moderation: запись нарушения {}: {}", report_id, e);
        finish_report(state, report_id, "review", Some("store_error"), Some(category.key), verdict, None).await;
        return;
    }
    refresh_restriction_cache(state, accused).await;
    info!(
        "moderation: {} — {} {} ({}) у {} [тексты: {}, решение: {}]",
        report_id,
        tier.title(),
        category.rule,
        category.key,
        accused,
        verification,
        source
    );
    finish_report(state, report_id, "actioned", None, Some(category.key), verdict, Some(&violation_id)).await;
    send_json_to_user(state, accused, json!({ "type": "moderation_standing" })).await;
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/moderation/standing — полоска и карточки нарушений в хабе
// ════════════════════════════════════════════════════════════════════════════

pub(crate) fn tiers_json() -> Value {
    Value::Array(
        [Tier::Warning, Tier::Violation, Tier::Serious]
            .iter()
            .map(|t| json!({ "key": t.key(), "title": t.title(), "ttlDays": t.ttl_days(), "effect": t.effect() }))
            .collect(),
    )
}

pub(crate) fn policy_json() -> Value {
    Value::Array(
        CATEGORIES
            .iter()
            .map(|c| {
                json!({
                    "key": c.key,
                    "rule": c.rule,
                    "title": c.title,
                    "base": c.base.key(),
                    "gross": c.gross.key(),
                    "lenientFirst": c.lenient_first,
                    "permanent": c.permanent,
                })
            })
            .collect(),
    )
}

fn violation_summary(row: &sqlx::sqlite::SqliteRow, now: &str) -> Value {
    let category: String = row.get("category");
    let info = category_by_key(&category);
    let tier = Tier::parse(&row.get::<String, _>("tier")).unwrap_or(Tier::Violation);
    let revoked = row.get::<Option<String>, _>("revoked_at").is_some();
    let expires: Option<String> = row.get("expires_at");
    let place: Value = serde_json::from_str(&row.get::<String, _>("place")).unwrap_or(json!({}));
    let active = !revoked && expires.as_deref().map_or(true, |e| e > now);
    json!({
        "id": row.get::<String, _>("id"),
        "tier": tier.key(),
        "tierTitle": tier.title(),
        "rule": info.map(|c| c.rule).unwrap_or(""),
        "title": info.map(|c| c.title).unwrap_or("Нарушение правил"),
        "createdAt": row.get::<String, _>("created_at"),
        "expiresAt": expires,
        "ttlDays": tier.ttl_days(),
        "active": active,
        "revoked": revoked,
        "reviewPending": row.get::<i64, _>("review_pending") != 0,
        "appealStatus": row.get::<Option<String>, _>("appeal_status"),
        "place": place,
        "placeLabel": place_label(&place),
    })
}

const VIOLATION_COLUMNS: &str = "id, category, tier, expires_at, review_pending, place, appeal_status, revoked_at, created_at";

pub(crate) async fn get_standing(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
) -> Response {
    let now = Utc::now();
    let now_s = ts(now);
    let active = active_measures(&state.db, &username, now).await;
    let pairs: Vec<(Tier, Option<DateTime<Utc>>)> = active.iter().map(|(_, t, e, _)| (*t, *e)).collect();
    let level = standing_level(&pairs);
    let counted = pairs.iter().filter(|(t, _)| *t == Tier::Violation).count();
    let (key, title, until): (&str, String, Option<String>) = match &level {
        Level::Suspended(until) => ("suspended", "Аккаунт приостановлен".to_string(), until.map(ts)),
        Level::Restricted(until) => ("restricted", "Применены временные ограничения".to_string(), Some(ts(*until))),
        Level::Warnings(n) => (
            "warnings",
            format!("Получено {} из {} предупреждений", n, VIOLATIONS_FOR_RESTRICTION),
            None,
        ),
        Level::Ok => ("ok", "С аккаунтом все отлично!".to_string(), None),
    };
    let review_pending = matches!(level, Level::Suspended(_))
        && active.iter().any(|(_, t, _, pending)| *t == Tier::Serious && *pending);
    let blocked: Vec<&str> = match level {
        Level::Suspended(_) => vec!["всё, кроме чтения, удаления своего и настроек безопасности"],
        Level::Restricted(_) => RESTRICTED_SUMMARY.to_vec(),
        _ => Vec::new(),
    };

    let violations: Vec<Value> = sqlx::query(&format!(
        "SELECT {VIOLATION_COLUMNS} FROM moderation_violations WHERE username = ? ORDER BY created_at DESC LIMIT 30"
    ))
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .iter()
    .map(|row| violation_summary(row, &now_s))
    .collect();

    let reports: Vec<Value> = sqlx::query(
        "SELECT r.id, r.status, r.category, r.accused, rr.created_at, r.decided_at
         FROM moderation_report_reporters rr JOIN moderation_reports r ON r.id = rr.report_id
         WHERE rr.reporter = ? ORDER BY rr.created_at DESC LIMIT 20",
    )
    .bind(&username)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .iter()
    .map(|row| {
        let status: String = row.get("status");
        let category: Option<String> = row.get("category");
        json!({
            "id": row.get::<String, _>("id"),
            "status": status,
            "statusLabel": status_label(&status),
            "accused": row.get::<String, _>("accused"),
            "rule": (status == "actioned")
                .then(|| category.as_deref().and_then(category_by_key).map(|c| format!("{} · {}", c.rule, c.title)))
                .flatten(),
            "createdAt": row.get::<String, _>("created_at"),
            "decidedAt": row.get::<Option<String>, _>("decided_at"),
        })
    })
    .collect();

    let quota = reporter_quota(&state.db, &username, now).await;
    Json(json!({
        "level": key,
        "title": title,
        "counted": counted.min(VIOLATIONS_FOR_RESTRICTION),
        "maxCounted": VIOLATIONS_FOR_RESTRICTION,
        "until": until,
        "reviewPending": review_pending,
        "blocked": blocked,
        "violations": violations,
        "reports": reports,
        "reportQuota": {
            "hourLeft": quota.hour_left,
            "dayLeft": quota.day_left,
            "cooldownUntil": quota.cooldown_until.map(ts),
        },
        "limits": {
            "contextEachSide": CONTEXT_EACH_SIDE,
            "maxZoneMessages": MAX_ZONE_MESSAGES,
            "maxContextZones": MAX_CONTEXT_ZONES,
        },
        "tiers": tiers_json(),
        "policy": policy_json(),
    }))
    .into_response()
}

/// `GET /api/moderation/violations/:id` — страница нарушения: всё с карточки плюс
/// срок, место и фрагмент переписки. Только своё.
pub(crate) async fn get_violation(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let row = sqlx::query(&format!(
        "SELECT {VIOLATION_COLUMNS}, fragment, gross, source, appeal_text, appeal_at, revoked_reason
         FROM moderation_violations WHERE id = ? AND username = ?"
    ))
    .bind(&id)
    .bind(&username)
    .fetch_optional(&state.db)
    .await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            warn!("moderation: нарушение {}: {}", id, e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let now = ts(Utc::now());
    let mut summary = violation_summary(&row, &now);
    let tier = Tier::parse(&row.get::<String, _>("tier")).unwrap_or(Tier::Violation);
    let fragment: Value = serde_json::from_str(&row.get::<String, _>("fragment")).unwrap_or(json!([]));
    summary["effect"] = json!(tier.effect());
    summary["gross"] = json!(row.get::<i64, _>("gross") != 0);
    summary["source"] = json!(row.get::<String, _>("source"));
    summary["appealText"] = json!(row.get::<Option<String>, _>("appeal_text"));
    summary["appealAt"] = json!(row.get::<Option<String>, _>("appeal_at"));
    summary["revokedReason"] = json!(row.get::<Option<String>, _>("revoked_reason"));
    summary["fragment"] = fragment;
    Json(summary).into_response()
}

#[derive(Debug, Deserialize)]
pub(crate) struct AppealInput {
    #[serde(default)]
    text: String,
}

/// `POST /api/moderation/violations/:id/appeal` — возражение (п. 7.3 Правил).
/// Одно на нарушение; решает администрация (снять меру или оставить).
pub(crate) async fn appeal_violation(
    AuthenticatedUser(username): AuthenticatedUser,
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<AppealInput>,
) -> Response {
    let text = clip(&input.text, 1000);
    if text.chars().count() < 10 {
        return api_error(StatusCode::BAD_REQUEST, "too_short", "Опишите, почему мера ошибочна (хотя бы пару слов)");
    }
    let updated = sqlx::query(
        "UPDATE moderation_violations SET appeal_text = ?, appeal_at = ?, appeal_status = 'pending'
         WHERE id = ? AND username = ? AND revoked_at IS NULL AND appeal_status IS NULL",
    )
    .bind(&text)
    .bind(ts(Utc::now()))
    .bind(&id)
    .bind(&username)
    .execute(&state.db)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);
    if updated == 0 {
        // Почему не вышло — человеку нужна причина, а не общая фраза.
        let row = sqlx::query("SELECT revoked_at, appeal_status FROM moderation_violations WHERE id = ? AND username = ?")
            .bind(&id)
            .bind(&username)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
        return match row {
            None => api_error(StatusCode::NOT_FOUND, "not_found", "Мера не найдена"),
            Some(r) if r.get::<Option<String>, _>("revoked_at").is_some() => {
                api_error(StatusCode::CONFLICT, "revoked", "Мера уже снята — оспаривать нечего")
            }
            Some(_) => api_error(StatusCode::CONFLICT, "appeal_exists", "Возражение по этой мере уже подано"),
        };
    }
    info!("moderation: возражение {} по нарушению {}", username, id);
    Json(json!({ "ok": true, "appealStatus": "pending" })).into_response()
}

// ════════════════════════════════════════════════════════════════════════════
// Оператор (RELEASE_ADMIN_TOKEN): очередь «Передано администрации», возражения
// ════════════════════════════════════════════════════════════════════════════

pub(crate) async fn admin_queue(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let now = Utc::now();
    let usage = sqlx::query("SELECT requests, cost FROM moderation_api_usage WHERE day = ?")
        .bind(utc_day(now))
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM moderation_reports WHERE status IN ('queued', 'processing')")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    let review: Vec<Value> = sqlx::query(
        "SELECT r.id, r.reporter, r.accused, r.scope, r.reason, r.category, r.violates, r.verification,
                r.payload, r.verdict, r.created_at,
                (SELECT COUNT(*) FROM moderation_report_reporters rr WHERE rr.report_id = r.id) AS reporters
         FROM moderation_reports r WHERE r.status = 'review' ORDER BY r.created_at ASC LIMIT 50",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .iter()
    .map(|row| {
        json!({
            "id": row.get::<String, _>("id"),
            "reporter": row.get::<String, _>("reporter"),
            "accused": row.get::<String, _>("accused"),
            "scope": row.get::<String, _>("scope"),
            "reason": row.get::<Option<String>, _>("reason"),
            "category": row.get::<Option<String>, _>("category"),
            "violates": row.get::<Option<f64>, _>("violates"),
            "verification": row.get::<String, _>("verification"),
            "reporters": row.get::<i64, _>("reporters"),
            "payload": serde_json::from_str::<Value>(&row.get::<String, _>("payload")).unwrap_or(Value::Null),
            "verdict": row.get::<Option<String>, _>("verdict").and_then(|v| serde_json::from_str::<Value>(&v).ok()),
            "createdAt": row.get::<String, _>("created_at"),
        })
    })
    .collect();
    let pending: Vec<Value> = sqlx::query(
        "SELECT id, username, category, tier, review_pending, appeal_status, appeal_text, fragment, created_at
         FROM moderation_violations
         WHERE revoked_at IS NULL AND (review_pending = 1 OR appeal_status = 'pending')
         ORDER BY created_at ASC LIMIT 100",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .iter()
    .map(|row| {
        json!({
            "id": row.get::<String, _>("id"),
            "username": row.get::<String, _>("username"),
            "category": row.get::<String, _>("category"),
            "tier": row.get::<String, _>("tier"),
            "reviewPending": row.get::<i64, _>("review_pending") != 0,
            "appealStatus": row.get::<Option<String>, _>("appeal_status"),
            "appealText": row.get::<Option<String>, _>("appeal_text"),
            "fragment": serde_json::from_str::<Value>(&row.get::<String, _>("fragment")).unwrap_or(json!([])),
            "createdAt": row.get::<String, _>("created_at"),
        })
    })
    .collect();
    Json(json!({
        "classifier": {
            "configured": state.config.openrouter_api_key.is_some(),
            "model": state.config.moderation_model,
            "maxPerMinute": state.config.moderation_max_per_minute,
            "maxPerDay": state.config.moderation_max_per_day,
            "requestsToday": usage.as_ref().map(|r| r.get::<i64, _>("requests")).unwrap_or(0),
            "costToday": usage.as_ref().map(|r| r.get::<f64, _>("cost")).unwrap_or(0.0),
        },
        "queued": queued,
        "review": review,
        "violations": pending,
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
pub(crate) struct AdminDecision {
    /// `violation` или `reject`.
    decision: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    gross: bool,
    /// Тир вручную: `warning` | `violation` | `serious`. Без него — по пункту.
    #[serde(default)]
    tier: String,
}

pub(crate) async fn admin_decide_report(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<AdminDecision>,
) -> Response {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let row = match sqlx::query("SELECT accused, payload, verification, status FROM moderation_reports WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
    {
        Ok(Some(row)) => row,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    if row.get::<String, _>("status") == "processing" {
        return api_error(StatusCode::CONFLICT, "processing", "Жалобу прямо сейчас разбирает классификатор");
    }
    let decision = match input.decision.as_str() {
        "reject" => Decision::Reject,
        "violation" => match category_by_key(input.category.trim()) {
            Some(category) => Decision::Violation {
                category,
                gross: input.gross,
                minor: false,
                tier: Tier::parse(&input.tier),
            },
            None => return api_error(StatusCode::BAD_REQUEST, "bad_category", "Неизвестный пункт правил"),
        },
        _ => return api_error(StatusCode::BAD_REQUEST, "bad_decision", "decision: violation | reject"),
    };
    let accused: String = row.get("accused");
    let verification: String = row.get("verification");
    let payload: Value = serde_json::from_str(&row.get::<String, _>("payload")).unwrap_or(Value::Null);
    let messages = payload_messages(&payload);
    apply_decision(&state, &id, &accused, decision, None, &messages, &verification, "operator").await;
    Json(json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize)]
pub(crate) struct AdminRevoke {
    #[serde(default)]
    reason: String,
}

/// Снять меру (ошибка классификатора, удовлетворённое возражение).
pub(crate) async fn admin_revoke_violation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<AdminRevoke>,
) -> Response {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let username: Option<String> = sqlx::query_scalar(
        "UPDATE moderation_violations
         SET revoked_at = ?, revoked_reason = ?, review_pending = 0,
             appeal_status = CASE WHEN appeal_status = 'pending' THEN 'granted' ELSE appeal_status END
         WHERE id = ? AND revoked_at IS NULL RETURNING username",
    )
    .bind(ts(Utc::now()))
    .bind(clip(&input.reason, 500))
    .bind(&id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let Some(username) = username else {
        return StatusCode::NOT_FOUND.into_response();
    };
    refresh_restriction_cache(&state, &username).await;
    send_json_to_user(&state, &username, json!({ "type": "moderation_standing" })).await;
    info!("moderation: оператор снял нарушение {} у {}", id, username);
    Json(json!({ "ok": true })).into_response()
}

/// Оставить меру: снимает «ждёт проверки», отклоняет возражение, если оно было.
pub(crate) async fn admin_confirm_violation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !operator_authorized(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let username: Option<String> = sqlx::query_scalar(
        "UPDATE moderation_violations
         SET review_pending = 0,
             appeal_status = CASE WHEN appeal_status = 'pending' THEN 'declined' ELSE appeal_status END
         WHERE id = ? AND revoked_at IS NULL RETURNING username",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let Some(username) = username else {
        return StatusCode::NOT_FOUND.into_response();
    };
    send_json_to_user(&state, &username, json!({ "type": "moderation_standing" })).await;
    Json(json!({ "ok": true })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_patterns_match_whole_segments() {
        assert!(route_matches("/api/upload", "/api/upload"));
        assert!(route_matches("/api/message/abc/reaction", "/api/message/*/reaction"));
        assert!(route_matches("/api/servers/s1/channels/c1/messages", "/api/servers/*/channels/*/messages"));
        assert!(!route_matches("/api/servers/s1", "/api/servers"));
        assert!(!route_matches("/api/message//reaction", "/api/message/*/reaction"));
        assert!(!route_matches("/api/uploads", "/api/upload"));
    }

    #[test]
    fn restriction_blocks_writing_but_not_reading_or_deleting() {
        assert!(restricted_blocks(&Method::POST, "/api/upload"));
        assert!(restricted_blocks(&Method::PUT, "/api/message/m1"));
        assert!(!restricted_blocks(&Method::DELETE, "/api/message/m1"));
        assert!(!restricted_blocks(&Method::POST, "/api/key-envelopes"));
        assert!(!restricted_blocks(&Method::POST, "/api/moderation/reports"));
    }

    #[test]
    fn suspension_keeps_security_maintenance_open() {
        assert!(suspended_blocks(&Method::POST, "/api/coins/transfer"));
        assert!(suspended_blocks(&Method::POST, "/api/upload"));
        assert!(!suspended_blocks(&Method::POST, "/api/auth/logout"));
        assert!(!suspended_blocks(&Method::POST, "/api/key-envelopes"));
        assert!(!suspended_blocks(&Method::DELETE, "/api/message/m1"));
        assert!(!suspended_blocks(&Method::GET, "/api/messages/bob"));
    }

    fn at(days: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-18T00:00:00Z").unwrap().with_timezone(&Utc) + ChronoDuration::days(days)
    }

    #[test]
    fn warnings_never_move_the_bar() {
        let active = vec![(Tier::Warning, Some(at(10))), (Tier::Warning, Some(at(20))), (Tier::Warning, Some(at(30)))];
        assert_eq!(standing_level(&active), Level::Ok);
    }

    #[test]
    fn violations_fill_the_bar_and_three_restrict_until_one_expires() {
        let one = vec![(Tier::Violation, Some(at(60)))];
        assert_eq!(standing_level(&one), Level::Warnings(1));
        let three = vec![
            (Tier::Violation, Some(at(50))),
            (Tier::Violation, Some(at(10))),
            (Tier::Violation, Some(at(30))),
        ];
        assert_eq!(standing_level(&three), Level::Restricted(at(10)));
        // Четвёртое продлевает: меньше трёх станет, когда истекут два самых ранних.
        let mut four = three.clone();
        four.push((Tier::Violation, Some(at(55))));
        assert_eq!(standing_level(&four), Level::Restricted(at(30)));
    }

    #[test]
    fn serious_suspends_for_its_lifetime_or_forever() {
        let serious = vec![(Tier::Violation, Some(at(5))), (Tier::Serious, Some(at(90)))];
        assert_eq!(standing_level(&serious), Level::Suspended(Some(at(90))));
        let permanent = vec![(Tier::Serious, Some(at(90))), (Tier::Serious, None)];
        assert_eq!(standing_level(&permanent), Level::Suspended(None));
    }

    #[test]
    fn tiers_follow_category_severity_and_history() {
        // Оскорбления, спам, «угрозы» и прочее лёгкое больше не наказуемы.
        for retired in ["threats", "harassment", "spam", "impersonation", "adult_public", "insult"] {
            assert!(category_by_key(retired).is_none(), "{retired} не должен наказываться");
        }
        assert!(CATEGORIES.iter().all(|c| c.rule.starts_with("3.1.")));
        let fraud = category_by_key("fraud").unwrap();
        assert_eq!(assign_tier(fraud, false, false, false), Tier::Violation);
        assert_eq!(assign_tier(fraud, false, true, true), Tier::Warning);
        assert_eq!(assign_tier(fraud, true, false, false), Tier::Serious);
        let intimate = category_by_key("intimate").unwrap();
        assert_eq!(assign_tier(intimate, false, false, false), Tier::Serious);
        let csam = category_by_key("csam").unwrap();
        assert_eq!(assign_tier(csam, false, true, false), Tier::Serious);
        assert_eq!(Tier::Warning.ttl_days(), 30);
        assert_eq!(Tier::Violation.ttl_days(), 60);
        assert_eq!(Tier::Serious.ttl_days(), 90);
    }

    fn verdict(p: f64, rule: &str, rule_p: f64, severity: f64) -> Verdict {
        Verdict {
            violates: Some(p),
            rule: Some(rule.to_string()),
            rule_probability: rule_p,
            severity: Some(severity),
            cost: 0.0,
            raw: Value::Null,
        }
    }

    #[test]
    fn decisions_follow_thresholds() {
        assert!(matches!(decide(&verdict(0.95, "fraud", 0.9, 2.0), false), Decision::Violation { gross: false, minor: false, .. }));
        assert!(matches!(decide(&verdict(0.95, "fraud", 0.9, 2.8), false), Decision::Violation { gross: true, .. }));
        assert!(matches!(decide(&verdict(0.95, "doxxing", 0.9, 1.0), false), Decision::Violation { minor: true, .. }));
        assert!(matches!(decide(&verdict(0.1, "none", 0.9, 0.1), false), Decision::Reject));
        assert!(matches!(decide(&verdict(0.1, "none", 0.9, 0.1), true), Decision::Review("media")));
        assert!(matches!(decide(&verdict(0.6, "doxxing", 0.7, 2.0), false), Decision::Review("uncertain")));
        // Три сигнала согласны (живой ответ Jev на фишинг) — мера без человека.
        assert!(matches!(decide(&verdict(0.84, "fraud", 0.91, 2.87), false), Decision::Violation { gross: true, .. }));
        // Не согласны — человеку: пункт неуверенный или тяжесть мелкая.
        assert!(matches!(decide(&verdict(0.84, "fraud", 0.7, 2.87), false), Decision::Review("uncertain")));
        assert!(matches!(decide(&verdict(0.8, "fraud", 0.9, 1.4), false), Decision::Review("uncertain")));
        assert!(matches!(decide(&verdict(0.95, "none", 0.6, 2.0), false), Decision::Review("uncertain")));
        // П. 3.1.1 — защитная приостановка уже на 0.6.
        assert!(matches!(
            decide(&verdict(0.65, "csam", 0.8, 1.0), false),
            Decision::Violation { gross: true, category, .. } if category.key == "csam"
        ));
    }

    #[test]
    fn zones_must_be_contiguous() {
        use Zone::*;
        assert!(zone_is_contiguous(&[Context, Red, Red, Context], Red));
        assert!(!zone_is_contiguous(&[Red, Context, Red], Red));
        assert!(zone_is_contiguous(&[Context, Context], Orange));
        assert_eq!(zone_runs(&[Orange, Context, Red, Orange, Orange, Context, Orange], Orange), 3);
        assert_eq!(zone_runs(&[Context, Red], Orange), 0);
    }

    fn msg(id: &str, sender: &str, zone: &str, text: &str) -> PayloadMessage {
        PayloadMessage {
            id: id.into(),
            sender: sender.into(),
            ts: String::new(),
            zone: zone.into(),
            text: text.into(),
            attachments: vec![],
        }
    }

    #[test]
    fn jev_state_hides_names() {
        let messages = vec![
            msg("1", "alice", "context", "hi bobby"),
            msg("2", "bobby", "red", "alice you are next"),
            msg("3", "carol", "context", "?"),
        ];
        let state = build_jev_state("bobby", "alice", "channel", &messages, "", 0);
        let text = state.to_string();
        assert!(!text.contains("alice") && !text.contains("bobby") && !text.contains("carol"));
        assert_eq!(state["transcript"][1]["author"], "A");
        assert_eq!(state["transcript"][0]["author"], "R");
        assert_eq!(state["transcript"][2]["author"], "U1");
        assert_eq!(state["transcript"][1]["text"], "R you are next");
    }

    #[test]
    fn fragment_is_red_zone_with_two_around() {
        let messages: Vec<PayloadMessage> = (0..20)
            .map(|i| msg(&i.to_string(), "x", if (8..=9).contains(&i) { "red" } else { "context" }, "t"))
            .collect();
        let fragment = build_fragment(&messages);
        let list = fragment.as_array().unwrap();
        assert_eq!(list.len(), 6);
        assert_eq!(list[2]["zone"], "red");
        assert_eq!(list[3]["zone"], "red");
    }

    #[test]
    fn channel_key_matches_client_derivation() {
        // web/src/interface/conversation_keys.js: base64url(SHA-256('zali-channel-key-v1:' + scope)) без '='.
        let key = derived_channel_key("server:s1:c1");
        assert_eq!(key.len(), 43);
        assert!(!key.contains('=') && !key.contains('+') && !key.contains('/'));
    }
}
