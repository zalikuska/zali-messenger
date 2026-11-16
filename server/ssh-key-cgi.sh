#!/bin/sh
# Одноразовая выдача приватного ключа для входа по SSH.
# Вызывается busybox httpd как CGI: GET /cgi-bin/ssh-key (порт 2223, loopback хоста).
#
# Первый GET отдаёт ключ и навсегда убирает его из контейнера; все следующие
# получают 410 Gone. «Один раз» обеспечивает атомарный mv: из двух
# одновременных запросов он удаётся только одному, второй видит 410.
# Ключ нигде не кешируется (Cache-Control: no-store) и не пишется в лог.
set -u
umask 077

STATE=/hostkeys
KEY="$STATE/client_ed25519"
ISSUING="$STATE/.client_ed25519.issuing"
ISSUED="$STATE/client_issued"

respond() { # статус, текст
    printf 'Status: %s\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\n\r\n%s\n' "$1" "$2"
}

# В лог контейнера (stdout PID 1), чтобы выдачу ключа было видно.
note() { echo "ssh-key: $*" > /proc/1/fd/1 2>/dev/null || true; }

if [ "${REQUEST_METHOD:-GET}" != "GET" ]; then
    # HEAD и прочее не должны «съесть» ключ.
    respond "405 Method Not Allowed" "только GET"
    exit 0
fi

if mv "$KEY" "$ISSUING" 2>/dev/null; then
    # attachment: из браузера файл скачивается, а не открывается как текст.
    printf 'Status: 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="zali_docker_key"\r\nCache-Control: no-store\r\n\r\n'
    cat "$ISSUING"
    date -u +%FT%TZ > "$ISSUED"
    rm -f "$ISSUING"
    note "приватный ключ выдан (клиент ${REMOTE_ADDR:-?}); повторно не выдаётся"
else
    note "повторный запрос ключа отклонён (клиент ${REMOTE_ADDR:-?})"
    respond "410 Gone" "Ключ уже выдан и в контейнере его больше нет. Новый: docker compose exec zali-ssh rm /hostkeys/client_issued && docker compose restart zali-ssh"
fi
