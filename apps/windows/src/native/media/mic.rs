//! Микрофон: WASAPI shared (роль `eConsole`), 48 кГц моно f32 → `VoiceProcessor`
//! (AEC3 → RNNoise → AGC2) → кадры по 20 мс. Опорный сигнал эхоподавления — loopback
//! устройства вывода по умолчанию в соседнем потоке (`loopback::run_render_reference`).

use super::com::{now_us, ComGuard};
use super::format::{audio_frame, FrameHeader, Processing};
use super::hub::StartContext;
use super::loopback::{run_render_reference, sleep_unless_stopped, WasapiCapture};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zali_messenger_core::audio_processing::{VoiceProcessingConfig, VoiceProcessor};

/// 20 мс при 48 кГц: вдвое меньше общих буферов WebView2, чем по 10 мс, а задержка
/// та же, что у Opus-кадра WebRTC.
const BLOCK: usize = 960;
const STATS_EVERY: Duration = Duration::from_secs(10);

static PROCESSING: Mutex<Processing> = Mutex::new(Processing::ALL);
static PROCESSING_GEN: AtomicU64 = AtomicU64::new(0);

pub fn current_processing() -> Processing {
    PROCESSING.lock().map(|p| *p).unwrap_or(Processing::ALL)
}

/// `set_processing` страницы — применяется к идущему микрофону на лету.
pub fn set_processing(value: Processing) {
    if let Ok(mut guard) = PROCESSING.lock() {
        *guard = value;
    }
    PROCESSING_GEN.fetch_add(1, Ordering::AcqRel);
}

fn to_config(p: Processing) -> VoiceProcessingConfig {
    VoiceProcessingConfig { echo_cancellation: p.aec, noise_suppression: p.ns, auto_gain: p.agc }
}

pub fn run(ctx: StartContext) {
    let _com = ComGuard::new();
    set_processing(Processing::from_start_options(&ctx.options, current_processing()));
    let mut processing = current_processing();
    let mut seen_gen = PROCESSING_GEN.load(Ordering::Acquire);

    let processor = Arc::new(Mutex::new(VoiceProcessor::new(to_config(processing))));
    let reference_ok = Arc::new(AtomicBool::new(false));
    let reference_stop = Arc::new(AtomicBool::new(false));
    {
        let processor = Arc::clone(&processor);
        let reference_ok = Arc::clone(&reference_ok);
        let stop = Arc::clone(&reference_stop);
        let _ = std::thread::Builder::new().name("zali-media-mic-ref".into()).spawn(move || {
            run_render_reference(
                stop,
                move |samples, channels| {
                    if let Ok(mut p) = processor.lock() {
                        p.push_render(samples, channels);
                    }
                },
                move |ok| reference_ok.store(ok, Ordering::Release),
            );
        });
    }

    let mut announced = false;
    let mut raw: Vec<f32> = Vec::with_capacity(4800);
    let mut processed: Vec<f32> = Vec::with_capacity(4800);
    let mut seq: u32 = 0;
    let mut anchor_us = 0u64;
    let mut sent_samples: u64 = 0;
    let mut last_stats = Instant::now();
    let mut reopen_attempts = 0u32;

    'device: while !ctx.stopped() {
        let opened = super::devices::capture_device(&ctx.device_id).and_then(|device| {
            let capture = WasapiCapture::open_endpoint(&device, 1, false)?;
            capture.start()?;
            Ok((capture, super::devices::friendly_name(&device), super::devices::device_id(&device)))
        });
        let (capture, label, device_id) = match opened {
            Ok(v) => v,
            Err(error) => {
                if !announced {
                    ctx.fail_win(&error, "микрофон");
                    break 'device;
                }
                // Устройство по умолчанию пропало посреди звонка — ждём новое по умолчанию.
                reopen_attempts += 1;
                if !ctx.device_id.is_empty() || reopen_attempts > 20 {
                    ctx.ended("device-lost");
                    break 'device;
                }
                sleep_unless_stopped(ctx.stop_flag(), 500);
                continue 'device;
            }
        };
        reopen_attempts = 0;
        if !announced {
            ctx.started(json!({ "codec": "pcm-f32", "label": label, "deviceId": device_id }));
            announced = true;
            anchor_us = now_us();
        } else {
            tracing::info!("[ZALI][WIN] media mic reopened on {label}");
        }

        while !ctx.stopped() {
            raw.clear();
            if let Err(error) = capture.read(20, &mut raw) {
                tracing::warn!("[ZALI][WIN] media mic read failed: {error}");
                // Явно выбранное устройство отключили — поток кончился; устройство по
                // умолчанию — переоткрываем (новое по умолчанию).
                if !ctx.device_id.is_empty() {
                    ctx.ended("device-lost");
                    break 'device;
                }
                sleep_unless_stopped(ctx.stop_flag(), 300);
                continue 'device;
            }
            let gen = PROCESSING_GEN.load(Ordering::Acquire);
            if gen != seen_gen {
                seen_gen = gen;
                processing = current_processing();
                if let Ok(mut p) = processor.lock() {
                    p.set_config(to_config(processing));
                }
            }
            if !raw.is_empty() {
                if let Ok(mut p) = processor.lock() {
                    p.process_capture(&raw, &mut processed);
                }
            }
            while processed.len() >= BLOCK {
                // Метка времени — по счёту отсчётов (ровная), с перепривязкой к часам,
                // если разошлись больше чем на 200 мс (провал устройства, пауза потока).
                let by_samples = anchor_us + sent_samples * 1_000_000 / 48_000;
                let now = now_us();
                if by_samples.abs_diff(now) > 200_000 {
                    anchor_us = now;
                    sent_samples = 0;
                }
                let ts = anchor_us + sent_samples * 1_000_000 / 48_000;
                let frame = audio_frame(&FrameHeader::audio(ctx.stream, ts, 1, seq), &processed[..BLOCK]);
                processed.drain(..BLOCK);
                seq = seq.wrapping_add(1);
                sent_samples += BLOCK as u64;
                // Звук не прореживаем, но и не копим без конца, если окно встало.
                if ctx.frames.pending() < 50 && !ctx.frames.send(frame) {
                    break 'device;
                }
            }
            if last_stats.elapsed() >= STATS_EVERY {
                last_stats = Instant::now();
                let stats = processor.lock().map(|p| p.stats()).unwrap_or_default();
                let mut value = serde_json::to_value(&stats).unwrap_or_else(|_| json!({}));
                value["source"] = json!("windows-wasapi");
                value["aec"] = json!(processing.aec);
                value["ns"] = json!(processing.ns);
                value["agc"] = json!(processing.agc);
                value["reference"] = json!(reference_ok.load(Ordering::Acquire));
                value["device"] = json!(label);
                ctx.events.emit(json!({ "event": "stats", "stream": ctx.stream, "processing": value }));
            }
        }
        break 'device;
    }
    reference_stop.store(true, Ordering::Release);
    ctx.finish();
}
