# CLAUDE.md

Инструкции для Claude Code в этом репозитории. Здесь — только то, что нужно
знать в **любой** задаче. Всё специфичное для конкретной подсистемы вынесено в
ситуативные скиллы (таблица в конце) — они не занимают контекст, пока задача их
не касается; вызывай их явно через Skill, когда работаешь в соответствующей области.

## Агенты

Агентов (инструмент Agent/Task) не использовать вообще. Всю работу выполнять
самостоятельно, без делегирования в сабагентов.

## graphify

`graphify-out/graph.json` есть в репозитории. Хук уже требует `graphify
query/explain/path` перед каждым Read/Grep по исходникам — повторять это
правило прозой не нужно. После правок: `graphify update .`.

## Любая правка кода: проверь остальные версии

Репозиторий держит **несколько параллельных реализаций одной и той же логики**.
Почти любой фикс в одном месте нужен и в других. Перед тем как считать задачу
законченной, явно назови пользователю, какие пары ниже затронуты, и подтверди
по каждой «нужно / не нужно / уже есть» — не пропускай этот шаг, даже если фикс
выглядит локальным.

| Пара | Канонический источник | Замечание |
|---|---|---|
| Web UI ↔ все нативные шеллы | `web/src/` (`ZaliInterface`, порядок — `web/src/manifest.json`) | После правки — **всегда** `python3 scripts/bundle_web.py`, иначе не попадёт в macOS/Windows/Android |
| macOS Swift (`apps/macos/`) ↔ Windows/Rust (`apps/windows/src/native.rs`) | — | Один нативный слой (IPC-бридж, ключи, реконнект WS, HTTP, голосовой транспорт), но **не 1:1** — платформенные различия (Keychain vs `keyring`) |
| Локальный `server/src/` ↔ серверный репозиторий `zali-server` | серверный репо | Правки нужно пушить и деплоить (команды — приватный скилл `zali-ops-deploy`, чеклист — `ops/RELEASE.md`). **Сервер выкатывается раньше клиента**, см. скилл `release-management` |
| `sdk/Rust/` (сервер+Windows) ↔ `sdk/Swift/` (macOS) | — | Зеркальные реализации формата `.zali` — менять формат/крипто в обоих |
| Android (`NativeBridge.kt`+`ZaliCoreBridge.kt`) | — | Четвёртая независимая реализация нативного слоя, её **систематически забывают**. При правке `core/` — пересобрать ядро: `ANDROID_NDK_HOME=... ./apps/android/build_android_core.sh` (Gradle этого не делает и не предупреждает) |

**Исключение — голосовые звонки.** Вся WebRTC-логика живёт только в
`web/src/interface/voice_*.js` и исполняется в WebView; нативные шеллы лишь
ретранслируют события по WS. Дублировать правки голоса в нативный код не нужно
— достаточно `bundle_web.py`. Сверять с нативным слоем нужно только транспорт
(реконнект WS, heartbeat) и разрешение микрофона. Подробности — скилл `voice-calls`.

## Приоритеты при исправлении багов

Фиксы работоспособности (отправка/приём/шифрование/звонки) всегда важнее фиксов
безопасности — мессенджер должен сначала корректно работать. Баг, ломающий
функциональность, критичен независимо от его природы. Баги безопасности, не
нарушающие работу, можно отложить.

## Коммиты и пуши: только номер версии

Заголовок каждого коммита/пуша — номер версии в схеме `MAJOR.MINOR{a|b|r}BUILD`
(например `0.2b22`), без описания в заголовке — детали идут в теле коммита.
Перед коммитом бампни все места одной командой `python3 scripts/bump_version.py 0.2b46`
(`--check` — только сверка), иначе заголовок соврёт о содержимом сборки. Скрипт пишет:

- `APP_VERSION` в `scripts/build_app.sh` (macOS)
- `APP_DISPLAY_VERSION` в `apps/windows/src/native.rs` (Windows — отображаемая/сравниваемая версия)
- `version` в `apps/windows/Cargo.toml` (отдельное SemVer-значение только для Cargo: `0.2b22` → `0.2.22`, его никто не сравнивает)
- `versionName`/`versionCode` в `apps/android/app/build.gradle.kts` (`versionCode = MAJOR*10000 + MINOR*1000 + BUILD`; у Android нет канала автообновления, номер только для опознания сборки)

Серверные коммиты идут тем же номером в `zali-server` — история обоих
репозиториев должна читаться как один ряд версий. Публикация релиза
(`POST /api/version`) — отдельный шаг, коммит его не заменяет. Полная процедура
и ловушки — скилл `release-management`.

## Production Server

- API: `https://msgs.zalikus.org`; standalone веб-клиент: `https://msg.zalikus.org`.
- Серверный репозиторий: https://github.com/zalikuska/zali-messenger-server (ветка `zali-server`).
- Хост, SSH, systemd, соседние сервисы, coturn, деплой — в `CLAUDE.local.md`, `ops/` и
  приватных скиллах `zali-ops-*` (всё в `.gitignore`). Репозитории публичные — **не возвращать эти
  подробности** сюда, в `docs/` или в комментарии кода.
- Сервер запускается только через systemd (`systemctl restart zali-server.service`),
  не через `nohup`/`pkill`.
- TURN проверять живым пробоем: `python3 scripts/voice_doctor/check_turn.py`.

## Build Commands

```bash
# Server (имя пакета zali_server, с подчёркиванием)
cargo check --manifest-path server/Cargo.toml -p zali_server
cargo run --manifest-path server/Cargo.toml   # http://localhost:3000

# Archiver SDK (Rust)
cargo check --manifest-path sdk/Rust/Cargo.toml

# Windows client
cargo check --manifest-path apps/windows/Cargo.toml

# Веб-ассеты — обязательно ДО сборки macOS/Windows, иначе в бинарник попадёт старый JS
python3 scripts/bundle_web.py

# Standalone browser/PWA — запускать перед bundle_web.py, чтобы web/wasm-pkg/ уже был на месте
scripts/build_web_wasm.sh

# macOS (Swift, основной клиент) — core собирается первым
cd core && cargo build --release && cd ..
swift build --package-path apps/macos
./scripts/build_app.sh                  # ZaliMessenger.app
./scripts/run_macos_app.sh              # удобный все-в-одном скрипт
```

Тесты:
```bash
cd core && cargo test
cargo test --manifest-path server/Cargo.toml   # интеграционные, живут в tests/
# Новый файл в tests/ НЕ подхватывается сам — нужен свой [[test]] (name+path) в server/Cargo.toml
```

Проверки области — `./scripts/{voice,notify,perf,security,crypto,memory}_doctor/run.sh`
(подсказка, какой запускать, приходит хуком при открытии файла области). Данные с живых
устройств: клиенты сами шлют отчёты (кнопка «Отправить диагностику» и автоматически при
сбое звонка/доставки/WS/JS — `web/src/interface/diagnostic_reports.js`), читать —
`python3 scripts/diag_reports.py metrics|list|show` (`ZALI_API_URL`, `ZALI_ADMIN_TOKEN` =
`RELEASE_ADMIN_TOKEN` сервера). Логи шеллов: macOS `zali-debug.log`, Windows `zali-win.log`
(оба с ротацией в `.1` на 8 МБ). После правки
скиллов, `CLAUDE.md` или констант, на которые они ссылаются, — `python3 scripts/check_docs.py`.

Хуки проекта (`.claude/settings.json`, код в `scripts/hooks/`): `graphify_hint.py` требует graphify
перед поиском/чтением (полный текст первые 2 раза за сессию, потом короткое напоминание);
`skill_hint.py` подсказывает скилл (и подфайл многофайловых скиллов — `voice-calls`, `performance`)
по пути файла; `auto_bundle.py` в конце хода сам пересобирает `bundle_web.py`, если
`web/src` новее бандла; `android_core_reminder.py` после правки `core/`/`sdk/Rust` напоминает
пересобрать `.so` для Android. Версию ставить `python3 scripts/bump_version.py <версия>`.
Сгенерированные `web/app.js`, `Assets.swift`, `BridgeProtocol.generated.swift`, `Resources/Web/*` скрыты от
поиска файлом `.ignore` (иначе каждый поиск возвращает 4–5 копий одного совпадения); правь `web/src/`, а сами
файлы читаются по прямому пути как обычно.

Копировать `.env.example` → `.env`, задать реальный `JWT_SECRET` для любого
не-локального деплоя. В git не должны попадать: `zali_messenger.db`, `uploads/`,
`target/`, `apps/macos/.build/`, `dist/`. При странностях SwiftPM после переноса
проекта — удалить `apps/macos/.build` и пересобрать.

## Project Structure

| Path | Role |
|---|---|
| `server/src/` | Axum-сервер, модули по доменам (`auth`, `messages`, `voice`, `updates`, `hash_chain`, `coins`, `treasury`, `realtime`, ...) |
| `web/src/interface.js` + `web/src/interface/` | Весь веб-UI (`ZaliInterface`), общий для браузера и всех нативных WebView. Порядок частей — `web/src/manifest.json` |
| `apps/macos/` | Основной macOS-клиент (AppKit, без SwiftUI) |
| `apps/windows/src/native.rs` + `native/` | Windows-клиент (WRY/TAO); тот же крейт умеет собираться и как экспериментальный macOS Rust-шелл |
| `apps/android/` | Android-шелл — 4-я независимая реализация нативного слоя |
| `core/` | Rust core, статическая `.a` для macOS FFI |
| `sdk/Rust/` / `sdk/Swift/` | Зеркальные реализации формата `.zali` |

Подробнее об архитектуре — `docs/ARCHITECTURE.md`.

## Git Safety

`git checkout -f` / `pull --ff-only` между ветками с разным набором
отслеживаемых путей уже однажды стёр реально нужный код с диска (файлы жили
только в рабочей копии). Перед такой операцией между ветками — сравнить
`git ls-tree -r <a> --name-only` с `<b>` и насторожиться при исчезающих
директориях или секции `# Legacy ... kept only in the workspace` в
`.gitignore`. Полный разбор инцидента и процедура восстановления — скилл `git-safety`.

## Ситуативные скиллы

Вызывай явно (`Skill`), когда задача касается соответствующей области —
без вызова их содержимое не грузится в контекст:

| Когда | Скилл |
|---|---|
| Публикация релиза, версии, апдейтер, сборка macOS/Windows-дистрибутива | `release-management` |
| Формат `.zali`, доставка сообщений, бинарный мост `API_REQUEST`, обмен ключами (E2E/каналы) | `messaging-protocol` |
| Редактирование/удаление/ответ на сообщение, hash chain переписки | `message-lifecycle` |
| ZaliCoin-карточки, казна сервера | `zalicoin-treasury` |
| macOS Swift-клиент, экспериментальный macOS Rust-шелл | `macos-client` |
| Windows-клиент (`native.rs`) | `windows-client` |
| Android-шелл | `android-client` |
| Структура `web/src/interface.js` (миксины, манифест) и мелкие веб-инварианты | `web-ui-architecture` |
| Голосовые звонки (WebRTC), WS keepalive/heartbeat | `voice-calls` |
| Standalone browser/PWA клиент | `browser-pwa-client` |
| Уведомления (push, toast, badge, focus-детект) | `notifications` |
| Производительность (рендер, кеш, память, путь отправки) | `performance` |
| Секьюрити-инварианты (origin pin, креды, секреты) | `security-invariants` |
| Сборка/дистрибуция Windows: cross-compile, installer, трей, автозапуск | `windows-build-distribution` |
| Восстановление после git-инцидента (потеря нетрекаемых файлов) | `git-safety` |
| Проверка изменения в реальном UI | `verify` |
