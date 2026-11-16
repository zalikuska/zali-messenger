#!/usr/bin/env bash
# Готовит секреты для docker-compose.
#
#   ./scripts/docker_init_secrets.sh          секреты файлом (по умолчанию, docker-compose.yml)
#   ./scripts/docker_init_secrets.sh --age     то же, но зашифрованными (docker-compose.age.yml)
#
# Безопасно запускать повторно: существующие секреты не перезаписываются.
set -euo pipefail
cd "$(dirname "$0")/.."

umask 077
mkdir -p secrets
chmod 700 secrets

mode="file"
for arg in "$@"; do
    case "$arg" in
        --age) mode="age" ;;
        *) echo "неизвестный аргумент: $arg (ожидался --age или ничего)" >&2; exit 2 ;;
    esac
done

gen() {
    local f="secrets/$1"
    if [ -s "$f" ]; then
        echo "есть:    $f (не трогаю)"
    else
        openssl rand -hex 32 > "$f"
        # Читаемый, чтобы его смог открыть пользователь контейнера (uid 10001):
        # Docker монтирует файл как есть, с правами хоста. Доступ остальным на
        # хосте закрывает каталог secrets/ (700).
        chmod 644 "$f"
        echo "создан:  $f"
    fi
}

if [ "$mode" = "age" ]; then
    command -v age >/dev/null 2>&1 || { echo "нужен age (brew install age / apt install age)" >&2; exit 1; }
    command -v age-keygen >/dev/null 2>&1 || { echo "нужен age-keygen (идёт в одном пакете с age)" >&2; exit 1; }

    recipient_file="secrets/.age-recipient"
    if [ -s "$recipient_file" ]; then
        recipient=$(cat "$recipient_file")
        echo "использую сохранённый публичный ключ: $recipient (не секрет, можно держать на диске)"
    else
        echo "Генерирую новую пару ключей age."
        # age-keygen отказывается писать в уже существующий файл (даже пустой) —
        # поэтому путь только внутри каталога от mktemp -d, а не сам mktemp.
        tmp_dir=$(mktemp -d)
        trap 'rm -rf "$tmp_dir"' EXIT
        tmp_identity="$tmp_dir/identity"
        tmp_pub="$tmp_dir/pub"
        age-keygen -o "$tmp_identity" 2>"$tmp_pub"
        recipient=$(grep -oE 'age1[a-z0-9]+' "$tmp_pub" | head -1)
        [ -n "$recipient" ] || { echo "не удалось получить публичный ключ из age-keygen" >&2; exit 1; }
        echo
        echo "================ СОХРАНИТЕ ПРИВАТНЫЙ КЛЮЧ — ПОКАЗЫВАЮ ОДИН РАЗ ================"
        cat "$tmp_identity"
        echo "=================================================================================="
        echo
        echo "Сохраните строку AGE-SECRET-KEY-1... в своём менеджере паролей (1Password, pass,"
        echo "сейф с бумагой — что угодно, НЕ этот диск) прямо сейчас. Этот скрипт его нигде"
        echo "не сохраняет и не может показать повторно: при утере зашифрованные секреты не"
        echo "прочитает никто, включая вас — придётся сгенерировать новую пару и зашифровать"
        echo "секреты заново."
        echo
        printf '%s\n' "$recipient" > "$recipient_file"
        chmod 644 "$recipient_file"
        rm -rf "$tmp_dir"
        trap - EXIT
        echo "публичный ключ сохранён: $recipient_file ($recipient)"
    fi

    age_gen() {
        # Два отдельных `local`: в одной строке `set -u` разворачивает все
        # слова до того, как присвоит первое, и падает на "$name" в "$f".
        local name="$1"
        local f="secrets/$name.age"
        if [ -s "$f" ]; then
            echo "есть:    $f (не трогаю)"
        else
            openssl rand -hex 32 | age -r "$recipient" -o "$f"
            chmod 644 "$f"
            echo "создан:  $f (зашифрован, читать можно без ключа — толку от этого нет)"
        fi
    }
    age_gen jwt_secret
    age_gen release_admin_token

    echo
    echo "дальше, при каждом запуске (ключ нигде на сервере не остаётся — вводите заново):"
    echo '  umask 077; printf "%s\n" "<приватный ключ из вывода выше>" > secrets/.age-identity'
    echo "  docker compose -f docker-compose.yml -f docker-compose.age.yml up -d --build"
    echo "  rm -f secrets/.age-identity   # entrypoint уже стёр содержимое, но проверьте сами"
    exit 0
fi

gen jwt_secret
gen release_admin_token

if [ -f .env ]; then
    perm=$(stat -f %Lp .env 2>/dev/null || stat -c %a .env)
    if [ "$perm" != "600" ]; then
        chmod 600 .env
        echo ".env:    права ужесточены до 600 (были $perm)"
    fi
    if grep -qE '^(JWT_SECRET|RELEASE_ADMIN_TOKEN)=.+' .env; then
        echo "ВНИМАНИЕ: в .env остались JWT_SECRET/RELEASE_ADMIN_TOKEN. Compose берёт секреты из"
        echo "          secrets/ (файл главнее), но значения в .env всё равно лежат открытым текстом."
        echo "          Чтобы сохранить действующие сессии, перенесите значение в secrets/jwt_secret"
        echo "          (printf %s \"\$JWT_SECRET\" > secrets/jwt_secret) и удалите строку из .env."
    fi
    if grep -qiE '^ALLOW_GUEST_MODE=true' .env; then
        echo "ВНИМАНИЕ: в .env ALLOW_GUEST_MODE=true. В Docker это принудительно выключено"
        echo "          (docker-compose.yml), но на любом другом сервере такое значение отключает вход."
    fi
fi
echo "готово: docker compose up -d --build"
