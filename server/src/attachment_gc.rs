//! Очистка устаревших вложений, когда на диске сервера не хватает места.
//!
//! ## Что именно чистится
//!
//! Сообщение — один зашифрованный архив `.zali` в `uploads/` (клиент шифрует его целиком,
//! сервер не видит ни текста, ни вложений и разделить их не может). «Вложение» здесь —
//! архив сообщения, который вырос сверх `ZALI_ATTACHMENT_MIN_BYTES`: у текста медиана
//! ~300 байт, поэтому большие файлы почти целиком состоят из фото, видео и файлов.
//! Убрать из такого архива только вложение нельзя, значит единица очистки — **сообщение
//! целиком**: так же, как при удалении самим автором (строка, реакции, файл, запись
//! `delete` в хеш-цепочке, событие `message_deleted` онлайн-зрителям).
//!
//! ## Алгоритм (`run_once`)
//!
//! 0. **Давление.** Свободное место раздела `uploads/` (`statvfs`) и, если задана,
//!    суммарный размер каталога против квоты. Нижняя отметка (`MIN_FREE`) включает
//!    очистку, верхняя (`TARGET_FREE`) — выключает: зазор между ними не даёт чистке
//!    запускаться на каждой загрузке. Давления нет — выходим, не листая каталог.
//! 1. **Старые релизы** (`releases/`, дёшево и безопасно — идёт первым). Файл удаляется,
//!    только если одновременно: в имени есть версия (`ZaliMessenger-0.2b51.exe`;
//!    `ZaliMessengerOnlineSetup.exe` без версии — это установщик, его качают по постоянной
//!    ссылке — не трогаем никогда); ни одна строка `app_releases_v2` на него не ссылается
//!    (последний релиз каждой платформы и канала неприкосновенен), как и на файл, чьё имя он
//!    продолжает через точку (`….exe.sha256`); он старше `ZALI_RELEASES_KEEP_DAYS` (14) —
//!    запас на откат и на клиентов, уже начавших скачивание. Пустая таблица релизов — ничего
//!    не чистим: после сброса базы по ней нельзя отличить лишнее от нужного.
//! 1b. **Мусор вне базы.** Файлы без строки в `messages` (хвосты прерванных загрузок
//!    `*.tmp`, архивы после сбоя между «записал файл» и «записал строку») старше
//!    часа удаляются первыми и всегда: пользователю они ничего не стоят. Час —
//!    запас на загрузку, которая прямо сейчас доезжает.
//! 2. **Кандидаты.** Сообщения, у которых одновременно: файл не меньше `MIN_BYTES`;
//!    сообщению больше `MIN_AGE_DAYS`; оно не среди последних `KEEP_RECENT` своей
//!    переписки (окно по беседе — личка (пара) или канал; свежий контекст не трогаем).
//! 3. **Порядок.** Очки = размер × (1 + дней сверх `MIN_AGE_DAYS`): первым уходит то,
//!    что освобождает больше всего места ценой одного потерянного сообщения и успело
//!    «остыть». Берём по убыванию очков, пока не набрано нужное (до `TARGET_FREE` /
//!    ниже квоты), но не более `MAX_PER_RUN` сообщений и `BUDGET` секунд за запуск.
//! 4. **Удаление.** Для каждого: строка и реакции в одной транзакции (с защитой
//!    `filename = ?` от гонки с правкой), запись `delete` от имени `system:retention`,
//!    файл, событие зрителям. Свободное место перемеряется по ходу, чтобы остановиться,
//!    как только цель достигнута.
//! 5. **Если не хватило.** Всё доступное съедено, а места мало — громкое предупреждение
//!    в журнале: дальше нужна рука администратора (диск, квота, `MIN_AGE_DAYS`).
//!
//! ## Предохранители
//!
//! Режим по умолчанию `off`. `dry` делает всё, кроме удаления: пишет в журнал, сколько
//! и чего ушло бы. `on` удаляет. Нет ни одного ключа, который удалял бы без
//! возрастного порога и без «последних N».

use crate::{
    broadcast_message_deleted_event, conversation_scope_for, hash_archive_on_disk,
    last_payload_for_message, record_message_event_best_effort, AppState, ChainEvent, Message,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio::fs;
use tracing::{error, info, warn};

/// От имени кого очистка пишет в хеш-цепочку.
const ACTOR: &str = "system:retention";
/// Файл без строки в базе моложе этого не трогаем: загрузка могла ещё не записать строку.
const ORPHAN_GRACE: Duration = Duration::from_secs(3600);
const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Off,
    /// Считает и пишет в журнал, ничего не удаляя.
    Dry,
    On,
}

#[derive(Debug, Clone)]
pub(crate) struct GcConfig {
    pub(crate) mode: Mode,
    /// Нижняя отметка: свободно меньше — чистим.
    pub(crate) min_free: u64,
    /// Верхняя отметка: чистим, пока свободно меньше.
    pub(crate) target_free: u64,
    /// Потолок размера `uploads/` (0 — не ограничивать). Чистим при превышении до 85 %.
    pub(crate) quota: u64,
    pub(crate) min_age: Duration,
    pub(crate) min_bytes: u64,
    pub(crate) keep_recent: i64,
    pub(crate) max_per_run: usize,
    pub(crate) budget: Duration,
    /// Сколько лежат ненужные версионные файлы релизов, прежде чем их можно убрать.
    pub(crate) release_keep: Duration,
}

impl Default for GcConfig {
    fn default() -> Self {
        Self {
            mode: Mode::Off,
            min_free: 2 * GIB,
            target_free: 3 * GIB,
            quota: 0,
            min_age: Duration::from_secs(30 * 86_400),
            min_bytes: 256 * 1024,
            keep_recent: 50,
            max_per_run: 500,
            budget: Duration::from_secs(60),
            release_keep: Duration::from_secs(14 * 86_400),
        }
    }
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

impl GcConfig {
    /// `ZALI_ATTACHMENT_GC` = `off` (по умолчанию) | `dry` | `on`;
    /// `ZALI_UPLOADS_MIN_FREE_BYTES`, `ZALI_UPLOADS_TARGET_FREE_BYTES`, `ZALI_UPLOADS_QUOTA_BYTES`,
    /// `ZALI_ATTACHMENT_MIN_AGE_DAYS`, `ZALI_ATTACHMENT_MIN_BYTES`, `ZALI_ATTACHMENT_KEEP_RECENT`,
    /// `ZALI_ATTACHMENT_MAX_PER_RUN`, `ZALI_ATTACHMENT_BUDGET_SECS`.
    pub(crate) fn from_env() -> Self {
        let mut cfg = Self::default();
        cfg.mode = match std::env::var("ZALI_ATTACHMENT_GC").unwrap_or_default().trim().to_lowercase().as_str() {
            "on" | "1" | "true" => Mode::On,
            "dry" | "dry-run" => Mode::Dry,
            _ => Mode::Off,
        };
        if let Some(v) = env_u64("ZALI_UPLOADS_MIN_FREE_BYTES") {
            cfg.min_free = v;
        }
        if let Some(v) = env_u64("ZALI_UPLOADS_TARGET_FREE_BYTES") {
            cfg.target_free = v;
        }
        if let Some(v) = env_u64("ZALI_UPLOADS_QUOTA_BYTES") {
            cfg.quota = v;
        }
        if let Some(v) = env_u64("ZALI_ATTACHMENT_MIN_AGE_DAYS") {
            cfg.min_age = Duration::from_secs(v.saturating_mul(86_400));
        }
        if let Some(v) = env_u64("ZALI_ATTACHMENT_MIN_BYTES") {
            cfg.min_bytes = v;
        }
        if let Some(v) = env_u64("ZALI_ATTACHMENT_KEEP_RECENT") {
            cfg.keep_recent = i64::try_from(v).unwrap_or(i64::MAX);
        }
        if let Some(v) = env_u64("ZALI_ATTACHMENT_MAX_PER_RUN") {
            cfg.max_per_run = usize::try_from(v).unwrap_or(usize::MAX).max(1);
        }
        if let Some(v) = env_u64("ZALI_ATTACHMENT_BUDGET_SECS") {
            cfg.budget = Duration::from_secs(v.max(1));
        }
        if let Some(v) = env_u64("ZALI_RELEASES_KEEP_DAYS") {
            cfg.release_keep = Duration::from_secs(v.saturating_mul(86_400));
        }
        // Верхняя отметка не ниже нижней, иначе гистерезиса нет.
        if cfg.target_free < cfg.min_free {
            cfg.target_free = cfg.min_free;
        }
        cfg
    }
}

/// Свободное место раздела, на котором лежит `path`. `None` — не удалось узнать
/// (не Unix или ошибка `statvfs`): тогда давление по свободному месту не определяется.
#[cfg(unix)]
pub(crate) fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: c_path — валидная C-строка, stat — своя инициализированная структура.
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return None;
    }
    // f_bavail — доступное обычному процессу, а не весь свободный блок (резерв root не считается).
    Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(not(unix))]
pub(crate) fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

/// Сколько байт нужно освободить. Нуль — давления нет (или оно ещё в зазоре между отметками).
///
/// Свободное место: ниже `min_free` — довести до `target_free`. Квота: выше `quota` —
/// довести до 85 % квоты. Берётся большее из двух требований.
pub(crate) fn needed_bytes(cfg: &GcConfig, free: Option<u64>, used: u64) -> u64 {
    let by_free = match free {
        Some(free) if free < cfg.min_free => cfg.target_free.saturating_sub(free),
        _ => 0,
    };
    let by_quota = if cfg.quota > 0 && used > cfg.quota {
        used.saturating_sub(cfg.quota / 100 * 85)
    } else {
        0
    };
    by_free.max(by_quota)
}

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub(crate) message: Message,
    pub(crate) size: u64,
    pub(crate) age_secs: u64,
}

fn score(c: &Candidate, min_age: Duration) -> f64 {
    let over_days = c.age_secs.saturating_sub(min_age.as_secs()) as f64 / 86_400.0;
    c.size as f64 * (1.0 + over_days)
}

/// Кого удалять: по убыванию очков, пока не набрано `need` байт, не больше `max` штук.
/// Чистая функция — вся политика выбора проверяется тестами без диска и базы.
pub(crate) fn choose_victims(mut cands: Vec<Candidate>, need: u64, cfg: &GcConfig) -> Vec<Candidate> {
    cands.retain(|c| c.size >= cfg.min_bytes && c.age_secs >= cfg.min_age.as_secs());
    cands.sort_by(|a, b| {
        score(b, cfg.min_age)
            .partial_cmp(&score(a, cfg.min_age))
            .unwrap_or(std::cmp::Ordering::Equal)
            // При равных очках — старше, затем по id: порядок не зависит от выдачи базы.
            .then(b.age_secs.cmp(&a.age_secs))
            .then(a.message.id.cmp(&b.message.id))
    });
    let mut picked = Vec::new();
    let mut freed = 0u64;
    for c in cands {
        if freed >= need || picked.len() >= cfg.max_per_run {
            break;
        }
        freed = freed.saturating_add(c.size);
        picked.push(c);
    }
    picked
}

struct DiskFile {
    size: u64,
    modified: SystemTime,
}

/// Плоский список `uploads/`: имя → размер и время изменения. Один проход на запуск.
fn scan_uploads(dir: &Path) -> std::io::Result<(HashMap<String, DiskFile>, u64)> {
    let mut files = HashMap::new();
    let mut total = 0u64;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = match entry.metadata() {
            Ok(meta) if meta.is_file() => meta,
            _ => continue,
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        total = total.saturating_add(meta.len());
        files.insert(
            name,
            DiskFile {
                size: meta.len(),
                modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            },
        );
    }
    Ok((files, total))
}

#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct RunReport {
    pub(crate) mode: Option<Mode>,
    pub(crate) free_before: Option<u64>,
    pub(crate) need_before: u64,
    pub(crate) release_files: Vec<String>,
    pub(crate) release_bytes: u64,
    pub(crate) orphan_files: usize,
    pub(crate) orphan_bytes: u64,
    pub(crate) deleted_ids: Vec<String>,
    pub(crate) deleted_bytes: u64,
    /// Нужное освободить так и не удалось: доступное кончилось.
    pub(crate) short_by: u64,
}

/// Есть ли в имени версия сборки: `0.2b51`, `9.9r1`, `1.1.0`. Токены по `-` и `_`,
/// после версии допустимо только расширение. `ZaliMessengerOnlineSetup.exe`, `x.exe`,
/// `private.zali` версии не содержат — такие файлы чистка не трогает.
pub(crate) fn looks_versioned(name: &str) -> bool {
    name.split(['-', '_']).any(|token| {
        let b = token.as_bytes();
        let digits = |mut i: usize| {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            (i, i > start)
        };
        let (i, ok) = digits(0);
        if !ok || i >= b.len() || b[i] != b'.' {
            return false;
        }
        let (mut i, ok) = digits(i + 1);
        if !ok {
            return false;
        }
        // Хвост версии: канал и номер сборки (`b51`) или ещё одно число (`.0`).
        loop {
            if i < b.len() && matches!(b[i], b'a' | b'b' | b'r') {
                let (next, ok) = digits(i + 1);
                if !ok {
                    break;
                }
                i = next;
            } else if i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
                i = digits(i + 1).0;
            } else {
                break;
            }
        }
        i == b.len() || b[i] == b'.'
    })
}

/// Имена файлов, на которые ссылаются опубликованные релизы (`/releases/<имя>` или полный URL).
pub(crate) fn referenced_release_names(urls: &[String]) -> HashSet<String> {
    urls.iter()
        .filter_map(|url| {
            let tail = url.split(['?', '#']).next()?.rsplit('/').next()?;
            (!tail.is_empty()).then(|| tail.to_string())
        })
        .collect()
}

/// Можно ли убрать файл релиза: версионный, не опубликованный, не сопутствующий
/// опубликованному и достаточно старый. Любое «нет» — оставляем.
pub(crate) fn release_is_prunable(
    name: &str,
    referenced: &HashSet<String>,
    age: Duration,
    keep: Duration,
) -> bool {
    if name.starts_with('.') || !looks_versioned(name) || age < keep {
        return false;
    }
    if referenced.contains(name) {
        return false;
    }
    // Сопутствующие файлы опубликованного (`X.exe.sha256`, `X.exe.sig`).
    !referenced
        .iter()
        .any(|r| name.len() > r.len() && name.starts_with(r.as_str()) && name.as_bytes()[r.len()] == b'.')
}

/// Удаляет из `releases/` версионные файлы, на которые уже не ссылается ни один релиз.
/// Возвращает имена и суммарный размер (в `dry` — того, что было бы удалено).
async fn prune_releases(state: &Arc<AppState>, cfg: &GcConfig, dry: bool) -> (Vec<String>, u64) {
    let urls: Vec<String> = match sqlx::query_scalar("SELECT download_url FROM app_releases_v2")
        .fetch_all(&state.db)
        .await
    {
        Ok(urls) => urls,
        Err(e) => {
            error!("[GC] не удалось прочитать app_releases_v2: {}", e);
            return (Vec::new(), 0);
        }
    };
    // Нет ни одной публикации — по базе не отличить лишнее от нужного (сброс базы, свежая
    // установка, релиз ещё не опубликован).
    if urls.is_empty() {
        return (Vec::new(), 0);
    }
    let referenced = referenced_release_names(&urls);
    let dir = state.releases_dir.clone();
    let scanned = tokio::task::spawn_blocking(move || scan_uploads(&dir)).await;
    let Ok(Ok((files, _))) = scanned else {
        warn!("[GC] не удалось прочитать {}", state.releases_dir.display());
        return (Vec::new(), 0);
    };
    let now = SystemTime::now();
    let mut removed = Vec::new();
    let mut bytes = 0u64;
    let mut names: Vec<&String> = files.keys().collect();
    names.sort();
    for name in names {
        let file = &files[name];
        let age = now.duration_since(file.modified).unwrap_or_default();
        if !release_is_prunable(name, &referenced, age, cfg.release_keep) {
            continue;
        }
        if dry {
            info!("[GC][dry] удалил бы релиз {} ({} байт, {} дн.)", name, file.size, age.as_secs() / 86_400);
        } else if let Err(e) = fs::remove_file(state.releases_dir.join(name)).await {
            warn!("[GC] не удалось удалить релиз {}: {}", name, e);
            continue;
        } else {
            info!("[GC] удалён устаревший релиз {} ({} байт)", name, file.size);
        }
        removed.push(name.clone());
        bytes = bytes.saturating_add(file.size);
    }
    (removed, bytes)
}

const CANDIDATES_SQL: &str = "SELECT id, client_id, sender, receiver, filename, timestamp, key_version, server_id, channel_id
    FROM (
        SELECT m.*, ROW_NUMBER() OVER (
            PARTITION BY CASE
                WHEN m.server_id IS NOT NULL AND m.channel_id IS NOT NULL THEN m.server_id || ':' || m.channel_id
                WHEN m.sender < m.receiver THEN m.sender || '|' || m.receiver
                ELSE m.receiver || '|' || m.sender
            END
            ORDER BY m.timestamp DESC, m.id DESC
        ) AS rn
        FROM messages m
    )
    WHERE rn > ?1 AND timestamp < ?2";

/// Один проход очистки. Возвращает отчёт — для журнала и тестов.
pub(crate) async fn run_once(state: &Arc<AppState>, cfg: &GcConfig) -> RunReport {
    let mut report = RunReport { mode: Some(cfg.mode), ..RunReport::default() };
    if cfg.mode == Mode::Off {
        return report;
    }
    let started = Instant::now();
    let free = free_bytes(&state.uploads_dir);
    report.free_before = free;
    // Дешёвый выход: места хватает и квоты нет — каталог даже не листаем.
    if cfg.quota == 0 && free.map_or(true, |f| f >= cfg.min_free) {
        return report;
    }

    let dir = state.uploads_dir.clone();
    let scanned = tokio::task::spawn_blocking(move || scan_uploads(&dir)).await;
    let (files, used) = match scanned {
        Ok(Ok(scanned)) => scanned,
        Ok(Err(e)) => {
            error!("[GC] не удалось прочитать {}: {}", state.uploads_dir.display(), e);
            return report;
        }
        Err(e) => {
            error!("[GC] сканирование каталога прервано: {}", e);
            return report;
        }
    };

    let need = needed_bytes(cfg, free, used);
    report.need_before = need;
    if need == 0 {
        return report;
    }
    let dry = cfg.mode == Mode::Dry;
    info!(
        "[GC] давление: свободно={:?} используется={} нужно освободить={} режим={:?}",
        free, used, need, cfg.mode
    );

    // Шаг 0. Устаревшие релизы — самое дешёвое: пользователи их не ждут.
    let mut remaining = need;
    let (release_files, release_bytes) = prune_releases(state, cfg, dry).await;
    report.release_files = release_files;
    report.release_bytes = release_bytes;
    remaining = remaining.saturating_sub(release_bytes);

    // Шаг 1. Файлы без строки в базе.
    let known: HashSet<String> = match sqlx::query_scalar::<_, String>("SELECT filename FROM messages")
        .fetch_all(&state.db)
        .await
    {
        Ok(names) => names.into_iter().collect(),
        Err(e) => {
            // Без списка известных файлов «сирот» не отличить от живых — ничего не удаляем.
            error!("[GC] не удалось прочитать messages.filename: {}", e);
            return report;
        }
    };
    let now = SystemTime::now();
    for (name, file) in &files {
        if known.contains(name) {
            continue;
        }
        let age = now.duration_since(file.modified).unwrap_or_default();
        if age < ORPHAN_GRACE {
            continue;
        }
        report.orphan_files += 1;
        report.orphan_bytes = report.orphan_bytes.saturating_add(file.size);
        if !dry {
            if let Err(e) = fs::remove_file(state.uploads_dir.join(name)).await {
                warn!("[GC] не удалось удалить сироту {}: {}", name, e);
                report.orphan_files -= 1;
                report.orphan_bytes = report.orphan_bytes.saturating_sub(file.size);
                continue;
            }
        }
    }
    remaining = remaining.saturating_sub(report.orphan_bytes);
    // Релизов и сирот хватило — сообщения не трогаем вовсе.

    // Шаги 2–4. Устаревшие большие сообщения.
    if remaining > 0 {
        let cutoff: DateTime<Utc> = Utc::now() - ChronoDuration::seconds(cfg.min_age.as_secs() as i64);
        let rows = sqlx::query_as::<_, Message>(CANDIDATES_SQL)
            .bind(cfg.keep_recent)
            .bind(cutoff)
            .fetch_all(&state.db)
            .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(e) => {
                error!("[GC] не удалось выбрать кандидатов: {}", e);
                return report;
            }
        };
        let now_utc = Utc::now();
        let cands: Vec<Candidate> = rows
            .into_iter()
            .filter_map(|message| {
                let size = files.get(&message.filename)?.size;
                let age_secs = (now_utc - message.timestamp).num_seconds().max(0) as u64;
                Some(Candidate { message, size, age_secs })
            })
            .collect();
        let victims = choose_victims(cands, remaining, cfg);
        let planned: u64 = victims.iter().map(|v| v.size).sum();
        info!(
            "[GC] план: {} сообщений на {} байт (нужно {}), сирот {} на {} байт",
            victims.len(),
            planned,
            remaining,
            report.orphan_files,
            report.orphan_bytes
        );
        for victim in victims {
            if started.elapsed() >= cfg.budget {
                info!("[GC] лимит времени запуска исчерпан");
                break;
            }
            // Цель достигнута по живому счётчику — не доедаем по плану.
            if !dry {
                if let Some(now_free) = free_bytes(&state.uploads_dir) {
                    if cfg.quota == 0 && now_free >= cfg.target_free {
                        break;
                    }
                }
            }
            if dry {
                info!(
                    "[GC][dry] удалил бы id={} размер={} возраст={}д",
                    victim.message.id,
                    victim.size,
                    victim.age_secs / 86_400
                );
                report.deleted_ids.push(victim.message.id.clone());
                report.deleted_bytes = report.deleted_bytes.saturating_add(victim.size);
                continue;
            }
            if purge_message(state, &victim.message).await {
                report.deleted_ids.push(victim.message.id.clone());
                report.deleted_bytes = report.deleted_bytes.saturating_add(victim.size);
            }
        }
        remaining = remaining.saturating_sub(report.deleted_bytes);
    }

    report.short_by = remaining;
    if remaining > 0 {
        warn!(
            "[GC] освободить удалось не всё: не хватает ещё {} байт. Доступное по правилам кончилось — \
             нужен диск побольше, квота или меньший ZALI_ATTACHMENT_MIN_AGE_DAYS.",
            remaining
        );
    }
    info!(
        "[GC] итог: релизов {} ({} байт), сирот {} ({} байт), сообщений {} ({} байт), режим={:?}",
        report.release_files.len(),
        report.release_bytes,
        report.orphan_files,
        report.orphan_bytes,
        report.deleted_ids.len(),
        report.deleted_bytes,
        cfg.mode
    );
    report
}

/// Удаляет сообщение так же, как это делает автор (`delete_message`), но от имени
/// `system:retention`. `false` — сообщение уже изменилось или пропало, пропускаем.
async fn purge_message(state: &Arc<AppState>, m: &Message) -> bool {
    let path = state.uploads_dir.join(&m.filename);
    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            error!("[GC] транзакция для {}: {}", m.id, e);
            return false;
        }
    };
    if let Err(e) = sqlx::query("DELETE FROM reactions WHERE message_id = ?")
        .bind(&m.id)
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        error!("[GC] реакции {}: {}", m.id, e);
        return false;
    }
    // `filename = ?`: если сообщение успели отредактировать (файл сменился), его трогать
    // уже нельзя — оно «свежее» того, что мы выбирали.
    match sqlx::query("DELETE FROM messages WHERE id = ? AND filename = ?")
        .bind(&m.id)
        .bind(&m.filename)
        .execute(&mut *tx)
        .await
    {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => {
            let _ = tx.rollback().await;
            return false;
        }
        Err(e) => {
            let _ = tx.rollback().await;
            error!("[GC] удаление строки {}: {}", m.id, e);
            return false;
        }
    }
    if let Err(e) = tx.commit().await {
        error!("[GC] фиксация {}: {}", m.id, e);
        return false;
    }

    // Цепочка узнаёт, какой архив ушёл, ДО удаления файла (как в delete_message).
    let scope = conversation_scope_for(m);
    let (sha, size) = match hash_archive_on_disk(&path).await {
        Some(hashed) => hashed,
        None => last_payload_for_message(state, &scope, &m.id).await,
    };
    let _ = fs::remove_file(&path).await;
    record_message_event_best_effort(state, &scope, &m.id, ChainEvent::Delete, ACTOR, &sha, size).await;
    broadcast_message_deleted_event(state, m).await;
    info!("[GC] удалено сообщение id={} файл={} байт={}", m.id, m.filename, size);
    true
}

/// Фоновая задача: раз в 10 минут, а под давлением — раз в минуту, пока не отпустит.
pub(crate) fn spawn(state: Arc<AppState>) {
    let cfg = GcConfig::from_env();
    if cfg.mode == Mode::Off {
        return;
    }
    info!(
        "[GC] очистка вложений включена: режим={:?} min_free={} target_free={} quota={} min_age={}д min_bytes={} keep_recent={}",
        cfg.mode,
        cfg.min_free,
        cfg.target_free,
        cfg.quota,
        cfg.min_age.as_secs() / 86_400,
        cfg.min_bytes,
        cfg.keep_recent
    );
    tokio::spawn(async move {
        loop {
            let report = run_once(&state, &cfg).await;
            let pressed = report.need_before > 0;
            tokio::time::sleep(Duration::from_secs(if pressed { 60 } else { 600 })).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str) -> Message {
        Message {
            id: id.to_string(),
            client_id: None,
            sender: "a".into(),
            receiver: "b".into(),
            filename: format!("{id}.zali"),
            timestamp: Utc::now(),
            key_version: Some(2),
            server_id: None,
            channel_id: None,
        }
    }

    fn cand(id: &str, size: u64, age_days: u64) -> Candidate {
        Candidate { message: msg(id), size, age_secs: age_days * 86_400 }
    }

    fn cfg() -> GcConfig {
        GcConfig { mode: Mode::On, min_age: Duration::from_secs(30 * 86_400), min_bytes: 1000, max_per_run: 100, ..GcConfig::default() }
    }

    #[test]
    fn no_pressure_between_the_watermarks() {
        let c = cfg();
        // Ниже верхней отметки, но не ниже нижней: чистка не стартует.
        assert_eq!(needed_bytes(&c, Some(c.min_free + 1), 0), 0);
        assert_eq!(needed_bytes(&c, Some(c.target_free), 0), 0);
        // Неизвестное свободное место без квоты — давления нет.
        assert_eq!(needed_bytes(&c, None, u64::MAX), 0);
    }

    #[test]
    fn below_the_low_mark_we_clean_up_to_the_high_mark() {
        let c = cfg();
        let free = c.min_free - 10;
        assert_eq!(needed_bytes(&c, Some(free), 0), c.target_free - free);
    }

    #[test]
    fn quota_overflow_cleans_down_to_85_percent() {
        let mut c = cfg();
        c.quota = 1000;
        assert_eq!(needed_bytes(&c, Some(u64::MAX), 1000), 0);
        assert_eq!(needed_bytes(&c, Some(u64::MAX), 1100), 1100 - 850);
        // Берётся большее из двух требований.
        let free = c.min_free - 5;
        assert_eq!(needed_bytes(&c, Some(free), 1100), (c.target_free - free).max(250));
    }

    #[test]
    fn young_and_small_are_never_chosen() {
        let c = cfg();
        let picked = choose_victims(
            vec![cand("young", 10_000_000, 29), cand("tiny", 999, 400), cand("ok", 5000, 31)],
            u64::MAX,
            &c,
        );
        assert_eq!(picked.iter().map(|p| p.message.id.as_str()).collect::<Vec<_>>(), vec!["ok"]);
    }

    #[test]
    fn biggest_and_stalest_go_first() {
        let c = cfg();
        // big: 1000 × (1+1) = 2000·k; old: 100 × (1+300) = 30100·k — старое мелкое весомее.
        let picked = choose_victims(
            vec![cand("big", 10_000, 31), cand("old", 10_000, 330), cand("mid", 10_000, 90)],
            u64::MAX,
            &c,
        );
        let ids: Vec<_> = picked.iter().map(|p| p.message.id.as_str()).collect();
        assert_eq!(ids, vec!["old", "mid", "big"]);
    }

    #[test]
    fn stops_as_soon_as_enough_bytes_are_picked() {
        let c = cfg();
        let picked = choose_victims(
            vec![cand("a", 4000, 100), cand("b", 4000, 90), cand("c", 4000, 80)],
            6000,
            &c,
        );
        assert_eq!(picked.len(), 2, "двух хватает: 8000 ≥ 6000");
        assert!(choose_victims(vec![cand("a", 4000, 100)], 0, &c).is_empty());
    }

    #[test]
    fn respects_the_per_run_cap() {
        let mut c = cfg();
        c.max_per_run = 2;
        let cands = (0..5).map(|i| cand(&format!("m{i}"), 5000, 60 + i)).collect();
        assert_eq!(choose_victims(cands, u64::MAX, &c).len(), 2);
    }

    #[test]
    fn order_is_deterministic_for_equal_scores() {
        let c = cfg();
        let ids = |v: Vec<Candidate>| v.into_iter().map(|c| c.message.id).collect::<Vec<_>>();
        let a = ids(choose_victims(vec![cand("z", 5000, 60), cand("a", 5000, 60)], u64::MAX, &c));
        let b = ids(choose_victims(vec![cand("a", 5000, 60), cand("z", 5000, 60)], u64::MAX, &c));
        assert_eq!(a, b);
        assert_eq!(a[0], "a");
    }

    #[test]
    fn env_defaults_are_off_and_hysteretic() {
        let c = GcConfig::default();
        assert_eq!(c.mode, Mode::Off);
        assert!(c.target_free > c.min_free);
        assert!(c.keep_recent > 0 && c.min_age >= Duration::from_secs(86_400));
    }

    #[test]
    fn version_in_the_name_is_recognised() {
        for yes in ["ZaliMessenger-0.2b51.exe", "ZaliMessenger-9.9r1.exe", "ZaliMessenger-9.9b1.apk", "ZaliMessenger-1.1.0.exe", "app_0.2a7.zip"] {
            assert!(looks_versioned(yes), "{yes}");
        }
        // Установщик без версии и служебные имена — не версионные: их не чистим никогда.
        for no in ["ZaliMessengerOnlineSetup.exe", "x.exe", "ok.exe", "private.zali", "nope-.exe", "release-notes.txt", "v2.exe"] {
            assert!(!looks_versioned(no), "{no}");
        }
    }

    #[test]
    fn referenced_names_come_from_urls() {
        let refs = referenced_release_names(&[
            "https://msgs.zalikus.org/releases/ZaliMessenger-0.2b85.exe".to_string(),
            "/releases/Zali-0.2b85.apk?x=1#frag".to_string(),
        ]);
        assert!(refs.contains("ZaliMessenger-0.2b85.exe") && refs.contains("Zali-0.2b85.apk"));
    }

    #[test]
    fn only_old_unpublished_versioned_files_are_prunable() {
        let keep = Duration::from_secs(14 * 86_400);
        let old = Duration::from_secs(15 * 86_400);
        let young = Duration::from_secs(13 * 86_400);
        let refs: HashSet<String> = ["ZaliMessenger-0.2b85.exe".to_string()].into();
        assert!(release_is_prunable("ZaliMessenger-0.2b80.exe", &refs, old, keep));
        // Опубликованный и его сопутствующие файлы.
        assert!(!release_is_prunable("ZaliMessenger-0.2b85.exe", &refs, old, keep));
        assert!(!release_is_prunable("ZaliMessenger-0.2b85.exe.sha256", &refs, old, keep));
        // Свежий, без версии, служебный.
        assert!(!release_is_prunable("ZaliMessenger-0.2b80.exe", &refs, young, keep));
        assert!(!release_is_prunable("ZaliMessengerOnlineSetup.exe", &refs, old, keep));
        assert!(!release_is_prunable(".hidden-0.2b1.exe", &refs, old, keep));
        // Другая версия с тем же началом имени — не «сопутствующий».
        assert!(release_is_prunable("ZaliMessenger-0.2b850.exe", &refs, old, keep));
    }

    #[cfg(unix)]
    #[test]
    fn free_bytes_reads_a_real_partition() {
        let free = free_bytes(&std::env::temp_dir()).expect("statvfs на temp");
        assert!(free > 0);
        assert!(free_bytes(Path::new("/definitely/not/here")).is_none());
    }
}

#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::{build_app_state, Config};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    async fn state() -> Arc<AppState> {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("zali-gc-test-{}-{}", std::process::id(), n));
        build_app_state(dir, Config::from_env()).await
    }

    async fn insert(state: &Arc<AppState>, id: &str, receiver: &str, age_days: i64, bytes: usize) {
        let filename = format!("{id}.zali");
        fs::write(state.uploads_dir.join(&filename), vec![7u8; bytes]).await.unwrap();
        sqlx::query("INSERT INTO messages (id, sender, receiver, filename, timestamp, key_version) VALUES (?, 'alice', ?, ?, ?, 2)")
            .bind(id)
            .bind(receiver)
            .bind(&filename)
            .bind(Utc::now() - ChronoDuration::days(age_days))
            .execute(&state.db)
            .await
            .unwrap();
    }

    fn pressed() -> GcConfig {
        // Требуем свободного больше, чем бывает на любом диске: давление есть всегда, а цель
        // недостижима — так тест проверяет именно выбор, а не состояние диска машины.
        GcConfig {
            mode: Mode::On,
            min_free: u64::MAX / 2,
            target_free: u64::MAX / 2,
            min_age: Duration::from_secs(30 * 86_400),
            min_bytes: 1000,
            keep_recent: 1,
            max_per_run: 100,
            budget: Duration::from_secs(30),
            ..GcConfig::default()
        }
    }

    #[tokio::test]
    async fn cleans_only_old_large_messages_and_keeps_recent_context() {
        let state = state().await;
        // Переписка alice↔bob: свежее сообщение + три старых.
        insert(&state, "fresh", "bob", 1, 5000).await;
        insert(&state, "old-big", "bob", 100, 5000).await;
        insert(&state, "old-small", "bob", 100, 100).await;
        insert(&state, "young-big", "bob", 10, 5000).await;
        // Сирота: файл без строки, старше часа (mtime подменяем).
        let orphan = state.uploads_dir.join("orphan.tmp");
        fs::write(&orphan, vec![1u8; 700]).await.unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(3 * 3600);
        std::fs::File::options().write(true).open(&orphan).unwrap().set_modified(old).unwrap();
        // Свежий хвост загрузки трогать нельзя.
        fs::write(state.uploads_dir.join("inflight.tmp"), vec![1u8; 700]).await.unwrap();

        let report = run_once(&state, &pressed()).await;

        assert_eq!(report.deleted_ids, vec!["old-big".to_string()]);
        assert_eq!(report.orphan_files, 1);
        assert!(!orphan.exists());
        assert!(state.uploads_dir.join("inflight.tmp").exists());
        assert!(!state.uploads_dir.join("old-big.zali").exists());
        for keep in ["fresh", "old-small", "young-big"] {
            assert!(state.uploads_dir.join(format!("{keep}.zali")).exists(), "{keep} должен остаться");
        }
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages").fetch_one(&state.db).await.unwrap();
        assert_eq!(left, 3);
        assert!(report.short_by > 0, "цель недостижима — отчёт честно это говорит");
    }

    async fn put_release(state: &Arc<AppState>, name: &str, age_days: u64) {
        let path = state.releases_dir.join(name);
        fs::write(&path, vec![9u8; 400]).await.unwrap();
        let when = std::time::SystemTime::now() - Duration::from_secs(age_days * 86_400);
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
    }

    async fn publish(state: &Arc<AppState>, platform: &str, channel: &str, file: &str) {
        sqlx::query("INSERT INTO app_releases_v2 (platform, channel, version, download_url, sha256, published_at) VALUES (?, ?, '1', ?, 'x', 1)")
            .bind(platform)
            .bind(channel)
            .bind(format!("https://msgs.example/releases/{file}"))
            .execute(&state.db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pressure_prunes_stale_releases_but_never_the_published_ones() {
        let state = state().await;
        publish(&state, "windows", "b", "ZaliMessenger-0.2b85.exe").await;
        publish(&state, "android", "b", "ZaliMessenger-0.2b85.apk").await;
        for (name, age) in [
            ("ZaliMessenger-0.2b85.exe", 90),      // опубликован — остаётся, сколько бы ни лежал
            ("ZaliMessenger-0.2b85.apk", 90),
            ("ZaliMessenger-0.2b85.exe.sha256", 90), // сопутствующий опубликованному
            ("ZaliMessenger-0.2b80.exe", 40),      // старый и ненужный — уходит
            ("ZaliMessenger-0.2b70.apk", 30),      // уходит
            ("ZaliMessenger-0.2b84.exe", 3),       // свежий откат — остаётся
            ("ZaliMessengerOnlineSetup.exe", 400), // установщик без версии — остаётся
        ] {
            put_release(&state, name, age).await;
        }

        let report = run_once(&state, &pressed()).await;

        let mut gone = report.release_files.clone();
        gone.sort();
        assert_eq!(gone, vec!["ZaliMessenger-0.2b70.apk".to_string(), "ZaliMessenger-0.2b80.exe".to_string()]);
        for keep in [
            "ZaliMessenger-0.2b85.exe",
            "ZaliMessenger-0.2b85.apk",
            "ZaliMessenger-0.2b85.exe.sha256",
            "ZaliMessenger-0.2b84.exe",
            "ZaliMessengerOnlineSetup.exe",
        ] {
            assert!(state.releases_dir.join(keep).exists(), "{keep} должен остаться");
        }
        assert!(!state.releases_dir.join("ZaliMessenger-0.2b80.exe").exists());
    }

    #[tokio::test]
    async fn an_empty_release_table_prunes_nothing() {
        let state = state().await;
        put_release(&state, "ZaliMessenger-0.2b10.exe", 200).await;

        let report = run_once(&state, &pressed()).await;

        assert!(report.release_files.is_empty());
        assert!(state.releases_dir.join("ZaliMessenger-0.2b10.exe").exists());
    }

    #[tokio::test]
    async fn dry_run_leaves_releases_in_place() {
        let state = state().await;
        publish(&state, "windows", "b", "ZaliMessenger-0.2b85.exe").await;
        put_release(&state, "ZaliMessenger-0.2b80.exe", 40).await;
        let mut cfg = pressed();
        cfg.mode = Mode::Dry;

        let report = run_once(&state, &cfg).await;

        assert_eq!(report.release_files, vec!["ZaliMessenger-0.2b80.exe".to_string()]);
        assert!(state.releases_dir.join("ZaliMessenger-0.2b80.exe").exists());
    }

    #[tokio::test]
    async fn dry_run_changes_nothing() {
        let state = state().await;
        insert(&state, "fresh", "bob", 1, 5000).await;
        insert(&state, "old-big", "bob", 100, 5000).await;
        let mut cfg = pressed();
        cfg.mode = Mode::Dry;

        let report = run_once(&state, &cfg).await;

        assert_eq!(report.deleted_ids, vec!["old-big".to_string()]);
        assert!(state.uploads_dir.join("old-big.zali").exists());
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages").fetch_one(&state.db).await.unwrap();
        assert_eq!(left, 2);
    }

    #[tokio::test]
    async fn off_and_no_pressure_do_nothing() {
        let state = state().await;
        insert(&state, "fresh", "bob", 1, 5000).await;
        insert(&state, "old-big", "bob", 100, 5000).await;

        let mut cfg = pressed();
        cfg.mode = Mode::Off;
        assert!(run_once(&state, &cfg).await.deleted_ids.is_empty());

        let mut cfg = pressed();
        cfg.min_free = 0; // места «хватает» всегда, квоты нет
        cfg.target_free = 0;
        assert!(run_once(&state, &cfg).await.deleted_ids.is_empty());
        assert!(state.uploads_dir.join("old-big.zali").exists());
    }

    #[tokio::test]
    async fn the_deletion_is_recorded_in_the_chain() {
        let state = state().await;
        insert(&state, "fresh", "bob", 1, 5000).await;
        insert(&state, "old-big", "bob", 100, 5000).await;

        run_once(&state, &pressed()).await;

        let actor: Option<String> = sqlx::query_scalar(
            "SELECT actor FROM message_hash_chain WHERE message_id = 'old-big' ORDER BY version DESC LIMIT 1",
        )
        .fetch_optional(&state.db)
        .await
        .unwrap();
        assert_eq!(actor.as_deref(), Some(ACTOR));
    }
}
