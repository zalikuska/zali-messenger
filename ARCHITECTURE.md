# Architecture

This document explains how the pieces of this repo fit together: what each
directory is for, how a message actually travels from one client to another,
which files are hand-written source vs. generated build output, and where the
bug-prone hot spots are. It complements `CLAUDE.md` (build commands, deploy
steps, invariants established by past fixes) rather than replacing it — read
that file for "how do I build/deploy/debug X", read this one for "how is the
system put together and why".

## 1. The five things that get built

| Directory | What it is | Language | Built by |
|---|---|---|---|
| `src/main.rs` | The server: HTTP API, WebSocket hub, SQLite (~8000 lines; auth, contacts, servers/channels, messages/attachments) | Rust (Axum) | `cargo run` / `cargo check -p zali_server` |
| `src/voice.rs` | Voice call signaling split out of `main.rs`: `VoiceRoom` state, join/leave/route/invite handling, the `voice_*` WebSocket message dispatcher | Rust | part of the `zali_server` binary |
| `src/devices.rs` | Device trust / E2E key envelope / cloud vault / history-ticket subsystem split out of `main.rs`: device registration/approval/revocation, `post_key_envelope`/`get_key_envelopes`, `post_vault_event`/`get_vault_events`, history tickets, transparency log | Rust | part of the `zali_server` binary |
| `macOS/` | The primary desktop client (SwiftUI + WKWebView shell) | Swift | `swift build --package-path macOS`, `./build_app.sh` |
| `Windows/src/native.rs` | The Windows client (WRY/TAO shell). Also builds as an **experimental, non-primary** macOS shell | Rust | `cargo run --manifest-path Windows/Cargo.toml`, `build_windows_app.ps1` |
| `Core/` | Shared Rust core (crypto, .zali archive I/O, a tiny command bus) compiled to a static lib and linked into the Swift app via FFI | Rust → C ABI | `cargo build --release` inside `Core/`, consumed by `macOS/Sources/CoreBridge` |
| `ZaliArchiverSDK/` | The `.zali` archive format itself. `Rust/` is used by the server and the Windows/Rust-shell client; `Swift/` (`ZaliArc.swift`) is a parallel hand-written mirror used by the Swift client | Rust + Swift | Part of `Core`/`Windows` builds; `Swift/` compiles directly into the SwiftPM target |

All UI logic — for **every** client — lives in one place:

```
Web/src/interface.js   (~13,800 lines, one class: ZaliInterface)
```

This runs unmodified inside a WKWebView (macOS) or WRY WebView2 (Windows). The
native layer on each platform is a thin bridge: it exposes a small set of
native calls (send HTTP request, read/write local storage, show a
notification, open a voice socket) and otherwise gets out of the way. **If
you're fixing a UI, chat, encryption-key, or notification-content bug, it is
almost always in `interface.js`, not in the Swift or Rust shell.**

## 2. Where a message actually goes

```
Sender's interface.js
  → builds a .zali archive (AES-256-GCM, chunked) client-side
  → postNativeMessage({ type: 'sendMessage', ... })
  → native shell POSTs multipart/form-data to /api/upload  (or /api/servers/:id/channels/:id/messages for a channel)
Server (src/main.rs, upload_message_with_context)
  → validates the "ZALIMSSG" archive magic header
  → writes the blob to uploads/<uuid>.zali, inserts a row in `messages`
  → deliver_to_user() pushes a small JSON pointer (id, client_id, sender,
    receiver — NOT the message content) over the recipient's live WebSocket
Recipient's native shell
  → receives the WS push, calls back into interface.js
  → interface.js calls downloadMessage → GET /api/download/:id
  → decrypts the archive locally using the conversation's E2E key
```

The WebSocket only ever carries a *pointer*; the encrypted bytes always travel
over the authenticated HTTP download endpoint. This is why `clientId` matters
so much throughout the outbox code (see §4) — it's the only reliable way to
match "the thing I just sent" against "the thing the server echoed back",
since two different messages can have identical visible text.

## 3. E2E key transfer ("передача ключей по облаку")

Two independent mechanisms move conversation keys between devices, and both
are load-bearing:

1. **Key envelopes** (`/api/key-envelopes`, table `conversation_key_envelopes`):
   point-to-point delivery, one conversation key, addressed to one specific
   recipient username. Used when you start talking to someone from a device
   that doesn't have the key yet. The server no longer requires device
   registration/approval to deliver an envelope — `recipientDeviceId` and
   `senderDeviceId` are optional on the wire and unvalidated server-side
   (stored as the literal string `"any"` when omitted, purely so the
   `ON CONFLICT` upsert still dedups correctly). **This does not mean the
   envelope content itself is unencrypted** — the client still must know the
   recipient device's real public key to run `encryptConversationKeyEnvelope`
   (ECDH), so per-device public keys (fetched via
   `/api/users/:username/devices`) are still load-bearing for the actual
   encryption; only the server-side "is this device pre-approved" gate was
   removed.
2. **Cloud vault** (`/api/vault/events`, table `account_vault_events`): a
   passphrase-encrypted bundle of *all* of a user's conversation keys,
   published so a brand-new device belonging to the same account can recover
   every key at once instead of waiting for per-conversation envelopes.
   `deviceId` here is intentionally optional (see the comment on
   `VaultEventPayload` in `main.rs`) — the client doesn't always know its own
   device id yet at the point it needs to publish.

`resolveConversationCryptoKey` in `interface.js` is the entry point that
decides, for a given conversation, whether to trust a locally-cached key, wait
for an incoming envelope, or pull the cloud vault snapshot. It's one of the
more subtle pieces of this codebase — see the inline comments there before
touching it, and `[[project_e2e_account_switch]]`-style history in
`CLAUDE.md`.

## 4. The outbox (why sending a message is not just "POST and done")

`interface.js` keeps a persisted queue (`pendingOutbox`) instead of sending
messages inline, because native shells can be killed, reloaded, or lose
network mid-send. The important invariants, all encoded in
`flushPendingOutbox` / `isPendingMessageAlreadyLoaded`:

- **Proof of delivery is `clientId` equality, not content equality.** Two
  messages with identical text and attachments are different messages; only
  a server echo carrying the same `clientId` proves *this specific* send
  succeeded.
- **Attachment bytes (`dataUrl`) are not persisted** across a restart
  (`localStorage` quota) — they live in an in-memory cache
  (`cachePendingOutboxAttachments`) for the current process lifetime only. If
  they're gone after a restart, the message fails loudly rather than sending
  silently without its files.
- **`inFlight` self-heals** after 45s of no response, so a lost native
  callback doesn't wedge a message in "sending" forever.

## 5. Live connections: WebSocket ping/reconnect

There are **two** separate WebSocket connections per session: one for
messages/presence (`run_message_transport` / `NetworkService`'s main socket)
and one for voice signaling (`run_voice_transport` / the voice-specific
socket). Both need their own heartbeat because a TCP connection can go
silently dark (sleep/wake, NAT idle timeout) without a close frame ever
arriving — `reader.next()` just never resolves. Both now ping every 25s on
every platform (Swift, Rust/Windows, Rust/macOS-shell) and treat a failed
ping the same as a closed socket. **If you add a third long-lived socket,
give it the same heartbeat — this is not automatic.**

The "Подключено"/connected badge is driven exclusively by real socket
state (connect/disconnect events), not by "did we set a session" — it used to
be forced `true` on login regardless of whether a socket existed at all.

## 6. Known risk areas / where bugs cluster

- **`Web/src/interface.js` (~13,800 lines) and `src/main.rs` (~8,000 lines,
  down from ~9,700 after the `voice.rs`/`devices.rs` extractions — see §7)**
  are both single-file monoliths. There is a parallel, unfinished
  modularization experiment under `Web/src/modules/` + `Web/src/bus.js` /
  `loader.js` / `styler.js` / `bootstrap.js` (bundled by `bundle_web.py`
  alongside `interface.js` itself). It is **not a replacement** for
  `interface.js` — it's additional infrastructure that gets concatenated
  *with* it into the final bundle. Don't assume logic has moved there; check
  `bundle_web.py`'s `js_files` list for the true build order.
- **Two independent `.zali` archive implementations** (`ZaliArchiverSDK/Rust`
  and `ZaliArchiverSDK/Swift/ZaliArc.swift`) must stay bit-for-bit compatible
  (same nonce-counter scheme, same PBKDF2 iteration count). A fix made in one
  needs to be checked against the other.
- **`bundle_web.py` fans one source file out to five locations**:
  `macOS/Sources/ZaliMessenger/Assets.swift` (the one that's actually loaded
  at runtime via `WebAssets.html`), `macOS/Sources/ZaliMessenger/Resources/Web/{index.html,app.js,style.css,bridge_protocol.json,native_types.js}`
  (bundled as SwiftPM resources, but only `bridge_protocol.json` is read from
  there at runtime — the rest are dead weight kept only because
  `Package.swift` copies the whole `Resources/Web` directory), and
  `Web/app.js` (explicitly for opening `Web/index.html` directly in a browser
  during debugging). **If you edit JS and don't see the change, you forgot to
  run `python3 bundle_web.py`.**
- **The root `.zip` files** (`zali-messenger-*.zip`, `zali-windows-*.zip`) are
  not build output or stray clutter — they are deliberate point-in-time
  snapshots of the working tree, kept after a real incident where
  `git checkout -f` + `git pull --ff-only` deleted untracked-but-load-bearing
  files (see `CLAUDE.md`'s "Git Safety" section). Do not delete them as part
  of a cleanup pass without checking that section first.

## 7. Modularizing the monoliths: what's been done, what's left

`src/main.rs` has had two subsystems pulled out so far:
- `src/voice.rs` — `VoiceRoom` state, join/leave/route/invite, the `voice_*`
  WS dispatcher (~780 lines).
- `src/devices.rs` — device trust (register/approve/revoke), E2E key envelope
  delivery, cloud vault events, history tickets, transparency log
  (~1125 lines).

Both were pure code motion (no logic changes), verified by `cargo check`/
`cargo build` being clean and the full E2E test suite passing unchanged
before and after. This is the template for extracting anything else the same
way:

1. Find the self-contained cluster (a struct + the functions that only touch
   it), grep every call site to confirm nothing outside the cluster reaches
   into its private internals directly.
2. Move it verbatim into `src/<name>.rs`, add `mod <name>;` + `use
   <name>::{...the symbols the rest of main.rs still calls...};` in
   `main.rs`. Rust's privacy rule (private items are visible to the defining
   module *and its descendants*) means submodules of the crate root can see
   `main.rs`'s private helpers without any visibility changes — only the
   symbols moving *into* the new module need `pub(crate)`.
3. `cargo check` finds every missed reference immediately (it's a compile
   error, not a runtime surprise) — this is why doing this in Rust/Swift is
   safe in a way it fundamentally isn't in `interface.js`, which has no
   compiler to catch a missed call site.

Next candidate in `main.rs`: servers/channels (create/update/delete server,
channels, roles, members, invites, avatars/banners — the largest remaining
cluster, several thousand lines). Message upload/download/history and the
top-level auth/contacts endpoints are more entangled with shared helpers
(`deliver_to_user`, `resolve_history_access` from `devices.rs`, reaction
state loading) and would need more careful call-site auditing before
extraction.

`Web/src/interface.js` (~13,800 lines, one class) does **not** have this
safety net — there's no compiler to catch a dropped call site, only runtime
behavior. Splitting it needs either an incremental extraction verified by
manually driving every affected feature in a live app each step, or adopting
TypeScript/JSDoc type-checking first so mistakes surface before runtime. That
is a dedicated, carefully-tested project of its own, not something to fold
into a single cleanup pass — especially given this repo's documented history
of losing work to over-eager bulk changes. The unfinished `Web/src/modules/`
split (`bus.js`, `loader.js`, `styler.js`, `bootstrap.js` — see §6) is a
reasonable skeleton to build on if that work is picked up.
