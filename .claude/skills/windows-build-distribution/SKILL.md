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
apps/windows/installer/wizard/ — картинки мастера (PNG, генерирует brand/logo/gen_logo.py --export)
apps/windows/assets/ — иконка: zali.ico (установщик/ярлыки) + icon-{16,20,24,32,48,64}.rgba (трей, окно)
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
  apps/windows/src apps/windows/assets apps/windows/Cargo.toml apps/windows/Cargo.lock apps/windows/build.rs \
  core/src core/Cargo.toml core/Cargo.lock \
  sdk/Rust/src sdk/Rust/Cargo.toml sdk/Rust/Cargo.lock \
  web/src web/bridge_protocol.json web/style.css web/index.html \
  scripts/bundle_web.py scripts/build_windows_app.ps1 \
  apps/windows/installer/ZaliMessenger.iss apps/windows/installer/wizard
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
обновления так не проверяются. Публикацию это не блокирует (решение
владельца, 2026-11-27): выпускаем и честно пишем, что на живой Windows не прогонялось.

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
копирует файл в `{app}\ZaliMessenger.exe`. Метаданные — через
`WinHttp.WinHttpRequest.5.1` (COM), сам файл — встроенным `DownloadTemporaryFile`
(Inno 6.1+): прежний `ADODB.Stream` с `Stream.Type := 1` не компилируется в ISCC 6.7. Один
раз собранный `ZaliMessengerOnlineSetup.exe` всегда ставит текущую
опубликованную версию — пересобирать инсталлятор на каждый релиз не нужно,
только `POST /api/version`.

Требуется [Inno Setup](https://jrsoftware.org/isinfo.php) **6.7+** (`ISCC.exe` в PATH):
тёмная тема мастера (`WizardStyle=modern dark hidebevels` — 6.6), цвет страниц
`WizardBackColor=#090b0e` (= `--bg`, 6.7), PNG-картинки (6.5.2). Старый компилятор
останавливается на `#error` в начале `.iss`, а не на непонятной директиве.
Локальная сборка Rust не нужна.

Оформление: страница приветствия включена (`DisableWelcomePage=no`) ради левой панели —
холст со светом «Фокуса со свечением», логотип и силуэты переписки
(`wizard/large-*.png`, 164:314 под 100–250% DPI); в шапке внутренних страниц —
плитка-иконка (`wizard/small-*.png`). Тексты приветствия и финала — `[Messages]`.
Кнопки и чекбоксы — встроенного тёмного стиля Inno (серые, акцент Windows): лаймовые
можно сделать только своим VCL-стилем (`WizardStyleFile`, `.vsf` из VCL Style Designer
на Windows). Как это выглядит вживую, на Windows ещё не проверялось.

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
  «Открыть»/«Выход». **Меню — только по правой кнопке** (`with_menu_on_left_click(false)`),
  `TrayShow` — только на `Click { Left, Up }`: tray-icon на правое нажатие синхронно
  открывает меню (`TrackPopupMenu`), и `TrayShow` от любого другого `Click` активировал окно
  и закрывал меню — пункты не появлялись (исправлено, на живой Windows не проверялось).
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

Иконка — логотип из `brand/logo/gen_logo.py --export`, со скруглённой плиткой в духе
Windows 11: система, как и macOS, иконки не скругляет. 16–32px — отдельный рисунок по
пиксельной сетке (`SMALL_LAYOUTS` в генераторе): уменьшенная большая иконка на этих
размерах превращается в лаймовое пятно. Трей и окно (малая иконка и `with_taskbar_icon`
для панели задач) берут сырой RGBA из `apps/windows/assets/icon-{16,20,24,32,48,64}.rgba`
через `include_bytes!` и `from_rgba`, без крейта декодирования картинок. `app_icon_rgba()`
выбирает размер по `GetSystemMetrics(SM_CXSMICON / SM_CXICON)` (наименьший ≥ метрики), чтобы
при 100/125/150% рисунок шёл 1:1, а не пережимался. Ресурса иконки у самого `.exe` нет
(сборка без rc-компилятора, `cargo xwin` его не даёт): Проводник показывает exe без иконки,
а ярлыки, «Программы и компоненты» и сам установщик берут `apps/windows/assets/zali.ico`
(`SetupIconFile`, `[Files]` → `{app}\zali.ico`, `IconFilename` в `[Icons]`). Кто запускает
голый `.exe` без установщика, видит иконку только у окна и в трее.

**Ничего из трея/автозапуска/установщика не проверялось на реальной Windows.**
Компиляция проходит (кросс-сборка через `cargo xwin`), но поведение — трей,
автозапуск, AUMID-фикс, апдейтер — нужно проверять вручную.
