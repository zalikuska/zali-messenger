//! SFU — видео звонков через сервер.
//!
//! Зачем. В mesh каждый участник кодирует и отправляет свою камеру/экран отдельной
//! копией каждому собеседнику, по пути «домашний Wi-Fi → домашний Wi-Fi». Оценка канала
//! WebRTC на таком пути видит всплески задержки радиоэфира, режет битрейт и разгоняется
//! обратно десятки секунд; пятеро с камерами просят у аплинка 4–10 Мбит/с. Здесь
//! отправитель грузит ОДИН поток (simulcast: три качества) до сервера, а сервер раздаёт
//! каждому зрителю тот слой, который пролезает в ЕГО канал (своя оценка на каждого
//! зрителя). Звук (микрофон) и каналы данных остаются в mesh: их мало, и задержка там
//! минимальна. Звук демонстрации едет здесь, в одном потоке с картинкой, — ради синхрона.
//!
//! Устройство. Отдельный поток ОС владеет UDP-сокетом и всеми `Rtc` (str0m, sans-IO):
//! читает пакеты, крутит таймеры и пересылает кадры. С tokio-частью сервера он общается
//! двумя очередями: команды (`SfuCommand`) из обработчиков `voice_sfu_*` в voice.rs и
//! исходящие сообщения клиентам (`SfuOut`), которые асинхронная задача отправляет по WS.
//!
//! У каждого клиента ДВЕ сессии: публикация (клиент шлёт оффер, только отправка) и
//! подписка (оффер шлёт сервер, только приём). Встречных офферов (glare) поэтому нет в
//! принципе — каждое соединение согласует ровно одна сторона.
//!
//! Сервер в режиме ICE-lite с одним host-кандидатом (публичный адрес): клиенту не нужно
//! слать нам кандидаты, он сам стучится по адресу из ответа. Клиент за жёстким NAT или с
//! закрытым UDP дойдёт через свой TURN (relay-кандидат → наш host).
//!
//! Шифрование. DTLS-SRTP завершается на сервере: сервер видит видео в открытом виде. Для
//! mesh это было не так — компромисс SFU, записан в скилле `voice-calls`.

use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::time::{Duration, Instant};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::format::CodecExtra;
use str0m::media::{Direction, KeyframeRequestKind, MediaData, MediaKind, MediaTime, Mid, Rid};
use str0m::net::{Protocol, Receive, TcpType};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tracing::{debug, info, warn};

/// Что за источник у публикуемой дорожки. Камера и экран — разные плитки у зрителя, звук
/// демонстрации — в одном потоке с экраном.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum SourceKind {
    Camera,
    Screen,
    ScreenAudio,
}

impl SourceKind {
    pub(crate) fn parse(raw: &str) -> Option<Self> {
        match raw {
            "camera" => Some(Self::Camera),
            "screen" => Some(Self::Screen),
            "screen_audio" => Some(Self::ScreenAudio),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Camera => "camera",
            Self::Screen => "screen",
            Self::ScreenAudio => "screen_audio",
        }
    }

    /// Поток (msid) у зрителя: экран и его звук — один поток, камера — другой.
    fn stream_suffix(self) -> &'static str {
        match self {
            Self::Camera => "c",
            Self::Screen | Self::ScreenAudio => "s",
        }
    }
}

pub(crate) enum SfuCommand {
    /// Оффер публикации (первый или пересогласование) и какой mid что несёт.
    Publish {
        room: String,
        user: String,
        device: String,
        sdp: String,
        sources: HashMap<String, SourceKind>,
        /// Пиксельная нагрузка слоёв (ширина × высота × к/с) по mid и rid — чтобы не
        /// слать зрителю слой, который его декодер не вытянет.
        layers: HashMap<String, HashMap<String, u64>>,
        /// Отдельный слот нативной оболочки: экран, который она шлёт сама (core/src/
        /// sfu_publisher.rs), мимо WebRTC страницы. Живёт рядом с издателем страницы
        /// (камера), не заменяя его.
        native: bool,
        /// Первый оффер нового RTCPeerConnection (перезагрузка страницы, новый издатель
        /// оболочки): живую старую сессию слота не переиспользовать — у неё чужие ключи
        /// DTLS/ICE, оффер на неё молча висел бы, пока она не умрёт.
        fresh: bool,
    },
    /// Снять нативный слот (демонстрация экрана из оболочки кончилась).
    Unpublish { room: String, user: String, native: bool },
    /// Клиент готов принимать видео комнаты (создаёт подписку, когда есть что слать).
    Join {
        room: String,
        user: String,
        device: String,
        /// Пересоздать подписку с нуля (клиент потерял своё соединение).
        reset: bool,
        /// Сколько пикселей в секунду клиент готов декодировать (0 — без ограничения):
        /// телефону не нужен 4K60, которое он покажет слайд-шоу.
        max_pixel_rate: u64,
        /// Клиент умеет «Смотреть» (`Watch`): экран ему шлётся только по запросу. Старый
        /// клиент о запросе не знает — ему экран идёт сразу, как раньше.
        watch_gating: bool,
    },
    /// Ответ клиента на оффер подписки.
    Answer {
        room: String,
        user: String,
        sdp: String,
        rev: u64,
    },
    /// Клиент вышел из SFU (звонок кончился, комната перешла на mesh).
    Leave { room: String, user: String },
    /// Зритель включил/выключил просмотр чужой демонстрации. Экран (и его звук) уходит
    /// зрителю только пока он смотрит: без этого каждый участник звонка получал каждый
    /// стрим целиком, даже не открыв его.
    Watch {
        room: String,
        user: String,
        device: String,
        target: String,
        on: bool,
    },
}

/// Сообщение клиенту, которое tokio-часть отправит по WS (`send_json_to_user`).
#[derive(Debug)]
pub(crate) struct SfuOut {
    pub user: String,
    pub device: String,
    pub payload: serde_json::Value,
}

/// Ручка, которую держит `AppState`. `None` в `AppState.sfu` — SFU выключен (не задан
/// `SFU_UDP_PORT`), комнаты остаются на mesh.
pub(crate) struct SfuHandle {
    tx: std::sync::Mutex<Sender<SfuCommand>>,
}

impl SfuHandle {
    pub(crate) fn send(&self, command: SfuCommand) {
        if let Ok(tx) = self.tx.lock() {
            if tx.send(command).is_err() {
                warn!("[SFU] поток SFU не принимает команды");
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SfuConfig {
    pub bind: SocketAddr,
    /// Адреса, которые сервер объявляет клиентам (host-кандидаты). Пусто — определить.
    pub public_ips: Vec<IpAddr>,
}

impl SfuConfig {
    /// `SFU_UDP_PORT` включает SFU (как TURN/VAPID — по одной настройке на деплой).
    /// `SFU_PUBLIC_IP` — через запятую, если сервер за NAT/в Docker; без него берётся
    /// адрес исходящего интерфейса.
    pub(crate) fn from_env() -> Option<Self> {
        let port = std::env::var("SFU_UDP_PORT")
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|p| *p != 0)?;
        let bind_ip = std::env::var("SFU_BIND_IP")
            .ok()
            .and_then(|v| v.trim().parse::<IpAddr>().ok())
            .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        let public_ips = std::env::var("SFU_PUBLIC_IP")
            .unwrap_or_default()
            .split(',')
            .filter_map(|v| v.trim().parse::<IpAddr>().ok())
            .collect();
        Some(Self {
            bind: SocketAddr::new(bind_ip, port),
            public_ips,
        })
    }
}

/// Запускает поток SFU. Ошибка привязки сокета — не повод ронять сервер: звонки просто
/// остаются на mesh, в лог уходит причина.
pub(crate) fn start(
    config: SfuConfig,
    out: tokio::sync::mpsc::UnboundedSender<SfuOut>,
) -> Option<SfuHandle> {
    let socket = match bind_udp(config.bind) {
        Ok(s) => s,
        Err(e) => {
            warn!("[SFU] не удалось занять UDP {}: {} — видео звонков остаётся в mesh", config.bind, e);
            return None;
        }
    };
    let port = socket.local_addr().map(|a| a.port()).unwrap_or(config.bind.port());
    let mut ips = config.public_ips.clone();
    if ips.is_empty() {
        if !config.bind.ip().is_unspecified() {
            ips.push(config.bind.ip());
        } else if let Some(ip) = outbound_ip().filter(|ip| udp_self_reachable(*ip)) {
            // Пробный пакет самому себе частный адрес проходит всегда — это не достижимость
            // снаружи. В Docker это адрес контейнера: клиенты вне хоста не подключатся.
            if is_private_ip(ip) {
                warn!(
                    "[SFU] объявляю клиентам частный адрес {} (SFU_PUBLIC_IP не задан) — снаружи до него не достучаться: видео звонков будет ждать SFU 12 с и уходить в mesh. Задайте SFU_PUBLIC_IP",
                    ip
                );
            }
            ips.push(ip);
        } else {
            // Адрес исходящего интерфейса бывает адресом VPN-туннеля (utun на macOS):
            // пакеты на него уходят в туннель и до нас не доходят. Для локальной разработки
            // годится петля; на сервере адрес задаётся явно — SFU_PUBLIC_IP.
            warn!("[SFU] адрес исходящего интерфейса недоступен по UDP — объявляю 127.0.0.1; на сервере задайте SFU_PUBLIC_IP");
            ips.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
        }
    }
    let candidates: Vec<SocketAddr> = ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect();
    // ICE-TCP на том же порту — запасной путь для сетей, где UDP закрыт (корпоративные
    // сети, часть мобильных операторов и VPN). Клиент сам выбирает UDP, если тот проходит.
    let tcp = match TcpListener::bind(SocketAddr::new(config.bind.ip(), port)) {
        Ok(l) => match l.set_nonblocking(true) {
            Ok(()) => Some(l),
            Err(e) => {
                warn!("[SFU] TCP {}: {} — без запасного пути по TCP", port, e);
                None
            }
        },
        Err(e) => {
            warn!("[SFU] не удалось занять TCP {}: {} — без запасного пути по TCP", port, e);
            None
        }
    };
    let transports = Transports {
        // Только для стенда: объявлять один TCP, как в сети с закрытым UDP.
        udp: std::env::var("SFU_TEST_TCP_ONLY").map(|v| v != "1").unwrap_or(true),
        tcp: tcp.is_some(),
    };
    info!(
        "[SFU] UDP {} , TCP {} , кандидаты для клиентов: {:?}",
        config.bind,
        if transports.tcp { "есть" } else { "нет" },
        candidates
    );
    if !transports.udp {
        warn!("[SFU] SFU_TEST_TCP_ONLY=1: UDP-кандидаты не объявляются — только для стенда");
    }

    str0m::crypto::from_feature_flags().install_process_default();

    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("zali-sfu".to_string())
        .spawn(move || {
            let mut engine = Engine::new(socket, tcp, transports, candidates, out);
            engine.run(rx);
        });
    if let Err(e) = spawned {
        warn!("[SFU] не удалось запустить поток: {}", e);
        return None;
    }
    Some(SfuHandle {
        tx: std::sync::Mutex::new(tx),
    })
}

/// UDP-сокет с большими буферами. 4K60 — до 40 Мбит/с на одного публикующего, а его
/// ключевой кадр (1–3 МБ) прилетает пачкой: с системным буфером в ~200 КБ хвост кадра
/// теряется в ядре, и зрители ждут повтор или новый ключевой кадр.
fn bind_udp(addr: SocketAddr) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol as SockProto, Socket, Type};
    let socket = Socket::new(Domain::for_address(addr), Type::DGRAM, Some(SockProto::UDP))?;
    for size in [16 << 20, 8 << 20, 4 << 20] {
        if socket.set_recv_buffer_size(size).is_ok() {
            break;
        }
    }
    for size in [16 << 20, 8 << 20, 4 << 20] {
        if socket.set_send_buffer_size(size).is_ok() {
            break;
        }
    }
    socket.bind(&addr.into())?;
    info!(
        "[SFU] UDP-буферы: приём {} КБ, отправка {} КБ (на Linux потолок — net.core.rmem_max/wmem_max)",
        socket.recv_buffer_size().unwrap_or(0) / 1024,
        socket.send_buffer_size().unwrap_or(0) / 1024
    );
    Ok(socket.into())
}

/// Доходит ли UDP-пакет, посланный самому себе на этот адрес. Отсекает адреса
/// point-to-point туннелей, которые выглядят локальными, но петлёй не работают.
fn udp_self_reachable(ip: IpAddr) -> bool {
    let Ok(rx) = UdpSocket::bind(SocketAddr::new(ip, 0)) else {
        return false;
    };
    let Ok(addr) = rx.local_addr() else {
        return false;
    };
    let _ = rx.set_read_timeout(Some(Duration::from_millis(300)));
    let Ok(tx) = UdpSocket::bind(SocketAddr::new(ip, 0)) else {
        return false;
    };
    if tx.send_to(b"zali-sfu-probe", addr).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    matches!(rx.recv_from(&mut buf), Ok((n, _)) if &buf[..n] == b"zali-sfu-probe")
}

/// Адрес интерфейса, через который уходит трафик наружу. `connect` у UDP пакетов не
/// шлёт — только выбирает маршрут.
/// Ключ потока зрителя для человека (msid — токен до 64 символов, имя туда как есть не
/// годится): FNV-1a, стабилен между сессиями и перезапусками.
fn user_stream_key(user: &str) -> u64 {
    user.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// Частный, локальный или CGNAT-адрес — клиентам из интернета он недоступен.
fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || (o[0] == 100 && (o[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            let s = v6.segments()[0];
            v6.is_loopback() || (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80
        }
    }
}

fn outbound_ip() -> Option<IpAddr> {
    let probe = UdpSocket::bind("0.0.0.0:0").ok()?;
    probe.connect("8.8.8.8:53").ok()?;
    let ip = probe.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

// ============================================================
// Движок
// ============================================================

type SessionId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Publish,
    Subscribe,
}

/// Слой simulcast у публикующего: сколько он сейчас реально шлёт.
#[derive(Debug, Default)]
struct LayerStat {
    bytes: u64,
    window_start: Option<Instant>,
    /// Сглаженный битрейт, бит/с.
    bitrate: f64,
    /// Пик битрейта с плавным спадом (полураспад ~4 с) — по нему слою выбирают зрителя.
    peak: f64,
    last_seen: Option<Instant>,
    /// Кадров и разрывов RTP (кадр без предшественника) с прошлого отчёта.
    frames: u64,
    gaps: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrackState {
    ToOpen,
    Negotiating(Mid),
    Open(Mid),
    ToStop(Mid),
    NegotiatingStop(Mid),
}

/// Дорожка, которую сервер шлёт зрителю.
#[derive(Debug)]
struct OutTrack {
    src_session: SessionId,
    src_user: String,
    src_mid: Mid,
    kind: MediaKind,
    source: SourceKind,
    state: TrackState,
    /// Слой, который сейчас уходит зрителю (None — слоёв нет или ещё не выбран).
    rid: Option<Rid>,
    /// Слой, на который хотим перейти (переход — на его ключевом кадре).
    target_rid: Option<Rid>,
    /// Ждём ключевой кадр, прежде чем слать что-либо (новая дорожка / новый слой).
    started: bool,
    ts_offset: i128,
    last_out: Option<(u64, Instant)>,
    last_switch: Option<Instant>,
    /// С какого момента текущий слой не помещается в оценку канала зрителя.
    over_budget_since: Option<Instant>,
    codec_mismatch_logged: bool,
}

impl OutTrack {
    fn mid(&self) -> Option<Mid> {
        match self.state {
            TrackState::ToOpen => None,
            TrackState::Negotiating(m)
            | TrackState::Open(m)
            | TrackState::ToStop(m)
            | TrackState::NegotiatingStop(m) => Some(m),
        }
    }
}

struct Session {
    id: SessionId,
    room: String,
    user: String,
    device: String,
    role: Role,
    rtc: Rtc,
    created_at: Instant,
    connected: bool,
    disconnected_since: Option<Instant>,
    // --- публикация ---
    sources: HashMap<Mid, SourceKind>,
    layers: HashMap<(Mid, Option<Rid>), LayerStat>,
    layer_pixels: HashMap<(Mid, Option<Rid>), u64>,
    keyframe_asked: HashMap<(Mid, Option<Rid>), Instant>,
    // --- подписка ---
    tracks: Vec<OutTrack>,
    pending: Option<(SdpPendingOffer, Instant, u64)>,
    rev: u64,
    /// Постоянная первая m-линия подписки (канал данных) согласована. Она держит
    /// BUNDLE-тег: если тег у медиа-линии, её остановка (собеседник выключил камеру)
    /// сносит у браузера общий транспорт — подписка рвалась целиком, — а оффер, где
    /// остановлены все линии, Chrome отвергает («no BUNDLE group»).
    anchor_negotiated: bool,
    max_pixel_rate: u64,
    estimate: Option<Bitrate>,
    /// Доля потерь у зрителя из его RTCP RR (максимум по дорожкам за последнюю секунду).
    loss: f32,
    loss_at: Option<Instant>,
    /// Пробы канала (см. tick): когда следующая, текущий шаг отступа, оценка до пробы.
    probe_next: Instant,
    probe_backoff: Duration,
    probe_before: Option<f64>,
    last_allocated: f64,
    /// Пробный переход вверх: до какого момента, при каких потерях начат, сколько требует.
    trial: Option<(Instant, f32, f64)>,
    /// Скорость, подтверждённая пробным переходом (потери при ней не выросли): нижняя
    /// граница оценки, пока потери и delay-based оценка не скажут обратное.
    proven_floor: f64,
    /// Медленное среднее потерь — их «фон» на этом канале.
    loss_slow: f32,
    /// PLI от зрителя за последние секунды: каждый — кадр, который не восстановили
    /// повторы. Прямее процента потерь говорит, что текущий слой этому каналу не по силам.
    viewer_plis: VecDeque<Instant>,
    /// До какого момента рост запрещён после серии PLI, и текущая длина паузы (растёт с
    /// каждой серией: 10 → 20 → 40 → 60 с; минута без серий — снова 10).
    pli_penalty_until: Option<Instant>,
    pli_penalty: Duration,
    last_report: Instant,
    /// Всё, что пришло от клиента с прошлого отчёта (кадры, повторы, паддинг, RTCP): у
    /// издателя сильно больше суммы слоёв — он шлёт паддинг (так нашли 50 Мбит/с мусора с
    /// Windows, 2026-11-24).
    rx_bytes: u64,
    /// Отправлено клиенту с прошлого отчёта по UDP и по TCP: в отчёте зрителя — `via=`.
    /// Зритель, ушедший на ICE-TCP, получает видео с задержкой очереди TCP (секунды на
    /// Wi-Fi) — так и выглядел «пинг 2–3 с» (2026-11-24).
    tx_udp: u64,
    tx_tcp: u64,
    /// Когда от клиента последний раз пришёл UDP (см. `UDP_STICKY`).
    last_udp_rx: Option<Instant>,
}

impl Session {
    fn new(id: SessionId, room: &str, user: &str, device: &str, role: Role, candidates: &[SocketAddr], transports: Transports) -> Self {
        let now = Instant::now();
        let mut builder = Rtc::builder()
            .set_ice_lite(true)
            // H.264 — первым: его аппаратно кодируют и декодируют все наши движки
            // (VideoToolbox, MediaCodec, Media Foundation). Opus — звук экрана.
            .clear_codecs()
            .enable_h264(true)
            .enable_vp8(true)
            // Лучше H.264 на бит — но только если и отправитель кодирует, и ВСЕ зрители
            // декодируют их аппаратно: кодек выбирает клиент по спискам участников
            // (voiceSfuChooseCodec), здесь — лишь умение их пересылать.
            .enable_av1(true)
            .enable_h265(true)
            .enable_vp9(true)
            .enable_opus(true, false)
            // Пересылка повторов (NACK) зрителю идёт из этого буфера: экран 4K60 на 40 Мбит/с
            // при RTT 200 мс — ~850 пакетов в полёте плюс ключевой кадр в ~2500 пакетов;
            // умолчания (1000) мало.
            .set_send_buffer_video(8000)
            // Ожидание недостающего пакета (повтор по NACK, перестановка на Wi-Fi) перед тем,
            // как выпустить кадр с дырой. Документация str0m говорит «пакетов», но в 0.25 код
            // считает готовые кадры за дырой, а для видео главный ограничитель — срок
            // восстановления (попытки NACK + 3 RTT). Большое число просто отдаёт решение сроку;
            // при умолчании 30 кадр с дырой выходил раньше, чем успевал повтор.
            .set_reordering_size_video(4000);
        if role == Role::Subscribe {
            // Своя оценка канала у каждого зрителя: по ней выбирается слой simulcast.
            // Старт как у mesh (x-google-start-bitrate 2500): первый выбор слоя сразу
            // приличный, а не 180p на полминуты. Перелёт оценка срежет за секунду.
            builder = builder
                .enable_bwe(Some(Bitrate::kbps(2500)))
                // Потери у зрителя (RTCP RR) — второй сигнал рядом с оценкой: оценка в str0m
                // может застыть (см. пробы в tick), а потери видны всегда.
                .set_stats_interval(Some(Duration::from_secs(1)));
        }
        let mut rtc = builder.build(now);
        for addr in candidates {
            if transports.udp {
                match Candidate::host(*addr, "udp") {
                    Ok(c) => {
                        rtc.add_local_candidate(c);
                    }
                    Err(e) => warn!("[SFU] плохой кандидат {}: {:?}", addr, e),
                }
            }
            if transports.tcp {
                // Пассивный: соединение открывает клиент (Chrome объявляет tcptype active).
                match Candidate::builder().tcp().host(*addr).tcptype(TcpType::Passive).build() {
                    Ok(c) => {
                        rtc.add_local_candidate(c);
                    }
                    Err(e) => warn!("[SFU] плохой TCP-кандидат {}: {:?}", addr, e),
                }
            }
        }
        Self {
            id,
            room: room.to_string(),
            user: user.to_string(),
            device: device.to_string(),
            role,
            rtc,
            created_at: now,
            connected: false,
            disconnected_since: None,
            sources: HashMap::new(),
            layers: HashMap::new(),
            layer_pixels: HashMap::new(),
            keyframe_asked: HashMap::new(),
            tracks: Vec::new(),
            pending: None,
            rev: 0,
            anchor_negotiated: false,
            max_pixel_rate: 0,
            estimate: None,
            loss: 0.0,
            loss_at: None,
            probe_next: now + Duration::from_secs(3),
            probe_backoff: Duration::from_secs(3),
            probe_before: None,
            last_allocated: 0.0,
            trial: None,
            proven_floor: 0.0,
            loss_slow: 0.0,
            viewer_plis: VecDeque::new(),
            pli_penalty_until: None,
            pli_penalty: Duration::from_secs(10),
            last_report: now,
            rx_bytes: 0,
            tx_udp: 0,
            tx_tcp: 0,
            last_udp_rx: None,
        }
    }

    /// Просит у публикующего ключевой кадр слоя.
    ///
    /// Каждый ключевой кадр весит как десятки обычных и бьёт по ВСЕМ зрителям этого слоя,
    /// поэтому запросы склеиваются: PLI зрителей и разрывы RTP — не чаще раза в секунду на
    /// слой источника (`urgent = false`); новый зритель и смена слоя, где без ключевого кадра
    /// картинки нет вовсе, — не чаще раза в 300 мс (`urgent = true`).
    fn ask_keyframe(&mut self, mid: Mid, rid: Option<Rid>, urgent: bool) {
        let now = Instant::now();
        let gap = if urgent { Duration::from_millis(300) } else { Duration::from_millis(1000) };
        if let Some(at) = self.keyframe_asked.get(&(mid, rid)) {
            if now.duration_since(*at) < gap {
                return;
            }
        }
        let Some(mut writer) = self.rtc.writer(mid) else {
            return;
        };
        if let Err(e) = writer.request_keyframe(rid, KeyframeRequestKind::Pli) {
            debug!("[SFU] keyframe request mid={} rid={:?}: {:?}", mid, rid, e);
        }
        self.keyframe_asked.insert((mid, rid), now);
    }
}

#[derive(Default)]
struct Member {
    device: String,
    publisher: Option<SessionId>,
    /// Издатель нативной оболочки (экран мимо WebView), см. `SfuCommand::Publish::native`.
    native_publisher: Option<SessionId>,
    subscriber: Option<SessionId>,
    wants_subscribe: bool,
    max_pixel_rate: u64,
    /// Чьи демонстрации экрана этот зритель смотрит (см. `SfuCommand::Watch`). Камеры
    /// не в счёт — они приходят всегда.
    watching: HashSet<String>,
    /// Зритель просит экран явно (см. `SfuCommand::Join::watch_gating`).
    gating: bool,
}

#[derive(Default)]
struct Room {
    members: HashMap<String, Member>,
}

enum Propagated {
    Media(SessionId, MediaData),
    KeyframeRequest(SessionId, Mid),
    Estimate(SessionId, Bitrate),
}

/// Какие host-кандидаты объявлять клиентам.
#[derive(Debug, Clone, Copy)]
struct Transports {
    udp: bool,
    tcp: bool,
}

/// Соединение ICE-TCP (RFC 6544): пакеты в потоке — с 2-байтной длиной впереди (RFC 4571).
struct TcpConn {
    stream: TcpStream,
    rbuf: Vec<u8>,
    wbuf: Vec<u8>,
    /// Сколько байт `wbuf` уже записано в сокет.
    wpos: usize,
    last_rx: Instant,
    opened: Instant,
    /// Хоть один пакет соединения принят сессией (STUN с ufrag/паролем из её SDP). До этого
    /// соединение — чужое: ему отведено `TCP_AUTH_DEADLINE`, первый же чужой пакет его рвёт.
    authed: bool,
}

/// Очередь на отправку одному клиенту по TCP. Сверх неё пакеты выбрасываются целиком —
/// для оценки канала это потеря, как на UDP; длиннее очередь — только задержка (2 МБ —
/// ~0,4 с на 40 Мбит/с).
const TCP_WBUF_MAX: usize = 2 << 20;
/// Сколько после последнего UDP-пакета клиента его ICE-TCP игнорируется (см. `handle_packet_proto`).
const UDP_STICKY: Duration = Duration::from_secs(3);
/// Соединений одновременно (сканеры портов не должны съесть память).
const TCP_MAX_CONNS: usize = 512;
/// Молчащее соединение закрываем: живой клиент шлёт STUN-проверки раз в секунды.
const TCP_IDLE: Duration = Duration::from_secs(30);
/// Неопознанному соединению — столько на первую проверку ICE, иначе вон. Без этого
/// 512 соединений по байту раз в 20 с навсегда занимали пул (`TCP_IDLE` их не трогал).
const TCP_AUTH_DEADLINE: Duration = Duration::from_secs(5);
/// Неопознанных соединений с одного IP одновременно. За общим NAT/прокси у всех клиентов
/// один адрес, а каждый клиент открывает по соединению на публикацию и на подписку —
/// потолок с запасом на целую комнату (общий пул ограничен `TCP_MAX_CONNS`).
const TCP_UNAUTHED_PER_IP: usize = 32;

impl TcpConn {
    /// Дописывает очередь в сокет; `false` — соединение мертво.
    fn flush(&mut self) -> bool {
        while self.wpos < self.wbuf.len() {
            match self.stream.write(&self.wbuf[self.wpos..]) {
                Ok(0) => return false,
                Ok(n) => self.wpos += n,
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return false,
            }
        }
        if self.wpos == self.wbuf.len() {
            self.wbuf.clear();
            self.wpos = 0;
        } else if self.wpos > self.wbuf.len() / 2 {
            self.wbuf.drain(..self.wpos);
            self.wpos = 0;
        }
        true
    }
}

struct Engine {
    socket: UdpSocket,
    local_addr: SocketAddr,
    tcp: Option<TcpListener>,
    tcp_conns: HashMap<SocketAddr, TcpConn>,
    transports: Transports,
    candidates: Vec<SocketAddr>,
    sessions: Vec<Session>,
    rooms: HashMap<String, Room>,
    out: tokio::sync::mpsc::UnboundedSender<SfuOut>,
    next_id: SessionId,
    last_tick: Instant,
    unmatched: u64,
    /// Только для стенда: доля пакетов, которые сервер выбрасывает сам — на входе
    /// (отправитель → сервер) и на выходе (сервер → зритель), у подключённых сессий.
    /// `SFU_TEST_LOSS_IN` / `SFU_TEST_LOSS_OUT` в процентах; на проде не задавать.
    test_loss_in: f64,
    test_loss_out: f64,
    /// Только для стенда: задержка всего, что сервер шлёт издателям (`SFU_TEST_DELAY_TO_PUB_MS`) —
    /// так NACK и повтор по нему идут с RTT, как по Wi-Fi, а не мгновенно, как на loopback.
    test_delay_to_pub: Duration,
    delayed_to_pub: VecDeque<(Instant, SocketAddr, Vec<u8>)>,
    /// Только для стенда: паузы эфира, как у Wi-Fi Mac (~70 мс раз в 0,5 с, AWDL) —
    /// `SFU_TEST_STALL=70/520/256` (мс паузы / период, мс / буфер точки доступа, КБ). В паузу
    /// пакеты от издателей копятся (сверх буфера — выбрасываются, как из переполненной очереди
    /// точки доступа) и приходят пачкой в её конце, пакеты издателям ждут её конца.
    test_stall: Option<(Duration, Duration, usize)>,
    stall_epoch: Instant,
    stalled_in: VecDeque<(Vec<u8>, SocketAddr)>,
    stalled_in_bytes: usize,
    stalled_in_dropped: u64,
    /// `SFU_TEST_STALL_VIEWERS=1` — паузы только на отправке зрителям (показывающий на той же
    /// машине, что сервер, — его путь через loopback, зритель за Wi-Fi).
    test_stall_viewers: bool,
    stalled_out_until: Option<Instant>,
    stalled_out_bytes: usize,
    stalled_out_dropped: u64,
    stalled_out_held: u64,
    stall_report_at: Instant,
    viewer_tx_total: u64,
    viewer_tx_tcp: u64,
    delayed_tcp: VecDeque<(Instant, SocketAddr, Vec<u8>)>,
}

/// Во сколько раз слой должен быть меньше свободной оценки, чтобы на него перейти вверх.
/// Небольшой: пока зритель на слое меньше канала, оценка str0m упирается в ~1,5× фактического
/// трафика и с запасом 1,1 × (0,95 оценки) переход на 1080p60 (≈9 Мбит/с) не наступал никогда
/// (прогон 2026-11-22: проба подняла оценку до 9,45, требовалось 10,5). После перехода оценку
/// ведёт уже настоящий трафик, перелёт ловят понижение с выдержкой и потери.
const UPGRADE_MARGIN: f64 = 1.03;

/// Ранжирование слоёв: q < h < f (так их называет клиент); прочее — по битрейту.
fn layer_rank(rid: Option<Rid>) -> u8 {
    match rid.as_deref() {
        None => 1,
        Some("q") => 0,
        Some("h") => 1,
        Some("f") => 2,
        Some(_) => 1,
    }
}

fn test_loss_env(key: &str) -> f64 {
    let pct = std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 50.0);
    if pct > 0.0 {
        warn!("[SFU] ТЕСТОВЫЕ ПОТЕРИ {}={}% — сервер сам выбрасывает пакеты; не для прода", key, pct);
    }
    pct / 100.0
}

fn test_delay_env(key: &str) -> Duration {
    let ms = std::env::var(key).ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0).min(1000);
    if ms > 0 {
        warn!("[SFU] ТЕСТОВАЯ ЗАДЕРЖКА {}={} мс — пакеты издателям уходят с опозданием; не для прода", key, ms);
    }
    Duration::from_millis(ms)
}

fn test_stall_env() -> Option<(Duration, Duration, usize)> {
    let raw = std::env::var("SFU_TEST_STALL").ok()?;
    let v: Vec<u64> = raw.split('/').filter_map(|p| p.trim().parse().ok()).collect();
    let (stall, every) = (*v.first()?, *v.get(1)?);
    let buf_kb = v.get(2).copied().unwrap_or(256);
    if stall == 0 || every <= stall || every > 10_000 {
        return None;
    }
    warn!(
        "[SFU] ТЕСТОВЫЕ ПАУЗЫ ЭФИРА SFU_TEST_STALL: {} мс каждые {} мс, буфер {} КБ — не для прода",
        stall, every, buf_kb
    );
    Some((Duration::from_millis(stall), Duration::from_millis(every), (buf_kb as usize) << 10))
}

/// PT, с которым кадр уходит зрителю, — только из тех, что зритель принял в ответе.
///
/// `Writer::match_params` ищет по всей конфигурации кодеков сервера, а не по ответу
/// зрителя. Издатель шлёт H.264 с профилем 42001f (Baseline; Chrome, Windows/Mac-ядро),
/// WebKit из всех H.264 принимает только 42e01f — и получал PT, которого не согласовывал:
/// пакеты шли, `codec` пустой, 0 кадров (Mac-зритель, 2026-11-22). Профиль в fmtp
/// декодеры не проверяют, поэтому при несовпадении — тот же кодек с тем же
/// packetization-mode (без FU-A большой кадр не собрать).
fn viewer_pt(writer: &str0m::media::Writer, params: str0m::format::PayloadParams) -> Option<str0m::media::Pt> {
    let mut accepted = writer.payload_params();
    if let Some(pt) = writer.match_params(params) {
        if writer.payload_params().any(|p| p.pt() == pt) {
            return Some(pt);
        }
    }
    let want = params.spec();
    accepted
        .find(|p| {
            let s = p.spec();
            s.codec == want.codec && s.format.packetization_mode == want.format.packetization_mode
        })
        .map(|p| p.pt())
}

/// Каким транспортом шёл трафик к клиенту за окно отчёта.
fn via_label(udp: u64, tcp: u64) -> String {
    match (udp, tcp) {
        (0, 0) => "-".to_string(),
        (_, 0) => "udp".to_string(),
        (0, _) => "tcp".to_string(),
        (u, t) => format!("udp+tcp({}%tcp)", t * 100 / (u + t)),
    }
}

fn is_keyframe(data: &MediaData) -> bool {
    match &data.codec_extra {
        CodecExtra::H264(x) => x.is_keyframe,
        CodecExtra::Vp8(x) => x.is_keyframe,
        CodecExtra::Vp9(x) => x.is_keyframe,
        CodecExtra::Av1(x) => x.is_keyframe,
        CodecExtra::H265(x) => x.is_keyframe,
        _ => false,
    }
}

impl Engine {
    fn new(
        socket: UdpSocket,
        tcp: Option<TcpListener>,
        transports: Transports,
        candidates: Vec<SocketAddr>,
        out: tokio::sync::mpsc::UnboundedSender<SfuOut>,
    ) -> Self {
        let local_addr = socket.local_addr().expect("local addr of SFU socket");
        Self {
            socket,
            local_addr,
            tcp,
            tcp_conns: HashMap::new(),
            transports,
            candidates,
            sessions: Vec::new(),
            rooms: HashMap::new(),
            out,
            next_id: 1,
            last_tick: Instant::now(),
            unmatched: 0,
            test_loss_in: test_loss_env("SFU_TEST_LOSS_IN"),
            test_loss_out: test_loss_env("SFU_TEST_LOSS_OUT"),
            test_delay_to_pub: test_delay_env("SFU_TEST_DELAY_TO_PUB_MS"),
            delayed_to_pub: VecDeque::new(),
            test_stall: test_stall_env(),
            stall_epoch: Instant::now(),
            stalled_in: VecDeque::new(),
            stalled_in_bytes: 0,
            stalled_in_dropped: 0,
            test_stall_viewers: std::env::var("SFU_TEST_STALL_VIEWERS").is_ok_and(|v| v == "1"),
            stalled_out_until: None,
            stalled_out_bytes: 0,
            stalled_out_dropped: 0,
            stalled_out_held: 0,
            stall_report_at: Instant::now(),
            viewer_tx_total: 0,
            viewer_tx_tcp: 0,
            delayed_tcp: VecDeque::new(),
        }
    }

    /// Только для стенда: конец текущей паузы эфира (`SFU_TEST_STALL`), если она идёт.
    fn stall_end(&self, now: Instant) -> Option<Instant> {
        let (stall, every, _) = self.test_stall?;
        let phase = now.duration_since(self.stall_epoch).as_nanos() % every.as_nanos();
        let phase = Duration::from_nanos(phase as u64);
        (phase < stall).then(|| now + (stall - phase))
    }

    fn send(&self, user: &str, device: &str, payload: serde_json::Value) {
        let _ = self.out.send(SfuOut {
            user: user.to_string(),
            device: device.to_string(),
            payload,
        });
    }

    fn session_index(&self, id: SessionId) -> Option<usize> {
        self.sessions.iter().position(|s| s.id == id)
    }

    fn run(&mut self, rx: Receiver<SfuCommand>) {
        let mut buf = vec![0u8; 2000];
        let mut queue: VecDeque<Propagated> = VecDeque::new();
        loop {
            // Нет ни одной сессии — спим на очереди команд, а не крутим сокет.
            if self.sessions.is_empty() {
                match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(cmd) => self.handle_command(cmd),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                // Пакеты, пришедшие без сессий, выбрасываем, чтобы не копились.
                let _ = self.socket.set_nonblocking(true);
                while self.socket.recv_from(&mut buf).is_ok() {}
                let _ = self.socket.set_nonblocking(false);
                self.tcp_conns.clear();
                if let Some(l) = &self.tcp {
                    while l.accept().is_ok() {}
                }
                continue;
            }
            loop {
                match rx.try_recv() {
                    Ok(cmd) => self.handle_command(cmd),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            self.negotiate_subscribers();

            let mut timeout = Instant::now() + Duration::from_millis(20);
            for i in 0..self.sessions.len() {
                let t = self.poll_session(i, &mut queue);
                timeout = timeout.min(t);
            }
            while let Some(p) = queue.pop_front() {
                self.propagate(p);
            }
            // Пересылка могла добавить вывод (пакеты зрителям) — отдаём сразу.
            for i in 0..self.sessions.len() {
                let t = self.poll_session(i, &mut queue);
                timeout = timeout.min(t);
            }
            while let Some(p) = queue.pop_front() {
                self.propagate(p);
            }

            while self.delayed_to_pub.front().is_some_and(|(at, _, _)| *at <= Instant::now()) {
                let (_, dest, data) = self.delayed_to_pub.pop_front().expect("front exists");
                let _ = self.socket.send_to(&data, dest);
            }
            if let Some((at, _, _)) = self.delayed_to_pub.front() {
                timeout = timeout.min(*at);
            }
            while self.delayed_tcp.front().is_some_and(|(at, _, _)| *at <= Instant::now()) {
                let (_, dest, data) = self.delayed_tcp.pop_front().expect("front exists");
                self.tcp_send(dest, &data);
            }
            if let Some((at, _, _)) = self.delayed_tcp.front() {
                timeout = timeout.min(*at);
            }
            // Стенд: пауза эфира кончилась — накопленное приходит пачкой, как с точки доступа.
            if !self.stalled_in.is_empty() {
                match self.stall_end(Instant::now()) {
                    Some(end) => timeout = timeout.min(end),
                    None => {
                        let held = std::mem::take(&mut self.stalled_in);
                        self.stalled_in_bytes = 0;
                        for (data, source) in held {
                            self.handle_packet(&data, source);
                        }
                        timeout = Instant::now();
                    }
                }
            }
            let mut wait = timeout
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1));
            // Ждём на UDP-сокете; TCP его не будит, поэтому при живых TCP-соединениях
            // ожидание короткое.
            if !self.tcp_conns.is_empty() {
                wait = wait.min(Duration::from_millis(2));
            }
            let _ = self.socket.set_read_timeout(Some(wait));
            match self.socket.recv_from(&mut buf) {
                Ok((n, source)) => self.handle_packet(&buf[..n], source),
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(e) => {
                    // ICMP «порт недоступен» от ушедшего клиента приходит сюда на
                    // некоторых ОС — это не повод останавливать SFU.
                    debug!("[SFU] recv_from: {}", e);
                }
            }
            // Дочитываем то, что уже лежит в сокете, без ожидания: на 8 Мбит/с пакеты
            // идут чаще, чем раз в миллисекунду.
            let _ = self.socket.set_nonblocking(true);
            for _ in 0..256 {
                match self.socket.recv_from(&mut buf) {
                    Ok((n, source)) => self.handle_packet(&buf[..n], source),
                    Err(_) => break,
                }
            }
            let _ = self.socket.set_nonblocking(false);
            self.service_tcp();

            let now = Instant::now();
            for s in &mut self.sessions {
                if s.rtc.is_alive() {
                    let _ = s.rtc.handle_input(Input::Timeout(now));
                }
            }
            if now.duration_since(self.last_tick) >= Duration::from_millis(500) {
                self.last_tick = now;
                self.tick(now);
            }
        }
    }

    fn handle_packet(&mut self, data: &[u8], source: SocketAddr) {
        self.handle_packet_proto(data, source, Protocol::Udp);
    }

    /// Принимает новые TCP-соединения, читает пакеты из потока, дописывает очереди.
    fn service_tcp(&mut self) {
        let now = Instant::now();
        if let Some(l) = &self.tcp {
            loop {
                match l.accept() {
                    Ok((stream, peer)) => {
                        let unauthed_here =
                            self.tcp_conns.iter().filter(|(a, c)| !c.authed && a.ip() == peer.ip()).count();
                        if unauthed_here >= TCP_UNAUTHED_PER_IP {
                            continue;
                        }
                        if self.tcp_conns.len() >= TCP_MAX_CONNS {
                            // Пул полон: место уступает самое старое неопознанное — живой
                            // клиент не должен ждать, пока чужие отвалятся сами.
                            let victim = self
                                .tcp_conns
                                .iter()
                                .filter(|(_, c)| !c.authed)
                                .min_by_key(|(_, c)| c.opened)
                                .map(|(a, _)| *a);
                            match victim {
                                Some(a) => {
                                    self.tcp_conns.remove(&a);
                                }
                                None => continue,
                            }
                        }
                        if stream.set_nonblocking(true).is_err() {
                            continue;
                        }
                        let _ = stream.set_nodelay(true);
                        debug!("[SFU] TCP-соединение от {}", peer);
                        self.tcp_conns.insert(
                            peer,
                            TcpConn {
                                stream,
                                rbuf: Vec::new(),
                                wbuf: Vec::new(),
                                wpos: 0,
                                last_rx: now,
                                opened: now,
                                authed: false,
                            },
                        );
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }
        if self.tcp_conns.is_empty() {
            return;
        }
        let mut frames: Vec<(SocketAddr, Vec<u8>)> = Vec::new();
        let mut dead: Vec<SocketAddr> = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        for (peer, c) in self.tcp_conns.iter_mut() {
            let mut alive = true;
            loop {
                match c.stream.read(&mut buf) {
                    Ok(0) => {
                        alive = false;
                        break;
                    }
                    Ok(n) => {
                        c.rbuf.extend_from_slice(&buf[..n]);
                        c.last_rx = now;
                        if c.rbuf.len() > 1 << 20 {
                            alive = false;
                            break;
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => {
                        alive = false;
                        break;
                    }
                }
            }
            let mut off = 0;
            while c.rbuf.len() - off >= 2 {
                let len = u16::from_be_bytes([c.rbuf[off], c.rbuf[off + 1]]) as usize;
                if c.rbuf.len() - off - 2 < len {
                    break;
                }
                frames.push((*peer, c.rbuf[off + 2..off + 2 + len].to_vec()));
                off += 2 + len;
            }
            if off > 0 {
                c.rbuf.drain(..off);
            }
            let unauthed_late = !c.authed && now.duration_since(c.opened) > TCP_AUTH_DEADLINE;
            if !alive || !c.flush() || now.duration_since(c.last_rx) > TCP_IDLE || unauthed_late {
                dead.push(*peer);
            }
        }
        for peer in dead {
            debug!("[SFU] TCP-соединение {} закрыто", peer);
            self.tcp_conns.remove(&peer);
        }
        for (peer, frame) in frames {
            let Some(authed) = self.tcp_conns.get(&peer).map(|c| c.authed) else { continue };
            let matched = self.handle_packet_proto(&frame, peer, Protocol::Tcp);
            if matched && !authed {
                if let Some(c) = self.tcp_conns.get_mut(&peer) {
                    c.authed = true;
                }
            } else if !matched && !authed {
                // Первый пакет не узнала ни одна сессия — это не клиент ICE.
                debug!("[SFU] TCP-соединение {} без сессии — закрыто", peer);
                self.tcp_conns.remove(&peer);
            }
        }
    }

    /// Ставит пакет в очередь TCP-соединения клиента (длина + пакет, RFC 4571).
    fn tcp_send(&mut self, destination: SocketAddr, data: &[u8]) {
        let Some(c) = self.tcp_conns.get_mut(&destination) else {
            return;
        };
        if data.len() > u16::MAX as usize || c.wbuf.len() - c.wpos + data.len() + 2 > TCP_WBUF_MAX {
            return;
        }
        c.wbuf.extend_from_slice(&(data.len() as u16).to_be_bytes());
        c.wbuf.extend_from_slice(data);
        if !c.flush() {
            self.tcp_conns.remove(&destination);
        }
    }

    /// `true` — пакет принят сессией.
    fn handle_packet_proto(&mut self, data: &[u8], source: SocketAddr, proto: Protocol) -> bool {
        let Ok(contents) = data.try_into() else {
            return false;
        };
        // str0m сверяет адрес назначения с объявленным host-кандидатом. Сокет занят на
        // 0.0.0.0, настоящего адреса назначения пакета он не знает (это IP_PKTINFO),
        // поэтому назначение — объявленный кандидат того же семейства. С 0.0.0.0 здесь
        // ни один STUN не проходил и ни одна сессия не подключалась.
        let destination = self
            .candidates
            .iter()
            .find(|c| c.is_ipv4() == source.is_ipv4())
            .copied()
            .unwrap_or(self.local_addr);
        let input = Input::Receive(
            Instant::now(),
            Receive {
                proto,
                source,
                destination,
                contents,
            },
        );
        let loss_in = self.test_loss_in;
        let stall = self
            .test_stall
            .filter(|_| !self.test_stall_viewers)
            .and_then(|(_, _, buf)| self.stall_end(Instant::now()).map(|_| buf));
        if let Some(s) = self.sessions.iter_mut().find(|s| s.rtc.accepts(&input)) {
            if loss_in > 0.0 && s.connected && rand::random::<f64>() < loss_in {
                return true;
            }
            // UDP «липкий»: пока от клиента идёт UDP, его ICE-TCP молча игнорируем — пара TCP
            // не проходит проверки, и браузер не переезжает на неё. Иначе на Wi-Fi с паузами
            // эфира Chrome (зритель Windows) уходил на TCP, а там видео стоит в очереди TCP:
            // секунды задержки, затем догоняющий рывок (стенд SFU_TEST_STALL_VIEWERS,
            // 2026-11-24: без пауз — UDP весь звонок, с паузами — 100 % TCP через ~20 с).
            // Пропал UDP дольше UDP_STICKY — TCP снова отвечает, запасной путь работает.
            let now = Instant::now();
            if proto == Protocol::Tcp {
                if s.last_udp_rx.is_some_and(|t| now.duration_since(t) < UDP_STICKY) {
                    return true;
                }
            } else {
                s.last_udp_rx = Some(now);
            }
            if let (Some(buf), Role::Publish, true) = (stall, s.role, s.connected) {
                if self.stalled_in_bytes + data.len() > buf {
                    self.stalled_in_dropped += 1;
                } else {
                    self.stalled_in_bytes += data.len();
                    self.stalled_in.push_back((data.to_vec(), source));
                }
                return true;
            }
            s.rx_bytes += data.len() as u64;
            if let Err(e) = s.rtc.handle_input(input) {
                warn!("[SFU] session {} ({} {:?}) input error: {:?}", s.id, s.user, s.role, e);
                s.rtc.disconnect();
            }
            true
        } else {
            // Чужой/опоздавший пакет — обычное дело (сессия уже закрыта), но поток таких
            // означает, что клиент стучится в сессию, которой мы его не сопоставили.
            self.unmatched += 1;
            if self.unmatched <= 5 || self.unmatched % 500 == 0 {
                info!(
                    "[SFU] пакет без сессии #{} от {} ({} байт, сессий {})",
                    self.unmatched,
                    source,
                    data.len(),
                    self.sessions.len()
                );
            }
            false
        }
    }

    fn poll_session(&mut self, i: usize, queue: &mut VecDeque<Propagated>) -> Instant {
        // Пейсер str0m выпускает по пакету и сразу просит таймаут «сейчас»; без его
        // обработки здесь следующий пакет ждал прохода цикла, а тот спит на сокете минимум
        // 1 мс — потолок ~1000 пакетов/с ≈ 7,3 Мбит/с на зрителя. Сверх него видео копилось
        // в буфере отправки (8000 пакетов) — до 10 с отставания, оценка канала стояла на
        // 7287 кбит/с (живой Windows → Mac 2026-11-22). Лимит — от зависшего таймера.
        let mut due_spins = 0u32;
        loop {
            let s = &mut self.sessions[i];
            if !s.rtc.is_alive() {
                return Instant::now() + Duration::from_millis(20);
            }
            let output = match s.rtc.poll_output() {
                Ok(o) => o,
                Err(e) => {
                    warn!("[SFU] session {} poll_output: {:?}", s.id, e);
                    s.rtc.disconnect();
                    return Instant::now();
                }
            };
            match output {
                Output::Timeout(t) => {
                    let now = Instant::now();
                    if t <= now && due_spins < 4096 {
                        due_spins += 1;
                        let _ = s.rtc.handle_input(Input::Timeout(now));
                        continue;
                    }
                    return t;
                }
                Output::Transmit(t) => {
                    if self.test_loss_out > 0.0 && self.sessions[i].connected && rand::random::<f64>() < self.test_loss_out {
                        continue;
                    }
                    let to_pub = self.sessions[i].role == Role::Publish;
                    if t.proto == Protocol::Tcp {
                        self.sessions[i].tx_tcp += t.contents.len() as u64;
                    } else {
                        self.sessions[i].tx_udp += t.contents.len() as u64;
                    }
                    let stall_end = if to_pub && !self.test_stall_viewers { self.stall_end(Instant::now()) } else { None };
                    // Стенд: пауза эфира и на пути к зрителю (сервер и показывающий — на одном
                    // Mac, зритель за Wi-Fi). Сверх буфера точки доступа — выброс.
                    if self.test_stall_viewers && !to_pub {
                        self.viewer_tx_total += 1;
                        if t.proto == Protocol::Tcp {
                            self.viewer_tx_tcp += 1;
                        }
                    }
                    let viewer_stall = (self.test_stall_viewers && !to_pub)
                        .then(|| self.stall_end(Instant::now()))
                        .flatten();
                    if let Some(end) = viewer_stall {
                        if self.stalled_out_until != Some(end) {
                            self.stalled_out_until = Some(end);
                            self.stalled_out_bytes = 0;
                        }
                        let buf = self.test_stall.map(|(_, _, b)| b).unwrap_or(0);
                        if t.proto != Protocol::Tcp && self.stalled_out_bytes + t.contents.len() > buf {
                            self.stalled_out_dropped += 1;
                        } else {
                            self.stalled_out_bytes += t.contents.len();
                            self.stalled_out_held += 1;
                            if t.proto == Protocol::Tcp {
                                // TCP не теряет: в паузу копится и уходит после неё.
                                self.delayed_tcp.push_back((end, t.destination, t.contents.to_vec()));
                            } else {
                                self.delayed_to_pub.push_back((end, t.destination, t.contents.to_vec()));
                            }
                        }
                    } else if t.proto == Protocol::Tcp {
                        self.tcp_send(t.destination, &t.contents);
                    } else if to_pub && (!self.test_delay_to_pub.is_zero() || stall_end.is_some()) {
                        let mut at = Instant::now() + self.test_delay_to_pub;
                        if let Some(end) = stall_end {
                            at = at.max(end);
                        }
                        self.delayed_to_pub.push_back((at, t.destination, t.contents.to_vec()));
                    } else if let Err(e) = self.socket.send_to(&t.contents, t.destination) {
                        debug!("[SFU] send_to {}: {}", t.destination, e);
                    }
                }
                Output::Event(event) => {
                    let id = s.id;
                    match event {
                        Event::Connected => {
                            s.connected = true;
                            s.disconnected_since = None;
                            info!(
                                "[SFU] connected session={} user={} role={:?} room={} after {} ms",
                                id,
                                s.user,
                                s.role,
                                s.room,
                                s.created_at.elapsed().as_millis()
                            );
                            if s.role == Role::Subscribe {
                                // Новое соединение зрителя: ключевые кадры всех его дорожек.
                                let wants: Vec<(SessionId, Mid, Option<Rid>)> = s
                                    .tracks
                                    .iter()
                                    .filter(|t| t.kind == MediaKind::Video)
                                    .map(|t| (t.src_session, t.src_mid, t.target_rid.or(t.rid)))
                                    .collect();
                                for (src, mid, rid) in wants {
                                    if let Some(j) = self.session_index(src) {
                                        self.sessions[j].ask_keyframe(mid, rid, true);
                                    }
                                }
                            }
                        }
                        Event::IceConnectionStateChange(state) => {
                            debug!("[SFU] session {} ice {:?}", id, state);
                            match state {
                                IceConnectionState::Disconnected => {
                                    s.disconnected_since.get_or_insert(Instant::now());
                                }
                                IceConnectionState::Connected | IceConnectionState::Completed => {
                                    s.disconnected_since = None;
                                }
                                _ => {}
                            }
                        }
                        Event::MediaAdded(added) => {
                            debug!(
                                "[SFU] media added session={} mid={} kind={:?} dir={:?} simulcast={:?}",
                                id, added.mid, added.kind, added.direction, added.simulcast
                            );
                        }
                        Event::MediaData(data) => queue.push_back(Propagated::Media(id, data)),
                        Event::KeyframeRequest(req) => {
                            queue.push_back(Propagated::KeyframeRequest(id, req.mid))
                        }
                        Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                            queue.push_back(Propagated::Estimate(id, estimate))
                        }
                        Event::EgressBitrateEstimate(BweKind::Remb { estimate, .. }) => {
                            queue.push_back(Propagated::Estimate(id, estimate))
                        }
                        Event::MediaEgressStats(st) => {
                            if let Some(loss) = st.loss {
                                let now = Instant::now();
                                let fresh = s.loss_at.is_some_and(|at| now.duration_since(at) < Duration::from_millis(900));
                                s.loss = if fresh { s.loss.max(loss) } else { loss };
                                s.loss_at = Some(now);
                            }
                        }
                        Event::Closed => {
                            info!("[SFU] session {} closed by peer", id);
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    // ---------------- команды ----------------

    fn handle_command(&mut self, cmd: SfuCommand) {
        match cmd {
            SfuCommand::Publish {
                room,
                user,
                device,
                sdp,
                sources,
                layers,
                native,
                fresh,
            } => self.on_publish(room, user, device, sdp, sources, layers, native, fresh),
            SfuCommand::Unpublish { room, user, native } => {
                let id = self
                    .rooms
                    .get(&room)
                    .and_then(|r| r.members.get(&user))
                    .and_then(|m| if native { m.native_publisher } else { m.publisher });
                if let Some(id) = id {
                    info!("[SFU] unpublish user={} room={} native={}", user, room, native);
                    self.drop_session(id, false);
                }
            }
            SfuCommand::Join {
                room,
                user,
                device,
                reset,
                max_pixel_rate,
                watch_gating,
            } => self.on_join(room, user, device, reset, max_pixel_rate, watch_gating),
            SfuCommand::Answer { room, user, sdp, rev } => self.on_answer(room, user, sdp, rev),
            SfuCommand::Leave { room, user } => self.on_leave(&room, &user),
            SfuCommand::Watch { room, user, device, target, on } => self.on_watch(room, user, device, target, on),
        }
    }

    /// `native` — ошибка слота издателя оболочки: страница отличает её от сбоя своей
    /// публикации (иначе сочла бы SFU недоступным и увела комнату в mesh).
    fn sfu_error(&self, room: &str, user: &str, device: &str, code: &str, message: &str, native: bool) {
        let mut payload = json!({ "type": "voice_sfu_error", "roomId": room, "code": code, "message": message });
        if native {
            payload["slot"] = json!("native");
        }
        self.send(user, device, payload);
    }

    fn on_publish(
        &mut self,
        room: String,
        user: String,
        device: String,
        sdp: String,
        sources: HashMap<String, SourceKind>,
        layers: HashMap<String, HashMap<String, u64>>,
        native: bool,
        fresh: bool,
    ) {
        let offer = match SdpOffer::from_sdp_string(&sdp) {
            Ok(o) => o,
            Err(e) => {
                warn!("[SFU] publish offer parse user={} room={}: {:?}", user, room, e);
                self.sfu_error(&room, &user, &device, "bad_offer", "Не удалось разобрать оффер", native);
                return;
            }
        };
        // Другое устройство того же аккаунта забрало звонок — старые сессии долой.
        let stale = self
            .rooms
            .get(&room)
            .and_then(|r| r.members.get(&user))
            .map(|m| m.device != device)
            .unwrap_or(false);
        if stale {
            self.on_leave(&room, &user);
        }
        let existing = self
            .rooms
            .get(&room)
            .and_then(|r| r.members.get(&user))
            .and_then(|m| if native { m.native_publisher } else { m.publisher })
            .and_then(|id| self.session_index(id))
            .filter(|i| !fresh && self.sessions[*i].rtc.is_alive());
        let idx = match existing {
            Some(i) => i,
            None => {
                let id = self.next_id;
                self.next_id += 1;
                let session = Session::new(id, &room, &user, &device, Role::Publish, &self.candidates, self.transports);
                self.sessions.push(session);
                let member = self.rooms.entry(room.clone()).or_default().members.entry(user.clone()).or_default();
                member.device = device.clone();
                let slot = if native { &mut member.native_publisher } else { &mut member.publisher };
                if let Some(old) = slot.replace(id) {
                    if let Some(i) = self.session_index(old) {
                        self.sessions[i].rtc.disconnect();
                    }
                }
                info!("[SFU] publisher session={} user={} room={} native={}", id, user, room, native);
                self.sessions.len() - 1
            }
        };
        let answer = match self.sessions[idx].rtc.sdp_api().accept_offer(offer) {
            Ok(a) => a,
            Err(e) => {
                warn!("[SFU] publish accept_offer user={} room={}: {:?}", user, room, e);
                self.sfu_error(&room, &user, &device, "bad_offer", "Сервер не принял оффер", native);
                return;
            }
        };
        let session_id = self.sessions[idx].id;
        let new_sources: HashMap<Mid, SourceKind> = sources
            .iter()
            .map(|(mid, kind)| (Mid::from(mid.as_str()), *kind))
            .collect();
        let old_sources = std::mem::replace(&mut self.sessions[idx].sources, new_sources.clone());
        self.sessions[idx].layer_pixels = layers
            .iter()
            .flat_map(|(mid, by_rid)| {
                let mid = Mid::from(mid.as_str());
                by_rid.iter().map(move |(rid, px)| {
                    let rid = (!rid.is_empty() && rid != "-").then(|| Rid::from(rid.as_str()));
                    ((mid, rid), *px)
                })
            })
            .collect();
        info!(
            "[SFU] publish user={} room={} sources={:?}",
            user,
            room,
            new_sources.iter().map(|(m, k)| format!("{}={}", m, k.as_str())).collect::<Vec<_>>()
        );
        self.send(
            &user,
            &device,
            json!({
                "type": "voice_sfu_publish_answer",
                "roomId": room,
                "sdp": answer.to_sdp_string(),
                "session": session_id,
                "slot": if native { "native" } else { "page" },
            }),
        );

        // Пропавшие источники — снять у зрителей, новые — раздать.
        let mut screen_removed = false;
        for (mid, kind) in &old_sources {
            if new_sources.get(mid) != Some(kind) {
                self.stop_source_everywhere(session_id, *mid);
                screen_removed |= Self::is_screen_kind(*kind);
            }
        }
        if screen_removed {
            self.clear_watchers(&room, &user);
        }
        for (mid, kind) in &new_sources {
            if old_sources.get(mid) != Some(kind) {
                self.offer_source_to_room(&room, &user, session_id, *mid, *kind);
            }
        }
    }

    /// Раздаёт новый источник всем в комнате, кто принимает видео.
    fn offer_source_to_room(&mut self, room: &str, src_user: &str, src_session: SessionId, mid: Mid, kind: SourceKind) {
        let viewers: Vec<(String, String)> = self
            .rooms
            .get(room)
            .map(|r| {
                r.members
                    .iter()
                    .filter(|(u, m)| u.as_str() != src_user && m.wants_subscribe)
                    .filter(|(_, m)| Self::viewer_gets(m, src_user, kind))
                    .map(|(u, m)| (u.clone(), m.device.clone()))
                    .collect()
            })
            .unwrap_or_default();
        for (viewer, device) in viewers {
            let idx = self.ensure_subscriber(room, &viewer, &device);
            self.add_out_track(idx, src_session, src_user, mid, kind);
        }
    }

    fn is_screen_kind(kind: SourceKind) -> bool {
        matches!(kind, SourceKind::Screen | SourceKind::ScreenAudio)
    }

    /// Должен ли зритель получать этот источник: камеру — всегда, экран и его звук —
    /// только если он нажал «Смотреть» у этого человека.
    fn viewer_gets(member: &Member, src_user: &str, kind: SourceKind) -> bool {
        !member.gating || !Self::is_screen_kind(kind) || member.watching.contains(src_user)
    }

    fn user_has_screen(&self, room: &str, user: &str) -> bool {
        self.sessions.iter().any(|s| {
            s.role == Role::Publish
                && s.room == room
                && s.user == user
                && s.rtc.is_alive()
                && s.sources.values().any(|k| Self::is_screen_kind(*k))
        })
    }

    /// Демонстрация человека кончилась — зрители забывают, что смотрели: новая будет
    /// снова закрыта до нажатия «Смотреть».
    fn clear_watchers(&mut self, room: &str, user: &str) {
        if self.user_has_screen(room, user) {
            return;
        }
        if let Some(r) = self.rooms.get_mut(room) {
            for m in r.members.values_mut() {
                m.watching.remove(user);
            }
        }
    }

    fn on_watch(&mut self, room: String, user: String, device: String, target: String, on: bool) {
        if target.is_empty() || target == user {
            return;
        }
        let joined = {
            // Запись создаётся и до join: «Смотреть» может дойти раньше него, и выбор
            // не должен пропасть (device совпадает, поэтому join не сочтёт запись чужой).
            let member = self.rooms.entry(room.clone()).or_default().members.entry(user.clone()).or_default();
            if member.device.is_empty() {
                member.device = device.clone();
            }
            member.gating = true;
            if on {
                member.watching.insert(target.clone());
            } else {
                member.watching.remove(&target);
            }
            member.wants_subscribe
        };
        info!("[SFU] watch user={} room={} target={} on={} joined={}", user, room, target, on, joined);
        if on {
            if !joined {
                return; // раздача — в on_join, когда подписка появится
            }
            let sources: Vec<(SessionId, Mid, SourceKind)> = self
                .sessions
                .iter()
                .filter(|s| s.role == Role::Publish && s.room == room && s.user == target && s.rtc.is_alive())
                .flat_map(|s| s.sources.iter().map(move |(m, k)| (s.id, *m, *k)))
                .filter(|(_, _, k)| Self::is_screen_kind(*k))
                .collect();
            if sources.is_empty() {
                return;
            }
            let idx = self.ensure_subscriber(&room, &user, &device);
            for (src, mid, kind) in sources {
                self.add_out_track(idx, src, &target, mid, kind);
            }
        } else {
            let Some(idx) = self
                .rooms
                .get(&room)
                .and_then(|r| r.members.get(&user))
                .and_then(|m| m.subscriber)
                .and_then(|id| self.session_index(id))
            else {
                return;
            };
            let s = &mut self.sessions[idx];
            s.tracks.retain(|t| {
                !(t.src_user == target && Self::is_screen_kind(t.source) && t.state == TrackState::ToOpen)
            });
            for t in &mut s.tracks {
                if t.src_user == target && Self::is_screen_kind(t.source) {
                    if let TrackState::Open(m) | TrackState::Negotiating(m) = t.state {
                        t.state = TrackState::ToStop(m);
                    }
                }
            }
        }
    }

    fn add_out_track(&mut self, idx: usize, src_session: SessionId, src_user: &str, mid: Mid, kind: SourceKind) {
        // Страховка: экран без «Смотреть» не раздаётся ни одним путём.
        if Self::is_screen_kind(kind) {
            let (room, viewer) = (self.sessions[idx].room.clone(), self.sessions[idx].user.clone());
            let watches = self
                .rooms
                .get(&room)
                .and_then(|r| r.members.get(&viewer))
                .map(|m| !m.gating || m.watching.contains(src_user))
                .unwrap_or(true);
            if !watches {
                return;
            }
        }
        let s = &mut self.sessions[idx];
        if s.tracks.iter().any(|t| {
            t.src_session == src_session
                && t.src_mid == mid
                && !matches!(t.state, TrackState::ToStop(_) | TrackState::NegotiatingStop(_))
        }) {
            return;
        }
        s.tracks.push(OutTrack {
            src_session,
            src_user: src_user.to_string(),
            src_mid: mid,
            kind: if kind == SourceKind::ScreenAudio {
                MediaKind::Audio
            } else {
                MediaKind::Video
            },
            source: kind,
            state: TrackState::ToOpen,
            rid: None,
            target_rid: None,
            started: false,
            ts_offset: 0,
            last_out: None,
            last_switch: None,
            over_budget_since: None,
            codec_mismatch_logged: false,
        });
    }

    fn stop_source_everywhere(&mut self, src_session: SessionId, mid: Mid) {
        for s in &mut self.sessions {
            if s.role != Role::Subscribe {
                continue;
            }
            s.tracks.retain(|t| !(t.src_session == src_session && t.src_mid == mid && t.state == TrackState::ToOpen));
            for t in &mut s.tracks {
                if t.src_session == src_session && t.src_mid == mid {
                    // И `Negotiating`: оффер зрителю ушёл, ответа нет — иначе on_answer сделает
                    // её Open, и дальше её никто не остановит (замёрзший кадр). Как drop_session.
                    if let TrackState::Open(m) | TrackState::Negotiating(m) = t.state {
                        t.state = TrackState::ToStop(m);
                    }
                }
            }
        }
    }

    fn ensure_subscriber(&mut self, room: &str, user: &str, device: &str) -> usize {
        let existing = self
            .rooms
            .get(room)
            .and_then(|r| r.members.get(user))
            .and_then(|m| m.subscriber)
            .and_then(|id| self.session_index(id))
            .filter(|i| self.sessions[*i].rtc.is_alive());
        if let Some(i) = existing {
            return i;
        }
        let id = self.next_id;
        self.next_id += 1;
        let session = Session::new(id, room, user, device, Role::Subscribe, &self.candidates, self.transports);
        self.sessions.push(session);
        let member = self
            .rooms
            .entry(room.to_string())
            .or_default()
            .members
            .entry(user.to_string())
            .or_default();
        member.device = device.to_string();
        member.wants_subscribe = true;
        let max_pixel_rate = member.max_pixel_rate;
        if let Some(old) = member.subscriber.replace(id) {
            if let Some(i) = self.session_index(old) {
                self.sessions[i].rtc.disconnect();
            }
        }
        info!("[SFU] subscriber session={} user={} room={}", id, user, room);
        if let Some(s) = self.sessions.last_mut() {
            s.max_pixel_rate = max_pixel_rate;
        }
        self.sessions.len() - 1
    }

    fn on_join(&mut self, room: String, user: String, device: String, reset: bool, max_pixel_rate: u64, watch_gating: bool) {
        let stale = self
            .rooms
            .get(&room)
            .and_then(|r| r.members.get(&user))
            .map(|m| m.device != device)
            .unwrap_or(false);
        if stale {
            self.on_leave(&room, &user);
        }
        if reset {
            if let Some(id) = self.rooms.get_mut(&room).and_then(|r| r.members.get_mut(&user)).and_then(|m| m.subscriber.take()) {
                if let Some(i) = self.session_index(id) {
                    self.sessions[i].rtc.disconnect();
                }
            }
        }
        {
            let member = self.rooms.entry(room.clone()).or_default().members.entry(user.clone()).or_default();
            member.device = device.clone();
            member.wants_subscribe = true;
            member.max_pixel_rate = max_pixel_rate;
            member.gating = member.gating || watch_gating;
        }
        if let Some(sub) = self.rooms.get(&room).and_then(|r| r.members.get(&user)).and_then(|m| m.subscriber) {
            if let Some(i) = self.session_index(sub) {
                self.sessions[i].max_pixel_rate = max_pixel_rate;
            }
        }
        // Всё, что уже публикуют остальные (чужие экраны — только те, что этот зритель смотрит).
        let (gating, watching) = self
            .rooms
            .get(&room)
            .and_then(|r| r.members.get(&user))
            .map(|m| (m.gating, m.watching.clone()))
            .unwrap_or_default();
        let sources: Vec<(SessionId, String, Mid, SourceKind)> = self
            .sessions
            .iter()
            .filter(|s| s.role == Role::Publish && s.room == room && s.user != user && s.rtc.is_alive())
            .flat_map(|s| s.sources.iter().map(move |(m, k)| (s.id, s.user.clone(), *m, *k)))
            .filter(|(_, src_user, _, k)| !gating || !Self::is_screen_kind(*k) || watching.contains(src_user))
            .collect();
        info!("[SFU] join user={} room={} reset={} sources={}", user, room, reset, sources.len());
        if sources.is_empty() {
            return;
        }
        let idx = self.ensure_subscriber(&room, &user, &device);
        for (src, src_user, mid, kind) in sources {
            self.add_out_track(idx, src, &src_user, mid, kind);
        }
    }

    fn on_answer(&mut self, room: String, user: String, sdp: String, rev: u64) {
        let Some(idx) = self
            .rooms
            .get(&room)
            .and_then(|r| r.members.get(&user))
            .and_then(|m| m.subscriber)
            .and_then(|id| self.session_index(id))
        else {
            return;
        };
        let answer = match SdpAnswer::from_sdp_string(&sdp) {
            Ok(a) => a,
            Err(e) => {
                warn!("[SFU] answer parse user={}: {:?}", user, e);
                return;
            }
        };
        let s = &mut self.sessions[idx];
        let Some((pending, _, pending_rev)) = s.pending.take() else {
            debug!("[SFU] answer without pending offer user={}", user);
            return;
        };
        if pending_rev != rev {
            debug!("[SFU] stale answer user={} rev={} pending={}", user, rev, pending_rev);
            s.pending = Some((pending, Instant::now(), pending_rev));
            return;
        }
        if let Err(e) = s.rtc.sdp_api().accept_answer(pending, answer) {
            warn!("[SFU] accept_answer user={}: {:?}", user, e);
            for t in &mut s.tracks {
                match t.state {
                    TrackState::Negotiating(_) => t.state = TrackState::ToOpen,
                    TrackState::NegotiatingStop(m) => t.state = TrackState::ToStop(m),
                    _ => {}
                }
            }
            // Остановленная, пока шёл оффер (stop_source_everywhere/drop_session): оффер не
            // принят — её линии нет, останавливать нечего.
            let rtc = &s.rtc;
            s.tracks.retain(|t| !matches!(t.state, TrackState::ToStop(m) if rtc.media(m).is_none()));
            return;
        }
        s.anchor_negotiated = true;
        let mut opened: Vec<(SessionId, Mid, Option<Rid>)> = Vec::new();
        for t in &mut s.tracks {
            if let TrackState::Negotiating(m) = t.state {
                t.state = TrackState::Open(m);
                if t.kind == MediaKind::Video {
                    opened.push((t.src_session, t.src_mid, t.target_rid.or(t.rid)));
                }
            }
        }
        s.tracks.retain(|t| !matches!(t.state, TrackState::NegotiatingStop(_)));
        for (src, mid, rid) in opened {
            if let Some(j) = self.session_index(src) {
                self.sessions[j].ask_keyframe(mid, rid, true);
            }
        }
    }

    fn on_leave(&mut self, room: &str, user: &str) {
        let Some(member) = self.rooms.get_mut(room).and_then(|r| r.members.remove(user)) else {
            return;
        };
        info!("[SFU] leave user={} room={}", user, room);
        for id in [member.publisher, member.native_publisher, member.subscriber].into_iter().flatten() {
            self.drop_session(id, false);
        }
        if self.rooms.get(room).map(|r| r.members.is_empty()).unwrap_or(false) {
            self.rooms.remove(room);
        }
    }

    /// Закрывает сессию и снимает её источники у зрителей. `notify` — сказать клиенту,
    /// что соединение потеряно (он поднимет его заново).
    fn drop_session(&mut self, id: SessionId, notify: bool) {
        let Some(i) = self.session_index(id) else {
            return;
        };
        let mut s = self.sessions.remove(i);
        s.rtc.disconnect();
        if s.role == Role::Publish {
            for s2 in &mut self.sessions {
                if s2.role != Role::Subscribe {
                    continue;
                }
                s2.tracks.retain(|t| !(t.src_session == id && t.state == TrackState::ToOpen));
                for t in &mut s2.tracks {
                    if t.src_session == id {
                        if let TrackState::Open(m) | TrackState::Negotiating(m) = t.state {
                            t.state = TrackState::ToStop(m);
                        }
                    }
                }
            }
        }
        if s.role == Role::Publish && s.sources.values().any(|k| Self::is_screen_kind(*k)) {
            self.clear_watchers(&s.room, &s.user);
        }
        let mut native_slot = false;
        // Сессия, которую сервер сам заменил (reset, fresh-публикация), в слоте уже не
        // стоит: клиенту о ней сообщать нельзя — он счёл бы живое соединение потерянным.
        let mut was_current = false;
        if let Some(member) = self.rooms.get_mut(&s.room).and_then(|r| r.members.get_mut(&s.user)) {
            match s.role {
                Role::Publish if member.publisher == Some(id) => {
                    was_current = true;
                    member.publisher = None;
                }
                Role::Publish if member.native_publisher == Some(id) => {
                    was_current = true;
                    native_slot = true;
                    member.native_publisher = None;
                }
                Role::Subscribe if member.subscriber == Some(id) => {
                    was_current = true;
                    member.subscriber = None;
                }
                _ => {}
            }
        }
        if notify && was_current {
            info!("[SFU] session lost session={} user={} role={:?}", id, s.user, s.role);
            self.send(
                &s.user,
                &s.device,
                json!({
                    "type": "voice_sfu_closed",
                    "roomId": s.room,
                    "role": if s.role == Role::Publish { "publish" } else { "subscribe" },
                    "slot": if native_slot { "native" } else { "page" },
                }),
            );
        }
    }

    // ---------------- согласование подписки ----------------

    fn negotiate_subscribers(&mut self) {
        for idx in 0..self.sessions.len() {
            let s = &mut self.sessions[idx];
            if s.role != Role::Subscribe || !s.rtc.is_alive() {
                continue;
            }
            if let Some((_, at, _)) = &s.pending {
                // Клиент не ответил (потерял сообщение) — пробуем заново.
                if at.elapsed() < Duration::from_secs(12) {
                    continue;
                }
                warn!("[SFU] offer timeout user={} rev={}", s.user, s.rev);
                s.pending = None;
                for t in &mut s.tracks {
                    match t.state {
                        TrackState::Negotiating(_) => t.state = TrackState::ToOpen,
                        TrackState::NegotiatingStop(m) => t.state = TrackState::ToStop(m),
                        _ => {}
                    }
                }
            }
            let needs = s
                .tracks
                .iter()
                .any(|t| matches!(t.state, TrackState::ToOpen | TrackState::ToStop(_)));
            if !needs {
                continue;
            }
            let mut change = s.rtc.sdp_api();
            if !s.anchor_negotiated {
                // Первой — до любых медиа-линий.
                change.add_channel("zali-sfu".to_string());
            }
            for t in &mut s.tracks {
                match t.state {
                    TrackState::ToOpen => {
                        // Поток — от человека, не от сессии: картинку экрана может слать издатель
                        // оболочки (`native`), а звук — страница, это две сессии. С id от сессии
                        // они приходили зрителю в разных потоках, и его единственная плитка
                        // показывала тот, что пришёл последним (чёрная со звуком).
                        let stream_id = format!("zs{:016x}{}", user_stream_key(&t.src_user), t.source.stream_suffix());
                        let track_id = format!("zt{}{}", t.src_session, t.src_mid);
                        let mid = change.add_media(t.kind, Direction::SendOnly, Some(stream_id), Some(track_id), None);
                        t.state = TrackState::Negotiating(mid);
                        t.started = false;
                        t.last_out = None;
                    }
                    TrackState::ToStop(mid) => {
                        change.stop_media(mid);
                        t.state = TrackState::NegotiatingStop(mid);
                    }
                    _ => {}
                }
            }
            if !change.has_changes() {
                continue;
            }
            let Some((offer, pending)) = change.apply() else {
                continue;
            };
            s.rev += 1;
            s.pending = Some((pending, Instant::now(), s.rev));
            let tracks: serde_json::Map<String, serde_json::Value> = s
                .tracks
                .iter()
                .filter(|t| matches!(t.state, TrackState::Open(_) | TrackState::Negotiating(_)))
                .filter_map(|t| {
                    t.mid().map(|m| {
                        (
                            m.to_string(),
                            json!({ "user": t.src_user, "source": t.source.as_str() }),
                        )
                    })
                })
                .collect();
            let payload = json!({
                "type": "voice_sfu_offer",
                "roomId": s.room,
                "sdp": offer.to_sdp_string(),
                "rev": s.rev,
                "session": s.id,
                "tracks": tracks,
            });
            let (user, device) = (s.user.clone(), s.device.clone());
            self.send(&user, &device, payload);
        }
    }

    // ---------------- пересылка ----------------

    fn propagate(&mut self, p: Propagated) {
        match p {
            Propagated::Media(src, data) => self.forward_media(src, data),
            Propagated::KeyframeRequest(sub, mid_out) => {
                let Some(i) = self.session_index(sub) else {
                    return;
                };
                self.sessions[i].viewer_plis.push_back(Instant::now());
                let Some((src, src_mid, rid)) = self.sessions[i]
                    .tracks
                    .iter()
                    .find(|t| t.mid() == Some(mid_out))
                    .map(|t| (t.src_session, t.src_mid, t.target_rid.or(t.rid)))
                else {
                    return;
                };
                if let Some(j) = self.session_index(src) {
                    self.sessions[j].ask_keyframe(src_mid, rid, false);
                }
            }
            Propagated::Estimate(sub, estimate) => {
                if let Some(i) = self.session_index(sub) {
                    self.sessions[i].estimate = Some(estimate);
                }
            }
        }
    }

    fn forward_media(&mut self, src: SessionId, data: MediaData) {
        let Some(si) = self.session_index(src) else {
            return;
        };
        let now = Instant::now();
        let keyframe = is_keyframe(&data);
        {
            let s = &mut self.sessions[si];
            if s.role != Role::Publish {
                return;
            }
            let stat = s.layers.entry((data.mid, data.rid)).or_default();
            stat.bytes += data.data.len() as u64;
            stat.frames += 1;
            if !data.contiguous {
                stat.gaps += 1;
            }
            stat.last_seen = Some(now);
            stat.window_start.get_or_insert(now);
        }
        // Разрыв в RTP от отправителя (пакет не восстановился по NACK): кадр ссылается на
        // потерянный. Пересылать его и следующие НЕЛЬЗЯ — у зрителя нумерация сплошная, он
        // разрыва не видит и ключевой кадр сам не попросит. H.264 это маскирует артефактами,
        // а аппаратный HEVC (VideoToolbox) ломается и выбрасывает ВСЕ кадры до следующего
        // IDR: при 5 % потерь зритель 20 с получал 4 Мбит/с и декодировал 0 к/с (прогон
        // 2026-11-22). Трек зрителя возвращается к ожиданию ключевого кадра, как при
        // переключении слоя.
        let gap = !data.contiguous && self.sessions[si].sources.get(&data.mid).is_some_and(|k| *k != SourceKind::ScreenAudio);
        if gap && !keyframe {
            self.sessions[si].ask_keyframe(data.mid, data.rid, true);
        }
        let room = self.sessions[si].room.clone();
        let mut ask: Vec<(Mid, Option<Rid>)> = Vec::new();
        for s in &mut self.sessions {
            if s.role != Role::Subscribe || s.room != room || !s.rtc.is_alive() {
                continue;
            }
            for t in &mut s.tracks {
                if t.src_session != src || t.src_mid != data.mid {
                    continue;
                }
                let TrackState::Open(mid_out) = t.state else {
                    continue;
                };
                if t.kind == MediaKind::Video {
                    if gap && !keyframe && t.started && data.rid == t.rid {
                        t.started = false;
                    }
                    // Первый выбор слоя, пока планировщик не отработал: первый пришедший.
                    if t.target_rid.is_none() && data.rid.is_some() {
                        t.target_rid = data.rid;
                    }
                    let want_switch = !t.started || t.target_rid != t.rid;
                    if want_switch && data.rid == t.target_rid {
                        if !keyframe {
                            // Ждём ключевой кадр нужного слоя; текущий слой (если идёт)
                            // продолжает уходить зрителю, пока он не пришёл.
                            ask.push((data.mid, data.rid));
                            continue;
                        }
                        if t.started && t.rid != t.target_rid {
                            t.last_switch = Some(now);
                        }
                        t.rid = t.target_rid;
                        t.started = true;
                        // У слоя свои RTP-таймстампы: стыкуем с отправленным по часам.
                        t.ts_offset = Self::continuity_offset(t.last_out, &data, now);
                    } else if !(t.started && data.rid == t.rid) {
                        continue;
                    }
                } else if t.last_out.is_none() {
                    t.ts_offset = 0;
                }
                let out_ts = (data.time.numer() as i128 + t.ts_offset).max(0) as u64;
                let time = MediaTime::new(out_ts, data.time.frequency());
                let Some(writer) = s.rtc.writer(mid_out) else {
                    continue;
                };
                let Some(pt) = viewer_pt(&writer, data.params) else {
                    if !t.codec_mismatch_logged {
                        t.codec_mismatch_logged = true;
                        warn!(
                            "[SFU] codec mismatch viewer={} from={} source={} params={:?}",
                            s.user, t.src_user, t.source.as_str(), data.params
                        );
                    }
                    continue;
                };
                let writer = match data.ext_vals.video_orientation {
                    Some(o) => writer.video_orientation(o),
                    None => writer,
                };
                if let Err(e) = writer.write(pt, data.network_time, time, data.data.clone()) {
                    warn!("[SFU] write viewer={} : {:?}", s.user, e);
                    s.rtc.disconnect();
                    break;
                }
                t.last_out = Some((out_ts, now));
            }
        }
        if !ask.is_empty() {
            let s = &mut self.sessions[si];
            for (mid, rid) in ask {
                s.ask_keyframe(mid, rid, true);
            }
        }
    }

    /// Смещение таймстампа, при котором первый кадр нового слоя встаёт сразу за
    /// последним отправленным — по прошедшему времени. Иначе у зрителя скачок
    /// таймстампа, и джиттер-буфер держит или выбрасывает кадры.
    fn continuity_offset(last: Option<(u64, Instant)>, data: &MediaData, now: Instant) -> i128 {
        let Some((last_ts, at)) = last else {
            return 0;
        };
        let hz = data.time.frequency().get() as f64;
        let delta = (now.duration_since(at).as_secs_f64() * hz).round().max(1.0) as i128;
        last_ts as i128 + delta - data.time.numer() as i128
    }

    // ---------------- такт планировщика ----------------

    fn tick(&mut self, now: Instant) {
        // Битрейты слоёв у публикующих.
        for s in &mut self.sessions {
            if s.role != Role::Publish {
                continue;
            }
            for stat in s.layers.values_mut() {
                if let Some(start) = stat.window_start {
                    let secs = now.duration_since(start).as_secs_f64();
                    if secs >= 0.4 {
                        let rate = stat.bytes as f64 * 8.0 / secs;
                        stat.bitrate = if stat.bitrate == 0.0 { rate } else { stat.bitrate * 0.6 + rate * 0.4 };
                        // Экран: в статике 1080p стоит 100 кбит/с, в движении — 15 Мбит/с за
                        // долю секунды. По среднему зритель с каналом 6 Мбит/с получал верхний
                        // слой, очередь отправки распухала на секунды, при смене слоя картинка
                        // «откатывалась назад» (живой Windows → Mac 2026-11-22). Пик держится
                        // и спадает с полураспадом ~4 с.
                        stat.peak = rate.max(stat.peak * 0.5f64.powf(secs / 4.0));
                        stat.bytes = 0;
                        stat.window_start = Some(now);
                    }
                }
                if stat.last_seen.is_some_and(|t| now.duration_since(t) > Duration::from_millis(1500)) {
                    stat.bitrate = 0.0;
                    stat.peak = 0.0;
                }
            }
        }

        // Умершие сессии: разрыв ICE дольше 8 с или так и не подключились за 25 с.
        let dead: Vec<SessionId> = self
            .sessions
            .iter()
            .filter(|s| {
                !s.rtc.is_alive()
                    || s.disconnected_since.is_some_and(|t| now.duration_since(t) > Duration::from_secs(8))
                    || (!s.connected && now.duration_since(s.created_at) > Duration::from_secs(25))
            })
            .map(|s| s.id)
            .collect();
        for id in dead {
            self.drop_session(id, true);
        }

        // Выбор слоёв для каждого зрителя.
        let layer_view: HashMap<SessionId, Vec<(Mid, Option<Rid>, (f64, f64), u64)>> = self
            .sessions
            .iter()
            .filter(|s| s.role == Role::Publish)
            .map(|s| {
                (
                    s.id,
                    s.layers
                        .iter()
                        .filter(|(_, st)| st.last_seen.is_some_and(|t| now.duration_since(t) < Duration::from_millis(1500)))
                        .map(|((m, r), st)| (*m, *r, (st.bitrate.max(1.0), st.peak.max(st.bitrate).max(1.0)), s.layer_pixels.get(&(*m, *r)).copied().unwrap_or(0)))
                        .collect(),
                )
            })
            .collect();
        let mut asks: Vec<(SessionId, Mid, Option<Rid>)> = Vec::new();
        for s in &mut self.sessions {
            if s.role != Role::Subscribe || !s.connected {
                continue;
            }
            let estimate = s.estimate.map(|b| b.as_f64()).unwrap_or(2_500_000.0);
            // Звук демонстрации — всегда.
            let audio = 64_000.0 * s.tracks.iter().filter(|t| t.kind == MediaKind::Audio).count() as f64;
            let loss = if s.loss_at.is_some_and(|at| now.duration_since(at) < Duration::from_millis(2500)) {
                s.loss
            } else {
                0.0
            };
            s.loss_slow = s.loss_slow * 0.9 + loss * 0.1;
            while s.viewer_plis.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(10)) {
                s.viewer_plis.pop_front();
            }
            // Серия PLI (3+ за 10 с) при 5 % потерь на прогоне 2026-11-22 означала фриз около
            // секунды на каждые 5 с на 1080p60: держать верхний слой там хуже, чем уйти ниже —
            // меньше пакетов на кадр, меньше невосстановимых кадров, легче ключевой кадр.
            let pli_storm = s.viewer_plis.len() >= 3;
            if s.pli_penalty_until.is_some_and(|t| now.duration_since(t.min(now)) > Duration::from_secs(60)) {
                s.pli_penalty = Duration::from_secs(10);
            }
            if pli_storm {
                // Серия, пришедшая вскоре после прошлого штрафа, — раскачка (проба подняла,
                // снова фризы): пауза вдвое длиннее.
                let recent = s.pli_penalty_until.is_some_and(|t| now < t + Duration::from_secs(30));
                if recent {
                    s.pli_penalty = (s.pli_penalty * 2).min(Duration::from_secs(60));
                }
                debug!("[SFU] pli storm viewer={} plis={} — вниз, пауза роста {}s", s.user, s.viewer_plis.len(), s.pli_penalty.as_secs());
                s.probe_backoff = (s.probe_backoff * 2).min(Duration::from_secs(30));
                s.proven_floor = 0.0;
                s.trial = None;
                s.viewer_plis.clear();
                s.pli_penalty_until = Some(now + s.pli_penalty);
            }
            // Явная перегрузка канала зрителя (потери > 8 % до повторов) — та же пауза роста,
            // что и после серии PLI. Раньше при таких потерях сбрасывался только запас
            // (proven_floor), и через 3 с проба снова поднимала слой экрана до полного: на
            // канале ~1,3 Мбит/с зритель каждые ~10 с получал f → q → f → q (оценка прыгала
            // 340 ↔ 6150 кбит/с, потери 8,6 %). Видео забивало общую очередь, и голоса звонка по
            // прямым соединениям теряли 2–2,5 % пакетов при RTT 215–321 мс и буфере ~850 мс — «его
            // слышно обрывками» (диагностика 2026-11-27, griboed). Вниз сверх оценки слой по-прежнему
            // не режем (повторы закрывают случайные потери), только не растим и не пробуем.
            if !pli_storm && loss > 0.08 && !s.pli_penalty_until.is_some_and(|t| now < t) {
                let recent = s.pli_penalty_until.is_some_and(|t| now < t + Duration::from_secs(30));
                if recent {
                    s.pli_penalty = (s.pli_penalty * 2).min(Duration::from_secs(60));
                }
                debug!("[SFU] congestion viewer={} loss={:.1}% — пауза роста {}s", s.user, loss * 100.0, s.pli_penalty.as_secs());
                s.probe_backoff = (s.probe_backoff * 2).min(Duration::from_secs(30));
                s.proven_floor = 0.0;
                s.trial = None;
                s.pli_penalty_until = Some(now + s.pli_penalty);
            }
            let penalty = s.pli_penalty_until.is_some_and(|t| now < t);
            // Случайные потери (Wi-Fi, мобильная сеть) классический GCC в str0m понимает как
            // «держать»: при 2–10 % оценка не растёт вовсе, и зритель навсегда оставался на
            // слое, на котором его застали (прогон 2026-11-22: 2 % потерь — 960×540 при
            // свободном канале, хотя повторы закрывали почти всё). Поэтому поверх оценки —
            // подтверждённая пробным переходом скорость (proven_floor). Снимается, когда
            // потери стали явными (> 8 %) или delay-based оценка упала вдвое ниже неё — это
            // уже перегрузка, а не шум.
            // Провал delay-based оценки без единой потери — не перегрузка: у зрителя на той же
            // машине, что сервер, её шатал сам приёмник (WKWebView, декод 1080p60), и запас
            // сбрасывался каждые полминуты — зритель скакал f ↔ h (живой Windows → Mac 2026-11-22).
            if s.proven_floor > 0.0 && (loss > 0.08 || (estimate < s.proven_floor * 0.5 && loss > 0.02)) {
                debug!("[SFU] proven floor dropped viewer={} loss={:.1}% estimate={:.0}k", s.user, loss * 100.0, estimate / 1000.0);
                s.proven_floor = 0.0;
            }
            if let Some((until, base, rate)) = s.trial {
                if now >= until {
                    s.trial = None;
                    // Провал оценки вдвое за время пробы с хоть какими-то потерями — не
                    // подтверждение: на узком канале проба «проходила» (потери < 5 %), запас
                    // взлетал до 6 Мбит/с при ёмкости ~1,3, и слой снова забивал канал.
                    let collapsed = s.probe_before.is_some_and(|before| estimate < before * 0.5) && loss > 0.01;
                    if loss <= (base + 0.03).max(0.05) && !collapsed {
                        s.proven_floor = s.proven_floor.max(rate * 1.05);
                        s.probe_backoff = Duration::from_secs(3);
                    } else {
                        s.probe_backoff = (s.probe_backoff * 2).min(Duration::from_secs(30));
                    }
                    s.probe_next = now + s.probe_backoff;
                }
            }
            let trial_rate = s.trial.map(|(_, _, rate)| rate).unwrap_or(0.0);
            let estimate = estimate.max(s.proven_floor).max(trial_rate);
            let mut budget = estimate - audio;
            // Вниз сверх оценки — по серии PLI (кадры, которые повторы НЕ восстановили) или
            // при потерях > 15 %. Доля потерь из RTCP RR — это потери ДО повторов: на прогоне
            // с 10 % потерь повторы закрывали почти всё (PLI 0,4 за 5 с), а срез по «> 8 %»
            // загонял зрителя в слой q — 480×270 при ~9 к/с — без всякой нужды.
            if (loss > 0.15 || pli_storm) && s.last_allocated > 0.0 {
                budget = budget.min(s.last_allocated * 0.7);
            }
            let cameras = s.tracks.iter().filter(|t| t.source == SourceKind::Camera).count();
            let mut desired = 0.0;
            let mut allocated = 0.0;
            let mut peak_allocated = 0.0;
            let mut next_step: Option<f64> = None;
            // Экран важнее камер: его слой выбирается первым.
            let mut order: Vec<usize> = (0..s.tracks.len()).filter(|i| s.tracks[*i].kind == MediaKind::Video).collect();
            order.sort_by_key(|i| if s.tracks[*i].source == SourceKind::Screen { 0 } else { 1 });
            for i in order {
                let t = &mut s.tracks[i];
                if !matches!(t.state, TrackState::Open(_)) {
                    continue;
                }
                // (rid, (средний, пик), пиксели): вверх — по пику (не входить в слой, который в
                // движении не поместится), держаться/вниз — по среднему (секундный всплеск
                // экрана не повод ронять разрешение; оценку под пики поднимают пробы ниже).
                let mut sized: Vec<(Option<Rid>, (f64, f64), u64)> = layer_view
                    .get(&t.src_session)
                    .map(|v| v.iter().filter(|(m, _, _, _)| *m == t.src_mid).map(|(_, r, b, px)| (*r, *b, *px)).collect())
                    .unwrap_or_default();
                if sized.is_empty() {
                    continue;
                }
                sized.sort_by_key(|(r, _, _)| layer_rank(*r));
                // Потолок декодера зрителя: слои тяжелее него не предлагаем (нижний — всегда).
                if s.max_pixel_rate > 0 {
                    let lowest = sized[0];
                    sized.retain(|(_, _, px)| *px == 0 || *px <= s.max_pixel_rate);
                    if sized.is_empty() {
                        sized.push(lowest);
                    }
                }
                let mut layers: Vec<(Option<Rid>, f64)> = sized.iter().map(|(r, b, _)| (*r, b.0)).collect();
                let peaks: Vec<f64> = sized.iter().map(|(_, b, _)| b.1).collect();
                // Много камер — плитки маленькие: верхний слой камеры не нужен.
                if t.source == SourceKind::Camera && cameras > 3 && layers.len() > 1 {
                    layers.pop();
                }
                let peak_of = |idx: usize| peaks.get(idx).copied().unwrap_or(0.0);
                desired += layers.last().map(|(_, b)| *b).unwrap_or(0.0);
                let current_rank = layer_rank(t.rid);
                let mut choice = layers[0];
                for (idx, layer) in layers.iter().enumerate() {
                    let up = layer_rank(layer.0) > current_rank;
                    // Вверх — с запасом и не чаще раза в 4 с; вниз — сразу.
                    let margin = if up { UPGRADE_MARGIN } else { 1.0 };
                    let cost = if up { layer.1.max(peak_of(idx)) } else { layer.1 };
                    // При заметных потерях (> 5 % до повторов) вверх не идём вовсе.
                    let calm = !up
                        || (loss < 0.05 && !penalty && t.last_switch.is_none_or(|at| now.duration_since(at) > Duration::from_secs(4)));
                    if cost * margin <= budget && calm {
                        choice = *layer;
                        if let Some(next) = layers.get(idx + 1) {
                            next_step = Some(next_step.unwrap_or(0.0).max(next.1 - layer.1));
                        } else {
                            next_step = next_step.or(Some(0.0));
                        }
                    }
                }
                // Вниз — не на первый же провал оценки: delay-based оценка шумит (всплеск
                // задержки на Wi-Fi, загруженный приёмник), и зритель скакал f → q → h за
                // полминуты. Понижаем, если не помещаемся дольше 1,5 с, а при провале вдвое
                // и больше — сразу: там уже идут потери.
                if layer_rank(choice.0) < current_rank && t.started {
                    if let Some(cur) = layers.iter().find(|(r, _)| *r == t.rid).copied() {
                        let severe = budget < cur.1 * 0.5 || pli_storm;
                        let since = *t.over_budget_since.get_or_insert(now);
                        if !severe && now.duration_since(since) < Duration::from_millis(1500) {
                            choice = cur;
                        }
                    }
                } else {
                    t.over_budget_since = None;
                }
                budget -= choice.1;
                allocated += choice.1;
                let chosen_idx = layers.iter().position(|(r, _)| *r == choice.0).unwrap_or(0);
                peak_allocated += choice.1.max(peak_of(chosen_idx));
                if t.target_rid != choice.0 {
                    debug!(
                        "[SFU] layer viewer={} from={} {:?} -> {:?} (estimate {:.0} kbit/s)",
                        s.user, t.src_user, t.target_rid, choice.0, estimate / 1000.0
                    );
                    t.target_rid = choice.0;
                    asks.push((t.src_session, t.src_mid, choice.0));
                }
            }
            s.last_allocated = allocated;
            if desired > 0.0 {
                // Как оценка канала зрителя растёт. В str0m детектор «приложение недогружает
                // канал» (ALR) считает только медиа, без паддинга: пока зритель на слое меньше
                // канала, оценка не меняется ВООБЩЕ — паддинг до следующего слоя жёг 4,7 Мбит/с
                // впустую, а оценка стояла на 7287 кбит/с до бита (прогон 2026-11-22). Растёт
                // она пробами, а пробу str0m запускает только на ПОВЫШЕНИЕ желаемого битрейта.
                // Поэтому: в покое желаемое = текущая оценка, минимум = фактическое видео (без
                // паддинга); когда следующий слой не помещается, а потерь нет, — проба:
                // желаемое поднимается до нужного для перехода. Удачная (оценка выросла на 15 %+)
                // — следующая через 3 с, неудачная — интервал вдвое, до 30 с.
                // Запас под пики: экран в статике стоит копейки, и без проб оценка застывала
                // на уровне статики (4–13 Мбит/с до зрителя на ТОЙ ЖЕ машине, что и сервер), а
                // активная сцена разгоняла 1080p до 15 Мбит/с — очередь, откат картинки, падение
                // слоя (живой Windows → Mac 2026-11-22). Пробуем канал до 1,3 × пика выбранного.
                let headroom = peak_allocated * 1.3 + audio;
                let want_more = next_step.unwrap_or(0.0) > 0.0 || estimate < headroom;
                // Ровно столько, сколько требует правило перехода выше (слой × UPGRADE_MARGIN).
                let need = ((allocated + next_step.unwrap_or(0.0)) * UPGRADE_MARGIN + audio).max(headroom);
                let min = Bitrate::bps((allocated + audio) as u64);
                if want_more && loss < 0.05 && !penalty && s.trial.is_none() && now >= s.probe_next {
                    // Пробный переход: 4 с бюджет включает следующий слой; итог — в начале
                    // следующих тактов (потери не выросли — скорость подтверждена).
                    s.trial = Some((now + Duration::from_secs(4), s.loss_slow.max(loss), need));
                    s.probe_before = Some(estimate);
                    s.probe_next = now + s.probe_backoff;
                    let target = (need * 1.5).max(estimate * 1.5).min(desired * 2.0);
                    s.rtc.bwe().set_bitrate(min, Bitrate::bps(target as u64));
                    debug!("[SFU] probe viewer={} estimate={:.0}k target={:.0}k", s.user, estimate / 1000.0, target / 1000.0);
                } else {
                    s.rtc.bwe().set_bitrate(min, Bitrate::bps(estimate.max(allocated + audio) as u64));
                }
            }
            if now.duration_since(s.last_report) >= Duration::from_secs(10) {
                s.last_report = now;
                let layers: Vec<String> = s
                    .tracks
                    .iter()
                    .filter(|t| matches!(t.state, TrackState::Open(_)))
                    .map(|t| format!("{}:{}:{}", t.src_user, t.source.as_str(), t.rid.as_deref().unwrap_or("-")))
                    .collect();
                info!(
                    "[SFU] viewer={} room={} via={} estimate={:.0}kbit/s floor={:.0}kbit/s loss={:.1}% probe_every={}s layers=[{}]",
                    s.user,
                    s.room,
                    via_label(s.tx_udp, s.tx_tcp),
                    estimate / 1000.0,
                    s.proven_floor / 1000.0,
                    loss * 100.0,
                    s.probe_backoff.as_secs(),
                    layers.join(",")
                );
                s.tx_udp = 0;
                s.tx_tcp = 0;
            }
        }
        for (src, mid, rid) in asks {
            if let Some(j) = self.session_index(src) {
                self.sessions[j].ask_keyframe(mid, rid, true);
            }
        }
        for s in &mut self.sessions {
            if s.role != Role::Publish || now.duration_since(s.last_report) < Duration::from_secs(10) {
                continue;
            }
            let wire_kbps = s.rx_bytes as f64 * 8.0 / now.duration_since(s.last_report).as_secs_f64() / 1000.0;
            s.rx_bytes = 0;
            s.last_report = now;
            let sources = &s.sources;
            let layers: Vec<String> = s
                .layers
                .iter_mut()
                .filter(|(_, st)| st.bitrate > 0.0)
                .map(|((m, r), st)| {
                    let line = format!(
                        "{}{}:{:.0}k/{}f/{}gap",
                        sources.get(m).map(|k| k.as_str()).unwrap_or("?"),
                        r.map(|r| format!("/{}", &*r)).unwrap_or_default(),
                        st.bitrate / 1000.0,
                        st.frames,
                        st.gaps
                    );
                    st.frames = 0;
                    st.gaps = 0;
                    line
                })
                .collect();
            // wire — весь входящий поток издателя; заметно больше суммы слоёв — это паддинг.
            info!("[SFU] publisher={} room={} wire={:.0}k layers=[{}]", s.user, s.room, wire_kbps, layers.join(","));
        }
        if self.stalled_in_dropped > 0 {
            info!("[SFU] стенд: в паузах эфира выброшено {} пакетов издателей", self.stalled_in_dropped);
            self.stalled_in_dropped = 0;
        }
        if (self.stalled_out_dropped > 0 || self.stalled_out_held > 0) && now.duration_since(self.stall_report_at) >= Duration::from_secs(10) {
            self.stall_report_at = now;
            info!(
                "[SFU] стенд: в паузах эфира задержано {} и выброшено {} из {} пакетов зрителям (tcp {})",
                self.stalled_out_held, self.stalled_out_dropped, self.viewer_tx_total, self.viewer_tx_tcp
            );
            self.viewer_tx_total = 0;
            self.viewer_tx_tcp = 0;
            self.stalled_out_dropped = 0;
            self.stalled_out_held = 0;
        }
    }
}

#[cfg(test)]
mod watch_tests {
    use super::*;

    fn member(gating: bool, watching: &[&str]) -> Member {
        Member {
            gating,
            watching: watching.iter().map(|s| s.to_string()).collect(),
            ..Member::default()
        }
    }

    #[test]
    fn screen_goes_only_to_watchers_that_ask_for_it() {
        // Клиент с «Смотреть»: экран и его звук — только после нажатия; камера — всегда.
        let viewer = member(true, &[]);
        assert!(Engine::viewer_gets(&viewer, "bob", SourceKind::Camera));
        assert!(!Engine::viewer_gets(&viewer, "bob", SourceKind::Screen));
        assert!(!Engine::viewer_gets(&viewer, "bob", SourceKind::ScreenAudio));
        let watcher = member(true, &["bob"]);
        assert!(Engine::viewer_gets(&watcher, "bob", SourceKind::Screen));
        assert!(Engine::viewer_gets(&watcher, "bob", SourceKind::ScreenAudio));
        assert!(!Engine::viewer_gets(&watcher, "carol", SourceKind::Screen), "смотрим одного — чужой экран не идёт");
        // Старый клиент не знает про «Смотреть» — ему всё идёт сразу.
        let legacy = member(false, &[]);
        assert!(Engine::viewer_gets(&legacy, "bob", SourceKind::Screen));
    }
}
