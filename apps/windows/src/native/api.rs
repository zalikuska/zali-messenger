//! HTTP API calls: auth, generic API requests, contacts, avatars,
//! reactions, and Tenor URL resolution.

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use reqwest::multipart;
use serde_json::{json, Value};
use std::collections::HashMap;
use tao::event_loop::EventLoopProxy;

use futures_util::StreamExt;

use crate::native::{
    api_http_client, auth_http_client, decode_data_url, dispatch_ui_event, extract_meta_content,
    http_client, infer_mime_and_kind, join_api_url, new_request_id, sanitize_file_name, trace,
    AppEvent, UiBusEvent, MAX_AVATAR_BYTES,
};

pub(crate) async fn fetch_users(
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

pub(crate) async fn fetch_contacts(
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

#[cfg(test)]
mod fetch_tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetch_users_returns_parsed_list_on_success() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/users"))
            .respond_with(ResponseTemplate::new(200).set_body_json(vec!["alice", "bob"]))
            .mount(&server)
            .await;

        let users = fetch_users(server.uri(), Some("token".to_string()), "me".to_string()).await;
        assert_eq!(users, vec!["alice".to_string(), "bob".to_string()]);
    }

    #[tokio::test]
    async fn fetch_users_falls_back_on_http_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/users"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let users = fetch_users(server.uri(), None, "me".to_string()).await;
        assert_eq!(
            users,
            vec!["Alice".to_string(), "Bob".to_string(), "me".to_string()]
        );
    }

    #[tokio::test]
    async fn fetch_users_falls_back_on_malformed_json() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/users"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;

        let users = fetch_users(server.uri(), None, "me".to_string()).await;
        assert_eq!(
            users,
            vec!["Alice".to_string(), "Bob".to_string(), "me".to_string()]
        );
    }

    #[tokio::test]
    async fn fetch_contacts_returns_contacts_on_success() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/contacts"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "contacts": ["carol", "dave"] })),
            )
            .mount(&server)
            .await;

        let contacts = fetch_contacts(server.uri(), Some("token".to_string()))
            .await
            .unwrap();
        assert_eq!(contacts, vec!["carol".to_string(), "dave".to_string()]);
    }

    #[tokio::test]
    async fn fetch_contacts_errs_on_http_failure() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/contacts"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let result = fetch_contacts(server.uri(), None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn perform_api_request_rejects_bad_paths_without_hitting_the_network() {
        // These are validated before any request is sent, so an unreachable
        // base URL proves the rejection happens locally.
        let unreachable = "http://127.0.0.1:1".to_string();
        let base = ApiSession {
            api_base_url: unreachable.clone(),
            auth_token: None,
            device_id: String::new(),
        };

        let traversal = perform_api_request(
            base.clone(),
            "GET".to_string(),
            "/api/../secret".to_string(),
            Value::Null,
            String::new(),
            false,
        )
        .await;
        assert!(traversal.is_err());

        let wrong_prefix = perform_api_request(
            base,
            "GET".to_string(),
            "/not-api/x".to_string(),
            Value::Null,
            String::new(),
            false,
        )
        .await;
        assert!(wrong_prefix.is_err());
    }

    #[tokio::test]
    async fn perform_api_request_returns_status_and_body_on_success() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/ping"))
            .respond_with(ResponseTemplate::new(200).set_body_string("pong"))
            .mount(&server)
            .await;

        let result = perform_api_request(
            ApiSession {
                api_base_url: server.uri(),
                auth_token: None,
                device_id: String::new(),
            },
            "GET".to_string(),
            "/api/ping".to_string(),
            Value::Null,
            String::new(),
            false,
        )
        .await
        .unwrap();

        assert_eq!(result["status"], 200);
        assert_eq!(result["ok"], true);
        assert_eq!(result["body"], "pong");
    }

    #[tokio::test]
    async fn perform_api_request_generates_a_request_id_when_caller_supplies_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/ping"))
            .and(wiremock::matchers::header_exists("X-Request-ID"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let result = perform_api_request(
            ApiSession {
                api_base_url: server.uri(),
                auth_token: None,
                device_id: String::new(),
            },
            "GET".to_string(),
            "/api/ping".to_string(),
            Value::Null,
            String::new(),
            false,
        )
        .await
        .unwrap();

        // Every request must carry a request id, even when nobody asked for one —
        // it's the ID that gets echoed back in the response and shown in trace().
        assert!(!result["httpRequestId"].as_str().unwrap().is_empty());
    }

    #[tokio::test]
    async fn perform_api_request_forwards_caller_supplied_request_id_verbatim() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/ping"))
            .and(wiremock::matchers::header(
                "X-Request-ID",
                "caller-chosen-id",
            ))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let result = perform_api_request(
            ApiSession {
                api_base_url: server.uri(),
                auth_token: None,
                device_id: String::new(),
            },
            "GET".to_string(),
            "/api/ping".to_string(),
            serde_json::json!({ "X-Request-ID": "caller-chosen-id" }),
            String::new(),
            false,
        )
        .await
        .unwrap();

        // The wiremock header() matcher above already proves the server received
        // it verbatim; this proves perform_api_request also reports the same ID
        // back to the caller rather than silently minting a different one.
        assert_eq!(result["httpRequestId"], "caller-chosen-id");
    }

    #[tokio::test]
    async fn perform_api_request_never_duplicates_the_authorization_header() {
        // Regression test: apiFetch (web/src/interface.js) puts Authorization into
        // the same `headers` JSON blob that also gets forwarded generically here.
        // perform_api_request must not send it twice (once via bearer_auth, once
        // via the generic forward loop) — a real HTTP server (nginx in front of
        // production) rejected such requests outright with a bare 400, breaking
        // every authenticated call.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/ping"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        perform_api_request(
            ApiSession {
                api_base_url: server.uri(),
                auth_token: Some("real-token".to_string()),
                device_id: String::new(),
            },
            "GET".to_string(),
            "/api/ping".to_string(),
            // Mirrors what apiHeaders() actually sends: Authorization already
            // present in the JSON blob alongside the request-id.
            serde_json::json!({
                "Authorization": "Bearer stale-token-from-js",
                "X-Request-ID": "dup-header-check",
            }),
            String::new(),
            false,
        )
        .await
        .unwrap();

        let received = server.received_requests().await.unwrap();
        assert_eq!(received.len(), 1);
        let auth_values: Vec<_> = received[0]
            .headers
            .get_all("authorization")
            .iter()
            .collect();
        assert_eq!(
            auth_values.len(),
            1,
            "expected exactly one Authorization header, got {:?}",
            auth_values
        );
        assert_eq!(auth_values[0], "Bearer real-token");
    }
}

pub(crate) async fn perform_auth_request(
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
    let http_request_id = new_request_id();

    trace(format!(
        "AUTH_REQUEST start http_request_id={} url={} mode={}",
        http_request_id, url, mode
    ));

    let mut response = match client
        .post(&url)
        .header("X-Request-ID", &http_request_id)
        .json(&payload)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            trace(format!(
                "AUTH_REQUEST transport_error http_request_id={} url={} err={}",
                http_request_id, url, error
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
            "AUTH_REQUEST register_conflict http_request_id={} url={} retry=login",
            http_request_id, url
        ));
        let login_url = join_api_url(&api_base_url, "/api/auth/login");
        response = match client
            .post(&login_url)
            .header("X-Request-ID", &http_request_id)
            .json(&payload)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                trace(format!(
                    "AUTH_REQUEST retry_transport_error http_request_id={} url={} err={}",
                    http_request_id, login_url, error
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
            "AUTH_REQUEST http_fail http_request_id={} url={} status={} body={}",
            http_request_id,
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
                "AUTH_REQUEST decode_error http_request_id={} url={} err={}",
                http_request_id, url, error
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

/// Auth/routing context shared by every authenticated API call:
/// base URL, bearer token and the sending device's identity.
#[derive(Clone)]
pub(crate) struct ApiSession {
    pub api_base_url: String,
    pub auth_token: Option<String>,
    pub device_id: String,
}

pub(crate) async fn perform_api_request(
    session: ApiSession,
    method: String,
    path: String,
    headers: Value,
    body: String,
    include_device_id: bool,
) -> Result<Value, String> {
    let ApiSession {
        api_base_url,
        auth_token,
        device_id,
    } = session;
    let method = reqwest::Method::from_bytes(method.trim().as_bytes())
        .map_err(|_| "Некорректный HTTP method".to_string())?;
    let method_display = method.as_str().to_string();
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
    // Forward every header the caller set, not just Content-Type — this is what
    // lets the request-id apiFetch (web/src/interface.js) generates for
    // correlation actually reach the server instead of being silently dropped.
    // Skip names already set explicitly above: apiHeaders() on the JS side puts
    // Authorization/X-Zali-Device-ID into this same object, and forwarding them
    // again here produced a request with the header set twice — which nginx
    // rejected outright with a generic 400 before it ever reached the app,
    // breaking every single authenticated API call.
    if let Some(header_map) = headers.as_object() {
        for (name, value) in header_map {
            if name.eq_ignore_ascii_case("authorization")
                || name.eq_ignore_ascii_case("x-zali-device-id")
            {
                continue;
            }
            if let Some(value_str) = value.as_str().map(str::trim).filter(|v| !v.is_empty()) {
                if let (Ok(header_name), Ok(header_value)) = (
                    reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                    reqwest::header::HeaderValue::from_str(value_str),
                ) {
                    request = request.header(header_name, header_value);
                }
            }
        }
    }
    let caller_supplied_request_id = headers
        .get("X-Request-ID")
        .or_else(|| headers.get("x-request-id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let http_request_id = caller_supplied_request_id
        .clone()
        .unwrap_or_else(new_request_id);
    if caller_supplied_request_id.is_none() {
        request = request.header("X-Request-ID", &http_request_id);
    }
    if !body.is_empty() {
        request = request.body(body);
    }

    trace(format!(
        "perform_api_request start http_request_id={} method={} path={}",
        http_request_id, method_display, path
    ));

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            trace(format!(
                "perform_api_request transport_error http_request_id={} method={} path={} err={}",
                http_request_id, method_display, path, error
            ));
            return Err(error.to_string());
        }
    };
    let status = response.status();
    trace(format!(
        "perform_api_request done http_request_id={} method={} path={} status={}",
        http_request_id,
        method_display,
        path,
        status.as_u16()
    ));
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
        "httpRequestId": http_request_id,
    }))
}

pub(crate) async fn perform_contacts_request(
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

pub(crate) async fn perform_avatar_request(
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

pub(crate) async fn perform_avatar_fetch(
    api_base_url: String,
    auth_token: Option<String>,
    username: String,
) -> Result<Value, String> {
    let client = api_http_client();
    let url = {
        // No trailing slash before path_segments_mut() — see fetch_messages_page's
        // comment; this was a pre-existing instance of the same double-slash/404 bug.
        let mut u = reqwest::Url::parse(&format!(
            "{}/api/avatar",
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

pub(crate) async fn perform_reaction_request(
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

pub(crate) async fn resolve_tenor_url(
    url: String,
    request_id: String,
    proxy: EventLoopProxy<AppEvent>,
) {
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
