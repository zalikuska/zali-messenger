---
name: browser-pwa-client
description: Standalone browser/PWA-клиент (web/index.html + web/app.js, без нативного шелла) — msg.zalikus.org. Использовать при правках WASM-моста, Web Push подписки или browser-фолбэков в interface.js.
---

# Standalone browser/PWA client (mobile + desktop, no native shell)

Работает как обычная вкладка браузера с нулевым нативным мостом (macOS/
Windows/iOS/Android), для отправки/приёма текста и вложений в личке.

- `hasNativeBridge()` гейтит почти каждый native-only путь в `interface.js`;
  ветки `!hasNativeBridge()` для отправки, загрузки истории DM и приёма в
  реальном времени реализованы: `browserSendMessage`,
  `loadBrowserDmHistory`, `handleIncomingBrowserMessage` в `interface.js`,
  подключены в `sendInputMessage`, `syncActiveConversation`/`refreshAfterKey`
  и существующий WS `connectBrowserVoiceSocket()`'s `onmessage`.
- Формат `.zali` (pack/unpack) нужен без файловой системы для браузера:
  `sdk/Rust/src/lib.rs` → `create_archive_bytes`/`extract_all_bytes`
  (in-memory, побайтово wire-совместимые с path-based версиями — тесты
  `bytes_archive_created_*` в `sdk/Rust/tests/archive.rs`); `core/src/net.rs`
  → `pack_message_bytes`/`unpack_message_bytes`; `core/src/lib.rs` экспортирует
  их как `pack_message_wasm`/`unpack_message_wasm` через `wasm-bindgen`
  (фича `wasm`).
- `web/src/modules/wasm_bridge.js` лениво `import()`'ит
  `web/wasm-pkg/zali_core.js` (собран `scripts/build_web_wasm.sh`, обязан
  выполниться до `bundle_web.py`) и экспонирует `window.ZaliWasm`.
- **Пойманные wasm32-ловушки**: `std::time::SystemTime::now()` паникует на
  `wasm32-unknown-unknown` — использовать `js_sys::Date::now()`
  (`now_unix_secs()` в `core/src/net.rs`). `rand`'s `OsRng`/`thread_rng()`
  нужна `getrandom`'s `"js"`-фича явно через
  `[target.'cfg(target_arch = "wasm32")'.dependencies]` override в
  `core/Cargo.toml` — Cargo не выведет её из одной фичи `wasm`. Обе всплывали
  как непрозрачный `RuntimeError: unreachable` —
  `console_error_panic_hook` (за фичей `wasm`) превращает это в настоящее
  сообщение паники Rust в консоли браузера.
- Постоянный per-tab WebSocket (`connectBrowserVoiceSocket`, авторизация
  через `/api/auth/ws-ticket`, потому что браузер не может поставить свой
  `Authorization` на WS-хендшейк) раньше обрабатывал только `voice_*`;
  `Message`-строка от `deliver_to_user`/`deliver_server_message`
  (`server/src/realtime.rs`) **без поля `type`** — так новая ветка отличает
  её от voice/avatar событий на том же сокете. Этот же сокет's
  `onopen`/`onclose` теперь драйвит `setConnectionStatus()` — раньше он
  срабатывал только от нативного `SET_CONNECTION_STATUS`, и бейдж «Подключено»
  был вечно залипшим в чистом браузере. **Только без оболочки** (`setBrowserSocketStatus`): в
  Android-оболочке индикатор и точки «в сети» ведёт её сокет, а запасной сокет WebView рвётся
  в фоне чаще и гасил их при живом основном. Оболочка шлёт статус только переходами, а
  `loader.bus.send` до готовности страницы ничего не делает — потерянный «подключено»
  исправляет `noteNativeFrame()` (любой реальный кадр от оболочки, кроме `native_*`).
- Мессенджинг серверов/каналов тоже портирован: browser-fallback ветка
  `loadServerMessages` теперь прогоняет каждую строку истории через
  `handleIncomingBrowserMessage` (тот же путь скачивания+распаковки WASM, что
  и живой приём), а не показывает плейсхолдер — сервер отдаёт метаданные для
  E2E-сообщений, никогда открытый текст.
- Голосовой **сигналинг** уже работал в чистом браузере до этой работы
  (`sendVoiceEvent` падает на тот же WS без нативного voice-моста), а
  `getUserMedia`/`RTCPeerConnection` вызываются безусловно (не за
  `nativeSupports('voice')`).
- PWA-скаффолдинг для установки: `web/manifest.json`, `web/icon.svg`,
  `web/service-worker.js` (app-shell cache-first для статики, всегда сеть для
  `/api`, `/ws`, `/uploads`), регистрируется из `bootstrap.js` только когда
  `!window.__ZALI_NATIVE?.available`.
- **Web Push (VAPID)** для доставки при полностью закрытой вкладке/PWA.
  Сервер: `server/src/push.rs` (`/api/push/vapid-public-key`,
  `/api/push/subscribe`, `/api/push/unsubscribe`, `send_web_push()`),
  вызывается из `deliver_to_user` только когда `send_payload_to_user` не
  нашёл ни одного живого WS — foreground-вкладка не получает дубликат.
  Таблица `push_subscriptions` в `init_db()`. Выключено по умолчанию: без
  `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` роут ключа отдаёт 404 и клиент не
  подписывается. Ключи — `cargo run --manifest-path server/Cargo.toml --example gen_vapid_keys`.
  Клиент: `interface.js` `subscribeWebPush()` (вызывается из `applySession`
  при логине, за `!hasNativeBridge()`), `service-worker.js`
  `push`/`notificationclick`. **Деплой**: `web-push`'s ece-бэкенд требует
  OpenSSL — `server/Cargo.toml` пинит `openssl = { features = ["vendored"] }`,
  чтобы VPS собирал OpenSSL из исходников вместо требования `libssl-dev`.
  Подробнее про решение «показывать ли пуш по устройству» — скилл
  `notifications`.

## Деплой

Клиент лежит на `msg.zalikus.org/web/`, на корне домена — сайт (`site/`). Дерево собирает
`python3 scripts/build_site_dist.py` (`dist/site/`): `/` — сайт, `/web/…` — клиент,
`/service-worker.js` — копия `web/service-worker.js` с `APP_ROOT = '/web/'`. Скрипт воркера
остаётся в корне под прежним URL нарочно: у тех, кто ставил PWA, когда клиент жил на корне,
регистрация со scope «/» держит подписки Web Push; новый путь завёл бы вторую регистрацию
(дубли уведомлений), а клик по пушу от старой открывал бы сайт. Клиент регистрирует именно
`/service-worker.js` (`bootstrap.js`). Ссылки `/server/<код>` и `/profile/<имя>` nginx
перенаправляет на `/web/server/…`, `<base>` ставит `index.html` по префиксу пути.

Раздаёт nginx отдельного вхоста (`msg.zalikus.org`), а не сам `zali_server` —
ни сборка, ни коммит его не выкладывают, это отдельный ручной шаг (точные
команды — приватный скилл `zali-ops-deploy`). Проверять живой загрузкой, не кодом ответа:
`wasmAvailable` в консоли должен быть `true` (`.wasm` обязан отдаваться как
`application/wasm`), а `https://msg.zalikus.org` — присутствовать в
`ALLOWED_ORIGINS` серверного env.

macOS/Windows/iOS/Android нативные клиенты этим не затронуты — путь чисто
аддитивный (новый code path без файловой системы, используется только при
отсутствии нативного моста), не дублирует их FFI-based обработку архивов.
