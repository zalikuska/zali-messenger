# Zali Messenger — iOS shell

Thin native iOS client. Like the macOS and Windows clients, it wraps the **shared
web UI** (`web/src/interface.js`, bundled by `scripts/bundle_web.py`) in a `WKWebView`. The
only native chrome is the bottom navigation: a **Liquid Glass tab bar** styled like
the iOS 26 App Store (`LiquidGlassTabBar.swift`).

## How it fits the monorepo

- The web UI is canonical. Feature/crypto/network changes go in `web/src/` and are
  bundled with `python3 scripts/bundle_web.py`, exactly as for macOS/Windows.
- This shell owns: window setup, the native tab bar, a tiny JS bridge that (a)
  clicks the hidden web dock buttons to switch section and (b) hides the web's own
  `.mobile-dock` so there is one bar, and a **native API bridge** (see below). See
  `WebView.swift`.
- No message/crypto logic lives here — it all runs in the shared JS + server.

### Why there's a native API bridge

The shared web UI is loaded via `loadFileURL` (`file://`). A `file://` page's
`fetch()` sends `Origin: null`, and the server's CORS allowlist
(`allowed_origins` in `server/src/lib.rs`, no wildcard) always rejects that — every API
call (login included) fails with a WebKit "Load failed" that surfaces in the UI as
"Не удалось связаться с сервером". macOS and Windows avoid this the same way: API
calls are routed through a native HTTP client instead of the WebView's `fetch()`.

`WebViewStore` registers a `WKScriptMessageHandler` named `nativeApp` (the exact
name `web/src/bootstrap.js` auto-detects) and injects `window.__ZALI_NATIVE_CAPS__ =
{ apiRequest: true }` before the page scripts run. `web/src/interface.js`'s
`apiFetch()` then routes every request through `postNativeMessage({type:
'API_REQUEST', ...})` instead of `fetch()`; `WebViewStore.handleApiRequest` performs
the request with `URLSession` (no CORS enforcement applies to native networking) and
replies via `window.loader.bus.send('zali_interface:native_response', ...)`, matching
the envelope `nativeApiResponse()` expects. `NETWORK_CONFIG` messages (user changes
the server address on the login screen) update the base URL used for the next
request.

Retries a stale pooled connection on a fresh ephemeral `URLSession`, same as macOS
`NetworkService.attemptApiRequest`: first attempt gets a short timeout (a dead
pooled socket shouldn't burn the whole budget before falling back), the retry gets
the rest. Ported after `/api/key-envelopes` and `/api/vault/events` calls were
observed timing out on-device with only a single attempt.

`apiSession` also caps `httpMaximumConnectionsPerHost = 2`. Login (a single, solo
request) succeeded while every request `startPostAuthSetup()` fires the instant
login completes (contacts/users/servers/device-trust/vault — ~5 concurrent calls,
see `web/src/interface.js`) timed out together. That split — one request fine, a
burst all failing at once — pointed at connection-pool contention rather than
permissions or the transport being categorically broken: on a narrow/high-latency
link, several requests queued behind the pool's first connection all stall if that
handshake is slow. Capping concurrency avoids asking a fragile link to open several
connections at once.

### Stable device identity (key envelope sync)

E2E key envelopes on the server are addressed to a specific `recipient_device_id`
captured when the sender published them (`conversation_key_envelopes`, filtered by
`WHERE owner=? AND recipient_device_id=?` in `server/src/lib.rs`). If a device's identity
changes between launches, every previously-published envelope becomes unreachable —
this device just never receives those keys and the UI logs "на сервере нет
конвертов для этого устройства" forever, even though the keys exist. `interface.js`'s
`loadDeviceIdentity()` only mints a fresh identity when its own localStorage has
none; before doing that it checks `window.__ZALI_INJECTED_DEVICE_IDENTITY`.

`WebViewStore` mirrors the macOS Swift client's fix: `handlePersistDeviceIdentity`
writes whatever identity `persistDeviceIdentityToNative()` sends to
`~/Library/Application Support/ZaliMessenger/shared_device_identity_{username}.json`
(plain file, no Keychain — same "no Keychain" rule as macOS) and remembers the
username in `UserDefaults`. On the next cold start, `init()` reads that file back
and injects it via a `WKUserScript` at `.atDocumentStart`, before `bootstrap.js`
runs — so a WKWebView storage wipe (reinstall, Xcode relaunch clearing site data)
re-adopts the same `device_id` instead of registering a new, unapproved one.

Unlike the macOS/Windows shells, this file is **not** actually shared across
devices (it's iOS's own app-sandboxed Application Support, on a different physical
device from the Mac) — it only stops this iOS install's *own* identity churn across
relaunches. Cross-device envelope delivery still requires the peer to (re)publish to
this device once it's an approved, stable identity.

## Files

| File | Role |
|---|---|
| `ZaliApp.swift` | `@main` app entry |
| `ContentView.swift` | Full-screen web view + bottom Liquid Glass bar overlay |
| `WebView.swift` | Single shared `WKWebView`, JS bridge, HTTP+WS transport, message decrypt dispatch |
| `ZaliCore.swift` | Swift wrapper around the Rust Core FFI (`.zali` pack/unpack) |
| `LiquidGlassTabBar.swift` | iOS 26 `glassEffect` bar (App Store style), green active pill |
| `ZaliTab.swift` | The four sections (Чаты / Сервера / Хаб / Настройки) |
| `Info.plist` | Camera/mic/photo usage strings, dark mode |
| `project.yml` | XcodeGen spec |

## Build

Requires **Xcode 26** (iOS 26 SDK) for the Liquid Glass APIs. The app still runs on
**iOS 17+** — Liquid Glass code is guarded by `if #available(iOS 26.0, *)` with an
`.ultraThinMaterial` fallback.

```bash
# 1. Build/refresh the shared web bundle (from repo root)
python3 scripts/bundle_web.py

# 2. Cross-compile Rust core for iOS and package ZaliCore.xcframework (from repo root;
#    only needed once, and again whenever core/src/*.rs changes)
./scripts/build_ios_core.sh

# 3. Generate the Xcode project (install XcodeGen via `brew install xcodegen`)
cd apps/ios
xcodegen generate

# 4. Open and run
open ZaliMessenger.xcodeproj
```

The `web/{index.html,style.css,app.js}` files are copied into a `Web/` folder inside
the app bundle (bundle-internal folder name, unrelated to the repo's `web/` source
dir); `WebViewStore.loadBundledUI()` loads `Web/index.html` via a file URL.

## Notes / TODO for a production build

- Signing team + a real bundle id must be set in Xcode before device deploy.
- `getUserMedia`/WebRTC in `WKWebView` needs the camera/mic permission prompt; the
  usage strings are in `Info.plist`. Grant is scoped by `WKUIDelegate`
  `requestMediaCapturePermissionFor` if you tighten origins (mirror the macOS shell).
- `API_REQUEST`, `NETWORK_CONFIG`, `SET_KEY`, `SEND_MESSAGE`, and
  `PERSIST_DEVICE_IDENTITY` native *messages* are all handled (the WS transport
  below is separate — it isn't a `postNativeMessage` type, it's driven internally).
  Messaging (send, receive, decrypt) is feature-complete. Push notifications,
  background voice (`VOICE_EVENT`), and avatar upload are **not** in this
  scaffold yet — port from the macOS Swift client
  (`apps/macos/Sources/ZaliMessenger/Views/WebView.swift`, `Services/NetworkService.swift`)
  when wiring the native transport further. Keep the "no Keychain" rule (plain
  file under Application Support) — see project CLAUDE.md.
- `window.__ZALI_NATIVE_CAPS__` explicitly sets every capability, including the
  false ones. It's registered under the message-handler name `nativeApp` — the
  same name macOS uses — so `bootstrap.js`'s detection treats it as the `webkit`
  transport and assumes full macOS-level defaults (`avatarFetch`, `voice`,
  `windowDrag`, ...). Left uncorrected, JS believed those were natively handled
  and skipped its own already-tested fallbacks (e.g. `sendMessage: true` made
  `flushPendingOutbox()` assume native would send the message instead of queueing
  it locally for retry — messages were silently lost, not just delayed). If you
  add a new capability here, set it explicitly rather than relying on the
  `webkit`-branch defaults.

### WebSocket transport + message decryption

`WebViewStore` opens a real `URLSessionWebSocketTask` to `wss://<host>/ws` with the
same `Authorization: Bearer` + `X-Zali-Device-ID` headers as HTTP, mirroring macOS
`NetworkService`'s message socket: ping every 25s, exponential-backoff reconnect
(same formula as macOS, capped at 6 attempts / 30s + jitter), a generation counter
so a superseded socket's late callbacks can't step on a newer connection. It
connects the moment the first authenticated `API_REQUEST` is seen (there's no
separate `SET_SESSION` native call on this transport) and reconnects if
`NETWORK_CONFIG` changes the server address.

It flips `window.setConnectionStatus(...)` accurately (the "Подключение..." badge
reflects a real socket state), forwards `avatar_updated`/`avatar_deleted` →
`window.avatarUpdated`/`avatarDeleted`, `reaction_updated` →
`window.receiveReactionUpdate`, `key_envelope_available` → `window.refreshAfterKey`
— all plaintext metadata, no decryption needed.

A **message-envelope frame** (`id`/`sender`/`receiver`, no `type` — matches macOS's
`WsMessage`) triggers `downloadAndDecryptMessage`: downloads the `.zali` archive from
`/api/download/{id}` via the same `apiSession`, then `decryptAndDeliver` unpacks +
decrypts it via `ZaliCore` (see below) and calls `window.receiveMessage(...)` with
the plaintext. Candidate keys come from `SET_KEY` (`currentE2eKey` +
`conversationKeys`, scoped the same way `ZaliCore.candidateMessageKeys` does on
macOS) — a message encrypted under a key this device hasn't synced yet is silently
dropped, same as macOS. Attachments ≤2 MB are inlined as a `data:` URL, matching
macOS's threshold.

### `ZaliCore.swift` — Rust Core FFI (`.zali` decrypt)

Ported near-verbatim from `apps/macos/Sources/ZaliMessenger/Services/ZaliCore.swift` —
same `zali_bus_dispatch` JSON-in/JSON-out C ABI, same `candidateMessageKeys` scoping
logic. Linked via `ZaliCore.xcframework`, built by **`scripts/build_ios_core.sh`**
(repo root): cross-compiles the `core/` crate for `aarch64-apple-ios` +
`aarch64-apple-ios-sim` and packages both slices, with `core/include/CoreBridge.h`
(a duplicate of macOS's `Sources/CoreBridge/include/CoreBridge.h` — keep both in
sync if the FFI surface changes), into an XCFramework via `xcodebuild
-create-xcframework`. `project.yml` links it as a static-lib framework
(`embed: false` — nothing to embed at runtime).

**Run `scripts/build_ios_core.sh` before the first `xcodegen generate` and after any
`core/src/*.rs` change** — the XCFramework isn't rebuilt automatically. Verified:
`xcodebuild ... build` for a real arm64 simulator (`iPhone 17 Pro`) succeeds with
this wired in — no Swift or link errors, only two benign linker warnings
(`UIUtilities` / `SwiftUICore` auto-link noise, normal when linking a
non-Xcode-produced static library, does not affect `BUILD SUCCEEDED`).

### Sending (`SEND_MESSAGE`)

`handleSendMessage` (ported from macOS's `.sendMessage` IPC case) decodes any
`data:` URL attachments to temp files, calls `ZaliCore.shared.packMessage(...)`
(Rust Core does the AES-256-GCM encryption + `.zali` archive build), then
`uploadMessage` — a hand-built `multipart/form-data` upload to `/api/upload`
(ported from macOS `NetworkService.uploadMessage`, same field names:
`sender`/`client_id`/`key_version`/`receiver`/`server_id`/`channel_id`/`file`) —
and reports the result back to JS via `zali_interface:on_send_success` /
`on_send_error`, matching macOS's `sendBusEvent`. An in-flight `clientId` guard
(`inFlightSendClientIds`) prevents a double-Enter or a retry racing the first
attempt from packing + uploading the same message twice. Verified compiling and
linking together with the WS/decrypt code above (`BUILD SUCCEEDED`).
- To use a native `TabView` with `.tabBarMinimizeBehavior(.onScrollDown)` instead of
  the custom glass bar, host the shared web view in a `ZStack` behind a transparent
  `TabView`; the custom bar was chosen so a single web view is never rebuilt.
