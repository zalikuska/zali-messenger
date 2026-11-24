//! Обработка голоса для нативного захвата микрофона (macOS и Windows).
//!
//! Зачем своя: WebKit на macOS захватывает микрофон только через системный
//! VoiceProcessingIO, а он на каждый вход в звонок приглушает звук всех остальных
//! приложений (до −15 дБ) и пересобирает аудиоустройство — звук во всей системе
//! заикается. Поэтому оболочки захватывают микрофон сами, обычным HAL-вводом, и
//! эхо/шум/громкость обрабатывают здесь — одним кодом на обеих платформах.
//!
//! Конвейер (выбран по стенду качества 2026-11-12, см. tests/apm_quality.rs):
//!
//! ```text
//!  опорный сигнал (что играет) ──→ ┐
//!  микрофон → [ФВЧ + AEC3 (sonora)] → [RNNoise] → [AGC2 адаптивный (sonora)] → [затвор по VAD] → выход
//! ```
//!
//! * AEC3 — чистый Rust-порт эхоподавителя WebRTC (`sonora`). На стенде не хуже
//!   C++-оригинала из Chromium: ERLE 53 против 47 дБ, речь в паузах дальней стороны
//!   проседает на 0.5 против 2.0 дБ.
//! * RNNoise (`nnnoiseless`) вместо шумодава WebRTC: на стационарном шуме глушит
//!   глубже (19–30 дБ) и почти не трогает речь (−0.1…−0.5 дБ против −1…−6 дБ),
//!   заодно добирает остаточное эхо (+20 дБ ERLE).
//! * AGC2 стоит после RNNoise, отдельным экземпляром: иначе он поднимал бы шум до того,
//!   как его уберёт RNNoise.
//! * Затвор (`SpeechGate`, 2026-11-24) — после всего: глушит паузы между фразами до −40 дБ
//!   по VAD RNNoise. Резкие шумы (клавиатура, щелчки) RNNoise пропускает почти целиком,
//!   а AGC их поднимал; затвор снимает их в паузах на 40+ дБ. Под сильным ровным шумом
//!   он сам мельчает до нуля — там начало слов едва выходит из шума.
//!
//! Формат: 48 кГц, моно, f32 в [-1, 1], кадры по 10 мс (480 отсчётов). Блоки любой
//! длины нарезаются внутри; RNNoise добавляет задержку в один кадр.
//! Опорный сигнал и микрофон приходят из разных потоков — снаружи нужен мьютекс
//! (его держит FFI-обёртка `ZaliApm`).

use sonora::config::{AdaptiveDigital, EchoCanceller, GainController2, HighPassFilter};
use sonora::{AudioProcessing, Config, StreamConfig};

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME: usize = 480;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoiceProcessingConfig {
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain: bool,
}

impl VoiceProcessingConfig {
    pub const ALL: Self = Self { echo_cancellation: true, noise_suppression: true, auto_gain: true };
    pub const NONE: Self = Self { echo_cancellation: false, noise_suppression: false, auto_gain: false };
}

/// Сводка для диагностики звонка (журнал `voiceDiag`).
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct VoiceProcessingStats {
    pub erle_db: Option<f64>,
    pub echo_return_loss_db: Option<f64>,
    pub delay_ms: Option<i32>,
    pub residual_echo_likelihood: Option<f64>,
    pub render_frames: u64,
    pub capture_frames: u64,
    /// Уровни за последние ~5 с (скользящее среднее мощности), dBFS: микрофон до
    /// обработки и то, что уходит собеседникам.
    pub input_dbfs: Option<f64>,
    pub output_dbfs: Option<f64>,
    /// Шум (кадры, где RNNoise не слышит голоса) до и после шумодава, и разница —
    /// сколько он реально срезает. None — шумодав выключен или шумовых кадров не было.
    pub noise_in_dbfs: Option<f64>,
    pub noise_out_dbfs: Option<f64>,
    pub ns_attenuation_db: Option<f64>,
    /// Те же шумовые кадры на самом выходе (после AGC): если он поднимает шум в паузах,
    /// это видно как `noise_final_dbfs` заметно выше `noise_out_dbfs`.
    pub noise_final_dbfs: Option<f64>,
    /// Затвор шумодава (`SpeechGate`): доля кадров за ~5 с, когда он закрыт (глушит
    /// больше 20 дБ), и его текущая глубина — 0 под сильным шумом, −40 в тихой комнате.
    pub gate_closed_ratio: Option<f64>,
    pub gate_depth_db: Option<f64>,
    /// Доля кадров с голосом (VAD RNNoise > 0.5) за ~5 с.
    pub speech_ratio: Option<f64>,
    /// Кадров с отсчётом на пределе (|x| ≥ 0.999) на выходе — с начала потока.
    pub clipped_frames: u64,
    /// Склейка по меткам времени (`*_at`): насколько опорный сигнал приходит позже
    /// микрофона и сколько микрофон из-за этого ждёт (среднее за ~5 с), мс. None —
    /// метки не подаются или AEC выключен.
    pub ref_lag_ms: Option<f64>,
    pub hold_ms: Option<f64>,
    /// С начала потока: кадров тишины вместо опорного сигнала (вывод молчал или дыра в
    /// метках), кадров микрофона, обработанных без дождавшегося опорного (он опоздал
    /// больше `MAX_HOLD`), выброшенных опоздавших кадров опорного.
    pub ref_zero_frames: u64,
    pub ref_forced_frames: u64,
    pub ref_late_dropped: u64,
}

/// Скользящие уровни для статистики (обновляются на каждом кадре, читаются раз в 10 с).
#[derive(Default)]
struct Levels {
    // (среднее, сколько кадров вошло)
    input: (Option<f64>, u32),
    output: (Option<f64>, u32),
    noise_in: (Option<f64>, u32),
    noise_out: (Option<f64>, u32),
    noise_final: (Option<f64>, u32),
    gate_closed: (Option<f64>, u32),
    speech: (Option<f64>, u32),
    clipped_frames: u64,
}

impl Levels {
    /// ~5 с при кадрах по 10 мс.
    const ALPHA: f64 = 0.002;

    fn ema(slot: &mut (Option<f64>, u32), value: f64) {
        // Первые 1/ALPHA кадров — обычное среднее: иначе первое значение (шумодав ещё
        // не подстроился) весило бы в статистике десятки секунд.
        slot.1 = slot.1.saturating_add(1);
        let alpha = Self::ALPHA.max(1.0 / slot.1 as f64);
        slot.0 = Some(match slot.0 {
            Some(prev) => prev + alpha * (value - prev),
            None => value,
        });
    }

    fn power(frame: &[f32]) -> f64 {
        frame.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / frame.len().max(1) as f64
    }

    fn dbfs(power: Option<f64>) -> Option<f64> {
        power.map(|p| 10.0 * p.max(1e-12).log10())
    }
}

/// Длительность одного отсчёта и кадра в наносекундах.
const NS_PER_SAMPLE: f64 = 1e9 / SAMPLE_RATE as f64;
const FRAME_NS: i64 = 10_000_000;
/// Дольше этого микрофон опорного сигнала не ждёт — обрабатывается без него (опорный
/// поток завис или опаздывает на сотни мс: лучше эхо, чем задержка голоса).
const MAX_HOLD_NS: i64 = 120_000_000;
/// Опорный сигнал не приходил дольше этого (по меткам) — вывод молчит: WASAPI loopback
/// в тишине пакетов не шлёт. Тогда вместо него в AEC идут нули, микрофон не ждёт.
const STALL_NS: i64 = 120_000_000;
/// Опорный сигнал старше этого относительно микрофона — устарел, догонять не нужно.
const MAX_LEAD_NS: i64 = 400_000_000;

/// Опорный сигнал и микрофон по меткам времени (`push_render_at` / `process_capture_at`).
///
/// AEC3 ищет эхо только ПОЗЖЕ опорного сигнала. В приложении опорный сигнал приходит из
/// другого потока (process tap на macOS, WASAPI loopback на Windows) и легко опаздывает
/// к обработчику на 10–40 мс относительно микрофона — тогда эхоподавитель его не находит
/// вовсе: на стенде опоздание 5 мс роняет ERLE с 52 до 25 дБ, 40 мс — до 6 дБ (так и было
/// в живых звонках 2026-11: 4–9 дБ, `delay_ms=0` на Windows). Поэтому опорный сигнал
/// копится с метками, а кадр микрофона уходит в AEC3 только когда опорный за то же
/// время уже здесь: сначала кадры опорного по его меткам до конца кадра микрофона, потом
/// сам кадр. Метки — время устройства одних часов (host time / QPC) в нс.
#[derive(Default)]
struct Aligner {
    render: std::collections::VecDeque<(i64, Vec<f32>)>,
    render_partial: Vec<f32>,
    render_partial_ts: i64,
    /// Метка следующего кадра опорного, который ждёт AEC (непрерывная шкала).
    render_next: Option<i64>,
    /// Конец последнего пришедшего опорного сигнала (по его меткам).
    render_last_end: Option<i64>,
    /// Метка первого отсчёта в `capture_fifo`.
    capture_ts: i64,
    timed: bool,
    zero_frames: u64,
    forced_frames: u64,
    late_dropped: u64,
    lag: (Option<f64>, u32),
    hold: (Option<f64>, u32),
}

impl Aligner {
    /// Сколько ещё кадров опорного сигнала положить в AEC перед кадром микрофона,
    /// начинающимся в `tc`. Ok(кадры) — можно обрабатывать, Err(()) — ждать опорный.
    fn take_render(&mut self, tc: i64, out: &mut Vec<Option<Vec<f32>>>) -> Result<(), ()> {
        let need = tc + FRAME_NS;
        let mut next = match self.render_next {
            Some(n) => n,
            None => match self.render.front() {
                Some(&(ts, _)) => ts,
                None => {
                    // Опорного ещё не было: если поток молчит давно — работаем без него.
                    return if self.render_last_end.map_or(true, |e| tc - e > STALL_NS) { Ok(()) } else { Err(()) };
                }
            },
        };
        // Сильно отстали (после паузы) — перескок, чтобы не лить в AEC сотни кадров разом.
        if next < tc - MAX_LEAD_NS {
            next = tc - FRAME_NS * 4;
        }
        while next + FRAME_NS <= need {
            while matches!(self.render.front(), Some(&(ts, _)) if ts < next - FRAME_NS / 2) {
                self.render.pop_front();
                self.late_dropped += 1;
            }
            match self.render.front() {
                Some(&(ts, _)) if ts <= next + FRAME_NS / 2 => {
                    out.push(self.render.pop_front().map(|(_, f)| f));
                }
                Some(_) => {
                    // Дыра в метках опорного: тишина.
                    out.push(None);
                    self.zero_frames += 1;
                }
                None => {
                    let stalled = self.render_last_end.map_or(true, |e| tc - e > STALL_NS);
                    if !stalled {
                        self.render_next = Some(next);
                        return Err(());
                    }
                    out.push(None);
                    self.zero_frames += 1;
                }
            }
            next += FRAME_NS;
        }
        self.render_next = Some(next);
        Ok(())
    }
}

pub struct VoiceProcessor {
    config: VoiceProcessingConfig,
    align: Aligner,
    front: AudioProcessing,
    agc: AudioProcessing,
    denoise: Box<nnnoiseless::DenoiseState<'static>>,
    highpass: Highpass,
    gate: SpeechGate,
    render_fifo: Vec<f32>,
    capture_fifo: Vec<f32>,
    scratch_render: Vec<f32>,
    scratch_a: Vec<f32>,
    scratch_b: Vec<f32>,
    render_frames: u64,
    capture_frames: u64,
    levels: Levels,
}

fn mono() -> StreamConfig {
    StreamConfig::new(SAMPLE_RATE, 1)
}

fn front_config(c: VoiceProcessingConfig) -> Config {
    Config {
        // Только вместе с AEC3. Без него ФВЧ sonora гонит звук через банк полос и портит
        // речь перед RNNoise (сходство на белом шуме 0.78 против 0.87) — там стоит свой
        // биквад (`Highpass`), см. process_frame.
        high_pass_filter: if c.echo_cancellation { Some(HighPassFilter::default()) } else { None },
        echo_canceller: if c.echo_cancellation { Some(EchoCanceller::default()) } else { None },
        ..Default::default()
    }
}

fn agc_config(c: VoiceProcessingConfig) -> Config {
    Config {
        gain_controller2: if c.auto_gain {
            Some(GainController2 { adaptive_digital: Some(AdaptiveDigital::default()), ..Default::default() })
        } else {
            None
        },
        ..Default::default()
    }
}

impl VoiceProcessor {
    pub fn new(config: VoiceProcessingConfig) -> Self {
        let front = AudioProcessing::builder()
            .config(front_config(config))
            .capture_config(mono())
            .render_config(mono())
            .build();
        let agc = AudioProcessing::builder().config(agc_config(config)).capture_config(mono()).render_config(mono()).build();
        Self {
            config,
            align: Aligner::default(),
            front,
            agc,
            denoise: nnnoiseless::DenoiseState::new(),
            highpass: Highpass::new(100.0),
            gate: SpeechGate::new(),
            render_fifo: Vec::with_capacity(FRAME * 4),
            capture_fifo: Vec::with_capacity(FRAME * 4),
            scratch_render: vec![0.0; FRAME],
            scratch_a: vec![0.0; FRAME],
            scratch_b: vec![0.0; FRAME],
            render_frames: 0,
            capture_frames: 0,
            levels: Levels::default(),
        }
    }

    pub fn config(&self) -> VoiceProcessingConfig {
        self.config
    }

    /// Меняет набор обработок на лету. Состояние AEC сохраняется, если он остаётся включённым.
    pub fn set_config(&mut self, config: VoiceProcessingConfig) {
        if config == self.config {
            return;
        }
        self.front.apply_config(front_config(config));
        if !config.echo_cancellation {
            // Опорный копится только при AEC; при повторном включении — шкала заново.
            self.align = Aligner::default();
        }
        self.agc.apply_config(agc_config(config));
        if config.noise_suppression && !self.config.noise_suppression {
            self.denoise = nnnoiseless::DenoiseState::new();
            self.gate = SpeechGate::new();
        }
        if config.noise_suppression != self.config.noise_suppression {
            // Замеры шумодава — только за время, пока он включён.
            self.levels.noise_in = (None, 0);
            self.levels.noise_out = (None, 0);
            self.levels.noise_final = (None, 0);
            self.levels.gate_closed = (None, 0);
            self.levels.speech = (None, 0);
        }
        self.config = config;
    }

    fn bypass(&self) -> bool {
        self.config == VoiceProcessingConfig::NONE
    }

    /// Опорный сигнал с меткой времени первого отсчёта (нс, те же часы, что у
    /// `process_capture_at`). Только копится: в AEC он уходит вместе с кадрами микрофона,
    /// по меткам (см. `Aligner`). Стерео сводится в моно.
    pub fn push_render_at(&mut self, samples: &[f32], channels: usize, ts_ns: i64) {
        if !self.config.echo_cancellation {
            return;
        }
        let ch = channels.max(1);
        let frames = samples.len() / ch;
        let a = &mut self.align;
        a.timed = true;
        let expected = a.render_partial_ts + (a.render_partial.len() as f64 * NS_PER_SAMPLE) as i64;
        if a.render_partial.is_empty() {
            a.render_partial_ts = ts_ns;
        } else if (ts_ns - expected).abs() > FRAME_NS / 2 {
            // Разрыв в потоке опорного (пересоздали тап, устройство сменилось).
            a.render_partial.clear();
            a.render_partial_ts = ts_ns;
        }
        if ch == 1 {
            a.render_partial.extend_from_slice(samples);
        } else {
            a.render_partial.extend(samples.chunks_exact(ch).map(|f| f.iter().sum::<f32>() / ch as f32));
        }
        let mut offset = 0;
        while a.render_partial.len() - offset >= FRAME {
            a.render.push_back((a.render_partial_ts, a.render_partial[offset..offset + FRAME].to_vec()));
            a.render_partial_ts += FRAME_NS;
            offset += FRAME;
        }
        a.render_partial.drain(..offset);
        a.render_last_end = Some(ts_ns + (frames as f64 * NS_PER_SAMPLE) as i64);
        // Микрофон не идёт (выключен) — не копить бесконечно.
        while a.render.len() > (MAX_LEAD_NS / FRAME_NS) as usize {
            a.render.pop_front();
        }
    }

    /// Микрофон с меткой времени первого отсчёта (нс). Как `process_capture`, но кадр
    /// уходит в обработку только когда опорный сигнал за то же время уже пришёл (не
    /// дольше `MAX_HOLD_NS`) — остальное ждёт следующего вызова.
    pub fn process_capture_at(&mut self, samples: &[f32], ts_ns: i64, out: &mut Vec<f32>) -> usize {
        if self.bypass() || !self.config.echo_cancellation || !self.align.timed {
            return self.process_capture(samples, out);
        }
        // Метка первого отсчёта очереди: по новой метке минус то, что уже лежит.
        // Пересчёт на каждом вызове — так шкала микрофона не уплывает от часов.
        self.align.capture_ts = ts_ns - (self.capture_fifo.len() as f64 * NS_PER_SAMPLE) as i64;
        self.capture_fifo.extend_from_slice(samples);
        let before = out.len();
        let mut offset = 0;
        let mut frames: Vec<Option<Vec<f32>>> = Vec::new();
        while self.capture_fifo.len() - offset >= FRAME {
            let tc = self.align.capture_ts + (offset as f64 * NS_PER_SAMPLE) as i64;
            frames.clear();
            let ready = self.align.take_render(tc, &mut frames);
            for f in frames.drain(..) {
                match f {
                    Some(frame) => self.feed_render_frame(&frame),
                    None => {
                        let zero = [0.0f32; FRAME];
                        self.feed_render_frame(&zero);
                    }
                }
            }
            // Сколько уже ждёт самый старый кадр: от его конца до последней метки.
            let newest_end = ts_ns + (samples.len() as f64 * NS_PER_SAMPLE) as i64;
            let waited = newest_end - (tc + FRAME_NS);
            if ready.is_err() {
                if waited < MAX_HOLD_NS {
                    break;
                }
                self.align.forced_frames += 1;
            }
            // Опоздание опорного: насколько его последний отсчёт старше последнего
            // отсчёта микрофона (пока вывод не молчит).
            if let (Ok(()), Some(end)) = (ready, self.align.render_last_end) {
                if newest_end - end < STALL_NS {
                    Levels::ema(&mut self.align.lag, ((newest_end - end) as f64 / 1e6).max(0.0));
                }
            }
            Levels::ema(&mut self.align.hold, (waited.max(0) as f64) / 1e6);
            self.scratch_a.copy_from_slice(&self.capture_fifo[offset..offset + FRAME]);
            self.process_frame();
            out.extend_from_slice(&self.scratch_a);
            self.capture_frames += 1;
            offset += FRAME;
        }
        self.capture_fifo.drain(..offset);
        out.len() - before
    }

    fn feed_render_frame(&mut self, frame: &[f32]) {
        let _ = self.front.process_render_f32(&[frame], &mut [&mut self.scratch_render[..]]);
        self.render_frames += 1;
    }

    /// Опорный сигнал — то, что сейчас играет из динамиков. `channels` = 1 или 2
    /// (чередующиеся отсчёты); стерео сводится в моно.
    pub fn push_render(&mut self, samples: &[f32], channels: usize) {
        if !self.config.echo_cancellation {
            return;
        }
        let ch = channels.max(1);
        if ch == 1 {
            self.render_fifo.extend_from_slice(samples);
        } else {
            self.render_fifo
                .extend(samples.chunks_exact(ch).map(|f| f.iter().sum::<f32>() / ch as f32));
        }
        let mut offset = 0;
        while self.render_fifo.len() - offset >= FRAME {
            let frame = &self.render_fifo[offset..offset + FRAME];
            let _ = self.front.process_render_f32(&[frame], &mut [&mut self.scratch_render[..]]);
            self.render_frames += 1;
            offset += FRAME;
        }
        self.render_fifo.drain(..offset);
        // Опорный сигнал без захвата (микрофон выключен) не должен копиться бесконечно.
        if self.render_fifo.len() > FRAME * 8 {
            let excess = self.render_fifo.len() - FRAME;
            self.render_fifo.drain(..excess);
        }
    }

    /// Микрофон (моно). Дописывает в `out` все готовые обработанные отсчёты
    /// (кратно кадру) и возвращает их число.
    pub fn process_capture(&mut self, samples: &[f32], out: &mut Vec<f32>) -> usize {
        if self.bypass() {
            out.extend_from_slice(samples);
            return samples.len();
        }
        self.capture_fifo.extend_from_slice(samples);
        let before = out.len();
        let mut offset = 0;
        while self.capture_fifo.len() - offset >= FRAME {
            self.scratch_a.copy_from_slice(&self.capture_fifo[offset..offset + FRAME]);
            self.process_frame();
            out.extend_from_slice(&self.scratch_a);
            self.capture_frames += 1;
            offset += FRAME;
        }
        self.capture_fifo.drain(..offset);
        out.len() - before
    }

    /// Один кадр в `scratch_a` → результат в `scratch_a`.
    fn process_frame(&mut self) {
        let mut noise_frame = false;
        let mut vad_now: Option<(f32, FrameStat, f32)> = None;
        Levels::ema(&mut self.levels.input, Levels::power(&self.scratch_a));
        if self.config.echo_cancellation {
            let _ = self.front.process_capture_f32(&[&self.scratch_a[..]], &mut [&mut self.scratch_b[..]]);
            std::mem::swap(&mut self.scratch_a, &mut self.scratch_b);
        }
        if self.config.noise_suppression {
            // Без AEC фильтр высоких частот — свой: RNNoise плохо снимает сетевой гул и
            // гул вентилятора (100–240 Гц), ФВЧ на 100 Гц добирает его, не трогая голос.
            if !self.config.echo_cancellation {
                self.highpass.process(&mut self.scratch_a);
            }
            let input_stat = FrameStat::of(&self.scratch_a);
            // RNNoise ждёт масштаб 16-битных отсчётов.
            for v in self.scratch_a.iter_mut() {
                *v *= 32767.0;
            }
            let vad = self.denoise.process_frame(&mut self.scratch_b[..], &self.scratch_a[..]);
            let before = Levels::power(&self.scratch_a) / (32767.0 * 32767.0);
            for (dst, src) in self.scratch_a.iter_mut().zip(self.scratch_b.iter()) {
                *dst = (src / 32767.0).clamp(-1.0, 1.0);
            }
            Levels::ema(&mut self.levels.speech, if vad > 0.5 { 1.0 } else { 0.0 });
            noise_frame = vad < 0.2;
            vad_now = Some((vad, input_stat, FrameStat::of(&self.scratch_a).db));
            if noise_frame {
                Levels::ema(&mut self.levels.noise_in, before);
                Levels::ema(&mut self.levels.noise_out, Levels::power(&self.scratch_a));
            }
        }
        if self.config.auto_gain {
            let _ = self.agc.process_capture_f32(&[&self.scratch_a[..]], &mut [&mut self.scratch_b[..]]);
            std::mem::swap(&mut self.scratch_a, &mut self.scratch_b);
        }
        if let Some((vad, input, denoised_db)) = vad_now {
            self.gate.process(vad, input, denoised_db, &mut self.scratch_a);
            Levels::ema(&mut self.levels.gate_closed, if self.gate.gain_db < -20.0 { 1.0 } else { 0.0 });
        }
        Levels::ema(&mut self.levels.output, Levels::power(&self.scratch_a));
        if noise_frame {
            Levels::ema(&mut self.levels.noise_final, Levels::power(&self.scratch_a));
        }
        if self.scratch_a.iter().any(|v| v.abs() >= 0.999) {
            self.levels.clipped_frames += 1;
        }
    }

    pub fn stats(&self) -> VoiceProcessingStats {
        let s = self.front.statistics();
        VoiceProcessingStats {
            erle_db: s.echo_return_loss_enhancement,
            echo_return_loss_db: s.echo_return_loss,
            delay_ms: s.delay_ms,
            residual_echo_likelihood: s.residual_echo_likelihood,
            render_frames: self.render_frames,
            capture_frames: self.capture_frames,
            input_dbfs: Levels::dbfs(self.levels.input.0),
            output_dbfs: Levels::dbfs(self.levels.output.0),
            noise_in_dbfs: Levels::dbfs(self.levels.noise_in.0),
            noise_out_dbfs: Levels::dbfs(self.levels.noise_out.0),
            ns_attenuation_db: match (self.levels.noise_in.0, self.levels.noise_out.0) {
                (Some(i), Some(o)) => Some(10.0 * (i.max(1e-12) / o.max(1e-12)).log10()),
                _ => None,
            },
            noise_final_dbfs: Levels::dbfs(self.levels.noise_final.0),
            gate_closed_ratio: self.levels.gate_closed.0,
            gate_depth_db: self.config.noise_suppression.then(|| self.gate.depth_db as f64),
            speech_ratio: self.levels.speech.0,
            clipped_frames: self.levels.clipped_frames,
            ref_lag_ms: self.align.lag.0,
            hold_ms: self.align.hold.0,
            ref_zero_frames: self.align.zero_frames,
            ref_forced_frames: self.align.forced_frames,
            ref_late_dropped: self.align.late_dropped,
        }
    }
}

/// Затвор по детектору речи RNNoise — стоит последним, после AGC.
///
/// RNNoise хорошо снимает ровный шум (вентилятор, гул: 15–26 дБ), но резкие — щелчки
/// клавиатуры и мыши, стук — пропускает почти целиком (стенд: 4–5 дБ), а AGC при тихой
/// речи их ещё и поднимает (щелчок громче, чем был на входе). Живые звонки 2026-11: «все
/// шумы слышны очень сильно», шумодав на Windows срезал 4–11 дБ. Поэтому вне речи выход
/// глушится до `FLOOR_DB`.
///
/// * Открывается, когда RNNoise слышит голос два кадра подряд: щелчок даёт одиночный
///   всплеск VAD, а по одному кадру затвор открывался бы на всё удержание. Выход RNNoise
///   отстаёт на кадр от входа, поэтому VAD следующего кадра уже известен — без задержки.
/// * VAD узнаёт начало фразы под шумом только через 2–3 кадра — затвор съел бы первый
///   слог. Поэтому он открывается заранее по скачку уровня над шумом (`ONSET_DB`) на
///   `PROVISIONAL` кадров; не подтвердил VAD — закрывается. Щелчок так не откроет: у него
///   энергия собрана в 1–5 мс кадра (`impulsive`), у голоса — размазана.
/// * Держится `HANGOVER` кадров после речи — хвосты слов и паузы между ними не рвутся.
struct SpeechGate {
    gain_db: f32,
    hangover: u32,
    provisional: u32,
    prev_vad: f32,
    prev: FrameStat,
    floor_db: f32,
    history: std::collections::VecDeque<f32>,
    in_floor_db: f32,
    in_history: std::collections::VecDeque<f32>,
    /// Уровень речи на входе (скользящее среднее по кадрам с речью, ~1 с).
    speech_db: f32,
    /// Текущая глубина (для статистики).
    depth_db: f32,
}

#[derive(Clone, Copy)]
struct FrameStat {
    db: f32,
    impulsive: bool,
}

impl FrameStat {
    fn of(frame: &[f32]) -> Self {
        // Четверти по 2.5 мс: у щелчка почти вся энергия в одной (стенд: медиана 0.83),
        // у голоса размазана (низкий мужской — 0.52, женский — 0.36).
        let quarter = (frame.len() / 4).max(1);
        let mut max = 0.0f64;
        let mut sum = 0.0f64;
        for chunk in frame.chunks(quarter) {
            let e = chunk.iter().map(|&v| v as f64 * v as f64).sum::<f64>();
            max = max.max(e);
            sum += e;
        }
        let db = (10.0 * (sum / frame.len().max(1) as f64).max(1e-12).log10()) as f32;
        Self { db, impulsive: sum > 0.0 && max / sum > SpeechGate::IMPULSE_SHARE }
    }
}

impl SpeechGate {
    const OPEN_VAD: f32 = 0.5;
    const HANGOVER: u32 = 30; // 300 мс
    const PROVISIONAL: u32 = 4; // 40 мс на подтверждение VAD
    const ONSET_DB: f32 = 12.0;
    const ONSET_INPUT_DB: f32 = 4.0;
    const IMPULSE_SHARE: f64 = 0.7;
    /// Окно оценки уровня шума: 1.5 с.
    const FLOOR_WINDOW: usize = 150;
    const FLOOR_DB: f32 = -40.0;
    const DEPTH_FROM_SNR_DB: f32 = 10.0;
    const DEPTH_FULL_SNR_DB: f32 = 20.0;
    /// Закрывается плавно: −40 дБ за ~150 мс.
    const RELEASE_DB_PER_FRAME: f32 = 2.7;

    fn new() -> Self {
        Self {
            gain_db: 0.0,
            hangover: Self::HANGOVER,
            provisional: 0,
            prev_vad: 1.0,
            prev: FrameStat { db: -120.0, impulsive: false },
            floor_db: -60.0,
            history: std::collections::VecDeque::with_capacity(Self::FLOOR_WINDOW),
            in_floor_db: -60.0,
            in_history: std::collections::VecDeque::with_capacity(Self::FLOOR_WINDOW),
            speech_db: -30.0,
            depth_db: Self::FLOOR_DB,
        }
    }

    /// Уровень шума — 20-й перцентиль уровней кадров за 1.5 с: шум после RNNoise скачет
    /// на 10 дБ от кадра к кадру, и минимум лежал бы на 10 дБ ниже обычного шума.
    fn percentile(history: &std::collections::VecDeque<f32>) -> f32 {
        let mut v: Vec<f32> = history.iter().copied().collect();
        if v.is_empty() {
            return -60.0;
        }
        let k = v.len() / 5;
        let (_, x, _) = v.select_nth_unstable_by(k, |a, b| a.total_cmp(b));
        *x
    }

    fn db_to_lin(db: f32) -> f32 {
        10f32.powf(db / 20.0)
    }

    /// `vad` и `input` — VAD и вход RNNoise этого вызова; `frame` — выход того же вызова
    /// (звук предыдущего входа).
    fn process(&mut self, vad: f32, input: FrameStat, denoised_db: f32, frame: &mut [f32]) {
        let cur = self.prev; // звук, который сейчас на выходе (по входу RNNoise)
        // Уровень над шумом — по выходу RNNoise: под ровным шумом начало фразы на входе
        // тонет (на 1–4 дБ громче шума), а после шумодава шума почти нет и голос виден.
        if self.history.len() == Self::FLOOR_WINDOW {
            self.history.pop_front();
        }
        self.history.push_back(denoised_db);
        self.floor_db = Self::percentile(&self.history);
        if self.in_history.len() == Self::FLOOR_WINDOW {
            self.in_history.pop_front();
        }
        self.in_history.push_back(cur.db);
        self.in_floor_db = Self::percentile(&self.in_history);
        let speech = vad.min(self.prev_vad) >= Self::OPEN_VAD;
        // Начало голоса: уровень над шумом и держится в следующем кадре (не тише чем на
        // 3 дБ). Щелчок за 10 мс затухает на 10+ дБ, а пришедший в конце кадра — резкий.
        let rising = input.db >= cur.db - 3.0 && !cur.impulsive && !input.impulsive;
        // И на входе хоть немного над шумом: после шумодава в паузах почти цифровая
        // тишина, и «+6 дБ» там дал бы любой хвост щелчка.
        let over_input = cur.db > self.in_floor_db + Self::ONSET_INPUT_DB && input.db > self.in_floor_db + Self::ONSET_INPUT_DB;
        let onset = !speech && rising && denoised_db > self.floor_db + Self::ONSET_DB && over_input;
        self.prev_vad = vad;
        self.prev = input;
        let open = if speech {
            self.hangover = Self::HANGOVER;
            self.provisional = 0;
            true
        } else if onset {
            self.provisional = Self::PROVISIONAL;
            true
        } else if self.provisional > 0 {
            self.provisional -= 1;
            true
        } else if self.hangover > 0 {
            self.hangover -= 1;
            true
        } else {
            false
        };
        if speech {
            self.speech_db += 0.01 * (cur.db - self.speech_db);
        }
        // Глубина — по тому, насколько речь громче шума. Под сильным ровным шумом (речь
        // громче на ≤ 10 дБ) начало слов едва выходит из шума, и жёсткий затвор резал бы
        // их (стенд, белый шум при SNR 5 дБ); там шум снимает RNNoise, а щелчки шум и так
        // маскирует. В тихой комнате (≥ 20 дБ) — полная глубина.
        let depth = ((self.speech_db - self.in_floor_db - Self::DEPTH_FROM_SNR_DB) / (Self::DEPTH_FULL_SNR_DB - Self::DEPTH_FROM_SNR_DB))
            .clamp(0.0, 1.0);
        let floor = Self::FLOOR_DB * depth;
        self.depth_db = floor;
        let target = if open { 0.0 } else { (self.gain_db - Self::RELEASE_DB_PER_FRAME).max(floor) };
        let (from, to) = (Self::db_to_lin(self.gain_db), Self::db_to_lin(target));
        self.gain_db = target;
        if from == 1.0 && to == 1.0 {
            return;
        }
        // Без ступеньки на границе: открывается за 1 мс (иначе съедал бы начало слова,
        // пришедшего в этом кадре), закрывается плавно через весь кадр.
        let ramp = if to > from { (frame.len() / 10).max(1) } else { frame.len().max(1) } as f32;
        for (i, v) in frame.iter_mut().enumerate() {
            *v *= from + (to - from) * ((i as f32 + 1.0) / ramp).min(1.0);
        }
    }
}

/// ФВЧ Баттерворта 2-го порядка (RBJ), состояние между кадрами.
struct Highpass {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}

impl Highpass {
    fn new(cutoff_hz: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * cutoff_hz / SAMPLE_RATE as f32;
        let alpha = w0.sin() / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let cos = w0.cos();
        let a0 = 1.0 + alpha;
        Self {
            b: [(1.0 + cos) / 2.0 / a0, -(1.0 + cos) / a0, (1.0 + cos) / 2.0 / a0],
            a: [-2.0 * cos / a0, (1.0 - alpha) / a0],
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn process(&mut self, frame: &mut [f32]) {
        for v in frame.iter_mut() {
            let x0 = *v;
            let y0 = self.b[0] * x0 + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
            self.x = [x0, self.x[0]];
            self.y = [y0, self.y[0]];
            *v = y0;
        }
    }
}

// ─── C ABI для macOS (Swift через CoreBridge.h) ───────────────────────────────
//
// Опорный сигнал (поток process tap) и микрофон (поток AUHAL) вызывают из разных
// потоков, поэтому обработчик лежит за мьютексом. Кадр — 10 мс, ожидание на мьютексе
// ничтожно по сравнению с бюджетом реального времени.

pub struct ZaliApm {
    inner: std::sync::Mutex<VoiceProcessor>,
    out: std::sync::Mutex<Vec<f32>>,
}

/// Создаёт обработчик. Освобождать — `zali_apm_free`.
#[no_mangle]
pub extern "C" fn zali_apm_new(aec: bool, ns: bool, agc: bool) -> *mut ZaliApm {
    let config = VoiceProcessingConfig { echo_cancellation: aec, noise_suppression: ns, auto_gain: agc };
    Box::into_raw(Box::new(ZaliApm {
        inner: std::sync::Mutex::new(VoiceProcessor::new(config)),
        out: std::sync::Mutex::new(Vec::with_capacity(FRAME * 4)),
    }))
}

/// # Safety
/// `apm` — указатель из `zali_apm_new`, после вызова не используется.
#[no_mangle]
pub unsafe extern "C" fn zali_apm_free(apm: *mut ZaliApm) {
    if !apm.is_null() {
        drop(Box::from_raw(apm));
    }
}

/// # Safety
/// `apm` — живой указатель из `zali_apm_new`.
#[no_mangle]
pub unsafe extern "C" fn zali_apm_set_config(apm: *mut ZaliApm, aec: bool, ns: bool, agc: bool) {
    let Some(apm) = apm.as_ref() else { return };
    if let Ok(mut p) = apm.inner.lock() {
        p.set_config(VoiceProcessingConfig { echo_cancellation: aec, noise_suppression: ns, auto_gain: agc });
    }
}

/// Опорный сигнал: `frames` кадров по `channels` чередующихся f32.
///
/// # Safety
/// `apm` — живой указатель; `samples` указывает на `frames * channels` f32.
#[no_mangle]
pub unsafe extern "C" fn zali_apm_push_render(apm: *mut ZaliApm, samples: *const f32, frames: usize, channels: u32) {
    let Some(apm) = apm.as_ref() else { return };
    if samples.is_null() || frames == 0 {
        return;
    }
    let ch = channels.max(1) as usize;
    let data = std::slice::from_raw_parts(samples, frames * ch);
    if let Ok(mut p) = apm.inner.lock() {
        p.push_render(data, ch);
    }
}

/// Микрофон: `frames` моно-отсчётов f32 на вход; в `out` (ёмкость `out_cap`)
/// пишутся готовые обработанные отсчёты, возвращается их число. Не поместившееся
/// остаётся до следующего вызова.
///
/// # Safety
/// `apm` — живой указатель; `input` — `frames` f32; `out` — `out_cap` f32.
#[no_mangle]
pub unsafe extern "C" fn zali_apm_process_capture(
    apm: *mut ZaliApm,
    input: *const f32,
    frames: usize,
    out: *mut f32,
    out_cap: usize,
) -> usize {
    let Some(apm) = apm.as_ref() else { return 0 };
    let (Ok(mut p), Ok(mut pending)) = (apm.inner.lock(), apm.out.lock()) else { return 0 };
    if !input.is_null() && frames > 0 {
        let data = std::slice::from_raw_parts(input, frames);
        p.process_capture(data, &mut pending);
    }
    if out.is_null() || out_cap == 0 {
        return 0;
    }
    let n = pending.len().min(out_cap);
    std::ptr::copy_nonoverlapping(pending.as_ptr(), out, n);
    pending.drain(..n);
    n
}

/// Опорный сигнал с меткой времени первого отсчёта `ts_ns` (host time в нс — те же
/// часы, что у `zali_apm_process_capture_at`).
///
/// # Safety
/// Как у `zali_apm_push_render`.
#[no_mangle]
pub unsafe extern "C" fn zali_apm_push_render_at(apm: *mut ZaliApm, samples: *const f32, frames: usize, channels: u32, ts_ns: i64) {
    let Some(apm) = apm.as_ref() else { return };
    if samples.is_null() || frames == 0 {
        return;
    }
    let ch = channels.max(1) as usize;
    let data = std::slice::from_raw_parts(samples, frames * ch);
    if let Ok(mut p) = apm.inner.lock() {
        p.push_render_at(data, ch, ts_ns);
    }
}

/// Микрофон с меткой времени первого отсчёта `ts_ns`; иначе как
/// `zali_apm_process_capture` (кадры, ждущие опорный сигнал, выйдут в следующих вызовах).
///
/// # Safety
/// Как у `zali_apm_process_capture`.
#[no_mangle]
pub unsafe extern "C" fn zali_apm_process_capture_at(
    apm: *mut ZaliApm,
    input: *const f32,
    frames: usize,
    ts_ns: i64,
    out: *mut f32,
    out_cap: usize,
) -> usize {
    let Some(apm) = apm.as_ref() else { return 0 };
    let (Ok(mut p), Ok(mut pending)) = (apm.inner.lock(), apm.out.lock()) else { return 0 };
    if !input.is_null() && frames > 0 {
        let data = std::slice::from_raw_parts(input, frames);
        p.process_capture_at(data, ts_ns, &mut pending);
    }
    if out.is_null() || out_cap == 0 {
        return 0;
    }
    let n = pending.len().min(out_cap);
    std::ptr::copy_nonoverlapping(pending.as_ptr(), out, n);
    pending.drain(..n);
    n
}

/// Статистика в JSON; освобождать — `zali_bus_free_string`.
///
/// # Safety
/// `apm` — живой указатель.
#[no_mangle]
pub unsafe extern "C" fn zali_apm_stats_json(apm: *mut ZaliApm) -> *mut std::os::raw::c_char {
    let json = apm
        .as_ref()
        .and_then(|a| a.inner.lock().ok().map(|p| serde_json::to_string(&p.stats()).unwrap_or_default()))
        .unwrap_or_else(|| "{}".to_string());
    std::ffi::CString::new(json).map(|c| c.into_raw()).unwrap_or(std::ptr::null_mut())
}
