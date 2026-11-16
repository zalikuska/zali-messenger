#!/bin/sh
# Точка входа контейнера zali-ssh: готовит хост-ключ, собирает authorized_keys из
# настроенных источников, периодически обновляет их и запускает sshd.
#
# Источники публичных ключей (любая комбинация):
#   SSH_KEYS_GITHUB   имена пользователей GitHub через запятую/пробел →
#                     https://github.com/<имя>.keys
#   SSH_KEYS_URLS     произвольные URL со списком ключей (по одному в строке)
#   /etc/zali-ssh/authorized_keys   файл, смонтированный с хоста (./ssh/)
#
# Каждая строка должна начинаться с типа ключа: строки с опциями
# (`command=…`, `from=…`) отбрасываются, чтобы чужой URL не мог подсунуть ключ
# с произвольной командой. Если источники недоступны или пусты, прежний набор
# ключей остаётся: сбой GitHub не должен запирать вас снаружи.
#
# Основной ключ для входа создаётся при первом старте САМ: приватная часть
# выдаётся один раз по HTTP (см. ssh-key-cgi.sh), публичная остаётся в
# authorized_keys навсегда. Заново выпустить:
#   docker compose exec zali-ssh rm /hostkeys/client_issued
#   docker compose restart zali-ssh
#
# SSH_KEYS_REFRESH — период обновления в секундах (по умолчанию 600; 0 — только
# при старте). Отозвали ключ на GitHub — он перестанет работать за этот срок.
set -eu
umask 077

HOSTKEY=/hostkeys/ssh_host_ed25519_key
KEYS_DIR=/tmp/ssh
KEYS=$KEYS_DIR/authorized_keys
CLIENT_KEY=/hostkeys/client_ed25519
ISSUED=/hostkeys/client_issued
KEY_PORT=2223
LOCAL_FILE=/etc/zali-ssh/authorized_keys
REFRESH="${SSH_KEYS_REFRESH:-600}"

log() { echo "ssh-entrypoint: $*" >&2; }

case "$REFRESH" in
    ''|*[!0-9]*) log "SSH_KEYS_REFRESH должен быть целым числом секунд, получено: $REFRESH"; exit 1 ;;
esac

mkdir -p "$KEYS_DIR"

if [ ! -f "$HOSTKEY" ]; then
    ssh-keygen -q -t ed25519 -N '' -C zali-ssh -f "$HOSTKEY"
    log "создан новый хост-ключ"
fi
log "отпечаток хоста: $(ssh-keygen -l -f "$HOSTKEY.pub")"

# Ключ для входа: создаём, если его ещё нет и он ещё не выдавался. Приватная
# часть живёт только в томе, пока её не заберут через эндпоинт.
#
# Эндпоинт может быть открыт в интернет, а HTTP не шифрует, поэтому приватный ключ
# защищён парольной фразой ПРЯМО В ФАЙЛЕ (формат OpenSSH, bcrypt-KDF): подслушавший
# запрос или опередивший вас получит файл, которым нельзя войти. Фраза — значение
# RELEASE_ADMIN_TOKEN (secrets/release_admin_token, он у администратора и так есть,
# и по сети не передаётся). Если секрета в контейнере нет (режим age), фраза
# случайная и пишется в лог контейнера.
PASS_SRC=/run/secrets/release_admin_token
FETCH_HINT="откройте http://<адрес-хоста>:2223/ (порт ZALI_SSH_KEY_PORT на хосте) и нажмите «Скачать ключ»"
if [ ! -f "$CLIENT_KEY" ] && [ ! -f "$ISSUED" ]; then
    rm -f "$CLIENT_KEY.pub"
    if [ -f "$PASS_SRC" ] && [ -r "$PASS_SRC" ] && [ -s "$PASS_SRC" ]; then
        pass=$(cat "$PASS_SRC")
        pass_note="пароль ключа — содержимое secrets/release_admin_token (RELEASE_ADMIN_TOKEN)"
    else
        pass=$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')
        pass_note="пароль ключа (запишите, больше нигде не показывается): $pass"
    fi
    ssh-keygen -q -t ed25519 -N "$pass" -C zali-docker -f "$CLIENT_KEY"
    unset pass
    log "создан ключ для входа. Заберите его ОДИН раз: $FETCH_HINT"
    log "$pass_note"
elif [ -f "$CLIENT_KEY" ]; then
    log "ключ для входа создан, но ещё не забран: $FETCH_HINT"
else
    log "ключ для входа уже выдан ($(cat "$ISSUED"))"
fi

# Оставляет только строки, начинающиеся с поддерживаемого типа ключа.
filter_keys() {
    grep -E '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+' \
        | tr -d '\r' || true
}

fetch() {
    # --proto =https: не следовать на http по редиректу.
    curl -fsSL --proto '=https' --max-time 15 --max-filesize 262144 "$1"
}

refresh_keys() {
    tmp=$(mktemp "$KEYS_DIR/keys.XXXXXX")
    sources=0

    for user in $(echo "${SSH_KEYS_GITHUB:-}" | tr ',' ' '); do
        case "$user" in
            *[!A-Za-z0-9-]*) log "пропущено недопустимое имя GitHub: $user"; continue ;;
        esac
        sources=$((sources + 1))
        if out=$(fetch "https://github.com/$user.keys"); then
            printf '%s\n' "$out" | filter_keys >> "$tmp"
        else
            log "не удалось получить ключи GitHub-пользователя $user"
        fi
    done

    for url in $(echo "${SSH_KEYS_URLS:-}" | tr ',' ' '); do
        case "$url" in
            https://*) ;;
            *) log "пропущен URL без https: $url"; continue ;;
        esac
        sources=$((sources + 1))
        if out=$(fetch "$url"); then
            printf '%s\n' "$out" | filter_keys >> "$tmp"
        else
            log "не удалось получить ключи с $url"
        fi
    done

    if [ -f "$CLIENT_KEY.pub" ]; then
        sources=$((sources + 1))
        filter_keys < "$CLIENT_KEY.pub" >> "$tmp"
    fi

    if [ -f "$LOCAL_FILE" ]; then
        sources=$((sources + 1))
        filter_keys < "$LOCAL_FILE" >> "$tmp"
    fi

    # sort -u убирает дубли и держит порядок детерминированным; потолок в 200
    # строк — защита от разросшегося или подложенного списка.
    sort -u "$tmp" | head -n 200 > "$tmp.sorted"
    rm -f "$tmp"
    count=$(wc -l < "$tmp.sorted" | tr -d ' ')

    if [ "$count" -gt 0 ]; then
        mv -f "$tmp.sorted" "$KEYS"
        log "authorized_keys обновлён: $count ключ(ей)"
    else
        rm -f "$tmp.sorted"
        if [ "$sources" -eq 0 ]; then
            log "ВНИМАНИЕ: источников ключей нет — задайте SSH_KEYS_GITHUB / SSH_KEYS_URLS или положите ./ssh/authorized_keys"
        else
            log "ВНИМАНИЕ: источники не дали ни одного ключа, прежний набор сохранён"
        fi
        [ -f "$KEYS" ] || : > "$KEYS"
    fi
}

refresh_keys

# Эндпоинт одноразовой выдачи ключа. Внутри контейнера слушает 0.0.0.0:2223,
# наружу compose публикует его только на loopback хоста.
busybox httpd -f -p "$KEY_PORT" -h /srv/www &

if [ "$REFRESH" -gt 0 ]; then
    (
        while sleep "$REFRESH"; do
            refresh_keys || log "обновление ключей не удалось"
        done
    ) &
fi

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config_zali
