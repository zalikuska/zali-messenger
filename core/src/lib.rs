#[cfg(feature = "android")]
pub mod android_jni;
pub mod bus;
pub mod crypto;
pub mod loader;
pub mod net;

use loader::ZaliLoader;
use std::sync::{OnceLock, RwLock};

pub(crate) fn get_loader() -> &'static RwLock<ZaliLoader> {
    static LOADER: OnceLock<RwLock<ZaliLoader>> = OnceLock::new();
    LOADER.get_or_init(|| {
        let mut loader = ZaliLoader::new();
        loader.register_module(crypto::ZaliCrypto).unwrap();
        loader.register_module(net::ZaliNet).unwrap();
        RwLock::new(loader)
    })
}

// --- Dynamic Unified FFI Bus Interface ---

#[no_mangle]
/// # Safety
///
/// `address_command` and `args_json` must be valid, non-null, NUL-terminated C strings.
/// The returned pointer must be released exactly once with `zali_bus_free_string`.
pub unsafe extern "C" fn zali_bus_dispatch(
    address_command: *const std::os::raw::c_char,
    args_json: *const std::os::raw::c_char,
) -> *mut std::os::raw::c_char {
    use std::ffi::{CStr, CString};
    if address_command.is_null() || args_json.is_null() {
        return std::ptr::null_mut();
    }

    let addr_cmd = unsafe {
        CStr::from_ptr(address_command)
            .to_string_lossy()
            .into_owned()
    };
    let args_str = unsafe { CStr::from_ptr(args_json).to_string_lossy() };

    let args_val: serde_json::Value = match serde_json::from_str(&args_str) {
        Ok(v) => v,
        Err(e) => {
            let err_json = serde_json::json!({
                "success": false,
                "error": format!("Invalid JSON args: {}", e)
            });
            let safe = err_json.to_string().replace('\0', "");
            return CString::new(safe)
                .unwrap_or_else(|_| CString::new(r#"{"success":false}"#).unwrap())
                .into_raw();
        }
    };

    let result = {
        let guard = get_loader().read().unwrap_or_else(|e| e.into_inner());
        guard.bus.send(&addr_cmd, args_val)
    };

    let response_json = match result {
        Ok(val) => serde_json::json!({
            "success": true,
            "data": val
        }),
        Err(err) => serde_json::json!({
            "success": false,
            "error": err
        }),
    };

    let safe = response_json.to_string().replace('\0', "");
    CString::new(safe)
        .unwrap_or_else(|_| CString::new(r#"{"success":false}"#).unwrap())
        .into_raw()
}

#[no_mangle]
/// # Safety
///
/// `ptr` must be a pointer returned by `zali_bus_dispatch` and must not be freed more than once.
pub unsafe extern "C" fn zali_bus_free_string(ptr: *mut std::os::raw::c_char) {
    if !ptr.is_null() {
        unsafe {
            drop(std::ffi::CString::from_raw(ptr));
        }
    }
}

// --- Backward-Compatible Legacy FFI Bridge (Routed Through ZaliBus) ---

#[no_mangle]
/// # Safety
///
/// `sender`, `text`, and `output` must be valid, non-null, NUL-terminated C strings.
pub unsafe extern "C" fn zali_pack_message(
    sender: *const std::os::raw::c_char,
    text: *const std::os::raw::c_char,
    output: *const std::os::raw::c_char,
) -> bool {
    use std::ffi::CStr;
    if sender.is_null() || text.is_null() || output.is_null() {
        return false;
    }
    let s = unsafe { CStr::from_ptr(sender).to_string_lossy() };
    let t = unsafe { CStr::from_ptr(text).to_string_lossy() };
    let o = unsafe { CStr::from_ptr(output).to_string_lossy() };

    let guard = get_loader().read().unwrap_or_else(|e| e.into_inner());
    let bus = &guard.bus;

    let Some(key) = std::env::var("ZALI_E2E_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
    else {
        return false;
    };

    let args = serde_json::json!({
        "sender": s,
        "text": t,
        "key": key,
        "output_path": o
    });

    bus.send("zali_net:pack_message", args).is_ok()
}

#[no_mangle]
/// # Safety
///
/// Input pointers must be valid, non-null, NUL-terminated C strings. Output buffers must be valid
/// for writes of `out_sender_max_len` and `out_text_max_len` bytes respectively.
pub unsafe extern "C" fn zali_unpack_message(
    archive_path: *const std::os::raw::c_char,
    temp_dir: *const std::os::raw::c_char,
    out_sender: *mut std::os::raw::c_char,
    out_sender_max_len: usize,
    out_text: *mut std::os::raw::c_char,
    out_text_max_len: usize,
) -> bool {
    use std::ffi::{CStr, CString};
    if archive_path.is_null() || temp_dir.is_null() || out_sender.is_null() || out_text.is_null() {
        return false;
    }
    let a_path = unsafe { CStr::from_ptr(archive_path).to_string_lossy() };
    let t_dir = unsafe { CStr::from_ptr(temp_dir).to_string_lossy() };

    let guard = get_loader().read().unwrap_or_else(|e| e.into_inner());
    let bus = &guard.bus;

    let Some(key) = std::env::var("ZALI_E2E_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
    else {
        return false;
    };

    let args = serde_json::json!({
        "archive_path": a_path,
        "temp_dir": t_dir,
        "key": key
    });

    match bus.send("zali_net:unpack_message", args) {
        Ok(result) => {
            let sender = result["sender"].as_str().unwrap_or("");
            let text = result["text"].as_str().unwrap_or("");

            let sender_c = match CString::new(sender) {
                Ok(s) => s,
                Err(_) => return false,
            };
            let text_c = match CString::new(text) {
                Ok(s) => s,
                Err(_) => return false,
            };

            let sender_bytes = sender_c.as_bytes_with_nul();
            if sender_bytes.len() > out_sender_max_len {
                return false;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(
                    sender_bytes.as_ptr() as *const std::os::raw::c_char,
                    out_sender,
                    sender_bytes.len(),
                );
            }

            let text_bytes = text_c.as_bytes_with_nul();
            if text_bytes.len() > out_text_max_len {
                return false;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(
                    text_bytes.as_ptr() as *const std::os::raw::c_char,
                    out_text,
                    text_bytes.len(),
                );
            }

            true
        }
        Err(_) => false,
    }
}

// --- WASM Bridge for Web ---
//
// Browser client has no filesystem, so it needs the .zali archive format
// available purely in memory. These wrap net::pack_message_bytes /
// net::unpack_message_bytes (which produce/consume the exact same wire
// format as the native path-based API — see core/src/net.rs) for JS.

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmAttachmentIn {
    name: String,
    archive_path: String,
    mime_type: String,
    kind: String,
    bytes: Vec<u8>,
}

#[cfg(feature = "wasm")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmAttachmentOut {
    name: String,
    archive_path: String,
    mime_type: String,
    kind: String,
    bytes: Vec<u8>,
}

#[cfg(feature = "wasm")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmUnpacked {
    sender: String,
    text: String,
    timestamp: u64,
    key_version: u8,
    attachments: Vec<WasmAttachmentOut>,
}

/// Packs a message (+ optional attachments) into `.zali` archive bytes.
/// `attachments` is a JS array of `{name, archivePath, mimeType, kind, bytes: Uint8Array}`,
/// or `undefined`/`null` for none.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn pack_message_wasm(
    sender: &str,
    text: &str,
    key: &str,
    key_version: u8,
    attachments: JsValue,
) -> Result<Vec<u8>, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
    let atts: Vec<WasmAttachmentIn> = if attachments.is_undefined() || attachments.is_null() {
        Vec::new()
    } else {
        serde_wasm_bindgen::from_value(attachments)
            .map_err(|e| JsValue::from_str(&e.to_string()))?
    };
    let in_memory = atts
        .into_iter()
        .map(|a| net::InMemoryAttachment {
            name: a.name,
            archive_path: a.archive_path,
            mime_type: a.mime_type,
            kind: a.kind,
            bytes: a.bytes,
        })
        .collect();
    net::pack_message_bytes(sender, text, key, key_version, in_memory)
        .map_err(|e| JsValue::from_str(&e))
}

/// Decodes `.zali` archive bytes into `{sender, text, timestamp, keyVersion, attachments}`,
/// where each attachment carries its raw bytes as a `Uint8Array`.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn unpack_message_wasm(archive: &[u8], key: &str) -> Result<JsValue, JsValue> {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
    let unpacked = net::unpack_message_bytes(archive, key).map_err(|e| JsValue::from_str(&e))?;
    let out = WasmUnpacked {
        sender: unpacked.sender,
        text: unpacked.text,
        timestamp: unpacked.timestamp,
        key_version: unpacked.key_version,
        attachments: unpacked
            .attachments
            .into_iter()
            .map(|a| WasmAttachmentOut {
                name: a.name,
                archive_path: a.archive_path,
                mime_type: a.mime_type,
                kind: a.kind,
                bytes: a.bytes,
            })
            .collect(),
    };
    serde_wasm_bindgen::to_value(&out).map_err(|e| JsValue::from_str(&e.to_string()))
}
