#!/usr/bin/env python3
"""Облако аддонов ZaliMessenger из командной строки (для авторов аддонов).

Облако — 10 МБ на аддон (на всех его пользователей вместе), только для
подписанных аддонов. У человека личная область (до 1 МБ), общая `--shared`
читается всеми и пишется автором, а автор ещё и собирает личные данные
пользователей (`collect`). Всё — без запуска приложения:

    python3 scripts/addon_cloud.py --api http://127.0.0.1:3000 --user me usage org.example.snake
    python3 scripts/addon_cloud.py ... ls  org.example.snake            # моя личная область
    python3 scripts/addon_cloud.py ... --shared ls org.example.snake    # общая
    python3 scripts/addon_cloud.py ... get org.example.snake progress
    python3 scripts/addon_cloud.py ... put org.example.snake progress '{"level": 3}'
    python3 scripts/addon_cloud.py ... --shared put org.example.snake news '"привет"'   # автор
    python3 scripts/addon_cloud.py ... put org.example.snake save.bin --file ./save.bin
    python3 scripts/addon_cloud.py ... rm  org.example.snake progress
    python3 scripts/addon_cloud.py ... clear org.example.snake          # стереть свои данные
    python3 scripts/addon_cloud.py ... collect org.example.snake        # автор: список по людям
    python3 scripts/addon_cloud.py ... collect org.example.snake --user alice --key survey

Пароль берётся из ZALI_PASSWORD (или спрашивается), токен — из ZALI_TOKEN, тогда
логин не нужен. Протокол — server/src/addon_cloud.rs, раздел 11 docs/ADDONS.md.
"""

import argparse
import base64
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

QUOTA = 10 * 1024 * 1024


def request(api, method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(api.rstrip("/") + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, {"message": raw.decode("utf-8", "replace")[:200]}


def login(api, user, password):
    req = urllib.request.Request(
        api.rstrip("/") + "/api/auth/login",
        data=json.dumps({"username": user, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())["token"]
    except urllib.error.HTTPError as err:
        sys.exit(f"Вход не удался: {err.code}")


def human(size):
    return f"{size / 1024 / 1024:.2f} МБ" if size >= 1024 * 1024 else f"{size / 1024:.1f} КБ"


def main():
    parser = argparse.ArgumentParser(description="Облако аддонов ZaliMessenger")
    parser.add_argument("--api", default=os.environ.get("ZALI_API_URL", "https://msgs.zalikus.org"))
    parser.add_argument("--user", default=os.environ.get("ZALI_USER"))
    parser.add_argument("--shared", action="store_true", help="общая область вместо личной")
    sub = parser.add_subparsers(dest="cmd", required=True)
    collect = sub.add_parser("collect", help="автору: личные данные пользователей")
    collect.add_argument("addon")
    collect.add_argument("--user", dest="of_user", help="чьё значение показать")
    collect.add_argument("--key", help="какой ключ показать (вместе с --user)")
    collect.add_argument("--offset", type=int, default=0)
    for name in ("usage", "ls", "clear"):
        sub.add_parser(name).add_argument("addon")
    for name in ("get", "rm"):
        p = sub.add_parser(name)
        p.add_argument("addon")
        p.add_argument("key")
    put = sub.add_parser("put")
    put.add_argument("addon")
    put.add_argument("key")
    put.add_argument("value", nargs="?", help="JSON-значение")
    put.add_argument("--file", help="записать файл как байты")
    args = parser.parse_args()

    token = os.environ.get("ZALI_TOKEN")
    if not token:
        if not args.user:
            sys.exit("Нужен --user (или ZALI_TOKEN).")
        password = os.environ.get("ZALI_PASSWORD") or getpass.getpass("Пароль: ")
        token = login(args.api, args.user, password)

    base = f"/api/addons/{urllib.parse.quote(args.addon, safe='')}/cloud"
    scope = "shared" if args.shared else "user"
    item = lambda key: f"{base}/item?key={urllib.parse.quote(key, safe='')}&scope={scope}"

    if args.cmd == "collect":
        if args.of_user and args.key:
            path = f"{base}/collect/item?user={urllib.parse.quote(args.of_user, safe='')}&key={urllib.parse.quote(args.key, safe='')}"
            status, body = request(args.api, "GET", path, token)
            if status != 200:
                sys.exit(f"{status}: {body.get('message', body)}")
            if body["kind"] == "json":
                print(json.dumps(body["value"], ensure_ascii=False, indent=2))
            else:
                sys.stdout.buffer.write(base64.b64decode(body["value"]))
            return
        status, body = request(args.api, "GET", f"{base}/collect?offset={args.offset}&limit=200", token)
        if status != 200:
            sys.exit(f"{status}: {body.get('message', body)}")
        print(f"{args.addon}: {body['users']} польз., {body['total']} ключей, {human(body['bytes'])}")
        for it in body["items"]:
            print(f"  {it['user']}  {it['key']}  [{it['kind']}]  {human(it['size'])}")
        return

    if args.cmd in ("usage", "ls"):
        status, body = request(args.api, "GET", f"{base}?scope={scope}", token)
        if status != 200:
            sys.exit(f"{status}: {body.get('message', body)}")
        print(f"{args.addon}: у всех пользователей {human(body['bytes'])} из {human(body['quota'])}; "
              f"моя доля {human(body['mine'])} из {human(body['mineQuota'])}; "
              f"в области «{body['scope']}» ключей {body['keys']}"
              f"{' (вы автор)' if body.get('isOwner') else ''}")
        if args.cmd == "ls":
            for it in body["items"]:
                print(f"  {it['key']}  [{it['kind']}]  {human(it['size'])}")
    elif args.cmd == "get":
        status, body = request(args.api, "GET", item(args.key), token)
        if status != 200:
            sys.exit(f"{status}: {body.get('message', body)}")
        if body["kind"] == "json":
            print(json.dumps(body["value"], ensure_ascii=False, indent=2))
        else:
            sys.stdout.buffer.write(base64.b64decode(body["value"]))
    elif args.cmd == "put":
        if args.file:
            payload = {"kind": "bytes", "value": base64.b64encode(open(args.file, "rb").read()).decode()}
        elif args.value is not None:
            try:
                payload = {"kind": "json", "value": json.loads(args.value)}
            except ValueError:
                sys.exit("Значение — не JSON; для строки возьмите кавычки: '\"текст\"'.")
        else:
            sys.exit("Нужно значение или --file.")
        status, body = request(args.api, "PUT", item(args.key), token, payload)
        if status != 200:
            sys.exit(f"{status}: {body.get('message', body)}")
        print(f"записано, занято {human(body['bytes'])} из {human(body['quota'])}")
    elif args.cmd == "rm":
        status, body = request(args.api, "DELETE", item(args.key), token)
        print("удалено" if status == 200 and body.get("removed") else "такого ключа нет")
    elif args.cmd == "clear":
        status, body = request(args.api, "DELETE", f"{base}?scope={scope}", token)
        if status != 200:
            sys.exit(f"{status}: {body.get('message', body)}")
        print(f"стёрто ключей: {body['removed']}")


if __name__ == "__main__":
    main()
