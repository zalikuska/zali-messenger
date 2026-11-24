//! Стенд издателя экрана (src/sfu_publisher.rs) без оболочки: шлёт на SFU заранее
//! закодированные слои H.264 Annex B (по файлу на слой, от меньшего к большему) в темпе их
//! частоты, по кругу. Сигналинг — строками JSON: в stdout `{"offer":{sdp,mid}}` и события
//! издателя, из stdin — `{"answer":"<sdp>"}`. Слой с бюджетом 0 не шлётся (как оболочка),
//! после возврата бюджета — с ближайшего ключевого кадра. Запрос ключевого кадра стенд
//! выполнить не может (файлы готовые) — у файлов GOP 1 с.
//!
//! cargo run --release --features sfu --example sfu_pub_file -- q.h264:480x270@30:400000 h.h264:960x540@60:2500000 f.h264:1920x1080@60:8000000
//! `CODEC=H265` — файлы H.265 Annex B, `CODEC=AV1` — файлы IVF (ffmpeg `-c:v libsvtav1 x.ivf`).
//! (обвязка с браузером-зрителем: scripts/voice_doctor/sfu_e2e/native_pub.mjs)

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zali_messenger_core::sfu_publisher::{LayerConfig, PublisherConfig, SfuPublisher, VideoCodec};

struct Au {
    data: Vec<u8>,
    key: bool,
}

fn nals(buf: &[u8]) -> Vec<(usize, usize)> {
    // (начало с префиксом, начало полезной части)
    let mut out = vec![];
    let mut i = 0;
    while i + 3 <= buf.len() {
        if buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1 {
            let start = if i > 0 && buf[i - 1] == 0 { i - 1 } else { i };
            out.push((start, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}

fn split_aus(buf: &[u8]) -> Vec<Au> {
    let list = nals(buf);
    let mut aus = vec![];
    let mut cur: Vec<u8> = vec![];
    let mut has_vcl = false;
    let mut key = false;
    for (n, (start, body)) in list.iter().enumerate() {
        let end = list.get(n + 1).map(|x| x.0).unwrap_or(buf.len());
        let t = buf[*body] & 0x1f;
        let vcl = t == 1 || t == 5;
        let first_mb0 = vcl && buf.get(body + 1).is_some_and(|b| b & 0x80 != 0);
        let boundary = has_vcl && (matches!(t, 6..=9) || first_mb0);
        if boundary {
            aus.push(Au { data: std::mem::take(&mut cur), key });
            has_vcl = false;
            key = false;
        }
        cur.extend_from_slice(&buf[*start..end]);
        has_vcl |= vcl;
        key |= t == 5;
    }
    if has_vcl {
        aus.push(Au { data: cur, key });
    }
    aus
}

/// H.265 Annex B → кадры: граница — AUD/VPS/SPS/PPS/префиксный SEI после VCL или срез с
/// first_slice_segment_in_pic_flag; ключевой — IRAP (16..=21).
fn split_aus_h265(buf: &[u8]) -> Vec<Au> {
    let list = nals(buf);
    let mut aus = vec![];
    let mut cur: Vec<u8> = vec![];
    let mut has_vcl = false;
    let mut key = false;
    for (n, (start, body)) in list.iter().enumerate() {
        let end = list.get(n + 1).map(|x| x.0).unwrap_or(buf.len());
        let t = (buf[*body] >> 1) & 0x3f;
        let vcl = t < 32;
        let first_slice = vcl && buf.get(body + 2).is_some_and(|b| b & 0x80 != 0);
        let boundary = has_vcl && (matches!(t, 32..=35 | 39) || first_slice);
        if boundary {
            aus.push(Au { data: std::mem::take(&mut cur), key });
            has_vcl = false;
            key = false;
        }
        cur.extend_from_slice(&buf[*start..end]);
        has_vcl |= vcl;
        key |= (16..=21).contains(&t);
    }
    if has_vcl {
        aus.push(Au { data: cur, key });
    }
    aus
}

/// IVF → временные единицы AV1; ключевая — та, где есть заголовок последовательности.
fn split_ivf(buf: &[u8]) -> Vec<Au> {
    let header = u16::from_le_bytes([buf[6], buf[7]]) as usize;
    let mut i = header;
    let mut aus = vec![];
    while i + 12 <= buf.len() {
        let size = u32::from_le_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        let data = buf[i + 12..(i + 12 + size).min(buf.len())].to_vec();
        let key = has_seq_header(&data);
        aus.push(Au { data, key });
        i += 12 + size;
    }
    aus
}

fn has_seq_header(tu: &[u8]) -> bool {
    let mut i = 0;
    while i < tu.len() {
        let h = tu[i];
        let kind = (h >> 3) & 0xf;
        if kind == 1 {
            return true;
        }
        let ext = h & 0x4 != 0;
        let mut j = i + 1 + ext as usize;
        if h & 0x2 == 0 {
            return false;
        }
        let (mut size, mut shift) = (0usize, 0);
        while j < tu.len() {
            let b = tu[j];
            size |= ((b & 0x7f) as usize) << shift;
            j += 1;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        i = j + size;
    }
    false
}

fn main() {
    let codec = std::env::var("CODEC").ok().and_then(|c| VideoCodec::parse(&c)).unwrap_or_default();
    let mut layers = vec![];
    let mut files = vec![];
    for (i, arg) in std::env::args().skip(1).enumerate() {
        // путь:ШxВ@к/с:бит/с
        let parts: Vec<&str> = arg.split(':').collect();
        let (wh, fps) = parts[1].split_once('@').unwrap();
        let (w, h) = wh.split_once('x').unwrap();
        let rid = ["q", "h", "f"][i];
        layers.push(LayerConfig {
            rid: rid.into(),
            width: w.parse().unwrap(),
            height: h.parse().unwrap(),
            fps: fps.parse().unwrap(),
            max_bitrate: parts[2].parse().unwrap(),
            min_bitrate: parts.get(3).map(|m| m.parse().unwrap()),
        });
        let raw = std::fs::read(parts[0]).unwrap();
        let aus = match codec {
            VideoCodec::H264 => split_aus(&raw),
            VideoCodec::H265 => split_aus_h265(&raw),
            VideoCodec::Av1 => split_ivf(&raw),
        };
        eprintln!("layer {rid}: {} кадров, ключевых {}", aus.len(), aus.iter().filter(|a| a.key).count());
        files.push(aus);
    }
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let alloc: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(vec![1; layers.len()]));
    let (out2, alloc2) = (stdout.clone(), alloc.clone());
    let publisher = SfuPublisher::new(
        PublisherConfig { layers: layers.clone(), start_bitrate: Some(2_500_000), codec },
        Box::new(move |ev: String| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev) {
                if v["event"] == "bitrates" {
                    if let Some(arr) = v["bitrates"].as_array() {
                        *alloc2.lock().unwrap() = arr.iter().map(|x| x.as_u64().unwrap_or(0)).collect();
                    }
                }
            }
            let mut o = out2.lock().unwrap();
            let _ = writeln!(o, "{ev}");
            let _ = o.flush();
        }),
    )
    .expect("publisher");
    {
        let (sdp, mid) = publisher.offer();
        let mut o = stdout.lock().unwrap();
        let _ = writeln!(o, "{}", serde_json::json!({"offer": {"sdp": sdp, "mid": mid}}));
        let _ = o.flush();
    }
    let publisher = Arc::new(publisher);
    let p2 = publisher.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(sdp) = v["answer"].as_str() {
                    p2.accept_answer(sdp.to_string());
                }
                if v["quit"].as_bool() == Some(true) {
                    std::process::exit(0);
                }
            }
        }
        std::process::exit(0);
    });

    let start = Instant::now();
    let mut next_idx = vec![0usize; files.len()];
    let mut waiting_key = vec![false; files.len()];
    loop {
        let now_us = start.elapsed().as_micros() as i64;
        let mut soonest = i64::MAX;
        for (li, aus) in files.iter().enumerate() {
            let fps = layers[li].fps as i64;
            let due = next_idx[li] as i64 * 1_000_000 / fps;
            if due <= now_us {
                let au = &aus[next_idx[li] % aus.len()];
                let on = alloc.lock().unwrap().get(li).copied().unwrap_or(1) > 0;
                if !on {
                    waiting_key[li] = true;
                } else if waiting_key[li] && !au.key {
                    // ждём ключевой
                } else {
                    waiting_key[li] = false;
                    publisher.push_frame(li, au.data.clone(), au.key, due);
                }
                next_idx[li] += 1;
            }
            soonest = soonest.min(next_idx[li] as i64 * 1_000_000 / fps);
        }
        let wait = (soonest - start.elapsed().as_micros() as i64).max(0) as u64;
        std::thread::sleep(Duration::from_micros(wait.min(20_000)));
    }
}
