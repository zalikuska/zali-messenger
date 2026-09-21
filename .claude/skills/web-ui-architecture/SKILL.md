---
name: web-ui-architecture
description: Структура web/src/interface.js (ZaliMixin, manifest.json) и мелкие сквозные веб-инварианты (esc(), randomBase64, outbox, стикеры .tgs). Использовать при добавлении новой части интерфейса или правках, затрагивающих несколько interface/*.js файлов.
---

# Web UI (`web/src/interface.js` + `web/src/interface/`)

`ZaliInterface` был одним файлом на 21 500 строк; с 2026-08-18 тело класса
разложено по доменным частям в `web/src/interface/` (`voice_media.js`,
`key_envelopes.js`, `message_send.js`, …), а `interface.js` держит конструктор,
`init()` и карту частей в шапке.

- **Части подключаются `ZaliMixin(ZaliInterface, class { ... })`**
  (`web/src/mixin.js`), а не объектными литералами: копируются *дескрипторы*,
  поэтому методы остаются неперечисляемыми, `static get` не вычисляется при
  переносе, статические поля едут вместе со своими методами. Из-за этого в
  частях **нельзя использовать `super`** — `[[HomeObject]]` метода указывает
  на прототип анонимного class-выражения. Дубликат имени в двух частях
  побеждает последним, но `ZaliMixin` пишет об этом `console.error`.
- **Порядок загрузки — `web/src/manifest.json`, и только он.** Новый файл
  нужно вписать в манифест один раз — он попадает и в бандл
  (`bundle_web.py`), и в `scripts/*_doctor`, и в `bridge_check.sh`.
- Части грузятся **после** `interface.js`: `ZaliMixin(...)` — обычный вызов
  на верхнем уровне, класс к этому моменту уже объявлен.

## Мелкие сквозные инварианты

- `randomBase64` бросает, если `window.crypto.getRandomValues` недоступен —
  без фолбэка на `Math.random`.
- CSS-цвета из серверных данных проходят через `safeCssColor()` до попадания
  в style-атрибуты.
- `flushPendingOutbox` дропает сообщения после 50 неудачных попыток
  (`MAX_OUTBOX_ATTEMPTS`).
- `renderMessageText` разэкранирует `&amp;` → `&` в href ссылок перед
  передачей в `this.esc()`.
- Vault-конверты требуют `v === 1` и `iterations >= 100000` до расшифровки.
- **Стикеры `.tgs` живут целиком в вебе.** `.tgs` — gzip'нутый Lottie JSON,
  поддержка сводится к двум файлам: `web/src/vendor/lottie_light.min.js`
  (вендоренный lottie-web 5.12.2, «light»-сборка: SVG-рендерер без
  expressions, MIT) и `web/src/modules/tgs.js` (`window.ZaliTgs`: gunzip +
  разбор + жизненный цикл анимаций). Нативным слоям менять ничего не надо —
  и macOS (`WebView.swift`, `SEND_MESSAGE`), и Windows (`native.rs`) кладут в
  архив `name`/`mimeType`/`kind` ровно такими, какими их отдал JS, а обратно
  возвращают вложение `data:`-URL'ом. Достаточно `bundle_web.py`.
  - Распознавание опирается на **имя файла**, не только на mime: `.tgs` не
    имеет зарегистрированного типа, у ОС нет маппинга (`file.type` пустой), а
    старые сборки и чужие клиенты присылают его как
    `application/gzip`/`application/octet-stream` с `kind: 'file'`.
    `normalizeAttachment` **перебивает** входящий `kind` на `sticker`.
  - `ZaliTgs.gunzip` сначала пробует `DecompressionStream('gzip')`, и только
    при отсутствии — свой inflate на JS: в WKWebView `DecompressionStream`
    появился лишь в Safari 16.4. Проверен побайтовой сверкой с zlib.
  - Анимацию нельзя просто оставить в DOM: перерисовка списка сообщений
    заменяет узлы целиком, осиротевший плеер продолжает крутить свой rAF.
    `ZaliTgs.hydrate()` вызывается из `hydrateGifMedia()` и на каждом заходе
    убивает анимации, чьи узлы уже вне документа.

Для отрисовки/памяти/кеша — скилл `performance`. Для голосовых частей
(`voice_*.js`) — скилл `voice-calls`.
