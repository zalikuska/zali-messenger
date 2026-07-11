# Zali Messenger — Android shell

Thin native Android client. Like the macOS/iOS/Windows clients, it wraps the
**shared web UI** (`Web/`, bundled by `bundle_web.py`) in a `WebView` and draws a
translucent bottom bar that mirrors the web Liquid Glass bar (green active pill).

> Android has no true Liquid Glass API. This bar approximates the look with a
> translucent dark "glass" fill; on Android 12+ you can attach a `RenderEffect`
> blur to the host view for a frostier result.

## How it fits the monorepo

- The web UI is canonical (`Web/src/interface.js` → `python3 bundle_web.py`).
- This shell owns: the WebView host, the native bottom bar (`MainActivity.kt`),
  a native API/WebSocket bridge (`NativeBridge.kt`) — mirrors the iOS shell's
  `WebViewStore` (`iOS/ZaliMessenger/WebView.swift`) protocol-for-protocol — and
  `ZaliCoreBridge.kt`, a JNI wrapper around the same Rust Core crate iOS/macOS
  link, for `.zali` message pack/unpack (encrypt/decrypt).

## Native bridge (`NativeBridge.kt`)

Registered as `window.ZaliAndroidBridge` via `WebView.addJavascriptInterface`;
`Web/src/bootstrap.js` auto-detects it (`window.ZaliAndroidBridge?.postMessage`,
alongside the existing `webkit`/`ipc`/`webview2` checks) and wires it into
`window.__ZALI_NATIVE`.

**Why a bridge is needed:** the UI loads via `file:///android_asset/...`, and a
`file://` page's `fetch()` sends `Origin: null`, which the server's CORS allowlist
(`allowed_origins` in `src/lib.rs`, no wildcard) always rejects — every API call
would fail with a network error. Routing `API_REQUEST` messages through OkHttp
instead sidesteps the WebView's CORS enforcement entirely (same fix as iOS).

- **HTTP (`API_REQUEST`)** — OkHttp, 2 connections/host cap (mirrors iOS's
  `httpMaximumConnectionsPerHost`), 2-attempt retry with a fresh client (own
  connection pool) on the second attempt so a stale pooled socket doesn't stall
  the retry too.
- **WebSocket** — OkHttp `WebSocket` to `wss://<host>/ws`, same
  `Authorization`/`X-Zali-Device-ID` headers as HTTP, exponential-backoff
  reconnect (same formula as iOS/macOS). OkHttp has a built-in ping interval, so
  unlike iOS there's no hand-rolled heartbeat. Flips `window.setConnectionStatus(...)`
  and forwards `avatar_updated`/`avatar_deleted`/`reaction_updated`/
  `key_envelope_available` (plaintext metadata) and downloads + decrypts
  message-envelope frames (`id`/`sender`/`receiver`, no `type`) via `ZaliCoreBridge`
  — see below.
- **Device identity** — `PERSIST_DEVICE_IDENTITY` writes
  `shared_device_identity_{user}.json` to `context.filesDir` (private app storage;
  Android has no Keychain-style consent friction, so this is simpler than the
  macOS/iOS "no Keychain" workaround) and is re-injected via
  `WebViewCompat.addDocumentStartJavaScript` on the next cold start — prevents
  device-identity churn from orphaning key envelopes across app restarts.
- **`window.__ZALI_NATIVE_CAPS__` lists every capability explicitly.**
  `window.ZaliAndroidBridge` falls into `bootstrap.js`'s generic "transport"
  branch, whose *defaults* already claim `sendMessage`, `setKey`, `sessionSync`,
  `saveStyle`, `saveMessageCache` — before those were actually handled here, JS
  believed outgoing messages were natively sent and silently dropped them
  instead of queueing them for retry (`flushPendingOutbox()` in interface.js).
  Set new capabilities explicitly here rather than relying on the branch defaults.

## Message send/receive — `ZaliCoreBridge.kt` (Rust Core JNI)

Ported from `ZaliCore.swift` (macOS/iOS) — same `zali_bus_dispatch`-equivalent
JSON-in/JSON-out protocol (`Core/src/android_jni.rs`, `Java_org_zalikus_messenger_
ZaliCoreBridge_busDispatch`), same `candidateMessageKeys` scoping. `.zali` archive
encrypt/decrypt is genuinely shared code — the same `Core/src/net.rs`/`crypto.rs`
Rust runs on macOS, iOS, Windows, and Android; only the language binding differs
(C ABI for Swift, JNI for Kotlin).

- **Receiving**: `NativeBridge.downloadAndDecryptMessage` (on a WS message-envelope
  frame) downloads the `.zali` archive from `/api/download/{id}`, then
  `decryptAndDeliver` calls `ZaliCoreBridge.unpackMessage(...)` with candidate keys
  from `SET_KEY` and hands the plaintext to `window.receiveMessage(...)`.
  Attachments ≤2 MB are inlined as a `data:` URL, matching macOS/iOS.
- **Sending**: `NativeBridge.handleSendMessage` (on `SEND_MESSAGE`) decodes `data:`
  URL attachments to temp files, calls `ZaliCoreBridge.packMessage(...)`, then
  uploads via OkHttp `MultipartBody` to `/api/upload` (same field names as macOS's
  `NetworkService.uploadMessage`: `sender`/`client_id`/`key_version`/`receiver`/
  `server_id`/`channel_id`/`file`), reporting back via
  `zali_interface:on_send_success`/`on_send_error`. An in-flight `clientId` guard
  prevents double-send on a rapid retry.

### Building the native library (`libzali_messenger_core.so`)

**Not built by this Gradle project** — cross-compiling Rust for Android needs the
NDK's C toolchain, which this repo's dev environment doesn't have installed.
`ZaliCoreBridge.isAvailable` is `false` (checked before every pack/unpack call) if
the `.so` isn't present, so the app still runs — send/receive just silently no-op
with an `on_send_error`/dropped-message outcome instead of crashing.

```bash
# Install the NDK once, e.g. via Android Studio → SDK Manager → SDK Tools → NDK
export ANDROID_NDK_HOME=$HOME/Library/Android/sdk/ndk/<version>
cargo install cargo-ndk

# From repo root, whenever Core/src/*.rs changes:
./android/build_android_core.sh
```

This cross-compiles `Core/` (with `--features android`, enabling `android_jni.rs`)
for `arm64-v8a` (device) and `x86_64` (emulator) and drops the `.so` files into
`android/app/src/main/jniLibs/<abi>/`, which Gradle picks up automatically — no
`build.gradle.kts` change needed for that part.

**Verified without the NDK**: `cargo check --features android --target
aarch64-linux-android` (and `x86_64-linux-android`) both pass cleanly —
`android_jni.rs` type-checks correctly for the real Android target, even though
this environment can't link the final `.so`. This also caught and fixed a real,
pre-existing cross-platform bug in `Core/src/lib.rs`'s legacy
`zali_unpack_message`: it cast to `*const i8`, but `c_char` is *unsigned* on
Android/Linux (vs. signed on Apple platforms) — fixed to the portable
`std::os::raw::c_char`.

## Build

```bash
# 1. Build/refresh the shared web bundle (from repo root)
python3 bundle_web.py

# 2. Cross-compile Rust Core for Android (needs NDK + cargo-ndk — see above).
#    Skippable for a first UI-only test build; messaging just no-ops until this runs.
./android/build_android_core.sh

# 3. Build the APK (Gradle copies Web/{index.html,style.css,app.js} into assets/web)
cd android
./gradlew assembleDebug        # or open the `android/` folder in Android Studio

# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

`compileSdk = 35`, `minSdk = 26`. The `copyWebAssets` Gradle task runs before every
build, so the WebView always loads the current bundle from `assets/web/index.html`.

## Notes / TODO for a production build

- WebRTC in `WebView` works from Android 8+; `onPermissionRequest` grants camera/mic.
  For real deployments, request the runtime `CAMERA`/`RECORD_AUDIO` permissions and
  scope the grant to the bundled origin.
- The Gradle wrapper (`gradlew`, `gradle/wrapper/…`) is not committed here — run
  `gradle wrapper` once, or open the project in Android Studio which provisions it.
- Push notifications (FCM), background voice service, and secure key storage
  (Android Keystore / EncryptedSharedPreferences) are **not** in this scaffold —
  port the transport/keys logic from the Windows Rust client or macOS Swift client.
