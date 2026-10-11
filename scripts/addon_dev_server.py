#!/usr/bin/env python3
"""Эталонный внешний сервер данных для аддонов с разрешением `network.any`.

Аддон может хранить данные не в облаке ZaliMessenger, а на своём сервере. Этот
скрипт — минимальная реализация такого сервера для разработки: ключ → JSON,
CORS разрешён, данные в одном JSON-файле. Не для продакшена (нет TLS, нет
квот на число клиентов), но протокол годится как образец:

    GET    /kv            → {"keys": [...], "bytes": N}
    GET    /kv/<ключ>     → {"value": ...}              (404, если нет)
    PUT    /kv/<ключ>     тело {"value": ...}           → {"ok": true}
    DELETE /kv/<ключ>     → {"ok": true}

    python3 scripts/addon_dev_server.py --port 8787 --file kv.json [--token секрет]

Из аддона (разрешение `network.any`, обычный fetch):

    await fetch('http://127.0.0.1:8787/kv/progress', {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({value: {level: 3}}),
    });

`http://` к своему компьютеру или локальной сети CSP аддона с `network.any`
разрешает; к чужим серверам берите https. Пример — examples/addons/external-sync.
"""

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

LIMIT = 10 * 1024 * 1024


def make_handler(store, path, token):
    lock = threading.Lock()

    def save():
        if path:
            Path(path).write_text(json.dumps(store, ensure_ascii=False))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print("%s %s" % (self.address_string(), fmt % args))

        def send(self, status, body=None):
            raw = json.dumps(body if body is not None else {}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            if token and self.headers.get("Authorization") != f"Bearer {token}":
                self.send(401, {"error": "unauthorized"})
                return False
            return True

        def key(self):
            parsed = urlparse(self.path).path
            if parsed == "/kv":
                return ""
            if parsed.startswith("/kv/"):
                return unquote(parsed[4:])
            return None

        def do_OPTIONS(self):
            self.send(204)

        def do_GET(self):
            if not self.authorized():
                return
            key = self.key()
            if key is None:
                return self.send(404, {"error": "not found"})
            with lock:
                if key == "":
                    size = sum(len(json.dumps(v)) for v in store.values())
                    return self.send(200, {"keys": sorted(store), "bytes": size})
                if key not in store:
                    return self.send(404, {"error": "not found"})
                return self.send(200, {"value": store[key]})

        def do_PUT(self):
            if not self.authorized():
                return
            key = self.key()
            if not key:
                return self.send(400, {"error": "key required"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > LIMIT:
                return self.send(413, {"error": "too large"})
            try:
                value = json.loads(self.rfile.read(length) or b"{}")["value"]
            except (ValueError, KeyError):
                return self.send(400, {"error": 'body must be {"value": ...}'})
            with lock:
                store[key] = value
                save()
            self.send(200, {"ok": True})

        def do_DELETE(self):
            if not self.authorized():
                return
            key = self.key()
            if not key:
                return self.send(400, {"error": "key required"})
            with lock:
                store.pop(key, None)
                save()
            self.send(200, {"ok": True})

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Образцовый внешний сервер данных для аддонов")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--file", help="JSON-файл для хранения (иначе только в памяти)")
    parser.add_argument("--token", help="требовать Authorization: Bearer <token>")
    args = parser.parse_args()
    store = {}
    if args.file and Path(args.file).exists():
        store = json.loads(Path(args.file).read_text() or "{}")
    server = ThreadingHTTPServer((args.host, args.port), make_handler(store, args.file, args.token))
    print(f"Слушаю http://{args.host}:{args.port}/kv (Ctrl+C — стоп)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
