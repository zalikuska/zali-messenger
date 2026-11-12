# Голосовые звонки: нативный захват (macOS, Windows)

Часть скилла `voice-calls` (основной файл — `.claude/skills/voice-calls/SKILL.md`).
Веб-сторона — `web/src/interface/native_media.js`, обработка звука —
`core/src/audio_processing.rs` (фича `apm`), её тесты — `core/tests/apm_quality.rs`.

## Зачем

WebKit (WKWebView) на macOS захватывает микрофон только через системный
VoiceProcessingIO — даже с `echoCancellation: {exact:false}`. На каждый вход в звонок
это `AudioDeviceDuck(…, 0.177828)` (все остальные приложения тише на 15 дБ), агрегат
«микрофон + динамики» и `StopForReconfiguration` — звук во всей системе заикается
(журнал 2026-11-12, `/usr/bin/log show --predicate 'eventMessage CONTAINS "AudioDeviceDuck"'`).
Поэтому на десктопе устройства открывает оболочка, а WebRTC остаётся в WebView.

**Инвариант:** на macOS и Windows `getUserMedia`/`getDisplayMedia` — только запасной путь
(нативный отказал или возможность не объявлена). Новый захват в веб-коде идёт через
`tryNativeMicStream` / `captureVoiceCameraTrack` / `openNativeMediaStream`, не мимо них.
Android и браузер — по-прежнему движок (там AEC/NS движка безвредны).

## Возможности

Оболочка объявляет в `__ZALI_NATIVE_CAPS__` только то, что реализовала:
`nativeMic`, `nativeCamera`, `nativeScreen`, `nativeScreenAudio`. Без флага веб идёт в
движок — можно выкатывать по частям. Плюс `window.__ZALI_MEDIA_BRIDGE` (user-скрипт
основного фрейма, `atDocumentStart`):

- macOS: `{kind: 'websocket', url: 'ws://127.0.0.1:<порт>/media', token: '<одноразовый>'}`.
  Сервер — только `127.0.0.1`, случайный порт; первым сообщением страница шлёт текст
  `{"hello":"<token>"}`; оболочка закрывает соединение при неверном токене или
  `Origin` ≠ `http://localhost`; второе одновременное соединение не принимается (новое
  вытесняет старое только после проверки токена). Токен не попадает в URL и журнал.
- Windows: `{kind: 'sharedbuffer'}`; кадры — `ICoreWebView2_17::PostSharedBufferToScript`
  только верхнему фрейму `zali.localhost`, буфер из `ICoreWebView2Environment12::CreateSharedBuffer`,
  доступ `READ_ONLY`. Страница сразу вызывает `chrome.webview.releaseBuffer` (данные
  копирует). **Буфер — новый на каждый кадр**, сразу `Close` после отправки: страница не
  сообщает оболочке, что скопировала кадр, и запись в тот же буфер по кругу давала бы
  рваные кадры. Пул — только вместе с подтверждением от страницы.
- Windows: Media Foundation (`mf`, `mfplat`, `mfreadwrite`) грузится динамически, а не
  через таблицу импорта: на Windows N без Media Feature Pack иначе не запускалось бы всё
  приложение — там просто нет камеры. Перезагрузка страницы останавливает все нативные
  потоки, чтобы микрофон и камера не оставались занятыми до выхода.

## Управление: `MEDIA_REQUEST` → событие шины `media_event`

`{type:'MEDIA_REQUEST', op, requestId?, stream?, kind?, deviceId?, sourceId?, options?}`.
Ответ на запрос с `requestId` — `media_event` с тем же `requestId`; ошибка —
`{event:'error', requestId, code, message}`, `code`: `permission` (нет доступа TCC/
приватности), `not_found`, `busy`, `unsupported`, `failed`.

| op | поля | ответ |
|---|---|---|
| `list_devices` | — | `{event:'devices', audioinput:[{id,label,isDefault}], videoinput:[…]}` |
| `list_screen_sources` | `options.thumbWidth` | `{event:'screen_sources', sources:[{id, kind:'display'\|'window', title, app, own, width, height, thumb}]}` — `thumb` = `data:image/jpeg;base64,…` шириной ≤ thumbWidth; окна самого мессенджера в списке с `own: true` (их можно показать); id стабилен, пока источник жив |
| `start` | `stream` (число, выдаёт страница), `kind` `mic`/`camera`/`screen`, `deviceId`/`sourceId` (пусто = по умолчанию), `options` | `{event:'started', stream, codec, label, deviceId}` — `codec` для H.264 — строка `avc1.PPCCLL` |
| `stop` | `stream` | — (ответа нет) |
| `set_processing` | `options: {aec, ns, agc}` | — ; применяется к идущему микрофону на лету |
| `request_keyframe` | `stream` | — ; ближайший кадр — ключевой |

Опции `start`: микрофон `{processing: bool}`; камера `{width, height, fps}`; экран
`{fps, maxHeight (0 = оригинал), audio, cursor}`.

События без запроса: `{event:'ended', stream, reason}` (источник пропал, окно закрыли,
устройство отключили) — страница гасит дорожку и шлёт `ended` (→ `stopScreenShare`);
`{event:'devices_changed'}`; `{event:'transport_unavailable'}` (Windows: нет общей памяти
WebView2 — страница выключает нативный захват до перезагрузки, без ожидания таймаутов); `{event:'stats', stream, processing:{erle_db, delay_ms, …}}`
раз в 10 с для микрофона (уходит в `voiceDiag mic-processing-native`).

Камера, открытая двумя потоками (превью в окне выбора + звонок), — один сеанс захвата
с раздачей кадров обоим, а не два сеанса (AVFoundation/MF отдают устройство одному).
Режим сеанса — **наибольший из запрошенных**: превью просит 640×360, звонок 1280×720;
если звонок подписался вторым, режим растёт на ходу (macOS — `CameraHub.prepare`,
Windows — `Shared.want` + `configure_reader` на том же читателе), иначе звонок остался
бы в размере превью и после его закрытия.

**Неподвижный экран:** ScreenCaptureKit и WGC отдают кадр только при изменении картинки,
а у каждого собеседника свой кодировщик WebRTC. Оболочка повторяет последний кадр не
реже раза в секунду — иначе вошедший в звонок видит чёрный экран, пока на нём ничего не
сдвинется.

`stats.processing.reference` — `bool` (есть ли опорный сигнал) на обеих платформах;
macOS дописывает причину в `reference_status` (`tap`, `off`, `unsupported-os`, `failed: …`).

**Старые id устройств.** Выбор камеры/микрофона, сохранённый до нативного захвата, — id
движка (WebKit/Chromium хешируют его по origin); оболочка его не знает (`not_found`).
Страница тогда открывает устройство по умолчанию **из оболочки**, а не уходит в
getUserMedia (на macOS это снова VoiceProcessingIO): `tryNativeMicStream`,
`captureVoiceCameraTrack`, превью в окне выбора — одним флагом `defaultIfUnknown` в
`openNativeMediaStream`. В журнале — `native-media-unknown-device`.

**Звук самого приложения в демонстрации** (`web/src/interface/share_audio.js`). Оболочка
снимает звук системы без всего ZaliMessenger — иначе голоса собеседников вернулись бы
им. Остальной звук приложения собирает страница в контексте звуков (`this.sound.ctx`) и
подмешивает к звуку оболочки (`startShareAppAudio`), при показе **всего экрана** и
**окна мессенджера** (окно другого приложения — только его звук):

| Источник | В демонстрации |
|---|---|
| голоса звонка, звук чужих демонстраций | нет (свои `<audio>`/`<video>`, сюда не заводятся) |
| звуки звонка (вход/выход, начало показа) — `playSoundBuffer('voice')` | нет: зрители в том же звонке |
| уведомления, рингтоны (`soundBus`, `soundDirectSharedBus`) | приглушённо, `SHARE_DUCK_GAIN` = 0.3 (≈ −10 дБ) |
| видео/аудио вложений (`.media-video`, `.media-audio-player`, blob:/data:) | как есть; `createMediaElementSource` при первом `play` во время показа — дальше элемент всегда звучит через контекст |
| аддоны (sandbox iframe), чужой origin без CORS | нет — недостижимы / дали бы тишину и в динамиках |

Новый звук приложения — через `soundDirectSharedBus` (попадёт в стрим) или
`soundDirectBus` (только в динамики); никогда не мимо обоих прямо в `ctx.destination`.

### Журнал

| Где | Что |
|---|---|
| macOS `zali-debug.log`, `[ZALI][MEDIA]` | каждый запрос (`request op=… device=<12 символов>`), `screen sources: N (thumbs M) in X ms`, раз в 10 с `stats stream=…` видео (кадры, fps, кбит/с, ключевые, пропуски, повторы неподвижного экрана, кадры камеры, формат), затор транспорта, пересборка формата камеры, сбои кодировщика, число запросов ключевого кадра |
| Windows `zali-win.log`, `[ZALI][WIN] media` | запрос, `started`/`ended`/`failed` с причиной, раз в 10 с `stats` видео (кадры, пропуски, кадры камеры, повторы, GPU/CPU-перевод), смена режима камеры |
| Журнал звонка (страница) | `native-media-open` → `native-media-started ms=…` / `native-media-open-failed`, `native-video-stats` (цифры оболочки + сколько кадров дошло до страницы; WARN при пропусках или нуле кадров), `mic-processing-native`, ошибки и отставание декодера, `native-media-ended` с длительностью и числом кадров, `voice-panel-rebuild` (панель пересобрана при живом видео — кадр мигнёт) |

`mic-processing-native` кроме AEC несёт уровни за ~5 с: `input_dbfs`, `output_dbfs`,
`noise_in_dbfs`/`noise_out_dbfs` (кадры без голоса до и после RNNoise),
`ns_attenuation_db` (сколько срезал шумодав; белый шум в тесте — ~20 дБ),
`speech_ratio`, `clipped_frames`.

### Где платформы расходятся (осознанно)

| | macOS | Windows |
|---|---|---|
| Видео в страницу | H.264 (VideoToolbox) → `VideoDecoder` | NV12 без сжатия → `VideoFrame` |
| `started` камеры/экрана | после первого ключевого кадра (нужен `codec`), кадры держатся до обработки `started` | сразу после открытия устройства |
| `request_keyframe` | ключевой кадр энкодера | ничего (каждый кадр NV12 — целый) |
| Звук микрофона | блоки по 10 мс, своё пересэмплирование (AVAudioConverter) | блоки по 20 мс, WASAPI `AUTOCONVERTPCM` |
| Опорный сигнал AEC | global process tap (14.2+) | loopback вывода по умолчанию |
| Звук демонстрации экрана | tap без процессов приложения и его WebKit; окно — звук SCStream приложения-владельца | process loopback без дерева процессов приложения (и для окна — весь звук) |
| `started.audioExcludesApp` у экрана | `true` при tap, `false` при SCStream (< 14.2, отказ тапа) — тогда страница звук приложения не подмешивает | всегда `true` |
| Своё окно (`own`) | страница шлёт `audio:false`, звук — только звук приложения из страницы | то же |
| Пропал микрофон по умолчанию | переоткрывается на новом по умолчанию по событию HAL | до 20 попыток раз в 500 мс |
| Затор транспорта | > 8 МБ в очереди сокета — пропуск видео до ключевого | > 3 кадров ждут поток окна — пропуск видео |
| Нет транспорта | флаги `native*` не объявляются | флаги всегда; без `ICoreWebView2_17` страница ждёт первый кадр 5 с и уходит в движок |

## Кадры

32 байта заголовка (little-endian) + данные, по кадру на сообщение/буфер:

| смещение | тип | поле |
|---|---|---|
| 0 | u8 | `0x5A` |
| 1 | u8 | версия = 1 |
| 2 | u8 | вид: 1 звук, 2 видео |
| 3 | u8 | кодек: звук 1 = f32 PCM 48 кГц; видео 1 = H.264 Annex B, 2 = NV12 |
| 4 | u32 | `stream` |
| 8 | u64 | метка времени, мкс (монотонная) |
| 16 | u16 | ширина (чётная) |
| 18 | u16 | высота (чётная) |
| 20 | u8 | флаги: бит 0 — ключевой кадр |
| 21 | u8 | каналы (звук) |
| 22 | u16 | резерв |
| 24 | u32 | длина данных |
| 28 | u32 | номер кадра |

- **Звук микрофона:** моно, уже после APM, блоки по 10–20 мс. **Звук экрана:** стерео
  (каналы = 2) чередующимися f32, без обработки, тем же `stream`, что и видео экрана.
- **Видео macOS:** H.264 Annex B (VideoToolbox: realtime, без B-кадров, профиль High или
  Main, SPS/PPS перед каждым ключевым кадром, ключевой раз в 2 с и по `request_keyframe`).
  WebKit декодирует `VideoDecoder` → `VideoTrackGenerator` в воркере. **Windows:** NV12
  без сжатия (Chromium `VideoFrame` из буфера, без копии на стороне оболочки).

## Обработка звука микрофона

`core/src/audio_processing.rs`: `VoiceProcessor` (Rust, Windows) / `zali_apm_*` (C ABI,
macOS через `CoreBridge.h`). 48 кГц моно f32; блоки любой длины. Опорный сигнал —
то, что сейчас играет: macOS — Core Audio process tap (macOS 14.2+, global tap,
`NSAudioCaptureUsageDescription`; без пригушения и без пересборки вывода — проверено);
Windows — WASAPI loopback устройства вывода по умолчанию. Нет опорного сигнала (macOS 13,
отказ в доступе) — AEC без него ничего не вычитает, NS и AGC работают.
Конвейер выбран стендом против C++ AEC3 из WebRTC — подробности в шапке модуля; пороги в
тестах — от измерений с запасом, не придуманные.

Захват: macOS — AUHAL только на вход, **без** VoiceProcessingIO (никакого
`kAudioUnitSubType_VoiceProcessingIO`, никакого `setVoiceProcessingEnabled`); Windows —
WASAPI shared, роль `eConsole` (режим «связь» включил бы системное приглушение).

## macOS: ICE без getUserMedia

Пока страница не получила доступ к микрофону/камере через движок, WebKit прячет
локальные адреса за mDNS (`….local`) — прямые соединения в LAN ломаются. Оболочка
выключает фильтр: `WKPreferences` `_setICECandidateFilteringEnabled:false` (проверено
2026-11-12 на macOS 27 — появились настоящие адреса).
