#!/bin/bash

set -e

# Пути
PROJECT_ROOT=$(pwd)
BUILD_DIR="$PROJECT_ROOT/macOS/.build/release"
APP_NAME="ZaliMessenger"
APP_BUNDLE="$PROJECT_ROOT/$APP_NAME.app"

TURN_CONF="/opt/homebrew/etc/turnserver.conf"

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
    sleep 2
}

echo "🚀 Начинаем сборку автономного приложения $APP_NAME..."

ensure_turn_server

# 1. Сборка Rust ядра
echo "📦 Сборка Rust ядра..."
cd Core && cargo build --release
cd ..

# 2. Сборка Swift приложения
echo "🍎 Сборка Swift приложения..."
swift build -c release --package-path macOS

# 3. Создание структуры .app
echo "📂 Создание структуры бандла..."
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# 4. Копирование бинарного файла
cp "$BUILD_DIR/$APP_NAME" "$APP_BUNDLE/Contents/MacOS/"

# 4b. Копирование SwiftPM resource bundle (Package.swift: .copy("Resources/Web")).
# Без этого шага Contents/Resources оставался пустым — Bundle.module не находил
# index.html/app.js, и WKWebView не мог отрисовать интерфейс вообще.
RESOURCE_BUNDLE="$BUILD_DIR/${APP_NAME}_${APP_NAME}.bundle"
if [ -d "$RESOURCE_BUNDLE" ]; then
    cp -R "$RESOURCE_BUNDLE" "$APP_BUNDLE/Contents/Resources/"
else
    echo "⚠️  Resource bundle не найден: $RESOURCE_BUNDLE (WebView не сможет загрузить UI)"
    exit 1
fi

# 5. Создание Info.plist
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

echo "✅ Готово! Приложение создано: $APP_BUNDLE"
echo "👉 Теперь вы можете запустить его командой: open $APP_BUNDLE"
echo "Или просто найдите его в папке проекта через Finder и кликните дважды."
