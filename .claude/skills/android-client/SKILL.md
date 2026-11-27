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
- **Демонстрация экрана — `MEDIA_REQUEST`, как у десктопа** (с 2026-11-22): `nativeScreen`
  и `__ZALI_MEDIA_BRIDGE = {kind:'webmessage'}` объявляются, только если WebView умеет
  WebMessage-каналы с ArrayBuffer и есть кодировщик H.264 (`NativeBridge.mediaScreenSupported`).
  Захват — `ScreenCaptureService.startH264Capture` + `ScreenH264Encoder.kt`; иначе прежний
  `START_SCREEN_CAPTURE` (JPEG, ~8 к/с). Протокол и транспорт — скилл `voice-calls` →
  `native-capture.md`. На телефоне не проверено.
  В звонке через SFU (`nativeSfuScreen`, если ядро загрузилось) слои кодирует оболочка и шлёт
  издатель ядра по JNI (`ScreenSfuLayers.kt`, `ZaliSfuNative.kt`); ядро собирать с
  `--features android,sfu` (`build_android_core.sh` уже так делает) — без этого `create`
  вернёт 0 и экран пойдёт прежним путём.
  **Перезагрузка страницы гасит показ** (`NativeBridge.onPageStarted` из `onPageStarted`
  WebView): новая страница номера потока не знает и `stop` не пришлёт — без сброса `start`
  отвечал `busy` до перезапуска приложения, а индикатор записи горел. Согласие, пришедшее
  на уже отменённый запрос, сервис сразу гасит (`screenCaptureWanted`).
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
  `ACTION_GET_CONTENT`. Документы и стикеры `.tgs` пикер не показывает — для них плитка
  «Файл» и поле `#anyFileInput` без `accept`. В KDoc не писать `image/*` буквально: Kotlin открывает
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

- **Входящий звонок в фоне — уведомление-звонок, не полноэкранный экран** (решение
  пользователя, 2026-11-18; `IncomingCall.kt`). Зелёную «Принять» и красную
  «Отклонить» рисует `NotificationCompat.CallStyle`, а Android 12+ бросает исключение
  на CallStyle без сервиса переднего плана или fullScreenIntent — поэтому
  `IncomingCallService` типа `shortService` (без особых разрешений; старт из фона
  разрешён пушем с высоким приоритетом). Не вышел сервис — обычное уведомление с
  окрашенным текстом кнопок. Звук — канал `zali-call-v1` (рингтон) + `FLAG_INSISTENT`.
  Снимается: `call_end`, кнопки, `onStart` активити (там звонит сам веб), 60 с.
  Вебвью в фоне рингтон не играет (`renderVoicePanel`, `__zaliNativeAppFocus`).
  «Отклонить» — `CallActionReceiver` с секретом звонка, без вебвью.
- **Идущий звонок держит `OngoingCallService`** (2026-11-20; `CALL_STATE` из
  `syncNativeCallState` в `voice_ui.js`, возможность `callService`). Сервис переднего
  плана типов `microphone` (+ `camera`, пока камера включена; тип без выданного
  разрешения — `SecurityException`, поэтому типы считаются по разрешениям), Wi‑Fi lock
  `LOW_LATENCY` и частичный wake lock. Без него (журнал Xiaomi, Android 16): камеру
  отрезало, как только активити переставала быть видимой (`CameraService … restricted,
  isUidVisible 0` — хватало системного диалога демонстрации экрана), а погасший экран
  через 7–12 с вставлял весь звонок — процесс уходил в `procState 12`, MIUI SmartPower
  душил его все 132 с фона, офферы перезапуска оставались без ответа. С сервисом —
  `procState 3` при выключенном экране. Типы `microphone`/`camera` можно запустить
  только из видимого приложения — веб шлёт состояние при начале звонка; отказ ОС — запись
  `ZaliCall` в logcat, звонок идёт как раньше. `stopWithTask` + `onTaskRemoved` снимают
  сервис со смахиванием задачи.
- **Интерфейс телефона — только портрет** (2026-11-20, `MainActivity.applyOrientation`,
  возможность `screenRotation`). Альбомный (`FULL_USER`, с системной блокировкой поворота)
  и скрытые системные полосы — только пока медиа на весь экран: веб шлёт
  `SCREEN_ROTATION { free }` из `media_viewer.js` (видео звонка `#voiceFocus`, фото
  `#mediaViewer`, `document.fullscreenElement`), а `<video>` на весь экран — это
  `onShowCustomView` (без него кнопка в панели видео ничего не делала). Планшет
  (sw ≥ 600dp) не ограничен. В альбомном ширина > 760 px и раскладка за оверлеем
  «настольная» — обработчики смены раскладки в `events.js` пропускают ход, пока
  `mobileRotationHeld()`, иначе `syncMobileChrome` сбросил бы открытый чат. Новый
  полноэкранный медиа-оверлей — вписать в `mediaRotationWanted()` и в `handleMobileBack`.
- **Автообновление — `AppUpdater.kt`** (возможность `appUpdate`, общий веб
  `updates.js`). Платформу и версию вебу отдаёт `documentStartScript`
  (`__ZALI_NATIVE_PLATFORM = "android"`, `__ZALI_NATIVE_APP_VERSION`). Версия —
  **из PackageManager, не `BuildConfig.VERSION_NAME`**: та вклеивается в байткод
  как константа, и инкрементальная сборка после бампа оставляла старую (проверено
  живьём) — апдейтер предлагал бы ту же версию вечно. Ответ на
  `INSTALL_UPDATE_REQUEST` веб не ждёт, поэтому отказ (нет разрешения ставить
  приложения) дублируется событием `update_event` `kind: install_error`.

- **Тема приложения (`res/values*/themes.xml`) не должна быть тёмной.** WebView берёт
  `prefers-color-scheme` из `android:isLightTheme` темы приложения: от родителя
  `android:Theme.Material` (тёмный) вебвью всегда отвечал «dark», и режим «Как в
  системе» на светлой системной теме показывал тёмный интерфейс (2026-11-20).
  Сейчас: `Material.Light` до API 29, `Theme.DeviceDefault.DayNight` с API 29
  (`values-v29`); активити держит `configChanges=uiMode`, вебвью сам пересчитывает
  запрос. Не проверено на телефоне.

- **Файлы: крупное идёт мимо моста строкой** (2026-11-26). Всё, что в вебе было `data:`-URL, на
  телефоне стоило 3–4 копий в куче, поэтому:
  - *Приём.* До `INLINE_ATTACHMENT_MAX_BYTES` (16 МБ, `NativeBridge.kt`; зеркало в вебе —
    `ZaliInterface.PHONE_INLINE_ATTACHMENT_MAX_BYTES`) вложение едет inline; крупнее — только
    описание (`name/size/archivePath`), веб рисует карточку `[data-attachment-unavailable]`, тап →
    `downloadMessageAttachment` → `DOWNLOAD_MESSAGE_ATTACHMENT`: оболочка качает архив **потоком на
    диск**, расшифровывает теми же ключами, что и историю, и кладёт файл в «Загрузки» или под
    «Поделиться». Раньше порог был 2 МБ без докачки (комментарий обещал «по требованию», но её
    не было) — файл больше приезжал безымянной заглушкой, «файлы не скачиваются».
  - *Отправка.* Файл > 4 МБ (`STAGE_THRESHOLD_BYTES`) веб режет на куски по 1 МиБ
    (`STAGE_ATTACHMENT`, ответ на каждый — порядок и backpressure); оболочка складывает их в
    `filesDir/staged_attachments` (НЕ в cacheDir: файл должен пережить повторы отправки и
    перезапуск), `SEND_MESSAGE` ссылается на `stageId`. Удаляется после успешной доставки, по ×
    в черновике и по возрасту > суток. Нет файла → `on_send_error` со статусом 400 (окончательный),
    а не тихая отправка без вложения.
  - *Нельзя молча терять вложение.* Правка (`EDIT_MESSAGE`) и пересылка переупаковывают сообщение
    из вложений страницы; вложение без байтов оболочка пропустила бы. Веб отказывает заранее
    (`submitMessageEdit`, `sendInputMessage`) с пояснением. Любой новый путь упаковки обязан
    так же отличать «нет вложений» от «вложение не загружено».
  - Не проверено на телефоне: ни скачивание, ни нарезка не запускались на устройстве, только
    компиляция и юнит-проверки веб-логики.

Origin pin для навигации в `MainActivity.kt` — таблица в скилле
`security-invariants`. Для правил дублирования `core/` под Android — `CLAUDE.md`.
