//! WebSocket transports: voice signaling and message stream, including
//! reconnect loops, WS request builders, and incoming-message notifications.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::Duration;
use tao::event_loop::EventLoopProxy;
use tokio::sync::{mpsc, watch};

use futures_util::{Sink, SinkExt, StreamExt};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{HeaderValue, Request},
        Message,
    },
};

use crate::native::{
    candidate_message_keys, dispatch_ui_event, process_history_record, trace, ApiSession, AppEvent,
    MessageConfig, UiBusEvent, VoiceConfig,
};

pub(crate) fn websocket_request(
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

pub(crate) fn voice_request(ws_url: &str, auth_token: Option<&str>) -> Result<Request<()>, String> {
    websocket_request(ws_url, auth_token, None)
}

pub(crate) fn message_request(current: &MessageConfig) -> Result<Request<()>, String> {
    websocket_request(
        &current.ws_url,
        current.auth_token.as_deref(),
        Some(current.current_device_id.as_str()),
    )
}

pub(crate) async fn send_voice_payload(
    writer: &mut (impl Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    payload: &Value,
) -> Result<(), String> {
    let text = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    writer
        .send(Message::Text(text))
        .await
        .map_err(|e| e.to_string())
}

pub(crate) fn dispatch_voice_event(proxy: &EventLoopProxy<AppEvent>, payload: Value) {
    dispatch_ui_event(proxy, UiBusEvent::VoiceEvent, payload);
}

pub(crate) fn dispatch_voice_log(proxy: &EventLoopProxy<AppEvent>, level: &str, msg: String) {
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

pub(crate) fn notification_body(text: &str, attachment_count: usize) -> String {
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

pub(crate) fn show_message_notification(rendered: &Value, current_username: &str) {
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
    // serde serializes an Option::None serverId/channelId to `Value::Null` with the key
    // still present, so `.is_some()` on the key is always true — check for a non-null,
    // non-empty string value instead, matching macOS's `serverId==nil && channelId==nil`.
    let has_channel = rendered
        .get("serverId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        || rendered
            .get("channelId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
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

pub(crate) async fn run_voice_transport(
    mut config_rx: watch::Receiver<VoiceConfig>,
    mut outbound_rx: mpsc::UnboundedReceiver<Value>,
    proxy: EventLoopProxy<AppEvent>,
) {
    let mut pending = VecDeque::<Value>::new();
    let mut reconnect_delay_secs = 1u64;

    loop {
        let current = config_rx.borrow().clone();
        let has_token = current
            .auth_token
            .as_deref()
            .map(|token| !token.trim().is_empty())
            .unwrap_or(false);
        // Без токена сервер отвечает 401 на любой connect — простаиваем до логина
        // (иначе цикл реконнекта спамит "Voice reconnecting: 401" до входа),
        // как это уже делает run_message_transport.
        if current.ws_url.trim().is_empty() || !has_token {
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

        // Same rationale as run_message_transport's ping_interval: without an active
        // liveness probe, a voice socket that goes silently dark (sleep/wake, NAT/proxy
        // idle timeout) looks "connected" forever — reader.next() just never resolves —
        // so an incoming call's signaling never arrives and nothing here would notice or
        // reconnect. Mirrors the Swift client's scheduleVoiceHeartbeat (25s sendPing).
        let mut ping_interval = tokio::time::interval(Duration::from_secs(25));
        ping_interval.tick().await; // first tick fires immediately; consume it

        loop {
            tokio::select! {
                _ = ping_interval.tick() => {
                    if let Err(error) = writer.send(Message::Ping(Vec::new())).await {
                        trace(format!("voice ws ping failed err={}", error));
                        dispatch_voice_log(&proxy, "WARN", format!("Voice ping failed: {}", error));
                        break;
                    }
                    trace("voice ws ping ok");
                }
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

pub(crate) async fn handle_message_ws_payload(
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
                || value == "device_approved"
        })
        .unwrap_or(false)
    {
        let event_type = raw.get("type").and_then(Value::as_str).unwrap_or("");
        if event_type.starts_with("voice_") {
            // Voice signaling normally travels over the dedicated voice-only
            // WebSocket (run_voice_transport) — the server delivers voice_*
            // events to every active connection for this user, including this
            // message socket, so this used to just drop them here to avoid
            // double-dispatch. But the voice socket has its own independent
            // reconnect/heartbeat cycle; a hiccup there used to silently lose
            // call signaling (hangup, camera/screen-share toggles) with no
            // fallback, even though this socket was still alive and had the
            // same message. Forward it too now; the JS side dedupes by each
            // event's `vid` (see voiceEventPayload/isDuplicateVoiceEvent in
            // interface.js), so double-delivery is harmless.
            trace(format!(
                "message ws voice event fallback type={} roomId={}",
                event_type,
                raw.get("roomId").and_then(Value::as_str).unwrap_or("")
            ));
            dispatch_voice_event(&proxy, raw);
        } else if event_type == "key_envelope_available" {
            dispatch_ui_event(&proxy, UiBusEvent::RefreshAfterKey, serde_json::Value::Null);
        } else if event_type == "device_approved" {
            // Pushed when one of our peers approves a new device — republish our side
            // of any DM/channel keys we've already shared with them instead of waiting
            // for our own next login. Mirrors macOS NetworkService.swift's
            // onDeviceApproved -> WebView.swift's retryPublishKeys().
            dispatch_ui_event(&proxy, UiBusEvent::RetryPublishKeys, serde_json::Value::Null);
        } else if event_type == "reaction_updated" {
            dispatch_ui_event(&proxy, UiBusEvent::ReactionUpdated, raw);
        } else if event_type == "avatar_updated" || event_type == "avatar_deleted" {
            // Mirrors macOS onAvatarChanged (NetworkService.swift) -> avatarUpdated/avatarDeleted
            // (WebView.swift): both funnel into the same web bus event with a `deleted` flag,
            // so a contact's avatar change/removal reflects live instead of only on next reload.
            let username = raw
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !username.is_empty() {
                let deleted = raw
                    .get("deleted")
                    .and_then(Value::as_bool)
                    .unwrap_or(event_type == "avatar_deleted");
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::AvatarUpdated,
                    json!({ "username": username, "deleted": deleted }),
                );
            }
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

    // Captured before the move into process_history_record below — needed for the
    // decrypt-failure self-heal branch (sync_active_conversation).
    let sync_peer = {
        let sender = raw.get("sender").and_then(Value::as_str).unwrap_or("");
        let receiver = raw.get("receiver").and_then(Value::as_str).unwrap_or("");
        if sender.trim() == current.current_username.trim() {
            receiver.to_string()
        } else {
            sender.to_string()
        }
    };
    let sync_server_id = server_id.clone();
    let sync_channel_id = channel_id.clone();

    match process_history_record(
        ApiSession {
            api_base_url: current.api_base_url,
            auth_token: current.auth_token,
            device_id: current.current_device_id,
        },
        keys,
        raw,
        "message_ws",
        server_id,
        channel_id,
    )
    .await
    {
        Some(rendered)
            if rendered
                .get("decryptionError")
                .and_then(Value::as_str)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false) =>
        {
            // process_history_record returns a rendered placeholder (not None) when every
            // candidate key failed to unpack the archive — e.g. the key envelope for a brand
            // new conversation hasn't synced to this device yet. Rendering that placeholder
            // here would permanently show "нет E2E-ключа" even after the key arrives seconds
            // later, because unlike the None branch below, this arm used to skip the self-heal
            // dispatch entirely. Treat it the same as a hard unpack failure: don't render, and
            // trigger the targeted re-resolve so history reload picks it up once the key syncs.
            trace(format!(
                "{} skipped render for message_id={} reason=unpack_or_decrypt_failed",
                "message_ws", message_id
            ));
            if !sync_peer.trim().is_empty() {
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::SyncActiveConversation,
                    json!({
                        "force": true,
                        "peer": sync_peer,
                        "serverId": sync_server_id.clone().unwrap_or_default(),
                        "channelId": sync_channel_id.clone().unwrap_or_default(),
                    }),
                );
            }
        }
        Some(rendered) => {
            // Notification decision (self-sender filter, "is this chat already open"
            // guard) now lives in JS's receiveMessage() → SHOW_NOTIFICATION bridge
            // message, matching macOS — Rust has no visibility into which chat is
            // currently open in the WebView2 UI, so it can't apply that guard itself.
            dispatch_ui_event(&proxy, UiBusEvent::ReceiveMessage, rendered);
        }
        None => {
            trace(format!(
                "{} skipped render for message_id={} reason=unpack_or_decrypt_failed",
                "message_ws", message_id
            ));
            // Mirrors macOS onMessageDecryptFailed -> sync_active_conversation: a message
            // that arrived before its key envelope should trigger a targeted re-resolve for
            // that specific peer instead of waiting for a generic key_envelope_available frame
            // that may never come for this exact conversation.
            if !sync_peer.trim().is_empty() {
                dispatch_ui_event(
                    &proxy,
                    UiBusEvent::SyncActiveConversation,
                    json!({
                        "force": true,
                        "peer": sync_peer,
                        "serverId": sync_server_id.unwrap_or_default(),
                        "channelId": sync_channel_id.unwrap_or_default(),
                    }),
                );
            }
        }
    }
}

pub(crate) async fn run_message_transport(
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
            // No usable session (e.g. a stale/expired token with no auth_token) — surface
            // this as disconnected rather than leaving whatever status was last dispatched.
            // Previously the UI's "Подключено" badge was set to true unconditionally right
            // after SET_SESSION and never revisited, so it kept showing "connected" even
            // when this loop could never attempt a socket at all — no signal to the user
            // that live delivery was actually dead.
            dispatch_ui_event(&proxy, UiBusEvent::SetConnectionStatus, Value::Bool(false));
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
                dispatch_ui_event(&proxy, UiBusEvent::SetConnectionStatus, Value::Bool(false));
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

        let (mut writer, mut reader) = match connect_async(request).await {
            Ok((stream, response)) => {
                trace(format!("message ws connected status={}", response.status()));
                dispatch_ui_event(&proxy, UiBusEvent::SetConnectionStatus, Value::Bool(true));
                stream.split()
            }
            Err(error) => {
                trace(format!(
                    "message ws connect failed url={} err={}",
                    current.ws_url, error
                ));
                dispatch_ui_event(&proxy, UiBusEvent::SetConnectionStatus, Value::Bool(false));
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
        let mut current = current;
        // Active liveness probe. Without this the writer half of the socket was never
        // used at all — a connection that goes silently dark (sleep/wake, network
        // switch, NAT/proxy idle timeout — none of which necessarily produce a TCP
        // RST) looked "connected" forever: reader.next() just never resolves, so the
        // reconnect path was never reached. Confirmed live: a session sat with
        // active_conns=0 server-side for minutes with zero client-side reconnect
        // attempts logged. Mirrors the Swift client's 25s sendPing heartbeat.
        let mut ping_interval = tokio::time::interval(Duration::from_secs(25));
        ping_interval.tick().await; // first tick fires immediately; consume it
        loop {
            tokio::select! {
                _ = ping_interval.tick() => {
                    if let Err(error) = writer.send(Message::Ping(Vec::new())).await {
                        trace(format!("message ws ping failed err={}", error));
                        break;
                    }
                    trace("message ws ping ok");
                }
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    let next = config_rx.borrow().clone();
                    // Only ws_url/auth_token/current_device_id shape the actual connect
                    // request (see message_request()) — reconnecting on every change to
                    // current_key/conversation_keys was tearing down and re-establishing
                    // the socket on every single key-sync event during login (cloud vault
                    // import, envelope sync, republish each fire their own SET_KEY), which
                    // could churn several times per second and left the client effectively
                    // disconnected from live message delivery during that window.
                    let reconnect_needed = next.ws_url != current.ws_url
                        || next.auth_token != current.auth_token
                        || next.current_device_id != current.current_device_id;
                    if !reconnect_needed {
                        trace("message ws config changed (keys only); refreshing snapshot without reconnect");
                        current = next;
                        continue;
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
        // Every break above (config change requiring reconnect, server close, receive
        // error, stream end) lands here before the outer loop retries — one place to
        // flip the badge off instead of duplicating it at each break site.
        dispatch_ui_event(&proxy, UiBusEvent::SetConnectionStatus, Value::Bool(false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_body_prefers_message_text_truncated_to_180_chars() {
        assert_eq!(notification_body("hello there", 0), "hello there");

        let long_text = "x".repeat(250);
        let body = notification_body(&long_text, 0);
        assert_eq!(body.chars().count(), 180);
    }

    #[test]
    fn notification_body_falls_back_to_attachment_summary_when_text_is_empty() {
        assert_eq!(notification_body("", 0), "Новое сообщение");
        assert_eq!(notification_body("   ", 1), "Вложение");
        assert_eq!(notification_body("", 3), "Вложения: 3");
    }
}
