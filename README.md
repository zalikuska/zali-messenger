# ZaliMessenger

Современный кроссплатформенный мессенджер, использующий формат **Zali** (`.zali`) для передачи сообщений и файлов.

- **Core/**: Единое ядро на Rust для всех платформ (FFI, WASM).
- **Server/**: Backend на Rust (Axum, SQLite, WebSocket).
- **Web/**: Веб-клиент для браузера и WKWebView.
- **Windows/**: Приложение на Rust (WRY/TAO) с Core ядром.
- **macOS/**: SwiftUI приложение, использующее Core через Rust-FFI мост.
- **ZaliArchiverSDK/**: Низкоуровневый SDK.

## Архитектура
Теперь проект использует единое ядро на **Rust**, что гарантирует:
1. Идентичную логику упаковки/распаковки `.zali` архивов на всех устройствах.
2. Безопасность и производительность Rust на всех платформах.
3. Легкое обновление криптографических протоколов.

### 1. Сервер
```bash
cd Server
cargo run
```
Сервер будет доступен по адресу `http://localhost:3000`.

### 2. Windows Клиент
```bash
powershell -ExecutionPolicy Bypass -File .\build_windows_app.ps1
# или для разработки без упаковки:
cargo run --manifest-path Windows/Cargo.toml
```
Windows-сборка использует встроенные `Web/`-ресурсы и подхватывает сохранённые стили/настройки через локальное состояние приложения.
Подробный список требований и шагов сборки есть в [docs/windows-build.md](/Users/zalikus/Codex/zali-messenger/docs/windows-build.md).

### 3. Веб Клиент
Просто откройте `Web/index.html` в браузере.

### 4. macOS Клиент
```bash
./build_app.sh
open ZaliMessenger.app
```

Для быстрой проверки SwiftPM-сборки:
```bash
cd Core
cargo build --release
cd ..
swift build --package-path macOS
```

Подробные команды разработки собраны в `DEVELOPMENT.md`.

## Передача сообщений
Каждое сообщение упаковывается в архив `.zali` с магическим заголовком `ZALIMSSG` с помощью Zali SDK. Это обеспечивает:
- AES-256-GCM шифрование.
- Защиту от несанкционированного доступа.
- Компактность при передаче медиафайлов.
