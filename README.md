# ZaliMessenger

Кроссплатформенный мессенджер: личные переписки со сквозным шифрованием, серверы
сообществ с каналами и ролями, голосовые и видеозвонки. Сообщения и файлы передаются
в собственном формате **Zali** (`.zali`).

Клиенты: macOS, Windows, Android, iOS и браузер (PWA). Интерфейс у всех один — веб-UI
из `web/`, встроенный в нативную оболочку.

## Возможности

- **Переписки** — ответы, правка и удаление, реакции, вложения,
  стикеры. Личные переписки шифруются на устройствах (AES-256-GCM), ключи между
  своими устройствами переносятся через одобрение устройства.
- **Сообщества** — серверы с каналами, ролями и приглашениями.
- **Звонки** — голос, камера и демонстрация экрана (WebRTC). На macOS и Windows
  микрофон, камеру и экран захватывает сама оболочка: так звук не приглушается
  системой и шумоподавление работает одинаково.
- **Удалённое управление** — участник звонка может попросить управлять показанным
  экраном; доступ выдаёт и в любой момент забирает тот, кто показывает.
- **Общий браузер** — активность в звонке: запустивший открывает отдельный браузер,
  он показывается всем как трансляция, и все участники управляют им одновременно —
  у каждого свой курсор цвета аватарки. Браузер изолирован от мессенджера и от
  системного браузера: профиль либо свой (отдельное хранилище приложения), либо
  общий профиль сообщества на сервере. Локальная сеть, загрузки и чужой буфер
  обмена ему недоступны. Частота кадров — как у дисплея запустившего.
- **Статус «Играет в …»** и тихий режим уведомлений во время игры.
- **Аддоны** — расширения в песочнице, см. [docs/ADDONS.md](docs/ADDONS.md).
- **Обновления** — встроенный апдейтер на macOS, Windows и Android; каналы alpha,
  beta и release, каждый релиз подписан.

## Структура

| Путь | Что это |
|---|---|
| `server/` | Сервер на Rust (Axum, SQLite, WebSocket) |
| `web/` | Веб-интерфейс — общий для браузера и всех оболочек |
| `core/` | Ядро на Rust: формат `.zali`, криптография, обработка звука (FFI и WASM) |
| `apps/macos/` | Основной macOS-клиент (Swift, AppKit) |
| `apps/windows/` | Windows-клиент (Rust, WRY/TAO, WebView2) |
| `apps/android/` | Android-клиент (Kotlin) |
| `apps/ios/` | iOS-клиент (Swift) |
| `sdk/` | Archiver SDK формата `.zali` (Rust и Swift) |
| `scripts/` | Сборка, бандл веб-ассетов, проверки областей (`*_doctor`) |
| `docs/` | Архитектура, разработка, дизайн интерфейса |

## Сборка

Веб-ассеты собираются **до** любого нативного клиента, иначе в него попадёт старый JS:

```bash
python3 scripts/bundle_web.py
```

### Сервер
```bash
cp .env.example .env    # для любого не-локального запуска задать JWT_SECRET
cargo run --manifest-path server/Cargo.toml
```
Сервер слушает `http://localhost:3000`.

### macOS
```bash
./scripts/run_macos_app.sh
```
Скрипт собирает ядро, веб-ассеты и `ZaliMessenger.app` и запускает его. Только сборка —
`./scripts/build_app.sh`.

### Windows
```bash
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_app.ps1
```
Для разработки — `cargo run --manifest-path apps/windows/Cargo.toml`. Требования и
кросс-сборка с macOS — [docs/windows-build.md](docs/windows-build.md).

### Android
Ядро собирается отдельно (Gradle этого не делает):
```bash
ANDROID_NDK_HOME=<путь к NDK> ./apps/android/build_android_core.sh
```
Дальше — обычная сборка Gradle, см. [apps/android/README.md](apps/android/README.md).

### iOS
См. [apps/ios/README.md](apps/ios/README.md).

### Браузер (PWA)
```bash
scripts/build_web_wasm.sh
python3 scripts/bundle_web.py
```

## Тесты и проверки

```bash
cargo test --manifest-path server/Cargo.toml
cd core && cargo test
./scripts/voice_doctor/run.sh       # и другие scripts/*_doctor/run.sh
```

Подробнее — [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) и [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Формат `.zali`

Каждое сообщение упаковывается в архив с заголовком `ZALIMSSG`: содержимое и вложения
шифруются AES-256-GCM и проверяются на целостность. Формат реализован дважды — в Rust
(`sdk/Rust`, сервер и Windows) и в Swift (`sdk/Swift`, macOS) — и меняется в обоих
местах одновременно.
