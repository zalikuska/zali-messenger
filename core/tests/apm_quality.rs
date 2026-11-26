//! Качество обработки голоса нативного захвата (src/audio_processing.rs).
//!
//!     cd core && cargo test --features apm --test apm_quality
//!
//! Речь — две записи `say` (Milena/ru — дальняя сторона, Fred/en — ближняя),
//! 24 кГц PCM16 в tests/fixtures, поднимаются до 48 кГц. Эхо-тракты синтетические:
//! прямой путь с задержкой + затухающие отражения (RT60), скачок задержки,
//! нелинейный динамик. Пороги — по стенду 2026-11-12 против C++ AEC3 из WebRTC
//! (того же, что в Chromium) с запасом: регресс порта или конвейера ловится, шум
//! измерений — нет.
#![cfg(feature = "apm")]

use zali_messenger_core::audio_processing::{VoiceProcessingConfig, VoiceProcessor, VoiceProcessingStats, FRAME, NS_DELAY_FRAMES, SAMPLE_RATE};

const SR: usize = SAMPLE_RATE as usize;

// ── фикстуры ────────────────────────────────────────────────────────────────

fn read_wav_pcm16(path: &str) -> (Vec<f32>, u32) {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    assert_eq!(&bytes[0..4], b"RIFF");
    let mut i = 12;
    let (mut rate, mut data) = (0u32, Vec::new());
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
        let body = &bytes[i + 8..(i + 8 + len).min(bytes.len())];
        if id == b"fmt " {
            assert_eq!(u16::from_le_bytes([body[0], body[1]]), 1, "PCM");
            assert_eq!(u16::from_le_bytes([body[2], body[3]]), 1, "mono");
            assert_eq!(u16::from_le_bytes([body[14], body[15]]), 16, "16-bit");
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
        } else if id == b"data" {
            data = body.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
        }
        i += 8 + len + (len & 1);
    }
    (data, rate)
}

/// 24 → 48 кГц: вставка нулей + НЧ-фильтр (окно Блэкмана, 63 отвода, срез 11 кГц).
fn upsample2(x: &[f32]) -> Vec<f32> {
    let taps = 63usize;
    let fc = 11_000.0 / SR as f64;
    let h: Vec<f64> = (0..taps)
        .map(|n| {
            let m = n as f64 - (taps - 1) as f64 / 2.0;
            let sinc = if m == 0.0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * m).sin() / (std::f64::consts::PI * m) };
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (taps - 1) as f64).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * n as f64 / (taps - 1) as f64).cos();
            2.0 * sinc * w
        })
        .collect();
    let mut z = vec![0.0f64; x.len() * 2];
    for (k, &v) in x.iter().enumerate() {
        z[2 * k] = v as f64;
    }
    (0..z.len())
        .map(|i| {
            let mut acc = 0.0;
            for (t, &c) in h.iter().enumerate() {
                if i >= t {
                    acc += c * z[i - t];
                }
            }
            acc as f32
        })
        .collect()
}

struct Fixtures {
    far: Vec<f32>,
    near: Vec<f32>,
    floor: Vec<f32>,
    len: usize,
}

fn fixtures() -> &'static Fixtures {
    static F: std::sync::OnceLock<Fixtures> = std::sync::OnceLock::new();
    F.get_or_init(|| {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
        let (far, r1) = read_wav_pcm16(&format!("{dir}/apm_far.wav"));
        let (near, r2) = read_wav_pcm16(&format!("{dir}/apm_near.wav"));
        assert_eq!((r1, r2), (24_000, 24_000));
        let (far, near) = (upsample2(&far), upsample2(&near));
        let len = far.len().min(near.len()) / FRAME * FRAME;
        let mut rng = Rng(7);
        let floor = (0..len).map(|_| rng.next() * 0.0005).collect();
        Fixtures { far: far[..len].to_vec(), near: near[..len].to_vec(), floor, len }
    })
}

// ── сигналы и метрики ───────────────────────────────────────────────────────

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

/// Разреженная импульсная характеристика комнаты: прямой путь + 60 затухающих отражений.
fn room_ir(delay_ms: f32, gain: f32, rt60: f32, seed: u64) -> Vec<(usize, f32)> {
    let mut r = Rng(seed);
    let d0 = (delay_ms / 1000.0 * SR as f32) as usize;
    let mut taps = vec![(d0, gain)];
    for k in 0..60 {
        let t = 0.002 + (k as f32 / 60.0) * rt60;
        taps.push((d0 + (t * SR as f32) as usize, gain * 0.45 * (-6.9 * t / rt60).exp() * r.next()));
    }
    taps
}

fn convolve(x: &[f32], taps: &[(usize, f32)]) -> Vec<f32> {
    let mut y = vec![0.0f32; x.len()];
    for &(d, a) in taps {
        for i in d..x.len() {
            y[i] += a * x[i - d];
        }
    }
    y
}

fn gate(x: &[f32], segs: &[(f32, f32)]) -> Vec<f32> {
    x.iter()
        .enumerate()
        .map(|(i, &v)| {
            let t = i as f32 / SR as f32;
            if segs.iter().any(|&(a, b)| t >= a && t < b) { v } else { 0.0 }
        })
        .collect()
}

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|&v| v as f64 * v as f64).sum()
}
fn db(a: f64, b: f64) -> f64 {
    10.0 * ((a + 1e-20) / (b + 1e-20)).log10()
}
fn scale_to(x: &mut [f32], target_energy: f64) {
    let g = (target_energy / energy(x)).sqrt() as f32;
    x.iter_mut().for_each(|v| *v *= g);
}

/// Прогон через обработчик кадрами по 10 мс (опорный сигнал перед захватом, как в жизни).
fn run(config: VoiceProcessingConfig, far: &[f32], mic: &[f32]) -> Vec<f32> {
    run_chunked(config, far, mic, &[FRAME])
}

fn run_chunked(config: VoiceProcessingConfig, far: &[f32], mic: &[f32], chunks: &[usize]) -> Vec<f32> {
    let mut p = VoiceProcessor::new(config);
    let mut out = Vec::with_capacity(mic.len());
    let (mut i, mut k) = (0usize, 0usize);
    while i < mic.len() {
        let n = chunks[k % chunks.len()].min(mic.len() - i);
        p.push_render(&far[i..i + n], 1);
        p.process_capture(&mic[i..i + n], &mut out);
        i += n;
        k += 1;
    }
    out.resize(mic.len(), 0.0);
    out
}

/// ERLE по окнам 0.5 с, где эхо есть: (медиана, минимум).
fn erle(mic: &[f32], out: &[f32], echo: &[f32], from_s: f32) -> (f64, f64) {
    let w = SR / 2;
    let mut v = vec![];
    let mut i = (from_s * SR as f32) as usize;
    while i + w <= out.len() {
        if energy(&echo[i..i + w]) / (w as f64) > 1e-5 {
            v.push(db(energy(&mic[i..i + w]), energy(&out[i..i + w])));
        }
        i += w;
    }
    assert!(!v.is_empty());
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (v[v.len() / 2], v[0])
}

fn bandpass(x: &[f32], f0: f32, q: f32) -> Vec<f32> {
    let w0 = 2.0 * std::f32::consts::PI * f0 / SR as f32;
    let alpha = w0.sin() / (2.0 * q);
    let (b0, b2, a0, a1, a2) = (alpha, -alpha, 1.0 + alpha, -2.0 * w0.cos(), 1.0 - alpha);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    x.iter()
        .map(|&v| {
            let y = (b0 * v + b2 * x2 - a1 * y1 - a2 * y2) / a0;
            x2 = x1;
            x1 = v;
            y2 = y1;
            y1 = y;
            y
        })
        .collect()
}
fn frame_db(x: &[f32]) -> Vec<f64> {
    x.chunks(FRAME).map(|c| (energy(c) / FRAME as f64 + 1e-12).log10() * 10.0).collect()
}
fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let (mut xy, mut xx, mut yy) = (0.0, 0.0, 0.0);
    for i in 0..a.len() {
        let (p, q) = (a[i] - ma, b[i] - mb);
        xy += p * q;
        xx += p * p;
        yy += q * q;
    }
    xy / (xx.sqrt() * yy.sqrt() + 1e-20)
}

/// Сходство речи (упрощённый STOI): корреляция огибающих 10-мс кадров в пяти полосах
/// 300–4800 Гц по кадрам, где чистая речь звучит и `mask` истинна; сдвиг 0–4 кадра.
/// Возвращает (сходство, изменение уровня речи в дБ в тех же полосах — инфранизы ниже
/// 200 Гц, которые режет любой ФВЧ, в разборчивость не входят). Корреляция формы волны
/// тут не годится: банки фильтров APM сдвигают фазу, не портя звучание.
fn similarity(out: &[f32], clean: &[f32], from_s: f32, mask: &dyn Fn(usize) -> bool) -> (f64, f64) {
    let f0 = (from_s * SR as f32) as usize / FRAME;
    let ce = frame_db(clean);
    let filtered: Vec<(Vec<f32>, Vec<f32>)> =
        [300.0f32, 600.0, 1200.0, 2400.0, 4800.0].iter().map(|&fc| (bandpass(clean, fc, 1.2), bandpass(out, fc, 1.2))).collect();
    let bands: Vec<(Vec<f64>, Vec<f64>)> = filtered.iter().map(|(c, o)| (frame_db(c), frame_db(o))).collect();
    let mut best = (f64::MIN, 0.0);
    for lag in 0..5usize {
        let frames: Vec<usize> =
            (f0..ce.len().min(out.len() / FRAME - lag)).filter(|&f| ce[f] > -45.0 && mask(f)).collect();
        assert!(frames.len() >= 20, "мало кадров речи для сравнения");
        let sim = bands
            .iter()
            .map(|(cb, ob)| {
                let a: Vec<f64> = frames.iter().map(|&f| cb[f]).collect();
                let b: Vec<f64> = frames.iter().map(|&f| ob[f + lag]).collect();
                pearson(&a, &b)
            })
            .sum::<f64>()
            / bands.len() as f64;
        let (mut ec, mut eo) = (0.0, 0.0);
        for (c, o) in &filtered {
            for &f in &frames {
                ec += energy(&c[f * FRAME..f * FRAME + FRAME]);
                eo += energy(&o[(f + lag) * FRAME..(f + lag) * FRAME + FRAME]);
            }
        }
        if sim > best.0 {
            best = (sim, db(eo, ec));
        }
    }
    best
}

const AEC: VoiceProcessingConfig = VoiceProcessingConfig { echo_cancellation: true, noise_suppression: false, auto_gain: false };
const AEC_NS: VoiceProcessingConfig = VoiceProcessingConfig { echo_cancellation: true, noise_suppression: true, auto_gain: false };
const NS: VoiceProcessingConfig = VoiceProcessingConfig { echo_cancellation: false, noise_suppression: true, auto_gain: false };
const AGC: VoiceProcessingConfig = VoiceProcessingConfig { echo_cancellation: false, noise_suppression: true, auto_gain: true };

// ── тесты ───────────────────────────────────────────────────────────────────

#[test]
fn echo_is_cancelled_when_only_the_far_side_talks() {
    let fx = fixtures();
    for &(delay, gain, rt60) in &[(30.0, 0.6, 0.2), (80.0, 0.8, 0.3), (150.0, 0.7, 0.4), (250.0, 0.5, 0.35)] {
        let echo = convolve(&fx.far, &room_ir(delay, gain, rt60, 3));
        let mic: Vec<f32> = echo.iter().zip(&fx.floor).map(|(a, b)| a + b).collect();
        let (med, min) = erle(&mic, &run(AEC, &fx.far, &mic), &echo, 2.0);
        assert!(med >= 40.0 && min >= 25.0, "AEC, задержка {delay} мс: ERLE медиана {med:.1}, минимум {min:.1} дБ");
        let (med2, _) = erle(&mic, &run(VoiceProcessingConfig::ALL, &fx.far, &mic), &echo, 2.0);
        assert!(med2 >= 40.0, "весь конвейер, задержка {delay} мс: ERLE медиана {med2:.1} дБ");
    }
}

#[test]
fn echo_through_a_distorting_speaker_is_cancelled() {
    let fx = fixtures();
    let driven: Vec<f32> = fx.far.iter().map(|&x| (3.0 * x).tanh() / 3.0 * 1.6).collect();
    let echo = convolve(&driven, &room_ir(80.0, 0.8, 0.3, 5));
    let mic: Vec<f32> = echo.iter().zip(&fx.floor).map(|(a, b)| a + b).collect();
    let (med, min) = erle(&mic, &run(AEC_NS, &fx.far, &mic), &echo, 2.0);
    assert!(med >= 40.0 && min >= 20.0, "нелинейный динамик: ERLE медиана {med:.1}, минимум {min:.1} дБ");
}

#[test]
fn canceller_recovers_after_the_echo_delay_jumps() {
    let fx = fixtures();
    let jump = 8 * SR;
    let e1 = convolve(&fx.far, &room_ir(80.0, 0.8, 0.3, 9));
    let e2 = convolve(&fx.far, &room_ir(200.0, 0.8, 0.3, 9));
    let echo: Vec<f32> = (0..fx.len).map(|i| if i < jump { e1[i] } else { e2[i] }).collect();
    let mic: Vec<f32> = echo.iter().zip(&fx.floor).map(|(a, b)| a + b).collect();
    let out = run(AEC_NS, &fx.far, &mic);
    // C++ AEC3 восстанавливается так же: провал первые ~1.5 с — свойство алгоритма.
    let w = SR / 4;
    let mut i = jump + 2 * SR;
    while i + w <= (jump + 4 * SR).min(fx.len) {
        if energy(&echo[i..i + w]) / (w as f64) > 1e-5 {
            let v = db(energy(&mic[i..i + w]), energy(&out[i..i + w]));
            assert!(v >= 25.0, "через {:.2} с после скачка ERLE {v:.1} дБ", (i - jump) as f32 / SR as f32);
        }
        i += w;
    }
}

#[test]
fn near_speech_survives_a_real_conversation() {
    let fx = fixtures();
    let far_segs = [(0.0f32, 5.0f32), (7.5, 12.0), (15.0, 18.0)];
    let near_segs = [(4.2f32, 7.8f32), (11.3, 15.4)];
    let far = gate(&fx.far, &far_segs);
    let near = gate(&fx.near, &near_segs);
    let far_on = move |f: usize| {
        let t = (f * FRAME) as f32 / SR as f32;
        far_segs.iter().any(|&(a, b)| t >= a && t < b)
    };
    // (эхо относительно ближней речи, мин. сходство в паузах дальней, мин. сходство в двойном разговоре, мин. уровень в двойном)
    // С DFN3 (2026-11-25): паузы 0.971 / 0.951, двойной 0.645 / 0.580; с RNNoise было
    // 0.991 / 0.979 и 0.712 / 0.609. Под эхом DFN3 подрезает ближнюю речь сильнее —
    // держат предел ослабления на время реплик собеседника и медленный нормализатор.
    for &(enr, near_only_min, dt_min, dt_level_min) in &[(0.0f64, 0.95, 0.60, -4.5), (5.0, 0.95, 0.50, -6.5)] {
        let mut echo = convolve(&far, &room_ir(80.0, 0.8, 0.3, 17));
        scale_to(&mut echo, energy(&near) * 10f64.powf(enr / 10.0));
        let mic: Vec<f32> = (0..fx.len).map(|i| echo[i] + near[i] + fx.floor[i]).collect();
        let out = run(AEC_NS, &far, &mic);
        let (s_only, l_only) = similarity(&out, &near, 2.0, &|f| !far_on(f));
        let (s_dt, l_dt) = similarity(&out, &near, 2.0, &far_on);
        let (med, _) = erle(&mic, &out, &echo, 2.0);
        assert!(s_only >= near_only_min && l_only >= -1.5, "ENR {enr}: речь в паузах {s_only:.3} ({l_only:+.1} дБ)");
        assert!(s_dt >= dt_min && l_dt >= dt_level_min, "ENR {enr}: двойной разговор {s_dt:.3} ({l_dt:+.1} дБ)");
        assert!(med >= 40.0, "ENR {enr}: ERLE медиана {med:.1} дБ");
    }
}

#[test]
fn stationary_noise_is_removed_without_eating_speech() {
    let fx = fixtures();
    let mut rng = Rng(21);
    let len = fx.len;
    let white: Vec<f32> = (0..len).map(|_| rng.next()).collect();
    let pink = {
        let (mut b0, mut b1, mut b2) = (0.0f32, 0.0f32, 0.0f32);
        (0..len)
            .map(|_| {
                let w = rng.next();
                b0 = 0.997 * b0 + 0.029591 * w;
                b1 = 0.985 * b1 + 0.032534 * w;
                b2 = 0.95 * b2 + 0.048056 * w;
                b0 + b1 + b2 + 0.05 * w
            })
            .collect::<Vec<f32>>()
    };
    let fan_broadband = {
        let mut lp = 0.0f32;
        (0..len).map(|_| { lp = 0.98 * lp + 0.02 * rng.next(); 3.0 * lp }).collect::<Vec<f32>>()
    };
    let fan = {
        let mut lp = 0.0f32;
        (0..len)
            .map(|i| {
                let t = i as f32 / SR as f32;
                lp = 0.98 * lp + 0.02 * rng.next();
                0.4 * (2.0 * std::f32::consts::PI * 120.0 * t).sin() + 0.2 * (2.0 * std::f32::consts::PI * 240.0 * t).sin() + 3.0 * lp
            })
            .collect::<Vec<f32>>()
    };
    let zeros = vec![0.0f32; len];
    let near_e = energy(&fx.near);
    let ce = frame_db(&fx.near);
    // Порог ослабления ≥ 18 дБ: DFN3 (2026-11-25) — белый 29.4, розовый 22.7, вентилятор
    // 22.6, вентилятор с гулом 120/240 Гц 24.1 (у RNNoise было 18–26 и 13.9 на гуле). Под
    // таким шумом (SNR 5 дБ) предел ослабления шумодава — 30 дБ: без него DFN3 съедал тихие
    // куски речи вместе с шумом (сходство на белом 0.71 против 0.88 на входе).
    for (name, mut noise, min_atten) in
        [("белый", white, 18.0), ("розовый", pink, 18.0), ("вентилятор без гула", fan_broadband, 18.0), ("вентилятор с гулом", fan, 18.0)]
    {
        scale_to(&mut noise, near_e / 10f64.powf(0.5)); // SNR 5 дБ
        let mic: Vec<f32> = (0..len).map(|i| fx.near[i] + noise[i]).collect();
        let out = run(NS, &zeros, &mic);
        // ослабление шума — в паузах речи (кадры тише −70 дБ), с учётом задержки в кадр
        let (mut em, mut eo) = (0.0, 0.0);
        let d = NS_DELAY_FRAMES;
        for f in (SR / FRAME)..ce.len() - d {
            if ce[f] < -70.0 && ce[f + 1] < -70.0 {
                em += energy(&mic[f * FRAME..f * FRAME + FRAME]);
                eo += energy(&out[(f + d) * FRAME..(f + d) * FRAME + FRAME]);
            }
        }
        let atten = db(em, eo);
        let (sim_in, _) = similarity(&mic, &fx.near, 1.0, &|_| true);
        let (sim, level) = similarity(&out, &fx.near, 1.0, &|_| true);
        assert!(atten >= min_atten, "{name}: шум ослаблен всего на {atten:.1} дБ");
        assert!(level >= -1.5, "{name}: речь просела на {level:.1} дБ");
        assert!(sim >= sim_in - 0.03, "{name}: сходство речи {sim:.3} против {sim_in:.3} до обработки");
    }
}

#[test]
fn quiet_speech_is_brought_up_without_clipping() {
    let fx = fixtures();
    let quiet: Vec<f32> = fx.near.iter().map(|&x| x * 0.05).collect();
    let zeros = vec![0.0f32; fx.len];
    let out = run(AGC, &zeros, &quiet);
    let gain = db(energy(&out[6 * SR..]), energy(&quiet[6 * SR..]));
    let peak = out.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
    assert!(gain >= 15.0, "AGC поднял тихую речь всего на {gain:+.1} дБ");
    assert!(peak <= 1.0, "клиппинг: пик {peak}");
}

#[test]
fn loud_double_talk_through_the_full_pipeline_never_clips() {
    let fx = fixtures();
    let mut echo = convolve(&fx.far, &room_ir(80.0, 0.8, 0.3, 11));
    scale_to(&mut echo, energy(&fx.near) * 10f64.powf(0.5));
    let mic: Vec<f32> = (0..fx.len).map(|i| (echo[i] + fx.near[i]) * 1.8 + fx.floor[i]).collect();
    let out = run(VoiceProcessingConfig::ALL, &fx.far, &mic);
    assert!(out.iter().all(|v| v.is_finite() && v.abs() <= 1.0), "выход вне [-1, 1]");
}

/// Как в приложении: опорный сигнал приходит из другого потока на `lag_ms` позже, чем
/// микрофон за то же время, пачками по `burst_ms` (с метками времени или без), пока
/// отсчёт меньше `render_until`. Микрофон — по 10 мс.
fn run_threaded(
    config: VoiceProcessingConfig,
    far: &[f32],
    mic: &[f32],
    lag_ms: usize,
    burst_ms: usize,
    timed: bool,
    render_until: usize,
) -> (Vec<f32>, VoiceProcessingStats) {
    let ns = |samples: usize| (samples as i64) * 1_000_000_000 / SR as i64;
    let (lag, burst) = (lag_ms * SR / 1000, burst_ms * SR / 1000);
    let mut p = VoiceProcessor::new(config);
    let mut out = Vec::with_capacity(mic.len());
    let (mut r, mut i) = (0usize, 0usize);
    while i < mic.len() {
        let n = FRAME.min(mic.len() - i);
        // Пачка опорного [r, r+burst) доходит к обработчику в момент r+burst+lag.
        while r + burst <= far.len().min(render_until) && r + burst + lag <= i + n {
            if timed {
                p.push_render_at(&far[r..r + burst], 1, ns(r));
            } else {
                p.push_render(&far[r..r + burst], 1);
            }
            r += burst;
        }
        if timed {
            p.process_capture_at(&mic[i..i + n], ns(i), &mut out);
        } else {
            p.process_capture(&mic[i..i + n], &mut out);
        }
        i += n;
    }
    let stats = p.stats();
    // Выход отстаёт от входа на то, что ещё ждёт опорный: выравниваем к началу.
    out.resize(mic.len(), 0.0);
    (out, stats)
}

#[test]
fn late_reference_is_aligned_by_timestamps() {
    let fx = fixtures();
    let echo = convolve(&fx.far, &room_ir(5.0, 0.6, 0.25, 3));
    let mic: Vec<f32> = echo.iter().zip(&fx.floor).map(|(a, b)| a + b).collect();
    for &(lag, burst) in &[(10usize, 10usize), (40, 10), (40, 20), (90, 30)] {
        let (out, _) = run_threaded(AEC, &fx.far, &mic, lag, burst, false, usize::MAX);
        let (untimed, _) = erle(&mic, &out, &echo, 2.0);
        // Как было в приложении: эхоподавитель эхо не находит.
        assert!(untimed < 30.0, "без меток, опоздание {lag} мс: ERLE {untimed:.1} — стенд больше не воспроизводит сбой");
        let (out, st) = run_threaded(AEC, &fx.far, &mic, lag, burst, true, usize::MAX);
        let delay = st.hold_ms.unwrap();
        // Выход отстаёт на ожидание (≤ 0.1 с) — окна ERLE по 0.5 с это почти не трогает.
        let (med, min) = erle(&mic, &out, &echo, 2.0);
        eprintln!("опоздание {lag} мс пачками {burst}: без меток {untimed:.1}, с метками {med:.1}/{min:.1} дБ, ожидание {delay:.1} мс, тишины {}", st.ref_zero_frames);
        assert!(med >= 40.0 && min >= 20.0, "с метками, опоздание {lag} мс пачками {burst}: ERLE медиана {med:.1}, минимум {min:.1}");
        // Микрофон ждёт ровно опоздание (плюс пачка), не больше.
        assert!(delay <= (lag + burst) as f64 + 12.0, "ожидание {delay:.1} мс при опоздании {lag}+{burst}");
        assert_eq!(st.ref_forced_frames, 0);
    }
}

#[test]
fn silent_output_does_not_hold_the_mic() {
    // WASAPI loopback в тишине пакетов не шлёт: опорный кончился на 4-й секунде, а
    // микрофон должен идти дальше без задержки (не дольше порога молчания).
    let fx = fixtures();
    let mic: Vec<f32> = fx.near.iter().zip(&fx.floor).map(|(a, b)| a + b).collect();
    let (_, st) = run_threaded(VoiceProcessingConfig::ALL, &fx.far, &mic, 20, 10, true, 4 * SR);
    let held_ms = (mic.len() - st.capture_frames as usize * FRAME) * 1000 / SR;
    assert!(held_ms <= 130, "микрофон ждёт {held_ms} мс после того, как вывод замолчал");
    assert!(st.ref_zero_frames > 0, "вместо молчащего опорного должна идти тишина");
}

/// Резкие шумы: пачки щелчков клавиатуры (3–12 щелчков по 4–14 мс с шагом 70–200 мс,
/// между пачками 0.3–1.5 с), пик щелчка — `peak`.
fn keyboard(len: usize, peak: f32, seed: u64) -> Vec<f32> {
    let mut r = Rng(seed);
    let mut y = vec![0.0f32; len];
    let mut t = SR / 2;
    while t < len {
        let n = 3 + ((r.next().abs() * 10.0) as usize);
        for _ in 0..n {
            let dur = (0.004 + 0.01 * r.next().abs()) * SR as f32;
            let f = 1500.0 + 2500.0 * r.next().abs();
            let a = peak * (0.5 + 0.5 * r.next().abs());
            for k in 0..dur as usize {
                if t + k >= len {
                    break;
                }
                let env = (-(k as f32) / (dur * 0.3)).exp();
                y[t + k] += a * env * (0.6 * r.next() + 0.4 * (2.0 * std::f32::consts::PI * f * k as f32 / SR as f32).sin());
            }
            t += ((0.07 + 0.13 * r.next().abs()) * SR as f32) as usize;
        }
        t += ((0.3 + 1.2 * r.next().abs()) * SR as f32) as usize;
    }
    y
}

#[test]
fn keyboard_clicks_between_phrases_are_muted() {
    // Синтетические щелчки (шум + тон, 4–14 мс). С RNNoise в паузах было 4–5 дБ, а AGC при
    // тихой речи поднимал их громче, чем было; затвор по VAD довёл до 43 / 40 дБ. С DFN3
    // и затвором по его оценке SNR (2026-11-25): 77.6 / 73.2 дБ, речь 0.959 / 0.844.
    let fx = fixtures();
    let len = fx.len;
    let zeros = vec![0.0f32; len];
    let segs: Vec<(f32, f32)> = (0..10).map(|k| (k as f32 * 6.0, k as f32 * 6.0 + 3.0)).collect();
    let pause = |i: usize| {
        let t = i as f32 / SR as f32;
        t > 1.0 && !segs.iter().any(|&(a, b)| t >= a - 0.05 && t < b + 0.4)
    };
    for &(peak, near_gain, config, min_atten, min_sim) in &[(0.1f32, 1.0f32, NS, 55.0, 0.93), (0.03, 0.2, AGC, 50.0, 0.75)] {
        let near: Vec<f32> = gate(&fx.near, &segs).iter().map(|v| v * near_gain).collect();
        let clicks = keyboard(len, peak, 5);
        let mut lp = 0.0f32;
        let mut r = Rng(3);
        let mic: Vec<f32> = (0..len)
            .map(|i| {
                lp = 0.98 * lp + 0.02 * r.next();
                near[i] + clicks[i] + lp * 0.003
            })
            .collect();
        let out = run(config, &zeros, &mic);
        let (mut em, mut eo) = (0.0, 0.0);
        let d = NS_DELAY_FRAMES * FRAME;
        for i in 0..len - d {
            if pause(i) {
                em += (mic[i] as f64).powi(2);
                eo += (out[i + d] as f64).powi(2);
            }
        }
        let atten = db(em, eo);
        let (sim, level) = similarity(&out, &near, 1.0, &|_| true);
        assert!(atten >= min_atten, "щелчки {peak}, речь ×{near_gain}: в паузах ослаблены всего на {atten:.1} дБ");
        assert!(sim >= min_sim && level >= -1.5, "щелчки {peak}, речь ×{near_gain}: речь {sim:.3} ({level:+.1} дБ)");
    }
}

/// Реалистичные удары: короткая вспышка (0.3–1 мс) через резонаторы корпуса (`modes`:
/// частота, затухание в мс) и комнату (RT60 0.25 с). `typing` — пачки клавиш, иначе
/// одиночные удары (у мыши — с отпусканием через 60–120 мс). Пик — `peak`.
fn resonant_hits(len: usize, peak: f32, seed: u64, modes: &[(f32, f32)], typing: bool) -> Vec<f32> {
    let mut r = Rng(seed);
    let mut exc = vec![0.0f32; len];
    let mut t = SR / 2;
    while t < len {
        let n = if typing { 4 + (r.next().abs() * 12.0) as usize } else { 1 + (r.next().abs() * 3.0) as usize };
        for _ in 0..n {
            let a = peak * (0.5 + 0.5 * r.next().abs());
            let d = ((0.0003 + 0.0007 * r.next().abs()) * SR as f32) as usize;
            for k in 0..d {
                if t + k < len {
                    exc[t + k] += a * r.next();
                }
            }
            if !typing {
                let t2 = t + ((0.06 + 0.06 * r.next().abs()) * SR as f32) as usize;
                for k in 0..d {
                    if t2 + k < len {
                        exc[t2 + k] += 0.6 * a * r.next();
                    }
                }
            }
            t += ((if typing { 0.08 + 0.15 * r.next().abs() } else { 0.25 + 0.5 * r.next().abs() }) * SR as f32) as usize;
        }
        t += ((0.4 + 1.5 * r.next().abs()) * SR as f32) as usize;
    }
    let mut y = vec![0.0f32; len];
    for &(f, tau_ms) in modes {
        let rr = (-1.0 / (tau_ms / 1000.0 * SR as f32)).exp();
        let w = 2.0 * std::f32::consts::PI * f / SR as f32;
        let (a1, a2) = (2.0 * rr * w.cos(), -rr * rr);
        let (mut y1, mut y2) = (0.0f32, 0.0f32);
        for i in 0..len {
            let v = exc[i] + a1 * y1 + a2 * y2;
            y2 = y1;
            y1 = v;
            y[i] += v * (1.0 - rr);
        }
    }
    let mut out = convolve(&y, &room_ir(0.0, 0.5, 0.25, seed + 1));
    let m = out.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
    out.iter_mut().for_each(|v| *v *= peak / m.max(1e-9));
    out
}

#[test]
fn realistic_clicks_are_removed_in_pauses_and_over_speech() {
    // Жалоба живых звонков 2026-11 с RNNoise: «все клики слышно идеально». RNNoise снимал
    // такие удары на 1–9 дБ в паузах и на 0–4 дБ поверх речи. Весь конвейер шумодава с
    // DFN3 и затвором, полная обработка каждого кадра (2026-11-26, `new_denoiser`): в паузах
    // клавиатура 51.6, мышь 73, стук 28 дБ; поверх речи клавиатура 3.9, мышь — целиком,
    // стук 8.7 дБ; речь между ударами 0.94–0.99, под ударами 0.97–0.98.
    // До 2026-11-26 тут стояло «поверх речи — целиком» (127–136 дБ): артефакт. DFN3 тогда
    // пропускал deep filter на кадрах с SNR 20–30 дБ и портил чистую речь сам, прогон без
    // щелчков выходил тише прогона со щелчками, разность уходила в минус. Честно поверх
    // речи клавиатура снимается примерно как у RNNoise.
    let fx = fixtures();
    let len = fx.len;
    let zeros = vec![0.0f32; len];
    let segs: Vec<(f32, f32)> = (0..10).map(|k| (k as f32 * 6.0, k as f32 * 6.0 + 3.0)).collect();
    let pause = |i: usize| {
        let t = i as f32 / SR as f32;
        t > 1.0 && !segs.iter().any(|&(a, b)| t >= a - 0.05 && t < b + 0.4)
    };
    let phrases = gate(&fx.near, &segs);
    let mut r = Rng(3);
    let mut lp = 0.0f32;
    let floor: Vec<f32> = (0..len).map(|_| { lp = 0.98 * lp + 0.02 * r.next(); lp * 0.003 }).collect();
    let d = NS_DELAY_FRAMES * FRAME;
    // (имя, удары, мин. ослабление в паузах, мин. ослабление поверх речи)
    let sources = [
        ("клавиатура", resonant_hits(len, 0.15, 11, &[(450.0, 8.0), (900.0, 6.0), (2600.0, 4.0), (5200.0, 2.5)], true), 40.0, 2.5),
        ("мышь", resonant_hits(len, 0.15, 9, &[(2300.0, 4.0), (4100.0, 3.0), (6800.0, 2.0)], false), 50.0, 20.0),
        ("стук по столу", resonant_hits(len, 0.3, 13, &[(120.0, 25.0), (260.0, 15.0), (700.0, 8.0)], false), 20.0, 5.0),
    ];
    for (name, clicks, min_pause, min_over) in &sources {
        let (min_pause, min_over) = (*min_pause, *min_over);
        // В паузах между фразами.
        let mic: Vec<f32> = (0..len).map(|i| phrases[i] + clicks[i] + floor[i]).collect();
        let out = run(NS, &zeros, &mic);
        let (mut em, mut eo) = (0.0, 0.0);
        for i in 0..len - d {
            if pause(i) {
                em += (mic[i] as f64).powi(2);
                eo += (out[i + d] as f64).powi(2);
            }
        }
        let atten = db(em, eo);
        let (sim, level) = similarity(&out, &phrases, 1.0, &|_| true);
        // Поверх сплошной речи: насколько выход со щелчками громче выхода без них в кадрах,
        // где щелчок не тише речи на 10+ дБ, — против того, насколько был громче вход.
        let mic2: Vec<f32> = (0..len).map(|i| fx.near[i] + clicks[i] + floor[i]).collect();
        let clean2: Vec<f32> = (0..len).map(|i| fx.near[i] + floor[i]).collect();
        let (o2, oc) = (run(NS, &zeros, &mic2), run(NS, &zeros, &clean2));
        let (sp, cl) = (frame_db(&fx.near), frame_db(clicks));
        let (mut a_in, mut b_in, mut a_out, mut b_out) = (0.0, 0.0, 0.0, 0.0);
        for f in (SR / FRAME)..len / FRAME - NS_DELAY_FRAMES {
            if sp[f] > -40.0 && cl[f] > sp[f] - 10.0 {
                a_in += energy(&mic2[f * FRAME..f * FRAME + FRAME]);
                b_in += energy(&clean2[f * FRAME..f * FRAME + FRAME]);
                let g = f + NS_DELAY_FRAMES;
                a_out += energy(&o2[g * FRAME..g * FRAME + FRAME]);
                b_out += energy(&oc[g * FRAME..g * FRAME + FRAME]);
            }
        }
        let over = db(a_in - b_in, (a_out - b_out).max(1e-12));
        let (sim2, _) = similarity(&o2, &fx.near, 1.0, &|_| true);
        assert!(atten >= min_pause, "{name}: в паузах ослаблены всего на {atten:.1} дБ");
        assert!(over >= min_over, "{name}: поверх речи ослаблены всего на {over:.1} дБ");
        assert!(sim >= 0.92 && level >= -1.5, "{name}: речь между ударами {sim:.3} ({level:+.1} дБ)");
        assert!(sim2 >= 0.95, "{name}: речь под ударами {sim2:.3}");
    }
}

#[test]
fn quiet_speech_survives_the_denoiser() {
    // DFN3 зависит от абсолютного уровня: речь тише ~−42 дБFS он целиком принимал за шум
    // (−46 дБ на выходе на −47 дБFS), а встроенный микрофон MacBook даёт −30…−45. Держит
    // нормализатор уровня перед шумодавом.
    let fx = fixtures();
    let zeros = vec![0.0f32; fx.len];
    let mut r = Rng(99);
    // (усиление речи, мин. сходство, мин. уровень). Измерено: 0.979, 0.960, 0.963 (−0.3…−0.4
    // дБ); на −55 дБFS (×0.02) — 0.816, −5.5 дБ: шум пола там всего на 25 дБ тише речи.
    for (gain, min_sim, min_level) in [(1.0f32, 0.94, -1.5), (0.1, 0.92, -1.5), (0.05, 0.92, -1.5), (0.02, 0.75, -8.0)] {
        let speech: Vec<f32> = fx.near.iter().map(|v| v * gain).collect();
        let mic: Vec<f32> = speech.iter().map(|v| v + r.next() * 0.00017).collect(); // пол −80 дБFS
        let out = run(NS, &zeros, &mic);
        let scale = 1.0 / gain;
        let (o, c): (Vec<f32>, Vec<f32>) = out.iter().zip(&speech).map(|(a, b)| (a * scale, b * scale)).unzip();
        let (sim, level) = similarity(&o, &c, 1.0, &|_| true);
        assert!(sim >= min_sim && level >= min_level, "речь ×{gain}: {sim:.3} ({level:+.1} дБ)");
    }
}

#[test]
fn aec_never_outputs_digital_silence() {
    // DFN3 после 60 мс точных нулей засыпает и сбрасывает свою нормировку — нельзя, чтобы
    // их давал AEC3, пока говорит только собеседник (эхо вычтено целиком).
    let fx = fixtures();
    let echo = convolve(&fx.far, &room_ir(80.0, 0.8, 0.3, 3));
    let mic: Vec<f32> = echo.iter().zip(&fx.floor).map(|(a, b)| a + b).collect();
    let out = run(AEC, &fx.far, &mic);
    let zero = out[SR..].chunks_exact(FRAME).filter(|c| c.iter().all(|&v| v == 0.0)).count();
    assert_eq!(zero, 0, "кадров точной тишины на выходе AEC: {zero}");
}

#[test]
fn disabled_processing_is_an_exact_passthrough() {
    let fx = fixtures();
    let mic: Vec<f32> = fx.near[..SR].to_vec();
    let out = run_chunked(VoiceProcessingConfig::NONE, &fx.far[..SR], &mic, &[137, 512, 480]);
    assert_eq!(out, mic);
}

#[test]
fn output_does_not_depend_on_device_block_size() {
    let fx = fixtures();
    let n = 4 * SR;
    let echo = convolve(&fx.far[..n], &room_ir(80.0, 0.8, 0.3, 23));
    let mic: Vec<f32> = (0..n).map(|i| echo[i] + fx.near[i] * 0.5).collect();
    let a = run(VoiceProcessingConfig::ALL, &fx.far[..n], &mic);
    // опорный сигнал и микрофон тем же темпом, но блоками, как отдают CoreAudio/WASAPI
    let b = run_chunked(VoiceProcessingConfig::ALL, &fx.far[..n], &mic, &[512, 441, 137, 1024]);
    let done = n / FRAME * FRAME - 2 * FRAME;
    assert_eq!(&a[..done], &b[..done]);
}

#[test]
fn stereo_reference_is_downmixed() {
    let fx = fixtures();
    let n = 3 * SR;
    let echo = convolve(&fx.far[..n], &room_ir(80.0, 0.8, 0.3, 29));
    let mic: Vec<f32> = echo.clone();
    let mono_out = run(AEC, &fx.far[..n], &mic);
    let mut p = VoiceProcessor::new(AEC);
    let mut stereo_out = Vec::new();
    for i in (0..n).step_by(FRAME) {
        let st: Vec<f32> = fx.far[i..i + FRAME].iter().flat_map(|&v| [v, v]).collect();
        p.push_render(&st, 2);
        p.process_capture(&mic[i..i + FRAME], &mut stereo_out);
    }
    assert_eq!(mono_out[..n], stereo_out[..n]);
}

#[test]
fn ffi_round_trip_matches_the_rust_api() {
    use zali_messenger_core::audio_processing::*;
    let fx = fixtures();
    let n = 2 * SR;
    let echo = convolve(&fx.far[..n], &room_ir(80.0, 0.8, 0.3, 31));
    let expected = run(VoiceProcessingConfig::ALL, &fx.far[..n], &echo);
    let apm = zali_apm_new(true, true, true);
    let mut got = Vec::new();
    let mut buf = vec![0.0f32; 4096];
    unsafe {
        for i in (0..n).step_by(FRAME) {
            zali_apm_push_render(apm, fx.far[i..].as_ptr(), FRAME, 1);
            let k = zali_apm_process_capture(apm, echo[i..].as_ptr(), FRAME, buf.as_mut_ptr(), buf.len());
            got.extend_from_slice(&buf[..k]);
        }
        let stats = zali_apm_stats_json(apm);
        let s = std::ffi::CStr::from_ptr(stats).to_str().unwrap().to_string();
        drop(std::ffi::CString::from_raw(stats));
        assert!(s.contains("\"capture_frames\":200"), "{s}");
        zali_apm_free(apm);
    }
    assert_eq!(got, expected[..got.len()]);
}

/// Статистика шумодава в журнале (`stats.ns_attenuation_db`) показывает то же, что
/// меряют тесты выше: на стационарном шуме — десятки дБ, на выключенном — ничего.
#[test]
fn stats_report_noise_suppression_levels() {
    use zali_messenger_core::audio_processing::{VoiceProcessingConfig, VoiceProcessor};
    let mut seed = 0x1234_5678u32;
    let mut noise = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed as f32 / u32::MAX as f32 - 0.5) * 0.05
    };
    let input: Vec<f32> = (0..48_000 * 12).map(|_| noise()).collect();
    let mut apm = VoiceProcessor::new(VoiceProcessingConfig { echo_cancellation: false, noise_suppression: true, auto_gain: false });
    let mut out = Vec::new();
    apm.process_capture(&input, &mut out);
    let s = apm.stats();
    let att = s.ns_attenuation_db.expect("шумовые кадры есть");
    eprintln!("stats: {s:?}");
    assert!(att > 15.0, "шумодав срезал {att:.1} дБ");
    assert!(s.speech_ratio.unwrap_or(1.0) < 0.2, "голос в белом шуме: {:?}", s.speech_ratio);
    assert!(s.input_dbfs.unwrap() > s.output_dbfs.unwrap());
    assert_eq!(s.clipped_frames, 0);

    apm.set_config(VoiceProcessingConfig { echo_cancellation: false, noise_suppression: false, auto_gain: false });
    assert!(apm.stats().ns_attenuation_db.is_none());
}

/// Речь −28 дБFS по звучащим кадрам (как `input_dbfs` живого внешнего микрофона, 2026-11-26).
fn live_like_speech() -> Vec<f32> {
    let fx = fixtures();
    let active: Vec<&[f32]> = fx.near.chunks(FRAME).filter(|c| energy(c) / FRAME as f64 > 1e-5).collect();
    let level = active.iter().map(|c| energy(c)).sum::<f64>() / (active.len() * FRAME) as f64;
    let g = (10f64.powf(-2.8) / level).sqrt() as f32;
    fx.near.iter().map(|v| v * g).collect()
}

#[test]
fn speech_survives_moderate_room_noise() {
    // Речь −28 дБFS (живой внешний микрофон, 2026-11-26) под ровным шумом комнаты: обычная
    // комната — речь на 20–35 дБ громче шума, ровно там, где DFN3 по умолчанию пропускал
    // deep filter или весь кадр (см. `new_denoiser`): сходство падало до 0.33, речь — на
    // 8 дБ, голос звучал «компьютерно». Измерено после правки: 0.987 / 0.985 / 0.983 /
    // 0.980 / 0.969, −0.3…−0.5 дБ. Нормализатор уровня на этой громкости почти не работает,
    // так что это проверка самого шумодава.
    let speech = live_like_speech();
    let ce = frame_db(&speech);
    let loud = |f: usize| ce.get(f).is_some_and(|&d| d > -35.0);
    let zeros = vec![0.0f32; speech.len()];
    for noise_db in [-65.0f64, -55.0, -50.0, -45.0, -40.0] {
        let mut r = Rng(77);
        let amp = (10f64.powf(noise_db / 20.0) * 3f64.sqrt()) as f32;
        let mic: Vec<f32> = speech.iter().map(|s| s + r.next() * amp).collect();
        let out = run(NS, &zeros, &mic);
        let (sim_in, _) = similarity(&mic, &speech, 2.0, &|f| loud(f));
        let (sim, level) = similarity(&out, &speech, 2.0, &|f| loud(f));
        assert!(sim >= 0.95 && sim >= sim_in - 0.03, "шум {noise_db} дБFS: сходство {sim:.3} (вход {sim_in:.3})");
        assert!(level >= -1.5, "шум {noise_db} дБFS: речь просела на {level:.1} дБ");
    }
}

#[test]
fn every_mic_lands_at_one_speech_level() {
    // Любой микрофон, от тихого −45 до громкого −10 дБFS, выходит к собеседникам на одном
    // уровне. До 2026-11-26 AGC2 только поднимал тихих: −18 и −10 выходили на −19 и −11,
    // остальные — на −24 (см. `OutputLevel`). Плюс ни одного съеденного начала фразы.
    let base = live_like_speech();
    let fd = |x: &[f32]| -> Vec<f64> { x.chunks(FRAME).map(|c| 10.0 * (energy(c) / FRAME as f64).max(1e-12).log10()).collect() };
    let cd = fd(&base);
    // phrases: runs of frames > -45 (base at -28), gap >= 30 frames
    let mut phrases = vec![]; let mut start = None; let mut last = 0;
    for (i, &d) in cd.iter().enumerate() {
        if d > -45.0 { if start.is_none() { start = Some(i); } last = i; }
        else if let Some(s) = start { if i - last >= 30 { phrases.push((s, last)); start = None; } }
    }
    if let Some(s) = start { phrases.push((s, last)); }
    for in_db in [-45.0f64, -35.0, -28.0, -18.0, -10.0] {
        let g = 10f64.powf((in_db + 28.0) / 20.0) as f32;
        let mut r = Rng(5);
        let amp = (10f64.powf(-62.0 / 20.0) * 3f64.sqrt()) as f32;
        let mic: Vec<f32> = base.iter().map(|s| s * g + r.next() * amp).collect();
        let zeros = vec![0.0f32; mic.len()];
        let out = run(AGC, &zeros, &mic);
        let d = NS_DELAY_FRAMES;
        let od = fd(&out);
        let act: Vec<usize> = (300..cd.len()).filter(|&f| cd[f] > -40.0 && f + d < od.len()).collect();
        let steady: Vec<usize> = act.iter().copied().filter(|&f| f > 900).collect();
        let lvl_steady = 10.0 * (steady.iter().map(|&f| 10f64.powf(od[f + d] / 10.0)).sum::<f64>() / steady.len() as f64).log10();
        let lvl = 10.0 * (act.iter().map(|&f| 10f64.powf(od[f + d] / 10.0)).sum::<f64>() / act.len() as f64).log10();
        let mut onset = vec![]; let mut lost_head = 0; let mut lost_tail = 0; let mut tot = 0;
        for &(s, e) in phrases.iter().filter(|p| p.0 > 100) {
            let rel = |f: usize| od.get(f + d).copied().unwrap_or(-120.0) - (cd[f] + in_db + 28.0);
            let ph: Vec<f64> = (s..=e).filter(|&f| cd[f] > -40.0).map(|f| od[f + d]).collect();
            let head: Vec<f64> = (s..(s + 30).min(e)).filter(|&f| cd[f] > -40.0).map(|f| od[f + d]).collect();
            let m = |v: &[f64]| 10.0 * (v.iter().map(|x| 10f64.powf(x / 10.0)).sum::<f64>() / v.len().max(1) as f64).log10();
            onset.push(m(&head) - m(&ph));
            // steady gain = median rel over phrase loud frames
            let mut rs: Vec<f64> = (s..=e).filter(|&f| cd[f] > -40.0).map(rel).collect(); rs.sort_by(|a,b| a.total_cmp(b));
            let med = rs[rs.len() / 2];
            for f in s..(s + 8).min(e) { if cd[f] > -55.0 { tot += 1; if rel(f) < med - 10.0 { lost_head += 1; } } }
            for f in e.saturating_sub(10)..=(e + 10).min(cd.len() - 1) { if cd[f] > -55.0 { tot += 1; if rel(f) < med - 10.0 { lost_tail += 1; } } }
        }
        let on_avg = onset.iter().sum::<f64>() / onset.len() as f64;
        let on_max = onset.iter().cloned().fold(-99.0, f64::max);
        eprintln!("in {in_db}: out speech {lvl:.1} dBFS (steady {lvl_steady:.1}), onset avg {on_avg:+.1} max {on_max:+.1}, lost head {lost_head} tail {lost_tail} of {tot}");
        assert!((lvl_steady + 24.0).abs() <= 2.5, "in {in_db}: steady {lvl_steady:.1}");
        assert!(on_max < 4.0, "in {in_db}: onset {on_max:+.1}");
        assert!(lost_head + lost_tail <= 3, "in {in_db}: lost {lost_head}+{lost_tail}");
    }
}

#[test]
fn phrase_start_after_long_silence_is_not_eaten() {
    // Начало голоса к концу кадра выглядело щелчком, и затвор съедал первые 10 мс каждой
    // фразы (−30 дБ, начальные согласные). Первая фраза звонка не проверяется: статистика
    // шума ещё не набрана.
    let base = live_like_speech();
    let ph = &base[257 * FRAME..600 * FRAME];
    let fd = |x: &[f32]| -> Vec<f64> { x.chunks(FRAME).map(|c| 10.0 * (energy(c) / FRAME as f64).max(1e-12).log10()).collect() };
    for noise in [-65.0f64, -50.0] {
      for in_db in [-40.0f64, -28.0] {
        let g = 10f64.powf((in_db + 28.0) / 20.0) as f32;
        let mut clean = vec![];
        let mut starts = vec![];
        for _ in 0..3 { clean.extend(std::iter::repeat(0.0f32).take(8 * SR)); starts.push(clean.len() / FRAME); clean.extend(ph.iter().map(|v| v * g)); }
        clean.extend(std::iter::repeat(0.0f32).take(SR));
        let mut r = Rng(9);
        let amp = (10f64.powf(noise / 20.0) * 3f64.sqrt()) as f32;
        let mic: Vec<f32> = clean.iter().map(|s| s + r.next() * amp).collect();
        let zeros = vec![0.0f32; mic.len()];
        let out = run(AGC, &zeros, &mic);
        let (cd, od) = (fd(&clean), fd(&out));
        let d = NS_DELAY_FRAMES;
        let mut line = String::new();
        for &s in &starts {
            let seg = |a: usize, b: usize| { let v: Vec<f64> = (a..b).filter(|&f| cd[f] > in_db - 12.0).map(|f| od[f + d] - cd[f]).collect(); v.iter().sum::<f64>() / v.len().max(1) as f64 };
            let first: Vec<String> = (s..s + 12).map(|f| format!("{:.0}", if cd[f] > in_db - 25.0 { od[f + d] - cd[f] } else { f64::NAN })).collect();
            line += &format!(" | g0-200ms {:+.1} g200-1000 {:+.1} g1-3s {:+.1} first[{}]", seg(s, s + 20), seg(s + 20, s + 100), seg(s + 100, s + 300), first.join(","));
        }
        eprintln!("noise {noise} in {in_db}:{line}");
        for &s in &starts[1..] {
            let first = od[s + d] - cd[s];
            assert!(first > -10.0, "noise {noise} in {in_db}: first frame {first:.0}");
        }
      }
    }
}
