//! Функции Media Foundation через `LoadLibraryExW` + `GetProcAddress`, а не через
//! таблицу импорта.
//!
//! В Windows N/KN без Media Feature Pack нет `mf.dll`/`mfplat.dll`/`mfreadwrite.dll`.
//! Статический импорт (как делает крейт `windows`) означал бы, что загрузчик не
//! запустит exe вообще — весь мессенджер, а не только камера. Методы интерфейсов
//! (IMFSourceReader и т.п.) идут через vtable и импорта не требуют — динамически
//! грузятся только эти пять свободных функций.

use std::ffi::c_void;
use std::sync::OnceLock;
use windows::core::{s, w, Interface, Result, HRESULT, PCSTR, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaSource, IMFMediaType, IMFSourceReader, MF_VERSION,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};

type MfStartupFn = unsafe extern "system" fn(u32, u32) -> HRESULT;
type MfCreateAttributesFn = unsafe extern "system" fn(*mut *mut c_void, u32) -> HRESULT;
type MfCreateMediaTypeFn = unsafe extern "system" fn(*mut *mut c_void) -> HRESULT;
type MfEnumDeviceSourcesFn = unsafe extern "system" fn(*mut c_void, *mut *mut *mut c_void, *mut u32) -> HRESULT;
type MfCreateSourceReaderFn = unsafe extern "system" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> HRESULT;

struct Api {
    create_attributes: MfCreateAttributesFn,
    create_media_type: MfCreateMediaTypeFn,
    enum_device_sources: MfEnumDeviceSourcesFn,
    create_source_reader: MfCreateSourceReaderFn,
}

const MFSTARTUP_NOSOCKET: u32 = 1;

unsafe fn proc(dll: PCWSTR, name: PCSTR) -> Option<unsafe extern "system" fn() -> isize> {
    let module = LoadLibraryExW(dll, None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
    GetProcAddress(module, name)
}

fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| unsafe {
        let startup: MfStartupFn = std::mem::transmute(proc(w!("mfplat.dll"), s!("MFStartup"))?);
        let api = Api {
            create_attributes: std::mem::transmute(proc(w!("mfplat.dll"), s!("MFCreateAttributes"))?),
            create_media_type: std::mem::transmute(proc(w!("mfplat.dll"), s!("MFCreateMediaType"))?),
            enum_device_sources: std::mem::transmute(proc(w!("mf.dll"), s!("MFEnumDeviceSources"))?),
            create_source_reader: std::mem::transmute(proc(w!("mfreadwrite.dll"), s!("MFCreateSourceReaderFromMediaSource"))?),
        };
        // Один раз на процесс; MFShutdown не зовём — Media Foundation живёт до выхода.
        if startup(MF_VERSION, MFSTARTUP_NOSOCKET).is_err() {
            return None;
        }
        Some(api)
    })
    .as_ref()
}

fn missing() -> windows::core::Error {
    // REGDB_E_CLASSNOTREG → код протокола `unsupported`.
    windows::core::Error::from(HRESULT(0x8004_0154u32 as i32))
}

pub fn create_attributes(initial: u32) -> Result<IMFAttributes> {
    let api = api().ok_or_else(missing)?;
    unsafe {
        let mut raw = std::ptr::null_mut();
        (api.create_attributes)(&mut raw, initial).ok()?;
        Ok(IMFAttributes::from_raw(raw))
    }
}

pub fn create_media_type() -> Result<IMFMediaType> {
    let api = api().ok_or_else(missing)?;
    unsafe {
        let mut raw = std::ptr::null_mut();
        (api.create_media_type)(&mut raw).ok()?;
        Ok(IMFMediaType::from_raw(raw))
    }
}

pub fn enum_device_sources(attrs: &IMFAttributes) -> Result<Vec<IMFActivate>> {
    let api = api().ok_or_else(missing)?;
    unsafe {
        let mut list: *mut *mut c_void = std::ptr::null_mut();
        let mut count = 0u32;
        (api.enum_device_sources)(attrs.as_raw(), &mut list, &mut count).ok()?;
        let mut out = Vec::with_capacity(count as usize);
        if !list.is_null() {
            for i in 0..count as usize {
                let raw = *list.add(i);
                if !raw.is_null() {
                    // Забираем ссылку каждого элемента; сам массив — CoTaskMemFree.
                    out.push(IMFActivate::from_raw(raw));
                }
            }
            CoTaskMemFree(Some(list as *const _));
        }
        Ok(out)
    }
}

pub fn create_source_reader(source: &IMFMediaSource, attrs: &IMFAttributes) -> Result<IMFSourceReader> {
    let api = api().ok_or_else(missing)?;
    unsafe {
        let mut raw = std::ptr::null_mut();
        (api.create_source_reader)(source.as_raw(), attrs.as_raw(), &mut raw).ok()?;
        Ok(IMFSourceReader::from_raw(raw))
    }
}
