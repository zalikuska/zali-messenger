//! Message pipeline: pack/upload/download, history pagination and refresh,
//! and the Core FFI dispatch used for crypto operations.

use reqwest::multipart;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::CString;
use std::path::{Path, PathBuf};
use tao::event_loop::EventLoopProxy;
use tokio_util::codec::{BytesCodec, FramedRead};
use uuid::Uuid;

use futures_util::{stream, StreamExt};
use zali_messenger_core::{zali_bus_dispatch, zali_bus_free_string};

use crate::native::{
    cache_decrypted_message, cached_decrypted_message, candidate_message_keys, dispatch_ui_event,
    http_client, json_string_literal, new_request_id, retry_with_backoff, sanitize_file_name,
    trace, ApiSession, AppEvent, UiBusEvent, UploadError,
};

pub(crate) fn dispatch_core_command(address_command: &str, args: Value) -> Result<Value, String> {
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

pub(crate) fn pack_message(
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

/// Metadata for a packed .zali archive being uploaded via /api/upload.
pub(crate) struct OutgoingMessage {
    pub sender: String,
    pub receiver: String,
    pub client_id: String,
    pub archive_path: PathBuf,
    pub server_id: Option<String>,
    pub channel_id: Option<String>,
    pub key_version: u8,
}

pub(crate) async fn upload_message(
    session: ApiSession,
    message: OutgoingMessage,
) -> Result<Option<String>, UploadError> {
    let ApiSession {
        api_base_url,
        auth_token,
        device_id,
    } = session;
    let OutgoingMessage {
        sender,
        receiver,
        client_id,
        archive_path: file_url,
        server_id,
        channel_id,
        key_version,
    } = message;
    let client_id_for_trace = client_id.clone();
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

    let http_request_id = new_request_id();
    let mut request = client
        .post(url)
        .header("X-Request-ID", &http_request_id)
        .multipart(form);
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    trace(format!(
        "upload_message start http_request_id={} client_id={}",
        http_request_id, client_id_for_trace
    ));

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            trace(format!(
                "upload_message transport_error http_request_id={} client_id={} err={}",
                http_request_id, client_id_for_trace, error
            ));
            return Err(UploadError::from_reqwest(error));
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        trace(format!(
            "upload_message http_fail http_request_id={} client_id={} status={}",
            http_request_id,
            client_id_for_trace,
            status.as_u16()
        ));
        return Err(UploadError::http(status.as_u16(), body));
    }

    let message_id = match response.json::<Value>().await {
        Ok(json) => json
            .get("id")
            .and_then(Value::as_str)
            .map(|s| s.to_string()),
        Err(_) => None,
    };

    trace(format!(
        "upload_message done http_request_id={} client_id={} message_id={:?}",
        http_request_id, client_id_for_trace, message_id
    ));

    Ok(message_id)
}

pub(crate) async fn fetch_messages_page(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    username: String,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>, String> {
    // No trailing slash before path_segments_mut().push(): a trailing "/" makes the
    // parsed URL end in an implicit empty path segment, and push() appends AFTER it
    // rather than replacing it — "/api/messages/" + push("alice") produced
    // "/api/messages//alice" (double slash), a 404 on every single call. This made
    // fetch_messages_page (and everything built on it: fetch_messages,
    // refresh_direct_history, i.e. ALL DM history catch-up on this shell) fail
    // unconditionally — confirmed live 2026-07-04, every call logged
    // "fetch_messages_page http_fail ... status=404 Not Found". Real-time delivery
    // via the message WebSocket doesn't use this endpoint, which is why messages
    // sent while both sides were online kept working and masked this bug.
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/messages",
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

pub(crate) async fn fetch_messages(
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

pub(crate) async fn fetch_server_messages_page(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    server_id: String,
    channel_id: String,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>, String> {
    // No trailing slash before path_segments_mut() — see fetch_messages_page's comment:
    // a trailing "/" leaves an implicit empty path segment that push() appends AFTER,
    // producing a double slash (".../servers//id/...") and a 404 on every call.
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/servers",
        api_base_url.trim_end_matches('/')
    ))
    .map_err(|e| e.to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "cannot-be-base".to_string())?;
        segments
            .push(&server_id)
            .push("channels")
            .push(&channel_id)
            .push("messages");
    }
    url.set_query(Some(&format!("limit={}&offset={}", limit, offset)));
    let url = url.to_string();
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

pub(crate) async fn fetch_server_messages(
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

pub(crate) async fn download_message(
    api_base_url: String,
    auth_token: Option<String>,
    device_id: String,
    message_id: String,
) -> Result<PathBuf, String> {
    // No trailing slash before path_segments_mut() — see fetch_messages_page's comment.
    // This one is a regression from earlier today's path_segments_mut() conversion
    // (fixing a path-injection issue): the original raw format!() string this replaced
    // never had this bug since it built "/api/download/{id}" directly with a single
    // slash. Confirmed broken exactly like fetch_messages_page: same trailing-slash
    // pattern, same double-slash-then-404 result.
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/download",
        api_base_url.trim_end_matches('/')
    ))
    .map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "cannot-be-base".to_string())?
        .push(&message_id);
    let url = url.to_string();
    let client = http_client();
    let http_request_id = new_request_id();
    let mut request = client.get(url).header("X-Request-ID", &http_request_id);
    if let Some(token) = auth_token.clone().filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(token);
    }
    if !device_id.trim().is_empty() {
        request = request.header("X-Zali-Device-ID", device_id);
    }

    trace(format!(
        "download_message start http_request_id={} id={}",
        http_request_id, message_id
    ));

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            trace(format!(
                "download_message transport_error http_request_id={} id={} err={}",
                http_request_id, message_id, error
            ));
            return Err(error.to_string());
        }
    };
    if !response.status().is_success() {
        trace(format!(
            "download_message http_fail http_request_id={} id={} status={}",
            http_request_id,
            message_id,
            response.status()
        ));
        return Err(format!("Download failed with status {}", response.status()));
    }

    let temp_dir = std::env::temp_dir().join("zali-messenger");
    let _ = tokio::fs::create_dir_all(&temp_dir).await;
    let safe_message_id = sanitize_file_name(&message_id, "zali");
    // Unique per download (mirrors macOS's `{id}-{UUID}.zali`): a live WS push racing a
    // history-reload/catch-up refresh of the same message id used to clobber a shared
    // fixed-name file mid-write, producing a spurious decrypt failure for a fine message.
    let file_path = temp_dir.join(format!("{}-{}.zali", safe_message_id, Uuid::new_v4()));
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
    trace(format!(
        "download_message done http_request_id={} id={} bytes={}",
        http_request_id, message_id, total_written
    ));
    Ok(file_path)
}

pub(crate) fn build_history_output(
    message_id: &str,
    record: &Value,
    decrypted: &Value,
    server_id: Option<String>,
    channel_id: Option<String>,
) -> Value {
    let record_sender = record.get("sender").and_then(Value::as_str).unwrap_or("");
    let sender = decrypted
        .get("sender")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(record_sender);
    let text = decrypted.get("text").and_then(Value::as_str).unwrap_or("");
    let attachments = decrypted
        .get("attachments")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let server_id_value = server_id
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
    output
}

pub(crate) async fn process_history_record(
    session: ApiSession,
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

    // Already decrypted once — skip the download and the PBKDF2 work entirely.
    if let Some(cached) = cached_decrypted_message(&message_id) {
        return Some(build_history_output(
            &message_id,
            &record,
            &cached,
            server_id,
            channel_id,
        ));
    }

    let file_url = match retry_with_backoff(
        &format!("{}_download_message id={}", context_label, message_id),
        3,
        || {
            let session = session.clone();
            let message_id = message_id.clone();
            async move {
                download_message(
                    session.api_base_url,
                    session.auth_token,
                    session.device_id,
                    message_id,
                )
                .await
            }
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
        // Single attempt per candidate key: decryption is deterministic, so a wrong
        // key fails identically every time. This used to run through
        // retry_with_backoff(3), which re-derived PBKDF2 (210k iterations) three
        // times and slept 250+500ms between attempts — per wrong key, per message.
        let unpack_attempt = (|| {
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
                    if let Some(error) = data.get("decryptionError").and_then(Value::as_str) {
                        if !error.trim().is_empty() {
                            return Err(error.to_string());
                        }
                    }
                    Ok(data)
                })
        })();

        match unpack_attempt {
            Ok(value) => {
                unpacked = Some(value);
                break;
            }
            Err(error) => {
                trace(format!(
                    "{}_unpack_message id={} err={}",
                    context_label, message_id, error
                ));
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

    let decrypted = json!({
        "sender": unpacked.get("sender").cloned().unwrap_or(Value::Null),
        "text": unpacked.get("text").cloned().unwrap_or(Value::Null),
        "attachments": unpacked.get("attachments").cloned().unwrap_or_else(|| json!([])),
    });
    cache_decrypted_message(&message_id, &decrypted);

    Some(build_history_output(
        &message_id,
        &record,
        &decrypted,
        server_id,
        channel_id,
    ))
}

pub(crate) async fn refresh_direct_history(
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
    let session = ApiSession {
        api_base_url,
        auth_token,
        device_id,
    };
    let rendered = stream::iter(records.into_iter().map(|record| {
        let session = session.clone();
        let keys = candidate_message_keys(&key, &HashMap::new(), "", &record, None, None);
        async move {
            process_history_record(session, keys, record, "refresh_direct_history", None, None)
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

pub(crate) async fn refresh_server_history(
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
    let session = ApiSession {
        api_base_url,
        auth_token,
        device_id,
    };
    let rendered = stream::iter(records.into_iter().map(|record| {
        let session = session.clone();
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
                session,
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

#[cfg(test)]
mod download_tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn download_message_streams_body_to_a_file() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/download/msg-123"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"encrypted-archive-bytes".to_vec()),
            )
            .mount(&server)
            .await;

        let path = download_message(
            server.uri(),
            Some("token".to_string()),
            "device-1".to_string(),
            "msg-123".to_string(),
        )
        .await
        .unwrap();

        let content = tokio::fs::read(&path).await.unwrap();
        assert_eq!(content, b"encrypted-archive-bytes");
        tokio::fs::remove_file(&path).await.ok();
    }

    #[tokio::test]
    async fn download_message_errs_on_http_failure() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/download/missing"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let result =
            download_message(server.uri(), None, String::new(), "missing".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn download_message_sends_a_request_id_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/download/msg-1"))
            .and(wiremock::matchers::header_exists("X-Request-ID"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"x".to_vec()))
            .mount(&server)
            .await;

        let path = download_message(server.uri(), None, String::new(), "msg-1".to_string())
            .await
            .unwrap();
        tokio::fs::remove_file(&path).await.ok();
    }

    #[tokio::test]
    async fn upload_message_sends_a_request_id_header() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/upload"))
            .and(wiremock::matchers::header_exists("X-Request-ID"))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "msg-9" })),
            )
            .mount(&server)
            .await;

        let archive_path =
            std::env::temp_dir().join(format!("zali-win-upload-test-{}.zali", std::process::id()));
        tokio::fs::write(&archive_path, b"ZALIMSSGfake-archive-bytes")
            .await
            .unwrap();

        let result = upload_message(
            ApiSession {
                api_base_url: server.uri(),
                auth_token: None,
                device_id: String::new(),
            },
            OutgoingMessage {
                sender: "alice".to_string(),
                receiver: "bob".to_string(),
                client_id: "client-1".to_string(),
                archive_path: archive_path.clone(),
                server_id: None,
                channel_id: None,
                key_version: 2,
            },
        )
        .await
        .unwrap();

        assert_eq!(result, Some("msg-9".to_string()));
        tokio::fs::remove_file(&archive_path).await.ok();
    }
}
