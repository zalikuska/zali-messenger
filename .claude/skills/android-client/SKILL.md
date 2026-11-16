---
name: android-client
description: Android-шелл (apps/android/) — NativeBridge.kt/ZaliCoreBridge.kt, четвёртая независимая реализация нативного слоя. Использовать при правках моста Android, разрешений камеры/микрофона, выбора файла (аватар/вложение не загружается по тапу), FCM-пушей, allowBackup.
---

# Android client (`apps/android/`)

Тонкий шелл вокруг того же вебвью, но нативный слой у него свой — четвёртая
независимая реализация моста. Инварианты, найденные аудитом 0.2b33:

- **Всё, что обходит мост, на Android не работает.** Документ живёт по
  `file:///android_asset/web/`, а `fetch()` с такой схемы шлёт `Origin: null`,
  который сервер отвергает по CORS. Поэтому любой браузерный фолбэк здесь
  мёртв: `FormData` идёт мимо моста (`_apiFetchImpl` исключает её из
  нативного пути), а WASM-ветки не запускаются вовсе — Chromium не грузит
  ES-модули с `file://`. Из-за этого до 0.2b33 молча не работали загрузка/
  удаление аватара (`hasNativeAvatarBridge()` не пускал транспорт `'android'`,
  хотя обработчики в `NativeBridge.kt` были написаны), правка сообщений и
  история каналов. Лечение — **нативный обработчик**, а не фолбэк:
  `serverHistory` и `editMessage` теперь объявлены `true` и реализованы в
  `handleLoadServerHistory` / `handleEditMessage`.
- **Перебор ключей ограничен и детерминирован** —
  `ZaliCoreBridge.MAX_DECRYPT_CANDIDATES` (12) плюс обход
  `conversationKeys.keys.sorted()`, и оба кэша расшифровки (положительный и
  отрицательный по `candidateKeysFingerprint`). Раньше в двух местах
  дописывались все значения мапы без потолка: цена одного нечитаемого
  сообщения росла вместе с историей `alt:`-ключей, а это два прохода PBKDF2 по
  210 000 итераций на кандидата — на самом слабом железе из всех оболочек.
  Проверяется `perf_doctor`.
- **`allowBackup` выключен, и это не перестраховка.** В `filesDir` лежат
  `conversation_keys_<user>.json` (ключи переписок открытым текстом) и
  `shared_device_identity_<user>.json` (приватный ECDH-ключ). При
  `allowBackup="true"` Android без спроса выгружал бы их в Google Drive.
  Выключены оба канала: `android:allowBackup="false"` и
  `res/xml/data_extraction_rules.xml` (на API 31+ читается именно он,
  `device-transfer` — отдельный канал от `cloud-backup`).
- **Микрофон и камеру нужно просить у ОС.** `PermissionRequest.grant()` в
  `WebChromeClient` не выдаёт приложению того, чего у приложения нет:
  `RECORD_AUDIO` и `CAMERA` — dangerous-разрешения, объявленные в манифесте с
  начала, но не запрашивались в рантайме (в коде стоял только
  `POST_NOTIFICATIONS`), поэтому `getUserMedia()` падал и звонок на Android не
  мог начаться в принципе — при полностью рабочем сигналинге. `MainActivity`
  теперь откладывает `PermissionRequest` до ответа системного диалога и
  отвечает вебвью ровно тем, что ОС дала.
- **`reply` и `call` едут внутри шифротекста**, поэтому их обязан пробрасывать
  и `packMessage`, и разбор `unpackMessage` (`ZaliCoreBridge`), и оба пути
  доставки в `NativeBridge`. Пропущенное поле теряется безвозвратно —
  восстанавливать цитату неоткуда. Подробнее — скилл `message-lifecycle`.
- **Своей нижней панели нет — работает веб-док** (с 2026-11-15). Compose-панель
  (`ZaliBottomBar`) дублировала `.mobile-dock`: жесты, ленту разделов, подсветку
  (`MOBILE_NAV_PROGRESS`), светлую тему — каждая правка делалась дважды и всё равно
  расходилась (акцент схемы, число вкладок). Убраны панель, `selectTab`/`dockPager`,
  возможность `mobileNav` и CSS-инъекция, прятавшая док. Без размытия (см.
  `is-android-shell`) плашка дока почти сплошная — правило рядом с
  `--m-glass-float` в `web/style.css`. Отступ под полосу навигации даёт
  `--m-safe-bottom`, при клавиатуре док уезжает по `body.kbd-open`. Не
  возвращать нативную панель: iOS-оболочка свою пока держит, веб-путь для неё
  (`nativeSupports('mobileNav')`) остаётся.
- **Список не должен просвечивать сквозь чат при свайпе.** `#viewChat` на
  телефоне обязан быть непрозрачным (`var(--bg)`): список стоит под ним на Y=0
  весь жест, а при парковке «улетает» вниз. Десктопное правило режима `focus`
  (`background: transparent`, фон там даёт `.main`) перебивает мобильное по
  специфичности — отсюда отдельный override в `@media (max-width: 760px)` блока
  «Фокус». Проверять живьём: `getComputedStyle(#viewChat).backgroundColor`.
- **Клавиатура: вебвью сжимается по IME сам.** Приложение edge-to-edge
  (targetSdk 35), `adjustResize` окно больше не ресайзит — без
  `Modifier.imePadding()` на `AndroidView` поле ввода уходит ПОД клавиатуру, а
  `visualViewport`/`--kbd-inset` остаются нулями (веб это не увидит). Нижний
  отступ веба `--m-safe-bottom` обязан быть `max(0, навбар − IME)`: IME-инсет
  включает полосу навигации, и без вычитания под полем остаётся пустой зазор.
- **Системное «назад» идёт через веб** (`BackHandler` в `MainActivity`,
  2026-11-10). Оболочка вызывает `window.__zaliHandleBack()`; `true` — веб закрыл
  верхний слой (окно, меню, вложенный экран, чат), `false` — `moveTaskToBack`,
  а не `finish()`: сокет и звонок остаются живы. До этого обработчика не было, и
  «назад» из открытого чата закрывало приложение. Порядок слоёв —
  `handleMobileBack()` в `web/src/interface/mobile.js`.
- **`<input type="file">` работает только через `onShowFileChooser`**
  (`MainActivity`). Android WebView, в отличие от WKWebView и WebView2, диалог
  сам не открывает — без этой правки `input.click()` молча не делал ничего.
  Колбэк обязан получить ответ всегда (`null` при отмене), иначе вебвью больше
  не откроет выбор файла. `FileChooserParams.createIntent()` не используется —
  он берёт из `accept` только первый тип.
- **«Скрепка» — своя галерея, а не выбор файла** (`MediaGallery.kt` +
  `web/src/interface/media_sheet.js`, возможность `mediaGallery`, сообщения
  `GALLERY_*`). Превью и оригиналы — запросы на `https://zali-gallery.invalid/<token>/…`,
  которые перехватывает `shouldInterceptRequest`: токен случайный на процесс и
  уходит только в ответах моста, иначе песочница аддона (iframe) читала бы
  галерею. Камера: при объявленном и не выданном `CAMERA` `ACTION_IMAGE_CAPTURE`
  падает `SecurityException` — сначала разрешение. Остальные поля с `image/*` /
  `video/*` открывают системный Photo Picker (`photoPickerMediaType`), прочие —
  `ACTION_GET_CONTENT`. Стикеры `.tgs` пикер не показывает — для них плитка
  «Стикер .tgs» и поле `#stickerFileInput` без картинок в `accept`. В KDoc не писать `image/*` буквально: Kotlin открывает
  вложенный комментарий, и файл перестаёт компилироваться.
- **Фоновая доставка — FCM** (`PushMessagingService.kt`,
  `server/src/fcm.rs`). Пуш — data-сообщение без текста; сервис сам скачивает
  архив и расшифровывает ключами из `filesDir` (не больше 3 кандидатов и 8 МБ
  — у data-пуша ~10 с), не вышло — «Новое сообщение». Сессию для фона (адрес
  API, токен, аккаунт, устройство) хранит `PushSession`. Инварианты:
  - id уведомления выводится из id сообщения (`MessageNotifier`),
    `SHOW_NOTIFICATION` из веба несёт `messageId` — иначе приложение в фоне с
    живым сокетом получило бы два уведомления (WS + пуш);
  - приложение сообщает серверу `client_presence` по своему WS (`onStart`/
    `onStop`), веб в вебвью этого не делает — он видит мост;
  - выход из аккаунта снимает устройство с пушей
    (`/api/push/device/unregister`) и стирает `PushSession`, сервис сверяет
    `recipient` пуша с аккаунтом на устройстве;
  - `google-services.json` **не в git** (публичный репозиторий) — без него
    плагин google-services не применяется, сборка проходит, Firebase не
    инициализируется (`PushSession.firebaseAvailable`), приложение живёт без
    фоновых пушей.
  - `send_push` на сервере шлёт по обоим каналам (Web Push + FCM) сразу; то же
    решение «показывать ли пуш» по устройству, что и в вебе — скилл `notifications`.

- **Автообновление — `AppUpdater.kt`** (возможность `appUpdate`, общий веб
  `updates.js`). Платформу и версию вебу отдаёт `documentStartScript`
  (`__ZALI_NATIVE_PLATFORM = "android"`, `__ZALI_NATIVE_APP_VERSION`). Версия —
  **из PackageManager, не `BuildConfig.VERSION_NAME`**: та вклеивается в байткод
  как константа, и инкрементальная сборка после бампа оставляла старую (проверено
  живьём) — апдейтер предлагал бы ту же версию вечно. Ответ на
  `INSTALL_UPDATE_REQUEST` веб не ждёт, поэтому отказ (нет разрешения ставить
  приложения) дублируется событием `update_event` `kind: install_error`.

Origin pin для навигации в `MainActivity.kt` — таблица в скилле
`security-invariants`. Для правил дублирования `core/` под Android — `CLAUDE.md`.
