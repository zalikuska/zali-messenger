//! Камера: Media Foundation `IMFSourceReader` → NV12. Один сеанс на устройство:
//! Media Foundation отдаёт камеру одному читателю, а страница открывает её дважды
//! (превью в окне выбора + звонок) — второй поток подписывается на тот же сеанс.

use super::com::{now_us, ComGuard};
use super::format::{choose_camera_mode, nv12_len, nv12_uv_offset, pack_nv12, CameraMode, FrameHeader, HEADER_LEN};
use super::hub::StartContext;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use windows::core::{Result, GUID};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaSource, IMFMediaType, IMFSample, IMFSourceReader, MFMediaType_Video, MFVideoFormat_NV12,
    MFVideoFormat_YUY2, MF_E_NO_MORE_TYPES, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR,
    MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
};

struct Subscriber {
    ctx: StartContext,
    announced: bool,
}

/// Идущий сеанс камеры и его подписчики.
struct Shared {
    subscribers: Mutex<Vec<Subscriber>>,
    /// Самый большой режим, который просил хоть один подписчик. Сеанс открывается под
    /// первого (часто превью 640×360); пришёл звонок на 1280×720 — режим растёт на
    /// ходу, иначе звонок так и шёл бы в размере превью и после его закрытия.
    want: Mutex<Want>,
}

#[derive(Clone, Copy, PartialEq)]
struct Want {
    width: u32,
    height: u32,
    fps: f64,
}

impl Want {
    fn from_options(options: &Value) -> Self {
        let get = |key: &str| options.get(key).and_then(Value::as_f64).unwrap_or(0.0).max(0.0);
        Self { width: get("width") as u32, height: get("height") as u32, fps: get("fps") }
    }

    fn max(self, other: Self) -> Self {
        Self { width: self.width.max(other.width), height: self.height.max(other.height), fps: self.fps.max(other.fps) }
    }

    fn exceeds(&self, current: &Self) -> bool {
        self.width > current.width || self.height > current.height || self.fps > current.fps + 0.5
    }
}

fn sessions() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Shared>>> {
    static CAMERAS: OnceLock<Mutex<HashMap<String, Arc<Shared>>>> = OnceLock::new();
    CAMERAS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

const STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

pub fn run(ctx: StartContext) {
    let _com = ComGuard::new();
    let cameras = super::devices::cameras();
    let camera = if ctx.device_id.is_empty() {
        cameras.into_iter().next()
    } else {
        cameras.into_iter().find(|c| c.id == ctx.device_id)
    };
    let Some(camera) = camera else {
        ctx.fail("not_found", "камера не найдена");
        return;
    };

    // Камера уже открыта другим потоком — просто подписаться.
    let shared = {
        let mut map = sessions();
        if let Some(shared) = map.get(&camera.id) {
            if let Ok(mut want) = shared.want.lock() {
                *want = want.max(Want::from_options(&ctx.options));
            }
            if let Ok(mut subs) = shared.subscribers.lock() {
                subs.push(Subscriber { ctx, announced: false });
            }
            return;
        }
        let shared = Arc::new(Shared {
            subscribers: Mutex::new(vec![Subscriber { ctx: ctx.clone(), announced: false }]),
            want: Mutex::new(Want::from_options(&ctx.options)),
        });
        map.insert(camera.id.clone(), Arc::clone(&shared));
        shared
    };

    let mut opened_for = shared.want.lock().map(|w| *w).unwrap_or(Want::from_options(&ctx.options));
    let opened = open_reader(&camera.activate, opened_for);
    let (reader, mut width, mut height, mut stride) = match opened {
        Ok(v) => v,
        Err(error) => {
            let (code, text) = super::com::describe(&error);
            tracing::warn!("[ZALI][WIN] media camera open failed: {text}");
            sessions().remove(&camera.id);
            for sub in shared.subscribers.lock().map(|mut s| std::mem::take(&mut *s)).unwrap_or_default() {
                sub.ctx.fail(code, format!("камера: {text}"));
            }
            return;
        }
    };
    let info = |width: u32, height: u32| json!({
        "codec": "nv12",
        "label": camera.label,
        "deviceId": camera.id,
        "width": width,
        "height": height,
    });

    let mut seq: u32 = 0;
    let mut payload: Vec<u8> = Vec::with_capacity(nv12_len(width as usize, height as usize));
    let mut window = std::time::Instant::now();
    let mut camera_frames = 0u64;
    let mut skipped = 0u64;
    let ended_reason = loop {
        if window.elapsed() >= std::time::Duration::from_secs(10) {
            let seconds = window.elapsed().as_secs_f64();
            let subs = shared.subscribers.lock().map(|s| s.iter().map(|s| s.ctx.clone()).collect::<Vec<_>>()).unwrap_or_default();
            for sub in &subs {
                let mut video = sub.frames.take_stats(seconds);
                video["kind"] = json!("camera");
                video["width"] = json!(width);
                video["height"] = json!(height);
                video["camera_fps"] = json!((camera_frames as f64 / seconds * 10.0).round() / 10.0);
                video["camera_skipped"] = json!(skipped);
                video["subscribers"] = json!(subs.len());
                sub.video_stats(video);
            }
            window = std::time::Instant::now();
            camera_frames = 0;
            skipped = 0;
        }
        let want = shared.want.lock().map(|w| *w).unwrap_or(opened_for);
        if want.exceeds(&opened_for) {
            // Тот же читатель, другой родной режим: Media Foundation сам сбросит очередь.
            // Не вышло — остаёмся в прежнем режиме, только не пытаемся снова.
            opened_for = want;
            match configure_reader(&reader, want) {
                Ok((w, h, s)) => {
                    tracing::info!("[ZALI][WIN] media camera mode {width}x{height} -> {w}x{h}");
                    (width, height, stride) = (w, h, s);
                }
                Err(error) => tracing::warn!("[ZALI][WIN] media camera mode change failed: {error}"),
            }
        }
        if !announce_and_prune(&shared, &info(width, height)) {
            break None;
        }
        match read_frame(&reader, width as usize, height as usize, stride, &mut payload) {
            Ok(ReadOutcome::Frame) => camera_frames += 1,
            Ok(ReadOutcome::Skip) => {
                skipped += 1;
                continue;
            }
            Ok(ReadOutcome::Ended) => break Some("device-lost"),
            Err(error) => {
                let (_, text) = super::com::describe(&error);
                tracing::warn!("[ZALI][WIN] media camera read failed: {text}");
                break Some("device-lost");
            }
        }
        let ts = now_us();
        let subs = shared.subscribers.lock().map(|s| s.iter().map(|s| s.ctx.clone()).collect::<Vec<_>>()).unwrap_or_default();
        for sub in subs {
            if sub.stopped() {
                continue;
            }
            let mut frame = vec![0u8; HEADER_LEN + payload.len()];
            super::format::encode_header(
                &FrameHeader::nv12(sub.stream, ts, width as u16, height as u16, seq),
                payload.len(),
                &mut frame[..HEADER_LEN],
            );
            frame[HEADER_LEN..].copy_from_slice(&payload);
            sub.frames.send_video(frame);
        }
        seq = seq.wrapping_add(1);
    };
    // Сеанс кончился: убрать из общей таблицы под тем же замком, под которым
    // подписываются новые потоки, и сообщить оставшимся.
    let leftovers = {
        let mut map = sessions();
        map.remove(&camera.id);
        shared.subscribers.lock().map(|mut s| std::mem::take(&mut *s)).unwrap_or_default()
    };
    for sub in leftovers {
        match ended_reason {
            Some(reason) if sub.announced => sub.ctx.ended(reason),
            Some(_) => sub.ctx.fail("failed", "камера перестала отдавать кадры"),
            None => sub.ctx.finish(),
        }
    }
}

/// Новым подписчикам — `started`, остановленных убрать. `false` — подписчиков нет,
/// сеанс закрывается (решение под замком таблицы, чтобы не потерять нового).
fn announce_and_prune(shared: &Arc<Shared>, info: &Value) -> bool {
    let map = sessions();
    let Ok(mut subs) = shared.subscribers.lock() else { return false };
    subs.retain(|s| {
        if s.ctx.stopped() {
            s.ctx.finish();
            false
        } else {
            true
        }
    });
    for sub in subs.iter_mut().filter(|s| !s.announced) {
        sub.ctx.started(info.clone());
        sub.announced = true;
    }
    let alive = !subs.is_empty();
    drop(subs);
    drop(map);
    alive
}

enum ReadOutcome {
    Frame,
    Skip,
    Ended,
}

fn subtype_rank(subtype: &GUID) -> u8 {
    if *subtype == MFVideoFormat_NV12 {
        0
    } else if *subtype == MFVideoFormat_YUY2 {
        1
    } else {
        2
    }
}

fn split_u64(v: u64) -> (u32, u32) {
    ((v >> 32) as u32, (v & 0xFFFF_FFFF) as u32)
}

fn open_reader(
    activate: &windows::Win32::Media::MediaFoundation::IMFActivate,
    want: Want,
) -> Result<(IMFSourceReader, u32, u32, usize)> {
    unsafe {
        let source: IMFMediaSource = activate.ActivateObject()?;
        let attrs = super::mf::create_attributes(2)?;
        // Преобразование MJPG/YUY2 → NV12 силами Media Foundation.
        attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)?;
        let reader = super::mf::create_source_reader(&source, &attrs)?;
        let (w, h, stride) = configure_reader(&reader, want)?;
        Ok((reader, w, h, stride))
    }
}

/// Выбрать родной режим камеры под `want` и выход NV12 того же размера.
/// Возвращает фактические ширину, высоту и шаг строки.
fn configure_reader(reader: &IMFSourceReader, want: Want) -> Result<(u32, u32, usize)> {
    unsafe {
        let mut natives: Vec<IMFMediaType> = Vec::new();
        let mut modes: Vec<CameraMode> = Vec::new();
        for i in 0.. {
            let mt = match reader.GetNativeMediaType(STREAM, i) {
                Ok(mt) => mt,
                Err(error) if error.code() == MF_E_NO_MORE_TYPES => break,
                Err(error) => return Err(error),
            };
            let subtype = mt.GetGUID(&MF_MT_SUBTYPE).unwrap_or_default();
            let (w, h) = split_u64(mt.GetUINT64(&MF_MT_FRAME_SIZE).unwrap_or(0));
            let (num, den) = split_u64(mt.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or(0));
            let fps = if den == 0 { 0.0 } else { num as f64 / den as f64 };
            modes.push(CameraMode { width: w, height: h, fps, subtype_rank: subtype_rank(&subtype) });
            natives.push(mt);
            if i > 512 {
                break;
            }
        }
        if let Some(index) = choose_camera_mode(&modes, want.width, want.height, want.fps) {
            reader.SetCurrentMediaType(STREAM, None, &natives[index])?;
        }
        let current = reader.GetCurrentMediaType(STREAM)?;
        let size = current.GetUINT64(&MF_MT_FRAME_SIZE)?;
        let out = super::mf::create_media_type()?;
        out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        out.SetUINT64(&MF_MT_FRAME_SIZE, size)?;
        reader.SetCurrentMediaType(STREAM, None, &out)?;

        let actual = reader.GetCurrentMediaType(STREAM)?;
        let (w, h) = split_u64(actual.GetUINT64(&MF_MT_FRAME_SIZE)?);
        // Нечётные размеры камер не бывают на практике, но поле кадра требует чётных.
        let (w, h) = (w & !1, h & !1);
        if w == 0 || h == 0 || w > 65534 || h > 65534 {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED));
        }
        let stride = actual.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|s| s as i32).unwrap_or(w as i32);
        let stride = if stride > 0 { stride as usize } else { w as usize };
        Ok((w, h, stride.max(w as usize)))
    }
}

fn read_frame(reader: &IMFSourceReader, width: usize, height: usize, stride: usize, payload: &mut Vec<u8>) -> Result<ReadOutcome> {
    unsafe {
        let mut flags = 0u32;
        let mut ts = 0i64;
        let mut sample: Option<IMFSample> = None;
        reader.ReadSample(STREAM, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample))?;
        if flags & (MF_SOURCE_READERF_ERROR.0 as u32 | MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
            return Ok(ReadOutcome::Ended);
        }
        let Some(sample) = sample else {
            return Ok(ReadOutcome::Skip);
        };
        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut current_len = 0u32;
        // Lock у двумерного буфера отдаёт данные в «непрерывном» виде; шаг строки —
        // MF_MT_DEFAULT_STRIDE (обычно = ширине), высоту выравнивания выводим из длины.
        buffer.Lock(&mut data, None, Some(&mut current_len))?;
        let len = current_len as usize;
        let mut ok = false;
        if !data.is_null() {
            let bytes = std::slice::from_raw_parts(data, len);
            let pitch = if len >= stride * height * 3 / 2 { stride } else { width };
            if let Some(uv) = nv12_uv_offset(len, pitch, height) {
                payload.clear();
                ok = pack_nv12(&bytes[..uv], pitch, &bytes[uv..], pitch, width, height, payload);
            }
        }
        let _ = buffer.Unlock();
        Ok(if ok { ReadOutcome::Frame } else { ReadOutcome::Skip })
    }
}
