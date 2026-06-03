# ZaliMessenger Development Notes

## Project Map

- `Core/` - Rust core library and C ABI used by native clients.
- `ZaliArchiverSDK/Rust/` - archive format SDK used by `Core`.
- `Server/` - Axum backend, SQLite storage, uploads, auth, WebSocket delivery.
- `Web/` - browser/WKWebView UI sources. `bundle_web.py` generates `Web/app.js` and macOS web assets.
- `macOS/` - Swift Package Manager app that links `Core/target/release/libzali_messenger_core.a`.
- `Windows/` - Rust desktop shell with WRY/TAO, embedded web assets, and a native bridge for message sending/style persistence.

## Useful Commands

```bash
# Rebuild generated web assets
python3 bundle_web.py

# Check the Rust core
cd Core
cargo test

# Run the server
cd Server
cargo run

# Build Rust core for the Swift app
cd Core
cargo build --release

# Build the SwiftPM macOS app
swift build --package-path macOS

# Build a local .app bundle
./build_app.sh

# Build the Windows app bundle
./build_windows_app.ps1

# Run the Windows client directly during development
cargo run --manifest-path Windows/Cargo.toml
```

On Windows, the build expects Rust MSVC, Python 3, and the Edge WebView2 Runtime. The packaged binary is copied to `dist/windows/ZaliMessenger.exe`.

## Current Notes

- The root folder and `Core/`, `Server/`, `Windows/` each contain their own `.git` folder with no commits yet. Choose one layout before the first real commit: one root repository, or separate repositories/submodules.
- Runtime files such as `Server/zali_messenger.db`, `Server/uploads/`, `target/`, `.build/`, `.DS_Store`, and generated app bundles should stay out of version control.
- Windows persists custom styles and network defaults under the user profile folder; deleting that state resets the native bridge cache without touching source files.
- The Windows voice transport is native now; no browser voice socket auth workaround is needed for desktop builds.
- If SwiftPM reports a stale module cache after moving the project, remove `macOS/.build` and rebuild.
- `Server/.env.example` documents local server settings. For production, set a real `JWT_SECRET` and disable guest mode.
