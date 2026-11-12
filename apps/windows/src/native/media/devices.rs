//! Список микрофонов (MMDevice) и камер (Media Foundation), уведомления об изменениях.

use super::com::{take_co_string, ComGuard};
use super::EventSink;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use windows::core::{implement, Result, PCWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator, IMMNotificationClient,
    IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE,
};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
};
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, STGM_READ};

pub fn enumerator() -> Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

pub fn device_id(device: &IMMDevice) -> String {
    unsafe { device.GetId().map(|id| take_co_string(id)).unwrap_or_default() }
}

pub fn friendly_name(device: &IMMDevice) -> String {
    unsafe {
        let Ok(store) = device.OpenPropertyStore(STGM_READ) else {
            return String::new();
        };
        let Ok(mut value) = store.GetValue(&PKEY_Device_FriendlyName) else {
            return String::new();
        };
        let text = PropVariantToStringAlloc(&value).map(|s| take_co_string(s)).unwrap_or_default();
        let _ = PropVariantClear(&mut value);
        text
    }
}

/// Микрофон по id или по умолчанию (роль `eConsole` — см. шапку mod.rs).
pub fn capture_device(id: &str) -> Result<IMMDevice> {
    let enumerator = enumerator()?;
    unsafe {
        if id.is_empty() {
            enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)
        } else {
            let wide = super::com::wide(id);
            enumerator.GetDevice(PCWSTR(wide.as_ptr()))
        }
    }
}

fn list_audio_inputs() -> Vec<Value> {
    let Ok(enumerator) = enumerator() else {
        return Vec::new();
    };
    let default_id = unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) }
        .map(|d| device_id(&d))
        .unwrap_or_default();
    let mut out = Vec::new();
    unsafe {
        let Ok(collection) = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else {
            return out;
        };
        let count = collection.GetCount().unwrap_or(0);
        for i in 0..count {
            let Ok(device) = collection.Item(i) else { continue };
            let id = device_id(&device);
            if id.is_empty() {
                continue;
            }
            out.push(json!({
                "id": id,
                "label": friendly_name(&device),
                "isDefault": id == default_id,
            }));
        }
    }
    out
}

/// Камера: символьная ссылка (стабильный id) + имя + активатор.
pub struct CameraDevice {
    pub id: String,
    pub label: String,
    pub activate: IMFActivate,
}

unsafe fn allocated_string(attrs: &IMFActivate, key: &windows::core::GUID) -> String {
    let mut raw = windows::core::PWSTR::null();
    let mut len = 0u32;
    if attrs.GetAllocatedString(key, &mut raw, &mut len).is_err() {
        return String::new();
    }
    take_co_string(raw)
}

pub fn cameras() -> Vec<CameraDevice> {
    let attrs = match super::mf::create_attributes(1) {
        Ok(attrs) => attrs,
        // Нет Media Foundation (Windows N без Media Feature Pack) — камер нет.
        Err(_) => return Vec::new(),
    };
    let listed = unsafe {
        attrs
            .SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)
            .and_then(|_| super::mf::enum_device_sources(&attrs))
    };
    listed
        .unwrap_or_default()
        .into_iter()
        .filter_map(|activate| {
            let id = unsafe { allocated_string(&activate, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK) };
            let label = unsafe { allocated_string(&activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME) };
            (!id.is_empty()).then_some(CameraDevice { id, label, activate })
        })
        .collect()
}

/// Ответ на `list_devices`.
pub fn list_devices() -> Value {
    let _com = ComGuard::new();
    let video: Vec<Value> = cameras()
        .iter()
        .enumerate()
        .map(|(i, cam)| json!({ "id": cam.id, "label": cam.label, "isDefault": i == 0 }))
        .collect();
    json!({
        "event": "devices",
        "audioinput": list_audio_inputs(),
        "videoinput": video,
    })
}

// --- Уведомления об изменении набора аудиоустройств -------------------------------

#[implement(IMMNotificationClient)]
struct DeviceNotifier;

static NOTIFY_SINK: Mutex<Option<EventSink>> = Mutex::new(None);
static LAST_NOTIFY_MS: AtomicU64 = AtomicU64::new(0);

fn notify_devices_changed() {
    // Одно подключение гарнитуры — это пачка из 3–6 обратных вызовов; странице
    // хватает одного события.
    let now = (super::com::now_us() / 1000).max(1);
    let last = LAST_NOTIFY_MS.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < 500 {
        return;
    }
    LAST_NOTIFY_MS.store(now, Ordering::Relaxed);
    if let Some(sink) = NOTIFY_SINK.lock().ok().and_then(|g| g.clone()) {
        sink.emit(json!({ "event": "devices_changed" }));
    }
}

impl IMMNotificationClient_Impl for DeviceNotifier_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> Result<()> {
        notify_devices_changed();
        Ok(())
    }
    fn OnDeviceAdded(&self, _id: &PCWSTR) -> Result<()> {
        notify_devices_changed();
        Ok(())
    }
    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> Result<()> {
        notify_devices_changed();
        Ok(())
    }
    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _id: &PCWSTR) -> Result<()> {
        if flow == eCapture && role == eConsole {
            notify_devices_changed();
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> Result<()> {
        Ok(())
    }
}

/// Подписка на изменения — один раз за процесс, в своём MTA-потоке: объекты должны
/// жить, пока жив процесс, а поток окна — STA WebView2.
pub fn watch_device_changes(sink: &EventSink) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if let Ok(mut guard) = NOTIFY_SINK.lock() {
        *guard = Some(sink.clone());
    }
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new().name("zali-media-devwatch".into()).spawn(|| {
            let _com = ComGuard::new();
            let Ok(enumerator) = enumerator() else { return };
            let client: IMMNotificationClient = DeviceNotifier.into();
            if unsafe { enumerator.RegisterEndpointNotificationCallback(&client) }.is_err() {
                return;
            }
            // Держим enumerator и client живыми до конца процесса.
            loop {
                std::thread::park();
            }
        });
    });
}
