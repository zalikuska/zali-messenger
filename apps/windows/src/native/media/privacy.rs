//! Скрытые приложения в трансляции экрана (страница — web/src/interface/screen_privacy.js;
//! зеркало macOS — apps/macos/.../Media/ScreenPrivacy.swift).
//!
//! Состояние приходит в `options.privacy` старта захвата и на лету — op `set_privacy`:
//! `{hidingEnabled, style: plate|blur, hiddenApps: [{id, name, hideVideo, muteAudio, style?}]}`,
//! где `id` — имя .exe без расширения в нижнем регистре.
//!
//! Здесь — то, что не зависит от Windows и проверяется тестами на любой машине: разбор
//! состояния, геометрия (видимая часть окна = прямоугольник минус окна выше по
//! z-порядку) и закрытие областей прямо в кадре NV12:
//!
//! * плашка — тёмная заливка и надпись (маска надписи рисуется GDI, `privacy_win.rs`);
//! * размытие — средние по блокам ~1/32 высоты кадра (не меньше 24 px), сглаживание
//!   сетки блоков биномиальным фильтром и плавное (smoothstep) растяжение обратно — без
//!   граней между блоками. Исходных пикселей в области после этого нет — текст не
//!   прочитать и не «развернуть». Шума нет и картинка не меняется от кадра к кадру:
//!   шум, свой на каждый кадр, «кипел» и съедал битрейт — кодировщик не может его сжать.
//!
//! Маска накладывается на CPU на плотный NV12, который и так выгружается с GPU для
//! кодировщика (screen.rs → `convert_frame`) — это дешевле отдельного D3D11-прохода в
//! поддержке и проверяется тестами; цена — один проход по закрываемой площади.

use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Plate,
    Blur,
}

impl Style {
    fn parse(v: Option<&Value>) -> Option<Self> {
        match v.and_then(Value::as_str) {
            Some("plate") => Some(Style::Plate),
            Some("blur") => Some(Style::Blur),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HiddenApp {
    pub id: String,
    pub name: String,
    pub hide_video: bool,
    pub mute_audio: bool,
    pub style: Option<Style>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub enabled: bool,
    pub style: Style,
    pub apps: Vec<HiddenApp>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self { enabled: true, style: Style::Plate, apps: Vec::new() }
    }
}

impl Snapshot {
    pub fn parse(v: &Value) -> Option<Self> {
        let obj = v.as_object()?;
        let apps = obj
            .get("hiddenApps")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .take(64)
                    .filter_map(|a| {
                        let id = normalize_id(a.get("id")?.as_str()?);
                        if id.is_empty() {
                            return None;
                        }
                        Some(HiddenApp {
                            name: a.get("name").and_then(Value::as_str).unwrap_or(&id).chars().take(120).collect(),
                            id,
                            hide_video: a.get("hideVideo").and_then(Value::as_bool).unwrap_or(true),
                            mute_audio: a.get("muteAudio").and_then(Value::as_bool).unwrap_or(true),
                            style: Style::parse(a.get("style")),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            enabled: obj.get("hidingEnabled").and_then(Value::as_bool).unwrap_or(true),
            style: Style::parse(obj.get("style")).unwrap_or(Style::Plate),
            apps,
        })
    }

    pub fn style_of(&self, app: &HiddenApp) -> Style {
        app.style.unwrap_or(self.style)
    }

    /// id → стиль приложений, чью картинку надо закрыть сейчас.
    pub fn video_apps(&self) -> Vec<(String, Style)> {
        if !self.enabled {
            return Vec::new();
        }
        self.apps.iter().filter(|a| a.hide_video).map(|a| (a.id.clone(), self.style_of(a))).collect()
    }

    /// id приложений, чей звук не передаём сейчас.
    pub fn muted_ids(&self) -> Vec<String> {
        if !self.enabled {
            return Vec::new();
        }
        self.apps.iter().filter(|a| a.mute_audio).map(|a| a.id.clone()).collect()
    }
}

/// `Chrome.EXE` / `chrome` → `chrome`.
pub fn normalize_id(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
}

fn state() -> &'static Mutex<Snapshot> {
    static STATE: OnceLock<Mutex<Snapshot>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Snapshot::default()))
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn snapshot() -> Snapshot {
    state().lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Растёт при каждом изменении — по нему потоки захвата видят, что пора перестроиться.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// Новое состояние со страницы; `true` — изменилось.
pub fn update(options: &Value) -> bool {
    let Some(next) = Snapshot::parse(options) else { return false };
    let mut guard = state().lock().unwrap_or_else(|p| p.into_inner());
    if *guard == next {
        return false;
    }
    tracing::info!(
        "[ZALI][WIN] privacy: enabled={} style={:?} apps={:?}",
        next.enabled,
        next.style,
        next.apps.iter().map(|a| format!("{}[{}{}]", a.id, if a.hide_video { "v" } else { "" }, if a.mute_audio { "a" } else { "" })).collect::<Vec<_>>()
    );
    *guard = next;
    GENERATION.fetch_add(1, Ordering::AcqRel);
    true
}

// --- геометрия ------------------------------------------------------------------------

/// Прямоугольник [left, right) × [top, bottom), пиксели.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self { left, top, right, bottom }
    }
    pub fn is_empty(&self) -> bool {
        self.right <= self.left || self.bottom <= self.top
    }
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    pub fn intersect(&self, o: &Rect) -> Rect {
        Rect::new(self.left.max(o.left), self.top.max(o.top), self.right.min(o.right), self.bottom.min(o.bottom))
    }
    pub fn inflate(&self, d: i32) -> Rect {
        Rect::new(self.left - d, self.top - d, self.right + d, self.bottom + d)
    }
    /// `self` минус `o` — до четырёх непересекающихся кусков.
    pub fn subtract(&self, o: &Rect) -> Vec<Rect> {
        let i = self.intersect(o);
        if i.is_empty() {
            return vec![*self];
        }
        let mut out = Vec::with_capacity(4);
        if i.top > self.top {
            out.push(Rect::new(self.left, self.top, self.right, i.top));
        }
        if i.bottom < self.bottom {
            out.push(Rect::new(self.left, i.bottom, self.right, self.bottom));
        }
        if i.left > self.left {
            out.push(Rect::new(self.left, i.top, i.left, i.bottom));
        }
        if i.right < self.right {
            out.push(Rect::new(i.right, i.top, self.right, i.bottom));
        }
        out
    }
}

/// Видимые куски `rect` под окнами `above` (они выше по z-порядку).
pub fn visible_parts(rect: Rect, above: &[Rect]) -> Vec<Rect> {
    let mut pieces = vec![rect];
    for o in above {
        pieces = pieces.iter().flat_map(|p| p.subtract(o)).collect();
        if pieces.is_empty() {
            break;
        }
    }
    pieces
}

/// Окно трекера: прямоугольник в экранных координатах и чьё оно.
#[derive(Clone, Debug)]
pub struct TrackedWindow {
    pub id: isize,
    pub rect: Rect,
    /// Стиль, если окно скрываемое; `None` — обычное окно, перекрывает лежащие ниже.
    pub hidden: Option<Style>,
    /// Окно само попадает в захват (не WDA_EXCLUDEFROMCAPTURE) — значит, перекрывает.
    pub captured: bool,
}

/// Слой маски: скруглённый прямоугольник, который закрашивается стилем (окно скрытого
/// приложения) или стирает закраску под собой (`style: None` — обычное окно поверх).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaskOp {
    pub rect: Rect,
    pub radius: i32,
    pub style: Option<Style>,
}

/// Маска кадра: слои снизу вверх (как окна на экране) и места надписей плашки.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FrameMask {
    pub ops: Vec<MaskOp>,
    pub labels: Vec<Rect>,
}

impl FrameMask {
    pub fn is_empty(&self) -> bool {
        !self.ops.iter().any(|op| op.style.is_some())
    }

    /// Весь кадр одним стилем (трекер ещё не опросил окна, показ окна скрытого приложения).
    pub fn full(w: u32, h: u32, style: Style) -> Self {
        let rect = Rect::new(0, 0, w as i32, h as i32);
        Self { ops: vec![MaskOp { rect, radius: 0, style: Some(style) }], labels: if style == Style::Plate { vec![rect] } else { Vec::new() } }
    }
}

/// Скругление закрытия. Углы маски — `radius` (с полем `margin` вокруг окна она всё равно
/// покрывает и окно с прямыми углами: нужно radius ≤ margin·3,4). Окно поверх стирает маску
/// со скруглением `occluder_radius` — не меньше настоящего радиуса окон системы: стёртое
/// тогда целиком внутри окна, и в его уголках скрытое окно не проглядывает.
#[derive(Clone, Copy, Debug)]
pub struct Rounding {
    pub margin: i32,
    pub radius: i32,
    pub occluder_radius: i32,
}

/// Окна спереди назад → маска в экранных координатах. Окно, сдвинувшееся с прошлого
/// опроса, закрывается и на старом месте (между опросами оно было где-то посередине),
/// исчезнувшее — ещё один опрос там, где было (самым нижним слоем).
pub fn mask_from_windows(front_to_back: &[TrackedWindow], previous: &mut Vec<(isize, Rect, Style)>, rounding: Rounding) -> FrameMask {
    let mut seen: Vec<(isize, Rect, Style)> = Vec::new();
    let mut labels = Vec::new();
    let mut above: Vec<Rect> = Vec::new();
    // Слои спереди назад, потом развернём.
    let mut ops_front: Vec<MaskOp> = Vec::new();
    for w in front_to_back {
        if w.rect.is_empty() {
            continue;
        }
        match w.hidden {
            Some(style) => {
                let current = w.rect.inflate(rounding.margin);
                ops_front.push(MaskOp { rect: current, radius: rounding.radius, style: Some(style) });
                if let Some((_, prev, _)) = previous.iter().find(|(id, r, _)| *id == w.id && *r != w.rect) {
                    ops_front.push(MaskOp { rect: prev.inflate(rounding.margin), radius: rounding.radius, style: Some(style) });
                }
                if style == Style::Plate {
                    // Надпись — в самом большом видимом куске окна.
                    if let Some(best) = visible_parts(current, &above).into_iter().max_by_key(|p| p.width() as i64 * p.height() as i64) {
                        labels.push(best);
                    }
                }
                seen.push((w.id, w.rect, style));
            }
            None if w.captured => {
                ops_front.push(MaskOp { rect: w.rect, radius: rounding.occluder_radius, style: None });
                above.push(w.rect);
            }
            None => {}
        }
    }
    let mut ops: Vec<MaskOp> = previous
        .iter()
        .filter(|(id, _, _)| !seen.iter().any(|(s, _, _)| s == id))
        .map(|(_, prev, style)| MaskOp { rect: prev.inflate(rounding.margin), radius: rounding.radius, style: Some(*style) })
        .collect();
    ops.extend(ops_front.into_iter().rev());
    *previous = seen;
    // Стирать нечего, пока под окном нет ни одного закрытия: обычные окна ниже всех
    // скрытых в маске не нужны.
    let first_hidden = ops.iter().position(|op| op.style.is_some()).unwrap_or(ops.len());
    ops.drain(..first_hidden);
    FrameMask { ops, labels }
}

/// Экранная маска → пиксели кадра `out_w × out_h`. Источник — монитор `monitor`
/// (экранные координаты), его содержимое `content_w × content_h` вписано в кадр в
/// прямоугольник `dest` (поля, если пропорции разошлись).
pub fn map_to_frame(mask: &FrameMask, monitor: Rect, content_w: u32, content_h: u32, dest: Rect, out_w: u32, out_h: u32) -> FrameMask {
    if monitor.is_empty() || content_w == 0 || content_h == 0 || dest.is_empty() {
        return FrameMask::default();
    }
    // Экран → содержимое (WGC отдаёт монитор в его физических пикселях) → кадр.
    let kx = dest.width() as f64 / monitor.width() as f64;
    let ky = dest.height() as f64 / monitor.height() as f64;
    let frame = Rect::new(0, 0, out_w as i32, out_h as i32);
    let map = |r: &Rect| {
        Rect::new(
            dest.left + ((r.left - monitor.left) as f64 * kx).floor() as i32,
            dest.top + ((r.top - monitor.top) as f64 * ky).floor() as i32,
            dest.left + ((r.right - monitor.left) as f64 * kx).ceil() as i32,
            dest.top + ((r.bottom - monitor.top) as f64 * ky).ceil() as i32,
        )
    };
    FrameMask {
        ops: mask
            .ops
            .iter()
            .map(|op| MaskOp { rect: map(&op.rect), radius: (op.radius as f64 * kx).round() as i32, style: op.style })
            .filter(|op| !op.rect.intersect(&frame).is_empty())
            .collect(),
        labels: mask.labels.iter().map(map).map(|r| r.intersect(&frame)).filter(|r| !r.is_empty()).collect(),
    }
}

// --- звук: какие процессы захватывать ------------------------------------------------

/// Процесс из снимка системы.
#[derive(Clone, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: u32,
    /// `normalize_id` имени .exe.
    pub id: String,
}

/// Звук при скрытых приложениях. Windows умеет исключить из process loopback только
/// одно дерево процессов (наше), поэтому захват идёт в режиме include — по одному на
/// каждый разрешённый процесс со звуковой сессией — и сводится. Include берёт и всех
/// потомков, отсюда правила:
///
/// * наше дерево (WebView2 с голосами звонка) и скрытые приложения — не берём;
/// * процесс, у которого среди потомков есть скрытое приложение, — тоже не берём:
///   через него звук скрытого прошёл бы (цена — его собственный звук);
/// * процесс, чей предок уже берётся, — не берём второй раз (звук удвоился бы).
///
/// Ответ — `(корни захвата, пропущенные из-за скрытого потомка)`.
pub fn audio_roots(session_pids: &[u32], procs: &[ProcInfo], own_pid: u32, muted: &[String]) -> (Vec<u32>, Vec<u32>) {
    use std::collections::{HashMap, HashSet};
    let by_pid: HashMap<u32, &ProcInfo> = procs.iter().map(|p| (p.pid, p)).collect();
    let ancestors = |pid: u32| -> Vec<u32> {
        let mut out = Vec::new();
        let mut cur = pid;
        for _ in 0..64 {
            let Some(p) = by_pid.get(&cur) else { break };
            if p.parent == 0 || p.parent == cur || out.contains(&p.parent) {
                break;
            }
            out.push(p.parent);
            cur = p.parent;
        }
        out
    };
    let in_own_tree = |pid: u32| pid == own_pid || ancestors(pid).contains(&own_pid);
    let muted_set: HashSet<&str> = muted.iter().map(String::as_str).collect();
    let is_muted = |pid: u32| by_pid.get(&pid).map(|p| muted_set.contains(p.id.as_str())).unwrap_or(false);
    // Предки всех скрытых процессов (не только со звуком сейчас: заиграть может любой).
    let unsafe_parents: HashSet<u32> = procs.iter().filter(|p| muted_set.contains(p.id.as_str())).flat_map(|p| ancestors(p.pid)).collect();
    let mut candidates: Vec<u32> = Vec::new();
    let mut skipped = Vec::new();
    for &pid in session_pids {
        // Нет в снимке процессов — сессия осталась от вышедшего процесса.
        if pid == 0 || !by_pid.contains_key(&pid) || candidates.contains(&pid) || in_own_tree(pid) || is_muted(pid) {
            continue;
        }
        if unsafe_parents.contains(&pid) {
            if !skipped.contains(&pid) {
                skipped.push(pid);
            }
            continue;
        }
        candidates.push(pid);
    }
    let roots = candidates.iter().copied().filter(|&pid| !ancestors(pid).iter().any(|a| candidates.contains(a))).collect();
    (roots, skipped)
}

// --- маска в кадре NV12 ---------------------------------------------------------------

/// Маска надписи плашки: яркость 0..255, `w × h`.
#[derive(Clone)]
pub struct LabelMask {
    pub width: usize,
    pub height: usize,
    pub alpha: Vec<u8>,
}

pub const PLATE_TEXT: &str = "Владелец трансляции скрыл это приложение";
const PLATE_Y: u8 = 30;
const PLATE_TEXT_Y: u8 = 205;

/// Размер блока размытия для кадра высотой `h`.
pub fn blur_block(h: usize) -> usize {
    ((h / 32).max(24) + 1) & !1
}

const CODE_PLATE: u8 = 1;
const CODE_BLUR: u8 = 2;

/// Отступ скруглённого угла в строке `y` прямоугольника `r` радиуса `radius`: сколько
/// точек с каждого края строки вне фигуры. `generous` — округлять в сторону большей фигуры.
fn corner_inset(r: &Rect, radius: i32, y: i32, generous: bool) -> i32 {
    let radius = radius.min(r.width() / 2).min(r.height() / 2);
    if radius <= 0 {
        return 0;
    }
    let d = if y < r.top + radius {
        (r.top + radius) as f32 - (y as f32 + 0.5)
    } else if y >= r.bottom - radius {
        (y as f32 + 0.5) - (r.bottom - radius) as f32
    } else {
        return 0;
    };
    let rf = radius as f32;
    let inset = rf - (rf * rf - d * d).max(0.0).sqrt();
    if generous { inset.floor() as i32 } else { inset.ceil() as i32 }
}

/// Покраска маски в коды точек: 0 — открыто, 1 — плашка, 2 — размытие. Слои снизу вверх;
/// закрашиваемое скругляется «в большую сторону», стираемое — «в меньшую»: на границе
/// лишняя закрытая точка лучше лишней открытой.
fn paint_codes(mask: &FrameMask, bbox: Rect) -> (Vec<u8>, [Rect; 3]) {
    let bw = bbox.width() as usize;
    let mut codes = vec![0u8; bw * bbox.height() as usize];
    for op in &mask.ops {
        let code = match op.style {
            None => 0,
            Some(Style::Plate) => CODE_PLATE,
            Some(Style::Blur) => CODE_BLUR,
        };
        let r = op.rect.intersect(&bbox);
        for y in r.top..r.bottom {
            let inset = corner_inset(&op.rect, op.radius, y, code != 0);
            let x0 = r.left.max(op.rect.left + inset);
            let x1 = r.right.min(op.rect.right - inset);
            if x1 > x0 {
                let row = (y - bbox.top) as usize * bw;
                codes[row + (x0 - bbox.left) as usize..row + (x1 - bbox.left) as usize].fill(code);
            }
        }
    }
    // Рамки слоёв каждого кода — где обрабатывать (с запасом: что внутри стёрто, отсекает
    // покрытие по точкам).
    let mut bounds = [Rect::new(i32::MAX, i32::MAX, i32::MIN, i32::MIN); 3];
    for op in &mask.ops {
        let code = match op.style {
            Some(Style::Plate) => CODE_PLATE,
            Some(Style::Blur) => CODE_BLUR,
            None => continue,
        } as usize;
        let r = op.rect.intersect(&bbox);
        let b = &mut bounds[code];
        *b = Rect::new(b.left.min(r.left), b.top.min(r.top), b.right.max(r.right), b.bottom.max(r.bottom));
    }
    (codes, bounds)
}

/// Чётные границы: одна точка UV покрывает 2×2 яркости.
fn even_out(r: Rect) -> Rect {
    Rect::new(r.left & !1, r.top & !1, (r.right + 1) & !1, (r.bottom + 1) & !1)
}

/// Код маски в точке яркости (x, y) — для точки цветности берётся её левая верхняя.
struct Coverage<'a> {
    codes: &'a [u8],
    bbox: Rect,
    code: u8,
}

impl Coverage<'_> {
    #[inline]
    fn at(&self, x: i32, y: i32) -> bool {
        x >= self.bbox.left && x < self.bbox.right && y >= self.bbox.top && y < self.bbox.bottom
            && self.codes[(y - self.bbox.top) as usize * self.bbox.width() as usize + (x - self.bbox.left) as usize] == self.code
    }

    /// Строка кодов маски для строки яркости `y` (её первая точка — `bbox.left`).
    #[inline]
    fn row(&self, y: i32) -> &[u8] {
        if y < self.bbox.top || y >= self.bbox.bottom {
            return &[];
        }
        let bw = self.bbox.width() as usize;
        &self.codes[(y - self.bbox.top) as usize * bw..(y - self.bbox.top + 1) as usize * bw]
    }
}

/// Закрыть маску в плотном NV12 `w × h` (Y, затем UV через строку). `label(size)` —
/// маска надписи плашки нужного кегля (None — без надписи).
pub fn mask_nv12(buf: &mut [u8], w: usize, h: usize, mask: &FrameMask, label: &mut dyn FnMut(usize) -> Option<LabelMask>) {
    if w < 2 || h < 2 || buf.len() < w * h + w * (h / 2) || mask.is_empty() {
        return;
    }
    let frame = Rect::new(0, 0, w as i32, h as i32);
    let mut bbox = Rect::new(i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for op in mask.ops.iter().filter(|op| op.style.is_some()) {
        bbox = Rect::new(bbox.left.min(op.rect.left), bbox.top.min(op.rect.top), bbox.right.max(op.rect.right), bbox.bottom.max(op.rect.bottom));
    }
    let bbox = even_out(bbox).intersect(&frame);
    if bbox.is_empty() {
        return;
    }
    let (codes, bounds) = paint_codes(mask, bbox);
    let plate_bounds = bounds[CODE_PLATE as usize];
    if !plate_bounds.is_empty() {
        plate(buf, w, h, &Coverage { codes: &codes, bbox, code: CODE_PLATE }, even_out(plate_bounds).intersect(&frame), &mask.labels, label);
    }
    let blur_bounds = bounds[CODE_BLUR as usize];
    if !blur_bounds.is_empty() {
        blur(buf, w, h, even_out(blur_bounds).intersect(&frame), &Coverage { codes: &codes, bbox, code: CODE_BLUR });
    }
}

fn plate(buf: &mut [u8], w: usize, h: usize, cover: &Coverage, area: Rect, labels: &[Rect], label: &mut dyn FnMut(usize) -> Option<LabelMask>) {
    let (y_plane, uv_plane) = buf.split_at_mut(w * h);
    // area внутри bbox маски: строки кодов и кадра идут рядом.
    let (cx0, cx1) = ((area.left - cover.bbox.left) as usize, (area.right - cover.bbox.left) as usize);
    for y in area.top..area.bottom {
        let codes = &cover.row(y)[cx0..cx1];
        let line = &mut y_plane[y as usize * w + area.left as usize..y as usize * w + area.right as usize];
        for (px, &c) in line.iter_mut().zip(codes) {
            if c == cover.code {
                *px = PLATE_Y;
            }
        }
    }
    for y in (area.top / 2)..(area.bottom / 2) {
        let codes = &cover.row(y * 2)[cx0..cx1];
        let line = &mut uv_plane[y as usize * w + area.left as usize..y as usize * w + area.right as usize];
        // Точка цветности (пара байт) — по коду левой верхней точки яркости своих 2×2.
        for (pair, c) in line.chunks_exact_mut(2).zip(codes.iter().step_by(2)) {
            if *c == cover.code {
                pair[0] = 128;
                pair[1] = 128;
            }
        }
    }
    for r in labels {
        if r.width() <= 120 || r.height() <= 28 {
            continue;
        }
        let size = ((r.width() / 30).min(r.height() / 4)).clamp(11, 30) as usize;
        let Some(text) = label(size) else { continue };
        if text.width as i32 > r.width() || text.height as i32 > r.height() {
            continue;
        }
        let x0 = r.left + (r.width() - text.width as i32) / 2;
        let y0 = r.top + (r.height() - text.height as i32) / 2;
        for ly in 0..text.height as i32 {
            for lx in 0..text.width as i32 {
                let a = text.alpha[ly as usize * text.width + lx as usize] as u32;
                let (x, y) = (x0 + lx, y0 + ly);
                if a > 0 && cover.at(x, y) {
                    y_plane[y as usize * w + x as usize] = ((PLATE_Y as u32 * (255 - a) + PLATE_TEXT_Y as u32 * a) / 255) as u8;
                }
            }
        }
    }
}

/// Сетка средних по блокам плоскости (`stride` — шаг строки, `step` — байт на точку:
/// 1 для Y, 2 для UV, `comp` — какой байт точки), сглаженная биномиально 1-2-1.
#[allow(clippy::too_many_arguments)]
fn block_grid(plane: &[u8], stride: usize, pw: usize, ph: usize, step: usize, comp: usize, area: Rect, block: usize) -> (Vec<f32>, usize, usize, i32, i32) {
    let gx0 = area.left.max(0) as usize / block;
    let gy0 = area.top.max(0) as usize / block;
    let gx1 = (area.right.max(0) as usize).min(pw).div_ceil(block);
    let gy1 = (area.bottom.max(0) as usize).min(ph).div_ceil(block);
    let (gw, gh) = (gx1.saturating_sub(gx0).max(1), gy1.saturating_sub(gy0).max(1));
    let mut grid = vec![0f32; gw * gh];
    for gy in 0..gh {
        for gx in 0..gw {
            let (x0, y0) = ((gx0 + gx) * block, (gy0 + gy) * block);
            let (x1, y1) = ((x0 + block).min(pw), (y0 + block).min(ph));
            let (mut sum, mut n) = (0u64, 0u64);
            // Сетка отсчётов ~8×8 на блок: среднее блока от этого почти не меняется.
            let skip = (block / 8).max(2);
            let mut yy = y0 + skip / 2;
            while yy < y1 {
                let row = &plane[yy * stride..];
                let mut xx = x0 + skip / 2;
                while xx < x1 {
                    sum += row[xx * step + comp] as u64;
                    n += 1;
                    xx += skip;
                }
                yy += skip;
            }
            grid[gy * gw + gx] = if n > 0 { sum as f32 / n as f32 } else { 128.0 };
        }
    }
    // Гауссово сглаживание сетки: ядро 1-2-1 по обеим осям дважды (≈ 1-4-6-4-1) — края
    // блоков не читаются и не проступают полосы, когда строки текста не совпадают с сеткой.
    let mut tmp = grid.clone();
    for _ in 0..2 {
        for gy in 0..gh {
            for gx in 0..gw {
                let at = |x: isize| grid[gy * gw + x.clamp(0, gw as isize - 1) as usize];
                tmp[gy * gw + gx] = (at(gx as isize - 1) + 2.0 * at(gx as isize) + at(gx as isize + 1)) / 4.0;
            }
        }
        for gy in 0..gh {
            for gx in 0..gw {
                let at = |y: isize| tmp[y.clamp(0, gh as isize - 1) as usize * gw + gx];
                grid[gy * gw + gx] = (at(gy as isize - 1) + 2.0 * at(gy as isize) + at(gy as isize + 1)) / 4.0;
            }
        }
    }
    (grid, gw, gh, (gx0 * block) as i32, (gy0 * block) as i32)
}

/// Веса плавного перехода между центрами соседних блоков: smoothstep(t) в 16.16 для
/// каждого шага t = i / block. В отличие от линейного перехода, у которого на центрах
/// блоков излом (видны «ромбы» сетки), здесь производная непрерывна — пятна гладкие.
fn smooth_weights(block: usize) -> Vec<i32> {
    (0..block)
        .map(|i| {
            let t = i as f32 / block as f32;
            (t * t * (3.0 - 2.0 * t) * 65536.0) as i32
        })
        .collect()
}

/// Заполнить `[x0, x1) × [y0, y1)` плоскости плавным растяжением сетки. Построчно: по
/// вертикали две строки сетки смешиваются один раз на строку, по горизонтали вес берётся
/// из таблицы по смещению от центра блока — ни деления, ни округления на точку.
#[allow(clippy::too_many_arguments)]
fn fill_from_grid(
    plane: &mut [u8], stride: usize, step: usize, comp: usize,
    x0: i32, y0: i32, x1: i32, y1: i32,
    grid: &[f32], gw: usize, gh: usize, ox: i32, oy: i32, block: usize,
    lo: i32, hi: i32, cover: &Coverage, scale: i32,
) {
    let weights = smooth_weights(block);
    let half = block as i32 / 2;
    let mut row = vec![0i32; gw];
    for y in y0..y1 {
        // Вертикаль: доля между центрами строк сетки, тоже через smoothstep.
        let fy = ((y - oy - half) as f32 / block as f32).clamp(0.0, (gh - 1) as f32);
        let iy0 = fy.floor() as usize;
        let iy1 = (iy0 + 1).min(gh - 1);
        let t = fy - iy0 as f32;
        let ty = t * t * (3.0 - 2.0 * t);
        for gx in 0..gw {
            row[gx] = (grid[iy0 * gw + gx] * (1.0 - ty) + grid[iy1 * gw + gx] * ty).round() as i32;
        }
        let line = &mut plane[y as usize * stride..];
        let codes = cover.row(y * scale);
        let left = cover.bbox.left;
        let covered = |xx: i32| -> bool {
            let i = xx * scale - left;
            i >= 0 && (i as usize) < codes.len() && codes[i as usize] == cover.code
        };
        let mut x = x0;
        while x < x1 {
            // Отрезок между центрами блоков gx и gx+1 (за крайними центрами — константа).
            let rel = x - ox - half;
            let gx = if rel < 0 { -1 } else { rel / block as i32 };
            if gx < 0 || gx as usize >= gw - 1 {
                let v = if gx < 0 { row[0] } else { row[gw - 1] }.clamp(lo, hi) as u8;
                let end = if gx < 0 { (ox + half).min(x1).max(x + 1) } else { x1 };
                for xx in x..end {
                    if covered(xx) {
                        line[xx as usize * step + comp] = v;
                    }
                }
                x = end;
                continue;
            }
            let g = gx as usize;
            let seg_start = ox + half + gx * block as i32;
            let (a, d) = (row[g], row[g + 1] - row[g]);
            let end = (seg_start + block as i32).min(x1);
            for xx in x..end {
                // d ≤ 255 по модулю, вес ≤ 65536 — произведение влезает в i32.
                if covered(xx) {
                    let value = a + ((d * weights[(xx - seg_start) as usize]) >> 16);
                    line[xx as usize * step + comp] = value.clamp(lo, hi) as u8;
                }
            }
            x = end.max(x + 1);
        }
    }
}

fn blur(buf: &mut [u8], w: usize, h: usize, r: Rect, cover: &Coverage) {
    let block = blur_block(h);
    let area = r.inflate(block as i32 * 2).intersect(&Rect::new(0, 0, w as i32, h as i32));
    let (y_plane, uv_plane) = buf.split_at_mut(w * h);
    // Сетки считаются по исходному кадру целиком до записи.
    let (gy, gyw, gyh, oyx, oyy) = block_grid(y_plane, w, w, h, 1, 0, area, block);
    let half = Rect::new(area.left / 2, area.top / 2, area.right / 2, area.bottom / 2);
    let cb = block / 2;
    let (gu, guw, guh, oux, ouy) = block_grid(uv_plane, w, w / 2, h / 2, 2, 0, half, cb);
    let (gv, _, _, _, _) = block_grid(uv_plane, w, w / 2, h / 2, 2, 1, half, cb);
    fill_from_grid(y_plane, w, 1, 0, r.left, r.top, r.right, r.bottom, &gy, gyw, gyh, oyx, oyy, block, 16, 235, cover, 1);
    let (cx0, cy0, cx1, cy1) = (r.left / 2, r.top / 2, r.right / 2, r.bottom / 2);
    fill_from_grid(uv_plane, w, 2, 0, cx0, cy0, cx1, cy1, &gu, guw, guh, oux, ouy, cb, 16, 240, cover, 2);
    fill_from_grid(uv_plane, w, 2, 1, cx0, cy0, cx1, cy1, &gv, guw, guh, oux, ouy, cb, 16, 240, cover, 2);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_state_and_filters_by_flags() {
        let s = Snapshot::parse(&json!({
            "hidingEnabled": true, "style": "blur",
            "hiddenApps": [
                {"id": "Telegram.exe", "name": "Telegram", "hideVideo": true, "muteAudio": false},
                {"id": "spotify", "hideVideo": false, "muteAudio": true, "style": "plate"},
                {"id": ""}
            ]
        }))
        .unwrap();
        assert_eq!(s.apps.len(), 2);
        assert_eq!(s.apps[0].id, "telegram");
        assert_eq!(s.video_apps(), vec![("telegram".to_string(), Style::Blur)]);
        assert_eq!(s.muted_ids(), vec!["spotify".to_string()]);
        let off = Snapshot::parse(&json!({"hidingEnabled": false, "hiddenApps": [{"id": "a"}]})).unwrap();
        assert!(off.video_apps().is_empty() && off.muted_ids().is_empty());
    }

    #[test]
    fn subtract_covers_exactly_the_difference() {
        let a = Rect::new(0, 0, 100, 100);
        let b = Rect::new(20, 30, 60, 200);
        let parts = a.subtract(&b);
        let area: i32 = parts.iter().map(|p| p.width() * p.height()).sum();
        assert_eq!(area, 100 * 100 - 40 * 70);
        for p in &parts {
            assert!(p.intersect(&b).is_empty());
        }
        assert_eq!(a.subtract(&Rect::new(200, 200, 300, 300)), vec![a]);
        assert!(a.subtract(&Rect::new(-1, -1, 101, 101)).is_empty());
    }

    fn one(rect: Rect, radius: i32, style: Style) -> FrameMask {
        FrameMask { ops: vec![MaskOp { rect, radius, style: Some(style) }], labels: Vec::new() }
    }

    const NO_ROUND: Rounding = Rounding { margin: 0, radius: 0, occluder_radius: 0 };

    #[test]
    fn mask_respects_z_order_and_motion() {
        let mut prev = Vec::new();
        let wins = vec![
            TrackedWindow { id: 1, rect: Rect::new(0, 0, 50, 50), hidden: None, captured: true },
            TrackedWindow { id: 2, rect: Rect::new(0, 0, 100, 100), hidden: Some(Style::Plate), captured: true },
            TrackedWindow { id: 3, rect: Rect::new(0, 0, 300, 300), hidden: None, captured: true },
        ];
        let m = mask_from_windows(&wins, &mut prev, NO_ROUND);
        // Снизу вверх: окно ниже скрытого в маске не нужно, окно выше — стирает.
        assert_eq!(m.ops, vec![
            MaskOp { rect: Rect::new(0, 0, 100, 100), radius: 0, style: Some(Style::Plate) },
            MaskOp { rect: Rect::new(0, 0, 50, 50), radius: 0, style: None },
        ]);
        assert_eq!(m.labels, vec![Rect::new(0, 50, 100, 100)], "надпись — в самом большом видимом куске");
        // Не попадающее в захват окно (наша плашка) ничего под собой не прячет.
        let wins2 = vec![
            TrackedWindow { id: 9, rect: Rect::new(0, 0, 50, 50), hidden: None, captured: false },
            TrackedWindow { id: 2, rect: Rect::new(10, 0, 110, 100), hidden: Some(Style::Blur), captured: true },
        ];
        let m2 = mask_from_windows(&wins2, &mut prev, NO_ROUND);
        assert_eq!(m2.ops.len(), 2, "текущее и прошлое положение");
        assert!(m2.ops.iter().all(|op| op.style == Some(Style::Blur)));
        // Окно пропало — ещё один опрос закрываем, где было.
        assert_eq!(mask_from_windows(&[], &mut prev, NO_ROUND).ops.len(), 1);
        assert!(mask_from_windows(&[], &mut prev, NO_ROUND).is_empty());
    }

    #[test]
    fn maps_screen_to_letterboxed_frame() {
        let monitor = Rect::new(1920, 0, 3840, 1080);
        let mask = FrameMask { ops: vec![MaskOp { rect: Rect::new(1920, 0, 2880, 540), radius: 15, style: Some(Style::Plate) }], labels: vec![Rect::new(1920, 0, 2880, 540)] };
        let out = map_to_frame(&mask, monitor, 1920, 1080, Rect::new(0, 0, 1280, 720), 1280, 720);
        assert_eq!(out.ops, vec![MaskOp { rect: Rect::new(0, 0, 640, 360), radius: 10, style: Some(Style::Plate) }]);
        assert_eq!(out.labels, vec![Rect::new(0, 0, 640, 360)]);
    }

    #[test]
    fn corners_are_rounded_and_occluder_corners_stay_covered() {
        let (w, h) = (320, 240);
        let orig = vec![200u8; w * h + w * (h / 2)];
        let mut buf = orig.clone();
        let mask = FrameMask {
            ops: vec![
                MaskOp { rect: Rect::new(20, 20, 300, 220), radius: 20, style: Some(Style::Plate) },
                // Окно поверх с углом радиуса 16: в его уголке скрытое должно остаться закрытым.
                MaskOp { rect: Rect::new(150, 100, 320, 240), radius: 16, style: None },
            ],
            labels: Vec::new(),
        };
        mask_nv12(&mut buf, w, h, &mask, &mut |_| None);
        assert_eq!(buf[21 * w + 21], 200, "угол скруглён — точка у самого угла открыта");
        assert_eq!(buf[21 * w + 100], PLATE_Y, "середина верхнего края закрыта");
        assert_eq!(buf[60 * w + 60], PLATE_Y, "внутри закрыто");
        assert_eq!(buf[101 * w + 151], PLATE_Y, "уголок окна поверх — закрыт (там проглядывало бы скрытое)");
        assert_eq!(buf[150 * w + 200], 200, "само окно поверх открыто");
        assert_eq!(buf[10 * w + 10], 200, "вне маски не тронуто");
    }

    #[test]
    fn generous_radius_still_covers_square_window() {
        // Окно с прямыми углами (0..100), поле 8, радиус 14: угол окна всё равно закрыт.
        let mut prev = Vec::new();
        let wins = vec![TrackedWindow { id: 1, rect: Rect::new(20, 20, 120, 120), hidden: Some(Style::Plate), captured: true }];
        let m = mask_from_windows(&wins, &mut prev, Rounding { margin: 8, radius: 14, occluder_radius: 20 });
        let (w, h) = (200, 200);
        let mut buf = vec![200u8; w * h + w * (h / 2)];
        mask_nv12(&mut buf, w, h, &m, &mut |_| None);
        for (x, y) in [(20, 20), (119, 20), (20, 119), (119, 119)] {
            assert_eq!(buf[y * w + x], PLATE_Y, "угол окна ({x},{y}) открыт");
        }
    }

    #[test]
    fn audio_roots_skip_own_tree_hidden_and_their_parents() {
        let p = |pid, parent, id: &str| ProcInfo { pid, parent, id: id.to_string() };
        let procs = vec![
            p(4, 0, "system"),
            p(100, 4, "explorer"),
            p(200, 100, "zali_messenger_win"),
            p(210, 200, "msedgewebview2"),
            p(300, 100, "chrome"),
            p(310, 300, "chrome"),
            p(400, 100, "launcher"),
            p(410, 400, "game"),
            p(500, 100, "spotify"),
        ];
        let sessions = vec![0, 210, 310, 300, 400, 410, 500, 999];
        let (roots, skipped) = audio_roots(&sessions, &procs, 200, &["game".to_string()]);
        // 210 — наш WebView2; 310 — потомок 300 (уже берётся); 410 — скрытый;
        // 400 — родитель скрытого: через include его дерева звук игры прошёл бы.
        assert_eq!(roots, vec![300, 500]);
        assert_eq!(skipped, vec![400]);
    }

    fn text_frame(w: usize, h: usize) -> Vec<u8> {
        // «Текст»: тонкие тёмные штрихи на светлом фоне.
        let mut buf = vec![128u8; w * h + w * (h / 2)];
        for y in 0..h {
            for x in 0..w {
                buf[y * w + x] = if (x / 3 + y / 7) % 4 == 0 { 30 } else { 220 };
            }
        }
        buf
    }

    #[test]
    fn blur_destroys_fine_detail() {
        let (w, h) = (320, 240);
        let mut buf = text_frame(w, h);
        let region = Rect::new(40, 40, 280, 200);
        mask_nv12(&mut buf, w, h, &one(region, 0, Style::Blur), &mut |_| None);
        // Внутри области соседние точки почти равны (детали ~3 px пропали), снаружи — нет.
        let mut max_step = 0i32;
        for y in 50..190 {
            for x in 50..270 {
                let d = (buf[y * w + x] as i32 - buf[y * w + x + 1] as i32).abs();
                max_step = max_step.max(d);
            }
        }
        assert!(max_step <= 20, "резкий перепад внутри размытия: {max_step}");
        assert_eq!(buf[5 * w + 5], text_frame(w, h)[5 * w + 5], "вне области кадр не тронут");
        // Тот же кадр — то же размытие: ничего не «кипит» и не съедает битрейт.
        let mut other = text_frame(w, h);
        mask_nv12(&mut other, w, h, &one(region, 0, Style::Blur), &mut |_| None);
        assert_eq!(buf, other);
    }

    #[test]
    fn plate_fills_region_and_draws_label() {
        let (w, h) = (320, 240);
        let mut buf = text_frame(w, h);
        let label = LabelMask { width: 20, height: 10, alpha: vec![255; 200] };
        let mut mask = one(Rect::new(11, 11, 301, 201), 0, Style::Plate);
        mask.labels.push(Rect::new(11, 11, 301, 201));
        mask_nv12(&mut buf, w, h, &mask, &mut |_| Some(label.clone()));
        assert_eq!(text_frame(w, h)[12 * w + 12], 220);
        assert_eq!(buf[12 * w + 12], PLATE_Y, "у края закрыто");
        assert_eq!(buf[10 * w + 13], text_frame(w, h)[10 * w + 13], "строка над маской не тронута");
        assert_eq!(buf[105 * w + 155], PLATE_TEXT_Y, "надпись по центру");
        assert_eq!(buf[w * h + 50 * w + 40], 128, "цвет плашки нейтральный");
        assert_eq!(buf[220 * w + 5], text_frame(w, h)[220 * w + 5]);
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// `cargo test --release bench_mask -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_mask() {
        for &(w, h) in &[(1920usize, 1080usize), (2560, 1440)] {
            for (name, style) in [("plate", Style::Plate), ("blur", Style::Blur)] {
                for &(label, frac) in &[("окно 1/4 экрана", 0.5f64), ("весь экран", 1.0)] {
                    let mut buf = vec![120u8; w * h + w * (h / 2)];
                    let r = Rect::new(0, 0, (w as f64 * frac) as i32, (h as f64 * frac) as i32);
                    let n = 60;
                    let t = std::time::Instant::now();
                    for _ in 0..n {
                        let mask = FrameMask { ops: vec![MaskOp { rect: r, radius: 14, style: Some(style) }], labels: Vec::new() };
                        mask_nv12(&mut buf, w, h, &mask, &mut |_| None);
                    }
                    let ms = t.elapsed().as_secs_f64() * 1000.0 / n as f64;
                    println!("{w}x{h} {name:5} {label:16} {ms:6.2} мс/кадр");
                }
            }
        }
    }
}

#[cfg(test)]
mod dump {
    use super::*;

    /// Y-плоскость кадра с «текстом» после размытия — в файл из ZALI_PRIVACY_DUMP.
    #[test]
    #[ignore]
    fn dump_blur() {
        let Ok(path) = std::env::var("ZALI_PRIVACY_DUMP") else { return };
        let (w, h) = (1280usize, 720usize);
        let mut buf = vec![128u8; w * h + w * (h / 2)];
        for y in 0..h {
            for x in 0..w {
                // Строки «текста» по 23 px: штрихи 2–3 px на белом.
                let line = y % 23;
                let ink = line > 4 && line < 18 && (x * 7 + y * 3) % 11 < 3 && (x / 90) % 5 != 4;
                buf[y * w + x] = if ink { 25 } else { 235 };
            }
        }
        let mask = FrameMask {
            ops: vec![
                MaskOp { rect: Rect::new(-20, 40, 640, 680), radius: 14, style: Some(Style::Blur) },
                MaskOp { rect: Rect::new(700, 100, 1220, 400), radius: 14, style: Some(Style::Plate) },
                MaskOp { rect: Rect::new(400, 300, 900, 600), radius: 20, style: None },
            ],
            labels: Vec::new(),
        };
        mask_nv12(&mut buf, w, h, &mask, &mut |_| None);
        std::fs::write(path, &buf[..w * h]).unwrap();
    }
}
