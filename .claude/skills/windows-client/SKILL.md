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
