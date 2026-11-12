//! Живой акустический тест эхоподавления: речь из tests/fixtures/apm_far.wav играет
//! в динамики, микрофон пишется одновременно, запись идёт через тот же конвейер, что в
//! приложении (src/audio_processing.rs). Печатает ERLE по реальному тракту
//! «динамик → комната → микрофон» и сохраняет WAV до/после для прослушивания.
//!
//!     cd core && cargo run --release --features apm --example apm_live -- [папка для WAV]
//!
//! Опорный сигнал здесь — ровно то, что отдано в динамики (в приложении его же даёт
//! process tap / WASAPI loopback). Нужен доступ терминала к микрофону.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use zali_messenger_core::audio_processing::{VoiceProcessingConfig, VoiceProcessor, SAMPLE_RATE};

fn read_pcm16(path: &str) -> Vec<f32> {
    let b = std::fs::read(path).expect("fixture");
    let mut i = 12;
    while i + 8 <= b.len() {
        let len = u32::from_le_bytes(b[i + 4..i + 8].try_into().unwrap()) as usize;
        if &b[i..i + 4] == b"data" {
            return b[i + 8..i + 8 + len].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
        }
        i += 8 + len + (len & 1);
    }
    panic!("no data chunk");
}

fn upsample2(x: &[f32]) -> Vec<f32> {
    // линейной интерполяции для воспроизведения достаточно
    let mut y = Vec::with_capacity(x.len() * 2);
    for i in 0..x.len() {
        let next = *x.get(i + 1).unwrap_or(&x[i]);
        y.push(x[i]);
        y.push((x[i] + next) * 0.5);
    }
    y
}

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|&v| v as f64 * v as f64).sum()
}
fn dbfs(x: &[f32]) -> f64 {
    10.0 * (energy(x) / x.len().max(1) as f64 + 1e-20).log10()
}

fn save(path: &str, x: &[f32]) {
    let mut out = Vec::with_capacity(44 + x.len() * 2);
    let data_len = (x.len() * 2) as u32;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &v in x {
        out.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    std::fs::write(path, out).expect("write wav");
}

fn main() {
    let out_dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let far = upsample2(&read_pcm16(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/apm_far.wav")));
    let far = Arc::new(far);
    let host = cpal::default_host();
    let out_dev = host.default_output_device().expect("нет устройства вывода");
    let in_dev = host.default_input_device().expect("нет микрофона");
    let rate = SAMPLE_RATE;
    let out_cfg = out_dev
        .supported_output_configs()
        .expect("форматы вывода")
        .filter(|c| c.sample_format() == cpal::SampleFormat::F32)
        .find_map(|c| c.try_with_sample_rate(rate))
        .expect("вывод не умеет 48 кГц f32");
    let in_cfg = in_dev
        .supported_input_configs()
        .expect("форматы ввода")
        .filter(|c| c.sample_format() == cpal::SampleFormat::F32)
        .find_map(|c| c.try_with_sample_rate(rate))
        .expect("микрофон не умеет 48 кГц f32");
    let out_ch = out_cfg.channels() as usize;
    let in_ch = in_cfg.channels() as usize;
    println!("вывод: {:?}, {} кан.; ввод: {:?}, {} кан.", out_dev.description().ok().map(|d| d.name().to_string()), out_ch, in_dev.description().ok().map(|d| d.name().to_string()), in_ch);

    let render_q = Arc::new(Mutex::new(VecDeque::<f32>::new()));
    let mic_q = Arc::new(Mutex::new(VecDeque::<f32>::new()));
    let pos = Arc::new(Mutex::new(0usize));
    let lead = SAMPLE_RATE as usize; // 1 с тишины до речи — замер шумового фона

    let (rq, f, p) = (render_q.clone(), far.clone(), pos.clone());
    let out_stream = out_dev
        .build_output_stream(
            out_cfg.config(),
            move |data: &mut [f32], _| {
                let mut pos = p.lock().unwrap();
                let mut rq = rq.lock().unwrap();
                for frame in data.chunks_mut(out_ch) {
                    let s = if *pos >= lead { *f.get(*pos - lead).unwrap_or(&0.0) * 0.9 } else { 0.0 };
                    *pos += 1;
                    frame.iter_mut().for_each(|v| *v = s);
                    rq.push_back(s);
                }
            },
            |e| eprintln!("вывод: {e}"),
            None,
        )
        .expect("поток вывода");
    let mq = mic_q.clone();
    let in_stream = in_dev
        .build_input_stream(
            in_cfg.config(),
            move |data: &[f32], _| {
                let mut mq = mq.lock().unwrap();
                for frame in data.chunks(in_ch) {
                    mq.push_back(frame[0]);
                }
            },
            |e| eprintln!("ввод: {e}"),
            None,
        )
        .expect("поток ввода");
    in_stream.play().unwrap();
    out_stream.play().unwrap();

    let total = lead + far.len() + SAMPLE_RATE as usize;
    let mut apm = VoiceProcessor::new(VoiceProcessingConfig::ALL);
    let mut aec_only = VoiceProcessor::new(VoiceProcessingConfig { echo_cancellation: true, noise_suppression: false, auto_gain: false });
    let (mut raw, mut out, mut out_aec, mut played) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    println!("играю {:.1} с речи…", far.len() as f32 / SAMPLE_RATE as f32);
    while raw.len() < total {
        std::thread::sleep(std::time::Duration::from_millis(5));
        let r: Vec<f32> = render_q.lock().unwrap().drain(..).collect();
        if !r.is_empty() {
            apm.push_render(&r, 1);
            aec_only.push_render(&r, 1);
            played.extend_from_slice(&r);
        }
        let m: Vec<f32> = mic_q.lock().unwrap().drain(..).collect();
        if !m.is_empty() {
            apm.process_capture(&m, &mut out);
            aec_only.process_capture(&m, &mut out_aec);
            raw.extend_from_slice(&m);
        }
    }
    drop(out_stream);
    drop(in_stream);

    let sr = SAMPLE_RATE as usize;
    let noise_floor = dbfs(&raw[sr / 4..lead - sr / 10]);
    // ERLE по окнам 0.5 с, где речь звучала, после 3 с сходимости
    let w = sr / 2;
    let (mut v_full, mut v_aec, mut echo_lvls) = (vec![], vec![], vec![]);
    let mut i = lead + 3 * sr;
    while i + w <= raw.len().min(out.len()).min(out_aec.len()).min(lead + far.len()) {
        let fseg = &far[i - lead..i - lead + w];
        if dbfs(fseg) > -40.0 {
            let e = energy(&raw[i..i + w]);
            v_full.push(10.0 * (e / energy(&out[i..i + w]).max(1e-20)).log10());
            v_aec.push(10.0 * (e / energy(&out_aec[i..i + w]).max(1e-20)).log10());
            echo_lvls.push(dbfs(&raw[i..i + w]));
        }
        i += w;
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (v[v.len() / 2], v[0])
    };
    let echo_med = med(&mut echo_lvls.clone()).0;
    let (m1, n1) = med(&mut v_full);
    let (m2, n2) = med(&mut v_aec);
    println!("шумовой фон микрофона: {noise_floor:.1} dBFS; эхо речи в микрофоне: {echo_med:.1} dBFS (запас над фоном {:.1} дБ)", echo_med - noise_floor);
    println!("ERLE, только AEC:       медиана {m2:.1} дБ, минимум {n2:.1} дБ ({} окон)", v_aec.len());
    println!("ERLE, весь конвейер:    медиана {m1:.1} дБ, минимум {n1:.1} дБ");
    println!("остаток после конвейера: {:.1} dBFS (фон {noise_floor:.1})", dbfs(&out[lead + 3 * sr..(lead + far.len()).min(out.len())]));
    println!("статистика AEC: {:?}", apm.stats());
    save(&format!("{out_dir}/apm_live_mic.wav"), &raw);
    save(&format!("{out_dir}/apm_live_aec.wav"), &out_aec);
    save(&format!("{out_dir}/apm_live_full.wav"), &out);
    println!("WAV: {out_dir}/apm_live_{{mic,aec,full}}.wav");
}
