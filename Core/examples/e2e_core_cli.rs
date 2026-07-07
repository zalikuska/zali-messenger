use serde_json::json;
use std::env;
use std::ffi::{CStr, CString};

fn dispatch(command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let command = CString::new(command).map_err(|e| e.to_string())?;
    let args = CString::new(args.to_string()).map_err(|e| e.to_string())?;
    let ptr = unsafe { zali_messenger_core::zali_bus_dispatch(command.as_ptr(), args.as_ptr()) };
    if ptr.is_null() {
        return Err("core returned null".to_string());
    }
    let text = unsafe {
        let text = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        zali_messenger_core::zali_bus_free_string(ptr);
        text
    };
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn main() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("pack") => {
            let sender = args.get(2).ok_or("missing sender")?;
            let text = args.get(3).ok_or("missing text")?;
            let key = args.get(4).ok_or("missing key")?;
            let output_path = args.get(5).ok_or("missing output_path")?;
            let response = dispatch(
                "zali_net:pack_message",
                json!({
                    "sender": sender,
                    "text": text,
                    "key": key,
                    "output_path": output_path,
                    "key_version": 2,
                    "attachments": [],
                }),
            )?;
            println!("{}", response);
            Ok(())
        }
        Some("unpack") => {
            let archive_path = args.get(2).ok_or("missing archive_path")?;
            let temp_dir = args.get(3).ok_or("missing temp_dir")?;
            let key = args.get(4).ok_or("missing key")?;
            let response = dispatch(
                "zali_net:unpack_message",
                json!({
                    "archive_path": archive_path,
                    "temp_dir": temp_dir,
                    "key": key,
                }),
            )?;
            println!("{}", response);
            Ok(())
        }
        _ => Err("usage: e2e_core_cli pack <sender> <text> <key> <output_path> | unpack <archive_path> <temp_dir> <key>".to_string()),
    }
}
