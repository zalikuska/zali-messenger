# Windows Build Guide

This project can be built on Windows with the native Rust shell in `apps/windows/`.

## Requirements

- Windows 10 or Windows 11.
- Rust stable with the MSVC toolchain.
- Visual Studio 2022 Build Tools or Visual Studio 2022 with:
  - Desktop development with C++
  - Windows 10/11 SDK
- Python 3.
- Microsoft Edge WebView2 Runtime on the target machine.

## Build

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_app.ps1
```

To build and launch immediately:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_app.ps1 -Run
```

The packaged binary is copied to:

```text
dist/windows/ZaliMessenger.exe
```

## Development Run

For a faster local loop without packaging:

```powershell
cargo run --manifest-path apps\windows\Cargo.toml
```

## Before Testing Voice

- Start the server first.
- Make sure your account/session is signed in.
- Verify the microphone permission prompt on first launch.
- If voice fails to connect, check that the WebSocket URL points to the server you are running.
