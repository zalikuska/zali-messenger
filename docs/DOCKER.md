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

## Повседневное

```bash
docker compose logs -f zali-server                 # вместо journalctl
docker compose restart zali-server                 # вместо systemctl restart
docker compose exec zali-server sh                 # «ssh внутрь»
# sqlite3 в образе нет (меньше инструментов у того, кто получит выполнение кода) —
# смотреть БД одноразовым контейнером на том же томе:
docker run --rm -it -v zali_zali-data:/data:ro keinos/sqlite3 sqlite3 /data/zali_messenger.db
docker compose cp zali-server:/data/uploads ./uploads-backup
```

Обновление: `git pull && docker compose up -d --build`. Контейнер перезапустится
со старыми данными из тома; миграции БД сервер делает сам при старте.
