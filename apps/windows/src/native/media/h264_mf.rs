//! H.264 / H.265 / AV1 для отправки экрана напрямую на SFU (screen.rs → core sfu_publisher).
//!
//! Кодек — подтип выхода MFT (`VideoCodec`). H.265 и AV1 — только аппаратные кодировщики
//! (программный HEVC на 4K60 положил бы процессор, программного AV1-MFT в Windows нет):
//! не нашёлся — `spawn` вернёт ошибку, и screen.rs возьмёт следующий кодек списка страницы.
//!
//! Media Foundation: сначала аппаратные кодировщики (NVENC/Quick Sync/AMF — асинхронные
//! MFT, события METransformNeedInput/HaveOutput), если ни один не настроился — программный
//! `CLSID_MSH264EncoderMFT` (синхронный). Вход — плотный NV12 из памяти (тот же, что
//! уходит странице), выход — Annex B; у ключевого кадра SPS/PPS внутри (если кодировщик
//! кладёт их только в тип выхода — дописываем сами).
//!
//! Каждый слой кодируется в своём потоке (`LayerEncoder`): задержки кодировщиков не
//! складываются и не тормозят захват. Кадр, который поток ещё не взял, заменяется новым.

use super::com::ComGuard;
use super::mf;
use std::mem::ManuallyDrop;
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::core::{Interface, Result};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VARIANT;
use zali_messenger_core::sfu_publisher::VideoCodec;

/// Сколько ждать готовности асинхронного кодировщика к кадру и его выхода.
const ASYNC_INPUT_WAIT: Duration = Duration::from_millis(12);
const ASYNC_OUTPUT_WAIT: Duration = Duration::from_millis(25);

struct Encoder {
    mft: IMFTransform,
    events: Option<IMFMediaEventGenerator>,
    codec_api: Option<ICodecAPI>,
    activate: Option<IMFActivate>,
    need_input: u32,
    provides_samples: bool,
    out_size: u32,
    seq_header: Vec<u8>,
    codec: VideoCodec,
    width: u32,
    height: u32,
    fps: u32,
    name: String,
}

fn set_codec(api: &ICodecAPI, key: &windows::core::GUID, value: VARIANT) -> bool {
    unsafe { api.SetValue(key, &value).is_ok() }
}

/// Есть ли в Annex B единица NAL, тип которой проходит `pred` (тип уже извлечён по кодеку).
fn has_nal_where(data: &[u8], codec: VideoCodec, pred: impl Fn(u8) -> bool) -> bool {
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            let h = data[i + 3];
            let kind = if codec == VideoCodec::H265 { (h >> 1) & 0x3f } else { h & 0x1f };
            if pred(kind) {
                return true;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    false
}

/// Есть ли в потоке OBU AV1 (low-overhead, с размерами) заголовок последовательности.
fn av1_has_seq_header(tu: &[u8]) -> bool {
    let mut i = 0;
    while i < tu.len() {
        let h = tu[i];
        if (h >> 3) & 0xf == 1 {
            return true;
        }
        if h & 0x2 == 0 {
            return false;
        }
        let mut j = i + 1 + ((h & 0x4 != 0) as usize);
        let (mut size, mut shift) = (0usize, 0u32);
        while j < tu.len() && shift < 56 {
            let b = tu[j];
            size |= ((b & 0x7f) as usize) << shift;
            j += 1;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        i = j.saturating_add(size);
    }
    false
}

/// Ключевой кадр по содержимому (IDR у H.264, IRAP у H.265; у AV1 — только флаг выборки).
fn is_key_payload(data: &[u8], codec: VideoCodec) -> bool {
    match codec {
        VideoCodec::H264 => has_nal_where(data, codec, |t| t == 5),
        VideoCodec::H265 => has_nal_where(data, codec, |t| (16..=21).contains(&t)),
        VideoCodec::Av1 => false,
    }
}

/// Есть ли параметры последовательности (SPS у H.264, VPS у H.265, заголовок у AV1).
fn has_params(data: &[u8], codec: VideoCodec) -> bool {
    match codec {
        VideoCodec::H264 => has_nal_where(data, codec, |t| t == 7),
        VideoCodec::H265 => has_nal_where(data, codec, |t| t == 32),
        VideoCodec::Av1 => av1_has_seq_header(data),
    }
}

fn subtype(codec: VideoCodec) -> windows::core::GUID {
    match codec {
        VideoCodec::H264 => MFVideoFormat_H264,
        VideoCodec::H265 => MFVideoFormat_HEVC,
        VideoCodec::Av1 => MFVideoFormat_AV1,
    }
}

impl Encoder {
    /// Аппаратный, если есть и настраивается; иначе программный.
    fn new(codec: VideoCodec, width: u32, height: u32, fps: u32, bitrate: u32, allow_hardware: bool) -> Result<Self> {
        if allow_hardware {
            let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
            let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: subtype(codec) };
            let flags = (MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0) as u32;
            for activate in mf::mft_enum_ex(MFT_CATEGORY_VIDEO_ENCODER, flags, &input, &output).unwrap_or_default() {
                let name = unsafe { friendly_name(&activate) };
                let Ok(mft) = (unsafe { activate.ActivateObject::<IMFTransform>() }) else { continue };
                match Self::setup(mft, Some(activate.clone()), codec, width, height, fps, bitrate, name.clone()) {
                    Ok(enc) => return Ok(enc),
                    Err(error) => {
                        tracing::warn!("[ZALI][WIN] {} hardware encoder {name} rejected {width}x{height}@{fps}: {error}", codec.name());
                        unsafe {
                            let _ = activate.ShutdownObject();
                        }
                    }
                }
            }
        }
        if codec != VideoCodec::H264 {
            return Err(windows::core::Error::new(windows::Win32::Foundation::E_FAIL, format!("нет аппаратного кодировщика {}", codec.name())));
        }
        let mft: IMFTransform = unsafe { CoCreateInstance(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER)? };
        Self::setup(mft, None, codec, width, height, fps, bitrate, "Microsoft H.264 (software)".into())
    }

    fn setup(
        mft: IMFTransform,
        activate: Option<IMFActivate>,
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        name: String,
    ) -> Result<Self> {
        unsafe {
            let attrs = mft.GetAttributes().ok();
            let is_async = attrs.as_ref().map(|a| a.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0).unwrap_or(false);
            if let Some(a) = &attrs {
                if is_async {
                    a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                }
                let _ = a.SetUINT32(&MF_LOW_LATENCY, 1);
            }
            let codec_api: Option<ICodecAPI> = mft.cast().ok();
            if let Some(api) = &codec_api {
                set_codec(api, &CODECAPI_AVLowLatencyMode, VARIANT::from(true));
                // Низкая задержка без B-кадров; ключевые — по запросу SFU, по таймеру редко.
                if !set_codec(api, &CODECAPI_AVEncCommonRateControlMode, VARIANT::from(eAVEncCommonRateControlMode_LowDelayVBR.0 as u32)) {
                    set_codec(api, &CODECAPI_AVEncCommonRateControlMode, VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32));
                }
                set_codec(api, &CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bitrate));
                set_codec(api, &CODECAPI_AVEncMPVGOPSize, VARIANT::from(fps.saturating_mul(10)));
                set_codec(api, &CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0u32));
            }
            let size = ((width as u64) << 32) | height as u64;
            let rate = ((fps as u64) << 32) | 1;
            let out = mf::create_media_type()?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out.SetGUID(&MF_MT_SUBTYPE, &subtype(codec))?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, size)?;
            out.SetUINT64(&MF_MT_FRAME_RATE, rate)?;
            out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
            out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            match codec {
                VideoCodec::H264 => out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32)?,
                // Профиль — подсказка: кодировщик без этого ключа всё равно отдаёт Main.
                VideoCodec::H265 => {
                    let _ = out.SetUINT32(&MF_MT_VIDEO_PROFILE, eAVEncH265VProfile_Main_420_8.0 as u32);
                }
                VideoCodec::Av1 => {}
            }
            mft.SetOutputType(0, &out, 0)?;
            let inp = mf::create_media_type()?;
            inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            inp.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            inp.SetUINT64(&MF_MT_FRAME_SIZE, size)?;
            inp.SetUINT64(&MF_MT_FRAME_RATE, rate)?;
            inp.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
            inp.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            inp.SetUINT32(&MF_MT_DEFAULT_STRIDE, width)?;
            mft.SetInputType(0, &inp, 0)?;

            let events = if is_async { Some(mft.cast::<IMFMediaEventGenerator>()?) } else { None };
            let mut enc = Self {
                mft,
                events,
                codec_api,
                activate,
                need_input: 0,
                provides_samples: false,
                out_size: 0,
                seq_header: Vec::new(),
                codec,
                width,
                height,
                fps,
                name,
            };
            enc.refresh_output_info()?;
            enc.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            enc.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(enc)
        }
    }

    fn refresh_output_info(&mut self) -> Result<()> {
        unsafe {
            let info = self.mft.GetOutputStreamInfo(0)?;
            self.provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32) != 0;
            self.out_size = info.cbSize.max(self.width * self.height * 3 / 2).max(64 * 1024);
            if let Ok(t) = self.mft.GetOutputCurrentType(0) {
                if let Ok(len) = t.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                    let mut blob = vec![0u8; len as usize];
                    if t.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, None).is_ok() {
                        // У AV1 здесь бывает запись av1C (маркер 0x81, 4 байта) с OBU после неё.
                        if self.codec == VideoCodec::Av1 && blob.len() > 4 && blob[0] == 0x81 {
                            blob.drain(..4);
                        }
                        if has_params(&blob, self.codec) {
                            self.seq_header = blob;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn force_keyframe(&self) {
        if let Some(api) = &self.codec_api {
            set_codec(api, &CODECAPI_AVEncVideoForceKeyFrame, VARIANT::from(1u32));
        }
    }

    fn set_bitrate(&self, bps: u32) {
        if let Some(api) = &self.codec_api {
            set_codec(api, &CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bps));
        }
    }

    fn make_sample(&self, nv12: &[u8], pts_us: i64) -> Result<IMFSample> {
        unsafe {
            let buffer = mf::create_memory_buffer(nv12.len() as u32)?;
            let mut ptr = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, nv12.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(nv12.len() as u32)?;
            let sample = mf::create_sample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(pts_us.max(0) * 10)?;
            sample.SetSampleDuration(10_000_000 / self.fps.max(1) as i64)?;
            Ok(sample)
        }
    }

    /// Один ProcessOutput. `Ok(false)` — кодировщику нужно больше входа.
    fn pull_output(&mut self, out: &mut Vec<(Vec<u8>, bool, i64)>) -> Result<bool> {
        unsafe {
            let sample = if self.provides_samples {
                None
            } else {
                let s = mf::create_sample()?;
                s.AddBuffer(&mf::create_memory_buffer(self.out_size)?)?;
                Some(s)
            };
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let mut status = 0u32;
            let result = self.mft.ProcessOutput(0, &mut buffers, &mut status);
            let [mut buffer] = buffers;
            let sample = ManuallyDrop::take(&mut buffer.pSample);
            ManuallyDrop::drop(&mut buffer.pEvents);
            match result {
                Ok(()) => {
                    if let Some(sample) = sample {
                        self.take_sample(&sample, out)?;
                    }
                    Ok(true)
                }
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(false),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    let t = self.mft.GetOutputAvailableType(0, 0)?;
                    self.mft.SetOutputType(0, &t, 0)?;
                    self.refresh_output_info()?;
                    Ok(true)
                }
                Err(e) => Err(e),
            }
        }
    }

    fn take_sample(&mut self, sample: &IMFSample, out: &mut Vec<(Vec<u8>, bool, i64)>) -> Result<()> {
        unsafe {
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut ptr, None, Some(&mut len))?;
            let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            buffer.Unlock()?;
            if data.is_empty() {
                return Ok(());
            }
            let key = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0 || is_key_payload(&data, self.codec);
            // Метка выхода — от его входа: у асинхронного кодировщика выход приходит позже,
            // уже с меткой следующего кадра на руках (100 нс → мкс).
            let pts = sample.GetSampleTime().map(|t| t / 10).unwrap_or(-1);
            if key && !has_params(&data, self.codec) && !self.seq_header.is_empty() {
                let mut full = self.seq_header.clone();
                full.extend_from_slice(&data);
                out.push((full, true, pts));
            } else {
                out.push((data, key, pts));
            }
            Ok(())
        }
    }

    /// События асинхронного кодировщика, что уже пришли.
    fn pump_events(&mut self, out: &mut Vec<(Vec<u8>, bool, i64)>) -> Result<()> {
        let Some(events) = self.events.clone() else { return Ok(()) };
        loop {
            let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(e) => e,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                Err(e) => return Err(e),
            };
            let kind = unsafe { event.GetType()? };
            if kind == METransformNeedInput.0 as u32 {
                self.need_input += 1;
            } else if kind == METransformHaveOutput.0 as u32 {
                self.pull_output(out)?;
            }
        }
    }

    /// Кадр NV12 → готовые кадры (у асинхронного выход может прийти со следующим).
    fn encode(&mut self, nv12: &[u8], pts_us: i64, out: &mut Vec<(Vec<u8>, bool, i64)>) -> Result<bool> {
        let sample = self.make_sample(nv12, pts_us)?;
        if self.events.is_some() {
            self.pump_events(out)?;
            let until = Instant::now() + ASYNC_INPUT_WAIT;
            while self.need_input == 0 && Instant::now() < until {
                std::thread::sleep(Duration::from_micros(300));
                self.pump_events(out)?;
            }
            if self.need_input == 0 {
                return Ok(false);
            }
            unsafe { self.mft.ProcessInput(0, &sample, 0)? };
            self.need_input -= 1;
            let before = out.len();
            let until = Instant::now() + ASYNC_OUTPUT_WAIT;
            while out.len() == before && Instant::now() < until {
                std::thread::sleep(Duration::from_micros(300));
                self.pump_events(out)?;
            }
        } else {
            unsafe { self.mft.ProcessInput(0, &sample, 0)? };
            while self.pull_output(out)? {}
        }
        Ok(true)
    }

    fn is_hardware(&self) -> bool {
        self.activate.is_some()
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            if let Some(a) = &self.activate {
                let _ = a.ShutdownObject();
            }
        }
    }
}

unsafe fn friendly_name(activate: &IMFActivate) -> String {
    let mut raw = windows::core::PWSTR::null();
    let mut len = 0u32;
    if activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut raw, &mut len).is_ok() {
        super::com::take_co_string(raw)
    } else {
        "hardware".into()
    }
}

/// Управление кодировщиком слоя извне (бюджет SFU и запросы ключевых кадров).
#[derive(Default)]
struct Control {
    bitrate: Option<u32>,
    keyframe: bool,
}

/// Готовый кадр слоя (Annex B; у AV1 — OBU), ключевой ли, метка захвата (мкс).
pub type OutputFn = Box<dyn FnMut(Vec<u8>, bool, i64) + Send + 'static>;

/// Кодировщик одного слоя в своём потоке.
pub struct LayerEncoder {
    tx: Option<SyncSender<(Vec<u8>, i64)>>,
    control: Arc<Mutex<Control>>,
    handle: Option<JoinHandle<()>>,
    pub description: String,
}

impl LayerEncoder {
    pub fn spawn(
        index: usize,
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        mut output: OutputFn,
    ) -> std::result::Result<Self, String> {
        let (tx, rx): (SyncSender<(Vec<u8>, i64)>, Receiver<(Vec<u8>, i64)>) = mpsc::sync_channel(1);
        let (ready_tx, ready_rx) = mpsc::channel::<std::result::Result<String, String>>();
        let control: Arc<Mutex<Control>> = Arc::default();
        let ctl = Arc::clone(&control);
        let handle = std::thread::Builder::new()
            .name(format!("zali-{}-layer{index}", codec.name().to_ascii_lowercase()))
            .spawn(move || {
                let _com = ComGuard::new();
                let mut encoder = match Encoder::new(codec, width, height, fps, bitrate, true) {
                    Ok(e) => e,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("{error}")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(format!("{} {}", encoder.name, if encoder.is_hardware() { "hw" } else { "sw" })));
                let mut current_bitrate = bitrate;
                let mut out = Vec::new();
                let mut retried = false;
                let mut first = true;
                while let Ok((nv12, pts)) = rx.recv() {
                    let (new_bitrate, key) = {
                        let mut c = ctl.lock().unwrap_or_else(|p| p.into_inner());
                        (c.bitrate.take(), std::mem::take(&mut c.keyframe))
                    };
                    if let Some(bps) = new_bitrate.filter(|b| *b != current_bitrate && *b > 0) {
                        encoder.set_bitrate(bps);
                        current_bitrate = bps;
                    }
                    if key || first {
                        encoder.force_keyframe();
                        first = false;
                    }
                    out.clear();
                    if let Err(error) = encoder.encode(&nv12, pts, &mut out) {
                        // Аппаратный кодировщик отказал посреди потока — один раз на программный
                        // (есть только у H.264; у H.265/AV1 слой умирает, и страница перезапустит
                        // показ — encoder_failed).
                        tracing::warn!("[ZALI][WIN] {} layer{index} {} failed: {error}", codec.name(), encoder.name);
                        if retried || codec != VideoCodec::H264 {
                            return;
                        }
                        retried = true;
                        drop(encoder);
                        encoder = match Encoder::new(codec, width, height, fps, current_bitrate, false) {
                            Ok(e) => e,
                            Err(error) => {
                                tracing::warn!("[ZALI][WIN] h264 layer{index} software fallback failed: {error}");
                                return;
                            }
                        };
                        first = true;
                        continue;
                    }
                    for (data, keyframe, out_pts) in out.drain(..) {
                        output(data, keyframe, if out_pts >= 0 { out_pts } else { pts });
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(description)) => Ok(Self { tx: Some(tx), control, handle: Some(handle), description }),
            Ok(Err(error)) => {
                let _ = handle.join();
                Err(error)
            }
            Err(_) => Err(format!("кодировщик {} не ответил за 5 с", codec.name())),
        }
    }

    /// `false` — поток ещё занят прошлым кадром (этот выброшен) или кончился.
    pub fn submit(&self, nv12: Vec<u8>, pts_us: i64) -> bool {
        match self.tx.as_ref().map(|tx| tx.try_send((nv12, pts_us))) {
            Some(Ok(())) => true,
            Some(Err(TrySendError::Full(_))) | Some(Err(TrySendError::Disconnected(_))) | None => false,
        }
    }

    /// Поток кодировщика ещё работает (не отказал и программный запасной).
    pub fn alive(&self) -> bool {
        self.handle.as_ref().is_some_and(|h| !h.is_finished())
    }

    pub fn set_bitrate(&self, bps: u32) {
        self.control.lock().unwrap_or_else(|p| p.into_inner()).bitrate = Some(bps);
    }

    pub fn request_keyframe(&self) {
        self.control.lock().unwrap_or_else(|p| p.into_inner()).keyframe = true;
    }
}

impl Drop for LayerEncoder {
    fn drop(&mut self) {
        self.tx = None;
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}
