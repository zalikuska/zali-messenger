//! Shared reqwest clients (plain/API/auth), upload error type, and the
//! generic retry-with-backoff helper.

use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

use crate::native::trace;

/// A fresh correlation ID for one outgoing HTTP request. Sent as
/// `X-Request-ID` and logged locally so a `trace()` line here can be matched
/// against the same ID in the server's access log by grep.
pub(crate) fn new_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

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

pub(crate) async fn retry_with_backoff<T, F, Fut>(
    label: &str,
    attempts: usize,
    mut op: F,
) -> Result<T, String>
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn retry_with_backoff_returns_first_success_without_retrying() {
        let calls = AtomicUsize::new(0);
        let result: Result<&str, String> = retry_with_backoff("test", 3, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok("done") }
        })
        .await;
        assert_eq!(result, Ok("done"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_with_backoff_retries_until_success() {
        let calls = AtomicUsize::new(0);
        let result: Result<&str, String> = retry_with_backoff("test", 3, || {
            let attempt = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                if attempt < 3 {
                    Err(format!("fail-{}", attempt))
                } else {
                    Ok("recovered")
                }
            }
        })
        .await;
        assert_eq!(result, Ok("recovered"));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn retry_with_backoff_exhausts_attempts_and_returns_last_error() {
        let calls = AtomicUsize::new(0);
        let result: Result<&str, String> = retry_with_backoff("test", 3, || {
            let attempt = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move { Err(format!("fail-{}", attempt)) }
        })
        .await;
        assert_eq!(result, Err("fail-3".to_string()));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn retry_with_backoff_treats_zero_attempts_as_one() {
        let calls = AtomicUsize::new(0);
        let _: Result<&str, String> = retry_with_backoff("test", 0, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err("nope".to_string()) }
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn upload_error_http_formats_message_with_and_without_body() {
        let with_body = UploadError::http(404, "  not found  ".to_string());
        assert_eq!(
            with_body.message,
            "Upload failed with status 404: not found"
        );
        assert_eq!(with_body.status_code, Some(404));
        assert_eq!(with_body.response_body, "not found");
        assert!(!with_body.timeout);

        let without_body = UploadError::http(500, "".to_string());
        assert_eq!(without_body.message, "Upload failed with status 500");
    }

    #[test]
    fn upload_error_permanent_defaults_to_status_400() {
        let error = UploadError::permanent("bad request");
        assert_eq!(error.status_code, Some(400));
        assert_eq!(error.message, "bad request");
    }

    #[test]
    fn upload_error_to_ui_payload_has_expected_shape() {
        let error = UploadError::http(413, "too large".to_string());
        let payload = error.to_ui_payload("client-123");
        assert_eq!(payload["clientId"], "client-123");
        assert_eq!(payload["statusCode"], 413);
        assert_eq!(payload["responseBody"], "too large");
        assert_eq!(payload["timeout"], false);
    }
}
