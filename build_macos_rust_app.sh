#!/bin/bash
# Собирает Rust-шелл (общий код с Windows-клиентом, Windows/src) как macOS .app.
# Экспериментальный, НЕ основной клиент — основной снова Swift-версия
# (./build_app.sh → ZaliMessenger.app, см. историю: миграция на Rust была
# опробована 2026-07 и отменена, т.к. голос/уведомления не подтверждены реальным
# использованием). Оба .app могут стоять рядом (разные bundle id), если
# понадобится вернуться к Rust-шеллу.
#
# Media capture (getUserMedia) через objc-хук на UIDelegate wry — реализовано,
# но end-to-end звонок с реальным звуком не проверялся. Уведомления показываются
# только при запуске из .app-бандла (этот скрипт как раз собирает бандл и
# подписывает его ad-hoc подписью).
#
# Переопределение сервера — как у Windows-сборки, до бандлинга:
#   ZALI_API_BASE_URL=https://msgs.zalikus.org ZALI_WS_BASE_URL=wss://msgs.zalikus.org ./build_macos_rust_app.sh
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="ZaliMessengerRust"
BUNDLE_ID="com.zali.messenger.rust"
BIN_NAME="zali_messenger_win"
DIST_DIR="dist/macos-rust"
APP_DIR="$DIST_DIR/$APP_NAME.app"

echo "==> Бандлинг веб-ассетов (bundle_web.py)"
python3 bundle_web.py

echo "==> Сборка Rust-бинарника (release)"
cargo build --release --manifest-path Windows/Cargo.toml

echo "==> Сборка бандла $APP_NAME.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "Windows/target/release/$BIN_NAME" "$APP_DIR/Contents/MacOS/$APP_NAME"
chmod +x "$APP_DIR/Contents/MacOS/$APP_NAME"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>Zali Messenger (Rust)</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>Микрофон нужен для голосовых звонков.</string>
    <key>NSCameraUsageDescription</key>
    <string>Камера может использоваться для вложений.</string>
</dict>
</plist>
PLIST

# Ad-hoc подпись: без неё Keychain и уведомления ведут себя нестабильно,
# а Gatekeeper ругается сильнее. Для распространения заменить на Developer ID.
codesign --force --sign - "$APP_DIR"

echo "✅ Готово: $APP_DIR"
echo "   Запуск:  open \"$APP_DIR\""
echo "   Логи:    RUST_LOG=info \"$APP_DIR/Contents/MacOS/$APP_NAME\""
