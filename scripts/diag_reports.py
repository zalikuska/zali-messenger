#!/usr/bin/env python3
"""Диагностика сервера и отчёты клиентов — чтение для оператора.

Клиенты сами присылают снимки состояния (кнопка «Отправить диагностику» в
Настройках и автоматически при сбое звонка, зависшей отправке, частых обрывах
WS, ошибке JS — web/src/interface/diagnostic_reports.js) и отчёты о неудачной
расшифровке. Сервер хранит их 30 дней и отдаёт за RELEASE_ADMIN_TOKEN
(server/src/diagnostics.rs).

Адрес и токен — из окружения, в репозитории их нет:

    export ZALI_API_URL=https://<api-host>        # по умолчанию http://localhost:3000
    export ZALI_ADMIN_TOKEN=<RELEASE_ADMIN_TOKEN сервера>

    python3 scripts/diag_reports.py metrics              # аптайм, соединения, медленные/ошибочные маршруты
    python3 scripts/diag_reports.py list                 # отчёты за 72 ч
    python3 scripts/diag_reports.py list --kind voice_failed --user alice --hours 24
    python3 scripts/diag_reports.py show ae4c49f9        # отчёт целиком (id или его начало из list)
    python3 scripts/diag_reports.py show ID --raw        # тело как JSON

Виды: manual, voice_failed, delivery_failed, ws_unstable, js_error, decrypt, other.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def api(path, params=None):
    base = os.environ.get('ZALI_API_URL', 'http://localhost:3000').rstrip('/')
    token = os.environ.get('ZALI_ADMIN_TOKEN', '').strip()
    if not token:
        sys.exit('ZALI_ADMIN_TOKEN не задан (это RELEASE_ADMIN_TOKEN сервера).')
    query = ('?' + urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v not in (None, '')})) if params else ''
    req = urllib.request.Request(f'{base}{path}{query}', headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        hint = ' — неверный токен или RELEASE_ADMIN_TOKEN на сервере не задан' if e.code == 403 else ''
        sys.exit(f'HTTP {e.code} {path}{hint}')
    except urllib.error.URLError as e:
        sys.exit(f'Сервер недоступен: {e.reason}')


def fmt_bytes(n):
    for unit in ('Б', 'КБ', 'МБ', 'ГБ'):
        if n < 1024:
            return f'{n:.0f} {unit}'
        n /= 1024
    return f'{n:.1f} ТБ'


def cmd_metrics(_args):
    m = api('/api/diagnostics/metrics')
    up = m['uptimeSecs']
    print(f"Сервер {m['version']}, аптайм {up // 86400}д {up % 86400 // 3600}ч {up % 3600 // 60}м")
    print(f"WS-соединений {m['wsConnections']}, пользователей онлайн {m['onlineUsers']}, голосовых комнат {m['voiceRooms']}, БД {fmt_bytes(m['dbBytes'])}")
    r = m['requests']
    print(f"Запросов {r['count']}, в среднем {r['avgMs']} мс, максимум {r['maxMs']} мс, "
          f"медленных (≥{r['slowThresholdMs']} мс) {r['slow']}, 5xx {r['errors5xx']}, 4xx {r['errors4xx']}")
    if m['reportsLast24h']:
        print('Отчёты за сутки: ' + ', '.join(f"{x['kind']}={x['count']}" for x in m['reportsLast24h']))
    for title, key in (('Маршруты по суммарному времени', 'routesByTime'),
                       ('Маршруты с ошибками 5xx', 'routesBy5xx'),
                       ('Маршруты с медленными запросами', 'routesBySlow')):
        rows = m.get(key) or []
        if not rows:
            continue
        print(f'\n{title}:')
        for row in rows:
            print(f"  {row['route']:<52} n={row['count']:<7} avg={row['avgMs']}мс max={row['maxMs']}мс "
                  f"slow={row['slow']} 5xx={row['errors5xx']} 4xx={row['errors4xx']}")


def cmd_list(args):
    data = api('/api/diagnostics/reports', {
        'kind': args.kind, 'user': args.user, 'hours': args.hours, 'limit': args.limit,
    })
    print(f"Отчётов за {data['hours']} ч: {data['count']}")
    for it in data['items']:
        detail = f" {it['detail']}" if it.get('detail') else ''
        print(f"{it['createdAt']}  {it['id'][:8]}  {it['kind']:<16} {it['user']:<16} "
              f"{it['platform'] or '-':<14} {it['appVersion'] or '-':<8} {fmt_bytes(it['bytes'])}{detail}")


def resolve_id(prefix):
    if len(prefix) >= 32:
        return prefix
    data = api('/api/diagnostics/reports', {'hours': 24 * 30, 'limit': 1000})
    matches = [it['id'] for it in data['items'] if it['id'].startswith(prefix)]
    if not matches:
        sys.exit(f'Нет отчёта с id {prefix}…')
    if len(matches) > 1:
        sys.exit(f'Неоднозначно: {", ".join(m[:12] for m in matches)}')
    return matches[0]


def cmd_show(args):
    rep = api(f'/api/diagnostics/reports/{urllib.parse.quote(resolve_id(args.id))}')
    if args.raw:
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        return
    p = rep['payload'] if isinstance(rep['payload'], dict) else {}
    print(f"{rep['kind']} от {rep['user']} — {rep['createdAt']} ({rep['platform'] or p.get('platform', '-')}, {rep['appVersion'] or '-'})")
    lists = {k: v for k, v in p.items() if isinstance(v, list)}
    scalars = {k: v for k, v in p.items() if not isinstance(v, list)}
    print(json.dumps(scalars, ensure_ascii=False, indent=2))
    for name, lines in lists.items():
        print(f'\n── {name} ({len(lines)}) ──')
        for line in lines:
            print(line if isinstance(line, str) else json.dumps(line, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('metrics').set_defaults(fn=cmd_metrics)
    p_list = sub.add_parser('list')
    p_list.add_argument('--kind')
    p_list.add_argument('--user')
    p_list.add_argument('--hours', type=int, default=72)
    p_list.add_argument('--limit', type=int, default=100)
    p_list.set_defaults(fn=cmd_list)
    p_show = sub.add_parser('show')
    p_show.add_argument('id')
    p_show.add_argument('--raw', action='store_true')
    p_show.set_defaults(fn=cmd_show)
    args = parser.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
