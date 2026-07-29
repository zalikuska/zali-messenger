# Выпуск релиза клиента

Пошаговая инструкция: как выкатить сервер и опубликовать новую версию клиента
через встроенный апдейтер. Дополняет `CLAUDE.md` — здесь только последовательность
действий одного релиза, без архитектурного контекста.

---

## 0. Что где живёт

| Что | Где |
|---|---|
| Прод-сервер | `https://msgs.zalikus.org`, SSH-алиас `zms` |
| Репозиторий кода | `origin` → `git@github.com:zalikuska/zali-messenger.git` |
| Репозиторий сервера | `serverrepo` → `git@github.com:zalikuska/zali-messenger-server.git`, ветка `zali-server` |
| Чекаут на VPS | `/opt/zali-server` |
| Бинарник | `/opt/zali-server/server/target/release/zali_server` |
| Каталог данных | `/var/lib/zali` (из `ZALI_DATA_DIR`) — БД, `uploads/`, `releases/` |
| systemd-юнит | `zali-server.service` (`enabled`, `Restart=always`) |
| Логи приложения | `/root/zali-server.log` (`journalctl -u zali-server` — только события systemd) |
| Версия Windows-клиента | `version` в `apps/windows/Cargo.toml` |
| Версия macOS-клиента | `APP_VERSION` в `scripts/build_app.sh` |

---

## 1. Деплой сервера

Ветка `main` пушится в серверный репозиторий как `zali-server`.

```bash
git push serverrepo main:zali-server
```

```bash
ssh zms "cd /opt/zali-server && git pull --ff-only origin zali-server"
```

```bash
ssh zms "cd /opt/zali-server && cargo build --release --manifest-path server/Cargo.toml -p zali_server 2>&1 | tail -5"
```

```bash
ssh zms "systemctl restart zali-server.service"
```

Проверка — обязательно смотреть на реальный путь бинарника, а не только на статус:

```bash
ssh zms "sleep 3 && systemctl status zali-server.service --no-pager | head -8 && readlink -f /proc/\$(pidof zali_server)/exe"
```

Должно вывести `/opt/zali-server/server/target/release/zali_server`. Если путь
другой (`/opt/zali-server/target/release/...`) — запущен устаревший бинарник,
см. предупреждение про реорганизацию 2026-07-12 в `CLAUDE.md`.

> **Первая сборка после подтягивания Web Push собирает OpenSSL из исходников**
> (`openssl` с фичей `vendored`) — это заметно дольше обычного, но разово.

---

## 2. Сборка веб-ассетов

Обязательно **до** сборки любого нативного клиента — иначе он вкомпилирует
старый JS.

```bash
python3 scripts/bundle_web.py
```

Базовые URL берутся из переменных окружения, а если они не заданы — из дефолта в
`web/src/interface.js` (`defaultApiBaseUrl()`), который уже указывает на
`https://msgs.zalikus.org`. То есть **для прод-релиза переменные задавать не
нужно**. Задавать их надо только для сборки под другой сервер:

```bash
ZALI_API_BASE_URL="https://example.org" ZALI_WS_BASE_URL="wss://example.org" python3 scripts/bundle_web.py
```

---

## 3. Сборка Windows-клиента

### Вариант А. Кросс-сборка с macOS через `cargo-xwin`

`cargo-xwin` сам скачивает Windows SDK и CRT, поэтому отдельная Windows-машина не
нужна. Это снимает старое ограничение из `CLAUDE.md` про падение `ring` на
отсутствующих заголовках Windows SDK.

```bash
cargo install cargo-xwin
```

```bash
rustup target add x86_64-pc-windows-msvc
```

```bash
cargo xwin build --release --manifest-path apps/windows/Cargo.toml --target x86_64-pc-windows-msvc
```

Результат: `apps/windows/target/x86_64-pc-windows-msvc/release/zali_messenger_win.exe`
(~8 МБ). Проверено 2026-07-26 на macOS: сборка проходит за ~34 с с одним
безобидным warning про неиспользуемый `control_flow` в `main.rs`.

> Кросс-сборка даёт валидный бинарник, но **не проверяет поведение**: трей,
> автозапуск, toast-уведомления, AUMID и установщик на реальной Windows этим
> способом не тестируются. Перед публикацией релиза прогоните `.exe` на живой
> машине.

### Вариант Б. Нативная сборка на Windows

```powershell
.\scripts\build_windows_app.ps1
```

Результат: `dist\windows\ZaliMessenger.exe`. Скрипт сам вызывает
`bundle_web.py` перед `cargo build --release`. Запустить сразу:

```powershell
.\scripts\build_windows_app.ps1 -Run
```

Требуется: Rust с MSVC-тулчейном, Python 3 и
[WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
на целевой машине.

### Онлайн-установщик

Собирается один раз и не требует пересборки на каждый релиз — он скачивает
актуальную версию с `/api/version` во время установки.

```powershell
.\scripts\build_windows_app.ps1 -OnlineInstallerOnly
```

Результат: `dist\windows\installer\ZaliMessengerOnlineSetup.exe`. Нужен
[Inno Setup](https://jrsoftware.org/isinfo.php) (`ISCC.exe` в PATH). Локальный
Rust для этого не требуется.

---

## 4. Сборка macOS-клиента

```bash
cd core && cargo build --release && cd ..
```

```bash
./scripts/build_app.sh
```

Результат: `ZaliMessenger.app`. Для публикации его надо упаковать в zip — именно
через `ditto`, потому что `UpdateService.installAndRelaunch` распаковывает архив
им же и ищет внутри `.app`:

```bash
ditto -c -k --keepParent ZaliMessenger.app ZaliMessenger-<версия>.zip
```

> **Если линковка падает с `ld: Assertion failed: (name.size() <= maxLength)`** —
> это разросшийся веб-бандл. `bundle_web.py` кладёт HTML+CSS+JS в `Assets.swift`
> как Swift-литералы; каждый литерал становится одним `__cstring`-атомом, а ld64
> именует атом его же содержимым и падает на имени больше ~1 МиБ. Ошибка не
> называет ни файла, ни символа. Генератор режет бандл на куски по 200 000
> символов, так что само по себе это повториться не должно — но если появится
> снова, уменьшите `max_chunk_chars` в `scripts/bundle_web.py`.

Windows публикуется как «голый» `.exe`, zip ему не нужен.

---

## 5. Публикация обновления

Клиенты (macOS и Windows) при логине дёргают
`GET /api/version?platform=macos|windows` и предлагают обновиться, если версия на
сервере новее. Отказ не теряется — обновление остаётся доступным в карточке
«Обновления» в Hub.

### 5.1. Поднять номер версии

Перед сборкой, иначе клиент сообщит о себе старую версию:

- Windows — `version` в `apps/windows/Cargo.toml`
- macOS — `APP_VERSION` в `scripts/build_app.sh`

> **Публикация той же версии, что уже стоит у клиента, не делает ничего — молча.**
> `checkForAppUpdate()` выходит на `compareVersions(latest, current) <= 0`, без
> единого сообщения в интерфейсе и без записи в лог. Внешне это неотличимо от
> «автообновление сломано». Если обновление не предлагается — первым делом
> сравните опубликованную версию с той, что зашита в клиенте:
>
> ```bash
> curl -s "https://msgs.zalikus.org/api/version?platform=macos" | python3 -m json.tool
> ```

### 5.2. Загрузить артефакт

Штатное место — публичный роут `/releases/:filename`:

```bash
scp <файл> zms:/var/lib/zali/releases/
```

Каталог создаётся сервером при старте. Ссылка для `downloadUrl` будет вида
`https://msgs.zalikus.org/releases/<имя файла>`.

> **Путь к данным задаётся через `ZALI_DATA_DIR`**, и на проде это
> `/var/lib/zali` — **не** `/opt/zali-server`. В `/opt/zali-server` лежат
> `uploads/` и `releases/`, оставшиеся с тех времён, когда переменная не была
> задана; сервер в них не смотрит. Если файл положить туда, роут вернёт `404`.
> Проверить актуальное значение:
>
> ```bash
> ssh zms "grep '^ZALI_DATA_DIR' /etc/zali/zali-server.env"
> ```

> **Не используйте `/uploads/:filename`**, вопреки тому что написано в
> `CLAUDE.md`. Это не статическая раздача, а роут вложений:
> `download_upload_file` ([server/src/messages.rs](server/src/messages.rs))
> требует `AuthenticatedUser` **и** наличия строки в таблице `messages` с таким
> `filename`. Загруженный туда `.exe` отдаёт `401`, и обновление у всех
> пользователей падает на скачивании.
>
> Апдейтер качает файл **без заголовка `Authorization`**
> (`download_update` в [apps/windows/src/native/updates.rs](apps/windows/src/native/updates.rs)),
> и онлайн-установщик тоже — он ходит голым `WinHttp`. Поэтому `downloadUrl`
> обязан быть публично доступным по HTTPS без аутентификации, и `/releases/`
> сделан именно таким намеренно.

Про безопасность `/releases/`: роут читает **только** из `releases_dir`, который
отдельный от `uploads_dir` с пользовательскими вложениями. Имя файла проходит
строгий allowlist `[A-Za-z0-9._-]` с запретом ведущей точки — `..`, разделители
и их URL-кодированные варианты непредставимы, а не «отфильтрованы». Листинга
каталога нет. Всё это покрыто тестами в [tests/releases.rs](tests/releases.rs),
включая обход каталога и попытку достать чужое вложение через этот роут.

Класть в `releases/` можно **только то, что предназначено для публичного
скачивания** — каталог доступен всем без авторизации.

Альтернатива, если не хочется хостить на своём сервере: **GitHub Releases** —
ссылка публична и отдаётся по HTTPS, менять ничего не надо.

### 5.3. Посчитать SHA-256

Клиент сверяет хеш после скачивания, и установщик тоже (через `certutil`).
Неверный хеш — обновление молча не установится.

```bash
shasum -a 256 <файл>
```

### 5.4. Опубликовать метаданные

Требуется `RELEASE_ADMIN_TOKEN` из окружения сервера
(`/etc/zali/zali-server.env`). Если переменная не задана, роут всегда отвечает
403.

```bash
curl -X POST https://msgs.zalikus.org/api/version \
  -H "Authorization: Bearer $RELEASE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"windows","version":"0.2b11","notes":"Исправлены групповые звонки","downloadUrl":"https://msgs.zalikus.org/releases/ZaliMessenger-0.2b11.exe","sha256":"<hex>"}'
```

> ⚠️ `downloadUrl` обязан указывать на **`/releases/`**, а не на `/uploads/`. Второй —
> роут вложений: он требует `Authorization` и строку в `messages` с таким именем файла,
> а артефакт качают без заголовков (и апдейтер, и онлайн-установщик), поэтому оттуда
> приходит `401`. Именно на этом уже спотыкались.

Публикуется **отдельно для каждой платформы** — один POST на `windows`, другой на
`macos`.

### 5.5. Проверить

```bash
curl -s "https://msgs.zalikus.org/api/version?platform=windows"
```

Должны вернуться свежие метаданные. `404` означает, что для этой платформы не
опубликовано ни одной версии.

**Обязательно проверьте, что `downloadUrl` реально скачивается без авторизации** —
иначе клиенты увидят предложение обновиться, но установка провалится:

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" "<downloadUrl>"
```

Должно быть `200` и полный размер файла.

---

## 6. Чеклист релиза

- [ ] Правки в `web/src/interface.js` (канонический источник), не в `web/app.js`
- [ ] `python3 scripts/bundle_web.py` выполнен
- [ ] `cargo test --manifest-path server/Cargo.toml` зелёный
- [ ] Версия поднята в `apps/windows/Cargo.toml` / `scripts/build_app.sh`
- [ ] Сервер задеплоен и `readlink` показывает правильный путь бинарника
- [ ] Клиент проверен на живой машине (кросс-сборка это не заменяет)
- [ ] Артефакт загружен, SHA-256 посчитан
- [ ] `POST /api/version` выполнен для каждой платформы
- [ ] `GET /api/version` возвращает новую версию
- [ ] `graphify update .` выполнен

---

## 7. Порядок выката клиента и сервера

Клиент и сервер иногда меняются парой — новое поле в протоколе появляется
одновременно в JS и в обработчике на сервере. **Сервер выкатывается первым.**
Старый сервер просто игнорирует незнакомые поля, а старый клиент не умеет
пользоваться новыми — обратная совместимость держится в эту сторону, но не в
обратную.

Пример: `keepalive: true` в событии `voice_join`. Старый сервер обрабатывает
такое событие как обычный заход в комнату — то есть веерно рассылает состояние
комнаты каждые 8 секунд и может выбить второе устройство того же аккаунта из
другой комнаты. Клиент с этим полем нельзя выпускать раньше сервера.
