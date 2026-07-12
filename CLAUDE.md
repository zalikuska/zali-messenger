# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Обязательно при ЛЮБЫХ изменениях в коде — проверить, не нужны ли они в другой версии

Этот репозиторий содержит **несколько параллельных реализаций одной и той же логики**. Почти любой фикс в одном месте требуется и в других. **Перед завершением любой правки уточни (у пользователя и/или проверкой), не нужно ли продублировать её в:**

- **Web UI** (`web/src/interface.js`) — канонический источник. После правки **всегда** запусти `python3 scripts/bundle_web.py`, иначе изменения не попадут в macOS (`Assets.swift`) и Windows embedded-ассеты.
- **macOS Swift-клиент** (`apps/macos/Sources/ZaliMessenger/`, основной) ↔ **Windows/Rust-шелл** (`apps/windows/src/native.rs` + `apps/windows/src/native/`) — реализуют один и тот же нативный слой (IPC-бридж, ключи, реконнект WS, HTTP-запросы, голосовой транспорт) **параллельно**. Фикс сетевого/крипто/бридж-поведения в одном почти всегда нужен и в другом — но с адаптацией под платформу (напр. macOS Keychain/файлы vs Windows `keyring`), не 1:1.
- **Сервер**: локальный `server/src/` в этом монорепо ↔ серверный репозиторий (`zali-server`, ветка `zali-server`). Правки хендлеров нужно пушить в серверный репо и деплоить (см. «Deploy process»).
- **Archiver SDK**: `sdk/Rust/` (сервер+Windows) ↔ `sdk/Swift/` (macOS) — зеркальные реализации формата `.zali`. Изменение формата/крипто нужно в обоих.

Правило: **никогда не считай правку завершённой, пока не спросил себя «в каких ещё из этих версий это тоже нужно?» и не сообщил об этом пользователю.**

**ОБЯЗАТЕЛЬНО:** при ЛЮБОМ изменении кода — до того как считать задачу выполненной — явно уточни у пользователя (или проверь сам и сообщи результат), нужно ли продублировать правку в другие версии из списка выше. Это не опционально: даже если кажется, что фикс локальный, назови затронутые параллельные реализации и подтверди по каждой «нужно / не нужно / уже есть».

> Пример из практики (2026-07): фикс загрузки/показа аватара делался в macOS Swift-клиенте (multipart CRLF в raw-строке `\#r\#n`, роутинг upload через нативный мост, ретрай `performAvatarFetch` на свежем соединении). Windows/Rust-шелл использует `reqwest` (сам ставит CRLF) и уже имеет `perform_avatar_fetch`+`retry_with_backoff` — там правки 1:1 не нужны, но проверить это надо было явно.

## graphify

This project has a knowledge graph at `graphify-out/` with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of raw source browsing.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Production Server

- URL: `https://msgs.zalikus.org`
- SSH access: `ssh zms`
- Server repo: https://github.com/zalikuska/zali-messenger-server (branch `zali-server`)
- Server binary runs at: `/opt/zali-server/server/target/release/zali_server` (moved from `/opt/zali-server/target/release/zali_server` by the 2026-07-12 reorg — that root `Cargo.toml` no longer exists, so the build output now lands under `server/target/`, not `target/`)
- Env vars: `/etc/zali/zali-server.env` (symlinked to `/opt/zali-server/.env`)

### Deploy process

```bash
# 1. Push server/src/main.rs changes from local monorepo to server repo
git push serverrepo codex/ui-v2-hub-segments:zali-server

# 2. On VPS: pull, build, restart
ssh zms "cd /opt/zali-server && git pull --ff-only origin zali-server"
ssh zms "cd /opt/zali-server && cargo build --release --manifest-path server/Cargo.toml -p zali_server 2>&1 | tail -3"
ssh zms "pkill -f zali_server; sleep 1"
ssh zms "cd /opt/zali-server && set -a && source /etc/zali/zali-server.env && set +a && nohup ./server/target/release/zali_server >>/root/zali-server.log 2>&1 </dev/null &"

# 3. Verify
ssh zms "sleep 3 && pidof zali_server && tail -5 /root/zali-server.log"
```

> Note: `set -a && source /etc/zali/zali-server.env && set +a` required — `nohup` doesn't inherit `source`d vars otherwise.

> Note: since the Web Push feature landed (2026-07-12), the first build after pulling it will compile
> OpenSSL from source (`openssl` crate's `vendored` feature, pulled in transitively for `web-push`'s
> encryption backend) — noticeably slower one-time build, needs a C compiler (already required for
> `sqlx-sqlite`, so nothing new to install) but no `libssl-dev`. To actually enable push, add
> `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` to `/etc/zali/zali-server.env` — generate with
> `cargo run --manifest-path server/Cargo.toml --example gen_vapid_keys` on the VPS (or copy from local
> dev, VAPID keys aren't tied to any account/domain). Leaving them unset just disables push silently.

> Note: after the 2026-07-12 repo reorg there is no root `Cargo.toml` on the VPS checkout — always pass `--manifest-path server/Cargo.toml` to `cargo build`, and restart from `server/target/release/zali_server`, not `target/release/zali_server`. On 2026-07-12 a deploy silently kept running a week-old binary at the old `target/release/zali_server` path (still present from a prior build) while the freshly built binary sat unused at `server/target/release/zali_server` — `pkill`+`nohup` "succeeded" with no errors and the new code never went live. If in doubt, verify with `ssh zms "readlink -f /proc/\$(pidof zali_server)/exe"` after restart. Consider deleting the stale `/opt/zali-server/target/` directory on the VPS once confirmed unused (ask before doing this — it's a production server path).

## Build Commands

```bash
# Server (package name is zali_server with underscore)
cargo check --manifest-path server/Cargo.toml -p zali_server
cargo run --manifest-path server/Cargo.toml   # starts on http://localhost:3000

# Archiver SDK (Rust)
cargo check --manifest-path sdk/Rust/Cargo.toml

# Windows client
cargo check --manifest-path apps/windows/Cargo.toml
cargo run --manifest-path apps/windows/Cargo.toml

# Web assets — must run before macOS/Windows builds see JS changes
python3 scripts/bundle_web.py

# Standalone browser/PWA client (mobile + desktop, no native shell) — run before bundle_web.py
# so web/wasm-pkg/ is present when web/app.js is regenerated. Serve web/ with any static
# file server (or the zali-server itself) — index.html loads wasm-pkg/zali_core.js next to it.
scripts/build_web_wasm.sh

# macOS (Swift, основная версия) — core must be built first
cd core && cargo build --release && cd ..
swift build --package-path apps/macos   # SwiftPM check
./scripts/build_app.sh                  # produces ZaliMessenger.app

# Full macOS app (convenience script)
./scripts/run_macos_app.sh

# macOS (Rust-шелл, экспериментальный) — тот же код, что Windows-клиент
./scripts/build_macos_rust_app.sh       # produces dist/macos-rust/ZaliMessengerRust.app
```

Running tests:
```bash
cd core && cargo test              # Core Rust unit tests
cd server && cargo test            # server integration tests (top-level tests/)
```

## Project Structure

| Path | Role |
|---|---|
| `server/src/` | Axum server, split into modules: `main.rs` (config, AppState, router wiring, middlewares), `models.rs` (DTOs/records), `auth.rs`, `contacts.rs`, `servers.rs`, `channels.rs`, `roles.rs`, `messages.rs`, `assets.rs`, `realtime.rs` (WS), `storage.rs` (migrations/seeding), `util.rs`, plus older `devices.rs`, `voice.rs`. Модули реэкспортируются в корень крейта (`pub(crate) use x::*;` в main.rs), поэтому `use crate::{...}` работает отовсюду |
| `web/src/interface.js` | Entire web UI (~13000 lines): runs in both browser and native WebView |
| `apps/macos/` | SwiftUI app (Swift Package Manager); wraps WKWebView. **Основной macOS-клиент** |
| `apps/windows/src/native.rs` + `apps/windows/src/native/` | Rust desktop shell (WRY/TAO). `native.rs` держит NativeState/bridges и центральный `handle_ipc_message`; подмодули `native/{http,cache,keyring,util,transport,api,messages}.rs` — HTTP-клиенты, кэш расшифровки, keyring, санитайзеры, WS-транспорты, API-запросы, конвейер сообщений. Кроссплатформенный: собирается для Windows (`scripts/build_windows_app.ps1`, основной путь) и как **экспериментальный** macOS-шелл (`scripts/build_macos_rust_app.sh`, см. ниже) |
| `core/` | Rust core library compiled to static `.a` for macOS FFI |
| `sdk/Rust/` | Archive format SDK; used by server and Windows client |
| `sdk/Swift/` | Swift mirror of the SDK; used by macOS client |

## Architecture

### Message flow
1. Sender calls `sendMessage` IPC on macOS/Windows → native client POSTs to `/api/send` with a `.zali` archive body
2. Server stores the archive blob, delivers via WebSocket to recipient's connected sessions
3. Recipient native client receives WS event, calls `downloadMessage`, unpacks the `.zali` archive, decrypts

### .zali archive format
Magic header `ZALIMSSG` (8 bytes) + 1-byte protocol version, followed by AES-256-GCM encrypted chunks of 1 MB each. **Nonce per chunk**: `base_nonce[8..12]` += `chunk_index` using **wrapping addition** (not XOR). This matches Swift `addNonceCounter` and Rust `wrapping_add`. PBKDF2-SHA256 at 210 000 iterations for key derivation; always use `Array(password.utf8).count` (not `password.count`) for byte length.

### E2E key exchange
Conversation-scoped keys are exchanged via ECDH + AES-GCM envelopes. `resolveConversationCryptoKey` in `interface.js` deduplicates concurrent requests via `_resolveKeyInFlight` Map. After decrypting a key envelope, verify `payload.sender` matches the expected peer from the conversation scope.

### Server (`server/src/`)
Axum server split into modules (2026-07-07); `main.rs` keeps Config/AppState/router, handlers live in per-domain modules (see Project Structure). Key invariants established by recent security fixes:
- `ensure_server_member` uses `ON CONFLICT DO NOTHING` — never demotes existing roles; use `upsert_server_member` for explicit role updates
- `revoke_device` wraps the active-count check + UPDATE in a `BEGIN IMMEDIATE` transaction
- `join_server_link` SQL has no `OR id = ?` clause; private servers (`is_public == 0`) are rejected after lookup
- Passwords are capped at 72 bytes at registration (bcrypt silent truncation prevention)
- `approve_device` rejects self-approval (`target_id == actor_id`)
- File deletions in `delete_server` happen **after** transaction commit

### macOS client (`apps/macos/`)
- IPC: `WKScriptMessageHandler.userContentController` in `WebView.swift`; all handlers guard `message.frameInfo.isMainFrame`
- Crypto key is stored in a **plain file** (`Coordinator.saveLegacyCryptoKey` / `loadLegacyCryptoKey`, `~/Library/Application Support/ZaliMessenger/legacy_crypto_key.txt`), not Keychain and never UserDefaults. Keychain was removed 2026-07-03: `build_app.sh` never code-signs with a stable identity, so its ad-hoc signature changes on every rebuild — the Keychain ACL then treats each rebuild as "a different app," reprompting for consent on every launch. Do not reintroduce Keychain here (see project memory `feedback_no_keychain`)
- Camera/mic permission (`requestMediaCapturePermissionFor`) is granted only for `localhost`/`127.0.0.1` origins from the main frame
- Tenor URL resolution validates HTTPS + `tenor.com` host before fetching
- `javaScriptCanOpenWindowsAutomatically` is `false`

### macOS Rust shell (тот же крейт `apps/windows/`) — экспериментальный, не основной
После пробной миграции (2026-07) решено вернуться к Swift-версии как основной: голосовые звонки и уведомления в Rust-шелле не были подтверждены реальным использованием, а ценность отдельного нативного стека не перевесила риск. Код и сборка сохранены рабочими на случай, если понадобится вернуться. Крейт `zali_messenger_win` собирается и на macOS (WRY использует WKWebView). Сборка/запуск: `./scripts/build_macos_rust_app.sh` / `./scripts/run_macos_rust_app.sh`. Платформенные ветки:
- `NativeState::app_data_dir()`: Windows → `%LOCALAPPDATA%\ZaliMessenger`, macOS → `~/Library/Application Support/ZaliMessenger` (без этой ветки конфиг падал в temp и стирался ОС)
- `spawn_swift_keychain_migration()` (macOS only): фоновый одноразовый импорт ключа Swift-клиента из Keychain (`com.zali.messenger` / `zali_crypto_key_v2`). **Никогда не читать чужие Keychain-записи на стартовом пути** — модальный диалог доступа блокирует поток до ответа пользователя (приложение зависало до появления окна)
- Меню-бар через `muda` (macOS only) — без него в WKWebView не работают Cmd+C/V/Q
- `install_media_capture_policy()` в `main.rs` (macOS only): добавляет `requestMediaCapturePermissionForOrigin:` в UIDelegate wry через objc runtime — Grant только main frame + origin `zali://`/localhost, зеркало инварианта Swift-клиента. Диагностика окружения при старте уходит в trace-лог строкой `DIAG_ENV;...` (подтверждено: `zali://` — secure context, WebCrypto/WebRTC/getUserMedia доступны)
- Уведомления работают только из .app-бандла (mac-notification-sys). Голосовой звонок end-to-end реальным звонком пока не проверялся — все слои (getUserMedia grant, RTCPeerConnection, нативный WS-транспорт сигналинга) на месте
- Swift-версия (`apps/macos/`, `./scripts/build_app.sh`) — основная; оба .app могут сосуществовать (разные bundle id: `com.zali.messenger` и `com.zali.messenger.rust`), если понадобится вернуться к Rust-шеллу
- Кросс-проверка Windows-таргета с macOS (`cargo check --target x86_64-pc-windows-msvc`) может падать на C-коде `ring` (нет заголовков Windows SDK) — это ограничение тулчейна, не регрессия; Windows собирается на Windows

### Windows client (`apps/windows/src/native.rs`)
- `handle_ipc_message` is the central native bridge entry point
- URL path segments for dynamic values use `reqwest::Url::path_segments_mut().push()` — never `format!()` interpolation
- `perform_api_request` blocks `..`, `%2F`, `%5C` in paths
- Avatar and message file downloads use streaming byte counters (100 MB and 512 MB caps respectively)
- `decode_data_url` has a 100 MB hard cap before any parsing

### Web UI (`web/src/interface.js`)
- `randomBase64` throws if `window.crypto.getRandomValues` is unavailable — no Math.random fallback
- CSS color values from server data pass through `safeCssColor()` before being set in style attributes
- `flushPendingOutbox` drops messages after 50 failed attempts (`MAX_OUTBOX_ATTEMPTS`)
- `renderMessageText` link hrefs unescape `&amp;` → `&` before passing to `this.esc()`
- Vault envelopes require `v === 1` and `iterations >= 100000` before decryption

### Standalone browser/PWA client (mobile + desktop, no native shell)
Started 2026-07-12: `web/index.html` + `web/app.js` can now run as a plain browser tab with zero
native bridge (macOS/Windows/iOS/Android), for direct-message text (and attachments) send/receive.
- `hasNativeBridge()` gates almost every native-only code path in `interface.js`; the `!hasNativeBridge()`
  branches for sending, DM history load, and real-time receive used to just no-op/warn — they now
  have real browser implementations (`browserSendMessage`, `loadBrowserDmHistory`,
  `handleIncomingBrowserMessage` in `interface.js`, wired into `sendInputMessage`,
  `syncActiveConversation`/`refreshAfterKey`, and the existing `connectBrowserVoiceSocket()` WS's
  `onmessage`, respectively)
- The `.zali` archive format (message pack/unpack) needs a filesystem-free implementation for the
  browser. `sdk/Rust/src/lib.rs` gained `create_archive_bytes`/`extract_all_bytes` (in-memory,
  byte-for-byte wire-compatible with the path-based `create_archive`/`extract_all` — see the
  `bytes_archive_created_*` interop tests in `sdk/Rust/tests/archive.rs`); `core/src/net.rs` gained
  `pack_message_bytes`/`unpack_message_bytes` on top of those; `core/src/lib.rs` exposes them as
  `pack_message_wasm`/`unpack_message_wasm` via `wasm-bindgen` (feature `wasm`)
- `web/src/modules/wasm_bridge.js` lazily `import()`s `web/wasm-pkg/zali_core.js` (built by
  `scripts/build_web_wasm.sh`, must run before `bundle_web.py`) and exposes `window.ZaliWasm`
- **wasm32 gotchas hit and fixed**: `std::time::SystemTime::now()` panics on `wasm32-unknown-unknown`
  ("time not implemented on this platform") — use `js_sys::Date::now()` there instead (see
  `now_unix_secs()` in `core/src/net.rs`). `rand`'s `OsRng`/`thread_rng()` need `getrandom`'s `"js"`
  feature explicitly enabled via a `[target.'cfg(target_arch = "wasm32")'.dependencies]` override in
  `core/Cargo.toml` (Cargo won't infer it from the `wasm` feature alone). Both surfaced in-browser as
  an opaque `RuntimeError: unreachable` — `console_error_panic_hook` (wired in behind the `wasm`
  feature) turns that into a real Rust panic message in the browser console; keep it when debugging
  new wasm-bindgen exports
- Real-time delivery already had a permanent per-browser-tab WebSocket (`connectBrowserVoiceSocket`,
  auth via `/api/auth/ws-ticket` since the browser can't set a custom `Authorization` header on the
  WS handshake) — it only handled `voice_*` events before; a `Message` row pushed by
  `deliver_to_user`/`deliver_server_message` (server/src/realtime.rs) has **no `type` field** at all,
  which is how the new branch tells it apart from voice/avatar events on the same socket. That same
  socket's `onopen`/`onclose` now also drive `setConnectionStatus()` — it used to only ever fire from
  native `SET_CONNECTION_STATUS` events, so the "Подключено"/"Переподключение..." badge was
  permanently stuck on the latter in pure-browser mode even once messaging worked
- Servers/channels messaging is ported too: `loadServerMessages`'s browser-fallback branch used to
  show literal placeholder text (`msg.text || msg.content || 'Зашифрованное сообщение недоступно...'`)
  because the server can only return metadata for E2E-encrypted messages, never plaintext — it now
  routes each history row through `handleIncomingBrowserMessage` (same WASM download+unpack path used
  for live receive), which already branched on `serverId`/`channelId` from day one. Sending in a
  channel from the browser was already covered by `browserSendMessage` (it always forwarded
  `serverId`/`channelId`) — only the history-load side was still stubbed
- Voice **signaling** already worked in pure-browser mode before any of this (`sendVoiceEvent` falls
  back to the same WS when there's no native voice bridge) and `getUserMedia`/`RTCPeerConnection` are
  called unconditionally (never gated behind `nativeSupports('voice')`) — so calls should work
  end-to-end in two real browser tabs, but this wasn't verified live in this session (needs two
  audio-capable peers, not just console-driven state pokes)
- Added minimal PWA scaffolding for installability: `web/manifest.json`, `web/icon.svg`,
  `web/service-worker.js` (app-shell cache-first for static files, always network for `/api`, `/ws`,
  `/uploads`), registered from `bootstrap.js` only when `!window.__ZALI_NATIVE?.available` — meaningless
  under native shells that load this HTML via `loadHTMLString`/an inline string, not a real origin
- macOS/Windows/iOS/Android native clients are unaffected by all of the above — this is purely
  additive (a new, filesystem-free code path used only when no native bridge is present), not a
  duplicate of their FFI-based archive handling that needed porting.
- **Web Push (VAPID)** for real background delivery when the tab/PWA is fully closed (2026-07-12,
  same session as the iOS-parity mobile-web pass). Server: `server/src/push.rs`
  (`/api/push/vapid-public-key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `send_web_push()`),
  wired into `deliver_to_user` in `messages.rs` — only fires when `send_payload_to_user` found **zero**
  live WS connections, so a foreground tab never gets a duplicate push. `push_subscriptions` table
  added to `init_db()` in `lib.rs`. Disabled by default: unset `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
  (see `.env.example`) makes the pubkey route 404 so the client never subscribes, and `send_web_push`
  no-ops. Generate a keypair with `cargo run --manifest-path server/Cargo.toml --example gen_vapid_keys`
  (no OpenSSL CLI/Firebase/Apple account needed — pure Web Push + VAPID, works in Chrome/Firefox always,
  Safari/iOS only once the PWA is added to the home screen on iOS 16.4+). Client:
  `interface.js` `subscribeWebPush()` (called from `applySession` on login, gated
  `!hasNativeBridge()`), `service-worker.js` `push`/`notificationclick` handlers. **Deploy note:** the
  `web-push` crate's only encryption backend depends on `ece`, which needs OpenSSL — `server/Cargo.toml`
  pins `openssl = { features = ["vendored"] }` so the VPS build compiles OpenSSL from source instead of
  requiring `libssl-dev` preinstalled (slower first build, zero new system deps). Verified live
  end-to-end against Google's real FCM endpoint in this session: subscribe → DM from a second user with
  the receiver's WS closed → server built+signed+encrypted+POSTed the push → got a real 404 back (fake
  test endpoint) → correctly pruned the stale subscription row. A **real** granted-permission delivery
  (actual OS notification popping) was not observed live — the sandboxed dev browser's
  `Notification.requestPermission()` always resolves `"denied"` with no way to grant it
  programmatically; that's a tooling limitation of this environment, not exercised code.

## Приоритеты при исправлении багов

**Фиксы работоспособности функций всегда важнее фиксов безопасности.** Мессенджер должен сначала корректно работать — отправлять, получать, шифровать, расшифровывать сообщения, совершать звонки. Если баг ломает функциональность, он критичен независимо от его природы. Баги безопасности, которые не нарушают работу, имеют низкий приоритет и могут быть отложены.

## Windows Build Distribution

### Что входит в дистрибутив

Для сборки Windows-клиента нужны только эти пути (без `target/`):

```
apps/windows/     — Rust-клиент (WRY/TAO)
core/             — Rust core library (зависимость apps/windows)
sdk/Rust/         — архивный SDK (зависимость core)
web/src/          — JS-модули и CSS/HTML
web/bridge_protocol.json
web/style.css
web/index.html
scripts/bundle_web.py         — бандлер веб-ассетов
scripts/build_windows_app.ps1 — PowerShell-скрипт сборки
```

Сервер (`server/src/main.rs`), `apps/macos/`, `sdk/Swift/` — **не нужны**.

### Создать zip для передачи

```bash
zip -r zali-windows-source.zip \
  apps/windows/src apps/windows/Cargo.toml apps/windows/Cargo.lock apps/windows/build.rs \
  core/src core/Cargo.toml core/Cargo.lock \
  sdk/Rust/src sdk/Rust/Cargo.toml sdk/Rust/Cargo.lock \
  web/src web/bridge_protocol.json web/style.css web/index.html \
  scripts/bundle_web.py scripts/build_windows_app.ps1
```

### Сборка на Windows-машине

**Предварительные требования:**
- Rust + MSVC toolchain (`rustup default stable-x86_64-pc-windows-msvc`)
- Python 3 (для `bundle_web.py`)
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) на целевой машине

**Порядок сборки:**
```powershell
# 1. Распаковать архив, перейти в корень
# 2. Собрать (PowerShell):
.\scripts\build_windows_app.ps1

# Результат: dist\windows\ZaliMessenger.exe
# Запустить сразу:
.\scripts\build_windows_app.ps1 -Run
```

`scripts/build_windows_app.ps1` автоматически запускает `scripts/bundle_web.py` перед `cargo build --release`.

Конфигурация сервера передаётся через env-переменные до бандлинга:
```powershell
$env:ZALI_API_BASE_URL = "https://msgs.zalikus.org"
$env:ZALI_WS_BASE_URL  = "wss://msgs.zalikus.org"
.\scripts\build_windows_app.ps1
```

## Git Safety — уроки реального инцидента с потерей кода

**Инцидент** (пути ниже — в структуре **до** реорганизации 2026-07-12; см. новые пути в разделе «Project Structure»): `git checkout -f <branch>` + `git pull --ff-only` между двумя ветками с *разным набором отслеживаемых путей* удалили с диска реально нужные файлы — `Core/src/*.rs`, `ZaliArchiverSDK/Rust/src/lib.rs`, `ZaliArchiverSDK/Swift/`, `macOS/Sources/ZaliMessenger/{NetworkService,ZaliArc,ZaliCore,ContentView}.swift`, `Package.swift`, `Web/src/{bus,loader,styler,bootstrap}.js`, `Web/index.html`, `Web/style.css`, `bundle_web.py`, `run_macos_app.sh` и другие build-скрипты. Причина: `Core/`, `Web/`, `Windows/`, `macOS/`, `ZaliArchiverSDK/` в этом репо на разных ветках то отслеживались git, то были в `.gitignore` как "legacy, хранится только в рабочей копии" — то есть их реальный, актуальный код существовал **только на диске**, никогда не коммитился. `git checkout -f` без раздумий подменяет такие файлы версией из целевой ветки; `pull --ff-only` после этого удаляет всё, что в новом дереве не отслеживается вовсе.

### Что делать до git checkout -f / reset --hard / pull --ff-only между ветками

1. **Сначала сравнить наборы отслеживаемых путей**, а не только диффы содержимого:
   ```bash
   diff <(git ls-tree -r <branch_a> --name-only | sort) <(git ls-tree -r <branch_b> --name-only | sort)
   ```
   Если списки сильно расходятся (особенно если пропадают целые директории типа `Core/`, `macOS/Sources/`) — это сигнал, что одна из веток не отслеживает то, что реально нужно на диске. `git status`/`git diff` этого не покажут, они смотрят только на текущий working tree.
2. Никогда не считать, что `main` — это "полная" версия проекта, только потому что так называется. Проверять `git log --oneline <branch> | tail`, чтобы понять реальную родословную (в этом репо было **два разных** "Initial commit" в истории — следствие squash/subtree-операций в прошлом).
3. Если `.gitignore` содержит секцию вида `# Legacy ... kept only in the workspace` — это красный флаг: значит эти пути живут только на диске, git о них ничего не знает, и любая операция, переключающая ветки/делающая fast-forward, может их стереть без предупреждения.
4. Если всё же нужно переключиться — сначала `git stash -u` (включая untracked) или скопировать директорию целиком, а не надеяться, что git сохранит нетрекаемые файлы.

### Где искать material для восстановления, если файлы всё же пропали

1. **`.claude/worktrees/agent-*/`** — если есть параллельные воркчтри фоновых агентов, они могли быть на другом коммите и не затронуты катастрофой. Проверить `git worktree list` и сравнить содержимое.
2. **Zip-архивы дистрибуции** (см. раздел "Windows Build Distribution" выше) — `zali-windows-source.zip` и подобные экспорты кода в корне репо или `~/Downloads` — это снапшоты реального рабочего дерева на конкретную дату. Проверять `unzip -l`, дату модификации и **сверять SHA1** (`shasum`) прежде чем считать находку новой информацией — может быть побайтовая копия уже виденного. Помнить: windows-source zip **не включает** `macOS/`, `src/main.rs`, `ZaliArchiverSDK/Swift/` (старые имена — эти zip-архивы датированы до реорганизации 2026-07-12) — для macOS-файлов нужен архив вида `*-full-code.zip`/`*-all-code.zip`/`*-full-current-code.zip`.
3. **Перебор git-объектов** (`git fsck --unreachable`) может найти висячие blob'ы от старых коммитов/сбросов — но для больших репозиториев поштучный `git cat-file -p` на каждый хэш непрактично медленный; использовать один процесс `git cat-file --batch` с потоковым чтением через небольшой Python-скрипт.
4. **Кросс-сверка с другим клиентом**: Windows (`apps/windows/src/native.rs`) и macOS реализуют одну и ту же логику параллельно (IPC-бридж, ключи шифрования, реконнект WS, голосовой транспорт). Если один клиент пострадал, а другой цел и **реально свежий** (проверить по `git log`/датам файлов, а не предполагать), можно восстановить логику по образцу через `graphify query`/явное сравнение построчно — но не копировать бездумно: платформенные различия (например, macOS Keychain vs Windows `keyring` crate) означают, что порт требует адаптации, а не 1:1 копирования.

### Как проверять восстановленный/реконструированный код — не гадать, а компилировать

- После восстановления/дописывания кода **пересобирать и читать реальные ошибки компилятора** как чек-лист недостающих сигнатур — не пытаться угадать всё сразу. `swift build`/`cargo build` даёт точный список того, что реально используется вызывающим кодом (WebView.swift и т.п.), и это надёжнее, чем реконструкция "по памяти".
- graphify-граф (`graphify-out/graph.json`) хранит **только структуру** (какая функция существовала, на какой строке, что вызывала) — не тела функций. Полезен, чтобы понять, что *должно* существовать и с чем связано, но не для восстановления реализации 1:1.
- `bundle_web.py` — это сам по себе генерируемый/поддерживаемый код, который может незаметно деградировать (в этом инциденте восстановленная версия знала только про 5 JS-модулей вместо реальных 13, и не генерировала `native_types.js`/`BridgeProtocol.generated.swift` из `bridge_protocol.json`). После восстановления любого build-скрипта — **запустить его** и проверить, что вывод (счётчики файлов, сгенерированные артефакты) соответствует ожиданиям, а не просто "скрипт не упал".
- Финальная проверка любого клиентского фикса — реально собрать `.app`/бинарник и запустить (`open ZaliMessenger.app` + `ps aux` + проверка что процесс не упал), а не только "компилируется".

## Key Development Notes

- The server Cargo package is named `zali_server` (underscore), not `zali-server`. Use `cargo check -p zali_server`.
- `web/src/interface.js` is the canonical source; `bundle_web.py` copies it into macOS and Windows embedded assets. Always edit the source, then bundle.
- If SwiftPM reports a stale module cache after moving the project, remove `apps/macos/.build` and rebuild.
- Runtime artifacts to keep out of version control: `zali_messenger.db`, `uploads/`, `target/`, `apps/macos/.build/`, `dist/`.
- Server env config: copy `.env.example` (repo root) to `.env`; set a real `JWT_SECRET` for any non-local deployment.
