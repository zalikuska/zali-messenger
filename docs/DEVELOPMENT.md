# ZaliMessenger Development Notes

## Project Map

- `core/` - Rust core library and C ABI used by native clients.
- `sdk/Rust/` - archive format SDK used by `core`.
- `server/` - Axum backend, SQLite storage, uploads, auth, WebSocket delivery.
- `web/` - browser/WKWebView UI sources. `scripts/bundle_web.py` generates `web/app.js` and macOS web assets.
- `apps/macos/` - Swift Package Manager app that links `core/target/release/libzali_messenger_core.a`.
- `apps/windows/` - Rust desktop shell with WRY/TAO, embedded web assets, and a native bridge for message sending/style persistence.

## Useful Commands

```bash
# Rebuild generated web assets
python3 scripts/bundle_web.py

# Check the Rust core
cd core
cargo test

# Run the server
cargo run --manifest-path server/Cargo.toml

# Build Rust core for the Swift app
cd core
cargo build --release

# Build the SwiftPM macOS app (Swift shell — primary macOS client)
swift build --package-path apps/macos

# Build a local .app bundle (Swift shell)
./scripts/build_app.sh

# Build the macOS Rust shell (experimental, not primary — same code as Windows)
./scripts/build_macos_rust_app.sh          # → dist/macos-rust/ZaliMessengerRust.app
./scripts/run_macos_rust_app.sh            # собрать и сразу запустить

# Build the Windows app bundle
./scripts/build_windows_app.ps1

# Run the Windows client directly during development
cargo run --manifest-path apps/windows/Cargo.toml
```

On Windows, the build expects Rust MSVC, Python 3, and the Edge WebView2 Runtime. The packaged binary is copied to `dist/windows/ZaliMessenger.exe`.

## Current Notes

- Runtime files such as `zali_messenger.db` (repo root), `uploads/` (repo root), `target/`, `.build/`, `.DS_Store`, and generated app bundles should stay out of version control.
- Windows persists custom styles and network defaults under the user profile folder; deleting that state resets the native bridge cache without touching source files.
- The Windows voice transport is native now; no browser voice socket auth workaround is needed for desktop builds.
- The Swift app (`apps/macos/`, `./scripts/build_app.sh`) is the primary macOS client, as of 2026-07-03. The macOS Rust shell (`scripts/build_macos_rust_app.sh` / `scripts/run_macos_rust_app.sh`, reuses the `apps/windows/` crate) was tried as a replacement but reverted: voice calls and notifications were never confirmed working end-to-end in real use. It's kept buildable as an experimental option — both bundles coexist (`com.zali.messenger` vs `com.zali.messenger.rust`). Notes if picking it back up: config lives in `~/Library/Application Support/ZaliMessenger/`; device identity (not the crypto key — no Keychain involved, see below) is shared with the Swift app via a plain JSON file in that same directory so the two shells register as the same server-side device instead of each minting a new one; media capture (mic/camera) is granted via an objc runtime hook on wry's UIDelegate — main frame + own origin only; startup writes a `DIAG_ENV;...` trace line confirming secure context/WebCrypto/WebRTC; notifications require the .app bundle.
- Do not add new Keychain usage to this project — cross-app consent dialogs are unwanted here. Prefer plain files under `~/Library/Application Support/ZaliMessenger/` (both macOS clients already read/write there unsandboxed, no prompt).
- If SwiftPM reports a stale module cache after moving the project, remove `apps/macos/.build` and rebuild.
- `.env.example` (repo root) documents local server settings. For production, set a real `JWT_SECRET` and disable guest mode.
