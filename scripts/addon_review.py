#!/usr/bin/env python3
"""Заявки на официальную подпись аддонов — очередь и решения для оператора.

Автор подаёт заявку в Хабе → «Подпись аддонов» → «Запросить официальную» на
конкретную сборку (id + версия + отпечаток). Решает оператор вручную; после
«approve» сервер сам выдаёт подпись именно этой сборке (server/src/addons.rs).
Нужен приватный официальный ключ на сервере — иначе список покажет
`signerReady: false`, а выдача вернёт «official_unavailable».

Адрес и токен — из окружения, в репозитории их нет:

    export ZALI_API_URL=https://<api-host>        # по умолчанию http://localhost:3000
    export ZALI_ADMIN_TOKEN=<RELEASE_ADMIN_TOKEN сервера>

    python3 scripts/addon_review.py list                    # ожидающие
    python3 scripts/addon_review.py list --status all
    python3 scripts/addon_review.py inspect ID DIGEST       # манифест, разрешения, файлы заявки
    python3 scripts/addon_review.py fetch ID DIGEST [--out файл.zali]   # скачать файл на проверку
    python3 scripts/addon_review.py approve ID DIGEST [--note "…"]
    python3 scripts/addon_review.py reject  ID DIGEST --note "что поправить"
    python3 scripts/addon_review.py revoke  ID DIGEST --note "почему"   # отозвать сборку
    python3 scripts/addon_review.py restore ID DIGEST                   # снять отзыв

DIGEST — отпечаток сборки из списка (хватит первых символов, если они однозначны).

Заявка с пометкой «в магазин» пришла кнопкой «Отправить на проверку» — к ней приложен
сам файл (inspect/fetch его показывают). `approve` такой заявки одним действием
подписывает сборку официальным ключом и выкладывает её в магазин по цене автора;
`reject` стирает файл. Обычная заявка (только подпись) файла не имеет.
Для revoke/restore — полный отпечаток (64 hex): сборка не обязана быть в заявках.
Отозванную сборку приложение не запускает, не даёт ей облака и вкладов в казну;
вернуть свои монеты человек может всегда.
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime


def api(path, params=None, body=None):
    base = os.environ.get('ZALI_API_URL', 'http://localhost:3000').rstrip('/')
    token = os.environ.get('ZALI_ADMIN_TOKEN', '').strip()
    if not token:
        sys.exit('ZALI_ADMIN_TOKEN не задан (это RELEASE_ADMIN_TOKEN сервера).')
    query = ('?' + urllib.parse.urlencode(params)) if params else ''
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'Authorization': f'Bearer {token}'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(f'{base}{path}{query}', data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        hint = ' — неверный токен или RELEASE_ADMIN_TOKEN на сервере не задан' if e.code == 403 else ''
        sys.exit(f'HTTP {e.code} {path}{hint}')
    except urllib.error.URLError as e:
        sys.exit(f'Сервер недоступен: {e.reason}')


def when(ms):
    return datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M') if ms else '—'


def fetch(status):
    return api('/api/admin/addons/requests', {'status': status})


def cmd_list(args):
    data = fetch(args.status)
    rows = data.get('requests', [])
    if not data.get('signerReady'):
        print('! На сервере нет официального ключа: одобренные заявки выдать нечем.\n')
    if not rows:
        print('Заявок нет.')
        return
    for r in rows:
        store = f" · в магазин, {r['storePrice']} ZC" if r.get('storePrice') is not None else ''
        print(f"[{r['status']}] {r['addonId']} {r['version']} — @{r['owner']}, подана {when(r['createdAt'])}{store}")
        print(f"    digest {r['digest']}")
        if r.get('note'):
            print(f"    «{r['note']}»")
        if r.get('decisionNote'):
            print(f"    решение: {r['decisionNote']} ({when(r['decidedAt'])})")


def resolve_digest(addon_id, prefix):
    rows = [r for r in fetch('all').get('requests', []) if r['addonId'] == addon_id and r['digest'].startswith(prefix)]
    if not rows:
        sys.exit('Такой заявки нет — см. list --status all')
    if len(rows) > 1:
        sys.exit('Начало отпечатка неоднозначно — укажите длиннее')
    return rows[0]['digest']


def request_blob(addon_id, prefix):
    digest = resolve_digest(addon_id, prefix)
    res = api('/api/admin/addons/requests/file', {'addonId': addon_id, 'digest': digest})
    return digest, base64.b64decode(res['fileBase64'])


def cmd_fetch(args):
    digest, blob = request_blob(args.id, args.digest)
    out = args.out or f"{args.id}-{digest[:12]}.zali"
    with open(out, 'wb') as fh:
        fh.write(blob)
    print(f"{out}: {len(blob)} байт")


def cmd_inspect(args):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import addon_pack
    digest, blob = request_blob(args.id, args.digest)
    files = addon_pack.parse(blob)
    manifest = json.loads(files['manifest.json'].decode('utf-8'))
    addon_pack.describe(blob, manifest)
    print(f"  автор в манифесте: {manifest.get('author', '—')}")
    print(f"  описание: {manifest.get('description', '—')}")
    for key in ('network', 'cloud'):
        if manifest.get(key):
            print(f"  {key}: {manifest[key]}")
    print(f"  файлов: {len(files)}")
    for name, data in sorted(files.items()):
        print(f"    {len(data):>9}  {name}")
    print("\nПосмотреть код целиком: fetch, затем распаковать и прочитать index.html и скрипты.")


def cmd_decide(args, decision):
    digest = resolve_digest(args.id, args.digest)
    res = api('/api/admin/addons/requests/decide', body={
        'addonId': args.id, 'digest': digest, 'decision': decision, 'note': args.note or '',
    })
    print(f"{args.id} {res.get('version', '')} → {res.get('status')} (@{res.get('owner')})")
    if res.get('published'):
        print('  подписано официально и выложено в магазин')


def cmd_revoke(args, restore):
    digest = args.digest.strip().lower()
    if len(digest) != 64:
        sys.exit('Нужен полный отпечаток сборки (64 hex).')
    res = api('/api/admin/addons/revoke', body={
        'addonId': args.id, 'digest': digest, 'reason': args.note or '', 'restore': restore,
    })
    print(f"{args.id} {digest[:12]}… → {'отзыв снят' if res.get('restored') else 'отозвана'}")


def main():
    parser = argparse.ArgumentParser(description='Заявки на официальную подпись аддонов.')
    sub = parser.add_subparsers(dest='command', required=True)
    lst = sub.add_parser('list', help='очередь заявок')
    lst.add_argument('--status', default='pending', help='pending (по умолчанию), approved, rejected, all')
    ins = sub.add_parser('inspect', help='манифест, разрешения и файлы заявки «в магазин»')
    ins.add_argument('id')
    ins.add_argument('digest')
    fch = sub.add_parser('fetch', help='скачать файл заявки «в магазин»')
    fch.add_argument('id')
    fch.add_argument('digest')
    fch.add_argument('--out', default='')
    for name in ('approve', 'reject'):
        p = sub.add_parser(name, help='одобрить' if name == 'approve' else 'отклонить')
        p.add_argument('id')
        p.add_argument('digest')
        p.add_argument('--note', default='')
    for name in ('revoke', 'restore'):
        p = sub.add_parser(name, help='отозвать сборку' if name == 'revoke' else 'снять отзыв')
        p.add_argument('id')
        p.add_argument('digest')
        p.add_argument('--note', default='')
    args = parser.parse_args()
    if args.command == 'list':
        cmd_list(args)
    elif args.command == 'inspect':
        cmd_inspect(args)
    elif args.command == 'fetch':
        cmd_fetch(args)
    elif args.command in ('revoke', 'restore'):
        cmd_revoke(args, args.command == 'restore')
    else:
        cmd_decide(args, args.command)


if __name__ == '__main__':
    main()
