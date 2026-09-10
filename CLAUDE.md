# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Агенты

Агентов (инструмент Agent/Task) не использовать вообще. Всю работу выполнять самостоятельно, без делегирования в сабагентов.

## ⚠️ Обязательно при ЛЮБЫХ изменениях в коде — проверить, не нужны ли они в другой версии

Этот репозиторий содержит **несколько параллельных реализаций одной и той же логики**. Почти любой фикс в одном месте требуется и в других. **Перед завершением любой правки уточни (у пользователя и/или проверкой), не нужно ли продублировать её в:**

- **Web UI** (`web/src/` — канонический источник; класс `ZaliInterface` разложен по `web/src/interface/*.js`, порядок сборки в `web/src/manifest.json`). После правки **всегда** запусти `python3 scripts/bundle_web.py`, иначе изменения не попадут в macOS (`Assets.swift`), Windows embedded-ассеты и Android (`apps/android/app/src/main/assets/web/`, откуда `MainActivity.kt` грузит `file:///android_asset/web/index.html`). Android туда добавлен 2026-08-18: до этого ассеты копировались руками, и на момент починки отставали на две недели — фича ответа/редактирования вышла на десктопе и молча миновала Android.
- **macOS Swift-клиент** (`apps/macos/Sources/ZaliMessenger/`, основной) ↔ **Windows/Rust-шелл** (`apps/windows/src/native.rs` + `apps/windows/src/native/`) — реализуют один и тот же нативный слой (IPC-бридж, ключи, реконнект WS, HTTP-запросы, голосовой транспорт) **параллельно**. Фикс сетевого/крипто/бридж-поведения в одном почти всегда нужен и в другом — но с адаптацией под платформу (напр. macOS Keychain/файлы vs Windows `keyring`), не 1:1.
- **Сервер**: локальный `server/src/` в этом монорепо ↔ серверный репозиторий (`zali-server`, ветка `zali-server`). Правки хендлеров нужно пушить в серверный репо и деплоить (см. «Deploy process»).
- **Archiver SDK**: `sdk/Rust/` (сервер+Windows) ↔ `sdk/Swift/` (macOS) — зеркальные реализации формата `.zali`. Изменение формата/крипто нужно в обоих.
- **Android-шелл** (`apps/android/app/src/main/java/org/zalikus/messenger/`) — четвёртая независимая реализация того же нативного слоя (`NativeBridge.kt` + `ZaliCoreBridge.kt`). Её **систематически забывали**: аудит 0.2b33 нашёл, что Android не знал про `reply`/`call` (вышли в 0.2b26 и уехали только в macOS и Windows), не имел ни потолка перебора ключей, ни кэшей расшифровки, а `.so` в `jniLibs/` была на неделю старше `core/src/`. Правя `core/`, **пересобирай ядро для Android** (`ANDROID_NDK_HOME=... ./apps/android/build_android_core.sh`) — Gradle его не собирает и о его устаревании молчит.

> **Исключение — голосовые звонки.** Вся WebRTC-логика (mesh, оффер/ответ, ICE, glare, микрофон)
> живёт только в вебе (`web/src/interface/voice_*.js`) и исполняется в WebView. Нативные шеллы лишь ретранслируют
> `voice_*` по WS, своей реализации согласования у них нет — дублировать туда правки голоса не надо,
> достаточно `bundle_web.py`. Сверять с нативным слоем нужно только транспорт (реконнект WS,
> heartbeat) и разрешения на микрофон.

Правило: **никогда не считай правку завершённой, пока не спросил себя «в каких ещё из этих версий это тоже нужно?» и не сообщил об этом пользователю.**

**ОБЯЗАТЕЛЬНО:** при ЛЮБОМ изменении кода — до того как считать задачу выполненной — явно уточни у пользователя (или проверь сам и сообщи результат), нужно ли продублировать правку в другие версии из списка выше. Это не опционально: даже если кажется, что фикс локальный, назови затронутые параллельные реализации и подтверди по каждой «нужно / не нужно / уже есть».

> Пример из практики (2026-07): фикс загрузки/показа аватара делался в macOS Swift-клиенте (multipart CRLF в raw-строке `\#r\#n`, роутинг upload через нативный мост, ретрай `performAvatarFetch` на свежем соединении). Windows/Rust-шелл использует `reqwest` (сам ставит CRLF) и уже имеет `perform_avatar_fetch`+`retry_with_backoff` — там правки 1:1 не нужны, но проверить это надо было явно.

## graphify — ОБЯЗАТЕЛЬНО, не пропускать

`graphify-out/graph.json` в этом репозитории существует. Это значит: **перед любым Read/Grep/поиском по коду** (в том числе в начале работы над задачей, до первого открытия исходников) сначала выполни `graphify query "<question>"` (или `graphify explain "<concept>"` / `graphify path "<A>" "<B>"`). Не открывай файлы "по памяти" или "чтобы просто посмотреть" — это правило действует всегда, а не только когда явно вспомнилось. Это касается и сабагентов: если делегируешь исследование кода — включи это требование в промпт сабагента.

Rules:
- For codebase questions, first run `graphify query "<question>"` when `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of raw source browsing.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Production Server

- URL: `https://msgs.zalikus.org` (API), `https://msg.zalikus.org` (standalone веб-клиент).
- Server repo: https://github.com/zalikuska/zali-messenger-server (branch `zali-server`).
- **Всё про боевую машину — хост, SSH, пути, systemd, соседние сервисы, coturn, деплой — в
  `CLAUDE.local.md` и `ops/` (оба в `.gitignore`).** Репозитории публичные: не возвращать эти
  подробности сюда, в `docs/` или в комментарии кода.
- Сервер запускается только через systemd (`systemctl restart zali-server.service`), не через
  `nohup`/`pkill`.
- TURN проверять живым пробоем, а не статусом службы:
  `python3 scripts/voice_doctor/check_turn.py` (Binding → Allocate → CreatePermission → реальные байты).

### Publishing a client release (in-app updater)

> **Полная процедура — в `ops/RELEASE.md` (не в git).** Здесь только суть и ловушки, на которых
> уже спотыкались.

macOS (`apps/macos/`) and Windows (`apps/windows/`) clients check `GET /api/version?platform=macos|windows`
on login and prompt to update if the server's version is newer (`web/src/interface.js`
`checkForAppUpdate()`/`compareVersions()`). Declining keeps it available under the Hub's "Обновления" card.

**Version scheme (since 2026-07-27):** `MAJOR.MINOR{a|b|r}BUILD`, e.g. `0.2b9` — channel letter is
alpha/beta/release, ranked `r > b > a` at the same `MAJOR.MINOR`. `compareVersions()` in `interface.js`
also accepts legacy plain dotted versions (e.g. old `1.1.3` releases already in `app_releases`) and
treats them as release-channel for comparison purposes.

**Состояние миграции (завершена 2026-07-28).** Обе платформы получили «переходный» релиз под
legacy-номером **1.1.4** — он нужен только для того, чтобы клиенты со СТАРОЙ `compareVersions`
(она просто делит по точкам) увидели численный бамп и обновились; внутри это сборка `0.2b9`.
`checkForAppUpdate()` игнорирует такую запись у клиентов, уже понимающих новую схему
(`VERSION_SCHEME_MIGRATION_CUTOFF_UNIX`, 2026-08-01). Затем Windows ушёл на `0.2b10`, а
**с 2026-07-28 обе платформы выпускаются в новой схеме — текущая версия `0.2b11`.**

> **Плата за это, принята осознанно:** клиенты, оставшиеся на `1.1.3` и старше, сравнивают `0.2bN`
> старым кодом (`0 < 1`) и апдейт больше не увидят — их надо доставить руками.
>
> **Почему для macOS не было выбора.** Казалось бы, можно было продолжить legacy-нумерацию
> (`1.1.5`) и никого не бросить. Нельзя: cutoff-логика, уже уехавшая в клиенты вместе с `1.1.4`,
> заставляет всякий plain-numeric релиз, опубликованный **до** 2026-08-01, считаться тем самым
> переходным бампом и молча игнорироваться. То есть `1.1.5`, выпущенный сейчас, не увидел бы
> вообще никто из тех, кто уже перешёл. После 2026-08-01 это ограничение снимается само.

Cargo requires strict SemVer, so it can't hold `0.2b9` directly — `apps/windows/Cargo.toml`'s `version`
is a separate, boring value bumped independently just to keep `cargo build` happy; the actual display/
compared version lives in `APP_DISPLAY_VERSION` in `apps/windows/src/native.rs`. macOS has no such split:
`APP_VERSION` in `scripts/build_app.sh` feeds `CFBundleShortVersionString` directly and isn't SemVer-locked.

1. Bump the version string: `APP_VERSION` in `scripts/build_app.sh` (macOS) and `APP_DISPLAY_VERSION` in
   `apps/windows/src/native.rs` (Windows) — **not** `apps/windows/Cargo.toml`'s `version`, which is unrelated
   (bump it too, but only so Cargo has something monotonic; nobody compares it). Обе платформы сейчас
   идут одним номером — `0.2b11` (см. «Состояние миграции» выше).
> **Ловушка, стоившая всех прежних macOS-релизов (найдена 2026-09-09).** `core`
> собирается как cdylib+staticlib, и линкер по `-l` предпочитает `.dylib` — бинарник
> получает зависимость на `<repo>/core/target/release/deps/libzali_messenger_core.dylib`
> **по абсолютному пути**. На машине сборки это незаметно, у скачавшего релиз dyld
> библиотеку не находит и приложение не стартует вообще. `build_app.sh` теперь кладёт
> её в `Contents/Frameworks`, переписывает на `@rpath` и **после подписи проверяет**, что
> среди зависимостей не осталось путей внутрь репозитория (иначе падает). Не убирать эту
> проверку: поломка видна только на чужой машине. Признак старой сборки — zip ~1.2 МБ
> вместо ~1.5 МБ.

2. Build the client(s) — `./scripts/build_app.sh`, and for Windows either `scripts/build_windows_app.ps1`
   on Windows or a cross-build from macOS (see «Windows Build Distribution»). Pack the macOS `.app`
   with `ditto -c -k --keepParent` — `UpdateService.installAndRelaunch` unpacks with `ditto` and looks
   for a `.app` inside. Windows ships as the raw `.exe`, no archive.
3. Upload the artifact into the `releases/` directory of the server data dir (`ZALI_DATA_DIR`,
   **not** the source checkout) and compute SHA-256 (`shasum -a 256 <file>`). The artifact is then
   served publicly at `https://msgs.zalikus.org/releases/<filename>`.
4. Publish, once per platform, with `POST /api/version` (requires `RELEASE_ADMIN_TOKEN` in the server's
   env — see `.env.example`; unset means this route always 403s). Run the `curl` **on the server** so the
   token never leaves it — exact command in `CLAUDE.local.md` / `ops/RELEASE.md`.
5. Verify both the metadata **and** that the artifact actually downloads unauthenticated:
   `curl "https://msgs.zalikus.org/api/version?platform=macos"` and
   `curl -o /dev/null -w '%{http_code} %{size_download}\n' <downloadUrl>`.

**Ловушки, каждая стоила отдельного разбора:**

- **`/uploads/:filename` не годится для артефактов** (старая версия этого файла советовала именно его).
  Это роут вложений: `download_upload_file` требует `AuthenticatedUser` **и** строку в `messages` с
  таким `filename` — `.exe` оттуда отдаёт `401`. А качают артефакт **без** заголовка `Authorization`:
  и `download_update` (`apps/windows/src/native/updates.rs`), и онлайн-установщик через `WinHttp`.
  Для этого добавлен публичный роут `GET /releases/:filename` (`server/src/updates.rs`), читающий
  только из `releases_dir`; имя файла проходит allowlist `[A-Za-z0-9._-]` без ведущей точки, листинга
  нет. Тесты — `tests/releases.rs` (обход каталога, точкофайлы, изоляция от `uploads/`).
- **Публикация той же версии, что уже стоит у клиента, не делает ничего — молча.**
  `checkForAppUpdate()` выходит на `compareVersions(latest, current) <= 0` без сообщения и без записи
  в лог, что внешне неотличимо от сломанного апдейтера. Именно так «сломалось» автообновление
  2026-07-27: был опубликован Windows 1.1.0 при клиенте 1.1.0.
- **Скрипт установки исполняет СТАРАЯ версия.** Любой фикс апдейтера начинает действовать только со
  следующего обновления — пользователям на сборке с багом нужен один ручной установ.

> Note: после реорганизации 2026-07-12 в серверном чекауте нет корневого `Cargo.toml` — всегда
> `--manifest-path server/Cargo.toml` и перезапуск из `server/target/release/zali_server`. Однажды
> деплой молча оставил работать недельный бинарник по старому пути; после рестарта сверяйте
> `readlink -f /proc/$(pidof zali_server)/exe` (подробности — `CLAUDE.local.md`).

## Именование коммитов — версия, и ничего кроме версии

**Каждый коммит и каждый пуш называются номером версии** в схеме релизов
(`MAJOR.MINOR{a|b|r}BUILD`, см. «Publishing a client release»), например `0.2b22`.
Не «fix voice health timer», не «Add TURN credentials» — именно версия, одной строкой
в заголовке. Описание работы идёт в теле коммита.

Из этого следует правило, которое легко забыть: **номер в заголовке обязан совпадать с
тем, что реально зашито в сборку.** Перед коммитом бампните оба места, иначе имя коммита
начинает врать о том, какой код в нём лежит:

- `APP_VERSION` в `scripts/build_app.sh` (macOS),
- `APP_DISPLAY_VERSION` в `apps/windows/src/native.rs` (Windows),
- `version` в `apps/windows/Cargo.toml` — отдельное SemVer-значение, которое никто не
  сравнивает; бампается только чтобы Cargo был доволен (`0.2b22` → `0.2.22`),
- `versionName` и `versionCode` в `apps/android/app/build.gradle.kts`. До 0.2b33 там
  вечно стояла заглушка `1.0` / `1`, пока десктопы ушли на 0.2b32, — по установленному
  APK нельзя было понять, какой в нём код. `versionCode` обязан быть монотонным целым,
  поэтому считается как `MAJOR*10000 + MINOR*1000 + BUILD` (`0.2b33` → `2033`).
  Канала автообновления у Android нет (`/api/version` знает только macos/windows), так
  что номер нужен исключительно для опознания сборки.

Серверные коммиты попадают в `zali-server` тем же именем: история серверного репозитория
и история монорепо должны читаться как один ряд версий, иначе по логу деплоя невозможно
понять, какой клиент соответствует какому серверу.

Публикация релиза (`POST /api/version`) — **отдельный шаг**, коммит её не заменяет: версию
можно закоммитить и задеплоить на сервер, не выпуская клиент. Но выпускать клиент под
номером, который уже опубликован, бессмысленно — `checkForAppUpdate()` молча ничего не
сделает (см. ловушки в разделе релизов).

## Build Commands

```bash
# Server (package name is zali_server with underscore)
cargo check --manifest-path server/Cargo.toml -p zali_server
cargo run --manifest-path server/Cargo.toml   # starts on http://localhost:3000

# Archiver SDK (Rust)
cargo check --manifest-path sdk/Rust/Cargo.toml

# Windows client
cargo check --manifest-path apps/windows/Cargo.toml
cargo run --manifest-path apps/windows/Cargo.toml

# Web assets — must run before macOS/Windows builds see JS changes
python3 scripts/bundle_web.py

# Standalone browser/PWA client (mobile + desktop, no native shell) — run before bundle_web.py
# so web/wasm-pkg/ is present when web/app.js is regenerated. Serve web/ with any static
# file server (or the zali-server itself) — index.html loads wasm-pkg/zali_core.js next to it.
scripts/build_web_wasm.sh

# macOS (Swift, основная версия) — core must be built first
cd core && cargo build --release && cd ..
swift build --package-path apps/macos   # SwiftPM check
./scripts/build_app.sh                  # produces ZaliMessenger.app

# Full macOS app (convenience script)
./scripts/run_macos_app.sh

# macOS (Rust-шелл, экспериментальный) — тот же код, что Windows-клиент
./scripts/build_macos_rust_app.sh       # produces dist/macos-rust/ZaliMessengerRust.app
```

Running tests:
```bash
cd core && cargo test              # Core Rust unit tests
cargo test --manifest-path server/Cargo.toml   # server integration tests (51 шт., живут в top-level tests/)
# Новый файл в tests/ НЕ подхватывается сам — он вне пакета, нужен свой [[test]]
# с name+path в server/Cargo.toml, иначе `cargo test` его молча не увидит.
# tests/common/mod.rs::TestApp отдаёт addr, http и data_dir (последний — чтобы
# класть на диск файлы, которые сервер потом читает, напр. releases/).
```

## Project Structure

| Path | Role |
|---|---|
| `server/src/` | Axum server, split into modules: `main.rs`/`lib.rs` (config, AppState, router wiring, middlewares), `models.rs` (DTOs/records), `auth.rs`, `contacts.rs`, `servers.rs`, `channels.rs`, `roles.rs`, `messages.rs`, `assets.rs`, `realtime.rs` (WS), `storage.rs` (migrations/seeding), `util.rs`, `devices.rs`, `voice.rs`, `push.rs` (Web Push/VAPID), `updates.rs` (`/api/version` + публичный `/releases/:filename`), `conversation_keys.rs` (серверный реестр ключей разговоров), `hash_chain.rs` (append-only цепочка хэшей сообщений переписки + `.zali`-экспорт). Модули реэкспортируются в корень крейта (`pub(crate) use x::*;`), поэтому `use crate::{...}` работает отовсюду |
| `web/src/interface.js` + `web/src/interface/` | Entire web UI (~21 500 строк), общий для браузера и нативных WebView. `interface.js` — только каркас класса `ZaliInterface` (конструктор, `init()`) плюс карта частей; тело разложено по 36 доменным файлам в `web/src/interface/`, подключаемым через `ZaliMixin` (`web/src/mixin.js`). Список и порядок файлов — `web/src/manifest.json` |
| `apps/macos/` | AppKit app (Swift Package Manager); wraps WKWebView, без SwiftUI — см. «macOS client». **Основной macOS-клиент** |
| `apps/windows/src/native.rs` + `apps/windows/src/native/` | Rust desktop shell (WRY/TAO). `native.rs` держит NativeState/bridges и центральный `handle_ipc_message`; подмодули `native/{http,cache,keyring,util,transport,api,messages}.rs` — HTTP-клиенты, кэш расшифровки, keyring, санитайзеры, WS-транспорты, API-запросы, конвейер сообщений. Кроссплатформенный: собирается для Windows (`scripts/build_windows_app.ps1`, основной путь) и как **экспериментальный** macOS-шелл (`scripts/build_macos_rust_app.sh`, см. ниже) |
| `core/` | Rust core library compiled to static `.a` for macOS FFI |
| `sdk/Rust/` | Archive format SDK; used by server and Windows client |
| `sdk/Swift/` | Swift mirror of the SDK; used by macOS client |

## Architecture

### Message flow
1. Sender calls `sendMessage` IPC on macOS/Windows → native client POSTs to `/api/send` with a `.zali` archive body
2. Server stores the archive blob, delivers via WebSocket to recipient's connected sessions
3. Recipient native client receives WS event, calls `downloadMessage`, unpacks the `.zali` archive, decrypts

### Бинарные ответы через нативный мост (`API_REQUEST`)

Мост — JSON-канал, по нему ходят строки, поэтому у ответа **два тела**: текст едет
в `body`, всё остальное — base64 в `bodyBase64`. Развилку делает оболочка по
`Content-Type`; правило одно на всех и продублировано в четырёх местах:
`NetworkService.isTextualContentType` (macOS), `native/api::is_textual_content_type`
(Windows, с тестом), `NativeBridge.isTextualContentType` (Android) и разбор в
`nativeApiResponse()` (`web/src/interface/api.js`). Отсутствующий `Content-Type`
считается текстом.

Почему так, а не «всё строкой», как было до 0.2b33: бинарь не переживает такой
проезд. На macOS `String(data:encoding:.utf8)` возвращает **nil** на первом же
байте PNG — тело приезжало пустым, `res.blob()` отдавал Blob нулевого размера, и
`loadServerAsset` молча рисовал букву вместо иконки сервера. На Android
`body.string()` подставляет replacement-символы — картинка приезжала битой. То есть
иконки и баннеры серверов не работали **ни в одной** нативной оболочке, а
`res.arrayBuffer()` в мостовом ответе отсутствовал вовсе.

### .zali archive format
Magic header `ZALIMSSG` (8 bytes) + 1-byte protocol version, followed by AES-256-GCM encrypted chunks of 1 MB each. **Nonce per chunk**: `base_nonce[8..12]` += `chunk_index` using **wrapping addition** (not XOR). This matches Swift `addNonceCounter` and Rust `wrapping_add`. PBKDF2-SHA256 at 210 000 iterations for key derivation; always use `Array(password.utf8).count` (not `password.count`) for byte length.

### E2E key exchange — только для личных переписок (`dm:`)

Conversation-scoped keys are exchanged via ECDH + AES-GCM envelopes. `resolveConversationCryptoKey`
in `interface.js` deduplicates concurrent requests via `_resolveKeyInFlight` Map. After decrypting a
key envelope, verify `payload.sender` matches the expected peer from the conversation scope.

**Каналы серверов (`server:sid:cid`) в этом не участвуют вообще — с 0.2b31.** Их ключ
**выводится** из scope: `deriveServerChannelKey()` = base64url(SHA-256(`zali-channel-key-v1:` + scope)).
Никакого реестра, никаких конвертов, никакого ожидания чужого ключа, никакой генерации
случайного — `_resolveConversationCryptoKeyImpl` уходит в `adoptDerivedChannelKey()` первой же
строкой.

Почему: канал жил по схеме личной переписки, то есть первый открывший придумывал случайный ключ
и рассылал его конвертами ECDH — **по одному на устройство каждого участника**. Для двоих это
работает, для канала нет: доставка зависит от того, зарегистрировано ли устройство получателя,
дошёл ли конверт и не придумал ли получатель тем временем свой ключ. На практике канал читали
ровно те двое, у кого обмен случайно сошёлся, остальные видели «Зашифрованное сообщение
недоступно».

**Это осознанно НЕ сквозное шифрование** (см. «Что остаётся незакрытым»). Кто знает id сервера и
канала, знает и ключ, а сервер их знает по определению.

Инварианты, которые нельзя потерять (проверяются `crypto_doctor`, блок «channel: three members»):
- ключ канала одинаков у всех участников **на первом же resolve**, до всякой сходимости;
- вывод ключа канала не создаёт заявок в `conversation_key_registry` и **не шлёт ни одного
  конверта** (`publishConversationKeyToServerMembers` — заглушка, `reconcileConversationKey`
  для `server:`-scope выходит сразу);
- входящий конверт со старым случайным ключом канала принимается **только как кандидат на
  расшифровку** (`addAltConversationKey`), активным не становится — иначе старый клиент снова
  увёл бы канал на ключ, которого нет у остальных;
- прежний активный ключ канала при переходе не выбрасывается, а демотируется в `alt:` —
  история, зашифрованная до перехода, остаётся читаемой на том же устройстве.

### Server (`server/src/`)
Axum server split into modules (2026-07-07); `main.rs` keeps Config/AppState/router, handlers live in per-domain modules (see Project Structure). Key invariants established by recent security fixes:
- `ensure_server_member` uses `ON CONFLICT DO NOTHING` — never demotes existing roles; use `upsert_server_member` for explicit role updates
- `revoke_device` wraps the active-count check + UPDATE in a `BEGIN IMMEDIATE` transaction
- `join_server_link` SQL has no `OR id = ?` clause; private servers (`is_public == 0`) are rejected after lookup
- Passwords are capped at 72 bytes at registration (bcrypt silent truncation prevention)
- `approve_device` rejects self-approval (`target_id == actor_id`)
- File deletions in `delete_server` happen **after** transaction commit

### Hash chain переписки (`server/src/hash_chain.rs`)

Append-only журнал **событий** сообщений: на каждое создание/редактирование/удаление
добавляется запись, связанная SHA-256 с предыдущей. Хранится только хэш **шифротекста**
`.zali` — ни ключа, ни открытого текста сервер не узнаёт; он лишь получает возможность
доказать, что сообщение было и что данный архив — тот самый.

- **Метка `"<номер сообщения>.<версия>"`.** Номер — позиция сообщения в переписке,
  выдаётся один раз и **никогда не переиспользуется** (даже после удаления: иначе
  удалённое и его замена были бы в журнале неотличимы). Версия: `0` — оригинал,
  далее каждое редактирование, и **удаление тоже занимает версию**.
- **Scope** тот же, что у history-тикетов и реестра ключей: `dm:a:b` / `server:sid:cid`.
- **Хэш записи length-prefixed.** Каждое поле идёт в SHA-256 как `be32(len) || bytes`.
  Простая конкатенация позволила бы двум разным записям совпасть (`actor="ab",id="c"`
  и `actor="a",id="bc"` дают один и тот же байтовый поток) — для tamper-evident журнала
  это недопустимо. В хэш входит и `conversation_scope`, поэтому цепочку нельзя целиком
  перенести в экспорт другой переписки.
- **`BEGIN IMMEDIATE` + отдельная задача.** `position` и `message_number` — обе
  read-then-write выдачи, дефолтная deferred-транзакция дала бы двум одновременным
  отправителям прочитать одну и ту же голову. Вся транзакция выполняется в собственном
  `tokio::spawn`: axum роняет future хендлера при разрыве соединения клиентом, и такой
  drop между `BEGIN IMMEDIATE` и `COMMIT` вернул бы в пул соединение с удерживаемой
  блокировкой записи sqlite — после чего встали бы **все** переписки.
- **Сбой журналирования не ломает отправку.** `record_message_event_best_effort` только
  пишет `error!` (приоритет из раздела «Приоритеты при исправлении багов»: мессенджер,
  отказывающийся доставить сообщение из-за икоты аудит-лога, хуже, чем пропуск в логе).
- **`.zali`-экспорт пересобирается при скачивании,** а не переписывается на каждое
  сообщение: архив — монолитный блоб, синхронное обновление означало бы перешифровку
  всей цепочки на каждой отправке (квадратичная работа на горячем пути). Файлы лежат в
  `<data_dir>/hash_chains/<sha256(scope)>.zali` (имя хэшируется — иначе участники
  переписки были бы видны в именах файлов), magic `ZALIHASH` (не `ZALIMSSG`, чтобы
  экспорт нельзя было скормить распаковщику сообщений). Внутри `chain.json` (полный лог)
  и `index.json` (плоская карта `"N.V" → хэш`).
- **Ключ экспорта** — `HASH_CHAIN_KEY`; пусто ≠ выключено (цепочка пишется всегда),
  поэтому пустое значение детерминированно выводится из `JWT_SECRET` через SHA-256.
  Ротация `JWT_SECRET` без явного `HASH_CHAIN_KEY` делает старые экспорты нечитаемыми.
- **`PUT /api/message/:id`** — редактирование (только автор; менеджеры канала могут
  *удалять* чужое, но переписывать от чужого имени — подлог, который цепочка честно
  записала бы на автора). Шлёт WS-событие `message_edited`; **клиенты его пока не
  обрабатывают и безопасно игнорируют** (web-ветка требует отсутствия `type`, Windows
  требует `id`+`filename`, macOS не декодирует `WsMessage` без `id`/`timestamp`) —
  UI редактирования это отдельная задача.

### Редактирование / удаление / ответ на сообщение

- **Цитата ответа лежит ВНУТРИ зашифрованного архива** — поле `MessageContent.reply`
  (`core/src/net.rs`), непрозрачная JSON-строка `{id, sender, text, attachmentCount}`,
  шифруется тем же ключом, что и текст (полная копия шаблона `call`). Это **снимок, а не
  ссылка**: иначе цитата пропадала бы, как только оригинал удалён, отредактирован или просто
  не попал в загруженное окно истории. Текст обрезается до 280 символов
  (`ZaliInterface.REPLY_QUOTE_MAX_CHARS`).
- **Куда пришлось продублировать `reply`** (тот же список, что и для `call`): `core/src/net.rs`
  (bus-команды + байтовый API), `core/src/lib.rs` (WASM), `web/src/modules/wasm_bridge.js`,
  macOS `ZaliCore.packMessage`/`MessagePayload`/`WebView.swift`, Windows
  `native/messages.rs`+`native.rs`, Android `ZaliCoreBridge.packMessage`/`MessagePayload` +
  `NativeBridge` (оба пути доставки). **`receiveMessage()` в `interface.js` собирает сообщение
  по полям, а не спредом** — забытое там поле теряется при живой доставке и «чинится» только
  следующей перезагрузкой истории; ровно это и произошло при первой сборке.
  Android в этот список **не попал** и просидел без `reply`/`call` с 0.2b26 до 0.2b33: ответ,
  отправленный с телефона, приезжал собеседнику без цитаты — безвозвратно, потому что цитата
  лежит внутри шифротекста и восстанавливать её неоткуда. Отдельно от кода: `.so` в
  `jniLibs/` тоже была старше `core/src/`, так что одной правки Kotlin не хватило бы.
- **Редактирует только автор.** Менеджеры канала могут *удалять* чужое (`can_delete_message`),
  но переписывать чужие слова от чужого имени — подлог, который hash chain честно записал бы
  на автора. Сервер (`PUT /api/message/:id`) проверяет это независимо от UI.
- **Правка заменяет архив целиком**, поэтому клиент обязан переупаковать сообщение вместе с
  вложениями и цитатой. Пропустить их = молча выбросить их из сообщения.
- Правка оптимистична и **откатывается при ошибке** (`submitMessageEdit`); правка «в то же
  самое» не отправляется вообще, чтобы не тратить версию в цепочке.
- `messageRenderKey` для сохранённого сообщения сворачивается в `id:<id>`, а
  `messageStableSignature` берёт от текста только **длину** — поэтому у отредактированных
  сообщений есть счётчик `editRev`, иначе правка, не изменившая длину, не перерисовывалась бы.
- Кэш расшифровки на нативной стороне (`decryptedMessageCache` / `forget_decrypted_message`)
  **обязан сбрасываться по id при правке** — он ключуется id, а содержимое под этим id
  меняется; без сброса история вечно перерисовывала бы текст «до правки».
- UI: пункты «Ответить»/«Изменить»/«Удалить» живут в том же popup, что и реакции
  (`ensureReactionMenu`), полоса контекста композера — `#composerContext`.

### macOS client (`apps/macos/`)
- **Никогда не отдавать `JSONSerialization.data(withJSONObject:)` граф типа `Any` напрямую
  — только через `zaliJSONData`/`zaliJSONString` (`Services/JSONSafe.swift`).** Эта функция
  не бросает Swift-ошибку на непригодном значении, а **поднимает ObjC-исключение**
  `NSInvalidArgumentException` (`Invalid type in JSON write (__SwiftValue)`): любой
  Swift-struct/enum, попавший в `[String: Any]`, приезжает к писателю как `__SwiftValue`.
  `try?` это НЕ ловит, и Swift вообще не может — исключение разматывает стек прямо сквозь
  Swift-кадры. Если эти кадры принадлежат `async`-функции, размотка бросает на полпути
  пер-тредовое состояние рантайма конкурентности, и дальше **любой**
  `swift_task_isCurrentExecutorWithFlags` в процессе читает мусорный executor и падает —
  причём падает тот, кто спросит следующим: hit-test SwiftUI, mouse tracking WebKit,
  жест-распознаватели AppKit, системное меню-бар.
  Так выглядела волна крашей 2026-09-09: `[RemoteReactionSummary]` (обычный Codable-struct)
  клали в payload истории в `renderHistoryRecord`, а сериализовали в дочерней задаче
  `withTaskGroup`. Пять отчётов — пять несвязанных стеков, ни один рядом с настоящей
  ошибкой не лежал. Мораль: **проверка `isValidJSONObject` обязана быть ДО вызова**, и в
  `[String: Any]` для JS кладём только String/Number/Bool/Array/Dictionary — Codable-модели
  разворачиваем в словари руками. Побочно: то же самое молча теряло реакции в истории,
  потому что `javascriptLiteral` на невалидном графе отдаёт `null`.
- **Окно — чистый AppKit, SwiftUI в нём нет** (с 0.2b29). Это НЕ было лечением тех крашей
  (лечение — пункт выше), но убирает целый класс поражаемых мест: `WKWebView` добавляется
  подвидом в `contentView` окна, созданного руками в `AppDelegate`, меню строится
  программно (`installMainMenu()`), иначе в WKWebView не работают Cmd+C/V/X/A/Q. Пока
  `contentView` был `NSHostingView`, WebKit на **каждое** движение мыши гонял через
  `-hitTest:` всю responder-машинерию SwiftUI — и когда рантайм конкурентности был уже
  сломан, падало именно там. Теперь `SwiftUI.framework` не линкуется в бинарник вообще
  (`otool -L`), и заодно исчезает полный SwiftUI hit-test на каждое движение мыши в окне,
  которое целиком вебвью. **Не возвращать `NSViewRepresentable`/`WindowGroup` в
  macOS-клиент.**
- IPC: `WKScriptMessageHandler.userContentController` in `WebView.swift`; all handlers guard `message.frameInfo.isMainFrame`
- Crypto key is stored in a **plain file** (`Coordinator.saveLegacyCryptoKey` / `loadLegacyCryptoKey`, `~/Library/Application Support/ZaliMessenger/legacy_crypto_key.txt`), not Keychain and never UserDefaults. Keychain was removed 2026-07-03: `build_app.sh` never code-signs with a stable identity, so its ad-hoc signature changes on every rebuild — the Keychain ACL then treats each rebuild as "a different app," reprompting for consent on every launch. Do not reintroduce Keychain here (see project memory `feedback_no_keychain`)
- Camera/mic permission (`requestMediaCapturePermissionFor`) is granted only for `localhost`/`127.0.0.1` origins from the main frame
- Tenor URL resolution validates HTTPS + `tenor.com` host before fetching
- `javaScriptCanOpenWindowsAutomatically` is `false`

### macOS Rust shell (тот же крейт `apps/windows/`) — экспериментальный, не основной
После пробной миграции (2026-07) решено вернуться к Swift-версии как основной: голосовые звонки и уведомления в Rust-шелле не были подтверждены реальным использованием, а ценность отдельного нативного стека не перевесила риск. Код и сборка сохранены рабочими на случай, если понадобится вернуться. Крейт `zali_messenger_win` собирается и на macOS (WRY использует WKWebView). Сборка/запуск: `./scripts/build_macos_rust_app.sh` / `./scripts/run_macos_rust_app.sh`. Платформенные ветки:
- `NativeState::app_data_dir()`: Windows → `%LOCALAPPDATA%\ZaliMessenger`, macOS → `~/Library/Application Support/ZaliMessenger` (без этой ветки конфиг падал в temp и стирался ОС)
- `spawn_swift_keychain_migration()` (macOS only): фоновый одноразовый импорт ключа Swift-клиента из Keychain (`com.zali.messenger` / `zali_crypto_key_v2`). **Никогда не читать чужие Keychain-записи на стартовом пути** — модальный диалог доступа блокирует поток до ответа пользователя (приложение зависало до появления окна)
- Меню-бар через `muda` (macOS only) — без него в WKWebView не работают Cmd+C/V/Q
- `install_media_capture_policy()` в `main.rs` (macOS only): добавляет `requestMediaCapturePermissionForOrigin:` в UIDelegate wry через objc runtime — Grant только main frame + origin `zali://`/localhost, зеркало инварианта Swift-клиента. Диагностика окружения при старте уходит в trace-лог строкой `DIAG_ENV;...` (подтверждено: `zali://` — secure context, WebCrypto/WebRTC/getUserMedia доступны)
- Уведомления работают только из .app-бандла (mac-notification-sys). Голосовой звонок end-to-end реальным звонком пока не проверялся — все слои (getUserMedia grant, RTCPeerConnection, нативный WS-транспорт сигналинга) на месте
- Swift-версия (`apps/macos/`, `./scripts/build_app.sh`) — основная; оба .app могут сосуществовать (разные bundle id: `com.zali.messenger` и `com.zali.messenger.rust`), если понадобится вернуться к Rust-шеллу
- Кросс-сборка Windows-таргета с macOS **работает** через `cargo xwin build --target x86_64-pc-windows-msvc` (см. «Windows Build Distribution»). Голый `cargo check --target x86_64-pc-windows-msvc` по-прежнему падает на C-коде `ring` — не хватает заголовков Windows SDK, которые `cargo-xwin` подкладывает сам; это ограничение голого тулчейна, не регрессия

### Windows client (`apps/windows/src/native.rs`)
- `handle_ipc_message` is the central native bridge entry point
- URL path segments for dynamic values use `reqwest::Url::path_segments_mut().push()` — never `format!()` interpolation
- `perform_api_request` blocks `..`, `%2F`, `%5C` in paths
- **`API_REQUEST` обязан учитывать `timeoutMs` из payload** (`api_request_timeout` →
  `perform_api_request_with_timeout`), как macOS `performApiRequest` и Android `NativeBridge`.
  До этого любой мостовой запрос на Windows обрывался через 12 с `api_http_client()`, хотя
  веб для бинарных тел просит 120 с (`TRANSFER_REQUEST_TIMEOUT_MS`): на медленном канале
  аватар и баннер сервера после выбора файла просто не ставились.
- Avatar and message file downloads use streaming byte counters (100 MB and 512 MB caps respectively)
- `decode_data_url` has a 100 MB hard cap before any parsing

### Android client (`apps/android/`)

Тонкий шелл вокруг того же вебвью, но нативный слой у него **свой** — четвёртая
независимая реализация моста. Инварианты, найденные аудитом 0.2b33:

- **Всё, что обходит мост, на Android не работает.** Документ живёт по
  `file:///android_asset/web/`, а `fetch()` с такой схемы шлёт `Origin: null`, который
  сервер отвергает по CORS. Поэтому любой браузерный фолбэк здесь мёртв: `FormData`
  идёт мимо моста (`_apiFetchImpl` исключает её из нативного пути), а WASM-ветки не
  запускаются вовсе — Chromium не грузит ES-модули с `file://`. Из-за этого до 0.2b33
  молча не работали загрузка/удаление аватара (`hasNativeAvatarBridge()` не пускал
  транспорт `'android'`, хотя обработчики в `NativeBridge.kt` были написаны), правка
  сообщений и история каналов. Лечение — **нативный обработчик**, а не фолбэк:
  `serverHistory` и `editMessage` теперь объявлены `true` и реализованы в
  `handleLoadServerHistory` / `handleEditMessage`.
- **Перебор ключей ограничен и детерминирован** — `ZaliCoreBridge.MAX_DECRYPT_CANDIDATES`
  (12) плюс обход `conversationKeys.keys.sorted()`, и оба кэша расшифровки
  (положительный и отрицательный по `candidateKeysFingerprint`). Раньше в двух местах
  дописывались **все** значения мапы без потолка: цена одного нечитаемого сообщения
  росла вместе с историей `alt:`-ключей, а это два прохода PBKDF2 по 210 000 итераций
  на кандидата — на самом слабом железе из всех оболочек. Проверяется `perf_doctor`.
- **`allowBackup` выключен, и это не перестраховка.** В `filesDir` лежат
  `conversation_keys_<user>.json` (ключи переписок открытым текстом) и
  `shared_device_identity_<user>.json` (приватный ECDH-ключ). При `allowBackup="true"`
  Android без спроса выгружал бы их в Google Drive. Выключены **оба** канала:
  `android:allowBackup="false"` и `res/xml/data_extraction_rules.xml` (на API 31+
  читается именно он, и `device-transfer` — отдельный канал от `cloud-backup`).
- **Микрофон и камеру нужно просить у ОС.** `PermissionRequest.grant()` в
  `WebChromeClient` не выдаёт приложению того, чего у приложения нет: `RECORD_AUDIO` и
  `CAMERA` — dangerous-разрешения. Они были объявлены в манифесте с самого начала, но
  не запрашивались в рантайме нигде (в коде стоял только `POST_NOTIFICATIONS`), поэтому
  `getUserMedia()` падал и звонок на Android не мог начаться в принципе — при полностью
  рабочем сигналинге. Теперь `MainActivity` откладывает `PermissionRequest` до ответа
  системного диалога и отвечает вебвью ровно тем, что ОС дала.
- **`reply` и `call` едут внутри шифротекста**, поэтому их обязан пробрасывать и
  `packMessage`, и разбор `unpackMessage` (`ZaliCoreBridge`), и оба пути доставки в
  `NativeBridge`. Пропущенное поле теряется безвозвратно: восстанавливать цитату неоткуда.
- **Нативная нижняя панель** (Compose) прячет веб-док, поэтому её подсветка не может
  узнать о навигации, случившейся в вебе. Веб сообщает активную секцию полем `section`
  в `MOBILE_NAV_PROGRESS` (`activeMobileNavSection()` — один источник истины для обеих
  панелей). Вкладок четыре, включая Хаб: без него в Хаб можно было попасть только
  окольным путём, через сегмент-контрол внутри Настроек.
- **`<input type="file">` работает только через `onShowFileChooser`** (`MainActivity`).
  Android WebView, в отличие от WKWebView и WebView2, диалог сам не открывает: до этой
  правки `input.click()` молча не делал ничего, и на Android нельзя было поставить
  аватар/баннер сервера, аватар профиля и прикрепить вложение. Колбэк обязан получить
  ответ всегда (`null` при отмене), иначе вебвью больше не откроет выбор файла.
  `FileChooserParams.createIntent()` не используется: он берёт из `accept` только
  первый тип.
- Фоновой доставки нет: WS живёт в Activity, foreground-сервиса нет, Web Push отключён
  при наличии моста. Уведомления приходят, только пока приложение живо.

### Web UI (`web/src/interface.js` + `web/src/interface/`)

`ZaliInterface` был одним файлом на 21 500 строк; с 2026-08-18 тело класса разложено по
доменным частям в `web/src/interface/` (`voice_media.js`, `key_envelopes.js`, `message_send.js`,
…), а `interface.js` держит конструктор, `init()` и карту частей в шапке.

- **Части подключаются `ZaliMixin(ZaliInterface, class { ... })`** (`web/src/mixin.js`), а не
  объектными литералами: копируются *дескрипторы*, поэтому методы остаются неперечисляемыми,
  `static get` не вычисляется при переносе, а статические поля едут вместе со своими методами.
  Из-за этого в частях **нельзя использовать `super`** — `[[HomeObject]]` метода указывает на
  прототип анонимного class-выражения. Дубликат имени в двух частях побеждает последним (как и
  в едином class-теле), но `ZaliMixin` пишет об этом `console.error`.
- **Порядок загрузки — `web/src/manifest.json`, и только он.** Раньше тот же список был
  продублирован в `bundle_web.py` и в каждом харнессе; новый файл нужно вписать в манифест
  один раз, после чего он попадает и в бандл, и в `scripts/*_doctor`, и в `bridge_check.sh`.
- Части грузятся **после** `interface.js`: `ZaliMixin(...)` — обычный вызов на верхнем уровне,
  класс к этому моменту должен быть объявлен.
- `randomBase64` throws if `window.crypto.getRandomValues` is unavailable — no Math.random fallback
- CSS color values from server data pass through `safeCssColor()` before being set in style attributes
- `flushPendingOutbox` drops messages after 50 failed attempts (`MAX_OUTBOX_ATTEMPTS`)
- `renderMessageText` link hrefs unescape `&amp;` → `&` before passing to `this.esc()`
- Vault envelopes require `v === 1` and `iterations >= 100000` before decryption
- **Стикеры `.tgs` живут целиком в вебе.** `.tgs` — это gzip'нутый Lottie JSON, поэтому поддержка
  сводится к двум файлам: `web/src/vendor/lottie_light.min.js` (вендоренный lottie-web 5.12.2,
  сборка «light»: SVG-рендерер без expressions, MIT) и `web/src/modules/tgs.js` (`window.ZaliTgs`:
  gunzip + разбор + жизненный цикл анимаций). Нативным слоям **менять ничего не надо**: и
  macOS (`WebView.swift`, `SEND_MESSAGE`), и Windows (`native.rs`) кладут в архив `name`/`mimeType`/
  `kind` ровно такими, какими их отдал JS, а обратно возвращают вложение `data:`-URL'ом — тип
  файла их не интересует. Достаточно `bundle_web.py`.
  - Распознавание опирается на **имя файла**, а не только на mime: `.tgs` не имеет
    зарегистрированного типа, у ОС на него нет маппинга (`file.type` приходит пустым), а старые
    сборки и чужие клиенты присылают его как `application/gzip`/`application/octet-stream` с
    `kind: 'file'`. Поэтому `normalizeAttachment` **перебивает** входящий `kind` на `sticker`.
  - `ZaliTgs.gunzip` сначала пробует `DecompressionStream('gzip')`, и только при его отсутствии —
    свой inflate на JS. Фолбэк не декоративный: в WKWebView `DecompressionStream` появился лишь в
    Safari 16.4. Он проверен побайтовой сверкой с zlib (все типы deflate-блоков, уровни 0–9).
  - Анимацию нельзя просто оставить в DOM: перерисовка списка сообщений заменяет узлы целиком, а
    осиротевший плеер продолжает крутить свой rAF. `ZaliTgs.hydrate()` вызывается из
    `hydrateGifMedia()` и на каждом заходе убивает анимации, чьи узлы уже вне документа.

### Голосовые звонки (WebRTC full mesh) — инварианты

Вся WebRTC-логика живёт в `web/src/interface/voice_*.js` (`voice_transport`, `voice_media`,
`voice_negotiation`, `voice_call`, `voice_signal`, `voice_ui`) и исполняется в WebView; нативные шеллы
(macOS/Windows/iOS/Android) только ретранслируют `voice_*` по WS. **Правки голоса дублировать в
нативные клиенты не нужно** — достаточно `bundle_web.py`.

- **`isPoliteVoicePeer` обязана быть строгой инверсией `shouldInitiateVoiceOffer`.** Обе раньше
  возвращали одинаковое `me.localeCompare(other) < 0`, из-за чего владелец оффера оказывался
  «вежливым». При встречных офферах это давало звонок, в котором **никто не отправлял `answer`**:
  невежливая сторона штатно отбрасывала входящий оффер, а вежливая откатывала свой — тот, ответа на
  который ждал собеседник. ICE при этом продолжает ходить, поэтому звонок выглядит подключённым и
  молчит. Диагностируется мгновенно по серверному логу: `grep 'VOICE.*ROUTE' | grep -oE 'signalType=[a-z]+' | sort | uniq -c`
  — если `answer` равен нулю, это оно.
- **`voice.inviter` — это «кто позвонил», и пишется он только из инвайта, принятия и
  `voice_room_state` (поле `initiator`) — никогда из входящего оффера.** Отправитель оффера —
  тот, кто пересогласует (камера, ICE-restart). Лестница владельца оффера падает на `inviter`,
  когда `callTrack` нет, а его нет у клиента, восстановленного из снапшота комнаты (перезагрузка
  посреди звонка): до 2026-09-10 такой клиент решал по порядку имён, собеседник — по
  `callTrack.direction`, и для пар, где вызываемый сортируется раньше звонящего, оба владели
  оффером или никто. Проверяется `voice_doctor` («who placed the call survives renegotiation
  and reloads»).
- Откат оффера (`setLocalDescription({type:'rollback'})`) допустим **только** из состояния
  `have-local-offer`. Из любого другого он бросает исключение, которое обрывает обработчик, и ответ
  не создаётся.
- `handleVoiceSignal` применяет сигналы через **цепочку промисов на каждого пира**. Без неё
  обработчики переплетались на `await`, и ICE-кандидат мог попасть в `pendingIceCandidates` уже
  **после** того, как очередь слили, — такая пара никогда не завершала ICE.
- `ensureVoiceLocalStream()` дедуплицирует одновременные `getUserMedia` через общий in-flight промис.
  Без этого при 3+ участниках каждый входящий оффер запускал свой захват, лишние падали с
  `NotReadableError`, и тот пир отвечал `recvonly` — «меня не слышит только он».
- `sendVoiceOffer` и ветка ответа на оффер берут защёлку `entry.negotiating` **синхронно**, до первого
  `await`: ни `signalingState`, ни `offerSent` не меняются до резолва `setLocalDescription`, поэтому два
  наложившихся прохода `syncVoicePeers` иначе оба слали оффер одному пиру.
- Оффер, пришедший на пира с `connectionState === 'failed'`, **пересоздаёт** соединение: у вернувшегося
  участника DTLS-транспорт уже мёртв и новым оффером не оживает.
- ICE-restart разнесён по времени: сторона, не владеющая оффером, ждёт на 5 с дольше, иначе оба конца
  бьют restart одновременно ровно по сломанному линку.
- **Presence keepalive:** клиент раз в 8 с переотправляет `voice_join` с `keepalive: true`
  (`sendVoiceRoomPresence`), пока находится в комнате, и сразу при восстановлении соединения. Сервер
  выселяет из голосовой комнаты через **150 с** после закрытия WS (`realtime.rs`; окно было 12 с и
  45 с — оба короче реального реконнекта, так что **число здесь всегда сверяйте с `realtime.rs`**),
  а клиент сам никогда не перезаходил: браузерный `onopen` этого не делает, а на нативе голосовой WS
  переподключается внутри Swift/Rust.
- **Нативные шеллы сообщают о состоянии голосового транспорта** событием `voice_transport_state`
  (`up`/`down`), которое они кладут в тот же путь, что и серверные события. До 2026-09-06 JS не знал
  о реконнекте вовсе и ждал очередного тика keepalive, то есть до 8 с оставался «призраком» в комнате.
  На `up` клиент немедленно переотправляет presence и передёргивает согласование: всё, что ушло в
  сокет, пока он был мёртв, потеряно безвозвратно.
- **`voice_send_failed`** — оттуда же: на нативе `sendVoiceEvent` — fire-and-forget и всегда
  возвращает «доставлено», поэтому ветка «оффер не ушёл из клиента» работала **только в браузере**.
  Шелл сообщает о payload'ах, которые он гарантированно не доставит (переполнение очереди), и клиент
  снимает защёлку `offerSent`. Очередь у обоих шеллов ограничена 64 payload'ами: неограниченная росла
  весь обрыв и потом честно доставляла согласование звонка, от которого все давно отказались.
- Флаг `keepalive: true` делает `join_voice_room` **недеструктивным**: он может вернуть в комнату, но
  никогда не выводит из другой. `user_voice_rooms` — это `DashMap<username, room_id>`, то есть **одна
  комната на аккаунт**; без флага два устройства одного аккаунта в разных комнатах выбивали бы друг
  друга каждые 8 с.
- `join_voice_room` рассылает состояние комнаты всем **только если состав реально изменился**; при
  идемпотентном перезаходе снапшот уходит только отправителю.
- **DM-комнату восстанавливает keepalive.** `voice_rooms` живёт только в памяти, а DM-комнату
  создаёт исключительно `voice_call_invite` — поэтому после рестарта сервера идущий звонок терял
  сигналинг навсегда: медиа (P2P) ещё шло, но `voice_join` отвечал `room_not_found` вечно, и ни
  ICE-restart, ни переговоры больше не проходили. Теперь keepalive пересоздаёт комнату
  (`restore_dm_room`), но **только** под теми же проверками, что и инвайт: id вида
  `voice:dm:a:b:stamp` должен называть отправителя, и эти двое должны быть в контактах. В
  восстановленную комнату кладётся **только отправитель** — второй мог реально положить трубку, пока
  сервер лежал; он вернётся своим keepalive. Обычный (не keepalive) `voice_join` в несуществующую
  DM-комнату по-прежнему ошибка. Канальные комнаты этим не страдали: `join_voice_room` создаёт их по
  имени.
- **Каждый `voice_error` несёт машиночитаемый `code`** (`room_not_found`, `room_forbidden`,
  `channel_forbidden`, `not_a_contact`, …). Клиент завершает звонок по `room_not_found` для своей
  комнаты — сопоставлять по русскому тексту `message` нельзя, он меняется.
- **Звонок обязан уметь закончиться сам.** `superviseVoiceLinks` даёт линку ~8 минут; когда бюджет
  исчерпан у **всех** пиров, `concludeDeadVoiceCallIfNeeded` завершает звонок (и пишет запись в
  историю). Раньше супервизор просто замолкал, а панель показывала «В эфире» до ручного сброса.
  Второй путь к тому же — `concludeVanishedVoiceRoom` по `voice_error{code:room_not_found}`.
- **Ничего не согласовывается, пока звонок не принят.** Ветка оффера открывает микрофон и отвечает
  sendrecv-сессией; она делала это независимо от того, нажал ли пользователь «Принять», а сервер
  разрешает инициатору звонящей комнаты слать в неё `voice_signal`. То есть звонящий с
  модифицированным клиентом слышал собеседника до ответа. `applyVoiceSignal` отклоняет любой сигнал
  при `voice.status === 'incoming'`; штатный поток сюда не попадает (оффер уходит только после
  `voice_call_accepted`, а к тому моменту статус уже `connecting`).
- **Битрейт видео и шаринга делится на состав комнаты** (`voiceVideoBudget` /
  `applyVoiceVideoBitrateLimit`, пересчёт при смене roster'а). В mesh каждая камера кодируется и
  отдаётся **на каждого** пира: без лимита пятеро с камерами просят с аплинка 4–10 Мбит/с, и первым
  ломается аудио, которое делит с видео тот же канал. Камера запрещена больше чем на
  `MAX_MESH_VIDEO_PEERS` (6) собеседников; `MAX_MESH_AUDIO_PEERS` (8) — только предупреждение в лог.
  Аудио-лимит `maxBitrate` — 64 кбит/с (было 512 000, что при Opus'овых ~32 кбит/с не ограничивало
  ничего).
- **Телеметрия здоровья пира (`reportVoiceAudioHealth`) должна запускаться на ЗДОРОВОМ звонке.**
  Она ставилась под `if (!entry.statsTimer)` на переходе в `connected`, а таймер уже был заведён при
  создании пира и на здоровом пути не сбрасывался — то есть always-on диагностика «RTP идёт / sink
  играет», написанная ровно про «соединилось и молчит», на таких звонках не работала никогда, как и
  авторемонт заблокированного autoplay'ем sink'а. Таймер теперь заводится **одним** владельцем —
  `ensureVoicePeerStatsTimer`.

### WebSocket keepalive (`server/src/realtime.rs`)

- Сервер шлёт протокольный `Ping` каждые 20 с. Установившийся звонок не создаёт WS-трафика (медиа
  идёт P2P), а собственный ping клиента — это `setInterval`, который браузеры душат в фоновой вкладке;
  реверс-прокси закрывал такие соединения по idle. Ping/Pong обрабатывает сетевой стек браузера **без
  пробуждения JS**, поэтому троттлинг ему не страшен.
- **У КАЖДОГО клиентского сокета должен быть дедлайн ответа на пинг, а не только отправка пинга.**
  На обрыве без FIN (NAT, VPN, сон) отправка «успешна» минутами, а `sendPing` в URLSession не
  завершается вовсе. До 2026-09-10 дедлайн был только у голосовых сокетов: главный сокет сообщений
  macOS (`scheduleHeartbeat`, 20 с) и Windows (`run_message_transport`, 70 с без входящих
  кадров) висели полуоткрытыми с зелёным значком, и сообщения не приходили до перезапуска.
  Android закрыт OkHttp `pingInterval`, браузер/iOS — JS-сторожем в `connectBrowserVoiceSocket`.
- **Не возвращать отключение по тишине.** 70-секундный idle-timeout, добавленный вместе с Ping,
  за первые сутки убил 27 живых соединений: он судит о живости по отсутствию входящих кадров, а не
  все клиенты отвечают на Ping (у `tokio-tungstenite` при разделённом стриме Pong ставится в очередь
  и не отправляется, пока не опрашивают write-половину). Мёртвые соединения детектируются по ошибке
  отправки. Если проблема с фоновыми вкладками вернётся — слать Ping **без** привязанного таймаута.

### Standalone browser/PWA client (mobile + desktop, no native shell)
Started 2026-07-12: `web/index.html` + `web/app.js` can now run as a plain browser tab with zero
native bridge (macOS/Windows/iOS/Android), for direct-message text (and attachments) send/receive.

> **Деплой — отдельный шаг, и его легко забыть.** Standalone-клиент раздаёт nginx отдельного
> вхоста `msg.zalikus.org`, а не сам `zali_server`, поэтому ни сборка, ни коммит его не выкладывают.
> Точный набор файлов и команды — в `CLAUDE.local.md`. Проверять живой загрузкой, а не кодом
> ответа: `wasmAvailable` в консоли должен быть `true` (`.wasm` обязан отдаваться как
> `application/wasm`), а `https://msg.zalikus.org` — присутствовать в `ALLOWED_ORIGINS` серверного
> env, иначе клиент поднимется и не сможет сделать ни одного запроса.
- `hasNativeBridge()` gates almost every native-only code path in `interface.js`; the `!hasNativeBridge()`
  branches for sending, DM history load, and real-time receive used to just no-op/warn — they now
  have real browser implementations (`browserSendMessage`, `loadBrowserDmHistory`,
  `handleIncomingBrowserMessage` in `interface.js`, wired into `sendInputMessage`,
  `syncActiveConversation`/`refreshAfterKey`, and the existing `connectBrowserVoiceSocket()` WS's
  `onmessage`, respectively)
- The `.zali` archive format (message pack/unpack) needs a filesystem-free implementation for the
  browser. `sdk/Rust/src/lib.rs` gained `create_archive_bytes`/`extract_all_bytes` (in-memory,
  byte-for-byte wire-compatible with the path-based `create_archive`/`extract_all` — see the
  `bytes_archive_created_*` interop tests in `sdk/Rust/tests/archive.rs`); `core/src/net.rs` gained
  `pack_message_bytes`/`unpack_message_bytes` on top of those; `core/src/lib.rs` exposes them as
  `pack_message_wasm`/`unpack_message_wasm` via `wasm-bindgen` (feature `wasm`)
- `web/src/modules/wasm_bridge.js` lazily `import()`s `web/wasm-pkg/zali_core.js` (built by
  `scripts/build_web_wasm.sh`, must run before `bundle_web.py`) and exposes `window.ZaliWasm`
- **wasm32 gotchas hit and fixed**: `std::time::SystemTime::now()` panics on `wasm32-unknown-unknown`
  ("time not implemented on this platform") — use `js_sys::Date::now()` there instead (see
  `now_unix_secs()` in `core/src/net.rs`). `rand`'s `OsRng`/`thread_rng()` need `getrandom`'s `"js"`
  feature explicitly enabled via a `[target.'cfg(target_arch = "wasm32")'.dependencies]` override in
  `core/Cargo.toml` (Cargo won't infer it from the `wasm` feature alone). Both surfaced in-browser as
  an opaque `RuntimeError: unreachable` — `console_error_panic_hook` (wired in behind the `wasm`
  feature) turns that into a real Rust panic message in the browser console; keep it when debugging
  new wasm-bindgen exports
- Real-time delivery already had a permanent per-browser-tab WebSocket (`connectBrowserVoiceSocket`,
  auth via `/api/auth/ws-ticket` since the browser can't set a custom `Authorization` header on the
  WS handshake) — it only handled `voice_*` events before; a `Message` row pushed by
  `deliver_to_user`/`deliver_server_message` (server/src/realtime.rs) has **no `type` field** at all,
  which is how the new branch tells it apart from voice/avatar events on the same socket. That same
  socket's `onopen`/`onclose` now also drive `setConnectionStatus()` — it used to only ever fire from
  native `SET_CONNECTION_STATUS` events, so the "Подключено"/"Переподключение..." badge was
  permanently stuck on the latter in pure-browser mode even once messaging worked
- Servers/channels messaging is ported too: `loadServerMessages`'s browser-fallback branch used to
  show literal placeholder text (`msg.text || msg.content || 'Зашифрованное сообщение недоступно...'`)
  because the server can only return metadata for E2E-encrypted messages, never plaintext — it now
  routes each history row through `handleIncomingBrowserMessage` (same WASM download+unpack path used
  for live receive), which already branched on `serverId`/`channelId` from day one. Sending in a
  channel from the browser was already covered by `browserSendMessage` (it always forwarded
  `serverId`/`channelId`) — only the history-load side was still stubbed
- Voice **signaling** already worked in pure-browser mode before any of this (`sendVoiceEvent` falls
  back to the same WS when there's no native voice bridge) and `getUserMedia`/`RTCPeerConnection` are
  called unconditionally (never gated behind `nativeSupports('voice')`) — so calls should work
  end-to-end in two real browser tabs, but this wasn't verified live in this session (needs two
  audio-capable peers, not just console-driven state pokes)
- Added minimal PWA scaffolding for installability: `web/manifest.json`, `web/icon.svg`,
  `web/service-worker.js` (app-shell cache-first for static files, always network for `/api`, `/ws`,
  `/uploads`), registered from `bootstrap.js` only when `!window.__ZALI_NATIVE?.available` — meaningless
  under native shells that load this HTML via `loadHTMLString`/an inline string, not a real origin
- macOS/Windows/iOS/Android native clients are unaffected by all of the above — this is purely
  additive (a new, filesystem-free code path used only when no native bridge is present), not a
  duplicate of their FFI-based archive handling that needed porting.
- **Web Push (VAPID)** for real background delivery when the tab/PWA is fully closed (2026-07-12,
  same session as the iOS-parity mobile-web pass). Server: `server/src/push.rs`
  (`/api/push/vapid-public-key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `send_web_push()`),
  wired into `deliver_to_user` in `messages.rs` — only fires when `send_payload_to_user` found **zero**
  live WS connections, so a foreground tab never gets a duplicate push. `push_subscriptions` table
  added to `init_db()` in `lib.rs`. Disabled by default: unset `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
  (see `.env.example`) makes the pubkey route 404 so the client never subscribes, and `send_web_push`
  no-ops. Generate a keypair with `cargo run --manifest-path server/Cargo.toml --example gen_vapid_keys`
  (no OpenSSL CLI/Firebase/Apple account needed — pure Web Push + VAPID, works in Chrome/Firefox always,
  Safari/iOS only once the PWA is added to the home screen on iOS 16.4+). Client:
  `interface.js` `subscribeWebPush()` (called from `applySession` on login, gated
  `!hasNativeBridge()`), `service-worker.js` `push`/`notificationclick` handlers. **Deploy note:** the
  `web-push` crate's only encryption backend depends on `ece`, which needs OpenSSL — `server/Cargo.toml`
  pins `openssl = { features = ["vendored"] }` so the VPS build compiles OpenSSL from source instead of
  requiring `libssl-dev` preinstalled (slower first build, zero new system deps). Verified live
  end-to-end against Google's real FCM endpoint in this session: subscribe → DM from a second user with
  the receiver's WS closed → server built+signed+encrypted+POSTed the push → got a real 404 back (fake
  test endpoint) → correctly pruned the stale subscription row. A **real** granted-permission delivery
  (actual OS notification popping) was not observed live — the sandboxed dev browser's
  `Notification.requestPermission()` always resolves `"denied"` with no way to grant it
  programmatically; that's a tooling limitation of this environment, not exercised code.

## Производительность — инварианты, которые нельзя терять

`./scripts/perf_doctor/run.sh` (см. `scripts/perf_doctor/README.md`) проверяет их
на боевом `ZaliInterface`. Запускать после правок в отрисовке списка сообщений,
во вложениях, в аватарах и в персисте кэша.

Общий принцип: **цена действия пропорциональна действию, а не размеру всего,
что уже накоплено в переписке.**

### Двоичные данные не попадают в текстовые пути

Нативные шеллы отдают вложения и аватары в вебвью как `data:`-URL
(`WebView.swift::makeDataURL`, `native/util.rs::make_data_url`). Такой payload
обязан быть переведён в `blob:`-ссылку до того, как попадёт в разметку:

- вложения — `attachmentDisplayUrl()`, **только** из `renderAttachmentPreview()`.
  Не переносить вызов в `normalizeAttachment()`: её зовёт ещё и
  `saveStoredMessageCache()`, который обходит вложения **всех** переписок, и
  тогда клиент держал бы декодированную копию архива, которого никто не видел;
- аватары — `saveStoredAvatar()`, единственная точка входа в `avatarCache`.

До 2026-09-05 этого не было: кадр списка на диалоге из 60 сообщений с 6 МБ фото
занимал 10,5 МБ строки при 1070 символах текста, из них 2,5 МБ — тридцать копий
одного аватара; вся эта строка проходила через `esc()` (пять regex-проходов =
52 МБ сканирования) и оседала второй копией в `_lastMessagesHTML`.

**Ссылка в разметке больше не является полезной нагрузкой.** Нативному мосту
сохранения (`DOWNLOAD_ATTACHMENT`) нужен именно payload — обратный поиск живёт
в `_attachmentBlobPayloads` и используется в `downloadAttachmentFromHref()`.
Сломать его = молча свалиться в браузерный путь `<a download>`, который
WKWebView и WebView2 не исполняют.

### Персист кэша сообщений

- **Детектор изменений — сериализация БЕЗ payload-ов.** Байты вложения
  неизменны: сообщение с другим набором вложений — это другое сообщение, с
  другими id и размерами, а они в этой строке есть. Полный `JSON.stringify`
  архива ради сравнения стоил ~9 мс на каждое сохранение, включая те, что
  ничего не меняют.
- **В `localStorage` payload-ы пишутся только там, где их больше негде
  хранить.** `messageCachePayloadsHeldElsewhere()`: на macOS есть нативный
  кэш-файл (`saveMessageCache`), в браузере `blob:`-ссылка всё равно мертва
  после перезагрузки. Windows/iOS/Android нативного кэша **не имеют** —
  там payload-ы хранятся, пока влезают в квоту.
- **Отказ по квоте фиксируется против той строки, на которой произошёл.**
  Раньше `catch` сбрасывал `_lastSavedMessageCacheJson = null`, и каждое
  следующее сообщение заново пересобирало весь архив, заново падало и заново
  копировало всё в мост: 80 МБ за десять сообщений, до конца сессии. Это и
  выглядело как «со временем начинает тормозить».
- **`saveInjectedMessageCache()` кладёт объект, а не строку.**
  `loadInjectedMessageCache()` принимает оба вида, а `JSON.stringify` здесь был
  второй полной сериализацией архива на каждое сохранение.
- **`adoptAttachmentPayloads()`** — единственное, что берётся из входящей копии
  при сверке собственного отправленного сообщения. Без него после перезагрузки
  свои же фотографии навсегда оставались чипом с именем файла.

### Путь отправки

Между Enter и появлением пузырька не должно быть ни одного `await`, когда ключ
разговора уже есть на устройстве: `getStoredConversationKey()` синхронный,
`resolveConversationCryptoKey()` вызывается без ожидания ради своих побочных
эффектов. Сохранение кэша на этом пути — только `scheduleSaveStoredMessageCache()`.

### Отрисовка

- `esc()` — один проход по строке, а не пять. Проверяется поведением в
  `security_doctor` (`check_web.mjs`), не формой записи.
- `normalizeAttachments()` мемоизируется на массиве-источнике и инвалидируется
  по идентичности объектов и payload-строк; `normalizeAttachment()` возвращает
  уже нормализованный объект как есть.
- Видео: `autoplay loop muted` — только для гифкоподобных вложений, и
  `IntersectionObserver` обязан **симметрично** ставить на паузу за экраном
  (эталон — `modules/tgs.js`).
- Отчёты о неудачной расшифровке уходят из кадра отрисовки через
  `queueDecryptFailureReport()`; вся пачка делит один запрос
  `fetchCanonicalKeyIds(..., { allowCached: true })`.
- Мобильный `backdrop-filter` вынесен в токен `--m-glass` и снимается на время
  жеста (`body.mobile-nav-dragging`); `will-change: transform` ставится только
  на время жеста, а не навсегда.

### Постоянный кеш ассетов (`web/src/interface/cache.js`)

До 0.2b33 кеш аватарок и ассетов серверов был `new Map()` в конструкторе, то есть
жил до перезагрузки: каждый запуск заново качал аватарку каждого контакта, иконку
и баннер каждого сервера, а профиль перезапрашивался на каждом открытии. Теперь
под кешем есть диск — IndexedDB — и политика.

**Всё живёт в вебвью**, как и голосовые звонки: нативным слоям дублировать нечего,
достаточно `bundle_web.py`. Плата — там, где IndexedDB закрыта origin'ом документа,
кеш деградирует до прежнего поведения «только память». Проверять доступность
только реальным `open()`: наличие `window.indexedDB` ничего не значит, на
opaque-origin оно есть и бросает `SecurityError`.

- **Сводка дешевле файла.** На каждый файл один компактный stat (`{k,s,h,u,c,g,n,t}`,
  однобуквенные поля) в ОТДЕЛЬНОМ object store. Весь индекс поднимается одним
  `getAll()` при открытии, дальше попадание меняет только Map в памяти, а дирти-записи
  уходят пачкой раз в 4 с и на `visibilitychange`/`pagehide`. Отдельная транзакция на
  каждое обращение стоила бы дороже самой аватарки.
- **Вытеснение не читает диск.** `cacheEntryScore` = `обращения × вес класса / размер в КБ`,
  делённое на `1 + возраст последнего обращения в днях`. Три свойства сразу: чем
  пользуются — остаётся; аватарка в 8 КБ ценнее видео в 40 МБ при равных обращениях;
  прошлогодняя популярность не держит запись вечно.
- **Прогрев НЕ засчитывает обращения — и это принципиально.** `primeAssetCacheFromDisk()`
  берёт самые используемые записи; если бы он их же и повышал, счётчик подтверждал бы
  сам себя, и однажды популярная аватарка вечно попадала бы в прогрев, вечно обновляла
  время обращения и никогда не устаревала. Показ засчитывает `cacheNoteAssetUse()` из
  `loadStoredAvatar()`/`loadServerAsset()` — с окном дедупликации в 60 с, иначе счётчик
  мерил бы число перерисовок списка, а не полезность файла.
- **Прогрев — одна транзакция** (`cacheReadBatch`), а не по одной на запись: до 400
  переходов через границу процесса на самом старте приложения.
- **Режим и потолок — настройка устройства, не аккаунта** (`zali_cache_prefs_v1`).
  По умолчанию «Кешировать легковесное» и 2 ГБ. Ужесточение применяется сразу:
  `enforceCachePolicy()` выкидывает то, что новый режим больше не пускает (класс уже
  лежит в сводке — обходить файлы не нужно), потом добивает потолок.
- **memo стоит на ОТКРЫТИИ базы, а не на режиме** (`ensureCacheStorage` vs
  `ensureCacheReady`): иначе выключение кеша запоминало бы «базы нет» на весь сеанс и
  обратное включение не работало бы до перезагрузки. Очистка и `cacheDelete()`, наоборот,
  обязаны работать при выключенном кеше — им нужно добраться до записанного раньше.
- **Инвалидация обязана доходить до диска.** `clearStoredAvatar()` (то есть
  `handleAvatarUpdated`), 404 на аватарку/ассет и 404 на профиль удаляют запись, иначе
  перезагрузка возвращала бы снятую картинку.
- **Профиль показывается из кеша сразу и обновляется под рукой.** Прежнее решение
  «данные всегда перезапрашиваются, показать вчерашнее хуже, чем моргнуть скелетоном»
  не отменено: запрос уходит в той же строке, кеш занимает место скелетона на те
  100–300 мс, что он идёт. Сетевой сбой при уже показанной карточке НЕ заменяет её
  ошибкой.
- **Вложения пишутся с проверкой «уже лежит» по индексу в памяти.**
  `saveStoredMessageCache()` обходит весь архив на каждом сохранении — без этой проверки
  каждое новое текстовое сообщение переписывало бы на диск все фотографии переписки.
  Побочно это чинит Windows/iOS/Android, где localStorage перестаёт вмещать вложения
  задолго до того, как переписка станет большой, и фотографии в истории навсегда
  превращались в имена файлов.

- **Записи в кеш идут по одной** (`cachePut` → очередь → `cachePutNow`). Вытеснение решает по
  учёту занятого места, а запись попадает в учёт только после транзакции: пачка записей разом
  видела один и тот же старый объём и не вытесняла ничего (511 МБ + 50×1 МБ при потолке
  512 МБ давали 561 МБ). `_cachePutInFlight` не даёт поставить в очередь файл, который уже пишется.
- **Временный отказ открытия базы не запоминается.** Таймаут/`blocked` (чужая вкладка держит
  `deleteDatabase`) — это «база занята», а не «базы нет»: `ensureCacheStorage()` сбрасывает memo,
  не дёргает базу 30 с и затем повторяет прогрев (`scheduleCacheOpenRetry`). Запоминается только
  настоящее отсутствие IndexedDB.

Проверяется `scripts/perf_doctor/check_cache_policy.mjs` (IndexedDB не нужна).

## Безопасность — инварианты, которые нельзя терять

`./scripts/security_doctor/run.sh` (см. `scripts/security_doctor/README.md`) проверяет их
статически, `tests/security.rs` — поведением. Запускать после правок в нативных шеллах,
в `server/src/auth.rs` и в рендеринге веб-UI.

### Origin pin: чужая страница не должна попасть на нативный мост

Нативный мост привязан к **вебвью, а не к документу**: `window.webkit.messageHandlers`
(macOS/iOS), `window.ipc` (WebView2/WRY) и `addJavascriptInterface` (Android) достаются
любой странице, оказавшейся во фрейме. Через мост доступны токен сессии, ключи
разговоров, отправка сообщений и запись на диск. Поэтому в каждом шелле навигация
ограничена собственным документом, а всё остальное уходит в ОС:

| Шелл | Где | Что разрешено во фрейме |
|---|---|---|
| macOS | `WebView.swift` → `decidePolicyFor` + `isAppOriginURL` | `http://localhost`, `about:`, `blob:` |
| iOS | `WebView.swift` → `decidePolicyFor` | `file:` (бандл), `about:`, `blob:` |
| Android | `MainActivity.kt` → `shouldOverrideUrlLoading` + `isBundledOrigin` | `file:///android_asset/web/` |
| Windows/Rust | `main.rs` → `with_navigation_handler` + `with_new_window_req_handler` | `zali://localhost`, `https://zali.localhost` |

**Политика запрещает по умолчанию.** Правило, которое перечисляет плохое и падает в
`allow`, не пинит ничего. `http/https/mailto/tel` отдаются системному браузеру
(`NSWorkspace` / `UIApplication` / `Intent.ACTION_VIEW` / `open_external_url`),
остальное отменяется.

> До 2026-08-22 навигация не была ограничена нигде. На Android хватало обычной ссылки
> в сообщении: `openExternalLink` там no-op (нет capability `openExternalUrl`), поэтому
> тап уводил вебвью на страницу атакующего вместе с `ZaliAndroidBridge`.

Там же: доступ к камере/микрофону выдаётся только главному фрейму известного origin, а
на Android — ещё и по списку ресурсов (`request.grant(request.resources)` выдавал что
попросят и кому попросят).

### Учётные данные

- **JWT не принимается из query-строки.** Query попадает в логи обратного прокси,
  историю браузера и `Referer`, а токен живёт 7 дней. Для WS есть одноразовый тикет
  (`/api/auth/ws-ticket`, 30 секунд, сгорает при первом использовании) — он существует
  ровно потому, что браузер не может поставить `Authorization` на WS-хендшейк.
- **Два независимых бюджета логина.** По (логин, IP) — против подбора пароля к одному
  аккаунту. По IP отдельно и **только по неудачам** — против password spray по списку
  логинов, который первый бюджет не видит вообще (каждая попытка в своей корзине), а
  список аккаунтов и так отдаётся любому залогиненному через `/api/users`.
- **Длина пароля не логируется.**
- `ALLOW_GUEST_MODE=true` — это не «упрощённый вход», а отключение аутентификации:
  любой запрос без токена выполняется от имени `Zalikus`. Сервер пишет об этом
  предупреждение при каждом старте. В `.env.example` значение по умолчанию было `true`
  до 2026-08-22 — проверьте env боевого сервера (см. `CLAUDE.local.md`).
- `null` в `ALLOWED_ORIGINS` отфильтровывается на старте: это origin песочничного
  iframe, `data:`- и `file:`-документа, а CORS работает с `allow_credentials(true)`.
  В `.env.example` он тоже стоял.

### Секреты на сервере

Сервер **не хранит ключей переписок**. Реестр (`conversation_key_registry`) держит
SHA-256-отпечаток, а не ключ. Легаси-таблица `conversation_keys` с колонкой `key_value`
(настоящий AES-ключ, открытым текстом, рядом с шифротекстом, который он открывает)
теперь **удаляется** при старте, а не просто не используется: неиспользуемая таблица
всё равно читаемая.

### Что остаётся незакрытым (осознанно)

Список известных, осознанно не закрытых слабостей ведётся в `CLAUDE.local.md` (не в git:
репозиторий публичный). Сверяться с ним перед любой правкой в крипто, релизах и авторстве сообщений.

## Приоритеты при исправлении багов

**Фиксы работоспособности функций всегда важнее фиксов безопасности.** Мессенджер должен сначала корректно работать — отправлять, получать, шифровать, расшифровывать сообщения, совершать звонки. Если баг ломает функциональность, он критичен независимо от его природы. Баги безопасности, которые не нарушают работу, имеют низкий приоритет и могут быть отложены.

## Windows Build Distribution

### Что входит в дистрибутив

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
scripts/bundle_web.py         — бандлер веб-ассетов
scripts/build_windows_app.ps1 — PowerShell-скрипт сборки (+ установщика, см. ниже)
```

Сервер (`server/src/main.rs`), `apps/macos/`, `sdk/Swift/` — **не нужны**.

### Создать zip для передачи

```bash
zip -r zali-windows-source.zip \
  apps/windows/src apps/windows/Cargo.toml apps/windows/Cargo.lock apps/windows/build.rs \
  core/src core/Cargo.toml core/Cargo.lock \
  sdk/Rust/src sdk/Rust/Cargo.toml sdk/Rust/Cargo.lock \
  web/src web/bridge_protocol.json web/style.css web/index.html \
  scripts/bundle_web.py scripts/build_windows_app.ps1 \
  apps/windows/installer/ZaliMessenger.iss
```

### Кросс-сборка с macOS через `cargo-xwin` (работает, проверено 2026-07-26/27)

Отдельная Windows-машина для получения `.exe` **не нужна**: `cargo-xwin` сам скачивает Windows SDK
и CRT, то есть ровно те заголовки, из-за отсутствия которых раньше падал C-код `ring`. Все релизы
1.1.0–1.1.3 собраны так, за ~30 с.

```bash
cargo install cargo-xwin && rustup target add x86_64-pc-windows-msvc
cargo xwin build --release --manifest-path apps/windows/Cargo.toml --target x86_64-pc-windows-msvc
# → apps/windows/target/x86_64-pc-windows-msvc/release/zali_messenger_win.exe (~8 МБ)
```

Не забыть `python3 scripts/bundle_web.py` **до** сборки — `main.rs` вкомпилирует `web/app.js` через
`include_str!`, и без бандлинга в `.exe` попадёт старый JS.

> Кросс-сборка даёт валидный бинарник, но **ничего не говорит о поведении**: трей, автозапуск,
> toast-уведомления, AUMID, установщик и сам процесс обновления так не проверяются. Перед публикацией
> релиза `.exe` надо прогнать на живой Windows.

### Сборка на Windows-машине

**Предварительные требования:**
- Rust + MSVC toolchain (`rustup default stable-x86_64-pc-windows-msvc`)
- Python 3 (для `bundle_web.py`)
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) на целевой машине

**Порядок сборки:**
```powershell
# 1. Распаковать архив, перейти в корень
# 2. Собрать (PowerShell):
.\scripts\build_windows_app.ps1

# Результат: dist\windows\ZaliMessenger.exe
# Запустить сразу:
.\scripts\build_windows_app.ps1 -Run
```

`scripts/build_windows_app.ps1` автоматически запускает `scripts/bundle_web.py` перед `cargo build --release`.

Конфигурация сервера передаётся через env-переменные до бандлинга:
```powershell
$env:ZALI_API_BASE_URL = "https://msgs.zalikus.org"
$env:ZALI_WS_BASE_URL  = "wss://msgs.zalikus.org"
.\scripts\build_windows_app.ps1
```

### Установщик (Inno Setup) — онлайн-инсталлятор

`apps/windows/installer/ZaliMessenger.iss` (обновлён 2026-07-26) — это **онлайн-инсталлятор**:
он НЕ содержит `ZaliMessenger.exe` внутри себя. Вместо этого во время установки он сам
дёргает `GET {UpdateApiBaseUrl}/api/version?platform=windows` (тот же эндпоинт, что
проверяет апдейтер клиента, `server/src/updates.rs::get_latest_version`), скачивает
`downloadUrl`, проверяет `sha256` (через `certutil -hashfile`, встроен в Windows) и
только потом копирует файл в `{app}\ZaliMessenger.exe`. HTTP/скачивание — через
`WinHttp.WinHttpRequest.5.1` + `ADODB.Stream` (COM-объекты, встроены в Windows, никаких
доп. плагинов Inno не нужно). Значит один раз собранный `ZaliMessengerOnlineSetup.exe`
всегда ставит текущую опубликованную версию — не нужно пересобирать инсталлятор на
каждый релиз, только `POST /api/version` (см. «Publishing a client release» выше).

**Дополнительное требование:** [Inno Setup](https://jrsoftware.org/isinfo.php) (`ISCC.exe` должен быть в PATH). Локальная сборка Rust/Cargo для этого НЕ нужна.

```powershell
.\scripts\build_windows_app.ps1 -OnlineInstallerOnly
# Результат: dist\windows\installer\ZaliMessengerOnlineSetup.exe
```

Базовый URL API зашит по умолчанию как `https://msgs.zalikus.org` (`#define UpdateApiBaseUrl`
в начале `.iss`); переопределить на другой сервер можно через `/DUpdateApiBaseUrl=...` при
вызове `ISCC.exe` напрямую.

Ограничение: AppVersion инсталлятора (в Add/Remove Programs) — статичный плейсхолдер
`1.0.0`, а не реальная версия скачанного клиента (та известна только во время установки,
до компиляции `.iss` — не пробрасывается обратно в реестр Uninstall). Это косметическое
ограничение подхода «скачать при установке», сам клиент свою версию знает штатно.

**Не собирался и не проверялся на реальной Windows-машине** (см. общее ограничение среды
разработки ниже) — код написан по документированному COM/Pascal Script API Inno Setup,
но живое поведение (реальная загрузка с прод-сервера, проверка sha256, установка,
появление уведомлений) нужно проверить вручную на Windows.

Классический офлайн-путь (локальная сборка `.exe` + `-Run` без установщика) не изменился —
см. команды выше; он остаётся способом быстро проверить сам билд без инсталлятора.

Установщик регистрирует **AppUserModelID** (`com.zali.messenger`) на ярлыке в Start
Menu — это единственное, чего не хватало для стабильных Windows toast-уведомлений:
`set_windows_app_user_model_id()` в `main.rs` задаёт AUMID процесса в рантайме, но
Windows показывает тосты для неупакованных (non-MSIX) Win32-приложений надёжно,
только если тот же AUMID ещё и зарегистрирован через persistent-ярлык — это делает
параметр `AppUserModelID` в секции `[Icons]` `.iss`-скрипта.

Также добавляет (через чекбоксы в мастере установки, `[Tasks]` в `.iss`):
- ярлык на рабочем столе (не отмечен по умолчанию);
- автозапуск при входе в Windows со свёрнутым окном (`--start-minimized`,
  `HKCU\...\Run`) — отмечен по умолчанию, поскольку без этого приложение не работает
  в фоне и локальные уведомления просто не приходят, пока пользователь не откроет
  чат руками.

Соответствующее поведение в самом клиенте (`apps/windows/src/main.rs`, Windows-only):
- `install_windows_tray()` создаёт иконку в трее (крейт `tray-icon`, меню через его
  реэкспорт `muda` — **не** тот же `muda 0.12`, что использует macOS Rust-шелл
  напрямую: Cargo резолвит их как два независимых экземпляра одноимённого крейта,
  их типы несовместимы, смешивать нельзя) с пунктами «Открыть»/«Выход».
- `WindowEvent::CloseRequested` на Windows сворачивает окно в трей вместо выхода
  (`window.set_visible(false)`) — выйти по-настоящему можно только через «Выход» в
  трее (`AppEvent::Quit`, тот же путь, что использует апдейтер после установки
  обновления) или через диспетчер задач. На остальных платформах поведение не
  менялось.
- Флаг `--start-minimized` не показывает окно при старте (`with_visible(!start_minimized)`
  в `WindowBuilder`) — используется только автозапуском из установщика.

Иконка трея сейчас — сплошной квадрат брендового цвета (`--lime: #cbff00`),
сгенерированный в коде (`tray_icon_image()` в `main.rs`), а не настоящий `.ico` —
это осознанное упрощение, чтобы не тащить крейт декодирования изображений ради
одной маленькой иконки. Замена на нормальный многоразмерный `.ico` — косметическая
доработка на будущее.

**Ничего из этого не проверялось в работе на реальной Windows-машине.** Собирается всё
это теперь нормально — кросс-сборка через `cargo xwin` проходит (см. выше), так что
компиляцию можно не гадать, а просто выполнить. Но собранный бинарник ничего не говорит
о поведении: трей, автозапуск, установщик, AUMID-фикс и процесс обновления нужно
проверять вручную на Windows. Практика 2026-07-27 показала цену этого: у выпущенного
апдейтера при установке всплывало окно консоли и обновление не доводилось до конца —
кросс-сборка такое поймать не могла в принципе.

## Git Safety — уроки реального инцидента с потерей кода

**Инцидент** (пути ниже — в структуре **до** реорганизации 2026-07-12; см. новые пути в разделе «Project Structure»): `git checkout -f <branch>` + `git pull --ff-only` между двумя ветками с *разным набором отслеживаемых путей* удалили с диска реально нужные файлы — `Core/src/*.rs`, `ZaliArchiverSDK/Rust/src/lib.rs`, `ZaliArchiverSDK/Swift/`, `macOS/Sources/ZaliMessenger/{NetworkService,ZaliArc,ZaliCore,ContentView}.swift`, `Package.swift`, `Web/src/{bus,loader,styler,bootstrap}.js`, `Web/index.html`, `Web/style.css`, `bundle_web.py`, `run_macos_app.sh` и другие build-скрипты. Причина: `Core/`, `Web/`, `Windows/`, `macOS/`, `ZaliArchiverSDK/` в этом репо на разных ветках то отслеживались git, то были в `.gitignore` как "legacy, хранится только в рабочей копии" — то есть их реальный, актуальный код существовал **только на диске**, никогда не коммитился. `git checkout -f` без раздумий подменяет такие файлы версией из целевой ветки; `pull --ff-only` после этого удаляет всё, что в новом дереве не отслеживается вовсе.

### Что делать до git checkout -f / reset --hard / pull --ff-only между ветками

1. **Сначала сравнить наборы отслеживаемых путей**, а не только диффы содержимого:
   ```bash
   diff <(git ls-tree -r <branch_a> --name-only | sort) <(git ls-tree -r <branch_b> --name-only | sort)
   ```
   Если списки сильно расходятся (особенно если пропадают целые директории типа `Core/`, `macOS/Sources/`) — это сигнал, что одна из веток не отслеживает то, что реально нужно на диске. `git status`/`git diff` этого не покажут, они смотрят только на текущий working tree.
2. Никогда не считать, что `main` — это "полная" версия проекта, только потому что так называется. Проверять `git log --oneline <branch> | tail`, чтобы понять реальную родословную (в этом репо было **два разных** "Initial commit" в истории — следствие squash/subtree-операций в прошлом).
3. Если `.gitignore` содержит секцию вида `# Legacy ... kept only in the workspace` — это красный флаг: значит эти пути живут только на диске, git о них ничего не знает, и любая операция, переключающая ветки/делающая fast-forward, может их стереть без предупреждения.
4. Если всё же нужно переключиться — сначала `git stash -u` (включая untracked) или скопировать директорию целиком, а не надеяться, что git сохранит нетрекаемые файлы.

### Где искать material для восстановления, если файлы всё же пропали

1. **`.claude/worktrees/agent-*/`** — если есть параллельные воркчтри фоновых агентов, они могли быть на другом коммите и не затронуты катастрофой. Проверить `git worktree list` и сравнить содержимое.
2. **Zip-архивы дистрибуции** (см. раздел "Windows Build Distribution" выше) — `zali-windows-source.zip` и подобные экспорты кода в корне репо или `~/Downloads` — это снапшоты реального рабочего дерева на конкретную дату. Проверять `unzip -l`, дату модификации и **сверять SHA1** (`shasum`) прежде чем считать находку новой информацией — может быть побайтовая копия уже виденного. Помнить: windows-source zip **не включает** `macOS/`, `src/main.rs`, `ZaliArchiverSDK/Swift/` (старые имена — эти zip-архивы датированы до реорганизации 2026-07-12) — для macOS-файлов нужен архив вида `*-full-code.zip`/`*-all-code.zip`/`*-full-current-code.zip`.
3. **Перебор git-объектов** (`git fsck --unreachable`) может найти висячие blob'ы от старых коммитов/сбросов — но для больших репозиториев поштучный `git cat-file -p` на каждый хэш непрактично медленный; использовать один процесс `git cat-file --batch` с потоковым чтением через небольшой Python-скрипт.
4. **Кросс-сверка с другим клиентом**: Windows (`apps/windows/src/native.rs`) и macOS реализуют одну и ту же логику параллельно (IPC-бридж, ключи шифрования, реконнект WS, голосовой транспорт). Если один клиент пострадал, а другой цел и **реально свежий** (проверить по `git log`/датам файлов, а не предполагать), можно восстановить логику по образцу через `graphify query`/явное сравнение построчно — но не копировать бездумно: платформенные различия (например, macOS Keychain vs Windows `keyring` crate) означают, что порт требует адаптации, а не 1:1 копирования.

### Как проверять восстановленный/реконструированный код — не гадать, а компилировать

- После восстановления/дописывания кода **пересобирать и читать реальные ошибки компилятора** как чек-лист недостающих сигнатур — не пытаться угадать всё сразу. `swift build`/`cargo build` даёт точный список того, что реально используется вызывающим кодом (WebView.swift и т.п.), и это надёжнее, чем реконструкция "по памяти".
- graphify-граф (`graphify-out/graph.json`) хранит **только структуру** (какая функция существовала, на какой строке, что вызывала) — не тела функций. Полезен, чтобы понять, что *должно* существовать и с чем связано, но не для восстановления реализации 1:1.
- `bundle_web.py` — это сам по себе генерируемый/поддерживаемый код, который может незаметно деградировать (в этом инциденте восстановленная версия знала только про 5 JS-модулей вместо реальных 13, и не генерировала `native_types.js`/`BridgeProtocol.generated.swift` из `bridge_protocol.json`). После восстановления любого build-скрипта — **запустить его** и проверить, что вывод (счётчики файлов, сгенерированные артефакты) соответствует ожиданиям, а не просто "скрипт не упал".
- Финальная проверка любого клиентского фикса — реально собрать `.app`/бинарник и запустить (`open ZaliMessenger.app` + `ps aux` + проверка что процесс не упал), а не только "компилируется".

## Key Development Notes

- The server Cargo package is named `zali_server` (underscore), not `zali-server`. Use `cargo check -p zali_server`.
- `web/src/` is the canonical source (`interface.js` + `interface/*.js`, order in `manifest.json`); `bundle_web.py` concatenates it into macOS and Windows embedded assets. Always edit the source, then bundle. `bundle_web.py` теперь **падает** на отсутствующем файле из манифеста — раньше оно молча возвращалось с кодом 0, и сборщики вкомпиливали прошлый `app.js`.
- **`bundle_web.py` режет бандл на литералы по 200 000 символов — это не косметика.** `Assets.swift`
  получает HTML+CSS+JS Swift-литералами, каждый литерал компилируется в один `__cstring`-атом, а ld64
  именует атом его же содержимым и падает на имени больше ~1 МиБ:
  `ld: Assertion failed: (name.size() <= maxLength), function makeSymbolStringInPlace`. Ошибка не
  называет ни файла, ни символа. 2026-07-27 macOS-клиент из-за этого перестал линковаться вообще
  (1 098 746 байт ещё линковались, 1 185 134 — уже нет). Разбиение идёт по границам строк, склейка —
  `joined(separator: "\n")`, что точно воспроизводит исходник и обходит проглатывание перевода строки
  перед закрывающим разделителем; закрывающий `"""#` пишется в нулевую колонку. JSON протокола и
  конфига печатаются с `indent=2` по той же причине. Если ассерт вернётся — уменьшить
  `max_chunk_chars`.
- Апдейтер Windows (`apps/windows/src/native/updates.rs`): скрипт установки запускается **только с
  `CREATE_NO_WINDOW`**. Вместе с `DETACHED_PROCESS` этот флаг игнорируется, а у отсоединённого
  процесса нет консоли вообще — каждая консольная утилита внутри скрипта получала собственное окно,
  и пользователь видел всплывающее `find "<pid>"`. Ожидания через `tasklist`/`find`/`timeout` больше
  нет: Windows держит запущенный образ заблокированным, поэтому **повтор `copy` и есть ожидание**
  (`timeout` к тому же требует консольного ввода и падал мгновенно). Сбой не проглатывается: после
  60 попыток скрипт возвращает уже установленную версию и пишет причину в `updates/install.log` —
  путь реальный, установщик кладёт приложение в Program Files, куда неэлевированная копия запрещена.
- Апдейтер macOS (`UpdateService.installAndRelaunch`): старый бандл **сначала отодвигается**, а не
  удаляется. Раньше был `rm -rf` установленного `.app` и непроверенный `mv` — сбой переименования
  уничтожал установку и не запускал ничего. Теперь при любом исходе что-то стартует обратно, причина
  пишется в `updates/install.log`.
- If SwiftPM reports a stale module cache after moving the project, remove `apps/macos/.build` and rebuild.
- Runtime artifacts to keep out of version control: `zali_messenger.db`, `uploads/`, `target/`, `apps/macos/.build/`, `dist/`.
- Server env config: copy `.env.example` (repo root) to `.env`; set a real `JWT_SECRET` for any non-local deployment.
