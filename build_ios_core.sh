#!/bin/bash
# Cross-compiles the Rust Core crate for iOS (device + simulator) and packages
# it as an XCFramework the iOS Xcode project links against. Mirrors
# build_macos_core.sh's role for the macOS SwiftPM build — run this whenever
# Core/src/*.rs changes, before building the iOS app.
set -euo pipefail

cd "$(dirname "$0")"

rustup target add aarch64-apple-ios aarch64-apple-ios-sim >/dev/null 2>&1 || true

cd Core
cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim
cd ..

rm -rf iOS/Frameworks/ZaliCore.xcframework
mkdir -p iOS/Frameworks

xcodebuild -create-xcframework \
    -library Core/target/aarch64-apple-ios/release/libzali_messenger_core.a -headers Core/include \
    -library Core/target/aarch64-apple-ios-sim/release/libzali_messenger_core.a -headers Core/include \
    -output iOS/Frameworks/ZaliCore.xcframework

echo "✅ Rust Core собран для iOS (device + simulator) и упакован в iOS/Frameworks/ZaliCore.xcframework"
echo "Дальше: cd iOS && xcodegen generate && open ZaliMessenger.xcodeproj"
