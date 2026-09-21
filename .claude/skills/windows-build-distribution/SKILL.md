---
name: windows-build-distribution
description: Windows-сборка и дистрибуция — кросс-компиляция с macOS, Inno Setup онлайн-инсталлятор, трей, автозапуск, набор файлов для передачи. Использовать при сборке .exe/установщика или правках трея/автозапуска.
---

# Windows Build Distribution

## Что входит в дистрибутив

Для сборки Windows-клиента нужны только эти пути (без `target/`):

```
apps/windows/     — Rust-клиент (WRY/TAO)
apps/windows/installer/ZaliMessenger.iss — Inno Setup скрипт установщика
core/             — Rust core library (зависимость apps/windows)
sdk/Rust/         — архивный SDK (зависимость core)
web/src/          — JS-модули и CSS/HTML
web/bridge_protocol.json
web/style.css
web/index.html
scripts/bundle_web.py
scripts/build_windows_app.ps1
```

Сервер, `apps/macos/`, `sdk/Swift/` — не нужны.

```bash
zip -r zali-windows-source.zip \
  apps/windows/src apps/windows/Cargo.toml apps/windows/Cargo.lock apps/windows/build.rs \
  core/src core/Cargo.toml core/Cargo.lock \
  sdk/Rust/src sdk/Rust/Cargo.toml sdk/Rust/Cargo.lock \
  web/src web/bridge_protocol.json web/style.css web/index.html \
  scripts/bundle_web.py scripts/build_windows_app.ps1 \
  apps/windows/installer/ZaliMessenger.iss
```

## Кросс-сборка с macOS через `cargo-xwin`

Отдельная Windows-машина не нужна: `cargo-xwin` сам скачивает Windows SDK и
CRT — ровно те заголовки, из-за отсутствия которых раньше падал C-код `ring`.

```bash
cargo install cargo-xwin && rustup target add x86_64-pc-windows-msvc
cargo xwin build --release --manifest-path apps/windows/Cargo.toml --target x86_64-pc-windows-msvc
# → apps/windows/target/x86_64-pc-windows-msvc/release/zali_messenger_win.exe (~8 МБ)
```

Не забыть `python3 scripts/bundle_web.py` до сборки — `main.rs` вкомпилирует
`web/app.js` через `include_str!`.

**Кросс-сборка даёт валидный бинарник, но ничего не говорит о поведении**:
трей, автозапуск, toast-уведомления, AUMID, установщик и сам процесс
обновления так не проверяются. Перед публикацией релиза `.exe` нужно
прогнать на живой Windows.

## Сборка на Windows-машине

Требования: Rust + MSVC (`rustup default stable-x86_64-pc-windows-msvc`),
Python 3, [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
на целевой машине.

```powershell
.\scripts\build_windows_app.ps1        # dist\windows\ZaliMessenger.exe
.\scripts\build_windows_app.ps1 -Run   # + запустить
```

Скрипт сам запускает `bundle_web.py` перед `cargo build --release`.
Конфигурация сервера — через env до бандлинга:
```powershell
$env:ZALI_API_BASE_URL = "https://msgs.zalikus.org"
$env:ZALI_WS_BASE_URL  = "wss://msgs.zalikus.org"
.\scripts\build_windows_app.ps1
```

## Установщик (Inno Setup) — онлайн-инсталлятор

`apps/windows/installer/ZaliMessenger.iss` — **онлайн-инсталлятор**: не
содержит `.exe` внутри себя. Во время установки сам дёргает
`GET {UpdateApiBaseUrl}/api/version?platform=windows` (тот же эндпоинт, что
апдейтер клиента, `server/src/updates.rs::get_latest_version`), скачивает
`downloadUrl`, проверяет `sha256` (`certutil -hashfile`, встроен в Windows) и
копирует файл в `{app}\ZaliMessenger.exe`. HTTP — через
`WinHttp.WinHttpRequest.5.1` + `ADODB.Stream` (COM, без доп. плагинов). Один
раз собранный `ZaliMessengerOnlineSetup.exe` всегда ставит текущую
опубликованную версию — пересобирать инсталлятор на каждый релиз не нужно,
только `POST /api/version`.

Требуется [Inno Setup](https://jrsoftware.org/isinfo.php) (`ISCC.exe` в PATH).
Локальная сборка Rust не нужна.

```powershell
.\scripts\build_windows_app.ps1 -OnlineInstallerOnly
# dist\windows\installer\ZaliMessengerOnlineSetup.exe
```

Базовый URL API — `https://msgs.zalikus.org` (`#define UpdateApiBaseUrl` в
`.iss`); переопределить через `/DUpdateApiBaseUrl=...` при вызове `ISCC.exe`.

Ограничение: AppVersion инсталлятора (Add/Remove Programs) — статичный
плейсхолдер `1.0.0`, не реальная версия скачанного клиента (та известна
только во время установки, после компиляции `.iss`). Косметическое
ограничение подхода «скачать при установке».

Классический офлайн-путь (локальная сборка `.exe` + `-Run` без установщика)
не меняется — способ быстро проверить сам билд без инсталлятора.

## Трей, автозапуск, AUMID (`apps/windows/src/main.rs`, Windows-only)

Установщик регистрирует **AppUserModelID** (`com.zali.messenger`) на ярлыке в
Start Menu — единственное, чего не хватало для стабильных toast-уведомлений:
`set_windows_app_user_model_id()` в `main.rs` задаёт AUMID процесса в
рантайме, но Windows показывает тосты для неупакованных (non-MSIX)
Win32-приложений надёжно только если тот же AUMID зарегистрирован ещё и
через persistent-ярлык — это делает параметр `AppUserModelID` в секции
`[Icons]` `.iss`-скрипта.

Установщик также добавляет (чекбоксы в мастере, `[Tasks]` в `.iss`): ярлык на
рабочем столе (не по умолчанию); автозапуск при входе со свёрнутым окном
(`--start-minimized`, `HKCU\...\Run`) — по умолчанию включён, без него
приложение не работает в фоне и локальные уведомления не приходят, пока
пользователь не откроет чат руками.

- `install_windows_tray()` создаёт иконку в трее (крейт `tray-icon`, меню
  через его реэкспорт `muda` — **не** тот же `muda 0.12`, что использует
  macOS Rust-шелл напрямую: Cargo резолвит их как два независимых экземпляра
  одноимённого крейта, их типы несовместимы, смешивать нельзя) с пунктами
  «Открыть»/«Выход».
- `WindowEvent::CloseRequested` на Windows сворачивает окно в трей вместо
  выхода — выйти по-настоящему можно только через «Выход» в трее
  (`AppEvent::Quit`, тот же путь, что апдейтер после установки обновления)
  или диспетчер задач. На остальных платформах поведение не менялось.
- Флаг `--start-minimized` не показывает окно при старте — используется
  только автозапуском.
- **Автозапуск прописывает само приложение** (`native/autostart.rs`, с
  2026-09-15): каждый старт релизной сборки ставит
  `HKCU\...\Run\ZaliMessenger` = `"<текущий exe>" --start-minimized` и
  переписывает путь, если exe переехал. До этого запись делала только
  галочка установщика, у запускавших `.exe` напрямую автозапуска не было
  вовсе. Отказ хранится в `HKCU\Software\ZaliMessenger\AutostartDisabled`
  (DWORD 1): пишут переключатель «Автозапуск» в настройках (capability
  `autostart`, bridge `AUTOSTART_REQUEST`: без `enabled` — чтение, с булевым —
  запись) и снятая галочка установщика. «Отключить» в Диспетчере задач живёт
  в `StartupApproved\Run` и перезаписью `Run` не снимается; включение из
  настроек снимает и его. Отладочная сборка (`cargo run`) себя не прописывает.
  **Не убирать запись отказа из установщика**: без неё первый же запуск
  молча включал бы автозапуск, который пользователь снял при установке.

Иконка трея — сплошной квадрат брендового цвета (`--lime: #cbff00`),
сгенерированный в коде (`tray_icon_image()` в `main.rs`), не настоящий `.ico`
— осознанное упрощение, чтобы не тащить крейт декодирования изображений.
Замена на многоразмерный `.ico` — косметическая доработка на будущее.

**Ничего из трея/автозапуска/установщика не проверялось на реальной Windows.**
Компиляция проходит (кросс-сборка через `cargo xwin`), но поведение — трей,
автозапуск, AUMID-фикс, апдейтер — нужно проверять вручную.
