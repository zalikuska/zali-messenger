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
//!  микрофон → [ФВЧ + AEC3 (sonora)] → [RNNoise] → [AGC2 адаптивный (sonora)] → выход
//! ```
//!
//! * AEC3 — чистый Rust-порт эхоподавителя WebRTC (`sonora`). На стенде не хуже
//!   C++-оригинала из Chromium: ERLE 53 против 47 дБ, речь в паузах дальней стороны
//!   проседает на 0.5 против 2.0 дБ.
//! * RNNoise (`nnnoiseless`) вместо шумодава WebRTC: на стационарном шуме глушит
//!   глубже (19–30 дБ) и почти не трогает речь (−0.1…−0.5 дБ против −1…−6 дБ),
//!   заодно добирает остаточное эхо (+20 дБ ERLE).
//! * AGC2 стоит последним, отдельным экземпляром: иначе он поднимал бы шум до того,
//!   как его уберёт RNNoise.
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
    /// Доля кадров с голосом (VAD RNNoise > 0.5) за ~5 с.
    pub speech_ratio: Option<f64>,
    /// Кадров с отсчётом на пределе (|x| ≥ 0.999) на выходе — с начала потока.
    pub clipped_frames: u64,
}

/// Скользящие уровни для статистики (обновляются на каждом кадре, читаются раз в 10 с).
#[derive(Default)]
struct Levels {
    // (среднее, сколько кадров вошло)
    input: (Option<f64>, u32),
    output: (Option<f64>, u32),
    noise_in: (Option<f64>, u32),
    noise_out: (Option<f64>, u32),
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

pub struct VoiceProcessor {
    config: VoiceProcessingConfig,
    front: AudioProcessing,
    agc: AudioProcessing,
    denoise: Box<nnnoiseless::DenoiseState<'static>>,
    highpass: Highpass,
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
            front,
            agc,
            denoise: nnnoiseless::DenoiseState::new(),
            highpass: Highpass::new(100.0),
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
        self.agc.apply_config(agc_config(config));
        if config.noise_suppression && !self.config.noise_suppression {
            self.denoise = nnnoiseless::DenoiseState::new();
        }
        if config.noise_suppression != self.config.noise_suppression {
            // Замеры шумодава — только за время, пока он включён.
            self.levels.noise_in = (None, 0);
            self.levels.noise_out = (None, 0);
            self.levels.speech = (None, 0);
        }
        self.config = config;
    }

    fn bypass(&self) -> bool {
        self.config == VoiceProcessingConfig::NONE
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
            if vad < 0.2 {
                Levels::ema(&mut self.levels.noise_in, before);
                Levels::ema(&mut self.levels.noise_out, Levels::power(&self.scratch_a));
            }
        }
        if self.config.auto_gain {
            let _ = self.agc.process_capture_f32(&[&self.scratch_a[..]], &mut [&mut self.scratch_b[..]]);
            std::mem::swap(&mut self.scratch_a, &mut self.scratch_b);
        }
        Levels::ema(&mut self.levels.output, Levels::power(&self.scratch_a));
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
            speech_ratio: self.levels.speech.0,
            clipped_frames: self.levels.clipped_frames,
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
