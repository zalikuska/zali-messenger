---
name: security-invariants
description: Секьюрити-инварианты — origin pin нативных мостов, аутентификация, секреты. Использовать при правках навигации WebView/WRY/Android, auth.rs или хранения ключей.
---

# Безопасность — инварианты, которые нельзя терять

`./scripts/security_doctor/run.sh` проверяет их статически, `tests/security.rs`
— поведением. Запускать после правок в нативных шеллах, в `server/src/auth.rs`
и в рендеринге веб-UI.

## Origin pin: чужая страница не должна попасть на нативный мост

Нативный мост привязан к **вебвью, а не к документу**:
`window.webkit.messageHandlers` (macOS/iOS), `window.ipc` (WebView2/WRY),
`addJavascriptInterface` (Android) достаются любой странице, оказавшейся во
фрейме. Через мост доступны токен сессии, ключи разговоров, отправка
сообщений и запись на диск. Поэтому навигация в каждом шелле ограничена
собственным документом, всё остальное уходит в ОС:

| Шелл | Где | Что разрешено во фрейме |
|---|---|---|
| macOS | `WebView.swift` → `decidePolicyFor` + `isAppOriginURL` | `http://localhost`, `about:`, `blob:` |
| iOS | `WebView.swift` → `decidePolicyFor` | `file:` (бандл), `about:`, `blob:` |
| Android | `MainActivity.kt` → `shouldOverrideUrlLoading` + `isBundledOrigin` | `file:///android_asset/web/` |
| Windows/Rust | `main.rs` → `with_navigation_handler` + `with_new_window_req_handler` | `zali://localhost`, `https://zali.localhost` |

**Политика запрещает по умолчанию.** Правило, которое перечисляет плохое и
падает в `allow`, не пинит ничего. `http/https/mailto/tel` отдаются
системному браузеру (`NSWorkspace` / `UIApplication` / `Intent.ACTION_VIEW` /
`open_external_url`), остальное отменяется.

До 2026-08-22 навигация не была ограничена нигде. На Android хватало обычной
ссылки в сообщении: `openExternalLink` там no-op (нет capability
`openExternalUrl`), тап уводил вебвью на страницу атакующего вместе с
`ZaliAndroidBridge`.

Там же: доступ к камере/микрофону выдаётся только главному фрейму известного
origin, на Android — ещё и по списку ресурсов (было `request.grant(request.resources)`
— выдавал что попросят и кому попросят).

## Вложенные фреймы: мост и document-start только верхнему

Origin pin не защищает от фрейма, который собирает сам UI: песочница аддона —
`<iframe sandbox="allow-scripts" srcdoc>` внутри того же вебвью. Мост виден и ей,
а WebView2 (`with_initialization_script`) и Android
(`addDocumentStartJavaScript(…, setOf("*"))`) выполняют document-start скрипты во
**всех** фреймах — а они кладут в `window` токен сессии, ключи переписок и
приватный ключ устройства. Поэтому (с 0.2a49.13):

| Шелл | Как |
|---|---|
| macOS Swift | все `WKUserScript` с `forMainFrameOnly: true`, хендлер отбрасывает `!isMainFrame` |
| Windows/WRY | init-скрипт завёрнут `top_frame_only_script` (`native/frame_guard.rs`), `handle_ipc_message` требует `bridgeNonce` |
| Android | `documentStartScript()` выходит при `window.top !== window`, `postMessage` требует `bridgeNonce` |
| веб | `bootstrap.js` забирает `__ZALI_BRIDGE_NONCE__` в замыкание, удаляет из `window` и шлёт в каждом сообщении |

Шелл, где это сделано, объявляет capability `addonFrames`; без неё веб аддоны не
запускает. iOS её не объявляет (хендлер там `isMainFrame` не проверяет).
Проверяет `security_doctor`, раздел «Frame isolation».

## Учётные данные

- **JWT не принимается из query-строки.** Query попадает в логи обратного
  прокси, историю браузера и `Referer`, токен живёт 7 дней. Для WS —
  одноразовый тикет (`/api/auth/ws-ticket`, 30 секунд, сгорает при первом
  использовании) — существует ровно потому, что браузер не может поставить
  `Authorization` на WS-хендшейк.
- **Два независимых бюджета логина.** По (логин, IP) — против подбора пароля
  к одному аккаунту. По IP отдельно и только по неудачам — против password
  spray по списку логинов, который первый бюджет не видит вообще (каждая
  попытка в своей корзине), а список аккаунтов и так отдаётся любому
  залогиненному через `/api/users`.
- **Длина пароля не логируется.**
- `ALLOW_GUEST_MODE=true` — это не «упрощённый вход», а отключение
  аутентификации: любой запрос без токена выполняется от имени `Zalikus`.
  Сервер пишет предупреждение при каждом старте. В `.env.example` значение по
  умолчанию было `true` до 2026-08-22 — проверять env боевого сервера (см.
  `CLAUDE.local.md`).
- `null` в `ALLOWED_ORIGINS` отфильтровывается на старте: это origin
  песочничного iframe, `data:`- и `file:`-документа, а CORS работает с
  `allow_credentials(true)`. В `.env.example` он тоже стоял.

## Инварианты `server/src/` (auth/servers/roles/devices)

Модули по доменам (`auth.rs`, `contacts.rs`, `servers.rs`, `channels.rs`,
`roles.rs`, `messages.rs`, `assets.rs`, `realtime.rs`, `storage.rs`, `util.rs`,
`devices.rs`, `voice.rs`, `push.rs`, `updates.rs`, `conversation_keys.rs`,
`hash_chain.rs`); реэкспортируются в корень крейта (`pub(crate) use x::*;`),
`use crate::{...}` работает отовсюду. Инварианты, установленные недавними
security-фиксами — не ломать при рефакторинге:
- `ensure_server_member` использует `ON CONFLICT DO NOTHING` — никогда не
  понижает существующие роли; для явного обновления роли — `upsert_server_member`.
- `revoke_device` оборачивает проверку счётчика активных устройств + UPDATE в
  `BEGIN IMMEDIATE`-транзакцию.
- SQL `join_server_link` не содержит `OR id = ?`; приватные серверы
  (`is_public == 0`) отклоняются после поиска.
- Пароли ограничены 72 байтами при регистрации (защита от тихой обрезки bcrypt).
- `approve_device` отклоняет самоодобрение (`target_id == actor_id`).
- Удаление файлов в `delete_server` происходит **после** коммита транзакции.

## Секреты на сервере

Сервер не хранит ключей переписок. Реестр (`conversation_key_registry`)
держит SHA-256-отпечаток, не ключ. Легаси-таблица `conversation_keys` с
колонкой `key_value` (настоящий AES-ключ, открытым текстом, рядом с
шифротекстом, который он открывает) удаляется при старте, а не просто не
используется — неиспользуемая таблица всё равно читаемая.

## Что остаётся незакрытым (осознанно)

Список известных, осознанно не закрытых слабостей — в приватном скилле `zali-ops-open-risks` (не в
git, репозиторий публичный). Сверяться с ним перед любой правкой в крипто,
релизах и авторстве сообщений.


## Аудит 2026-10-11: что закрыто и как не потерять

Проверяет `security_doctor` (раздел `audit 2026-10-11`, `app frames and releases`)
и `tests/security.rs`, `tests/addons.rs`.

- **`JWT_SECRET`-заглушка.** Релизный бинарник паникует на `CHANGE_ME…`,
  повторяющихся символах (`is_weak_jwt_secret`). `.env.example` держит пустой.
  Релизный `ALLOWED_ORIGINS` по умолчанию — только `https://msgs.zalikus.org` и
  `zali://localhost` (localhost-порты — только debug-сборка).
- **Cookie без Origin-чека — это CSRF и CSWSH с соседних поддоменов.** Запрос с
  cookie допускается без `Origin` или с `Origin` из allowlist
  (`cookie_origin_allowed` в `auth.rs`, до проверки токена). Bearer не затронут.
- **Пароль = парольная фраза облачного vault.** Смена пароля
  (`POST /api/auth/password`, `changePassword()` в `auth.js`) обязана: синхронизировать
  vault под старым паролем, сменить на сервере, затем опубликовать vault под новым
  (`syncCloudVaultPackage({ force: true })`) и перезапечатать unlock-secret новым
  токеном. Менять пароль только на сервере нельзя — следующий вход не прочитает
  ни одного ключа.
- **Политика пароля** — `password_policy_error` (≥ 8, ≤ 72 байт, не логин, не из
  `COMMON_PASSWORDS`); один и тот же код на регистрации и при смене.
- **Коды приглашений** — 64 бита, провалы считаются на человека
  (`invite_attempts_exhausted`); старые 8-символьные коды продолжают работать.
- **WS:** кадр ≤ 256 КиБ, ≤ 24 соединений на человека, ≤ 400 входящих событий за
  10 с на соединение. Загрузки/аватары/ws-ticket — `rate_allow` на человека.
- **IPv6-лимиты считаются по /64** (`rate_bucket_ip`).
- **Push endpoint** проверяется и по имени, и по резолву (`endpoint_resolves_public`).
- **Релизы подписаны.** `/api/version` отдаёт `signature` (ES256 официального
  ключа над `zali-release-sig:v1\n<платформа>\n<версия>\n<sha256>\n<url>`).
  Клиент (`updates.js` → `verifyReleaseSignature`) не выдаёт ссылку на скачивание
  без валидной подписи и перепроверяет её перед загрузкой. Подписывает
  `scripts/release_sign.py`; формат держат вместе: он, `updates.rs`, `updates.js`.
- **Фреймы страницы** — `frame-src about: blob: data:` в `index.html`: политика
  родителя блокирует навигацию фрейма аддона на внешний адрес (проверено в браузере:
  `securitypolicyviolation frame-src`). Не добавлять в приложение `<iframe>` с
  внешним адресом без пересмотра этого правила.
