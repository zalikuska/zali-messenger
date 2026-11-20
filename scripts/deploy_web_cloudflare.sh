#!/usr/bin/env bash
# Собирает standalone веб-клиент и выкладывает его на Cloudflare (Worker со статикой).
# Бандл (web/app.js, web/wasm-pkg/) в git не лежит, поэтому собираем локально.
#   scripts/deploy_web_cloudflare.sh            # build + deploy
#   scripts/deploy_web_cloudflare.sh --no-deploy # только собрать dist-web/
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/scripts/build_web_wasm.sh"
python3 "$ROOT_DIR/scripts/bundle_web.py"

OUT="$ROOT_DIR/dist-web"
rm -rf "$OUT"
mkdir -p "$OUT/wasm-pkg"
cp web/{index.html,app.js,style.css,manifest.json,service-worker.js,icon.svg,icon-192.png,icon-512.png,apple-touch-icon.png} "$OUT/"
cp web/wasm-pkg/{zali_core.js,zali_core_bg.wasm} "$OUT/wasm-pkg/"
cp cloudflare/_headers "$OUT/_headers"
echo "✅ dist-web/ собран"

if [ "${1:-}" != "--no-deploy" ]; then
    npx wrangler deploy
fi
