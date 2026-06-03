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

ensure_turn_server

# 1. Сборка Rust-ядра
echo "⚙️  Сборка Rust Core..."
cd Core && cargo build --release && cd ..

# 2. Сборка Swift-приложения через Swift Package Manager
echo "🚀 Сборка SwiftUI приложения через SPM..."
cd macOS
swift build -c release

# 3. Запуск приложения
echo "✅ Сборка завершена! Запуск..."
.build/release/ZaliMessenger
