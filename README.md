# ZaliMessenger

Современный кроссплатформенный мессенджер, использующий формат **Zali** (`.zali`) для передачи сообщений и файлов.

- **core/**: Единое ядро на Rust для всех платформ (FFI, WASM).
- **server/**: Backend на Rust (Axum, SQLite, WebSocket).
- **web/**: Веб-клиент для браузера и WKWebView.
- **apps/windows/**: Приложение на Rust (WRY/TAO) с core ядром.
- **apps/macos/**: SwiftUI приложение, использующее core через Rust-FFI мост.
- **sdk/**: Низкоуровневый Archiver SDK (Rust + Swift).

## Архитектура
Теперь проект использует единое ядро на **Rust**, что гарантирует:
1. Идентичную логику упаковки/распаковки `.zali` архивов на всех устройствах.
2. Безопасность и производительность Rust на всех платформах.
3. Легкое обновление криптографических протоколов.

### 1. Сервер
```bash
cargo run --manifest-path server/Cargo.toml
```
Сервер будет доступен по адресу `http://localhost:3000`.

### 2. Windows Клиент
```bash
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_app.ps1
# или для разработки без упаковки:
cargo run --manifest-path apps/windows/Cargo.toml
```
Windows-сборка использует встроенные `web/`-ресурсы и подхватывает сохранённые стили/настройки через локальное состояние приложения.
Подробный список требований и шагов сборки есть в [docs/windows-build.md](docs/windows-build.md).

### 3. Веб Клиент
Просто откройте `web/index.html` в браузере.

### 4. macOS Клиент
```bash
./scripts/build_app.sh
open ZaliMessenger.app
```

Для быстрой проверки SwiftPM-сборки:
```bash
cd core
cargo build --release
cd ..
swift build --package-path apps/macos
```

Подробные команды разработки собраны в `docs/DEVELOPMENT.md`.

## Передача сообщений
Каждое сообщение упаковывается в архив `.zali` с магическим заголовком `ZALIMSSG` с помощью Zali SDK. Это обеспечивает:
- AES-256-GCM шифрование.
- Защиту от несанкционированного доступа.
- Компактность при передаче медиафайлов.
