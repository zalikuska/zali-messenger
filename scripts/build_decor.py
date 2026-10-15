#!/usr/bin/env python3
"""Иллюстрации экранов («декор»): крупные линейные рисунки в свободных
местах интерфейса, каждый — сюжет о том, что на этом экране происходит:
монетка летит от человека в копилку (ZaliCoin), модули запускают ракету к
планете (хаб), сообщение самолётиком через замок долетает до собеседника
(пустая переписка) и т. д.

Единственный источник рисунков. Иконки — в одном линейном стиле (контур,
скруглённые концы); иллюстрации собираются из них и из своих фигур (люди,
окна, пунктирные траектории). Каждая — одноцветный SVG; скрипт вписывает
его data-URI как custom property в блок web/style.css между маркерами
`@generated decor:start/end`. Как переменные используются — в
web/style.css сразу под блоком.

    python3 scripts/build_decor.py              # обновить блок в style.css
    python3 scripts/build_decor.py --preview F  # HTML-превью иллюстраций в файл F

После правки — `python3 scripts/bundle_web.py`, как после любой правки style.css.
"""
import argparse
import math
import os
import re
import sys
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STYLE = os.path.join(ROOT, 'web', 'style.css')
START = '/* @generated decor:start — scripts/build_decor.py, руками не править */'
END = '/* @generated decor:end */'


def gear(teeth=8, r_out=22, r_in=17, hole=7):
    """Шестерёнка: зубья — трапеции по окружности, в центре отверстие."""
    pts = []
    step = 2 * math.pi / teeth
    for i in range(teeth):
        a = i * step
        for da, r in ((-0.30, r_in), (-0.17, r_out), (0.17, r_out), (0.30, r_in)):
            ang = a + da * step * 1.6
            pts.append((32 + r * math.cos(ang), 32 + r * math.sin(ang)))
    d = 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in pts) + 'Z'
    return f'<path d="{d}"/><circle cx="32" cy="32" r="{hole}"/>'


def star5(r_out=20, r_in=8.5):
    pts = []
    for i in range(10):
        r = r_out if i % 2 == 0 else r_in
        ang = -math.pi / 2 + i * math.pi / 5
        pts.append((32 + r * math.cos(ang), 33 + r * math.sin(ang)))
    return '<path d="M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in pts) + 'Z"/>'


# Иконки в квадрате 64×64, центр (32, 32). Контур — по умолчанию (stroke),
# сплошные детали (глаза, искры, точки) — class="f".
ICONS = {
    # ── ZaliCoin ──────────────────────────────────────────────────────────
    'coin': (
        '<circle cx="32" cy="32" r="22"/><circle cx="32" cy="32" r="16.5"/>'
        '<path d="M25.5 24.5h13l-13 15h13"/>'
    ),
    'coin3d': (
        '<ellipse cx="32" cy="25" rx="22" ry="10"/>'
        '<path d="M10 25v9c0 5.5 9.85 10 22 10s22-4.5 22-10v-9"/>'
        '<path d="M26.5 21.5h11l-11 7h11"/>'
    ),
    'stack': (
        '<ellipse cx="32" cy="18" rx="19" ry="7"/>'
        '<path d="M13 18v6c0 3.9 8.5 7 19 7s19-3.1 19-7v-6"/>'
        '<path d="M13 24v7c0 3.9 8.5 7 19 7s19-3.1 19-7v-7"/>'
        '<path d="M13 31v7c0 3.9 8.5 7 19 7s19-3.1 19-7v-7"/>'
        '<path d="M13 38v7c0 3.9 8.5 7 19 7s19-3.1 19-7v-7"/>'
    ),
    'piggy': (
        # тело со «пятачком» справа и ножками
        '<path d="M12 34c0-9.6 9.4-16.5 21.5-16.5 7.5 0 13.5 2.6 16.9 7l5.1-1.2'
        'c1.4-.3 2.7.7 2.7 2.1v7.4c0 1.2-1 2.2-2.2 2.2h-4.2c-1.6 3.4-4.3 6.1-7.8 7.9'
        'l.9 5.6c.2 1.2-.7 2.3-1.9 2.3h-4.2c-.9 0-1.7-.6-1.9-1.5l-.7-3.5'
        'c-1.6.3-3.3.4-5 .4s-3.4-.1-5-.4l-.7 3.5c-.2.9-1 1.5-1.9 1.5h-4.2'
        'c-1.2 0-2.1-1.1-1.9-2.3l1-5.9C14.6 44.4 12 39.6 12 34z"/>'
        '<path d="M42.5 19.2l1.6-6.3c.2-.9 1.3-1.2 2-.6l4.6 4.9"/>'  # ухо
        '<path d="M27 22.5h9"/>'  # щель для монет
        '<path d="M12.6 31.6c-3.3.3-5.4-1.6-4.9-3.7.4-1.6 2.4-2.1 3.4-.9"/>'  # хвостик
        '<path d="M53.2 26.6v4.2"/>'  # линия пятачка
        '<circle class="f" cx="46.6" cy="27.2" r="1.7"/>'  # глаз
    ),
    'wallet': (
        '<path d="M11 21.5h37a5 5 0 0 1 5 5v19a5 5 0 0 1-5 5H16a5 5 0 0 1-5-5z"/>'
        '<path d="M11 21.5l27.2-8.4c2.1-.6 4.3.9 4.3 3.1v5.3"/>'
        '<path d="M53 30.5H42.5a5 5 0 0 0 0 10H53"/>'
        '<circle class="f" cx="43.5" cy="35.5" r="1.9"/>'
    ),
    'gift': (
        '<rect x="13" y="28" width="38" height="24" rx="2.5"/>'
        '<rect x="9.5" y="20" width="45" height="8" rx="2"/>'
        '<path d="M32 20v32"/>'
        '<path d="M32 20c-2.3-6.4-11.6-9.6-12.4-4.2-.5 3.4 4.2 4.2 12.4 4.2z'
        'M32 20c2.3-6.4 11.6-9.6 12.4-4.2.5 3.4-4.2 4.2-12.4 4.2z"/>'
    ),
    'transfer': (
        '<path d="M13 25h36M42 17.5l7.5 7.5-7.5 7.5"/>'
        '<path d="M51 40H15M22 32.5L14.5 40l7.5 7.5"/>'
    ),
    'chest': (
        '<path d="M11 30h42v19a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3z"/>'
        '<path d="M11 30v-6c0-6.6 5.4-12 12-12h18c6.6 0 12 5.4 12 12v6"/>'
        '<path d="M11 30h42M22 12.6V30M42 12.6V30"/>'
        '<rect x="27.5" y="26" width="9" height="10" rx="2"/>'
    ),
    # ── Хаб ───────────────────────────────────────────────────────────────
    'bell': (
        '<path d="M32 11.5a3.6 3.6 0 0 1 3.6 3.6v1.6c6.2 1.6 10.6 7.2 10.6 13.8v8.3'
        'l4.3 6.2h-37l4.3-6.2v-8.3c0-6.6 4.4-12.2 10.6-13.8v-1.6a3.6 3.6 0 0 1 3.6-3.6z"/>'
        '<path d="M26.8 49.8a5.2 5.2 0 0 0 10.4 0"/>'
    ),
    'rocket': (
        '<path d="M32 7.5c8.4 6 12.6 15 12.6 25.3L40.4 45H23.6l-4.2-12.2C19.4 22.5 23.6 13.5 32 7.5z"/>'
        '<circle cx="32" cy="25" r="5"/>'
        '<path d="M19.8 33.5l-6.5 8.8 8.2 2M44.2 33.5l6.5 8.8-8.2 2"/>'
        '<path d="M27.5 49.5c0 4.8 4.5 8 4.5 8s4.5-3.2 4.5-8"/>'
    ),
    'puzzle': (
        '<path d="M14 20h9.5a4.5 4.5 0 1 1 9 0H42v9.5a4.5 4.5 0 1 1 0 9V48H32.5'
        'a4.5 4.5 0 1 0-9 0H14v-9.5a4.5 4.5 0 1 0 0-9z"/>'
    ),
    'megaphone': (
        '<path d="M12 27.5v10h6.5L40 47.5v-30l-21.5 10z"/>'
        '<path d="M18.5 37.5l3.2 10.5h5.6l-2.6-8.6"/>'
        '<path d="M46 27c2 2.2 2 8.8 0 11M50.5 22.5c4.4 4.6 4.4 15.4 0 20"/>'
    ),
    'box': (
        '<path d="M32 9.5l21 10.2v24.6L32 54.5 11 44.3V19.7z"/>'
        '<path d="M11 19.7l21 10.2 21-10.2M32 29.9v24.6M21.5 14.6l21 10.2"/>'
    ),
    'planet': (
        '<circle cx="32" cy="32" r="12.5"/>'
        '<path d="M43.3 26.2c7.4-3.2 12.6-3.8 13.5-1.9 1.4 3-9.2 10.2-23.7 16.1'
        'S9.7 49.6 8.3 46.6c-.9-1.9 2.8-5.6 9.5-9.8"/>'
    ),
    'star': star5(),
    # ── Настройки ─────────────────────────────────────────────────────────
    'gear': gear(),
    'gear6': gear(teeth=6, r_out=22, r_in=16.5, hole=6.5),
    'sliders': (
        '<path d="M18 11v42M32 11v42M46 11v42"/>'
        '<rect x="13" y="17" width="10" height="7" rx="3.5"/>'
        '<rect x="27" y="36" width="10" height="7" rx="3.5"/>'
        '<rect x="41" y="25" width="10" height="7" rx="3.5"/>'
    ),
    'toggle': (
        '<rect x="8" y="22" width="48" height="20" rx="10"/>'
        '<circle class="f" cx="46" cy="32" r="6"/>'
    ),
    'palette': (
        '<path d="M32 10.5c-12.4 0-22 9.1-22 20.9C10 43 18.4 53 29 53'
        'c2.7 0 4-1.7 4-3.7 0-2.6-2.1-3.4-2.1-5.7 0-2.6 2.1-4.2 4.7-4.2H41'
        'c7.1 0 12-4.4 12-10.6 0-10.6-9.4-18.3-21-18.3z"/>'
        '<circle class="f" cx="21.5" cy="31" r="2.8"/><circle class="f" cx="26" cy="21.5" r="2.8"/>'
        '<circle class="f" cx="36.5" cy="19.5" r="2.8"/><circle class="f" cx="44.5" cy="26.5" r="2.8"/>'
    ),
    'key': (
        '<circle cx="19.5" cy="32" r="9.5"/><circle cx="19.5" cy="32" r="3"/>'
        '<path d="M29 32h25M47.5 32v7M54 32v5"/>'
    ),
    'shield': (
        '<path d="M32 9.5l19 6.5v14.2c0 12.1-8.1 20.3-19 24.3-10.9-4-19-12.2-19-24.3V16z"/>'
        '<path d="M23.5 31.5l6 6 11.5-12"/>'
    ),
    # ── Чат и вход ────────────────────────────────────────────────────────
    'bubble': (
        '<path d="M14 14h36a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H28l-10.5 8.5V44H14'
        'a5 5 0 0 1-5-5V19a5 5 0 0 1 5-5z"/>'
        '<circle class="f" cx="22.5" cy="29" r="2.6"/><circle class="f" cx="32" cy="29" r="2.6"/>'
        '<circle class="f" cx="41.5" cy="29" r="2.6"/>'
    ),
    'bubble2': (
        '<path d="M32 12c12.2 0 22 8.3 22 18.5S44.2 49 32 49c-2.7 0-5.3-.4-7.7-1.2'
        'L13 53l3.3-9.6C12.4 40.2 10 35.6 10 30.5 10 20.3 19.8 12 32 12z"/>'
    ),
    'plane': (
        '<path d="M8.5 30.5L55 11.5 45 52 31.5 41l-7.5 9V37z"/>'
        '<path d="M24 37l31-25.5M31.5 41l-7.5-4"/>'
    ),
    'heart': (
        '<path d="M32 51S11.5 39.2 11.5 24.8c0-6.9 5.1-11.3 10.6-11.3 4.4 0 7.9 2.4 9.9 6.2'
        ' 2-3.8 5.5-6.2 9.9-6.2 5.5 0 10.6 4.4 10.6 11.3C52.5 39.2 32 51 32 51z"/>'
    ),
    'lock': (
        '<rect x="14" y="28" width="36" height="25" rx="5"/>'
        '<path d="M21 28v-6.5a11 11 0 0 1 22 0V28"/>'
        '<circle cx="32" cy="39" r="3.2"/><path d="M32 42.2v4.3"/>'
    ),
    'smile': (
        '<circle cx="32" cy="32" r="21"/>'
        '<circle class="f" cx="25" cy="27.5" r="2.4"/><circle class="f" cx="39" cy="27.5" r="2.4"/>'
        '<path d="M23.5 37c4.2 5.6 12.8 5.6 17 0"/>'
    ),
    # ── Люди и окна (для сюжетов) ─────────────────────────────────────────
    'person': '<circle cx="32" cy="21" r="10"/><path d="M13 53c0-10.6 8.5-18 19-18s19 7.4 19 18"/>',
    'person-plus': (
        '<circle cx="28" cy="21" r="10"/><path d="M9 53c0-10.6 8.5-18 19-18s19 7.4 19 18"/>'
        '<path d="M50 13v12M44 19h12"/>'
    ),
    'search': '<circle cx="27" cy="27" r="14"/><path d="M37.5 37.5L52 52"/><path d="M20 22a8 8 0 0 1 6-5" opacity=".6"/>',
    'phone': (
        '<rect x="18" y="6" width="28" height="52" rx="6"/><path d="M28 11.5h8"/>'
        '<circle cx="32" cy="31" r="7"/><path d="M29 28.5h6l-6 5h6"/>'
        '<path d="M24 46h16" opacity=".6"/>'
    ),
    'card': (
        '<rect x="6" y="14" width="52" height="36" rx="6"/><circle cx="20" cy="28" r="5.5"/>'
        '<path d="M11.5 42c1.4-3.8 4.6-5.8 8.5-5.8s7.1 2 8.5 5.8M35 27h15M35 34h10"/>'
    ),
    'badge-plus': '<circle cx="32" cy="32" r="16"/><path d="M32 24.5v15M24.5 32h15"/>',
    'window': (
        '<rect x="6" y="12" width="52" height="40" rx="5"/><path d="M6 20h52"/>'
        '<circle class="f" cx="11" cy="16" r="1.3"/><circle class="f" cx="15.5" cy="16" r="1.3"/>'
        '<circle class="f" cx="20" cy="16" r="1.3"/>'
        '<path d="M13 28h24M13 34h32M13 40h18" opacity=".7"/>'
        '<rect x="36" y="39" width="15" height="7" rx="3.5" opacity=".7"/>'
    ),
    # ── Мелочь для «воздуха» ──────────────────────────────────────────────
    'sparkle': (
        '<path class="f" d="M32 12c1.6 10.4 4.7 13.5 15 15-10.3 1.5-13.4 4.6-15 15'
        '-1.6-10.4-4.7-13.5-15-15 10.3-1.5 13.4-4.6 15-15z"/>'
    ),
    'dot': '<circle class="f" cx="32" cy="32" r="5"/>',
    'ring': '<circle cx="32" cy="32" r="7"/>',
    'plus': '<path d="M32 22v20M22 32h20"/>',
}


# Силуэты (заливка) иконок в квадрате 64×64: по ним передний предмет
# закрывает линии позади себя и получает тональную заливку тела. У кого
# силуэта нет — мелочь и «прозрачные» предметы (ползунки), они не закрывают.
PIGGY_BODY = ICONS['piggy'].split('"')[1]
SIL = {
    'coin': '<circle cx="32" cy="32" r="22"/>',
    'coin3d': '<path d="M10 25c0-5.5 9.85-10 22-10s22 4.5 22 10v9c0 5.5-9.85 10-22 10S10 39.5 10 34z"/>',
    'stack': '<path d="M13 18c0-3.9 8.5-7 19-7s19 3.1 19 7v27c0 3.9-8.5 7-19 7s-19-3.1-19-7z"/>',
    'piggy': f'<path d="{PIGGY_BODY}"/><path d="M42.5 19.2l1.6-6.3c.2-.9 1.3-1.2 2-.6l4.6 4.9z"/>',
    'person': '<circle cx="32" cy="21" r="10"/><path d="M13 53c0-10.6 8.5-18 19-18s19 7.4 19 18z"/>',
    'phone': '<rect x="18" y="6" width="28" height="52" rx="6"/>',
    'card': '<rect x="6" y="14" width="52" height="36" rx="6"/>',
    'badge-plus': '<circle cx="32" cy="32" r="16"/>',
    'window': '<rect x="6" y="12" width="52" height="40" rx="5"/>',
    'bubble': '<path d="M14 14h36a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H28l-10.5 8.5V44H14a5 5 0 0 1-5-5V19a5 5 0 0 1 5-5z"/>',
    'bubble2': '<path d="M32 12c12.2 0 22 8.3 22 18.5S44.2 49 32 49c-2.7 0-5.3-.4-7.7-1.2L13 53l3.3-9.6C12.4 40.2 10 35.6 10 30.5 10 20.3 19.8 12 32 12z"/>',
    'plane': '<path d="M8.5 30.5L55 11.5 45 52 31.5 41l-7.5 9V37z"/>',
    'lock': '<rect x="14" y="28" width="36" height="25" rx="5"/>',
    'gear': gear().split('<circle')[0].replace('<path', '<path fill-rule="evenodd"'),
    'gear6': gear(teeth=6, r_out=22, r_in=16.5, hole=6.5).split('<circle')[0],
    'rocket': '<path d="M32 7.5c8.4 6 12.6 15 12.6 25.3L40.4 45H23.6l-4.2-12.2C19.4 22.5 23.6 13.5 32 7.5z"/>',
    'planet': '<circle cx="32" cy="32" r="12.5"/>',
    'box': '<path d="M32 9.5l21 10.2v24.6L32 54.5 11 44.3V19.7z"/>',
    'bell': '<path d="M32 11.5a3.6 3.6 0 0 1 3.6 3.6v1.6c6.2 1.6 10.6 7.2 10.6 13.8v8.3l4.3 6.2h-37l4.3-6.2v-8.3c0-6.6 4.4-12.2 10.6-13.8v-1.6a3.6 3.6 0 0 1 3.6-3.6z"/>',
    'shield': '<path d="M32 9.5l19 6.5v14.2c0 12.1-8.1 20.3-19 24.3-10.9-4-19-12.2-19-24.3V16z"/>',
    'palette': ICONS['palette'].split('/>')[0] + '/>',
    'search': '<circle cx="27" cy="27" r="14"/>',
    'heart': '<path d="M32 51S11.5 39.2 11.5 24.8c0-6.9 5.1-11.3 10.6-11.3 4.4 0 7.9 2.4 9.9 6.2 2-3.8 5.5-6.2 9.9-6.2 5.5 0 10.6 4.4 10.6 11.3C52.5 39.2 32 51 32 51z"/>',
    'star': star5(),
    'puzzle': ICONS['puzzle'],
    'toggle': '<rect x="8" y="22" width="48" height="20" rx="10"/>',
}


def tf(x, y, scale, rot):
    return f'translate({x} {y}) rotate({rot}) scale({scale}) translate(-32 -32)'


def item(name, x, y, s=1.0, r=0, tone=None, op=1.0, occlude=True):
    """Предмет сюжета: иконка, тональная заливка тела (tone — её
    непрозрачность) и силуэт, закрывающий всё, что нарисовано раньше."""
    return {'kind': 'icon', 'name': name, 'x': x, 'y': y, 's': s, 'r': r,
            'tone': tone, 'op': op, 'occlude': occlude and name in SIL}


def raw(svg, occlude_svg=None):
    """Свой фрагмент (траектория, штрихи); occlude_svg — его силуэт, если есть."""
    return {'kind': 'raw', 'svg': svg, 'occlude_svg': occlude_svg}


def blob(cx, cy, rx, ry, seed, alpha=.3, wobble=.16, points=9):
    """Мягкая органичная подложка под сюжетом: эллипс с «дыханием» радиуса,
    сглаженный кривыми Catmull-Rom → Безье. Детерминирован по seed."""
    pts = []
    for i in range(points):
        a = 2 * math.pi * i / points + seed * .37
        k = 1 + wobble * math.sin(seed * 1.7 + i * 2.39) * math.cos(seed + i * 1.13)
        pts.append((cx + rx * k * math.cos(a), cy + ry * k * math.sin(a)))
    d = f'M{pts[0][0]:.1f} {pts[0][1]:.1f}'
    n = len(pts)
    for i in range(n):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f'C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}'
    return raw(f'<path d="{d}Z" fill="#000" fill-opacity="{alpha}" stroke="none"/>')


def dashed(d, opacity=.8, dash='0.1 7', arrow=None):
    """Траектория: пунктир из круглых точек; arrow=(x, y, angle°) — наконечник."""
    out = f'<path d="{d}" stroke-dasharray="{dash}" opacity="{opacity:g}"/>'
    if arrow:
        x, y, ang = arrow
        out += (f'<path d="M-6 -5L0 0L-6 5" transform="translate({x} {y}) rotate({ang})" '
                f'opacity="{opacity:g}"/>')
    return raw(out)


def motion(x, y, length=14, angle=180, count=3, gap=6, opacity=.6):
    """Штрихи движения позади летящего предмета (angle — куда смотрят)."""
    out = []
    rad = math.radians(angle)
    nx, ny = -math.sin(rad), math.cos(rad)
    for i in range(count):
        off = (i - (count - 1) / 2) * gap
        sx, sy = x + nx * off, y + ny * off
        ln = length * (1 - abs(i - (count - 1) / 2) * .35)
        ex, ey = sx + math.cos(rad) * ln, sy + math.sin(rad) * ln
        out.append(f'M{sx:.1f} {sy:.1f}L{ex:.1f} {ey:.1f}')
    return raw(f'<path d="{" ".join(out)}" opacity="{opacity:g}"/>')


def bits(*specs):
    """Мелочь «для воздуха»: (иконка, x, y, масштаб[, прозрачность])."""
    return [item(n, x, y, s, 0, None, op[0] if op else .8, occlude=False) for n, x, y, s, *op in specs]


# Иллюстрации: имя → (ширина, высота, предметы от дальнего к ближнему).
# Композиция — не цепочкой слева направо, а вокруг главного предмета:
# спутники разного масштаба и глубины, закрученные траектории, подложка.
ILLUSTRATIONS = {
    # ZaliCoin: монеты по спирали с телефона летят в копилку.
    'zalicoin': (400, 260, [
        blob(214, 146, 160, 92, 3),
        raw('<circle cx="318" cy="62" r="40" fill="#000" fill-opacity=".18" stroke="none"/>'),
        dashed('M84 70C120 6 236 -4 292 40C334 74 304 120 252 120', arrow=(252, 120, 172)),
        item('phone', 64, 100, 1.3, -14, tone=.22),
        item('coin3d', 176, 44, .78, -24, tone=.24),
        motion(152, 56, 15, 160, opacity=.5),
        item('stack', 150, 196, 1.05, -6, tone=.2),
        item('piggy', 236, 162, 2.45, -7, tone=.14),
        item('coin3d', 231, 124, .4, 83, tone=.3),
        item('coin', 310, 64, 1.18, 16, tone=.24),
        motion(280, 44, 16, 205, opacity=.5),
        item('coin', 340, 198, .62, -22, tone=.24),
        *bits(('sparkle', 40, 34, .42), ('sparkle', 376, 112, .34, .7), ('sparkle', 200, 236, .3, .7),
              ('dot', 262, 18, .32, .6), ('dot', 22, 160, .3, .6), ('ring', 104, 150, .48, .55),
              ('plus', 372, 240, .42, .5)),
    ]),
    # Хаб: ракета уходит по орбите вокруг планеты, модули всплывают снизу.
    'hub': (400, 260, [
        blob(200, 150, 158, 94, 7),
        item('planet', 300, 80, 1.95, -18, tone=.16),
        raw('<ellipse cx="206" cy="146" rx="158" ry="54" transform="rotate(-20 206 146)" '
            'stroke-dasharray="0.1 7" opacity=".7"/>'),
        raw('<circle cx="120" cy="180" r="9" opacity=".45"/><circle cx="104" cy="166" r="6" opacity=".4"/>'
            '<circle cx="136" cy="190" r="5" opacity=".35"/>'),
        item('rocket', 176, 120, 1.75, 50, tone=.2),
        item('puzzle', 52, 122, .8, -22, tone=.2),
        item('box', 84, 196, 1.1, -10, tone=.18),
        item('box', 130, 222, .7, 12, tone=.2),
        item('bell', 334, 198, .86, 16, tone=.18),
        item('star', 250, 220, .6, 12, tone=.22),
        *bits(('sparkle', 232, 24, .44), ('sparkle', 380, 140, .32, .7), ('sparkle', 22, 62, .3, .7),
              ('dot', 160, 30, .3, .6), ('ring', 376, 30, .46, .55), ('plus', 22, 210, .42, .5)),
    ]),
    # Маленькие картинки кнопок хаба (160×100): по одному предмету на раздел —
    # две шестерёнки, коробка, кошелёк; тот же карандаш, что у больших сцен, но без
    # подложки-пятна — только предмет.
    'hub-settings': (160, 100, [
        item('gear', 60, 50, 1.22, 8, tone=.14),
        item('gear6', 108, 66, .78, -8, tone=.18),
        *bits(('sparkle', 140, 20, .26, .7)),
    ]),
    'hub-addons': (160, 100, [
        item('box', 80, 50, 1.5, 6, tone=.16),
        *bits(('sparkle', 134, 18, .26, .7)),
    ]),
    'hub-coins': (160, 100, [
        item('wallet', 80, 52, 1.4, -6, tone=.16),
        *bits(('sparkle', 134, 20, .26, .7)),
    ]),
    # Пустая переписка: два облачка, самолётик делает петлю, замок — шифрование.
    'chat': (360, 210, [
        blob(184, 112, 140, 82, 11),
        dashed('M152 30C176 -2 222 0 224 26C226 50 192 52 196 30C200 8 252 4 290 44',
               arrow=(290, 44, 48)),
        item('person', 48, 66, .78, -6, tone=.18),
        item('bubble', 132, 98, 1.9, -8, tone=.16),
        item('bubble2', 244, 124, 1.6, 8, tone=.22),
        item('heart', 244, 122, .5, 0, tone=.3),
        item('lock', 86, 150, .64, -10, tone=.24),
        item('plane', 306, 58, .92, -18, tone=.22),
        item('person', 322, 176, .7, 6, tone=.18),
        *bits(('sparkle', 30, 150, .4), ('sparkle', 186, 196, .3, .7), ('dot', 344, 110, .3, .6),
              ('ring', 76, 22, .42, .55)),
    ]),
    # Пустой список: карточка контакта, лупа поиска поверх, «+» и облачко.
    'contacts': (260, 150, [
        blob(130, 80, 104, 56, 5),
        item('card', 118, 84, 1.65, -6, tone=.14),
        item('badge-plus', 66, 38, .9, 0, tone=.24),
        item('search', 196, 54, 1.05, 8, tone=.16),
        item('bubble', 210, 120, .7, 8, tone=.2),
        *bits(('sparkle', 26, 110, .34), ('dot', 150, 18, .28, .6), ('sparkle', 244, 28, .28, .7)),
    ]),
    # Настройки: окно поверх большой шестерёнки, ползунки и палитра вокруг.
    'settings': (360, 260, [
        blob(184, 140, 150, 98, 13),
        item('gear', 262, 86, 2.2, 12, tone=.14),
        item('window', 150, 140, 2.5, -6, tone=.14),
        item('gear6', 318, 156, 1.0, -10, tone=.18),
        item('sliders', 296, 214, .95, 8, occlude=False),
        item('palette', 66, 202, 1.1, -14, tone=.2),
        item('toggle', 66, 72, .9, -10, tone=.2),
        *bits(('sparkle', 34, 128, .38), ('sparkle', 200, 22, .32, .7), ('dot', 340, 32, .3, .6),
              ('ring', 200, 240, .44, .55)),
    ]),
}


def illustration_svg(name):
    w, h, items = ILLUSTRATIONS[name]
    used = set()
    for it in items:
        if it['kind'] == 'icon':
            used.add(it['name'])
    defs = [f'<g id="{n}">{ICONS[n]}</g>' for n in sorted(used)]
    defs += [f'<g id="s-{n}">{SIL[n]}</g>' for n in sorted(used) if n in SIL]

    # Силуэт каждого закрывающего предмета — с «ореолом» (обводкой), чтобы
    # между передним предметом и линиями позади оставался зазор.
    def silhouette(it):
        if it['kind'] == 'icon' and it['occlude']:
            return (f'<use href="#s-{it["name"]}" transform="{tf(it["x"], it["y"], it["s"], it["r"])}" '
                    'fill="#000" stroke="#000" stroke-width="7"/>')
        if it['kind'] == 'raw' and it['occlude_svg']:
            return it['occlude_svg']
        return ''

    sils = [silhouette(it) for it in items]
    body = []
    for i, it in enumerate(items):
        front = ''.join(sils[i + 1:])
        if it['kind'] == 'icon':
            t = tf(it['x'], it['y'], it['s'], it['r'])
            inner = ''
            if it['tone'] and it['name'] in SIL:
                inner += (f'<use href="#s-{it["name"]}" transform="{t}" fill="#000" '
                          f'fill-opacity="{it["tone"]:g}" stroke="none"/>')
            op = '' if it['op'] >= 1 else f' opacity="{it["op"]:g}"'
            inner += f'<use href="#{it["name"]}" transform="{t}"{op}/>'
        else:
            inner = it['svg']
        if front:
            defs.append(
                f'<mask id="m{i}" maskUnits="userSpaceOnUse" x="-20" y="-20" width="{w + 40}" height="{h + 40}">'
                f'<rect x="-20" y="-20" width="{w + 40}" height="{h + 40}" fill="#fff" stroke="none"/>'
                f'<g fill="#000" stroke="#000">{front}</g></mask>'
            )
            body.append(f'<g mask="url(#m{i})">{inner}</g>')
        else:
            body.append(inner)
    # vector-effect: одна толщина линии у крупных и мелких предметов — стиль
    # «один карандаш», а не «увеличенные иконки».
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" fill="none" '
        'stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        '<style>*{vector-effect:non-scaling-stroke}.f{fill:#000;stroke:none}</style>'
        f'<defs>{"".join(defs)}</defs>{"".join(body)}</svg>'
    )


def data_uri(svg):
    return 'url("data:image/svg+xml,' + quote(svg, safe=" /=:,.-'()") + '")'


def build():
    return {name: illustration_svg(name) for name in ILLUSTRATIONS}


def css_block(svgs):
    lines = [START, ':root {']
    for key, svg in svgs.items():
        lines.append(f'    --decor-{key}: {data_uri(svg)};')
    lines.append('}')
    lines.append(END)
    return '\n'.join(lines)


def write_style(svgs):
    with open(STYLE, encoding='utf-8') as f:
        css = f.read()
    block = css_block(svgs)
    pattern = re.compile(re.escape(START) + r'.*?' + re.escape(END), re.S)
    if not pattern.search(css):
        sys.exit(f'Маркеры decor не найдены в {STYLE}: добавьте строки\n{START}\n{END}')
    css = pattern.sub(lambda _: block, css)
    with open(STYLE, 'w', encoding='utf-8') as f:
        f.write(css)
    print(f'decor: {len(svgs)} слоёв записано в web/style.css')


def write_preview(path, svgs):
    cells = []
    rules = []
    for name, (w, h, _items) in ILLUSTRATIONS.items():
        rules.append(f'.i-{name} i{{-webkit-mask:{data_uri(svgs[name])} center/contain no-repeat}}')
        cells.append(
            f'<figure><figcaption>{name} · {len(svgs[name]) // 1024 + 1} КБ</figcaption>'
            f'<div class="c i-{name}" style="width:{round(w * 1.4)}px;height:{round(h * 1.4)}px">'
            '<i></i></div></figure>'
        )
    sheet = ''.join(
        f'<div class="ic"><svg viewBox="0 0 64 64" fill="none" stroke="#cbff00" stroke-width="2.2" '
        f'stroke-linecap="round" stroke-linejoin="round"><style>.f{{fill:#cbff00;stroke:none}}</style>'
        f'{svg}</svg><span>{name}</span></div>'
        for name, svg in ICONS.items()
    )
    html = (
        '<!doctype html><meta charset="utf-8"><style>body{background:#0d0f13;color:#aaa;'
        'font:12px system-ui;margin:16px}.sheet{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}'
        '.ic{width:96px;text-align:center}.ic svg{width:96px;height:96px;background:#16191f;border-radius:8px}'
        'figure{display:inline-block;margin:0 16px 16px 0}.c{position:relative;background:#14171c;'
        'border-radius:12px;overflow:hidden}.c i{position:absolute;inset:0}'
        '.c i{background:#fff;opacity:.5}'
        + ''.join(rules) + '</style>'
        f'<div class="sheet">{sheet}</div>' + ''.join(cells)
    )
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'decor: превью → {path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--preview', metavar='FILE', help='записать HTML-превью сцен вместо style.css')
    args = parser.parse_args()
    svgs = build()
    if args.preview:
        write_preview(args.preview, svgs)
    else:
        write_style(svgs)
