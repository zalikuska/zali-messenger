#!/bin/bash
# Cross-compiles the Rust Core crate for Android (arm64-v8a device + x86_64
# emulator) and drops the resulting .so files into app/src/main/jniLibs, where
# Gradle picks them up automatically. Mirrors build_ios_core.sh's role for the
# iOS XCFramework. Run this whenever core/src/*.rs changes, before building the APK.
#
# Requires:
#   - Android NDK (set ANDROID_NDK_HOME, or install via Android Studio's SDK Manager)
#   - cargo-ndk: `cargo install cargo-ndk`
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    echo "❌ ANDROID_NDK_HOME is not set. Install the NDK via Android Studio's SDK Manager" >&2
    echo "   (SDK Manager → SDK Tools → NDK), then:" >&2
    echo "   export ANDROID_NDK_HOME=\$HOME/Library/Android/sdk/ndk/<version>" >&2
    exit 1
fi

if ! command -v cargo-ndk >/dev/null 2>&1; then
    echo "❌ cargo-ndk not found. Install it with: cargo install cargo-ndk" >&2
    exit 1
fi

rustup target add aarch64-linux-android x86_64-linux-android >/dev/null 2>&1 || true

mkdir -p apps/android/app/src/main/jniLibs

cargo ndk \
    -t arm64-v8a \
    -t x86_64 \
    -o apps/android/app/src/main/jniLibs \
    build --release --manifest-path core/Cargo.toml --features android

echo "✅ Rust Core собран для Android (arm64-v8a + x86_64) и скопирован в apps/android/app/src/main/jniLibs"
echo "Дальше: cd apps/android && ./gradlew assembleDebug"
