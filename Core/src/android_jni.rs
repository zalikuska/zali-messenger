//! JNI bridge for Android — mirrors the C ABI's `zali_bus_dispatch` (see `lib.rs`)
//! with JNI types instead of raw C strings. Same JSON-in/JSON-out `ZaliBus` command
//! protocol as macOS/iOS, so `Web/src/interface.js`'s `zali_net:pack_message` /
//! `zali_net:unpack_message` calls work identically.
//!
//! Registered by naming convention (`Java_<package>_<Class>_<method>`), matching
//! `ZaliCoreBridge.kt`'s `external fun busDispatch(...)` in the
//! `org.zalikus.messenger` app package — the package name is baked into the symbol
//! name, so renaming the Android app package requires renaming this function too.
//!
//! No `free` function is needed here (unlike the C ABI's `zali_bus_free_string`):
//! `env.new_string(...).into_raw()` returns a JVM local reference, which the JVM
//! reclaims automatically when the native method returns.
#![cfg(feature = "android")]

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;

#[no_mangle]
pub extern "system" fn Java_org_zalikus_messenger_ZaliCoreBridge_busDispatch<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    address_command: JString<'local>,
    args_json: JString<'local>,
) -> jstring {
    let addr_cmd: String = match env.get_string(&address_command) {
        Ok(s) => s.into(),
        Err(_) => return std::ptr::null_mut(),
    };
    let args_str: String = match env.get_string(&args_json) {
        Ok(s) => s.into(),
        Err(_) => return std::ptr::null_mut(),
    };

    let args_val: serde_json::Value = match serde_json::from_str(&args_str) {
        Ok(v) => v,
        Err(e) => {
            let err_json = serde_json::json!({
                "success": false,
                "error": format!("Invalid JSON args: {}", e)
            });
            return env
                .new_string(err_json.to_string())
                .map(|s| s.into_raw())
                .unwrap_or(std::ptr::null_mut());
        }
    };

    let result = {
        let guard = crate::get_loader().read().unwrap_or_else(|e| e.into_inner());
        guard.bus.send(&addr_cmd, args_val)
    };

    let response_json = match result {
        Ok(val) => serde_json::json!({ "success": true, "data": val }),
        Err(err) => serde_json::json!({ "success": false, "error": err }),
    };

    env.new_string(response_json.to_string())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
