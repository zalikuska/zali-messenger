//! Shared harness for integration tests: spins a real `zali_server` instance
//! bound to an OS-assigned port, backed by an isolated per-test sqlite dir,
//! and drives it with a real HTTP client (and WS client, for realtime tests).
//! This exercises the exact same router/handlers production uses — no mocks.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct TestApp {
    pub addr: SocketAddr,
    pub http: reqwest::Client,
}

impl TestApp {
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }

    #[allow(dead_code)]
    pub fn ws_url(&self, path: &str) -> String {
        format!("ws://{}{}", self.addr, path)
    }
}

/// Boots a fresh, fully migrated server on `127.0.0.1:0` with its own
/// throwaway data directory, and returns a client pointed at it. Each call
/// is fully isolated from every other — safe to run in parallel.
pub async fn spawn_app() -> TestApp {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let data_dir: PathBuf =
        std::env::temp_dir().join(format!("zali-server-test-{}-{}", std::process::id(), n));

    let config = zali_server::Config::from_env();
    let state = zali_server::build_app_state(data_dir, config).await;
    let app = zali_server::build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test listener");
    let addr = listener.local_addr().expect("listener local_addr");

    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("test server crashed");
    });

    TestApp {
        addr,
        http: reqwest::Client::builder()
            .build()
            .expect("build reqwest client"),
    }
}

pub struct RegisteredUser {
    #[allow(dead_code)]
    pub username: String,
    pub token: String,
}

impl RegisteredUser {
    pub fn auth_header(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

/// Registers a brand-new user through the real `/api/auth/register` endpoint
/// and returns their JWT. Panics on failure — callers that want to assert on
/// registration failure should call the endpoint directly instead.
pub async fn register_user(app: &TestApp, username: &str, password: &str) -> RegisteredUser {
    let resp = app
        .http
        .post(app.url("/api/auth/register"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .expect("register request");
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.expect("register response json");
    assert_eq!(status, 201, "register({}) failed: {:?}", username, body);
    RegisteredUser {
        username: username.to_string(),
        token: body["token"].as_str().expect("token field").to_string(),
    }
}

/// Registers a device for `user` via `/api/devices` and returns the raw
/// JSON device response. The first device registered for an account is
/// auto-approved by the server.
#[allow(dead_code)]
pub async fn register_device(
    app: &TestApp,
    user: &RegisteredUser,
    device_id: &str,
) -> serde_json::Value {
    let resp = app
        .http
        .post(app.url("/api/devices"))
        .header("Authorization", user.auth_header())
        .json(&serde_json::json!({
            "deviceId": device_id,
            "label": "test device",
        }))
        .send()
        .await
        .expect("register_device request");
    assert!(
        resp.status().is_success(),
        "register_device({}) failed: {}",
        device_id,
        resp.status()
    );
    resp.json().await.expect("register_device response json")
}

/// A minimal valid `.zali` archive body: 8-byte magic header the server
/// checks for, plus padding so it isn't a suspiciously tiny upload.
#[allow(dead_code)]
pub fn fake_zali_bytes() -> Vec<u8> {
    let mut bytes = b"ZALIMSSG".to_vec();
    bytes.extend_from_slice(&[1u8; 32]);
    bytes
}
