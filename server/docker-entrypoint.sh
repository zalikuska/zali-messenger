#!/bin/sh
# Точка входа контейнера: подгружает секреты (из файла или из age-шифрованного
# файла) и запускает сервер.
#
# Секрет в переменной окружения виден в `docker inspect`, в `docker compose
# config` и любому, кто прочтёт /proc/<pid>/environ контейнера. Секрет в файле
# (Docker secret → /run/secrets/…) туда не попадает: переменная `<ИМЯ>_FILE`
# хранит только путь, а значение читается здесь, уже внутри контейнера.
#
# `<ИМЯ>_FILE_AGE` — то же самое, но файл зашифрован age (команда
# `scripts/docker_init_secrets.sh --age`). Ciphertext можно держать на диске и
# в бэкапах открыто: без ключа расшифровки он бесполезен.
#
# Ключ расшифровки — `AGE_IDENTITY_FILE`, путь к файлу, который оператор
# монтирует в контейнер ТОЛЬКО на время `docker compose up` (не переменная
# окружения со значением ключа: значение переменной Docker навсегда пишет в
# свой собственный конфиг контейнера на диске хоста — `docker inspect` →
# Config.Env, файл .../containers/<id>/config.v2.json, — то есть секрет лёг бы
# на диск ровно там, откуда мы его убираем; путь к файлу так не хранится, он
# не секрет). Сразу после чтения этот скрипт стирает содержимое файла — то же
# самое делайте и на хосте, а для restart/перезагрузки хоста кладите ключ
# заново. Плата за это описана в docs/DOCKER.md.
#
# Ровно один из `_FILE` / `_FILE_AGE` на переменную; ни тот, ни другой секрет
# это не прячет от процесса, которому он нужен для работы — он неизбежно
# оказывается расшифрованным в памяти `zali_server` на время использования.
set -eu

# Файлы данных (БД, ключ подписи аддонов, uploads) — только владельцу.
umask 077

AGE_IDENTITY_FILE="${AGE_IDENTITY_FILE:-}"
if [ -n "$AGE_IDENTITY_FILE" ]; then
    # `-f`, не только `-r`: если на хосте secrets/.age-identity не был создан
    # заранее, Docker при bind-mount сам создаёт на его месте ПУСТУЮ ДИРЕКТОРИЮ
    # (стандартная ловушка bind-mount), а не ошибку — а директория читаема
    # (-r верно для неё тоже), так что без этой проверки age падает с невнятным
    # «is a directory» вместо понятного сообщения ниже.
    if [ ! -f "$AGE_IDENTITY_FILE" ] || [ ! -r "$AGE_IDENTITY_FILE" ]; then
        echo "entrypoint: AGE_IDENTITY_FILE не указывает на читаемый обычный файл: $AGE_IDENTITY_FILE (secrets/.age-identity на хосте не создан перед docker compose up?)" >&2
        exit 1
    fi
fi

for var in JWT_SECRET RELEASE_ADMIN_TOKEN HASH_CHAIN_KEY TURN_STATIC_AUTH_SECRET VAPID_PRIVATE_KEY; do
    eval "plain_path=\${${var}_FILE:-}"
    eval "age_path=\${${var}_FILE_AGE:-}"
    if [ -n "$plain_path" ] && [ -n "$age_path" ]; then
        echo "entrypoint: заданы и ${var}_FILE, и ${var}_FILE_AGE — непонятно, какой источник верен" >&2
        exit 1
    fi

    if [ -n "$age_path" ]; then
        if [ -z "$AGE_IDENTITY_FILE" ]; then
            echo "entrypoint: ${var}_FILE_AGE задан, а AGE_IDENTITY_FILE нет — нечем расшифровать" >&2
            exit 1
        fi
        if [ ! -r "$age_path" ]; then
            echo "entrypoint: ${var}_FILE_AGE указывает на нечитаемый файл: $age_path" >&2
            exit 1
        fi
        if ! value=$(age --decrypt --identity "$AGE_IDENTITY_FILE" "$age_path" 2>/tmp/age-err); then
            echo "entrypoint: не удалось расшифровать ${var}_FILE_AGE ($age_path): $(cat /tmp/age-err)" >&2
            rm -f /tmp/age-err
            exit 1
        fi
        rm -f /tmp/age-err
        if [ -z "$value" ]; then
            echo "entrypoint: расшифрованный ${var}_FILE_AGE пуст: $age_path" >&2
            exit 1
        fi
        export "$var=$value"
        unset "${var}_FILE_AGE"
        continue
    fi

    [ -n "$plain_path" ] || continue
    if [ ! -r "$plain_path" ]; then
        echo "entrypoint: ${var}_FILE указывает на нечитаемый файл: $plain_path" >&2
        exit 1
    fi
    # $(…) срезает завершающий перевод строки, который оставляет `echo > файл`.
    value=$(cat "$plain_path")
    if [ -z "$value" ]; then
        echo "entrypoint: файл ${var}_FILE пуст: $plain_path" >&2
        exit 1
    fi
    export "$var=$value"
    unset "${var}_FILE"
done

# Ключ больше не нужен: стираем содержимое смонтированного файла НА ХОСТЕ
# (bind-mount — тот же инод, запись отсюда долетает до реального файла).
# Сам путь-мойнтпоинт не трогаем (unlink по нему обычно падает EBUSY) —
# достаточно обнулить содержимое, после чего restart без нового ключа
# завершится понятной ошибкой выше, а не тихо переживёт его потерю.
if [ -n "$AGE_IDENTITY_FILE" ]; then
    : > "$AGE_IDENTITY_FILE" 2>/dev/null || true
fi

exec /usr/local/bin/zali_server "$@"
