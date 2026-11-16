# Сервер в Docker

Образ собирает только сервер (`zali_server`). Веб-клиент в него не входит — он
вшит в клиентов. TLS-прокси (nginx) и TURN-релей (coturn) остаются на хосте.

## Запуск

```bash
cp .env.example .env              # ALLOWED_ORIGINS и прочие НЕсекретные настройки
./scripts/docker_init_secrets.sh  # JWT_SECRET и RELEASE_ADMIN_TOKEN → ./secrets/
docker compose up -d --build
docker compose ps        # STATUS должен стать healthy
```

Контекст сборки — **корень репозитория**, а не `server/`: крейт зависит от
`../sdk/Rust`, а `../core` и `../tests` нужны cargo для разбора манифеста
(`docker build -f server/Dockerfile .`). Сборка Rust тяжёлая; по умолчанию
`CARGO_BUILD_JOBS=2`, на сильной машине — `CARGO_BUILD_JOBS=8 docker compose build`.

## Что где лежит

| | |
|---|---|
| Порт | контейнер `3000`, на хосте только `127.0.0.1:${ZALI_HOST_PORT:-3001}` |
| Данные | том `zali-data` → `/data` (`ZALI_DATA_DIR`): БД, `uploads/`, `releases/`, `addon_signing_key.pem` |
| Пользователь | `10001:10001`, не root; корневая ФС read-only, `cap_drop: ALL`, `no-new-privileges` |
| Память | `mem_limit: 1g` (`ZALI_MEM_LIMIT`) |
| Проверка | `GET /health` |

**Данные только в `/data`.** Без `ZALI_DATA_DIR` сервер берёт каталог по пути
сборки внутри образа, и всё пропадёт при пересоздании контейнера. Ключ подписи
аддонов нельзя терять: все выданные подписи перестанут сходиться.

Взять каталог с хоста вместо тома:

```bash
sudo chown -R 10001:10001 /var/lib/zali
ZALI_DATA_HOST=/var/lib/zali docker compose up -d
```

## nginx на хосте

Проксируйте на `127.0.0.1:3001`. Для WebSocket нужны обычные заголовки апгрейда;
сервер сам шлёт Ping каждые 20 с, так что длинный `proxy_read_timeout` не нужен.

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;   # map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### IP клиента и rate limit

Сервер верит `X-Real-IP`, только если соединение пришло от доверенного прокси.
Без Docker это loopback. В Docker nginx приходит с адреса шлюза сети compose
(`172.29.77.1`), поэтому `docker-compose.yml` задаёт
`TRUSTED_PROXY_CIDRS=172.29.77.0/24` — ровно подсеть сети `zali`. Менять её
нужно вместе с `networks.zali.ipam`. Если сервер увидит чужой IP в этом списке,
он поверит его заголовку, так что держите список узким и не публикуйте порт
наружу (`0.0.0.0:`).

Проверка: сервер пишет IP клиента в лог при срабатывании лимита
(`Rate limit exceeded … ip=`). Там должен быть реальный адрес, а не `172.29.77.1`.
Если везде шлюз — прокси не распознан: сверьте подсеть и `TRUSTED_PROXY_MODE=true`.

## Защита секретов и данных

| Что | Как защищено |
|---|---|
| `JWT_SECRET`, `RELEASE_ADMIN_TOKEN` | Файлами в `./secrets/` (Docker secrets), а не переменными: в `docker inspect`, `docker compose config` и слоях образа их нет. Точка входа (`server/docker-entrypoint.sh`) читает `<ИМЯ>_FILE`; так же работают `HASH_CHAIN_KEY`, `TURN_STATIC_AUTH_SECRET`, `VAPID_PRIVATE_KEY`. Файл главнее переменной. |
| `secrets/`, `.env` | В `.gitignore` и `.dockerignore`; каталог `700`. Скрипт `scripts/docker_init_secrets.sh` ужесточает `.env` до `600` и предупреждает, если там остались секреты — всё, что лежит в `.env`, **видно** в `docker inspect`. |
| Файлы данных | `umask 077`: БД, ключ подписи аддонов и `uploads/` читаются только пользователем контейнера; `/data` — `700`. |
| Контейнер | Корневая ФС только для чтения (пишется `/data` и `/tmp` без exec), все capabilities сняты, `no-new-privileges`, лимит процессов, не root. В образе нет `sqlite3` и лишних утилит. |
| Гостевой режим | В compose принудительно `ALLOW_GUEST_MODE=false`: значение `true` из старого `.env` отключило бы аутентификацию целиком. |
| Сеть | Порт опубликован только на `127.0.0.1`. Не меняйте на `0.0.0.0:` — доверие к `X-Real-IP` держится на том, что до сервера достаёт только ваш прокси. |

Что это **не** закрывает: тот, кто получил `docker exec` или доступ к демону Docker,
читает всё, включая `/run/secrets` — защищайте сам хост и группу `docker`. Секрет
сервера, нужный ему для работы, неизбежно лежит у него в памяти.

Смена `JWT_SECRET` разлогинивает всех. Чтобы перенести действующий секрет из старого
`.env`: `printf %s "$JWT_SECRET" > secrets/jwt_secret`, затем удалить строку из `.env`.

Android-пуши (FCM): ключ сервисного аккаунта в `./secrets/fcm.json`, раскомментировать
монтирование в `docker-compose.yml` и задать `FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm.json`.

### Более жёсткий режим: секреты на диске зашифрованы (age)

Режим выше защищает секрет от утечки через git, образ, `docker inspect` и логи, но
`JWT_SECRET`/`RELEASE_ADMIN_TOKEN` всё равно лежат на диске открытым текстом
(`secrets/jwt_secret`) — у кого есть доступ к файлам хоста (украденный диск, бэкап,
root), у того есть и секрет. `docker-compose.age.yml` убирает и это: на диске лежит
только шифротекст (`secrets/*.age`), а ключ расшифровки не хранится вовсе — его
нужно класть заново перед каждым `up`.

```bash
./scripts/docker_init_secrets.sh --age
# вывод — ОДИН РАЗ показывает приватный ключ AGE-SECRET-KEY-1…; сохраните его в
# своём менеджере паролей сейчас же, скрипт его не запоминает и не покажет снова

umask 077; printf '%s\n' "<приватный ключ>" > secrets/.age-identity
docker compose -f docker-compose.yml -f docker-compose.age.yml up -d --build
rm -f secrets/.age-identity   # entrypoint уже обнулил содержимое, но проверьте сами
```

Что происходит технически: `docker-entrypoint.sh` расшифровывает `*.age` файлом
`AGE_IDENTITY_FILE`, а не переменной окружения со значением ключа — значение
переменной Docker пишет навсегда в свой же конфиг контейнера на диске хоста
(`docker inspect` → `Config.Env`, файл `.../containers/<id>/config.v2.json`), то
есть секрет оказался бы ровно там, откуда мы его убираем. Путь к файлу сам по
себе не секрет. Сразу после чтения entrypoint стирает содержимое
`secrets/.age-identity` (bind-mount — тот же инод на хосте).

**Плата.** Без свежего `secrets/.age-identity` контейнер не поднимется —
в том числе сам, после перезагрузки хоста: `restart: unless-stopped` не помогает,
когда файла с ключом уже нет, контейнер просто крутится в цикле перезапуска с понятной
ошибкой в `docker logs`. Это обязательный побочный эффект самой идеи «ключ не хранится»,
а не недоработка: любой автоматический способ поднять его без человека означал бы,
что ключ где-то на диске сохранён — иначе было бы нечем автоматически его взять.
Поднимать такой сервер — вручную, с ключом под рукой.

**Типичная ошибка:** если `docker compose up` запустили раньше, чем создали
`secrets/.age-identity`, Docker сам создаёт на этом месте пустую **директорию**
(обычное поведение bind-mount для отсутствующего источника), и просто положить файл
с тем же именем потом уже не получится — сначала `rm -rf secrets/.age-identity`.

Утеря приватного ключа без копии в менеджере паролей — не read_only-происшествие,
а отказ: расшифровать `*.age` не сможет никто, включая вас. Нужна новая пара ключей
(`./scripts/docker_init_secrets.sh --age` после `rm secrets/.age-recipient
secrets/*.age`) и перевыпуск секретов.

Это не защищает от атакующего, который получил `docker exec` или ptrace на уже
запущенный контейнер (там секрет неизбежно в памяти процесса) — только от кражи
диска/бэкапа, когда контейнер не работает или ключ ещё не введён.

## TURN

coturn в compose нет: его UDP-диапазон через Docker NAT работает плохо
(рывки или вообще нет соединения за NAT). Сервер лишь выдаёт TURN-креды
(`TURN_STATIC_AUTH_SECRET`, `TURN_URLS`); сам релей держите на хосте.

## SSH

Вместе с сервером всегда поднимается сервис `zali-ssh` — вход по SSH с полным
доступом к окружению сервера. Ничего готовить не нужно: ключ создаётся сам. Это
отдельный контейнер, а не sshd внутри образа `zali_server`: у того в рантайме нет
шелла для людей, и ломать это ради SSH не нужно — контейнер видит те же данные и
секреты.

```bash
docker compose up -d --build
```

Всё. Эндпоинт уже работает и открыт наружу. Откройте в браузере
**http://<адрес-хоста>:2223/** и нажмите «Скачать ключ» (или `GET /cgi-bin/ssh-key`).
Дальше:

```bash
chmod 600 ~/Downloads/zali_docker_key    # ssh отказывается работать с ключом, открытым всем
ssh -i ~/Downloads/zali_docker_key -p 2222 zali@<адрес-хоста>
# ssh спросит пароль ключа: содержимое secrets/release_admin_token
# (убрать пароль насовсем: ssh-keygen -p -f ~/Downloads/zali_docker_key)
```

Эта же подсказка пишется в `docker compose logs zali-ssh`, там же отпечаток хоста
для первого подключения.

**Ключ выдаётся один раз.** При первом старте контейнер создаёт пару ключей:
публичная часть сразу попадает в `authorized_keys`, приватная лежит в томе
`zali-ssh-hostkeys`, пока её не заберут запросом `GET /cgi-bin/ssh-key`. Первый
запрос получает ключ, и он навсегда удаляется из контейнера; все следующие — `410 Gone`
(из 8 одновременных запросов успешен ровно один). `HEAD`/`POST` ключ не расходуют.
Выдача и каждый отклонённый повтор пишутся в лог контейнера.

**Почему это безопасно открывать наружу.** Эндпоинт работает по обычному HTTP, поэтому
приватный ключ в файле **зашифрован парольной фразой** (формат OpenSSH, bcrypt): тот, кто
подслушал запрос или успел раньше вас, получит файл, которым нельзя войти. Парольная
фраза — `RELEASE_ADMIN_TOKEN` (`secrets/release_admin_token`); по сети она не ходит. В
режиме `docker-compose.age.yml` секрета в контейнере нет, и фраза случайная — она один
раз пишется в `docker compose logs zali-ssh`. Остаточный риск — **опередивший вас может
«сжечь» выдачу** (получит бесполезный файл, вам придёт `410`): тогда перевыпустите
ключ, как ниже. Откройте страницу сразу после установки. Если ключ ещё не забран, а
эндпоинт уже ответил `410` на ваш первый запрос, это он.

**Файрвол.** Порты `2222` (SSH) и `2223` (выдача ключа) опубликованы на `0.0.0.0`, а
Docker публикует порты в обход `ufw`/`firewalld` — ограничивайте доступ облачным
файрволом (разрешите только свои адреса). `ZALI_SSH_BIND=127.0.0.1` и
`ZALI_SSH_KEY_BIND=127.0.0.1` возвращают всё на loopback (ходить тогда через
`ssh -J user@хост …` или `ssh -L`).

Потеряли ключ или забрали чужой — выпустите новый, старый перестанет работать:

```bash
docker compose exec zali-ssh rm /hostkeys/client_issued
docker compose restart zali-ssh
```

**Дополнительные ключи.** Помимо основного, каждые `SSH_KEYS_REFRESH` секунд (600 по
умолчанию, `0` — только при старте) `ssh-entrypoint.sh` пересобирает `authorized_keys`
ещё и из логинов GitHub (`SSH_KEYS_GITHUB`, через запятую → `github.com/<логин>.keys`),
https-URL (`SSH_KEYS_URLS`) и файла `./ssh/authorized_keys` на хосте. Принимаются
только строки, начинающиеся с типа ключа: строки с опциями (`command=`, `from=`)
отбрасываются, чтобы источник не мог подсунуть ключ с произвольной командой. Если
источники недоступны, прежний набор остаётся — сбой GitHub не запрёт вас.

| | |
|---|---|
| Порты | SSH `0.0.0.0:${ZALI_SSH_PORT:-2222}`; выдача ключа `0.0.0.0:${ZALI_SSH_KEY_PORT:-2223}` (оба — `ZALI_SSH_BIND` / `ZALI_SSH_KEY_BIND`) |
| Если порты на loopback | `ssh -J user@хост -i zali_docker_key -p 2222 zali@127.0.0.1` или `ssh -L 2222:127.0.0.1:2222 user@хост` |
| Вход | только по ключу, пользователь `zali` (uid 10001, тот же, что у сервера), без паролей |
| Данные | `/data` — БД, `uploads/`, `releases/`, ключ подписи аддонов, **с записью** (`ZALI_SSH_DATA_MODE=ro` — только чтение) |
| Секреты | `/run/secrets/jwt_secret`, `/run/secrets/release_admin_token` — читаются |
| Сеть | та же compose-сеть `zali`: `curl http://zali-server:3000/health` |
| В сессии | `bash`, `sqlite3`, `curl`, `sftp`; пробросы портов/агента/X11 выключены |
| Процессы | чтобы видеть и останавливать `zali_server`, раскомментируйте `pid: "service:zali-server"` в `docker-compose.yml` |
| Отпечаток хоста | в томе `zali-ssh-hostkeys`, переживает пересоздание контейнера |
| Контейнер | sshd без root, `read_only`, `cap_drop: ALL`, `no-new-privileges` |

Это **не root**: sshd без root — сознательно, иначе контейнеру пришлось бы вернуть
capabilities. Нужен root в контейнере сервера — `docker compose exec -u root
zali-server sh` с хоста.

**Цена.** Любой, у кого есть приватный ключ (`zali_docker_key`) или чей публичный ключ
подтягивается с GitHub, владеет сервером: читает и правит БД, подписывает аддоны,
берёт `JWT_SECRET` и админ-токен. Берегите `zali_docker_key`, закройте порты файрволом от посторонних, в `SSH_KEYS_GITHUB` указывайте только свои аккаунты. В режиме
`docker-compose.age.yml` сервис секретов не получает (открытых файлов там нет).
Не нужен SSH совсем — `docker compose up -d zali-server` запускает только сервер.

Если данные взяты с хоста через `ZALI_DATA_HOST`, каталог должен принадлежать uid
10001 (`chown` из раздела выше) — `zali-ssh` работает под тем же пользователем.

## Повседневное

```bash
docker compose logs -f zali-server                 # вместо journalctl
docker compose restart zali-server                 # вместо systemctl restart
docker compose exec zali-server sh                 # шелл внутри (с хоста); по сети — раздел «SSH»
# sqlite3 в образе нет (меньше инструментов у того, кто получит выполнение кода) —
# смотреть БД одноразовым контейнером на том же томе:
docker run --rm -it -v zali_zali-data:/data:ro keinos/sqlite3 sqlite3 /data/zali_messenger.db
docker compose cp zali-server:/data/uploads ./uploads-backup
```

Обновление: `git pull && docker compose up -d --build`. Контейнер перезапустится
со старыми данными из тома; миграции БД сервер делает сам при старте.
