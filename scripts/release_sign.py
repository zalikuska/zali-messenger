#!/usr/bin/env python3
"""Подпись релиза приложения офлайн-ключом разработчиков и (по желанию) публикация.

    python3 scripts/release_sign.py --platform windows --version 0.2b51 \
        --file dist/ZaliMessenger.exe --url https://msgs.zalikus.org/releases/ZaliMessenger-0.2b51.exe \
        [--notes "…"] [--mandatory] [--key ops/keys/addon-official-private.pem] [--publish]

Зачем: `/api/version` отдаёт ссылку и SHA-256 одним ответом, поэтому без подписи
скомпрометированный сервер раздал бы клиентам любой бинарник. Клиент
(web/src/interface/updates.js) скачивает обновление только при действующей
подписи официального ключа над платформой, версией, SHA-256 и ссылкой — те же
ключ и инструменты, что у официальных аддонов (docs/ADDONS.md §10), но сообщение
своё: `zali-release-sig:v1`, подписи аддонов и релизов не взаимозаменяемы.

Приватный ключ лежит вне репозитория (`ops/keys/`, в .gitignore). Без
`--publish` печатается тело запроса для `POST /api/version`; с `--publish` оно
отправляется на `ZALI_API_URL` с токеном `ZALI_ADMIN_TOKEN` (RELEASE_ADMIN_TOKEN
сервера). Формат сообщения держат вместе: этот файл, server/src/updates.rs и
web/src/interface/updates.js.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import addon_sign  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KEY = ROOT / "ops" / "keys" / "addon-official-private.pem"
PLATFORMS = ("macos", "windows")


def release_message(platform, version, sha256, url):
    return f"zali-release-sig:v1\n{platform}\n{version}\n{sha256}\n{url}"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Подпись релиза ZaliMessenger.")
    parser.add_argument("--platform", required=True, choices=PLATFORMS)
    parser.add_argument("--version", required=True)
    parser.add_argument("--url", required=True, help="ссылка на артефакт (как её увидит клиент)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--file", help="артефакт: SHA-256 считается с него")
    group.add_argument("--sha256", help="готовый SHA-256 (64 hex)")
    parser.add_argument("--notes", default="")
    parser.add_argument("--mandatory", action="store_true")
    parser.add_argument("--key", default=str(DEFAULT_KEY), help="приватный ключ разработчиков (PEM)")
    parser.add_argument("--publish", action="store_true", help="отправить на ZALI_API_URL")
    args = parser.parse_args()

    sha256 = (sha256_file(args.file) if args.file else args.sha256).strip().lower()
    if len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256):
        print("Ошибка: SHA-256 — 64 hex-символа.", file=sys.stderr)
        return 1
    if not args.url.startswith("https://"):
        print("Ошибка: ссылка на артефакт должна быть https://.", file=sys.stderr)
        return 1
    try:
        pem = Path(args.key).read_bytes()
    except OSError as e:
        print(f"Ошибка: не прочитан ключ {args.key}: {e}", file=sys.stderr)
        return 1
    if addon_sign.public_key_b64(pem) != addon_sign.OFFICIAL_PUBLIC_KEY:
        print("Ошибка: ключ не совпадает с официальным публичным ключом в приложении.", file=sys.stderr)
        return 1

    message = release_message(args.platform, args.version, sha256, args.url)
    signature = base64.b64encode(addon_sign.sign_message(pem, message)).decode()
    if not addon_sign.verify_message(addon_sign.OFFICIAL_PUBLIC_KEY, message, signature):
        print("Ошибка: подпись не прошла самопроверку.", file=sys.stderr)
        return 1
    body = {
        "platform": args.platform,
        "version": args.version,
        "notes": args.notes,
        "downloadUrl": args.url,
        "sha256": sha256,
        "mandatory": bool(args.mandatory),
        "signature": signature,
    }
    if not args.publish:
        print(json.dumps(body, ensure_ascii=False, indent=2))
        return 0

    api = os.environ.get("ZALI_API_URL", "").rstrip("/")
    token = os.environ.get("ZALI_ADMIN_TOKEN", "").strip()
    if not api or not token:
        print("Ошибка: для --publish задайте ZALI_API_URL и ZALI_ADMIN_TOKEN.", file=sys.stderr)
        return 1
    request = urllib.request.Request(
        f"{api}/api/version",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(f"Опубликовано: {args.platform} {args.version} (HTTP {response.status})")
    except urllib.error.HTTPError as e:
        print(f"Ошибка публикации: HTTP {e.code} {e.read().decode(errors='replace')}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"Ошибка публикации: {e.reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
