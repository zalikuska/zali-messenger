#!/usr/bin/env bash
# Builds core/ to WebAssembly for the standalone browser client and drops the
# glue JS + .wasm binary into web/wasm-pkg/. Run before bundle_web.py so the
# browser bundle picks up wasm-pkg/zali_core.js (see web/src/modules/wasm_bridge.js).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v wasm-pack >/dev/null 2>&1; then
    echo "wasm-pack not found. Install it with: cargo install wasm-pack" >&2
    exit 1
fi

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

wasm-pack build "$ROOT_DIR/core" \
    --target web \
    --out-dir "$ROOT_DIR/web/wasm-pkg" \
    --out-name zali_core \
    --release \
    -- --features wasm

echo "✅ wasm-pkg built at web/wasm-pkg/"
