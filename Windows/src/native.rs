use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::TryFrom;
use std::ffi::CString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tao::event_loop::EventLoopProxy;
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, watch};
use tokio_util::codec::{BytesCodec, FramedRead};
use uuid::Uuid;

use futures_util::{stream, Sink, SinkExt, StreamExt};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{HeaderValue, Request},
        Message,
    },
};
use zali_messenger_core::{zali_bus_dispatch, zali_bus_free_string};

fn trace(message: impl AsRef<str>) {
    tracing::trace!("[ZALI][WIN] {}", message.as_ref());
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|error| {
                trace(format!(
                    "http_client builder failed err={}, falling back to default client",
                    error
                ));
                reqwest::Client::new()
            })
    })
}

fn in_flight_send_client_ids() -> &'static Mutex<HashSet<String>> {
    static IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn clear_in_flight_send_client_id(client_id: &str) {
    let id = client_id.trim();
    if id.is_empty() {
        return;
    }
    if let Ok(mut ids) = in_flight_send_client_ids().lock() {
        ids.remove(id);
    }
}

#[derive(Debug, Clone)]
struct UploadError {
    message: String,
    status_code: Option<u16>,
    response_body: String,
    timeout: bool,
}

impl UploadError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: None,
            response_body: String::new(),
            timeout: false,
        }
    }

    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: Some(400),
            response_body: String::new(),
            timeout: false,
        }
    }

    fn from_reqwest(error: reqwest::Error) -> Self {
        Self {
            message: error.to_string(),
            status_code: error.status().map(|status| status.as_u16()),
            response_body: String::new(),
            timeout: error.is_timeout(),
        }
    }

    fn http(status_code: u16, response_body: String) -> Self {
        let body = response_body.trim().to_string();
        let message = if body.is_empty() {
            format!("Upload failed with status {}", status_code)
        } else {
            format!("Upload failed with status {}: {}", status_code, body)
        };
        Self {
            message,
            status_code: Some(status_code),
            response_body: body,
            timeout: false,
        }
    }

    fn to_ui_payload(&self, client_id: &str) -> Value {
        json!({
            "clientId": client_id,
            "statusCode": self.status_code.unwrap_or_default(),
            "responseBody": self.response_body,
            "error": self.message,
            "timeout": self.timeout,
        })
    }
}

fn api_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .build()
            .unwrap_or_else(|error| {
                trace(format!(
                    "api_http_client builder failed err={}, falling back to default client",
                    error
                ));
                reqwest::Client::new()
            })
    })
}

fn auth_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(6))
            .build()
            .unwrap_or_else(|error| {
                trace(format!(
                    "auth_http_client builder failed err={}, falling back to api client",
                    error
                ));
                api_http_client().clone()
            })
    })
}

const MAX_AVATAR_BYTES: u64 = 2 * 1024 * 1024;
const BRIDGE_PROTOCOL_JSON: &str = include_str!("../../Web/bridge_protocol.json");

include!(concat!(env!("OUT_DIR"), "/bridge_protocol.rs"));

fn keyring_entry(name: &str) -> Option<keyring::Entry> {
    keyring::Entry::new("ZaliMessenger", name).ok()
}

fn load_secret_from_keyring(name: &str) -> Option<String> {
    keyring_entry(name)?.get_password().ok()
}

fn store_secret_in_keyring(name: &str, value: Option<&str>) -> bool {
    let Some(entry) = keyring_entry(name) else {
        return false;
    };
    match value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        Some(secret) => entry.set_password(&secret).is_ok(),
        None => entry.delete_password().is_ok(),
    }
}

fn is_direct_message_key(key: &str) -> bool {
    key.trim_start().starts_with("zali-e2e:v1:dm:")
}

fn dm_conversation_scope(a: &str, b: &str) -> Option<String> {
    let first = a.trim();
    let second = b.trim();
    if first.is_empty() || second.is_empty() {
        return None;
    }
    let mut names = [first.to_string(), second.to_string()];
    names.sort();
    Some(format!("dm:{}:{}", names[0], names[1]))
}

fn server_conversation_scope(server_id: &str, channel_id: &str) -> Option<String> {
    let server_id = server_id.trim();
    let channel_id = channel_id.trim();
    if server_id.is_empty() || channel_id.is_empty() {
        return None;
    }
    Some(format!("server:{}:{}", server_id, channel_id))
}

fn push_candidate_key(keys: &mut Vec<String>, key: impl Into<String>) {
    let key = key.into();
    let trimmed = key.trim();
    if trimmed.is_empty() || keys.iter().any(|existing| existing == trimmed) {
        return;
    }
    keys.push(trimmed.to_string());
}

fn candidate_message_keys(
    current_key: &str,
    conversation_keys: &HashMap<String, String>,
    current_username: &str,
    record: &Value,
    server_id: Option<&str>,
    channel_id: Option<&str>,
) -> Vec<String> {
    let mut keys = Vec::new();
    if let (Some(server_id), Some(channel_id)) = (server_id, channel_id) {
        if let Some(scope) = server_conversation_scope(server_id, channel_id) {
            if let Some(key) = conversation_keys.get(&scope) {
                push_candidate_key(&mut keys, key.clone());
            }
        }
    } else {
        let sender = record.get("sender").and_then(Value::as_str).unwrap_or("");
        let receiver = record.get("receiver").and_then(Value::as_str).unwrap_or("");
        let peer = if sender.trim() == current_username.trim() {
            receiver
        } else {
            sender
        };
        if let Some(scope) = dm_conversation_scope(current_username, peer) {
            if let Some(key) = conversation_keys.get(&scope) {
                push_candidate_key(&mut keys, key.clone());
            }
        }
    }
    if keys.is_empty() {
        push_candidate_key(&mut keys, current_key);
    }
    keys
}

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
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct VoiceConfig {
    ws_url: String,
    auth_token: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct MessageConfig {
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

    pub fn configure(
        &self,
        ws_base_url: Option<String>,
        api_base_url: String,
        auth_token: Option<String>,
        current_key: String,
        conversation_keys: HashMap<String, String>,
        current_username: String,
        current_device_id: String,
    ) {
        let ws_url = normalize_voice_ws_url(ws_base_url, Some(api_base_url.clone()));
        let auth_token = auth_token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let next = MessageConfig {
            ws_url,
            api_base_url,
            auth_token,
            current_key: current_key.trim().to_string(),
            conversation_keys,
            current_username: current_username.trim().to_string(),
            current_device_id: current_device_id.trim().to_string(),
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
        std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("ZaliMessenger")
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
            crypto_key: if keyring_key_ok {
                None
            } else if self.current_key.trim().is_empty() {
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

fn normalize_voice_ws_url(ws_base_url: Option<String>, api_base_url: Option<String>) -> String {
    if let Some(raw) = ws_base_url {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_string();
        }
    }

    if let Some(raw) = api_base_url {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if let Some(stripped) = trimmed.strip_prefix("https://") {
                return format!("wss://{}/ws", stripped.trim_end_matches('/'));
            }
            if let Some(stripped) = trimmed.strip_prefix("http://") {
                return format!("ws://{}/ws", stripped.trim_end_matches('/'));
            }
        }
    }

    "wss://msgs.zalikus.org/ws".to_string()
}

fn join_api_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim().trim_end_matches('/'),
        path.trim().trim_start_matches('/')
    )
}

fn json_string_literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn sanitize_file_name(name: &str, fallback_extension: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '?' | '%' | '*' | '|' | '"' | '<' | '>' => '_',
            _ => ch,
        })
        .collect();

    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return format!("attachment.{fallback_extension}");
    }
    let cleaned = trimmed.trim_start_matches('.').to_string();
    let cleaned = if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".to_string()
    } else {
        cleaned
    };
    cleaned
}

fn decode_data_url(value: &str) -> Option<(Vec<u8>, String, String)> {
    const MAX_DATA_URL_BYTES: usize = 100 * 1024 * 1024; // 100 MB
    if value.len() > MAX_DATA_URL_BYTES {
        return None;
    }
    let value = value.trim();
    if !value.starts_with("data:") {
        return None;
    }

    let comma = value.find(',')?;
    let meta = &value[5..comma];
    let payload = &value[comma + 1..];
    let mime_type = meta
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim();
    let file_extension = match mime_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    };

    if meta
        .split(';')
        .any(|part| part.trim().eq_ignore_ascii_case("base64"))
    {
        let bytes = BASE64_STANDARD.decode(payload).ok()?;
        return Some((bytes, mime_type.to_string(), file_extension.to_string()));
    }

    Some((
        payload.as_bytes().to_vec(),
        mime_type.to_string(),
        file_extension.to_string(),
    ))
}

fn sanitize_download_name(name: &str, fallback_extension: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '?' | '%' | '*' | '|' | '"' | '<' | '>' => '_',
            _ => ch,
        })
        .collect();

    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return format!("attachment.{fallback_extension}");
    }
    let cleaned = trimmed.trim_start_matches('.').to_string();
    let cleaned = if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".to_string()
    } else {
        cleaned
    };
    cleaned
}

fn user_downloads_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|base| base.join("Downloads"))
        .unwrap_or_else(std::env::temp_dir)
}

fn unique_download_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let ext = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for index in 2..10_000 {
        let next_name = if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        };
        let next = dir.join(next_name);
        if !next.exists() {
            return next;
        }
    }

    dir.join(filename)
}

fn save_data_url_attachment(data_url: &str, filename: &str) -> Result<PathBuf, String> {
    let (data, _mime_type, fallback_extension) =
        decode_data_url(data_url).ok_or_else(|| "Invalid attachment data URL".to_string())?;
    if data.is_empty() {
        return Err("Attachment payload is empty".to_string());
    }

    let download_dir = user_downloads_dir();
    fs::create_dir_all(&download_dir).map_err(|e| e.to_string())?;
    let safe_name = sanitize_download_name(filename, &fallback_extension);
    let destination = unique_download_path(&download_dir, &safe_name);
    if !destination.starts_with(&download_dir) {
        return Err("Path traversal detected".to_string());
    }
    fs::write(&destination, data).map_err(|e| e.to_string())?;
    Ok(destination)
}

fn html_search_lower(haystack: &str, needle: &str, start: usize) -> Option<usize> {
    let lower_haystack = haystack.get(start..)?.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    lower_haystack
        .find(&lower_needle)
        .map(|offset| start + offset)
}

fn extract_meta_content(html: &str, marker: &str) -> Option<String> {
    let marker_index = html_search_lower(html, marker, 0)?;
    let search_start = marker_index + marker.len();
    let content_index = html_search_lower(html, "content=", search_start)?;
    let after_content = html.get(content_index + "content=".len()..)?;
    let mut chars = after_content.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }

    let rest = &after_content[quote.len_utf8()..];
    let end = rest.find(quote)?;
    let value = rest[..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn infer_mime_and_kind(url: &str) -> (String, String) {
    let lower = url.to_ascii_lowercase();
    if lower.ends_with(".mp4") {
        return ("video/mp4".to_string(), "video".to_string());
    }
    if lower.ends_with(".webm") {
        return ("video/webm".to_string(), "video".to_string());
    }
    if lower.ends_with(".gif") {
        return ("image/gif".to_string(), "gif".to_string());
    }
    if lower.ends_with(".webp") {
        return ("image/webp".to_string(), "image".to_string());
    }
    if lower.ends_with(".png") {
        return ("image/png".to_string(), "image".to_string());
    }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        return ("image/jpeg".to_string(), "image".to_string());
    }
    ("application/octet-stream".to_string(), "file".to_string())
}

fn websocket_request(
    ws_url: &str,
    auth_token: Option<&str>,
    device_id: Option<&str>,
) -> Result<Request<()>, String> {
    let mut request = ws_url.into_client_request().map_err(|e| e.to_string())?;
    if let Some(token) = auth_token
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let auth_value =
            HeaderValue::from_str(&format!("Bearer {}", token)).map_err(|e| e.to_string())?;
        request.headers_mut().insert("Authorization", auth_value);
    }
    if let Some(device_id) = device_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let device_value = HeaderValue::from_str(device_id).map_err(|e| e.to_string())?;
        request
            .headers_mut()
            .insert("X-Zali-Device-ID", device_value);
    }
    Ok(request)
}

fn voice_request(ws_url: &str, auth_token: Option<&str>) -> Result<Request<()>, String> {
    websocket_request(ws_url, auth_token, None)
}

fn message_request(current: &MessageConfig) -> Result<Request<()>, String> {
    websocket_request(
        &current.ws_url,
        current.auth_token.as_deref(),
        Some(current.current_device_id.as_str()),
    )
}

async fn send_voice_payload(
    writer: &mut (impl Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    payload: &Value,
) -> Result<(), String> {
    let text = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    writer
        .send(Message::Text(text))
        .await
        .map_err(|e| e.to_string())
}

async fn fetch_users(
    api_base_url: String,
    auth_token: Option<String>,
    current_username: String,
) -> Vec<String> {
    let url = format!("{}/api/users", api_base_url.trim_end_matches('/'));
    let client = auth_http_client();
    let mut request = client.get(&url);
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(response) if response.status().is_success() => {
            match response.json::<Vec<String>>().await {
                Ok(users) => users,
                Err(error) => {
                    trace(format!("fetch_users decode_error err={}", error));
                    vec!["Alice".to_string(), "Bob".to_string(), current_username]
                }
            }
        }
        Ok(response) => {
            trace(format!(
                "fetch_users http_fail status={}",
                response.status()
            ));
            vec!["Alice".to_string(), "Bob".to_string(), current_username]
        }
        Err(error) => {
            trace(format!("fetch_users request_error err={}", error));
            vec!["Alice".to_string(), "Bob".to_string(), current_username]
        }
    }
}

async fn fetch_contacts(
    api_base_url: String,
    auth_token: Option<String>,
) -> Result<Vec<String>, String> {
    let url = format!("{}/api/contacts", api_base_url.trim_end_matches('/'));
    let client = auth_http_client();
    let mut request = client.get(&url);
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(response) if response.status().is_success() => {
            match response.json::<HashMap<String, Vec<String>>>().await {
                Ok(payload) => Ok(payload.get("contacts").cloned().unwrap_or_default()),
                Err(error) => {
                    trace(format!("fetch_contacts decode_error err={}", error));
                    Err(error.to_string())
                }
            }
        }
        Ok(response) => {
            trace(format!(
                "fetch_contacts http_fail status={}",
                response.status()
            ));
            Err(format!(
                "Fetch contacts failed with status {}",
                response.status()
            ))
        }
        Err(error) => {
            trace(format!("fetch_contacts request_error err={}", error));
            Err(error.to_string())
        }
    }
}

fn dispatch_voice_event(proxy: &EventLoopProxy<AppEvent>, payload: Value) {
    dispatch_ui_event(proxy, UiBusEvent::VoiceEvent, payload);
}

fn dispatch_voice_log(proxy: &EventLoopProxy<AppEvent>, level: &str, msg: String) {
    dispatch_ui_event(
        proxy,
        UiBusEvent::AddLogEntry,
        json!({
            "type": level,
            "msg": msg,
            "ts": "",
        }),
    );
}

fn notification_body(text: &str, attachment_count: usize) -> String {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        return trimmed.chars().take(180).collect();
    }
    if attachment_count == 1 {
        return "Вложение".to_string();
    }
    if attachment_count > 1 {
        return format!("Вложения: {}", attachment_count);
    }
    "Новое сообщение".to_string()
}

fn show_message_notification(rendered: &Value, current_username: &str) {
    let sender = rendered
        .get("sender")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if sender.is_empty() || sender == current_username.trim() {
        return;
    }

    let text = rendered.get("text").and_then(Value::as_str).unwrap_or("");
    let attachment_count = rendered
        .get("attachments")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let has_channel = rendered.get("serverId").is_some() || rendered.get("channelId").is_some();
    let title = if has_channel {
        format!("{} в канале", sender)
    } else {
        sender.to_string()
    };
    let body = notification_body(text, attachment_count);

    let mut notification = notify_rust::Notification::new();
    notification.appname("Zali Messenger");
    #[cfg(target_os = "windows")]
    notification.app_id("com.zali.messenger");

    if let Err(error) = notification.summary(&title).body(&body).show() {
        trace(format!("notification failed err={}", error));
    }
}

async fn run_voice_transport(
    mut config_rx: watch::Receiver<VoiceConfig>,
    mut outbound_rx: mpsc::UnboundedReceiver<Value>,
    proxy: EventLoopProxy<AppEvent>,
) {
    let mut pending = VecDeque::<Value>::new();
    let mut reconnect_delay_secs = 1u64;

    loop {
        let current = config_rx.borrow().clone();
        if current.ws_url.trim().is_empty() {
            tokio::select! {
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                maybe_payload = outbound_rx.recv() => {
                    match maybe_payload {
                        Some(payload) => pending.push_back(payload),
                        None => return,
                    }
                }
            }
            continue;
        }

        let request = match voice_request(&current.ws_url, current.auth_token.as_deref()) {
            Ok(request) => request,
            Err(error) => {
                trace(format!(
                    "voice ws request build failed url={} err={}",
                    current.ws_url, error
                ));
                dispatch_voice_log(
                    &proxy,
                    "ERROR",
                    format!("Voice connection error: {}", error),
                );
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay_secs)) => {}
                    changed = config_rx.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
                reconnect_delay_secs = (reconnect_delay_secs.saturating_mul(2)).min(30);
                continue;
            }
        };

        trace(format!(
            "voice ws connect url={} token={}",
            current.ws_url,
            current.auth_token.is_some()
        ));

        let (ws_stream, _) = match connect_async(request).await {
            Ok(result) => result,
            Err(error) => {
                trace(format!(
                    "voice ws connect failed url={} err={}",
                    current.ws_url, error
                ));
                dispatch_voice_log(&proxy, "WARN", format!("Voice reconnecting: {}", error));
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay_secs)) => {}
                    changed = config_rx.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
                reconnect_delay_secs = (reconnect_delay_secs.saturating_mul(2)).min(30);
                continue;
            }
        };

        reconnect_delay_secs = 1;
        trace(format!("voice ws connected url={}", current.ws_url));
        let (mut writer, mut reader) = ws_stream.split();

        while let Some(payload) = pending.pop_front() {
            if let Err(error) = send_voice_payload(&mut writer, &payload).await {
                trace(format!("voice ws flush failed err={}", error));
                pending.push_front(payload);
                break;
            }
        }

        loop {
            tokio::select! {
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    trace("voice ws config changed; reconnecting");
                    break;
                }
                maybe_payload = outbound_rx.recv() => {
                    match maybe_payload {
                        Some(payload) => {
                            if let Err(error) = send_voice_payload(&mut writer, &payload).await {
                                trace(format!("voice ws send failed err={}", error));
                                pending.push_front(payload);
                                break;
                            }
                        }
                        None => return,
                    }
                }
                maybe_msg = reader.next() => {
                    match maybe_msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(raw) = serde_json::from_str::<Value>(&text) {
                                if raw.get("type").and_then(Value::as_str).map(|value| value.starts_with("voice_")).unwrap_or(false) {
                                    dispatch_voice_event(&proxy, raw);
                                }
                            }
                        }
                        Some(Ok(Message::Binary(data))) => {
                            if let Ok(text) = String::from_utf8(data.to_vec()) {
                                if let Ok(raw) = serde_json::from_str::<Value>(&text) {
                                    if raw.get("type").and_then(Value::as_str).map(|value| value.starts_with("voice_")).unwrap_or(false) {
                                        dispatch_voice_event(&proxy, raw);
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Ping(_))) => {}
                        Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(Message::Frame(_))) => {}
                        Some(Ok(Message::Close(_))) => {
                            trace("voice ws closed by server");
                            dispatch_voice_log(&proxy, "WARN", "Voice socket closed".to_string());
                            break;
                        }
                        Some(Err(error)) => {
                            trace(format!("voice ws receive error={}", error));
                            dispatch_voice_log(&proxy, "WARN", format!("Voice socket error: {}", error));
                            break;
                        }
                        None => {
                            trace("voice ws stream ended");
                            dispatch_voice_log(&proxy, "WARN", "Voice socket disconnected".to_string());
                            break;
                        }
                    }
                }
            }
        }
    }
}

async fn handle_message_ws_payload(
    raw: Value,
    current: MessageConfig,
    proxy: EventLoopProxy<AppEvent>,
) {
    if raw
        .get("type")
        .and_then(Value::as_str)
        .map(|value| {
            value.starts_with("voice_")
                || value == "reaction_updated"
                || value.ends_with("avatar_updated")
                || value == "avatar_deleted"
                || value == "key_envelope_available"
        })
        .unwrap_or(false)
    {
        if raw.get("type").and_then(Value::as_str) == Some("key_envelope_available") {
            dispatch_ui_event(&proxy, UiBusEvent::RefreshAfterKey, serde_json::Value::Null);
        } else if raw.get("type").and_then(Value::as_str) == Some("reaction_updated") {
            dispatch_ui_event(&proxy, UiBusEvent::ReactionUpdated, raw);
        }
        return;
    }

    let message_id = raw
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let filename = raw
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if message_id.is_empty() || filename.is_empty() {
        return;
    }

    let server_id = raw
        .get("serverId")
        .or_else(|| raw.get("server_id"))
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    let channel_id = raw
        .get("channelId")
        .or_else(|| raw.get("channel_id"))
        .and_then(Value::as_str)
        .map(|value| value.to_string());

    let keys = candidate_message_keys(
        &current.current_key,
        &current.conversation_keys,
        &current.current_username,
        &raw,
        server_id.as_deref(),
        channel_id.as_deref(),
    );

    match process_history_record(
        current.api_base_url,
        current.auth_token,
        current.current_device_id,
        keys,
        raw,
        "message_ws",
        server_id,
        channel_id,
    )
    .await
    {
        Some(rendered) => {
            show_message_notification(&rendered, &current.current_username);
            dispatch_ui_event(&proxy, UiBusEvent::ReceiveMessage, rendered);
        }
        None => {
            trace(format!(
                "{} skipped render for message_id={} reason=unpack_or_decrypt_failed",
                "message_ws", message_id
            ));
        }
    }
}

async fn run_message_transport(
    mut config_rx: watch::Receiver<MessageConfig>,
    proxy: EventLoopProxy<AppEvent>,
) {
    let mut reconnect_delay_secs = 1u64;

    loop {
        let current = config_rx.borrow().clone();
        if current.ws_url.trim().is_empty()
            || current.api_base_url.trim().is_empty()
            || current.auth_token.is_none()
        {
            if config_rx.changed().await.is_err() {
                return;
            }
            continue;
        }

        let request = match message_request(&current) {
            Ok(request) => request,
            Err(error) => {
                trace(format!(
                    "message ws request build failed url={} err={}",
                    current.ws_url, error
                ));
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay_secs)) => {}
                    changed = config_rx.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
                reconnect_delay_secs = (reconnect_delay_secs.saturating_mul(2)).min(30);
                continue;
            }
        };

        trace(format!(
            "message ws connect url={} token={} key_set={} device_id={}",
            current.ws_url,
            current.auth_token.is_some(),
            !current.current_key.trim().is_empty(),
            current.current_device_id
        ));

        let (_writer, mut reader) = match connect_async(request).await {
            Ok((stream, response)) => {
                trace(format!("message ws connected status={}", response.status()));
                let (_writer, reader) = stream.split();
                (_writer, reader)
            }
            Err(error) => {
                trace(format!(
                    "message ws connect failed url={} err={}",
                    current.ws_url, error
                ));
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay_secs)) => {}
                    changed = config_rx.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
                reconnect_delay_secs = (reconnect_delay_secs.saturating_mul(2)).min(30);
                continue;
            }
        };

        reconnect_delay_secs = 1;
        loop {
            tokio::select! {
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    trace("message ws config changed; reconnecting");
                    break;
                }
                maybe_msg = reader.next() => {
                    match maybe_msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(raw) = serde_json::from_str::<Value>(&text) {
                                let current = current.clone();
                                let proxy = proxy.clone();
                                tokio::spawn(async move {
                                    handle_message_ws_payload(raw, current, proxy).await;
                                });
                            }
                        }
                        Some(Ok(Message::Binary(data))) => {
                            if let Ok(text) = String::from_utf8(data.to_vec()) {
                                if let Ok(raw) = serde_json::from_str::<Value>(&text) {
                                    let current = current.clone();
                                    let proxy = proxy.clone();
                                    tokio::spawn(async move {
                                        handle_message_ws_payload(raw, current, proxy).await;
                                    });
                                }
                            }
                        }
                        Some(Ok(Message::Ping(_))) => {}
                        Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(Message::Frame(_))) => {}
                        Some(Ok(Message::Close(_))) => {
                            trace("message ws closed by server");
                            break;
                        }
                        Some(Err(error)) => {
                            trace(format!("message ws receive error={}", error));
                            break;
                        }
                        None => {
                            trace("message ws stream ended");
                            break;
                        }
                    }
                }
            }
        }
    }
}

fn dispatch_core_command(address_command: &str, args: Value) -> Result<Value, String> {
    let command = CString::new(address_command).map_err(|e| e.to_string())?;
    let args_str = CString::new(args.to_string()).map_err(|e| e.to_string())?;

    let response_ptr = unsafe { zali_bus_dispatch(command.as_ptr(), args_str.as_ptr()) };
    if response_ptr.is_null() {
        return Err("Rust core returned a null response".to_string());
    }

    let response = unsafe {
        let text = std::ffi::CStr::from_ptr(response_ptr)
            .to_string_lossy()
            .into_owned();
        zali_bus_free_string(response_ptr);
        text
    };

    serde_json::from_str(&response).map_err(|e| e.to_string())
}

fn pack_message(
    sender: &str,
    text: &str,
    key: &str,
    output_path: &Path,
    key_version: u8,
    attachments: &[Value],
) -> Result<PathBuf, String> {
    let args = json!({
        "sender": sender,
        "text": text,
        "key": key,
        "output_path": output_path.to_string_lossy().to_string(),
        "key_version": key_version,
        "attachments": attachments,
    });

    let response = dispatch_core_command("zali_net:pack_message", args)?;
    if response.get("success").and_then(Value::as_bool) == Some(true) {
        Ok(output_path.to_path_buf())
    } else {
        Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Failed to pack message")
            .to_string())
    }
}

async fn upload_message(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    sender: String,
    receiver: String,
    client_id: String,
    file_url: PathBuf,
    server_id: Option<String>,
    channel_id: Option<String>,
    key_version: u8,
) -> Result<Option<String>, UploadError> {
    let url = format!("{}/api/upload", api_base_url.trim_end_matches('/'));
    let file = tokio::fs::File::open(&file_url)
        .await
        .map_err(|e| UploadError::new(e.to_string()))?;
    let file_stream = FramedRead::new(file, BytesCodec::new());
    let file_body = reqwest::Body::wrap_stream(file_stream);
    let client = http_client();

    let mut form = multipart::Form::new()
        .text("sender", sender)
        .text("receiver", receiver)
        .text("client_id", client_id)
        .text("key_version", key_version.max(1).to_string())
        .part(
            "file",
            multipart::Part::stream(file_body)
                .file_name("msg.zali")
                .mime_str("application/octet-stream")
                .map_err(|e| UploadError::new(e.to_string()))?,
        );

    if let (Some(server_id), Some(channel_id)) = (server_id, channel_id) {
        if !server_id.trim().is_empty() && !channel_id.trim().is_empty() {
            form = form
                .text("server_id", server_id)
                .text("channel_id", channel_id);
        }
    }

    let mut request = client.post(url).multipart(form);
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    let response = request.send().await.map_err(UploadError::from_reqwest)?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(UploadError::http(status.as_u16(), body));
    }

    let message_id = match response.json::<Value>().await {
        Ok(json) => json
            .get("id")
            .and_then(Value::as_str)
            .map(|s| s.to_string()),
        Err(_) => None,
    };

    Ok(message_id)
}

async fn fetch_messages_page(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    username: String,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>, String> {
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/messages/",
        api_base_url.trim_end_matches('/')
    ))
    .map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "cannot-be-base".to_string())?
        .push(&username);
    url.set_query(Some(&format!("limit={}&offset={}", limit, offset)));
    let url = url.to_string();
    trace(format!(
        "fetch_messages_page start user={} url={}",
        username, url
    ));
    let client = http_client();
    let mut request = client.get(url);
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        trace(format!(
            "fetch_messages_page http_fail user={} status={}",
            username,
            response.status()
        ));
        return Err(format!("Fetch failed with status {}", response.status()));
    }

    let messages = response
        .json::<Vec<Value>>()
        .await
        .map_err(|e| e.to_string())?;
    trace(format!(
        "fetch_messages_page success user={} count={} offset={}",
        username,
        messages.len(),
        offset
    ));
    Ok(messages)
}

async fn fetch_messages(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    username: String,
) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    let page_size = 200_i64;
    let mut offset = 0_i64;

    loop {
        let page = fetch_messages_page(
            api_base_url.clone(),
            auth_token.clone(),
            device_id.clone(),
            username.clone(),
            page_size,
            offset,
        )
        .await?;
        let count = page.len();
        all.extend(page);
        if (count as i64) < page_size {
            break;
        }
        offset += page_size;
    }

    trace(format!(
        "fetch_messages success user={} count={}",
        username,
        all.len()
    ));
    Ok(all)
}

async fn fetch_server_messages_page(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    server_id: String,
    channel_id: String,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>, String> {
    let url = format!(
        "{}/api/servers/{}/channels/{}/messages?limit={}&offset={}",
        api_base_url.trim_end_matches('/'),
        server_id,
        channel_id,
        limit,
        offset
    );
    trace(format!(
        "fetch_server_messages_page start server={} channel={} url={}",
        server_id, channel_id, url
    ));
    let client = http_client();
    let mut request = client.get(url);
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        trace(format!(
            "fetch_server_messages_page http_fail server={} channel={} status={}",
            server_id,
            channel_id,
            response.status()
        ));
        return Err(format!("Fetch failed with status {}", response.status()));
    }

    let messages = response
        .json::<Vec<Value>>()
        .await
        .map_err(|e| e.to_string())?;
    trace(format!(
        "fetch_server_messages_page success server={} channel={} count={} offset={}",
        server_id,
        channel_id,
        messages.len(),
        offset
    ));
    Ok(messages)
}

async fn fetch_server_messages(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    server_id: String,
    channel_id: String,
) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    let page_size = 200_i64;
    let mut offset = 0_i64;

    loop {
        let page = fetch_server_messages_page(
            api_base_url.clone(),
            auth_token.clone(),
            device_id.clone(),
            server_id.clone(),
            channel_id.clone(),
            page_size,
            offset,
        )
        .await?;
        let count = page.len();
        all.extend(page);
        if (count as i64) < page_size {
            break;
        }
        offset += page_size;
    }

    trace(format!(
        "fetch_server_messages success server={} channel={} count={}",
        server_id,
        channel_id,
        all.len()
    ));
    Ok(all)
}

async fn download_message(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    message_id: String,
) -> Result<PathBuf, String> {
    let url = format!(
        "{}/api/download/{}",
        api_base_url.trim_end_matches('/'),
        message_id
    );
    let client = http_client();
    let mut request = client.get(url);
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        trace(format!(
            "download_message http_fail id={} status={}",
            message_id,
            response.status()
        ));
        return Err(format!("Download failed with status {}", response.status()));
    }

    let temp_dir = std::env::temp_dir().join("zali-messenger");
    let _ = tokio::fs::create_dir_all(&temp_dir).await;
    let file_path = temp_dir.join(format!("{}.zali", message_id));
    let mut output = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| e.to_string())?;
    const MAX_MESSAGE_FILE_BYTES: u64 = 512 * 1024 * 1024;
    let mut total_written: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        total_written += chunk.len() as u64;
        if total_written > MAX_MESSAGE_FILE_BYTES {
            return Err("Message file too large".to_string());
        }
        tokio::io::AsyncWriteExt::write_all(&mut output, &chunk)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(file_path)
}

async fn retry_with_backoff<T, F, Fut>(label: &str, attempts: usize, mut op: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let max_attempts = attempts.max(1);
    let mut last_error = String::new();
    for attempt in 1..=max_attempts {
        match op().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                last_error = error.clone();
                trace(format!("{} retry={} err={}", label, attempt, error));
                if attempt < max_attempts {
                    let delay_ms =
                        250_u64.saturating_mul(1_u64 << (attempt.saturating_sub(1) as u32));
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms.min(2_000))).await;
                }
            }
        }
    }

    Err(last_error)
}

async fn process_history_record(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    keys: Vec<String>,
    record: Value,
    context_label: &str,
    server_id: Option<String>,
    channel_id: Option<String>,
) -> Option<Value> {
    let message_id = record
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if message_id.is_empty() {
        return None;
    }

    let file_url = match retry_with_backoff(
        &format!("{}_download_message id={}", context_label, message_id),
        3,
        || {
            let api_base_url = api_base_url.clone();
            let auth_token = auth_token.clone();
            let device_id = device_id.clone();
            let message_id = message_id.clone();
            async move { download_message(api_base_url, auth_token, device_id, message_id).await }
        },
    )
    .await
    {
        Ok(path) => path,
        Err(error) => {
            trace(format!(
                "{} download_error message_id={} err={}",
                context_label, message_id, error
            ));
            return None;
        }
    };

    let temp_dir = std::env::temp_dir().join(format!("zali-unpack-{}", Uuid::new_v4()));
    let _ = tokio::fs::create_dir_all(&temp_dir).await;

    let mut unpacked: Option<Value> = None;
    let mut last_unpack_error = String::new();
    for key in keys {
        let unpack_attempt = retry_with_backoff(
            &format!("{}_unpack_message id={}", context_label, message_id),
            3,
            || {
                let file_url = file_url.clone();
                let temp_dir = temp_dir.clone();
                let key = key.clone();
                async move {
                    let archive_path = file_url.to_string_lossy().to_string();
                    let temp_dir_path = temp_dir.to_string_lossy().to_string();
                    let response = dispatch_core_command(
                        "zali_net:unpack_message",
                        json!({
                            "archive_path": archive_path,
                            "temp_dir": temp_dir_path,
                            "key": key,
                        }),
                    )?;
                    if response.get("success").and_then(Value::as_bool) != Some(true) {
                        return Err(response
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Failed to unpack message")
                            .to_string());
                    }
                    response
                        .get("data")
                        .cloned()
                        .ok_or_else(|| "Unpack response does not contain data".to_string())
                        .and_then(|data| {
                            if let Some(error) = data.get("decryptionError").and_then(Value::as_str)
                            {
                                if !error.trim().is_empty() {
                                    return Err(error.to_string());
                                }
                            }
                            Ok(data)
                        })
                }
            },
        )
        .await;

        match unpack_attempt {
            Ok(value) => {
                unpacked = Some(value);
                break;
            }
            Err(error) => {
                last_unpack_error = error;
            }
        }
    }

    let Some(unpacked) = unpacked else {
        trace(format!(
            "{} unpack_error message_id={} err={}",
            context_label, message_id, last_unpack_error
        ));
        let _ = tokio::fs::remove_file(&file_url).await;
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        let mut output = json!({
            "id": message_id,
            "clientId": record.get("clientId").or_else(|| record.get("client_id")).cloned().unwrap_or(Value::Null),
            "sender": record.get("sender").and_then(Value::as_str).unwrap_or(""),
            "receiver": record.get("receiver").and_then(Value::as_str).unwrap_or(""),
            "text": "Не удалось расшифровать сообщение: нет E2E-ключа для этой переписки",
            "attachments": [],
            "timestamp": record.get("timestamp").cloned().unwrap_or(Value::Null),
            "reactions": record.get("reactions").cloned().unwrap_or_else(|| json!([])),
            "myReaction": record.get("myReaction").or_else(|| record.get("my_reaction")).cloned().unwrap_or(Value::String(String::new())),
            "decryptionError": last_unpack_error,
        });
        if let Some(server_id_value) = server_id
            .clone()
            .or_else(|| {
                record
                    .get("serverId")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            })
            .or_else(|| {
                record
                    .get("server_id")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            })
        {
            output["serverId"] = Value::String(server_id_value);
        }
        if let Some(channel_id_value) = channel_id
            .clone()
            .or_else(|| {
                record
                    .get("channelId")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            })
            .or_else(|| {
                record
                    .get("channel_id")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            })
        {
            output["channelId"] = Value::String(channel_id_value);
        }
        return Some(output);
    };

    let _ = tokio::fs::remove_file(&file_url).await;
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;

    let sender = unpacked
        .get("sender")
        .and_then(Value::as_str)
        .unwrap_or_else(|| record.get("sender").and_then(Value::as_str).unwrap_or(""));
    let text = unpacked.get("text").and_then(Value::as_str).unwrap_or("");
    let attachments = unpacked
        .get("attachments")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let server_id_value = server_id
        .clone()
        .or_else(|| {
            record
                .get("serverId")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        })
        .or_else(|| {
            record
                .get("server_id")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        });
    let channel_id_value = channel_id
        .clone()
        .or_else(|| {
            record
                .get("channelId")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        })
        .or_else(|| {
            record
                .get("channel_id")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        });

    let mut output = json!({
        "id": message_id,
        "clientId": record.get("clientId").or_else(|| record.get("client_id")).cloned().unwrap_or(Value::Null),
        "sender": sender,
        "receiver": record.get("receiver").and_then(Value::as_str).unwrap_or(""),
        "text": text,
        "attachments": attachments,
        "timestamp": record.get("timestamp").cloned().unwrap_or(Value::Null),
        "reactions": record.get("reactions").cloned().unwrap_or_else(|| json!([])),
        "myReaction": record.get("myReaction").or_else(|| record.get("my_reaction")).cloned().unwrap_or(Value::String(String::new())),
    });

    if let Some(server_id_value) = server_id_value {
        output["serverId"] = Value::String(server_id_value);
    }
    if let Some(channel_id_value) = channel_id_value {
        output["channelId"] = Value::String(channel_id_value);
    }

    Some(output)
}

async fn refresh_direct_history(
    api_base_url: String,
    auth_token: Option<String>,
    peer: String,
    key: String,
    device_id: String,
    proxy: EventLoopProxy<AppEvent>,
) {
    if key.trim().is_empty() {
        trace(format!(
            "refresh_direct_history skip user={} reason=empty_key",
            peer
        ));
        return;
    }
    trace(format!(
        "refresh_direct_history start user={} api={} token={} key_set={}",
        peer,
        api_base_url,
        auth_token.is_some(),
        !key.trim().is_empty()
    ));

    let records = match fetch_messages(
        api_base_url.clone(),
        auth_token.clone(),
        device_id.clone(),
        peer.clone(),
    )
    .await
    {
        Ok(records) => records,
        Err(error) => {
            trace(format!(
                "refresh_direct_history fetch_error user={} err={}",
                peer, error
            ));
            let log = format!(
                "window.addLog({}, {});",
                json_string_literal("ERROR"),
                json_string_literal(&format!("Не удалось загрузить историю: {}", error))
            );
            let _ = proxy.send_event(AppEvent::EvaluateScript(log));
            return;
        }
    };
    trace(format!(
        "refresh_direct_history records user={} count={}",
        peer,
        records.len()
    ));

    let total_records = records.len();
    let rendered = stream::iter(records.into_iter().map(|record| {
        let api_base_url = api_base_url.clone();
        let auth_token = auth_token.clone();
        let device_id = device_id.clone();
        let keys = candidate_message_keys(&key, &HashMap::new(), "", &record, None, None);
        async move {
            process_history_record(
                api_base_url,
                auth_token,
                device_id.clone(),
                keys,
                record,
                "refresh_direct_history",
                None,
                None,
            )
            .await
        }
    }))
    .buffer_unordered(4)
    .filter_map(|item| async move { item })
    .collect::<Vec<_>>()
    .await;

    let rendered_count = rendered.len();
    if rendered_count < total_records {
        let skipped = total_records.saturating_sub(rendered_count);
        dispatch_ui_event(
            &proxy,
            UiBusEvent::AddLogEntry,
            json!({
                "type": "WARN",
                "msg": format!("История чата: пропущено сообщений: {}", skipped),
            }),
        );
    }
    let payload = Value::Array(rendered);
    let script = format!("window.loadHistory && window.loadHistory({});", payload);
    let _ = proxy.send_event(AppEvent::EvaluateScript(script));
    trace(format!(
        "refresh_direct_history dispatch user={} rendered={}",
        peer, rendered_count
    ));
}

async fn refresh_server_history(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    server_id: String,
    channel_id: String,
    key: String,
    proxy: EventLoopProxy<AppEvent>,
) {
    if key.trim().is_empty() {
        trace(format!(
            "refresh_server_history skip server={} channel={} reason=empty_key",
            server_id, channel_id
        ));
        return;
    }
    trace(format!(
        "refresh_server_history start server={} channel={} api={} token={} key_set={}",
        server_id,
        channel_id,
        api_base_url,
        auth_token.is_some(),
        !key.trim().is_empty()
    ));

    let records = match fetch_server_messages(
        api_base_url.clone(),
        auth_token.clone(),
        device_id.clone(),
        server_id.clone(),
        channel_id.clone(),
    )
    .await
    {
        Ok(records) => records,
        Err(error) => {
            trace(format!(
                "refresh_server_history fetch_error server={} channel={} err={}",
                server_id, channel_id, error
            ));
            let log = format!(
                "window.addLog({}, {});",
                json_string_literal("ERROR"),
                json_string_literal(&format!("Не удалось загрузить историю канала: {}", error))
            );
            let _ = proxy.send_event(AppEvent::EvaluateScript(log));
            return;
        }
    };

    trace(format!(
        "refresh_server_history records server={} channel={} count={}",
        server_id,
        channel_id,
        records.len()
    ));

    let total_records = records.len();
    let rendered = stream::iter(records.into_iter().map(|record| {
        let api_base_url = api_base_url.clone();
        let auth_token = auth_token.clone();
        let device_id = device_id.clone();
        let server_id = server_id.clone();
        let channel_id = channel_id.clone();
        let keys = candidate_message_keys(
            &key,
            &HashMap::new(),
            "",
            &record,
            Some(&server_id),
            Some(&channel_id),
        );
        async move {
            process_history_record(
                api_base_url,
                auth_token,
                device_id.clone(),
                keys,
                record,
                "refresh_server_history",
                Some(server_id),
                Some(channel_id),
            )
            .await
        }
    }))
    .buffer_unordered(4)
    .filter_map(|item| async move { item })
    .collect::<Vec<_>>()
    .await;

    let rendered_count = rendered.len();
    if rendered_count < total_records {
        let skipped = total_records.saturating_sub(rendered_count);
        dispatch_ui_event(
            &proxy,
            UiBusEvent::AddLogEntry,
            json!({
                "type": "WARN",
                "msg": format!("История канала: пропущено сообщений: {}", skipped),
            }),
        );
    }
    dispatch_ui_event(
        &proxy,
        UiBusEvent::LoadServerHistory,
        json!({
            "serverId": server_id,
            "channelId": channel_id,
            "messages": rendered,
        }),
    );
    trace(format!(
        "refresh_server_history dispatch server={} channel={} rendered={}",
        server_id, channel_id, rendered_count
    ));
}

async fn perform_auth_request(
    api_base_url: String,
    mode: String,
    username: String,
    password: String,
    request_id: String,
    proxy: EventLoopProxy<AppEvent>,
) {
    let mode_is_register = mode.trim().eq_ignore_ascii_case("register");
    let endpoint = if mode_is_register {
        "/api/auth/register"
    } else {
        "/api/auth/login"
    };
    let url = join_api_url(&api_base_url, endpoint);
    let payload = json!({
        "username": username,
        "password": password,
    });
    let client = auth_http_client();

    let mut response = match client.post(&url).json(&payload).send().await {
        Ok(response) => response,
        Err(error) => {
            trace(format!(
                "AUTH_REQUEST transport_error url={} err={}",
                url, error
            ));
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
    };

    if mode_is_register && response.status().as_u16() == 409 {
        trace(format!(
            "AUTH_REQUEST register_conflict url={} retry=login",
            url
        ));
        let login_url = join_api_url(&api_base_url, "/api/auth/login");
        response = match client.post(&login_url).json(&payload).send().await {
            Ok(response) => response,
            Err(error) => {
                trace(format!(
                    "AUTH_REQUEST retry_transport_error url={} err={}",
                    login_url, error
                ));
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
        };
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        trace(format!(
            "AUTH_REQUEST http_fail url={} status={} body={}",
            url,
            status,
            body.chars().take(200).collect::<String>()
        ));
        dispatch_ui_event(
            &proxy,
            UiBusEvent::AuthResponse,
            json!({
                "requestId": request_id,
                "ok": false,
                "error": if body.trim().is_empty() {
                    format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or("Error"))
                } else {
                    body
                },
            }),
        );
        return;
    }

    let response_body = match response.json::<Value>().await {
        Ok(value) => value,
        Err(error) => {
            trace(format!(
                "AUTH_REQUEST decode_error url={} err={}",
                url, error
            ));
            dispatch_ui_event(
                &proxy,
                UiBusEvent::AuthResponse,
                json!({
                    "requestId": request_id,
                    "ok": false,
                    "error": "Не удалось войти",
                }),
            );
            return;
        }
    };

    let token = response_body
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let username_value = response_body
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if token.is_empty() {
        trace(format!("AUTH_REQUEST empty_token url={}", url));
        dispatch_ui_event(
            &proxy,
            UiBusEvent::AuthResponse,
            json!({
                "requestId": request_id,
                "ok": false,
                "error": "Не удалось войти",
            }),
        );
        return;
    }

    trace(format!(
        "AUTH_REQUEST success url={} username={} token_set=true",
        url, username_value
    ));
    dispatch_ui_event(
        &proxy,
        UiBusEvent::AuthResponse,
        json!({
            "requestId": request_id,
            "ok": true,
            "data": {
                "username": if username_value.is_empty() { Value::String(String::new()) } else { Value::String(username_value) },
                "token": token,
                "cloudVaultSyncEnabled": response_body
                    .get("cloudVaultSyncEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            },
        }),
    );
}

async fn perform_api_request(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    method: String,
    path: String,
    headers: Value,
    body: String,
    include_device_id: bool,
) -> Result<Value, String> {
    let method = reqwest::Method::from_bytes(method.trim().as_bytes())
        .map_err(|_| "Некорректный HTTP method".to_string())?;
    let path = path.trim();
    if path.is_empty() || !path.starts_with("/api/") {
        return Err("Некорректный API path".to_string());
    }
    if path.contains("..")
        || path.contains("%2F")
        || path.contains("%2f")
        || path.contains("%5C")
        || path.contains("%5c")
    {
        return Err("Некорректный API path".to_string());
    }
    let url = join_api_url(&api_base_url, path);
    let client = api_http_client();
    let mut request = client.request(method, &url);

    if let Some(token) = auth_token.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if include_device_id && !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }
    if let Some(content_type) = headers
        .get("Content-Type")
        .or_else(|| headers.get("content-type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    if !body.is_empty() {
        request = request.body(body);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let mut response_headers = serde_json::Map::new();
    for (name, value) in response.headers().iter() {
        if let Ok(text) = value.to_str() {
            response_headers.insert(name.as_str().to_string(), Value::String(text.to_string()));
        }
    }
    let body = response.text().await.unwrap_or_default();
    Ok(json!({
        "status": status.as_u16(),
        "ok": status.is_success(),
        "headers": response_headers,
        "body": body,
    }))
}

async fn perform_contacts_request(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    username: String,
    add: bool,
) -> Result<Vec<String>, String> {
    let client = api_http_client();
    let url = if add {
        join_api_url(&api_base_url, "/api/contacts")
    } else {
        let mut parsed = reqwest::Url::parse(&join_api_url(&api_base_url, "/api/contacts"))
            .map_err(|error| error.to_string())?;
        parsed
            .path_segments_mut()
            .map_err(|_| "Invalid contacts URL".to_string())?
            .push(&username);
        parsed.to_string()
    };

    let request = if add {
        client.post(&url).json(&json!({ "username": username }))
    } else {
        client.delete(&url)
    };

    let mut request = request;
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!(
                "{} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Error")
            )
        } else {
            body
        });
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let contacts = payload
        .get("contacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(|value| value.to_string()))
        .collect::<Vec<String>>();
    Ok(contacts)
}

async fn perform_avatar_request(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    mode: String,
    data_url: Option<String>,
    mime_type: Option<String>,
    filename: Option<String>,
) -> Result<(), String> {
    let client = api_http_client();
    let url = join_api_url(&api_base_url, "/api/avatar");
    let mut request = if mode.eq_ignore_ascii_case("delete") {
        client.delete(&url)
    } else {
        let data_url = data_url.unwrap_or_default();
        let (bytes, decoded_mime, fallback_ext) =
            decode_data_url(&data_url).ok_or_else(|| "Invalid avatar data URL".to_string())?;
        let requested_mime = mime_type.unwrap_or(decoded_mime).trim().to_string();
        let part = multipart::Part::bytes(bytes)
            .file_name(sanitize_file_name(
                filename.as_deref().unwrap_or("avatar.png"),
                &fallback_ext,
            ))
            .mime_str(&requested_mime)
            .map_err(|error| error.to_string())?;
        let form = multipart::Form::new().part("file", part);
        client.post(&url).multipart(form)
    };

    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() && response.status().as_u16() != 204 {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!(
                "{} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Error")
            )
        } else {
            body
        });
    }

    Ok(())
}

async fn perform_avatar_fetch(
    api_base_url: String,
    auth_token: Option<String>,
    username: String,
) -> Result<Value, String> {
    let client = api_http_client();
    let url = {
        let mut u = reqwest::Url::parse(&format!(
            "{}/api/avatar/",
            api_base_url.trim_end_matches('/')
        ))
        .map_err(|e| e.to_string())?;
        u.path_segments_mut()
            .map_err(|_| "cannot-be-base".to_string())?
            .push(&username);
        u.to_string()
    };
    let mut request = client.get(&url);

    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!(
                "{} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Error")
            )
        } else {
            body
        });
    }

    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .trim()
        .to_string();
    if response.content_length().unwrap_or(0) > MAX_AVATAR_BYTES {
        return Err("Avatar response is too large".to_string());
    }
    let mut buf = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
        if buf.len() as u64 > MAX_AVATAR_BYTES {
            return Err("Avatar too large".to_string());
        }
    }
    if buf.is_empty() {
        return Err("Empty avatar response".to_string());
    }

    let data_url = format!("data:{};base64,{}", mime_type, BASE64_STANDARD.encode(buf));
    Ok(json!({
        "username": username,
        "mimeType": mime_type,
        "dataUrl": data_url,
    }))
}

async fn perform_reaction_request(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    message_id: String,
    emoji: String,
) -> Result<Value, String> {
    let client = api_http_client();
    let url = join_api_url(
        &api_base_url,
        &format!("/api/message/{}/reaction", message_id),
    );
    let mut request = client.post(&url).json(&json!({
        "emoji": emoji,
    }));

    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!(
                "{} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Error")
            )
        } else {
            body
        });
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())
}

async fn resolve_tenor_url(url: String, request_id: String, proxy: EventLoopProxy<AppEvent>) {
    let source_url = url.trim().to_string();
    if source_url.is_empty() {
        return;
    }

    let parsed = match reqwest::Url::parse(&source_url) {
        Ok(u) => u,
        Err(_) => return,
    };
    if parsed.scheme() != "https" {
        return;
    }
    let host = parsed.host_str().unwrap_or("");
    let allowed = ["tenor.com", "media.tenor.com", "c.tenor.com"];
    if !allowed
        .iter()
        .any(|&h| host == h || host.ends_with(&format!(".{}", h)))
    {
        return;
    }

    let client = http_client();
    let response = match client
        .get(&source_url)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            trace(format!(
                "resolve_tenor fetch_error url={} err={}",
                source_url, error
            ));
            dispatch_ui_event(
                &proxy,
                UiBusEvent::TenorResolved,
                json!({
                    "requestId": request_id,
                    "sourceUrl": source_url,
                }),
            );
            return;
        }
    };

    let html = match response.text().await {
        Ok(text) => text,
        Err(error) => {
            trace(format!(
                "resolve_tenor text_error url={} err={}",
                source_url, error
            ));
            dispatch_ui_event(
                &proxy,
                UiBusEvent::TenorResolved,
                json!({
                    "requestId": request_id,
                    "sourceUrl": source_url,
                }),
            );
            return;
        }
    };

    let candidates = [
        "property=\"og:video\"",
        "property='og:video'",
        "property=\"og:image\"",
        "property='og:image'",
        "name=\"twitter:image\"",
        "name='twitter:image'",
        "name=\"twitter:player:stream\"",
        "name='twitter:player:stream'",
    ];

    let media_url = candidates
        .iter()
        .find_map(|marker| extract_meta_content(&html, marker));
    let (mime_type, kind) = media_url
        .as_deref()
        .map(infer_mime_and_kind)
        .unwrap_or_else(|| ("".to_string(), "".to_string()));

    dispatch_ui_event(
        &proxy,
        UiBusEvent::TenorResolved,
        json!({
            "requestId": request_id,
            "sourceUrl": source_url,
            "mediaUrl": media_url,
            "mimeType": if mime_type.is_empty() { Value::Null } else { Value::String(mime_type) },
            "kind": if kind.is_empty() { Value::Null } else { Value::String(kind) },
        }),
    );
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
                    api_base_url,
                    auth_token,
                    device_id,
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
                    message_bridge.configure(
                        guard.ws_base_url.clone(),
                        guard.api_base_url(),
                        guard.auth_token.clone(),
                        guard.current_key.clone(),
                        guard.conversation_keys.clone(),
                        guard.current_username.clone(),
                        guard.current_device_id.clone(),
                    );
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
                    message_bridge.configure(
                        guard.ws_base_url.clone(),
                        guard.api_base_url(),
                        guard.auth_token.clone(),
                        guard.current_key.clone(),
                        guard.conversation_keys.clone(),
                        guard.current_username.clone(),
                        guard.current_device_id.clone(),
                    );
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
                message_bridge.configure(
                    guard.ws_base_url.clone(),
                    guard.api_base_url(),
                    guard.auth_token.clone(),
                    guard.current_key.clone(),
                    guard.conversation_keys.clone(),
                    guard.current_username.clone(),
                    guard.current_device_id.clone(),
                );
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
                    dispatch_ui_event(
                        &proxy_for_lists,
                        UiBusEvent::SetConnectionStatus,
                        Value::Bool(true),
                    );
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
                    message_bridge.configure(
                        guard.ws_base_url.clone(),
                        guard.api_base_url(),
                        guard.auth_token.clone(),
                        guard.current_key.clone(),
                        guard.conversation_keys.clone(),
                        guard.current_username.clone(),
                        guard.current_device_id.clone(),
                    );
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
                if is_direct_message_key(&snapshot.3) {
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
                message_bridge.configure(
                    guard.ws_base_url.clone(),
                    guard.api_base_url(),
                    guard.auth_token.clone(),
                    guard.current_key.clone(),
                    guard.conversation_keys.clone(),
                    guard.current_username.clone(),
                    guard.current_device_id.clone(),
                );
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
                    snapshot.0,
                    snapshot.1,
                    snapshot.4,
                    sender.clone(),
                    receiver,
                    client_id.clone(),
                    archive_path.clone(),
                    server_id,
                    channel_id,
                    key_version,
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
            // Notifications are macOS-only; no-op on Windows.
        }
    }
}
