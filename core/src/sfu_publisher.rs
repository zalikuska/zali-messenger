//! Нативная отправка демонстрации экрана на SFU сервера (фича `sfu`).
//!
//! Экран на всех оболочках снимается нативно и аппаратно сжимается (VideoToolbox, MediaCodec,
//! Media Foundation). Раньше готовые кадры шли в WebView, там распаковывались в дорожку и
//! WebRTC сжимал их второй раз — двойная работа и потеря качества. Здесь оболочка отдаёт
//! готовые слои simulcast (Annex B) прямо клиенту WebRTC на str0m, и он шлёт их на SFU.
//!
//! Сигналинг остаётся у страницы: она уже держит WS и состояние звонка. Издатель создаёт
//! оффер, страница шлёт его серверу `voice_sfu_publish` со `slot: "native"` и возвращает
//! ответ (`answer`). Дальше всё общение — UDP между издателем и SFU.
//!
//! Обратная связь оболочке — события JSON через колбэк (из потока издателя):
//! - `{"event":"connected"}` / `{"event":"closed","reason":...}`;
//! - `{"event":"keyframe","layer":N}` — SFU просит ключевой кадр слоя (PLI/FIR);
//! - `{"event":"bitrates","bitrates":[q,h,f]}` — бюджет слоёв из оценки канала; 0 — слой
//!   выключить (не кодировать), пока бюджет не вернётся;
//! - `{"event":"stats",...}` — раз в 2 с для диагностики.
//!
//! Ограничения первой версии: только UDP (без ICE-TCP — у клиента с закрытым UDP экран
//! пойдёт старым путём через страницу), без звука экрана. Кодек — один на издателя
//! (`PublisherConfig::codec`): H.264, H.265 или AV1, как его кодирует оболочка (2026-11-24;
//! до этого — только H.264).

use serde::Deserialize;
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, Frequency, MediaKind, MediaTime, Mid, Rid, Simulcast, SimulcastLayer};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

/// Слой simulcast так, как его кодирует оболочка (от меньшего к большему).
#[derive(Debug, Clone, Deserialize)]
pub struct LayerConfig {
    /// rid слоя: «q», «h», «f» — как у браузерного издателя (сервер их и ждёт).
    pub rid: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Потолок битрейта слоя, бит/с.
    pub max_bitrate: u64,
    /// Минимум, с которым слой ещё стоит слать, бит/с (`minBps` страницы). Нет — 1/10 потолка.
    #[serde(default)]
    pub min_bitrate: Option<u64>,
}

impl LayerConfig {
    fn min(&self) -> u64 {
        self.min_bitrate.unwrap_or(self.max_bitrate / 10).clamp(100_000.min(self.max_bitrate), self.max_bitrate)
    }
}

/// Запас над суммой минимумов, чтобы слой включился (выключается — ниже самой суммы).
const LAYER_ON_MARGIN: f64 = 1.3;

/// Сколько включённый слой ждёт, прежде чем выключиться от нехватки бюджета.
const LAYER_OFF_HOLD: Duration = Duration::from_secs(3);

/// Раздача бюджета слоям, как в Chrome: слой включается по МИНИМУМАМ (сумма минимумов
/// его и нижних, с запасом `LAYER_ON_MARGIN`; выключается ниже самой суммы), нижние
/// включённые получают умеренную долю (1,5 минимума), верхний — весь остаток до потолка,
/// лишнее возвращается нижним. Нижний слой не выключается никогда.
///
/// Раньше верхний включался, только когда остатка хватало на 60 % его ПОТОЛКА: с потолками
/// страницы (h 12, f 40 Мбит/с) h жил лишь при оценке >5–8 Мбит/с, f не включался никогда —
/// живой Windows → Mac 2026-11-22: 960×540, кодировщик на урезанном бюджете терял кадры.
/// `bounds` — (минимум, потолок) по слоям снизу вверх, `on` — включён ли слой сейчас.
pub fn allocate_layers(budget: f64, bounds: &[(f64, f64)], on: &[bool]) -> Vec<u64> {
    let n = bounds.len();
    let mut next = vec![0u64; n];
    if n == 0 {
        return next;
    }
    let mut active = 1;
    let mut sum_min = bounds[0].0;
    for i in 1..n {
        sum_min += bounds[i].0;
        let need = if on.get(i).copied().unwrap_or(false) { sum_min } else { sum_min * LAYER_ON_MARGIN };
        if budget < need {
            break;
        }
        active = i + 1;
    }
    let top = active - 1;
    let mut give = vec![0f64; n];
    for i in 0..top {
        give[i] = (bounds[i].0 * 1.5).min(bounds[i].1);
    }
    let lower: f64 = give[..top].iter().sum();
    let floor = if top == 0 { bounds[0].0.min(150_000.0) } else { bounds[top].0 };
    give[top] = (budget - lower).clamp(floor, bounds[top].1);
    let mut left = budget - give.iter().sum::<f64>();
    for i in (0..top).rev() {
        if left <= 0.0 {
            break;
        }
        let add = left.min(bounds[i].1 - give[i]).max(0.0);
        give[i] += add;
        left -= add;
    }
    for i in 0..active {
        next[i] = give[i] as u64;
    }
    next
}

#[cfg(test)]
mod allocate_tests {
    use super::allocate_layers;
    // Слои страницы для экрана: q 150k–400k, h 1M–12M, f 2.5M–40M.
    const L: [(f64, f64); 3] = [(150e3, 400e3), (1e6, 12e6), (2.5e6, 40e6)];

    #[test]
    fn modest_wifi_estimate_still_runs_the_top_layer() {
        // 10 Мбит/с: раньше — только q и h (f требовал 24 Мбит/с остатка).
        let a = allocate_layers(9e6, &L, &[true, true, false]);
        assert!(a[2] > 6_000_000, "{a:?}");
        assert!(a.iter().sum::<u64>() <= 9_000_000);
    }

    #[test]
    fn hysteresis_keeps_a_layer_near_its_threshold() {
        let sum = 150e3 + 1e6 + 2.5e6;
        assert_eq!(allocate_layers(sum * 1.1, &L, &[true, true, false])[2], 0, "off: needs the margin");
        assert!(allocate_layers(sum * 1.1, &L, &[true, true, true])[2] > 0, "on: stays above the sum");
    }

    #[test]
    fn low_estimate_keeps_only_the_bottom_layer() {
        let a = allocate_layers(600e3, &L, &[true, true, true]);
        assert_eq!(&a[1..], &[0, 0]);
        assert_eq!(a[0], 400_000);
        assert_eq!(allocate_layers(50e3, &L, &[true, false, false])[0], 150_000);
    }

    #[test]
    fn surplus_tops_up_lower_layers() {
        let a = allocate_layers(60e6, &L, &[true, true, true]);
        assert_eq!(a, vec![400_000, 12_000_000, 40_000_000]);
    }
}

/// Кодек слоёв. Оболочка кодирует все слои одним кодеком; оффер содержит только его —
/// сервер не может ответить кодеком, которого издатель не умеет.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoCodec {
    /// Annex B, у ключевого кадра SPS/PPS внутри.
    #[default]
    H264,
    /// Annex B, у ключевого кадра VPS/SPS/PPS внутри.
    H265,
    /// OBU low-overhead (размеры внутри), у ключевого кадра — заголовок последовательности.
    Av1,
}

impl VideoCodec {
    /// «H264» / «H265» / «AV1» (как в `SFU_CODEC_ORDER` страницы), без учёта регистра.
    pub fn parse(name: &str) -> Option<Self> {
        match name.to_ascii_uppercase().as_str() {
            "H264" | "AVC" => Some(Self::H264),
            "H265" | "HEVC" => Some(Self::H265),
            "AV1" => Some(Self::Av1),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::H264 => "H264",
            Self::H265 => "H265",
            Self::Av1 => "AV1",
        }
    }

    fn str0m(self) -> Codec {
        match self {
            Self::H264 => Codec::H264,
            Self::H265 => Codec::H265,
            Self::Av1 => Codec::Av1,
        }
    }
}

impl<'de> Deserialize<'de> for VideoCodec {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let name = String::deserialize(d)?;
        Self::parse(&name).ok_or_else(|| serde::de::Error::custom(format!("неизвестный кодек {name}")))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PublisherConfig {
    pub layers: Vec<LayerConfig>,
    /// Кодек слоёв; нет — H.264 (старые оболочки).
    #[serde(default)]
    pub codec: VideoCodec,
    /// Стартовая оценка канала, бит/с (как `x-google-start-bitrate` у страницы).
    #[serde(default)]
    pub start_bitrate: Option<u64>,
}

pub type EventSink = Box<dyn Fn(String) + Send + 'static>;

enum Cmd {
    Answer(String),
    Frame { layer: usize, data: Vec<u8>, keyframe: bool, pts_us: i64 },
    /// Кадр слоя выброшен до отправки (очередь полна): дальше — только с ключевого.
    Broken(usize),
    Close,
}

pub struct SfuPublisher {
    offer_sdp: String,
    mid: String,
    cmd: Sender<Cmd>,
    waker: Option<(UdpSocket, SocketAddr)>,
    thread: Option<JoinHandle<()>>,
    /// Кадров, ещё не взятых потоком: больше `MAX_QUEUED` — новые разностные выбрасываем
    /// (кодировщик быстрее канала или поток подвис), ключевые берём всегда.
    queued: Arc<Mutex<usize>>,
    queue_drops: Arc<AtomicU64>,
}

/// Точность системного таймера 1 мс, пока жив публикатор (только Windows).
///
/// По умолчанию Windows будит потоки шагом ~15,6 мс — и тайм-аут сокета в цикле ниже тоже.
/// Пейсер str0m выпускал пакеты пачками раз в 16 мс, оценка канала (TWCC) застревала около
/// 5 Мбит/с, верхний слой не включался, кодировщики Media Foundation на урезанном бюджете
/// выкидывали кадры: живой Windows → Mac 2026-11-22 — 960×540 при 14 к/с. На стенде
/// (`sfu_e2e/native_pub.mjs`, ожидание огрублено до 16 мс) — то же: 5 Мбит/с, буфер
/// зрителя 200–360 мс; с шагом 1–2 мс — 1080p60 и 17 Мбит/с. Так же делает libwebrtc.
struct HighResTimer;

#[cfg(windows)]
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
    fn timeEndPeriod(period: u32) -> u32;
}

#[cfg(windows)]
#[repr(C)]
struct ProcessPowerThrottlingState {
    version: u32,
    control_mask: u32,
    state_mask: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn SetProcessInformation(process: *mut std::ffi::c_void, class: i32, info: *const std::ffi::c_void, size: u32) -> i32;
}

impl HighResTimer {
    fn new() -> Self {
        #[cfg(windows)]
        unsafe {
            // Windows 11 не выдаёт 1 мс процессу со свёрнутым/перекрытым окном, а при
            // показе экрана окно Zali как раз сзади: просим не урезать (ProcessPowerThrottling = 4,
            // PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 4, состояние 0 — «не урезать»).
            let state = ProcessPowerThrottlingState { version: 1, control_mask: 4, state_mask: 0 };
            SetProcessInformation(
                GetCurrentProcess(),
                4,
                &state as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<ProcessPowerThrottlingState>() as u32,
            );
            timeBeginPeriod(1);
        }
        HighResTimer
    }
}

impl Drop for HighResTimer {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            timeEndPeriod(1);
        }
    }
}

const MAX_QUEUED: usize = 24;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Сколько ждать после обрыва ICE, прежде чем сдаться: str0m сам перезапускает проверки,
/// короткий обрыв Wi-Fi переживаем.
const DISCONNECT_GRACE: Duration = Duration::from_secs(10);

impl SfuPublisher {
    pub fn new(config: PublisherConfig, sink: EventSink) -> Result<Self, String> {
        if config.layers.is_empty() || config.layers.len() > 3 {
            return Err("нужно от 1 до 3 слоёв".into());
        }
        let socket = bind_udp().map_err(|e| format!("udp bind: {e}"))?;
        let port = socket.local_addr().map_err(|e| e.to_string())?.port();
        let host_ip = outbound_ip().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
        let local = SocketAddr::new(host_ip, port);

        let start = config.start_bitrate.unwrap_or(2_500_000).clamp(300_000, 50_000_000);
        let codec = config.codec;
        let mut rtc = Rtc::builder()
            .clear_codecs()
            .enable_h264(codec == VideoCodec::H264)
            .enable_h265(codec == VideoCodec::H265)
            .enable_av1(codec == VideoCodec::Av1)
            .enable_bwe(Some(Bitrate::from(start)))
            // Повторы (NACK) идут из этого буфера: ключевой кадр 4K — тысячи пакетов.
            .set_send_buffer_video(8000)
            // Потери и NACK по слоям (RTCP RR сервера) — в `stats` для диагностики.
            .set_stats_interval(Some(Duration::from_secs(2)))
            .build(Instant::now());
        let cand = Candidate::host(local, "udp").map_err(|e| format!("candidate: {e:?}"))?;
        rtc.add_local_candidate(cand);

        let mut api = rtc.sdp_api();
        let simulcast = Simulcast {
            send: config.layers.iter().map(|l| SimulcastLayer::new(&l.rid)).collect(),
            recv: vec![],
        };
        let mid = api.add_media(
            MediaKind::Video,
            Direction::SendOnly,
            Some("zali-native-screen".into()),
            Some("screen".into()),
            Some(simulcast),
        );
        let (offer, pending) = api.apply().ok_or("str0m не создал оффер")?;
        let offer_sdp = offer.to_sdp_string();

        socket.set_nonblocking(false).ok();
        let waker_sock = UdpSocket::bind("127.0.0.1:0").ok();
        let waker_from = waker_sock.as_ref().and_then(|s| s.local_addr().ok());
        let waker = waker_sock.map(|s| (s, SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)));

        let (tx, rx) = mpsc::channel();
        let queued = Arc::new(Mutex::new(0usize));
        let queue_drops = Arc::new(AtomicU64::new(0));
        let worker = Worker {
            queue_drops: queue_drops.clone(),
            frames: vec![0; config.layers.len()],
            send_errors: 0,
            egress: vec![(0, 0.0, 0, 0); config.layers.len()],
            rtc,
            socket,
            local,
            mid,
            pending: Some(pending),
            layers: config.layers.clone(),
            rids: config.layers.iter().map(|l| Rid::from(l.rid.as_str())).collect(),
            sink,
            rx,
            waker_from,
            queued: queued.clone(),
            created: Instant::now(),
            connected: false,
            disconnected_since: None,
            estimate: start as f64,
            alloc: vec![0; config.layers.len()],
            alloc_sent_at: None,
            below_since: vec![None; config.layers.len()],
            sent_bytes: vec![0; config.layers.len()],
            wire_bytes: 0,
            dropped: 0,
            last_stats: Instant::now(),
            pt: None,
            codec,
            first_pts: vec![None; config.layers.len()],
            need_key: vec![true; config.layers.len()],
        };
        let thread = std::thread::Builder::new()
            .name("zali-sfu-pub".into())
            .spawn(move || worker.run())
            .map_err(|e| e.to_string())?;
        Ok(Self { offer_sdp, mid: mid.to_string(), cmd: tx, waker, thread: Some(thread), queued, queue_drops })
    }

    /// Оффер и mid видеолинии (страница сообщает серверу `sources: {mid: "screen"}`).
    pub fn offer(&self) -> (&str, &str) {
        (&self.offer_sdp, &self.mid)
    }

    pub fn accept_answer(&self, sdp: String) {
        let _ = self.cmd.send(Cmd::Answer(sdp));
        self.wake();
    }

    /// Готовый кадр слоя в кодеке издателя (см. `VideoCodec`): у ключевого кадра параметры
    /// последовательности — внутри.
    pub fn push_frame(&self, layer: usize, data: Vec<u8>, keyframe: bool, pts_us: i64) {
        {
            let mut q = self.queued.lock().unwrap();
            if *q >= MAX_QUEUED && !keyframe {
                self.queue_drops.fetch_add(1, Ordering::Relaxed);
                // Молча выброшенный кадр ломает цепочку ссылок: следующие P-кадры уходят,
                // у зрителя застревают куски экрана и «призраки» курсора до планового
                // ключевого кадра (живой Windows → Mac 2026-11-22). Слой ждёт ключевой.
                drop(q);
                let _ = self.cmd.send(Cmd::Broken(layer));
                self.wake();
                return;
            }
            *q += 1;
        }
        let _ = self.cmd.send(Cmd::Frame { layer, data, keyframe, pts_us });
        self.wake();
    }

    fn wake(&self) {
        if let Some((s, to)) = &self.waker {
            let _ = s.send_to(b"w", to);
        }
    }
}

impl Drop for SfuPublisher {
    fn drop(&mut self) {
        let _ = self.cmd.send(Cmd::Close);
        self.wake();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Worker {
    rtc: Rtc,
    socket: UdpSocket,
    local: SocketAddr,
    mid: Mid,
    pending: Option<SdpPendingOffer>,
    layers: Vec<LayerConfig>,
    rids: Vec<Rid>,
    sink: EventSink,
    rx: Receiver<Cmd>,
    waker_from: Option<SocketAddr>,
    queued: Arc<Mutex<usize>>,
    queue_drops: Arc<AtomicU64>,
    /// Кадров, отданных str0m, по слоям за окно статистики.
    frames: Vec<u64>,
    /// Пакетов, которые сокет не принял (буфер полон, сеть пропала).
    send_errors: u64,
    /// По слоям из статистики str0m: (NACK всего, доля потерь из RR, RTT мс, пакетов всего).
    egress: Vec<(u64, f32, u64, u64)>,
    created: Instant,
    connected: bool,
    disconnected_since: Option<Instant>,
    estimate: f64,
    alloc: Vec<u64>,
    alloc_sent_at: Option<Instant>,
    /// С какого момента включённому слою не хватает бюджета (удержание `LAYER_OFF_HOLD`).
    below_since: Vec<Option<Instant>>,
    sent_bytes: Vec<u64>,
    /// Всё, что ушло в сокет за окно статистики: кадры, повторы, паддинг, RTCP, STUN.
    /// Сильно больше суммы `sent_bytes` — str0m шлёт паддинг (так 50 Мбит/с мусора и нашли).
    wire_bytes: u64,
    dropped: u64,
    last_stats: Instant,
    pt: Option<str0m::media::Pt>,
    codec: VideoCodec,
    /// Первая метка слоя: RTP-время считается от неё (у слоёв общая шкала — метки захвата).
    first_pts: Vec<Option<i64>>,
    /// Слой ждёт ключевого кадра (старт, восстановление после обрыва, возврат из паузы):
    /// разностные до него зритель всё равно не декодирует — не тратим на них канал.
    need_key: Vec<bool>,
}

impl Worker {
    fn emit(&self, v: serde_json::Value) {
        (self.sink)(v.to_string());
    }

    fn run(mut self) {
        let _timer = HighResTimer::new();
        let mut buf = vec![0u8; 2000];
        // Когда пришёл ответ страницы: срок подключения идёт от него, а не от создания.
        let mut answered_at: Option<Instant> = None;
        loop {
            // Команды.
            loop {
                match self.rx.try_recv() {
                    Ok(Cmd::Close) | Err(TryRecvError::Disconnected) => {
                        self.rtc.disconnect();
                        self.emit(json!({"event": "closed", "reason": "local"}));
                        return;
                    }
                    Ok(Cmd::Answer(sdp)) => {
                        answered_at = Some(Instant::now());
                        if let Err(e) = self.apply_answer(&sdp) {
                            self.emit(json!({"event": "closed", "reason": "bad_answer", "message": e}));
                            return;
                        }
                    }
                    Ok(Cmd::Frame { layer, data, keyframe, pts_us }) => {
                        *self.queued.lock().unwrap() -= 1;
                        self.write_frame(layer, data, keyframe, pts_us);
                    }
                    Ok(Cmd::Broken(layer)) => self.mark_broken(layer),
                    Err(TryRecvError::Empty) => break,
                }
            }

            // Вывод str0m до таймаута.
            let deadline = loop {
                match self.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => break t,
                    Ok(Output::Transmit(t)) => {
                        self.wire_bytes += t.contents.len() as u64;
                        if self.socket.send_to(&t.contents, t.destination).is_err() {
                            self.send_errors += 1;
                        }
                    }
                    Ok(Output::Event(e)) => {
                        if !self.on_event(e) {
                            return;
                        }
                    }
                    Err(e) => {
                        self.emit(json!({"event": "closed", "reason": "rtc_error", "message": format!("{e:?}")}));
                        return;
                    }
                }
            };

            let now = Instant::now();
            if !self.connected {
                let since = self.disconnected_since.or(answered_at).unwrap_or(self.created);
                let limit = if self.disconnected_since.is_some() { DISCONNECT_GRACE } else { CONNECT_TIMEOUT };
                // Пока ответа нет, ждём страницу — её WS мог переподключаться.
                if (answered_at.is_some() || self.disconnected_since.is_some()) && now.duration_since(since) > limit {
                    let reason = if self.disconnected_since.is_some() { "disconnected" } else { "connect_timeout" };
                    self.emit(json!({"event": "closed", "reason": reason}));
                    return;
                }
            }
            if now.duration_since(self.last_stats) >= Duration::from_secs(2) {
                self.report_stats(now);
            }

            // Срок str0m уже наступил (пейсер выпускает по пакету и сразу просит новый
            // таймаут): не спим на сокете — иначе минимум 1 мс на пакет, потолок ~900 пак./с,
            // и при трёх слоях верхний копил очередь и доходил на 50 к/с вместо 60.
            if deadline <= now {
                if !self.drain_socket(&mut buf, false) {
                    return;
                }
                let _ = self.rtc.handle_input(Input::Timeout(now));
                continue;
            }
            // Ждём пакет до таймаута str0m (кадры будят через waker).
            let wait = deadline.saturating_duration_since(now).clamp(Duration::from_millis(1), Duration::from_millis(100));
            let _ = self.socket.set_read_timeout(Some(wait));
            if !self.drain_socket(&mut buf, true) {
                return;
            }
        }
    }

    /// Блокирующий режим — ждёт один пакет до таймаута сокета; иначе забирает всё, что уже
    /// пришло. `false` — сессия кончилась.
    fn drain_socket(&mut self, buf: &mut [u8], blocking: bool) -> bool {
        if !blocking {
            let _ = self.socket.set_nonblocking(true);
        }
        let mut got = false;
        let alive = loop {
            match self.socket.recv_from(buf) {
                Ok((n, from)) => {
                    got = true;
                    if Some(from) != self.waker_from {
                        if let Ok(contents) = buf[..n].try_into() {
                            let input = Input::Receive(
                                Instant::now(),
                                Receive { proto: Protocol::Udp, source: from, destination: self.local, contents },
                            );
                            if let Err(e) = self.rtc.handle_input(input) {
                                self.emit(json!({"event": "closed", "reason": "rtc_error", "message": format!("{e:?}")}));
                                break false;
                            }
                        }
                    }
                    if blocking {
                        break true;
                    }
                }
                Err(_) => break true,
            }
        };
        if !blocking {
            let _ = self.socket.set_nonblocking(false);
        }
        if alive && blocking && !got {
            let _ = self.rtc.handle_input(Input::Timeout(Instant::now()));
        }
        alive
    }

    fn apply_answer(&mut self, sdp: &str) -> Result<(), String> {
        let answer = SdpAnswer::from_sdp_string(sdp).map_err(|e| format!("{e:?}"))?;
        let pending = self.pending.take().ok_or("ответ уже принят")?;
        self.rtc.sdp_api().accept_answer(pending, answer).map_err(|e| format!("{e:?}"))?;
        // Желаемый битрейт — сумма потолков слоёв: str0m зондирует канал до него.
        //
        // Минимум — НОЛЬ. Первый аргумент `set_bitrate` — не ориентир, а скорость, которую
        // str0m держит паддингом, когда кадров меньше («padding fills the gap, capped by the
        // estimate»). Сюда шла раздача слоям (0,9 оценки), а это потолок кодировщика: экран в
        // статике кодируется в ~1 Мбит/с, и str0m добивал разницу мусором — до 50 Мбит/с
        // паддинга ради 1 Мбит/с видео (живой Windows → Mac 2026-11-22: оценка 53 Мбит/с,
        // раздача 0,2 + 7,5 + 40, отправлено 0,95). Паддинг держал эфир получателя забитым
        // почти до оценки: каждая пауза Wi-Fi (у Mac — ~70 мс раз в 0,5 с, AWDL) переполняла
        // очередь точки доступа, терялись голос (5–8 %) и видео, оценка падала до 2 Мбит/с и
        // снова разгонялась паддингом — пила 2 ↔ 65 Мбит/с, слои то выключались, то
        // включались. Канал разведывают пробы str0m (начальные 3×/6×, экспоненциальные, на
        // рост желаемого, периодические в ALR раз в 5 с, при застое), найденная оценка в покое
        // не падает. Свои 50 кбит/с (NAT, RTX) str0m держит и при нулевом минимуме.
        let desired: u64 = self.layers.iter().map(|l| l.max_bitrate).sum();
        self.rtc.bwe().set_bitrate(Bitrate::ZERO, Bitrate::from(desired));
        Ok(())
    }

    fn pick_pt(&mut self) -> Option<str0m::media::Pt> {
        if self.pt.is_some() {
            return self.pt;
        }
        let writer = self.rtc.writer(self.mid)?;
        let want = self.codec.str0m();
        let mut best = None;
        for p in writer.payload_params() {
            let spec = p.spec();
            // H.264 — только packetization-mode=1 (FU-A): без него кадр больше MTU не уйдёт.
            if spec.codec != want || (want == Codec::H264 && spec.format.packetization_mode != Some(1)) {
                continue;
            }
            // Профиль в fmtp декодеры не проверяют, но Constrained Baseline/High 4:2:0 —
            // самые совместимые; берём первый подходящий.
            best = Some(p.pt());
            break;
        }
        self.pt = best;
        best
    }

    fn write_frame(&mut self, layer: usize, data: Vec<u8>, keyframe: bool, pts_us: i64) {
        if !self.connected || layer >= self.rids.len() {
            return;
        }
        // Выключенный бюджетом слой оболочка не кодирует, но кадр мог быть уже в пути (а слой
        // превью кодируется для страницы и на паузе). Возврат из паузы — с ключевого кадра.
        if self.alloc.get(layer) == Some(&0) && self.alloc_sent_at.is_some() {
            self.dropped += 1;
            return;
        }
        if self.need_key[layer] {
            if !keyframe {
                self.dropped += 1;
                return;
            }
            self.need_key[layer] = false;
        }
        let Some(pt) = self.pick_pt() else {
            return;
        };
        let first = *self.first_pts[layer].get_or_insert(pts_us);
        let ticks = ((pts_us - first).max(0) as u64) * 90 / 1000;
        let time = MediaTime::new(ticks, Frequency::NINETY_KHZ);
        let rid = self.rids[layer];
        let len = data.len() as u64;
        let Some(writer) = self.rtc.writer(self.mid) else {
            return;
        };
        match writer.rid(rid).write(pt, Instant::now(), time, data) {
            Ok(()) => {
                self.sent_bytes[layer] += len;
                self.frames[layer] += 1;
            }
            Err(e) => {
                self.emit(json!({"event": "warn", "message": format!("write {}: {e:?}", rid)}));
                self.mark_broken(layer);
            }
        }
    }

    /// `false` — сессия кончилась.
    fn on_event(&mut self, e: Event) -> bool {
        match e {
            Event::Connected => {
                self.connected = true;
                self.disconnected_since = None;
                self.emit(json!({"event": "connected"}));
                self.allocate(true);
                self.request_keyframes();
            }
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                if self.connected {
                    self.connected = false;
                    self.disconnected_since = Some(Instant::now());
                    self.emit(json!({"event": "state", "state": "disconnected"}));
                }
            }
            Event::IceConnectionStateChange(IceConnectionState::Connected | IceConnectionState::Completed) => {
                if self.disconnected_since.is_some() {
                    self.connected = true;
                    self.disconnected_since = None;
                    self.emit(json!({"event": "state", "state": "connected"}));
                    // После обрыва зритель ждёт ключевой кадр — дадим его сразу.
                    self.request_keyframes();
                }
            }
            Event::KeyframeRequest(req) => {
                if req.mid == self.mid {
                    let layer = req.rid.and_then(|r| self.rids.iter().position(|x| *x == r)).unwrap_or(0);
                    self.emit(json!({"event": "keyframe", "layer": layer}));
                }
            }
            Event::MediaEgressStats(st) => {
                if let Some(i) = st.rid.and_then(|r| self.rids.iter().position(|x| *x == r)) {
                    self.egress[i] = (st.nacks, st.loss.unwrap_or(0.0), st.rtt.map(|d| d.as_millis() as u64).unwrap_or(0), st.packets);
                }
            }
            Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                self.estimate = estimate.as_f64();
                self.allocate(false);
            }
            _ => {}
        }
        true
    }

    /// Кадр слоя потерян до отправки: следующие дельты бесполезны — ждём ключевой и
    /// просим его один раз на разрыв (не на каждый выброшенный кадр).
    fn mark_broken(&mut self, layer: usize) {
        if layer < self.need_key.len() && !self.need_key[layer] {
            self.need_key[layer] = true;
            self.emit(json!({"event": "keyframe", "layer": layer}));
        }
    }

    fn request_keyframes(&mut self) {
        for i in 0..self.rids.len() {
            self.need_key[i] = true;
            self.emit(json!({"event": "keyframe", "layer": i}));
        }
    }

    /// Бюджет слоёв от оценки канала — `allocate_layers`.
    fn allocate(&mut self, force: bool) {
        let bounds: Vec<(f64, f64)> = self.layers.iter().map(|l| (l.min() as f64, l.max_bitrate as f64)).collect();
        let on: Vec<bool> = self.alloc.iter().map(|a| *a > 0).collect();
        let mut next = allocate_layers(self.estimate * 0.9, &bounds, &on);
        // Короткий провал оценки (Wi-Fi: 65 → 2 → 50 Мбит/с за секунды) не выключает слой:
        // выключение — ключевой кадр и смена слоя у зрителя, то есть фриз. Слой держится на
        // минимуме, пока бюджета не хватает меньше `LAYER_OFF_HOLD`.
        let now_hold = Instant::now();
        for i in 1..next.len() {
            if next[i] > 0 || !on[i] {
                self.below_since[i] = None;
                continue;
            }
            let since = *self.below_since[i].get_or_insert(now_hold);
            if now_hold.duration_since(since) < LAYER_OFF_HOLD && next[i - 1] > 0 {
                next[i] = bounds[i].0 as u64;
            }
        }
        let now = Instant::now();
        let changed_pause = next.iter().zip(&self.alloc).any(|(a, b)| (*a == 0) != (*b == 0));
        let big = next.iter().zip(&self.alloc).any(|(a, b)| {
            let (a, b) = (*a as f64, *b as f64);
            (a - b).abs() > b.max(1.0) * 0.15
        });
        let down = next.iter().zip(&self.alloc).any(|(a, b)| a < b);
        let rate_ok = self.alloc_sent_at.map_or(true, |t| now.duration_since(t) >= Duration::from_secs(1));
        if force || changed_pause || (big && (down || rate_ok)) {
            // Слой возвращается из паузы: оболочка возобновит кодирование с ключевого кадра.
            let resumed: Vec<usize> =
                (0..next.len()).filter(|&i| next[i] > 0 && self.alloc[i] == 0 && !force).collect();
            self.alloc = next;
            self.alloc_sent_at = Some(now);
            self.emit(json!({"event": "bitrates", "bitrates": self.alloc, "estimate": self.estimate as u64}));
            for i in resumed {
                self.need_key[i] = true;
                self.emit(json!({"event": "keyframe", "layer": i}));
            }
            // Минимум str0m здесь НЕ трогаем: раздача — потолок кодировщика, а не его выход, и
            // «минимум = раздача + шаг к следующему слою» превращался в паддинг на всю оценку
            // (см. `apply_answer`). Включение слоя проверяют пробы str0m.
        }
    }

    fn report_stats(&mut self, now: Instant) {
        let secs = now.duration_since(self.last_stats).as_secs_f64().max(0.001);
        let kbps: Vec<u64> = self.sent_bytes.iter().map(|b| (*b as f64 * 8.0 / secs / 1000.0) as u64).collect();
        let fps: Vec<f64> = self.frames.iter().map(|f| (*f as f64 / secs * 10.0).round() / 10.0).collect();
        let wire_kbps = (self.wire_bytes as f64 * 8.0 / secs / 1000.0) as u64;
        self.sent_bytes.iter_mut().for_each(|b| *b = 0);
        self.frames.iter_mut().for_each(|f| *f = 0);
        self.wire_bytes = 0;
        self.last_stats = now;
        self.emit(json!({
            "event": "stats",
            "connected": self.connected,
            "estimate_kbps": (self.estimate / 1000.0) as u64,
            "alloc_kbps": self.alloc.iter().map(|a| a / 1000).collect::<Vec<_>>(),
            "sent_kbps": kbps,
            "wire_kbps": wire_kbps,
            "codec": self.codec.name(),
            "fps": fps,
            "dropped": self.dropped,
            "queue_drops": self.queue_drops.load(Ordering::Relaxed),
            "send_errors": self.send_errors,
            "nacks": self.egress.iter().map(|e| e.0).collect::<Vec<_>>(),
            "loss_pct": self.egress.iter().map(|e| (e.1 * 1000.0).round() / 10.0).collect::<Vec<_>>(),
            "rtt_ms": self.egress.iter().map(|e| e.2).max().unwrap_or(0),
            "packets": self.egress.iter().map(|e| e.3).collect::<Vec<_>>(),
        }));
    }
}

/// UDP-сокет с большими буферами: ключевой кадр 4K — тысячи пакетов почти разом, а
/// системные буферы (macOS — ~9 КБ на отправку) молча выбрасывают хвост.
fn bind_udp() -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol as SockProto, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(SockProto::UDP))?;
    for size in [8 << 20, 4 << 20, 2 << 20, 1 << 20] {
        if socket.set_send_buffer_size(size).is_ok() {
            break;
        }
    }
    for size in [4 << 20, 2 << 20, 1 << 20] {
        if socket.set_recv_buffer_size(size).is_ok() {
            break;
        }
    }
    socket.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0).into())?;
    Ok(socket.into())
}

/// Адрес интерфейса, через который уходит трафик наружу (`connect` у UDP ничего не шлёт).
fn outbound_ip() -> Option<IpAddr> {
    let probe = UdpSocket::bind("0.0.0.0:0").ok()?;
    probe.connect("8.8.8.8:53").ok()?;
    let ip = probe.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

// ============================================================
// C-интерфейс (macOS через CoreBridge.h; Windows зовёт Rust напрямую)
// ============================================================

use std::ffi::{c_char, c_void, CStr, CString};

pub type ZaliSfuPubCallback = extern "C" fn(ctx: *mut c_void, json: *const c_char);

struct CtxPtr(*mut c_void);
// Указатель на контекст оболочки; оболочка обещает, что он живёт до zali_sfu_pub_free
// и что колбэк можно звать с чужого потока.
unsafe impl Send for CtxPtr {}

/// # Safety
/// `config_json` — строка C; `ctx` живёт до `zali_sfu_pub_free`.
#[no_mangle]
pub unsafe extern "C" fn zali_sfu_pub_new(
    config_json: *const c_char,
    callback: ZaliSfuPubCallback,
    ctx: *mut c_void,
) -> *mut SfuPublisher {
    if config_json.is_null() {
        return std::ptr::null_mut();
    }
    let Ok(text) = CStr::from_ptr(config_json).to_str() else {
        return std::ptr::null_mut();
    };
    let Ok(config) = serde_json::from_str::<PublisherConfig>(text) else {
        return std::ptr::null_mut();
    };
    let ctx = CtxPtr(ctx);
    let sink: EventSink = Box::new(move |s: String| {
        let ctx = &ctx;
        if let Ok(c) = CString::new(s) {
            callback(ctx.0, c.as_ptr());
        }
    });
    match SfuPublisher::new(config, sink) {
        Ok(p) => Box::into_raw(Box::new(p)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// `{"sdp":"...","mid":"..."}`; освобождать — `zali_bus_free_string`.
///
/// # Safety
/// `p` — из `zali_sfu_pub_new`.
#[no_mangle]
pub unsafe extern "C" fn zali_sfu_pub_offer_json(p: *const SfuPublisher) -> *mut c_char {
    let Some(p) = p.as_ref() else {
        return std::ptr::null_mut();
    };
    let (sdp, mid) = p.offer();
    CString::new(json!({"sdp": sdp, "mid": mid}).to_string())
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

/// # Safety
/// `p` — из `zali_sfu_pub_new`, `sdp` — строка C.
#[no_mangle]
pub unsafe extern "C" fn zali_sfu_pub_answer(p: *const SfuPublisher, sdp: *const c_char) -> bool {
    let (Some(p), false) = (p.as_ref(), sdp.is_null()) else {
        return false;
    };
    let Ok(s) = CStr::from_ptr(sdp).to_str() else {
        return false;
    };
    p.accept_answer(s.to_string());
    true
}

/// # Safety
/// `p` — из `zali_sfu_pub_new`; `data` — `len` байт.
#[no_mangle]
pub unsafe extern "C" fn zali_sfu_pub_push(
    p: *const SfuPublisher,
    layer: u32,
    data: *const u8,
    len: usize,
    keyframe: bool,
    pts_us: i64,
) {
    let (Some(p), false) = (p.as_ref(), data.is_null()) else {
        return;
    };
    p.push_frame(layer as usize, std::slice::from_raw_parts(data, len).to_vec(), keyframe, pts_us);
}

/// Останавливает поток издателя (ждёт его) и освобождает. После возврата колбэк больше
/// не зовётся.
///
/// # Safety
/// `p` — из `zali_sfu_pub_new`, освобождается один раз.
#[no_mangle]
pub unsafe extern "C" fn zali_sfu_pub_free(p: *mut SfuPublisher) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

// ============================================================
// JNI (Android, ZaliSfuNative.kt): та же обёртка, что C-интерфейс выше
// ============================================================

#[cfg(feature = "android")]
mod android {
    use super::{EventSink, PublisherConfig, SfuPublisher};
    use jni::objects::{JByteArray, JObject, JString, JValue};
    use jni::sys::{jboolean, jint, jlong, jstring};
    use jni::JNIEnv;
    use serde_json::json;

    /// `sink` — объект с методом `onEvent(String)`; зовётся с потока издателя. 0 — не создан.
    #[no_mangle]
    pub extern "system" fn Java_org_zalikus_messenger_ZaliSfuNative_create<'l>(
        mut env: JNIEnv<'l>,
        _this: JObject<'l>,
        config_json: JString<'l>,
        sink: JObject<'l>,
    ) -> jlong {
        let Ok(text) = env.get_string(&config_json).map(String::from) else {
            return 0;
        };
        let Ok(config) = serde_json::from_str::<PublisherConfig>(&text) else {
            return 0;
        };
        let (Ok(vm), Ok(target)) = (env.get_java_vm(), env.new_global_ref(sink)) else {
            return 0;
        };
        let sink: EventSink = Box::new(move |s: String| {
            // Поток издателя прикрепляется к JVM один раз (daemon) и живёт до free; локальные
            // ссылки — в своей рамке, иначе копились бы: поток в Java не возвращается.
            let Ok(mut env) = vm.attach_current_thread_as_daemon() else {
                return;
            };
            let _ = env.with_local_frame(4, |env| -> jni::errors::Result<()> {
                let text = env.new_string(&s)?;
                let _ = env.call_method(&target, "onEvent", "(Ljava/lang/String;)V", &[JValue::Object(&text)]);
                if env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                Ok(())
            });
        });
        match SfuPublisher::new(config, sink) {
            Ok(p) => Box::into_raw(Box::new(p)) as jlong,
            Err(_) => 0,
        }
    }

    fn publisher<'a>(ptr: jlong) -> Option<&'a SfuPublisher> {
        // SAFETY: ptr — из create, живёт до free (Kotlin держит его под своим замком).
        unsafe { (ptr as *const SfuPublisher).as_ref() }
    }

    /// `{"sdp":"...","mid":"..."}`.
    #[no_mangle]
    pub extern "system" fn Java_org_zalikus_messenger_ZaliSfuNative_offer<'l>(env: JNIEnv<'l>, _this: JObject<'l>, ptr: jlong) -> jstring {
        let Some(p) = publisher(ptr) else {
            return std::ptr::null_mut();
        };
        let (sdp, mid) = p.offer();
        env.new_string(json!({"sdp": sdp, "mid": mid}).to_string())
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }

    #[no_mangle]
    pub extern "system" fn Java_org_zalikus_messenger_ZaliSfuNative_answer<'l>(
        mut env: JNIEnv<'l>,
        _this: JObject<'l>,
        ptr: jlong,
        sdp: JString<'l>,
    ) {
        if let (Some(p), Ok(s)) = (publisher(ptr), env.get_string(&sdp).map(String::from)) {
            p.accept_answer(s);
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_org_zalikus_messenger_ZaliSfuNative_push<'l>(
        env: JNIEnv<'l>,
        _this: JObject<'l>,
        ptr: jlong,
        layer: jint,
        data: JByteArray<'l>,
        keyframe: jboolean,
        pts_us: jlong,
    ) {
        let Some(p) = publisher(ptr) else {
            return;
        };
        if let Ok(bytes) = env.convert_byte_array(&data) {
            p.push_frame(layer.max(0) as usize, bytes, keyframe != 0, pts_us);
        }
    }

    /// Останавливает поток издателя (ждёт его); после возврата `onEvent` не зовётся.
    #[no_mangle]
    pub extern "system" fn Java_org_zalikus_messenger_ZaliSfuNative_free<'l>(_env: JNIEnv<'l>, _this: JObject<'l>, ptr: jlong) {
        if ptr != 0 {
            // SAFETY: ptr — из create, освобождается один раз.
            drop(unsafe { Box::from_raw(ptr as *mut SfuPublisher) });
        }
    }
}
