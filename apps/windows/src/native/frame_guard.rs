//! Изоляция нативного моста от вложенных фреймов.
//!
//! Песочница аддона (`web/src/interface/addons*.js`) — это `<iframe sandbox>`
//! внутри того же вебвью, а WebView2 делает две вещи, которые без этого модуля
//! отдали бы ей всё приложение:
//!
//! - `AddScriptToExecuteOnDocumentCreated` (wry `with_initialization_script`)
//!   выполняет скрипт «во всех документах верхнего уровня и дочерних фреймах».
//!   Наш init-скрипт кладёт в `window` токен сессии, ключи переписок, приватный
//!   ключ устройства и кеш сообщений — во фрейме аддона они оказались бы тоже.
//!   Поэтому весь скрипт завёрнут в проверку `window.top !== window`.
//! - `window.ipc` wry определяет в каждом фрейме. В Windows сообщение из
//!   дочернего фрейма до `WebMessageReceived` верхнего уровня не доходит, но
//!   экспериментальный macOS Rust-шелл (тот же крейт, WKWebView) кадр
//!   отправителя не проверяет вообще. Поэтому `handle_ipc_message` принимает
//!   только сообщения с `bridgeNonce` — секретом этого запуска, который знает
//!   лишь верхний фрейм (`web/src/bootstrap.js` прячет его в замыкание).
//!
//! macOS Swift-клиент решает то же самое `forMainFrameOnly: true` и проверкой
//! `message.frameInfo.isMainFrame`, Android — тем же секретом в `NativeBridge.kt`.

use serde_json::Value;
use std::sync::OnceLock;

static BRIDGE_NONCE: OnceLock<String> = OnceLock::new();

/// Секрет моста на время жизни процесса: 2 × UUIDv4 (getrandom), 244 бита.
pub(crate) fn bridge_nonce() -> &'static str {
    BRIDGE_NONCE.get_or_init(|| {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    })
}

/// Сообщение пришло от нашего верхнего фрейма: несёт верный `bridgeNonce`.
pub(crate) fn bridge_nonce_matches(payload: &Value) -> bool {
    payload
        .get("bridgeNonce")
        .and_then(Value::as_str)
        .map(|got| constant_time_eq(got.as_bytes(), bridge_nonce().as_bytes()))
        .unwrap_or(false)
}

/// Заворачивает document-start скрипт так, что он выполняется только в верхнем
/// фрейме, и кладёт туда же секрет моста.
pub(crate) fn top_frame_only_script(body: &str) -> String {
    let nonce = serde_json::to_string(bridge_nonce()).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(){{\nif (window.top !== window) return;\nwindow.__ZALI_BRIDGE_NONCE__ = {};\n{}\n}})();\n",
        nonce, body
    )
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nonce_is_stable_and_long() {
        assert_eq!(bridge_nonce(), bridge_nonce());
        assert_eq!(bridge_nonce().len(), 64);
    }

    #[test]
    fn only_matching_nonce_passes() {
        assert!(bridge_nonce_matches(&json!({"type": "X", "bridgeNonce": bridge_nonce()})));
        assert!(!bridge_nonce_matches(&json!({"type": "X"})));
        assert!(!bridge_nonce_matches(&json!({"type": "X", "bridgeNonce": ""})));
        assert!(!bridge_nonce_matches(&json!({"type": "X", "bridgeNonce": 1})));
        let mut wrong = bridge_nonce().to_string();
        wrong.replace_range(0..1, if wrong.starts_with('0') { "1" } else { "0" });
        assert!(!bridge_nonce_matches(&json!({"type": "X", "bridgeNonce": wrong})));
    }

    #[test]
    fn script_is_guarded_by_top_frame_check() {
        let script = top_frame_only_script("window.__ZALI_SAVED_KEY = \"k\";");
        let guard = script.find("window.top !== window").expect("guard");
        let secret = script.find("__ZALI_SAVED_KEY").expect("body");
        assert!(guard < secret);
        assert!(script.contains(bridge_nonce()));
    }
}
