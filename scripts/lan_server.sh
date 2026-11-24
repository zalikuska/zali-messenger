#!/bin/sh
# Прод-подобный сервер для проверки с других машин по локальной сети.
#
# Отличия от `zali-server` из .claude/launch.json: release-сборка, настоящий
# (случайный) JWT_SECRET, отдельный каталог данных (чистая БД, не dev-база из
# корня репо), слушает 0.0.0.0, SFU объявляет клиентам LAN-адрес этой машины,
# гостевой режим выключен. Порт 3000, SFU — 3479 (UDP+TCP).
#
#   scripts/lan_server.sh                 # LAN-адрес определяется сам
#   ZALI_LAN_IP=192.168.0.50 scripts/lan_server.sh
#   ZALI_LAN_DATA=/путь scripts/lan_server.sh
#
# Клиент Windows под этот сервер собирается так: scripts/build_windows_lan.sh
set -eu
cd "$(dirname "$0")/.."

LAN_IP="${ZALI_LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
[ -n "$LAN_IP" ] || { echo "Не удалось определить LAN-адрес: задайте ZALI_LAN_IP" >&2; exit 1; }

DATA="${ZALI_LAN_DATA:-$HOME/.zali-lan}"
mkdir -p "$DATA"
chmod 700 "$DATA"
if [ ! -s "$DATA/jwt_secret" ]; then
  openssl rand -hex 32 > "$DATA/jwt_secret"
  chmod 600 "$DATA/jwt_secret"
fi

# Секрет переживает рестарты: иначе после каждого перезапуска клиенты разлогинивались бы.
export JWT_SECRET="$(cat "$DATA/jwt_secret")"
export ZALI_DATA_DIR="$DATA"
export BIND_ADDR="0.0.0.0:3000"
export ALLOWED_ORIGINS="https://msgs.zalikus.org,zali://localhost,http://$LAN_IP:3000"
export ALLOW_GUEST_MODE=false
# Без TLS: Secure-cookie по http браузер не отправит.
export AUTH_COOKIE_SECURE=false
# Перед сервером нет прокси — иначе клиент сам выбирал бы себе корзину rate limit.
export TRUSTED_PROXY_MODE=false
export SFU_UDP_PORT=3479
export SFU_PUBLIC_IP="$LAN_IP"
export RUST_LOG="${RUST_LOG:-zali_server=info,tower_http=warn}"

k="$(grep -E '^KLIPY_APP_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
[ -z "$k" ] || export KLIPY_APP_KEY="$k"

echo "LAN-адрес: $LAN_IP  данные: $DATA" >&2
CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_DEBUG=true \
  cargo build --release --manifest-path server/Cargo.toml -p zali_server
exec server/target/release/zali_server
