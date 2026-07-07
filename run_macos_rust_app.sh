#!/bin/bash
# Собирает и запускает экспериментальный Rust-шелл для macOS (не основной клиент —
# основной снова Swift, см. run_macos_app.sh; голос/уведомления в этом шелле не
# подтверждены реальным использованием).
set -euo pipefail
cd "$(dirname "$0")"

./build_macos_rust_app.sh
open "dist/macos-rust/ZaliMessengerRust.app"
