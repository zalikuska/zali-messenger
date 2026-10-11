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
    python3 scripts/addon_review.py approve ID DIGEST [--note "…"]
    python3 scripts/addon_review.py reject  ID DIGEST --note "что поправить"
    python3 scripts/addon_review.py revoke  ID DIGEST --note "почему"   # отозвать сборку
    python3 scripts/addon_review.py restore ID DIGEST                   # снять отзыв

DIGEST — отпечаток сборки из списка (хватит первых символов, если они однозначны).
Для revoke/restore — полный отпечаток (64 hex): сборка не обязана быть в заявках.
Отозванную сборку приложение не запускает, не даёт ей облака и вкладов в казну;
вернуть свои монеты человек может всегда.
"""
import argparse
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
        print(f"[{r['status']}] {r['addonId']} {r['version']} — @{r['owner']}, подана {when(r['createdAt'])}")
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


def cmd_decide(args, decision):
    digest = resolve_digest(args.id, args.digest)
    res = api('/api/admin/addons/requests/decide', body={
        'addonId': args.id, 'digest': digest, 'decision': decision, 'note': args.note or '',
    })
    print(f"{args.id} {res.get('version', '')} → {res.get('status')} (@{res.get('owner')})")


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
    elif args.command in ('revoke', 'restore'):
        cmd_revoke(args, args.command == 'restore')
    else:
        cmd_decide(args, args.command)


if __name__ == '__main__':
    main()
