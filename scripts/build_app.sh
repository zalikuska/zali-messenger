#!/bin/bash

set -e

# Пути
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
BUILD_DIR="$PROJECT_ROOT/apps/macos/.build/release"
APP_NAME="ZaliMessenger"
APP_BUNDLE="$PROJECT_ROOT/$APP_NAME.app"
# Bump this on every release published via POST /api/version (see CLAUDE.md's
# "Publishing a client release" section) — the in-app updater compares it
# against the server's app_releases.version for platform=macos. Scheme is
# MAJOR.MINOR{a|b|r}BUILD (r > b > a, see compareVersions in interface.js);
# unlike apps/windows/Cargo.toml, CFBundleShortVersionString isn't SemVer-locked
# so this can hold the display version directly.
APP_VERSION="0.2b35"

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
cd core && cargo build --release
cd ..

# 2. Сборка Swift приложения
echo "🍎 Сборка Swift приложения..."
swift build -c release --package-path apps/macos

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

# 4c. Rust-ядро внутрь бандла.
#
# `core` собирается сразу как cdylib+staticlib, и линкер по `-l` предпочитает
# .dylib — то есть бинарник получает зависимость на
# `<repo>/core/target/release/deps/libzali_messenger_core.dylib` ПО АБСОЛЮТНОМУ
# ПУТИ. На машине сборки это незаметно, а у любого, кто скачает релиз, dyld не
# найдёт библиотеку и приложение не стартует вообще. Кладём её в
# Contents/Frameworks и переписываем ссылку на @rpath.
CORE_DYLIB_NAME="libzali_messenger_core.dylib"
CORE_DYLIB_SRC="$PROJECT_ROOT/core/target/release/$CORE_DYLIB_NAME"
LINKED_CORE="$(otool -L "$APP_BUNDLE/Contents/MacOS/$APP_NAME" | awk '/zali_messenger_core/ {print $1; exit}')"
if [ -n "$LINKED_CORE" ]; then
    if [ ! -f "$CORE_DYLIB_SRC" ]; then
        echo "❌ Бинарник ссылается на $LINKED_CORE, а $CORE_DYLIB_SRC не найден"
        exit 1
    fi
    mkdir -p "$APP_BUNDLE/Contents/Frameworks"
    cp "$CORE_DYLIB_SRC" "$APP_BUNDLE/Contents/Frameworks/$CORE_DYLIB_NAME"
    install_name_tool -id "@rpath/$CORE_DYLIB_NAME" "$APP_BUNDLE/Contents/Frameworks/$CORE_DYLIB_NAME"
    install_name_tool -change "$LINKED_CORE" "@rpath/$CORE_DYLIB_NAME" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
    install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP_BUNDLE/Contents/MacOS/$APP_NAME" 2>/dev/null || true
    echo "📦 Rust-ядро вложено в бандл: Contents/Frameworks/$CORE_DYLIB_NAME"
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
    <string>$APP_VERSION</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>ZaliMessenger uses the microphone for voice calls and voice channels.</string>
    <key>NSCameraUsageDescription</key>
    <string>ZaliMessenger uses the camera for video calls.</string>
</dict>
</plist>
EOF

chmod +x "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

# 6. Подпись бандла. Обязательно ПОСЛЕ записи Info.plist — подпись, наложенная
# на голый бинарник линкером во время `swift build` (ad-hoc), не привязана к
# Info.plist ("Info.plist=not bound" в `codesign -dv`), и именно поэтому
# UNUserNotificationCenter.requestAuthorization падал с "UNErrorDomain error 1"
# на macOS 26: без стабильной, привязанной к Info.plist подписи система не
# может однозначно идентифицировать приложение для выдачи разрешения на
# уведомления. Подписываем локальным self-signed сертификатом "ZaliMessenger
# Local" (создаётся один раз через Keychain Access / security import, не
# требует платного Apple Developer аккаунта) — если сертификата ещё нет на
# этой машине, откатываемся на ad-hoc и предупреждаем, что push-уведомления не
# заработают, а не роняем сборку.
SIGN_IDENTITY="ZaliMessenger Local"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_IDENTITY"; then
    echo "🔏 Подпись бандла ($SIGN_IDENTITY)..."
    codesign --force --deep --sign "$SIGN_IDENTITY" "$APP_BUNDLE"
else
    echo "⚠️  Сертификат '$SIGN_IDENTITY' не найден в Keychain — подписываем ad-hoc."
    echo "   Push-уведомления не будут работать (UNErrorDomain error 1). См. CLAUDE.md."
    codesign --force --deep --sign - "$APP_BUNDLE"
fi

# 7. Бандл обязан быть самодостаточным: ни одной ссылки на пути этого репозитория.
# tail -n +2 — первая строка вывода otool это путь к самому файлу, не зависимость.
LEAKED="$(otool -L "$APP_BUNDLE/Contents/MacOS/$APP_NAME" | tail -n +2 | grep -F "$PROJECT_ROOT" || true)"
if [ -n "$LEAKED" ]; then
    echo "❌ Бандл ссылается на пути вне себя — на другой машине не запустится:"
    echo "$LEAKED"
    exit 1
fi

echo "✅ Готово! Приложение создано: $APP_BUNDLE"
echo "👉 Теперь вы можете запустить его командой: open $APP_BUNDLE"
echo "Или просто найдите его в папке проекта через Finder и кликните дважды."
