---
name: macos-client
description: Основной macOS Swift-клиент (apps/macos/) и экспериментальный macOS Rust-шелл (тот же крейт, что Windows). Использовать при правках IPC-моста WKWebView, JSON-сериализации в JS, окна AppKit, Keychain/ключей.
---

# macOS client

## macOS Swift (`apps/macos/`) — основной

- **Никогда не отдавать `JSONSerialization.data(withJSONObject:)` граф типа
  `Any` напрямую — только через `zaliJSONData`/`zaliJSONString`
  (`Services/JSONSafe.swift`).** Эта функция не бросает Swift-ошибку на
  непригодном значении, а **поднимает ObjC-исключение**
  `NSInvalidArgumentException` (`Invalid type in JSON write (__SwiftValue)`):
  любой Swift-struct/enum в `[String: Any]` приезжает к писателю как
  `__SwiftValue`. `try?` это НЕ ловит, и Swift вообще не может — исключение
  разматывает стек прямо сквозь Swift-кадры. Если эти кадры принадлежат
  `async`-функции, размотка бросает на полпути пер-тредовое состояние
  рантайма конкурентности, и дальше **любой**
  `swift_task_isCurrentExecutorWithFlags` в процессе читает мусорный executor
  и падает — причём падает тот, кто спросит следующим: hit-test SwiftUI,
  mouse tracking WebKit, жест-распознаватели AppKit, системное меню-бар.
  Так выглядела волна крашей 2026-09-09: `[RemoteReactionSummary]` (обычный
  Codable-struct) клали в payload истории в `renderHistoryRecord`, а
  сериализовали в дочерней задаче `withTaskGroup`. Пять отчётов — пять
  несвязанных стеков, ни один рядом с настоящей ошибкой. Мораль: проверка
  `isValidJSONObject` обязана быть ДО вызова, и в `[String: Any]` для JS
  кладём только String/Number/Bool/Array/Dictionary — Codable-модели
  разворачиваем в словари руками. Побочно: то же самое молча теряло реакции в
  истории, потому что `javascriptLiteral` на невалидном графе отдаёт `null`.
- **Окно — чистый AppKit, SwiftUI в нём нет** (с 0.2b29). Это не лечило те
  крахи (лечение — пункт выше), но убирает целый класс поражаемых мест:
  `WKWebView` — подвид в `contentView` окна, созданного руками в
  `AppDelegate`, меню строится программно (`installMainMenu()`), иначе в
  `WKWebView` не работают Cmd+C/V/X/A/Q. Пока `contentView` был
  `NSHostingView`, WebKit на каждое движение мыши гонял через `-hitTest:` всю
  responder-машинерию SwiftUI — и когда рантайм конкурентности был уже
  сломан, падало именно там. `SwiftUI.framework` теперь не линкуется в
  бинарник вообще (`otool -L`). **Не возвращать
  `NSViewRepresentable`/`WindowGroup` в macOS-клиент.**
- IPC: `WKScriptMessageHandler.userContentController` в `WebView.swift`; все
  хендлеры проверяют `message.frameInfo.isMainFrame`.
- Ключ шифрования хранится в **обычном файле**
  (`Coordinator.saveLegacyCryptoKey`/`loadLegacyCryptoKey`,
  `~/Library/Application Support/ZaliMessenger/legacy_crypto_key.txt`), не в
  Keychain и никогда в UserDefaults. Keychain убран 2026-07-03: `build_app.sh`
  никогда не подписывает стабильной identity, ad-hoc подпись меняется на
  каждой пересборке — Keychain ACL считает каждую пересборку «другим
  приложением» и переспрашивает согласие на каждый запуск. **Не возвращать
  Keychain сюда** (память `feedback_no_keychain`).
- Разрешение камеры/микрофона (`requestMediaCapturePermissionFor`) выдаётся
  только для `localhost`/`127.0.0.1` origin из главного фрейма.
- Резолв Tenor-URL проверяет HTTPS + хост `tenor.com` до запроса.
- `javaScriptCanOpenWindowsAutomatically` — `false`.
- Стороннее правило для навигации в этом WebView и разрешений камеры/микро —
  таблица origin-pin по всем четырём шеллам в скилле `security-invariants`.

## macOS Rust shell (тот же крейт `apps/windows/`) — экспериментальный, НЕ основной

После пробной миграции (2026-07) решено вернуться к Swift-версии как основной:
голосовые звонки и уведомления в Rust-шелле не подтверждены реальным
использованием, ценность отдельного нативного стека не перевесила риск. Код и
сборка сохранены рабочими на случай возврата. Крейт `zali_messenger_win`
собирается и на macOS (WRY использует WKWebView). Сборка/запуск:
`./scripts/build_macos_rust_app.sh` / `./scripts/run_macos_rust_app.sh`.

Платформенные ветки:
- `NativeState::app_data_dir()`: macOS → `~/Library/Application Support/ZaliMessenger`
  (без этой ветки конфиг падал в temp и стирался ОС).
- `spawn_swift_keychain_migration()` (macOS only): фоновый одноразовый импорт
  ключа Swift-клиента из Keychain (`com.zali.messenger`/`zali_crypto_key_v2`).
  **Никогда не читать чужие Keychain-записи на стартовом пути** — модальный
  диалог доступа блокирует поток до ответа пользователя.
- Меню-бар через `muda` (macOS only) — без него в WKWebView не работают Cmd+C/V/Q.
- `install_media_capture_policy()` в `main.rs` (macOS only): добавляет
  `requestMediaCapturePermissionForOrigin:` в UIDelegate wry через objc
  runtime — грант только main frame + origin `zali://`/localhost, зеркало
  инварианта Swift-клиента. Диагностика окружения на старте — `DIAG_ENV;...`
  в trace-логе.
- Уведомления работают только из `.app`-бандла (mac-notification-sys).
  Голосовой звонок end-to-end реальным звонком не проверялся.
- Кросс-сборка Windows-таргета с macOS **работает** через
  `cargo xwin build --target x86_64-pc-windows-msvc`. Голый
  `cargo check --target x86_64-pc-windows-msvc` падает на C-коде `ring` —
  не хватает заголовков Windows SDK, которые `cargo-xwin` подкладывает сам;
  это ограничение голого тулчейна, не регрессия.
- Оба `.app` могут сосуществовать (разные bundle id: `com.zali.messenger` и
  `com.zali.messenger.rust`).

Если SwiftPM жалуется на устаревший кеш модулей после переноса проекта —
удалить `apps/macos/.build` и пересобрать.
