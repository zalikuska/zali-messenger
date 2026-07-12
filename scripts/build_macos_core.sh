#!/bin/bash
# Скрипт для сборки Rust-ядра для macOS приложения

cd "$(dirname "$0")/../core"

# Сборка для архитектуры текущего Mac (x86_64 или aarch64)
cargo build --release

# Создание папки для библиотеки в проекте macOS, если её нет
mkdir -p ../apps/macos/ZaliMessenger/Frameworks

# Копирование статической библиотеки
cp target/release/libzali_messenger_core.a ../apps/macos/ZaliMessenger/Frameworks/

echo "✅ Rust Core собран и скопирован в macOS проект."
echo "Убедитесь, что в Xcode добавлена библиотека libzali_messenger_core.a и путь к CoreBridge.h в Objective-C Bridging Header."
