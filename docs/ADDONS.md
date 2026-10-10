# Аддоны хаба — руководство автора

Аддон — мини-приложение, которое пользователь ставит в хаб одним файлом `.zali` и
запускает оттуда же на всё окно: мини-игра, запись голоса, сборщик модов, лаунчер
программы с компьютера. Аддон — это **интерфейс** (HTML/CSS/JS в песочнице) и, по
желанию, **бэкенд**: встроенные инструменты приложения (`window.zali`) или собственная
программа-процесс. Всё, что выходит за песочницу, выдаётся по разрешениям.

Готовые примеры — `examples/addons/` (змейка, голосовые заметки, лаунчер). Собрать
любой из них:

```bash
python3 scripts/addon_pack.py examples/addons/snake snake.zali
```

Где что в коде: формат и манифест — `web/src/modules/addon_format.js`, SDK —
`web/src/modules/addon_sdk.js`, хост — `web/src/interface/addons_*.js`, нативная часть —
`apps/windows/src/native/addon{s,_elevated}.rs`, `apps/macos/.../Services/Addon{Store,Elevated}.swift`,
`apps/android/.../AddonStore.kt`. Проверки — `scripts/security_doctor/check_addons.mjs`.

## 1. Файл `ZALIEXTN`

Тот же контейнер, что у `.zali` сообщений (`sdk/Rust` `ZaliSession`, `sdk/Swift` `ZaliArc`),
другой магик и без шифрования: файл должен читаться до установки, чтобы показать
пользователю, что аддон просит.

```
"ZALIEXTN"            8 байт
version   u8          = 1
id        u8 len+utf8 — id аддона (информационно, истина — в манифесте)
dom       u8 len+utf8 — "addon"
flags     u8          = 0 (шифрование запрещено)
count     u32 LE
count раз: nameLen u16 LE | name utf8 | size u64 LE | stored u64 LE (= size) | данные
```

Ограничения (их одинаково проверяют веб и нативные оболочки):

- файл ≤ 32 МБ, записей ≤ 2000, `manifest.json` ≤ 64 КБ;
- путь — сегменты `[A-Za-z0-9._-]+` через `/`, без `.` и `..`, без ведущего и
  завершающего `/`, ≤ 255 байт; имена, отличающиеся только регистром, — дубликаты;
- `flags ≠ 0`, `stored ≠ size`, лишние байты после последней записи — отказ.

Упаковщик `scripts/addon_pack.py <папка> <файл.zali>` проверяет всё это и манифест
заранее; скрытые файлы (`.git`, `.DS_Store`) пропускает.

## 2. Манифест `manifest.json`

```json
{
  "zaliAddon": 1,
  "id": "org.example.snake",
  "name": "Змейка",
  "version": "1.0.0",
  "description": "Классическая змейка",
  "author": "Имя",
  "icon": "icon.svg",
  "entry": "index.html",
  "permissions": ["cache", "network"],
  "network": ["api.example.com"],
  "backend": {
    "type": "process",
    "commands": {
      "macos-arm64": "bin/macos-arm64/backend",
      "macos-x64": "bin/macos-x64/backend",
      "windows-x64": "bin/windows-x64/backend.exe"
    },
    "args": []
  }
}
```

| Поле | Обязательно | Правило |
|---|---|---|
| `zaliAddon` | да | ровно `1` |
| `id` | да | `^[a-z0-9][a-z0-9._-]{2,63}$`, без `..`; это же имя папки на диске. Аддон с тем же `id` ставится поверх (обновление) |
| `name` | да | до 64 символов |
| `version` | да | `^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$`, например `1.0.0` |
| `description`, `author` | нет | до 300 и 80 символов |
| `entry` | нет | `.html` внутри файла, по умолчанию `index.html` |
| `icon` | нет | png, svg, webp или jpeg внутри файла |
| `permissions` | нет | список из каталога ниже; неизвестное разрешение — отказ (старое приложение не должно молча выдать меньше) |
| `network` | с `network` | до 16 хостов без схемы и пути: `api.example.com`, `*.example.com`, `host:8443` |
| `backend` | с `process` | `type: "process"`, `commands` — платформа → путь внутри файла, `args` — до 32 строк по 256 символов |

Платформы `backend.commands`: `macos-arm64`, `macos-x64`, `windows-x64`, `windows-arm64`.
Для macOS кладите обе архитектуры: запускается только программа своей платформы.

## 3. Разрешения

Без разрешений аддон рисует свой интерфейс, читает свои файлы (`zali.assets`) и хранит
настройки (`zali.storage`, до 1 МБ). Открыть файл, который выбрал пользователь, можно
обычным `<input type="file">` — без разрешений.

| Разрешение | Уровень | Что даёт | Где работает |
|---|---|---|---|
| `cache` | обычный | свои файлы в кеше приложения, до 256 МБ | везде |
| `notifications` | обычный | уведомление от имени «Аддон «имя»», не чаще раза в 5 с | везде |
| `clipboard` | обычный | копирование текста, пока аддон открыт | везде |
| `files` | обычный | сохранение файла через загрузки, не чаще раза в 2 с, пока аддон открыт | везде |
| `microphone` | обычный | запись звука (пишет приложение, аддону отдаёт байты), до 60 минут и 64 МБ | где есть микрофон |
| `network` | обычный | `fetch`/`WebSocket` к хостам из `network` (только https/wss) | везде |
| `fs.read` | **повышенный** | чтение любых файлов и папок | macOS, Windows |
| `fs.write` | **повышенный** | создание, запись и удаление любых файлов | macOS, Windows |
| `launch` | **повышенный** | открыть файл или папку системой, запустить программу | macOS, Windows |
| `process` | **повышенный** | запуск собственной программы-бэкенда | macOS, Windows |

Если хоть одно разрешение аддона на платформе недоступно (повышенные в браузере и на
Android, микрофон без устройства, `process` без программы под эту систему), аддон на ней
не запускается, а хаб пишет почему. Делайте отдельные аддоны, если нужна и «лёгкая»
версия для телефона.

### Подтверждения

- **Установка.** Диалог приложения: иконка, имя, версия, автор, размер, отпечаток
  SHA-256 и список разрешений; повышенные выделены. Если они есть, следом показывается
  **системный** диалог (NSAlert на macOS, MessageBox на Windows) с их перечнем; по
  умолчанию выбрана «Отмена». Права оболочка читает из манифеста внутри файла сама и
  запоминает вместе с отпечатком файла.
- **Каждый запуск** аддона с повышенными правами — снова системный диалог. Оболочка
  сверяет отпечаток файла с подтверждённым при установке: подменённый на диске файл
  не запустится. Повышенные операции работают только в сессии этого запуска.
- **Обновление** (тот же `id`) — снова оба диалога: права привязаны к файлу, а не к `id`.

## 4. SDK `window.zali`

Хост кладёт SDK первым скриптом документа, до вашего кода. Все вызовы асинхронные и
возвращают `Promise`; ошибка — `ZaliAddonError` с полями `code` и `message`.

```js
const info = await zali.ready;
// {id, name, version, permissions, network, platform, visible, theme: {accent, background, text}}
// platform: 'macos' | 'windows' | 'android' | 'ios' | 'web'
```

| Вызов | Разрешение | Результат |
|---|---|---|
| `zali.ui.collapse()` / `close()` / `setTitle(text)` | — | свернуть, закрыть, заголовок в верхней полосе (до 64 символов) |
| `zali.storage.get(key)` / `set(key, value)` / `remove(key)` / `keys()` / `clear()` | — | значения — любой JSON, ключ до 256 символов, всё вместе до 1 МБ |
| `zali.assets.read(path)` / `text(path)` / `url(path)` | — | `Uint8Array`, строка, `blob:`-URL файла из вашего архива |
| `zali.cache.write(path, data)` | `cache` | `data` — `Uint8Array`, `ArrayBuffer`, `Blob` или строка, до 32 МБ за раз |
| `zali.cache.read(path)` / `text(path)` | `cache` | `Uint8Array` / строка или `null`, если файла нет |
| `zali.cache.list(prefix)` / `remove(path)` / `usage()` | `cache` | `list` → `[{path, size}]`; `usage()` → `{bytes, quota, files}` |
| `zali.notify({title, body})` | `notifications` | `{shown}` |
| `zali.clipboard.writeText(text)` | `clipboard` | до 1 МБ |
| `zali.files.save({name, data, mimeType})` | `files` | `true` |
| `zali.mic.start()` / `stop()` / `cancel()` | `microphone` | `stop()` → `{data: Uint8Array, mimeType, durationMs}` |
| `zali.fs.paths()` | `fs.read` или `fs.write` | `{home, documents, downloads, desktop, temp, addonData, separator, platform}` |
| `zali.fs.read(path)` / `readText(path)` | `fs.read` | файл до 32 МБ |
| `zali.fs.list(path)` | `fs.read` | до 5000 записей `{name, type: 'file'\|'dir'\|'other', size, modifiedMs}` |
| `zali.fs.stat(path)` | `fs.read` | `{exists, type, size, modifiedMs}` |
| `zali.fs.write(path, data, {append})` / `mkdir(path)` / `remove(path, {recursive})` | `fs.write` | `true`; `remove` несуществующего — `false` |
| `zali.system.open(path)` | `launch` | открыть файл или папку программой по умолчанию |
| `zali.system.exec(path, args, {cwd})` | `launch` | запустить программу → `{pid}`; вывод не возвращается |
| `zali.backend.send(obj)` / `restart()` | `process` | строка JSON в stdin бэкенда |
| `zali.on(event, fn)` / `zali.off(event, fn)` | — | подписка; `on` возвращает функцию отписки |

Пути в `zali.fs` и `zali.system` — только полные (`/Users/me/...`, `C:\Games\...`). Корень
диска, папки первых двух уровней (`/Users`, `C:\Windows`), домашняя папка и её предки
`fs.remove` не удаляет. Пути в `cache` — те же сегменты, что внутри архива.

События:

| Событие | Данные | Когда |
|---|---|---|
| `visibility` | `{visible}` | аддон свернули или развернули. Свёрнутый аддон работает дальше |
| `backend` | объект из строки stdout (или `{text}`, если строка не JSON) | бэкенд написал строку |
| `backend-exit` | `{code}` | бэкенд завершился |
| `backend-error` | `{message}` | строка бэкенда больше 1 МБ и т. п. |

Коды ошибок: `permission_denied`, `bad_params`, `bad_path`, `not_found`, `quota`,
`too_large`, `rate_limited`, `not_visible` (буфер, сохранение и запись звука — только пока
аддон развёрнут), `busy`, `unsupported`, `denied`, `cancelled`, `not_recording`,
`unknown_method`, `failed`. Одновременно в работе до 64 вызовов.

## 5. Собственный процесс

Для лаунчеров, сборщиков модов и всего, чему нужен нативный код.

- Программа — **один самодостаточный исполняемый файл** под платформу из
  `backend.commands`. При запуске аддона оболочка распаковывает только его в
  `<данные приложения>/addons/<id>/bin/<отпечаток>/` и при каждом запуске сверяет с
  архивом. Библиотеки рядом с ним не распаковываются — собирайте статически или кладите
  нужное в `zali.cache` / на диск через `fs.write`.
- Стартует после системного подтверждения запуска, завершается при остановке аддона
  и выходе из приложения. Свёрнутый аддон бэкенд не останавливает.
- Обмен — **JSON по строкам**: `zali.backend.send(obj)` → одна строка в stdin; каждая
  строка stdout → событие `backend`. Строка до 1 МБ. stderr уходит в лог оболочки.
- Окружение: `ZALI_ADDON_ID`, `ZALI_ADDON_DIR` (папка распакованной программы),
  `ZALI_ADDON_DATA` (папка данных аддона; она же текущая папка).
- Программа работает с правами пользователя: поэтому `process` — повышенное разрешение.
- **macOS arm64** запускает только подписанные программы. Rust и Go подписывают сборку
  ad-hoc сами; иначе — `codesign -s - bin/macos-arm64/backend` перед упаковкой.

Минимальный бэкенд на Python-подобном псевдокоде:

```
for line in stdin:
    msg = json.loads(line)
    stdout.write(json.dumps({"reply": msg}) + "\n"); stdout.flush()
```

## 6. Песочница интерфейса

- `<iframe sandbox="allow-scripts allow-pointer-lock">` без `allow-same-origin`: у аддона
  нет доступа к окну приложения, `localStorage`, IndexedDB и cookies; всплывающие окна,
  формы, загрузки и переход на другую страницу запрещены. Попытка увести фрейм на
  другую страницу останавливает аддон. Камера, микрофон и геолокация фрейму не даны —
  микрофон только через `zali.mic`.
- Документ собирает хост. `<script src>` и `<link rel=stylesheet>` встраиваются из
  архива, `url(...)` в CSS и `src` у `img`/`audio`/`video`/`source` превращаются в
  `data:`-URL. Ссылки на внешние скрипты удаляются. `<base>` и `<meta http-equiv>`
  удаляются. ES-модули с `import` между файлами не работают — собирайте в один файл.
  Картинки, которые код создаёт сам, берите через `await zali.assets.url(path)`.
- CSP (ужесточить своим тегом можно, ослабить — нет):
  ```
  default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:;
  style-src 'unsafe-inline' blob: data:; img-src data: blob: [https://хосты];
  media-src data: blob: mediastream: [https://хосты]; font-src data: blob:;
  connect-src data: blob: [https://хосты wss://хосты]; worker-src blob:; child-src blob:;
  frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'
  ```
  Хосты подставляются из `network`, только если есть разрешение `network`.
- Тема: хост добавляет CSS-переменные `--zali-accent`, `--zali-accent-rgb`, `--zali-bg`,
  `--zali-surface`, `--zali-text`, `--zali-text2`, `--zali-text3`, `--zali-border`,
  `--zali-danger`, `--zali-radius`, `--zali-font`. Используйте их, чтобы аддон выглядел
  частью приложения.
- Если документ не вызвал SDK за 15 секунд (`zali.ready` вызывается сам при загрузке
  SDK), хаб покажет ошибку запуска.

**Помните про сеть.** Всё, что аддону доступно (кеш, файлы с диска, запись микрофона),
он может отправить на хосты из `network`. Поэтому пользователь видит список хостов в
диалоге установки, а аддону с `fs.read` и `network` вместе стоит доверять как программе.

## 7. Интерфейс в приложении

- Хаб, секция «Аддоны»: «Установить аддон», у каждого — «Открыть» и меню «⋯» с
  разрешениями, отпечатком и «Удалить». У запущенного — «Развернуть» и «Остановить».
- Открытый аддон занимает всё окно под верхней полосой. Кнопка «Свернуть» — в полосе
  сразу после кнопок окна (на телефоне — полоса над аддоном). Свёрнутый аддон виден в
  полосе плашкой с именем; клик разворачивает.
- Одновременно работают до 4 аддонов, развёрнут один. Входящий звонок и переход в
  чаты, настройки или ZaliCoin сворачивают аддон.

## 8. Хранение

- С нативной оболочкой: `<данные приложения>/addons/<id>/` — `addon.zali`, `meta.json`,
  `grant.json` (отпечаток и подтверждённые повышенные права), `data/` (`kv.json`
  настроек и `cache/`), `bin/`.
- В браузере — IndexedDB.
- «Удалить» стирает папку аддона целиком, вместе с его данными.

## 9. Ограничения и дальше

- Нет подписи автора: доверие — к файлу, который пользователь выбрал сам; отпечаток
  SHA-256 виден в диалоге. Дальше — подпись Ed25519 и каталог аддонов.
- 32 МБ на файл аддона и на одну операцию с файлом (мост передаёт base64).
- Нет ES-модулей между файлами; нет повышенных прав на Android и в браузере.
