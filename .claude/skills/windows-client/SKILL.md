---
name: windows-client
description: Windows-клиент, apps/windows/src/native.rs — центральный IPC-мост, HTTP-запросы, таймауты, лимиты скачивания. Использовать при правках handle_ipc_message или API_REQUEST на Windows.
---

# Windows client (`apps/windows/src/native.rs`)

- `handle_ipc_message` — центральная точка входа нативного моста.
- URL path segments для динамических значений — только через
  `reqwest::Url::path_segments_mut().push()`, никогда `format!()`-интерполяция.
- `perform_api_request` блокирует `..`, `%2F`, `%5C` в путях.
- **`API_REQUEST` обязан учитывать `timeoutMs` из payload**
  (`api_request_timeout` → `perform_api_request_with_timeout`), как macOS
  `performApiRequest` и Android `NativeBridge`. До этого любой мостовой запрос
  на Windows обрывался через 12 с `api_http_client()`, хотя веб для бинарных
  тел просит 120 с (`TRANSFER_REQUEST_TIMEOUT_MS`) — на медленном канале
  аватар и баннер сервера после выбора файла просто не ставились.
- Скачивание аватара и файлов сообщений — стриминговые байтовые счётчики
  (потолки 100 МБ и 512 МБ соответственно).
- `decode_data_url` — жёсткий потолок 100 МБ до любого разбора.
- Для форматов бинарного ответа (`is_textual_content_type`) и общего протокола
  `.zali`/E2E-ключей — скилл `messaging-protocol`. Для origin pin навигации в
  WRY — скилл `security-invariants`. Для сборки/дистрибуции (installer, трей,
  автозапуск, cross-compile) — скилл `windows-build-distribution`.

## Кружок непрочитанного на панели задач (`native/taskbar_badge.rs`)

Растеризация вынесена в `native/badge_render.rs` (чистый код, `cargo test badge_render`
работает на любой платформе); `taskbar_badge.rs` отдаёт ей только размер по DPI
окна и маску цифр из GDI.

- **Цвет — парами (r, g, b), упаковка в одном месте (`pack`).** DIB 32 bpp — это
  `0xAARRGGBB`; прежняя константа `0xFF2A2AE6` («красный» в голове автора) была
  R=0x2A, B=0xE6, то есть синей. Тест `the_badge_is_red_not_blue` держит это.
- **Размер от DPI окна** (`GetDpiForWindow` → `badge_size_for_dpi`: 16/20/24/32),
  а не константа 16: на 150–200 % оболочка растягивала 16 px и значок был
  «пиксельным».
- **Края и цифры сглажены:** круг — суперсэмплинг 4×4, цифры — Segoe UI Bold через
  GDI (`ANTIALIASED_QUALITY`, серый на чёрном → карта покрытия). Блоки 3×5 не
  возвращать. Пиксели в DIB — **предумноженные**.
- Живой Windows этот рендер не видел (проверено только компиляцией под
  `x86_64-pc-windows-msvc` и тестами `badge_render`).
