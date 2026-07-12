use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::TryFrom;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tao::event_loop::EventLoopProxy;
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

mod api;
pub(crate) use api::*;
mod cache;
pub(crate) use cache::*;
mod http;
pub(crate) use http::*;
mod keyring;
pub(crate) use keyring::*;
mod messages;
pub(crate) use messages::*;
mod transport;
pub(crate) use transport::*;
mod util;
pub(crate) use util::*;

fn trace(message: impl AsRef<str>) {
    tracing::trace!("[ZALI][WIN] {}", message.as_ref());
}

const MAX_AVATAR_BYTES: u64 = 2 * 1024 * 1024;
const BRIDGE_PROTOCOL_JSON: &str = include_str!("../../../web/bridge_protocol.json");

include!(concat!(env!("OUT_DIR"), "/bridge_protocol.rs"));

#[derive(Debug, Clone, Deserialize)]
struct AuthRequestPayload {
    username: String,
    password: String,
}

#[derive(Debug, Clone)]
pub enum AppEvent {
    EvaluateScript(String),
    StartDrag,
}

#[derive(Debug, Clone, Copy)]
enum UiBusEvent {
    VoiceEvent,
    AddLogEntry,
    ReactionUpdated,
    ReceiveMessage,
    RefreshAfterKey,
    AuthResponse,
    NativeResponse,
    TenorResolved,
    SetUsers,
    SetContacts,
    SetLoading,
    SetConnectionStatus,
    LoadServerHistory,
    OnSendSuccess,
    OnSendError,
    AvatarUpdated,
    SyncActiveConversation,
}

impl UiBusEvent {
    fn as_str(self) -> &'static str {
        match self {
            UiBusEvent::VoiceEvent => "voice_event",
            UiBusEvent::AddLogEntry => "add_log_entry",
            UiBusEvent::ReactionUpdated => "reaction_updated",
            UiBusEvent::ReceiveMessage => "receive_message",
            UiBusEvent::RefreshAfterKey => "refresh_after_key",
            UiBusEvent::AuthResponse => "auth_response",
            UiBusEvent::NativeResponse => "native_response",
            UiBusEvent::TenorResolved => "tenor_resolved",
            UiBusEvent::SetUsers => "set_users",
            UiBusEvent::SetContacts => "set_contacts",
            UiBusEvent::SetLoading => "set_loading",
            UiBusEvent::SetConnectionStatus => "set_connection_status",
            UiBusEvent::LoadServerHistory => "load_server_history",
            UiBusEvent::OnSendSuccess => "on_send_success",
            UiBusEvent::OnSendError => "on_send_error",
            UiBusEvent::AvatarUpdated => "avatar_updated",
            UiBusEvent::SyncActiveConversation => "sync_active_conversation",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct VoiceConfig {
    ws_url: String,
    auth_token: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MessageConfig {
    ws_url: String,
    api_base_url: String,
    auth_token: Option<String>,
    current_key: String,
    conversation_keys: HashMap<String, String>,
    current_username: String,
    current_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistedConfig {
    api_base_url: Option<String>,
    ws_base_url: Option<String>,
    #[serde(
        default,
        rename = "crypto_key_v2",
        skip_serializing_if = "Option::is_none"
    )]
    crypto_key: Option<String>,
    session_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(default, rename = "conversation_keys_v2")]
    conversation_keys: HashMap<String, String>,
    #[serde(default)]
    pending_outbox: Vec<Value>,
    message_cache: Option<String>,
    #[serde(default)]
    pending_outbox_by_user: HashMap<String, Vec<Value>>,
    #[serde(default)]
    message_cache_by_user: HashMap<String, String>,
    #[serde(default, rename = "crypto_keys_v2_by_user")]
    crypto_keys_by_user: HashMap<String, String>,
    #[serde(default, rename = "conversation_keys_v2_by_user")]
    conversation_keys_by_user: HashMap<String, HashMap<String, String>>,
}

#[derive(Debug, Clone)]
pub struct NativeState {
    pub api_base_url: Option<String>,
    pub ws_base_url: Option<String>,
    pub current_username: String,
    pub auth_token: Option<String>,
    pub current_key: String,
    pub conversation_keys: HashMap<String, String>,
    pub current_device_id: String,
    pub saved_css: String,
    pub pending_outbox: Vec<Value>,
    pub message_cache_json: String,
    pub pending_outbox_by_user: HashMap<String, Vec<Value>>,
    pub message_cache_by_user: HashMap<String, String>,
    pub crypto_keys_by_user: HashMap<String, String>,
    pub conversation_keys_by_user: HashMap<String, HashMap<String, String>>,
    config_path: PathBuf,
    css_path: PathBuf,
    /// Raw JSON of the JS-side device identity (ECDH keypair + deviceId) exported by
    /// the Swift client's WKWebView localStorage, if present for this user. macOS only
    /// — lets a first Rust-shell launch on the same Mac reuse the already-approved
    /// device instead of registering a brand-new one with no key envelopes.
    injected_device_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapabilities {
    api_request: bool,
    send_message: bool,
    session_sync: bool,
    network_config: bool,
    set_key: bool,
    set_reaction: bool,
    avatar_fetch: bool,
    save_style: bool,
    download_attachment: bool,
    server_history: bool,
    tenor: bool,
    voice: bool,
    window_drag: bool,
    message_cache: bool,
}

impl Default for NativeCapabilities {
    fn default() -> Self {
        Self {
            api_request: true,
            send_message: true,
            session_sync: true,
            network_config: true,
            set_key: true,
            set_reaction: true,
            avatar_fetch: true,
            save_style: true,
            download_attachment: true,
            server_history: true,
            tenor: true,
            voice: true,
            window_drag: true,
            message_cache: true,
        }
    }
}

pub struct VoiceBridge {
    config_tx: watch::Sender<VoiceConfig>,
    outbound_tx: mpsc::UnboundedSender<Value>,
}

impl VoiceBridge {
    pub fn new(runtime: Arc<Runtime>, proxy: EventLoopProxy<AppEvent>) -> Arc<Self> {
        let (config_tx, config_rx) = watch::channel(VoiceConfig::default());
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<Value>();
        let bridge = Arc::new(Self {
            config_tx,
            outbound_tx,
        });

        let proxy_for_task = proxy.clone();
        runtime.spawn(async move {
            run_voice_transport(config_rx, outbound_rx, proxy_for_task).await;
        });

        bridge
    }

    pub fn configure(
        &self,
        ws_base_url: Option<String>,
        api_base_url: Option<String>,
        auth_token: Option<String>,
    ) {
        let ws_url = normalize_voice_ws_url(ws_base_url, api_base_url);
        let auth_token = auth_token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let next = VoiceConfig { ws_url, auth_token };
        let unchanged = {
            let current = self.config_tx.borrow();
            *current == next
        };
        if unchanged {
            trace("voice configure unchanged; keeping existing websocket");
            return;
        }
        let _ = self.config_tx.send(next);
    }

    pub fn send_event(&self, payload: Value) {
        let _ = self.outbound_tx.send(payload);
    }
}

pub struct MessageBridge {
    config_tx: watch::Sender<MessageConfig>,
}

impl MessageBridge {
    pub fn new(runtime: Arc<Runtime>, proxy: EventLoopProxy<AppEvent>) -> Arc<Self> {
        let (config_tx, config_rx) = watch::channel(MessageConfig::default());
        let bridge = Arc::new(Self { config_tx });
        runtime.spawn(async move {
            run_message_transport(config_rx, proxy).await;
        });
        bridge
    }

    /// Пересобирает конфиг транспорта из актуального состояния приложения.
    /// Все поля берутся напрямую из `NativeState`, поэтому вызывающему коду
    /// не нужно вручную клонировать каждое из них.
    pub fn configure(&self, state: &NativeState) {
        let ws_url = normalize_voice_ws_url(state.ws_base_url.clone(), Some(state.api_base_url()));
        let auth_token = state
            .auth_token
            .clone()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let next = MessageConfig {
            ws_url,
            api_base_url: state.api_base_url(),
            auth_token,
            current_key: state.current_key.trim().to_string(),
            conversation_keys: state.conversation_keys.clone(),
            current_username: state.current_username.trim().to_string(),
            current_device_id: state.current_device_id.trim().to_string(),
        };
        let unchanged = {
            let current = self.config_tx.borrow();
            *current == next
        };
        if unchanged {
            trace("message configure unchanged; keeping existing websocket");
            return;
        }
        let _ = self.config_tx.send(next);
    }
}

fn user_storage_key(username: &str) -> String {
    username.trim().to_lowercase()
}

impl NativeState {
    pub fn load() -> Self {
        let root = Self::app_data_dir();
        let _ = fs::create_dir_all(&root);
        let config_path = root.join("native_config.json");
        let css_path = root.join("custom_style.css");
        let persisted = Self::load_config(&config_path).unwrap_or_default();
        let saved_css = fs::read_to_string(&css_path).unwrap_or_default();
        let current_username = persisted.session_username.clone().unwrap_or_default();
        let user_key = user_storage_key(&current_username);
        // Plain file, not Keychain: both shells run unsandboxed as the same OS user, so
        // this needs no cross-app consent dialog. Consistent with native_config.json's
        // own plaintext fallback tier for secrets.
        //
        // Read on ALL platforms (previously macOS-only, where the Swift client authored the
        // file). Windows/Rust now writes it too (PERSIST_DEVICE_IDENTITY handler), so a
        // rebuild/restart that wipes WebView localStorage re-adopts the same device_id
        // instead of minting a fresh one — the churn that orphaned key envelopes and broke
        // key convergence (envelopes are addressed to a specific recipient_device_id).
        let injected_device_identity: Option<String> = if user_key.is_empty() {
            None
        } else {
            let path = root.join(format!("shared_device_identity_{}.json", user_key));
            fs::read_to_string(&path).ok().and_then(|raw| {
                // Validate before ever splicing into the WebView init script — a
                // corrupt/partial export must not break page load entirely.
                serde_json::from_str::<Value>(&raw).ok().map(|_| raw)
            })
        };
        let legacy_current_key = load_secret_from_keyring("crypto_key_v2")
            .or_else(|| persisted.crypto_key.clone())
            .unwrap_or_default()
            .trim()
            .to_string();
        let current_key = persisted
            .crypto_keys_by_user
            .get(&user_key)
            .cloned()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| legacy_current_key.clone())
            .trim()
            .to_string();
        let auth_token = load_secret_from_keyring("session_token")
            .or_else(|| persisted.session_token.clone())
            .and_then(|token| {
                let trimmed = token.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            });

        let state = Self {
            api_base_url: persisted.api_base_url,
            ws_base_url: persisted.ws_base_url,
            current_username,
            current_device_id: persisted.device_id.unwrap_or_default().trim().to_string(),
            auth_token,
            current_key,
            conversation_keys: persisted
                .conversation_keys_by_user
                .get(&user_key)
                .cloned()
                .filter(|map| !map.is_empty())
                .unwrap_or_else(|| persisted.conversation_keys.clone()),
            saved_css,
            pending_outbox: persisted
                .pending_outbox_by_user
                .get(&user_key)
                .cloned()
                .unwrap_or_else(|| persisted.pending_outbox.clone()),
            message_cache_json: persisted
                .message_cache_by_user
                .get(&user_key)
                .cloned()
                .or(persisted.message_cache.clone())
                .unwrap_or_else(|| r#"{"chats":{},"serverChats":{}}"#.to_string())
                .trim()
                .to_string(),
            pending_outbox_by_user: persisted.pending_outbox_by_user,
            message_cache_by_user: persisted.message_cache_by_user,
            crypto_keys_by_user: persisted.crypto_keys_by_user,
            conversation_keys_by_user: persisted.conversation_keys_by_user,
            config_path,
            css_path,
            injected_device_identity,
        };
        trace(format!(
            "load user={} has_token={} key_set={} pending_count={} config={}",
            state.current_username,
            state.auth_token.is_some(),
            !state.current_key.trim().is_empty(),
            state.pending_outbox.len(),
            state.config_path.display()
        ));
        state.persist_config();
        state
    }

    fn app_data_dir() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            std::env::var_os("LOCALAPPDATA")
                .or_else(|| std::env::var_os("APPDATA"))
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("ZaliMessenger")
        }
        #[cfg(target_os = "macos")]
        {
            // LOCALAPPDATA/APPDATA do not exist on macOS; without this branch the
            // config landed in temp_dir() and was wiped by the OS between launches.
            std::env::var_os("HOME")
                .map(|home| {
                    PathBuf::from(home)
                        .join("Library")
                        .join("Application Support")
                })
                .unwrap_or_else(std::env::temp_dir)
                .join("ZaliMessenger")
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .map(|home| PathBuf::from(home).join(".local").join("share"))
                })
                .unwrap_or_else(std::env::temp_dir)
                .join("ZaliMessenger")
        }
    }

    fn load_config(path: &Path) -> Option<PersistedConfig> {
        let raw = fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn update_scoped_maps_for_current_user(&mut self) {
        let user_key = user_storage_key(&self.current_username);
        if user_key.is_empty() {
            return;
        }
        self.pending_outbox_by_user
            .insert(user_key.clone(), self.pending_outbox.clone());
        self.message_cache_by_user
            .insert(user_key.clone(), self.message_cache_json.clone());
        if self.current_key.trim().is_empty() {
            self.crypto_keys_by_user.remove(&user_key);
        } else {
            self.crypto_keys_by_user
                .insert(user_key.clone(), self.current_key.clone());
        }
        self.conversation_keys_by_user
            .insert(user_key, self.conversation_keys.clone());
    }

    fn load_scoped_state_for_current_user(&mut self, legacy_fallback: bool) {
        let user_key = user_storage_key(&self.current_username);
        if user_key.is_empty() {
            return;
        }
        self.current_key = self
            .crypto_keys_by_user
            .get(&user_key)
            .cloned()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                if legacy_fallback {
                    Some(self.current_key.clone()).filter(|value| !value.trim().is_empty())
                } else {
                    None
                }
            })
            .unwrap_or_default();
        self.conversation_keys = self
            .conversation_keys_by_user
            .get(&user_key)
            .cloned()
            .filter(|map| !map.is_empty())
            .or_else(|| {
                if legacy_fallback && !self.conversation_keys.is_empty() {
                    Some(self.conversation_keys.clone())
                } else {
                    None
                }
            })
            .unwrap_or_default();
        self.pending_outbox = self
            .pending_outbox_by_user
            .get(&user_key)
            .cloned()
            .unwrap_or_default();
        self.message_cache_json = self
            .message_cache_by_user
            .get(&user_key)
            .cloned()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                if legacy_fallback {
                    Some(self.message_cache_json.clone()).filter(|value| !value.trim().is_empty())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| r#"{"chats":{},"serverChats":{}}"#.to_string());
        self.update_scoped_maps_for_current_user();
    }

    fn persist_config(&self) {
        let key_ref = if self.current_key.trim().is_empty() {
            None
        } else {
            Some(self.current_key.as_str())
        };
        let keyring_key_ok = store_secret_in_keyring("crypto_key_v2", key_ref);
        let keyring_token_ok = store_secret_in_keyring("session_token", self.auth_token.as_deref());
        let user_key = user_storage_key(&self.current_username);
        let mut pending_outbox_by_user = self.pending_outbox_by_user.clone();
        let mut message_cache_by_user = self.message_cache_by_user.clone();
        let mut crypto_keys_by_user = self.crypto_keys_by_user.clone();
        let mut conversation_keys_by_user = self.conversation_keys_by_user.clone();
        if !user_key.is_empty() {
            pending_outbox_by_user.insert(user_key.clone(), self.pending_outbox.clone());
            message_cache_by_user.insert(user_key.clone(), self.message_cache_json.clone());
            if self.current_key.trim().is_empty() {
                crypto_keys_by_user.remove(&user_key);
            } else {
                crypto_keys_by_user.insert(user_key.clone(), self.current_key.clone());
            }
            conversation_keys_by_user.insert(user_key, self.conversation_keys.clone());
        }
        let payload = PersistedConfig {
            api_base_url: self.api_base_url.clone(),
            ws_base_url: self.ws_base_url.clone(),
            crypto_key: if keyring_key_ok || self.current_key.trim().is_empty() {
                None
            } else {
                Some(self.current_key.clone())
            },
            session_username: Some(self.current_username.clone()),
            session_token: if keyring_token_ok {
                None
            } else {
                self.auth_token
                    .clone()
                    .filter(|value| !value.trim().is_empty())
            },
            device_id: if self.current_device_id.trim().is_empty() {
                None
            } else {
                Some(self.current_device_id.clone())
            },
            conversation_keys: self.conversation_keys.clone(),
            pending_outbox: self.pending_outbox.clone(),
            message_cache: Some(self.message_cache_json.clone()),
            pending_outbox_by_user,
            message_cache_by_user,
            crypto_keys_by_user,
            conversation_keys_by_user,
        };
        if let Ok(json) = serde_json::to_string_pretty(&payload) {
            let _ = fs::write(&self.config_path, json);
            trace(format!(
                "persist_config user={} has_token={} key_set={} pending_count={} config={}",
                self.current_username,
                self.auth_token.is_some(),
                !self.current_key.trim().is_empty(),
                self.pending_outbox.len(),
                self.config_path.display()
            ));
        }
    }

    fn persist_pending_outbox(&mut self, items: Vec<Value>) {
        self.pending_outbox = items;
        self.update_scoped_maps_for_current_user();
        trace(format!(
            "persist_pending_outbox count={} user={}",
            self.pending_outbox.len(),
            self.current_username
        ));
        self.persist_config();
    }

    fn persist_message_cache(&mut self, json: String) {
        self.message_cache_json = if json.trim().is_empty() {
            r#"{"chats":{},"serverChats":{}}"#.to_string()
        } else {
            json
        };
        self.update_scoped_maps_for_current_user();
        trace(format!(
            "persist_message_cache bytes={} user={}",
            self.message_cache_json.len(),
            self.current_username
        ));
        self.persist_config();
    }

    fn persist_css(&self) {
        let _ = fs::write(&self.css_path, &self.saved_css);
    }

    // Write the JS-authored device identity to shared_device_identity_{user}.json next to
    // native_config.json. Read back by NativeState::load()'s injected_device_identity on the
    // next launch. Validates the JSON and requires a non-empty username + deviceId so a
    // pre-auth/garbage payload never overwrites a good file. See the PERSIST_DEVICE_IDENTITY
    // IPC handler and interface.js persistDeviceIdentityToNative.
    fn persist_shared_device_identity(&self, username: &str, identity_json: &str) {
        let user_key = user_storage_key(username);
        if user_key.is_empty() || identity_json.trim().is_empty() {
            return;
        }
        let parsed = match serde_json::from_str::<Value>(identity_json) {
            Ok(value) => value,
            Err(error) => {
                trace(format!(
                    "persist_shared_device_identity invalid json err={}",
                    error
                ));
                return;
            }
        };
        let device_id = parsed
            .get("deviceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if device_id.is_empty() {
            return;
        }
        let Some(root) = self.config_path.parent() else {
            return;
        };
        let path = root.join(format!("shared_device_identity_{}.json", user_key));
        match fs::write(&path, identity_json) {
            Ok(_) => trace(format!(
                "persist_shared_device_identity user={} device_id={}",
                user_key, device_id
            )),
            Err(error) => trace(format!(
                "persist_shared_device_identity write failed user={} err={}",
                user_key, error
            )),
        }
    }

    pub fn initialization_script(&self) -> String {
        trace(format!(
            "initialization_script user={} has_token={} key_set={} pending_count={}",
            self.current_username,
            self.auth_token.is_some(),
            !self.current_key.trim().is_empty(),
            self.pending_outbox.len()
        ));
        let mut script = String::new();

        let config = json!({
            "apiBaseUrl": self.api_base_url.clone().unwrap_or_default(),
            "wsBaseUrl": self.ws_base_url.clone().unwrap_or_default(),
        });
        if let Ok(json) = serde_json::to_string(&config) {
            script.push_str(&format!("window.__ZALI_CONFIG = {};\n", json));
        }

        script.push_str(&format!(
            "window.__ZALI_BRIDGE_PROTOCOL__ = {};\n",
            BRIDGE_PROTOCOL_JSON
        ));

        if let Ok(json) = serde_json::to_string(&self.native_capabilities()) {
            script.push_str(&format!("window.__ZALI_NATIVE_CAPS__ = {};\n", json));
        }

        if !self.saved_css.trim().is_empty() {
            if let Ok(json) = serde_json::to_string(&self.saved_css) {
                script.push_str(&format!("window.__ZALI_SAVED_CSS = {};\n", json));
            }
        }

        if !self.current_key.trim().is_empty() {
            if let Ok(json) = serde_json::to_string(&self.current_key) {
                script.push_str(&format!("window.__ZALI_SAVED_KEY = {};\n", json));
            }
        }
        if let Ok(json) = serde_json::to_string(&self.conversation_keys) {
            script.push_str(&format!("window.__ZALI_CONVERSATION_KEYS = {};\n", json));
        }

        if let Some(raw) = &self.injected_device_identity {
            // JS only consumes this if it has no device identity of its own yet
            // (loadDeviceIdentity's injected-fallback) — safe to always inject.
            script.push_str(&format!(
                "window.__ZALI_INJECTED_DEVICE_IDENTITY = {};\n",
                raw
            ));
        }

        let session = json!({
            "username": self.current_username,
            "token": self.auth_token.clone().unwrap_or_default(),
            "guest": self.auth_token.as_ref().map(|t| t.trim().is_empty()).unwrap_or(true),
        });
        if let Ok(json) = serde_json::to_string(&session) {
            script.push_str(&format!("window.__ZALI_SAVED_SESSION = {};\n", json));
        }

        if let Ok(json) = serde_json::to_string(&self.pending_outbox) {
            script.push_str(&format!("window.__ZALI_PENDING_OUTBOX = {};\n", json));
        } else {
            script.push_str("window.__ZALI_PENDING_OUTBOX = [];\n");
        }

        if let Ok(json) = serde_json::to_string(&self.message_cache_json) {
            script.push_str(&format!("window.__ZALI_MESSAGE_CACHE = {};\n", json));
        } else {
            script.push_str(
                "window.__ZALI_MESSAGE_CACHE = \"{\\\"chats\\\":{},\\\"serverChats\\\":{}}\";\n",
            );
        }

        script
    }

    pub fn api_base_url(&self) -> String {
        self.api_base_url
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("ZALI_API_BASE_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or_else(|| "https://msgs.zalikus.org".to_string())
    }

    fn native_capabilities(&self) -> NativeCapabilities {
        NativeCapabilities::default()
    }
}

fn script_eval_command(command: &str, payload: Value) -> String {
    let command_literal = json_string_literal(command);
    let payload_literal = payload.to_string();
    format!(
        "window.loader?.bus?.send({}, {});",
        command_literal, payload_literal
    )
}

fn dispatch_ui_event(proxy: &EventLoopProxy<AppEvent>, event: UiBusEvent, payload: Value) {
    let command = format!("zali_interface:{}", event.as_str());
    let _ = proxy.send_event(AppEvent::EvaluateScript(script_eval_command(
        &command, payload,
    )));
}

pub fn handle_ipc_message(
    message: String,
    state: Arc<Mutex<NativeState>>,
    voice_bridge: Arc<VoiceBridge>,
    message_bridge: Arc<MessageBridge>,
    runtime: Arc<Runtime>,
    proxy: EventLoopProxy<AppEvent>,
) {
    let parsed = serde_json::from_str::<Value>(&message).ok();
    let Some(payload) = parsed else {
        return;
    };

    let Some(kind_name) = payload.get("type").and_then(Value::as_str) else {
        return;
    };

    let Some(kind) = parse_bridge_protocol_message_type(kind_name) else {
        trace(format!("IPC unknown type kind={}", kind_name));
        return;
    };

    match kind {
        BridgeProtocolMessageType::SaveStyle => {
            if let Some(css) = payload.get("css").and_then(Value::as_str) {
                if let Ok(mut guard) = state.lock() {
                    guard.saved_css = css.to_string();
                    guard.persist_css();
                }
            }
        }
        BridgeProtocolMessageType::DownloadAttachment => {
            let data_url = payload
                .get("dataUrl")
                .or_else(|| payload.get("data_url"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let filename = payload
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or("attachment");

            if data_url.trim().is_empty() {
                trace("DOWNLOAD_ATTACHMENT skipped: empty dataUrl");
                return;
            }

            match save_data_url_attachment(data_url, filename) {
                Ok(path) => trace(format!(
                    "DOWNLOAD_ATTACHMENT saved filename={} path={}",
                    filename,
                    path.display()
                )),
                Err(error) => {
                    trace(format!(
                        "DOWNLOAD_ATTACHMENT failed filename={} err={}",
                        filename, error
                    ));
                    let log = format!(
                        "window.addLog({}, {});",
                        json_string_literal("ERROR"),
                        json_string_literal(&format!("Не удалось сохранить вложение: {}", error))
                    );
                    let _ = proxy.send_event(AppEvent::EvaluateScript(log));
                }
            }
        }
        BridgeProtocolMessageType::AuthRequest => {
            let mode = payload
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("login")
                .trim()
                .to_lowercase();
            let auth_payload = match serde_json::from_value::<AuthRequestPayload>(payload.clone()) {
                Ok(value) => value,
                Err(error) => {
                    trace(format!("AUTH_REQUEST payload_error err={}", error));
                    dispatch_ui_event(
                        &proxy,
                        UiBusEvent::AuthResponse,
                        json!({
                            "requestId": payload.get("requestId").or_else(|| payload.get("request_id")).and_then(Value::as_str).unwrap_or("").trim(),
                            "ok": false,
                            "error": "Не удалось связаться с сервером",
                        }),
                    );
                    return;
                }
            };
            let request_id = payload
                .get("requestId")
                .or_else(|| payload.get("request_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();

            if auth_payload.username.trim().is_empty()
                || auth_payload.password.is_empty()
                || request_id.is_empty()
            {
                trace("AUTH_REQUEST skipped: missing username/password/requestId");
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::AuthResponse,
                    json!({
                        "requestId": request_id,
                        "ok": false,
                        "error": "Не удалось связаться с сервером",
                    }),
                );
                return;
            }

            let api_base_url = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                guard.api_base_url()
            };
            let proxy = proxy.clone();
            runtime.spawn(async move {
                perform_auth_request(
                    api_base_url,
                    mode,
                    auth_payload.username,
                    auth_payload.password,
                    request_id,
                    proxy,
                )
                .await;
            });
        }
        BridgeProtocolMessageType::ApiRequest => {
            let request_id = payload
                .get("requestId")
                .or_else(|| payload.get("request_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let method = payload
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .trim()
                .to_string();
            let path = payload
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let headers = payload.get("headers").cloned().unwrap_or_else(|| json!({}));
            let body = payload
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let include_device_id = payload
                .get("includeDeviceId")
                .or_else(|| payload.get("include_device_id"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (api_base_url, auth_token, device_id) = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                (
                    guard.api_base_url(),
                    guard.auth_token.clone(),
                    guard.current_device_id.clone(),
                )
            };

            if request_id.is_empty() || path.is_empty() {
                trace("API_REQUEST skipped: empty requestId/path");
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::NativeResponse,
                    json!({
                        "requestId": request_id,
                        "ok": false,
                        "error": "Некорректный API запрос",
                    }),
                );
                return;
            }

            let proxy = proxy.clone();
            runtime.spawn(async move {
                match perform_api_request(
                    ApiSession {
                        api_base_url,
                        auth_token,
                        device_id,
                    },
                    method,
                    path,
                    headers,
                    body,
                    include_device_id,
                )
                .await
                {
                    Ok(data) => dispatch_ui_event(
                        &proxy,
                        UiBusEvent::NativeResponse,
                        json!({
                            "requestId": request_id,
                            "ok": true,
                            "data": data,
                        }),
                    ),
                    Err(error) => dispatch_ui_event(
                        &proxy,
                        UiBusEvent::NativeResponse,
                        json!({
                            "requestId": request_id,
                            "ok": false,
                            "error": error,
                        }),
                    ),
                }
            });
        }
        BridgeProtocolMessageType::AddContactRequest
        | BridgeProtocolMessageType::RemoveContactRequest => {
            let username = payload
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let request_id = payload
                .get("requestId")
                .or_else(|| payload.get("request_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();

            let (api_base_url, auth_token) = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                (guard.api_base_url(), guard.auth_token.clone())
            };

            if username.is_empty() || request_id.is_empty() {
                trace("CONTACT_REQUEST skipped: empty username/requestId");
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::NativeResponse,
                    json!({
                        "requestId": request_id,
                        "ok": false,
                        "error": "Не удалось выполнить операцию",
                    }),
                );
                return;
            }

            if auth_token
                .as_ref()
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
            {
                trace("CONTACT_REQUEST skipped: missing session token");
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::NativeResponse,
                    json!({
                        "requestId": request_id,
                        "ok": false,
                        "error": "Сначала войдите в аккаунт",
                    }),
                );
                return;
            }

            let add = matches!(kind, BridgeProtocolMessageType::AddContactRequest);
            let device_id = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                guard.current_device_id.clone()
            };
            let proxy = proxy.clone();
            runtime.spawn(async move {
                match perform_contacts_request(api_base_url, auth_token, device_id, username, add)
                    .await
                {
                    Ok(contacts) => dispatch_ui_event(
                        &proxy,
                        UiBusEvent::NativeResponse,
                        json!({
                            "requestId": request_id,
                            "ok": true,
                            "data": {
                                "contacts": contacts,
                            },
                        }),
                    ),
                    Err(error) => dispatch_ui_event(
                        &proxy,
                        UiBusEvent::NativeResponse,
                        json!({
                            "requestId": request_id,
                            "ok": false,
                            "error": error,
                        }),
                    ),
                }
            });
        }
        BridgeProtocolMessageType::UploadAvatarRequest
        | BridgeProtocolMessageType::DeleteAvatarRequest => {
            let request_id = payload
                .get("requestId")
                .or_else(|| payload.get("request_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let (api_base_url, auth_token, current_username) = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                (
                    guard.api_base_url(),
                    guard.auth_token.clone(),
                    guard.current_username.clone(),
                )
            };
            let device_id = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                guard.current_device_id.clone()
            };

            if request_id.is_empty() {
                trace("AVATAR_REQUEST skipped: empty requestId");
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::NativeResponse,
                    json!({
                        "requestId": request_id,
                        "ok": false,
                        "error": "Не удалось выполнить операцию",
                    }),
                );
                return;
            }

            if auth_token
                .as_ref()
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
            {
                trace("AVATAR_REQUEST skipped: missing session token");
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::NativeResponse,
                    json!({
                        "requestId": request_id,
                        "ok": false,
                        "error": "Сначала войдите в аккаунт",
                    }),
                );
                return;
            }

            let deleted = matches!(kind, BridgeProtocolMessageType::DeleteAvatarRequest);
            let data_url = payload
                .get("dataUrl")
                .or_else(|| payload.get("data_url"))
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            let mime_type = payload
                .get("mimeType")
                .or_else(|| payload.get("mime_type"))
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            let filename = payload
                .get("filename")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            let proxy = proxy.clone();
            runtime.spawn(async move {
                match perform_avatar_request(
                    api_base_url,
                    auth_token,
                    device_id,
                    if deleted {
                        "delete".to_string()
                    } else {
                        "upload".to_string()
                    },
                    data_url,
                    mime_type,
                    filename,
                )
                .await
                {
                    Ok(()) => {
                        dispatch_ui_event(
                            &proxy,
                            UiBusEvent::NativeResponse,
                            json!({
                                "requestId": request_id,
                                "ok": true,
                                "data": {
                                    "username": current_username,
                                },
                            }),
                        );
                        dispatch_ui_event(
                            &proxy,
                            UiBusEvent::AvatarUpdated,
                            json!({
                                "username": current_username,
                            "deleted": deleted,
                            }),
                        );
                    }
                    Err(error) => dispatch_ui_event(
                        &proxy,
                        UiBusEvent::NativeResponse,
                        json!({
                            "requestId": request_id,
                            "ok": false,
                            "error": error,
                        }),
                    ),
                }
            });
        }
        BridgeProtocolMessageType::LoadAvatarRequest => {
            let request_id = payload
                .get("requestId")
                .or_else(|| payload.get("request_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let username = payload
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let (api_base_url, auth_token) = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                (guard.api_base_url(), guard.auth_token.clone())
            };

            if request_id.is_empty() || username.is_empty() {
                trace("LOAD_AVATAR_REQUEST skipped: empty requestId/username");
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::NativeResponse,
                    json!({
                        "requestId": request_id,
                        "ok": false,
                        "error": "Не удалось загрузить аватар",
                    }),
                );
                return;
            }

            let proxy = proxy.clone();
            runtime.spawn(async move {
                match perform_avatar_fetch(api_base_url, auth_token, username.clone()).await {
                    Ok(payload) => dispatch_ui_event(
                        &proxy,
                        UiBusEvent::NativeResponse,
                        json!({
                            "requestId": request_id,
                            "ok": true,
                            "data": payload,
                        }),
                    ),
                    Err(error) => dispatch_ui_event(
                        &proxy,
                        UiBusEvent::NativeResponse,
                        json!({
                            "requestId": request_id,
                            "ok": false,
                            "error": error,
                        }),
                    ),
                }
            });
        }
        BridgeProtocolMessageType::LoadServerHistory => {
            let server_id = payload
                .get("serverId")
                .or_else(|| payload.get("server_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let channel_id = payload
                .get("channelId")
                .or_else(|| payload.get("channel_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let requested_key = payload
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();

            if server_id.is_empty() || channel_id.is_empty() {
                trace("LOAD_SERVER_HISTORY skipped: empty serverId/channelId");
                return;
            }

            if !requested_key.is_empty() {
                if let Ok(mut guard) = state.lock() {
                    guard.current_key = requested_key.clone();
                    guard.update_scoped_maps_for_current_user();
                    guard.persist_config();
                    message_bridge.configure(&guard);
                }
            }

            let snapshot = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                (
                    guard.api_base_url(),
                    guard.auth_token.clone(),
                    if requested_key.is_empty() {
                        guard.current_key.clone()
                    } else {
                        requested_key.clone()
                    },
                    guard.current_device_id.clone(),
                )
            };
            let proxy = proxy.clone();
            runtime.spawn(async move {
                refresh_server_history(
                    snapshot.0, snapshot.1, snapshot.3, server_id, channel_id, snapshot.2, proxy,
                )
                .await;
            });
        }
        BridgeProtocolMessageType::ResolveTenor => {
            let url = payload
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let request_id = payload
                .get("requestId")
                .or_else(|| payload.get("request_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();

            if url.is_empty() {
                trace("RESOLVE_TENOR skipped: empty url");
                return;
            }

            let proxy = proxy.clone();
            runtime.spawn(async move {
                resolve_tenor_url(url, request_id, proxy).await;
            });
        }
        BridgeProtocolMessageType::SetKey => {
            if let Some(key) = payload.get("key").and_then(Value::as_str) {
                if let Ok(mut guard) = state.lock() {
                    let next_key = key.trim().to_string();
                    let mut next_conversation_keys = guard.conversation_keys.clone();
                    if let Some(map) = payload.get("conversationKeys").and_then(Value::as_object) {
                        next_conversation_keys = map
                            .iter()
                            .filter_map(|(scope, value)| {
                                let scope = scope.trim();
                                let key = value.as_str().unwrap_or("").trim();
                                if scope.is_empty() || key.is_empty() {
                                    None
                                } else {
                                    Some((scope.to_string(), key.to_string()))
                                }
                            })
                            .collect();
                    }
                    if let Some(scope) = payload.get("scope").and_then(Value::as_str) {
                        let scope = scope.trim();
                        if !scope.is_empty() {
                            if next_key.is_empty() {
                                next_conversation_keys.remove(scope);
                            } else {
                                next_conversation_keys.insert(scope.to_string(), next_key.clone());
                            }
                        }
                    }
                    if guard.current_key == next_key
                        && guard.conversation_keys == next_conversation_keys
                    {
                        return;
                    }
                    guard.current_key = next_key;
                    guard.conversation_keys = next_conversation_keys;
                    guard.update_scoped_maps_for_current_user();
                    guard.persist_config();
                    trace(format!(
                        "SET_KEY key_set={} length={} conversation_keys={}",
                        !guard.current_key.is_empty(),
                        guard.current_key.len(),
                        guard.conversation_keys.len()
                    ));
                    message_bridge.configure(&guard);
                    let proxy = proxy.clone();
                    runtime.spawn(async move {
                        dispatch_ui_event(&proxy, UiBusEvent::RefreshAfterKey, Value::Null);
                    });
                }
            }
        }
        BridgeProtocolMessageType::SetMessageReaction => {
            let message_id = payload
                .get("messageId")
                .or_else(|| payload.get("message_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let emoji = payload
                .get("emoji")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();

            let (api_base_url, auth_token) = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                (guard.api_base_url(), guard.auth_token.clone())
            };

            if message_id.is_empty() {
                trace("SET_MESSAGE_REACTION skipped: empty messageId");
                return;
            }

            let proxy = proxy.clone();
            let device_id = {
                let guard = state.lock().ok();
                let Some(guard) = guard else {
                    return;
                };
                guard.current_device_id.clone()
            };
            runtime.spawn(async move {
                match perform_reaction_request(
                    api_base_url,
                    auth_token,
                    device_id,
                    message_id.clone(),
                    emoji,
                )
                .await
                {
                    Ok(payload) => dispatch_ui_event(&proxy, UiBusEvent::ReactionUpdated, payload),
                    Err(error) => {
                        trace(format!(
                            "SET_MESSAGE_REACTION failed messageId={} err={}",
                            message_id, error
                        ));
                        let log = format!(
                            "window.addLog({}, {});",
                            json_string_literal("ERROR"),
                            json_string_literal("Не удалось сохранить реакцию на сервере")
                        );
                        let _ = proxy.send_event(AppEvent::EvaluateScript(log));
                    }
                }
            });
        }
        BridgeProtocolMessageType::SetSession => {
            if let Ok(mut guard) = state.lock() {
                let next_username = payload
                    .get("username")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let token = payload
                    .get("token")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let device_id = payload
                    .get("deviceId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let username_changed = guard.current_username != next_username;
                if username_changed {
                    guard.update_scoped_maps_for_current_user();
                    guard.current_username = next_username;
                    guard.load_scoped_state_for_current_user(true);
                } else {
                    guard.current_username = next_username;
                }
                guard.auth_token = if token.is_empty() {
                    None
                } else {
                    Some(token.to_string())
                };
                guard.current_device_id = device_id.to_string();
                guard.persist_config();
                trace(format!(
                    "SET_SESSION user={} has_token={} key_set={} device_id={}",
                    guard.current_username,
                    guard.auth_token.is_some(),
                    !guard.current_key.is_empty(),
                    guard.current_device_id
                ));
                voice_bridge.configure(
                    guard.ws_base_url.clone(),
                    Some(guard.api_base_url()),
                    guard.auth_token.clone(),
                );
                message_bridge.configure(&guard);
                let session_snapshot = (
                    guard.api_base_url(),
                    guard.auth_token.clone(),
                    guard.current_username.clone(),
                );
                let proxy_for_lists = proxy.clone();
                runtime.spawn(async move {
                    dispatch_ui_event(&proxy_for_lists, UiBusEvent::SetLoading, Value::Bool(false));
                    let users_task = fetch_users(
                        session_snapshot.0.clone(),
                        session_snapshot.1.clone(),
                        session_snapshot.2.clone(),
                    );
                    let contacts_task =
                        fetch_contacts(session_snapshot.0.clone(), session_snapshot.1.clone());
                    let (users, contacts) = tokio::join!(users_task, contacts_task);
                    dispatch_ui_event(
                        &proxy_for_lists,
                        UiBusEvent::SetUsers,
                        Value::Array(users.into_iter().map(Value::String).collect()),
                    );
                    match contacts {
                        Ok(contacts) => dispatch_ui_event(
                            &proxy_for_lists,
                            UiBusEvent::SetContacts,
                            Value::Array(contacts.into_iter().map(Value::String).collect()),
                        ),
                        Err(error) => {
                            trace(format!("SET_SESSION contacts sync skipped err={}", error))
                        }
                    }
                    // SetConnectionStatus is intentionally not dispatched here anymore. It
                    // used to fire unconditionally true on every SET_SESSION regardless of
                    // whether the message WebSocket (or even a valid token) existed, so the
                    // "Подключено" badge stayed green for sessions that could never receive
                    // anything live (e.g. a stale username with an empty auth_token).
                    // run_message_transport now owns this signal end-to-end, driven by the
                    // actual socket state (see its dispatch calls around message ws connect).
                });
                let proxy = proxy.clone();
                runtime.spawn(async move {
                    dispatch_ui_event(&proxy, UiBusEvent::RefreshAfterKey, Value::Null);
                });
            }
        }
        BridgeProtocolMessageType::RefreshHistory => {
            if let Ok(mut guard) = state.lock() {
                let requested_key = payload
                    .get("key")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let requested_peer = payload
                    .get("peer")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let key = if requested_key.is_empty() {
                    guard.current_key.clone()
                } else {
                    requested_key
                };
                if !key.trim().is_empty() {
                    guard.current_key = key.clone();
                    guard.update_scoped_maps_for_current_user();
                    guard.persist_config();
                    message_bridge.configure(&guard);
                }
                if requested_peer.is_empty() {
                    trace("REFRESH_HISTORY skipped: missing peer");
                    return;
                }
                let snapshot = (
                    guard.api_base_url(),
                    guard.auth_token.clone(),
                    requested_peer.clone(),
                    key,
                    guard.current_device_id.clone(),
                );
                // Previously gated on is_direct_message_key(&snapshot.3), which checks for a
                // "zali-e2e:v1:dm:" prefix that no key produced anywhere in this codebase
                // (JS's stored conversation keys, Rust's own current_key/conversation_keys)
                // ever has — confirmed by grepping the whole repo, zero hits outside this
                // dead check and its Swift mirror (which is itself only used for a cosmetic
                // log line, never gates behavior there). The gate below always evaluated to
                // false, so refresh_direct_history — the ONLY call site in this file — was
                // NEVER spawned via REFRESH_HISTORY: DM history was never actually pulled
                // from the server on this shell, for the active conversation OR any other,
                // only real-time WS pushes and the locally persisted cache ever populated
                // chats. Matches live symptom: a message confirmed delivered server-side
                // never appeared even after the recipient reconnected and opened that exact
                // chat. Fix: just require peer + key non-empty, mirroring Swift's working
                // .refreshHistory case (WebView.swift), which never had this extra check.
                if !snapshot.3.trim().is_empty() {
                    let proxy = proxy.clone();
                    runtime.spawn(async move {
                        refresh_direct_history(
                            snapshot.0, snapshot.1, snapshot.2, snapshot.3, snapshot.4, proxy,
                        )
                        .await;
                    });
                }
            }
        }
        BridgeProtocolMessageType::NetworkConfig => {
            if let Ok(mut guard) = state.lock() {
                guard.api_base_url = payload
                    .get("apiBaseUrl")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string())
                    .filter(|value| !value.trim().is_empty());
                guard.ws_base_url = payload
                    .get("wsBaseUrl")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string())
                    .filter(|value| !value.trim().is_empty());
                guard.persist_config();
                trace(format!(
                    "NETWORK_CONFIG api={:?} ws={:?}",
                    guard.api_base_url, guard.ws_base_url
                ));
                voice_bridge.configure(
                    guard.ws_base_url.clone(),
                    Some(guard.api_base_url()),
                    guard.auth_token.clone(),
                );
                message_bridge.configure(&guard);
            }
        }
        BridgeProtocolMessageType::SavePendingOutbox => {
            if let Ok(mut guard) = state.lock() {
                let items = payload
                    .get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                trace(format!("SAVE_PENDING_OUTBOX count={}", items.len()));
                guard.persist_pending_outbox(items);
            }
        }
        BridgeProtocolMessageType::SaveMessageCache => {
            if let Ok(mut guard) = state.lock() {
                let cache = payload
                    .get("cache")
                    .or_else(|| payload.get("messageCache"))
                    .cloned()
                    .unwrap_or_else(|| json!({"chats": {}, "serverChats": {}}));
                let json = serde_json::to_string(&cache)
                    .unwrap_or_else(|_| r#"{"chats":{},"serverChats":{}}"#.to_string());
                guard.persist_message_cache(json);
            }
        }
        BridgeProtocolMessageType::VoiceEvent => {
            let event = payload
                .get("payload")
                .cloned()
                .unwrap_or_else(|| payload.clone());
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            trace(format!(
                "VOICE_EVENT queued type={} roomId={} roomType={} to={}",
                event_type,
                event.get("roomId").and_then(Value::as_str).unwrap_or(""),
                event.get("roomType").and_then(Value::as_str).unwrap_or(""),
                event.get("to").and_then(Value::as_str).unwrap_or("")
            ));
            voice_bridge.send_event(event);
        }
        BridgeProtocolMessageType::SendMessage => {
            let request = payload.clone();
            let send_guard_client_id = request
                .get("clientId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if !send_guard_client_id.is_empty() {
                if let Ok(mut ids) = in_flight_send_client_ids().lock() {
                    if !ids.insert(send_guard_client_id.clone()) {
                        trace(format!(
                            "SEND_MESSAGE duplicate_in_flight clientId={}",
                            send_guard_client_id
                        ));
                        return;
                    }
                }
            }
            let state = Arc::clone(&state);
            let proxy = proxy.clone();
            trace(format!(
                "SEND_MESSAGE queued sender={} receiver={} clientId={} serverId={:?} channelId={:?}",
                request.get("sender").and_then(Value::as_str).unwrap_or(""),
                request.get("recipient").or_else(|| request.get("receiver")).and_then(Value::as_str).unwrap_or(""),
                request.get("clientId").and_then(Value::as_str).unwrap_or(""),
                request.get("serverId").and_then(Value::as_str),
                request.get("channelId").and_then(Value::as_str)
            ));
            runtime.spawn(async move {
                let snapshot = {
                    let guard = state.lock().ok();
                    let Some(guard) = guard else {
                        clear_in_flight_send_client_id(&send_guard_client_id);
                        return;
                    };
                    (
                        guard.api_base_url(),
                        guard.auth_token.clone(),
                        guard.current_username.clone(),
                        guard.current_key.clone(),
                        guard.current_device_id.clone(),
                    )
                };

                let sender = request
                    .get("sender")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(&snapshot.2)
                    .to_string();
                let receiver = request
                    .get("recipient")
                    .or_else(|| request.get("receiver"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let text = request.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                let key = request
                    .get("key")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(&snapshot.3)
                    .to_string();
                let key_version = request
                    .get("keyVersion")
                    .or_else(|| request.get("key_version"))
                    .and_then(Value::as_i64)
                    .and_then(|value| u8::try_from(value).ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(2);
                let client_id = request
                    .get("clientId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let server_id = request.get("serverId").and_then(Value::as_str).map(|value| value.to_string());
                let channel_id = request.get("channelId").and_then(Value::as_str).map(|value| value.to_string());

                let attachments = request
                    .get("attachments")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();

                if key.trim().is_empty() {
                    trace(format!("SEND_MESSAGE missing_key clientId={}", client_id));
                    dispatch_ui_event(
                        &proxy,
                        UiBusEvent::OnSendError,
                        UploadError::permanent("Core: E2E-ключ не задан").to_ui_payload(&client_id),
                    );
                    let log = format!(
                        "window.addLog({}, {});",
                        json_string_literal("ERROR"),
                        json_string_literal("Core: E2E-ключ не задан")
                    );
                    let _ = proxy.send_event(AppEvent::EvaluateScript(log));
                    clear_in_flight_send_client_id(&send_guard_client_id);
                    return;
                }

                let temp_dir = std::env::temp_dir().join("zali-messenger");
                let _ = tokio::fs::create_dir_all(&temp_dir).await;
                let archive_path = temp_dir.join(format!("{}.zali", Uuid::new_v4()));

                let mut packed_attachments = Vec::<Value>::new();
                let mut cleanup_paths = Vec::<PathBuf>::new();

                for attachment in attachments {
                    let Some(data_url) = attachment.get("dataUrl").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some((data, mime_type, file_extension)) = decode_data_url(data_url) else {
                        continue;
                    };

                    let name = attachment
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("attachment.bin");
                    let kind = attachment.get("kind").and_then(Value::as_str).unwrap_or("file");
                    let safe_name = sanitize_file_name(name, &file_extension);
                    let attachment_path = temp_dir.join(format!("{}_{}", Uuid::new_v4(), safe_name));

                    if tokio::fs::write(&attachment_path, data).await.is_ok() {
                        let size = if let Some(size) = attachment.get("size").and_then(Value::as_u64) {
                            size
                        } else {
                            tokio::fs::metadata(&attachment_path)
                                .await
                                .map(|meta| meta.len())
                                .unwrap_or(0)
                        };
                        packed_attachments.push(json!({
                            "path": attachment_path.to_string_lossy().to_string(),
                            "archivePath": format!("attachments/{}", safe_name),
                            "name": name,
                            "mimeType": attachment.get("mimeType").and_then(Value::as_str).unwrap_or(&mime_type),
                            "kind": kind,
                            "size": size,
                        }));
                        cleanup_paths.push(attachment_path);
                    }
                }

                let pack_result = pack_message(&sender, &text, &key, &archive_path, key_version, &packed_attachments);
                if let Err(error) = pack_result {
                    trace(format!("SEND_MESSAGE pack_failed clientId={} err={}", client_id, error));
                    dispatch_ui_event(
                        &proxy,
                        UiBusEvent::OnSendError,
                        UploadError::permanent(format!("Core: {}", error)).to_ui_payload(&client_id),
                    );
                    let log = format!("window.addLog({}, {});",
                        json_string_literal("ERROR"),
                        json_string_literal(&format!("Core: {}", error))
                    );
                    let _ = proxy.send_event(AppEvent::EvaluateScript(log));
                    for path in cleanup_paths {
                        let _ = tokio::fs::remove_file(path).await;
                    }
                    let _ = tokio::fs::remove_file(&archive_path).await;
                    clear_in_flight_send_client_id(&send_guard_client_id);
                    return;
                }

                let upload_result = upload_message(
                    ApiSession {
                        api_base_url: snapshot.0,
                        auth_token: snapshot.1,
                        device_id: snapshot.4,
                    },
                    OutgoingMessage {
                        sender: sender.clone(),
                        receiver,
                        client_id: client_id.clone(),
                        archive_path: archive_path.clone(),
                        server_id,
                        channel_id,
                        key_version,
                    },
                ).await;

                match upload_result {
                    Ok(message_id) => {
                        trace(format!("SEND_MESSAGE upload_ok clientId={} messageId={:?}", client_id, message_id));
                        let payload = json!({
                            "clientId": client_id,
                            "messageId": message_id.unwrap_or_default(),
                        });
                        dispatch_ui_event(&proxy, UiBusEvent::OnSendSuccess, payload);
                    }
                    Err(error) => {
                        trace(format!("SEND_MESSAGE upload_failed clientId={} err={}", client_id, error.message));
                        dispatch_ui_event(
                            &proxy,
                            UiBusEvent::OnSendError,
                            error.to_ui_payload(&client_id),
                        );
                        let log = format!("window.addLog({}, {});",
                            json_string_literal("ERROR"),
                            json_string_literal(&format!("Network: {}", error.message))
                        );
                        let _ = proxy.send_event(AppEvent::EvaluateScript(log));
                    }
                }

                for path in cleanup_paths {
                    let _ = tokio::fs::remove_file(path).await;
                }
                let _ = tokio::fs::remove_file(&archive_path).await;
                clear_in_flight_send_client_id(&send_guard_client_id);
            });
        }
        BridgeProtocolMessageType::StartDrag => {
            let _ = proxy.send_event(AppEvent::StartDrag);
        }
        BridgeProtocolMessageType::ShowNotification => {
            let sender = payload
                .get("sender")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let attachment_count = payload
                .get("attachmentCount")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let server_id = payload
                .get("serverId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let channel_id = payload
                .get("channelId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let current_username = state
                .lock()
                .map(|guard| guard.current_username.clone())
                .unwrap_or_default();
            let rendered = json!({
                "sender": sender,
                "text": text,
                "attachments": vec![Value::Null; attachment_count],
                "serverId": server_id,
                "channelId": channel_id,
            });
            show_message_notification(&rendered, &current_username);
        }
        BridgeProtocolMessageType::PersistDeviceIdentity => {
            // Mirror the JS-side device identity to a per-user plain file so it survives a
            // WebView localStorage wipe (rebuild/restart). On the next launch NativeState::load
            // re-injects it as window.__ZALI_INJECTED_DEVICE_IDENTITY, so the same device_id
            // (and its ECDH private key) is reused instead of a fresh registration — the churn
            // that orphaned key envelopes. Stores the raw identity JSON verbatim, including
            // privateKeyJwk; same plaintext tier as native_config.json.
            let username = payload
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let identity = payload
                .get("identity")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Ok(guard) = state.lock() {
                guard.persist_shared_device_identity(&username, &identity);
            }
        }
    }
}
