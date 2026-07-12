#!/bin/bash
# Универсальный скрипт для сборки и запуска ZaliMessenger на macOS через SPM (без Xcode)

set -e

TURN_CONF="/opt/homebrew/etc/turnserver.conf"
TURN_PID_FILE="/tmp/zali-turnserver.pid"

ensure_turn_server() {
    if lsof -nP -iTCP:3478 -iUDP:3478 >/dev/null 2>&1; then
        echo "✅ TURN server уже запущен"
        return 0
    fi

    if ! command -v turnserver >/dev/null 2>&1; then
        echo "⚠️  turnserver не найден. Установи coturn через Homebrew: brew install coturn"
        return 1
    fi

    if [ ! -f "$TURN_CONF" ]; then
        cat > "$TURN_CONF" <<'EOF'
listening-port=3478
fingerprint
lt-cred-mech
realm=zali.local
server-name=zali-turn
user=zali:turnpass
min-port=49160
max-port=49200
no-cli
allow-loopback-peers
verbose
EOF
    fi

    echo "🌐 Запуск локального TURN..."
    nohup turnserver -c "$TURN_CONF" > /tmp/zali-turnserver.log 2>&1 &
    echo $! > "$TURN_PID_FILE"
    sleep 2
}

cd "$(dirname "$0")/.."

ensure_turn_server

# 1. Сборка Rust-ядра
echo "⚙️  Сборка Rust Core..."
cd core && cargo build --release && cd ..

# 2. Сборка Swift-приложения через Swift Package Manager
echo "🚀 Сборка SwiftUI приложения через SPM..."
swift build -c release --package-path apps/macos

# 3. Оборачиваем бинарник в .app-бандл — без Info.plist/CFBundleIdentifier
#    UNUserNotificationCenter крашится с bundleProxyForCurrentProcess is nil.
PROJECT_ROOT=$(pwd)
APP_NAME="ZaliMessenger"
APP_BUNDLE="$PROJECT_ROOT/$APP_NAME.app"
BUILD_DIR="$PROJECT_ROOT/apps/macos/.build/release"

echo "📂 Создание структуры бандла..."
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"
cp "$BUILD_DIR/$APP_NAME" "$APP_BUNDLE/Contents/MacOS/"

cat > "$APP_BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>com.zali.messenger</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>ZaliMessenger uses the microphone for voice calls and voice channels.</string>
</dict>
</plist>
EOF

chmod +x "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

# 4. Запуск приложения (напрямую из бандла — логи остаются в терминале)
echo "✅ Сборка завершена! Запуск..."
"$APP_BUNDLE/Contents/MacOS/$APP_NAME"
