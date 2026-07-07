//! Shared reqwest clients (plain/API/auth), upload error type, and the
//! generic retry-with-backoff helper.

use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;


use crate::native::{
    trace,
};

pub(crate) fn http_client() -> &'static reqwest::Client {
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

#[derive(Debug, Clone)]
pub(crate) struct UploadError {
    pub(crate) message: String,
    pub(crate) status_code: Option<u16>,
    pub(crate) response_body: String,
    pub(crate) timeout: bool,
}

impl UploadError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: None,
            response_body: String::new(),
            timeout: false,
        }
    }

    pub(crate) fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: Some(400),
            response_body: String::new(),
            timeout: false,
        }
    }

    pub(crate) fn from_reqwest(error: reqwest::Error) -> Self {
        Self {
            message: error.to_string(),
            status_code: error.status().map(|status| status.as_u16()),
            response_body: String::new(),
            timeout: error.is_timeout(),
        }
    }

    pub(crate) fn http(status_code: u16, response_body: String) -> Self {
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

    pub(crate) fn to_ui_payload(&self, client_id: &str) -> Value {
        json!({
            "clientId": client_id,
            "statusCode": self.status_code.unwrap_or_default(),
            "responseBody": self.response_body,
            "error": self.message,
            "timeout": self.timeout,
        })
    }
}

pub(crate) fn api_http_client() -> &'static reqwest::Client {
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

pub(crate) fn auth_http_client() -> &'static reqwest::Client {
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

pub(crate) async fn retry_with_backoff<T, F, Fut>(label: &str, attempts: usize, mut op: F) -> Result<T, String>
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

// Merge the immutable decrypted payload ({sender, text, attachments}) with the
// volatile fields of the freshly fetched server record (reactions, timestamps, ids)
// into the shape window.loadHistory()/receiveMessage() expects.
