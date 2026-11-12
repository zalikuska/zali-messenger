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

use zali_messenger_core::audio_processing::{VoiceProcessingConfig, VoiceProcessor, FRAME, SAMPLE_RATE};

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
    // Порог ослабления: широкополосный шум ≥ 15 дБ (измерено 18–26). Вентилятор с
    // тональным гулом 120/240 Гц ≥ 12 дБ (измерено 13.9): тоны RNNoise снимает лишь
    // частично, ФВЧ на 100 Гц до 120 Гц почти не достаёт, а выше резать — худеет голос.
    for (name, mut noise, min_atten) in
        [("белый", white, 15.0), ("розовый", pink, 15.0), ("вентилятор без гула", fan_broadband, 15.0), ("вентилятор с гулом", fan, 12.0)]
    {
        scale_to(&mut noise, near_e / 10f64.powf(0.5)); // SNR 5 дБ
        let mic: Vec<f32> = (0..len).map(|i| fx.near[i] + noise[i]).collect();
        let out = run(NS, &zeros, &mic);
        // ослабление шума — в паузах речи (кадры тише −70 дБ), с учётом задержки в кадр
        let (mut em, mut eo) = (0.0, 0.0);
        for f in (SR / FRAME)..ce.len() - 1 {
            if ce[f] < -70.0 && ce[f + 1] < -70.0 {
                em += energy(&mic[f * FRAME..f * FRAME + FRAME]);
                eo += energy(&out[(f + 1) * FRAME..(f + 1) * FRAME + FRAME]);
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
