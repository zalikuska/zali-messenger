"""Генератор логотипа ZaliMessenger.

Квадратная плитка без скругления (маску накладывает платформа), пять пузырей
в языке «Фокус»: большие серые — входящие, лаймовые ступени — исходящие одной
реплики (сгруппированные углы). Левые края ступеней лежат на одной прямой —
вместе с верхним и нижним пузырём читается Z.

Объём и свет — те же приёмы, что у пузырей в приложении (web/style.css),
только в масштабе иконки (пузырь 136px против 42px в чате, K ≈ 3,24):
  .bubble / .out .bubble   — вертикальный градиент заливки (accent .98→.90),
                             inset 0 1px 0 rgba(255,255,255,.24) сверху,
                             inset 0 -1px 0 тёмная кромка снизу,
                             тень 0 10px 24px;
  «Фокус со свечением»     — ореол 0 0 12px accent .26 вокруг исходящих,
                             рассеянный свет холста: лайм сверху слева
                             и снизу справа (те же значения).

Один генератор на все платформы:
    python3 brand/logo/gen_logo.py            # SVG: мастер, macOS, слои Android
    python3 brand/logo/gen_logo.py --export   # + PNG/ICNS/ICO/mipmap во все шеллы
Экспорт рисует через QuickLook (qlmanage) и Pillow — только на macOS.
"""
import math
import os
import sys

S = 1024
L, RIGHT = 92, 932          # поля; правый край у всех пузырей общий
H = 136                     # высота пузыря
K = H / 42                  # масштаб относительно однострочного пузыря в чате
P = H / 2                   # пилюля — как однострочный пузырь
C = round(H * 6 / 36)       # сгруппированный угол «Фокуса»: 6px на 36px
GAP_GROUP = 24              # внутри реплики
GAP = 38                    # между репликами
W = RIGHT - L

BG = "#090b0e"              # --bg
ACCENT = (203, 255, 0)      # --accent-rgb

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
GENERATED = "Сгенерировано brand/logo/gen_logo.py, не править руками."


def mix(rgb, a, under=(9, 11, 14)):
    """rgba(rgb, a) поверх --bg → непрозрачный hex."""
    return "#" + "".join(f"{round(c * a + u * (1 - a)):02x}" for c, u in zip(rgb, under))


def rrect(x, y, w, h, tl, tr, br, bl):
    return (f"M{x+tl:.1f},{y:.1f} H{x+w-tr:.1f} A{tr},{tr} 0 0 1 {x+w:.1f},{y+tr:.1f} "
            f"V{y+h-br:.1f} A{br},{br} 0 0 1 {x+w-br:.1f},{y+h:.1f} "
            f"H{x+bl:.1f} A{bl},{bl} 0 0 1 {x:.1f},{y+h-bl:.1f} "
            f"V{y+tl:.1f} A{tl},{tl} 0 0 1 {x+tl:.1f},{y:.1f} Z")


def layout():
    ys, y = [], 0.0
    gaps = [GAP, GAP_GROUP, GAP_GROUP, GAP]
    for i in range(5):
        ys.append(y)
        y += H + (gaps[i] if i < 4 else 0)
    top = (S - y) / 2 - 8   # чуть выше центра: тени тянут массу вниз
    return [top + v for v in ys]


def bubbles():
    y = layout()
    step = W / 4
    x2, x3, x4 = L + 3 * step - 64, L + 2 * step - 32, L + step
    return [
        ("in",  L,  y[0], W,          (P, P, P, C)),  # входящий, одиночный
        ("out", x2, y[1], RIGHT - x2, (P, P, C, P)),  # исходящие: start
        ("out", x3, y[2], RIGHT - x3, (P, C, C, P)),  #            mid
        ("out", x4, y[3], RIGHT - x4, (P, C, P, P)),  #            end
        ("in",  L,  y[4], W,          (P, P, P, C)),  # входящий, одиночный
    ]


EDGE = 1 * K                # 1px инсет-кромки
SHADOW_DY = 10 * K          # 0 10px 24px
SHADOW_SD = 24 * K / 2      # CSS blur → stdDeviation
# Ореол вокруг исходящих: --g-halo-soft (0 0 12px .26)
HALOS = [(6 * K, .30)]      # (stdDeviation, opacity)

# farthest-corner радиус CSS-круга × доля из градиента
R_TL = math.hypot(S * .88, S * .94) * .26
R_BR = math.hypot(S * .90, S * .96) * .28

DEFS = f"""
    <!-- Точные значения из style.css (.app в «Фокусе со свечением»):
         radial-gradient(circle at 12% 6%, accent .13, transparent 26%),
         radial-gradient(circle at 90% 96%, accent .09, transparent 28%).
         Размер круга по умолчанию — до дальнего угла, отсюда радиусы. -->
    <radialGradient id="lightTL" gradientUnits="userSpaceOnUse" cx="{S*.12:.1f}" cy="{S*.06:.1f}" r="{R_TL:.1f}">
      <stop offset="0" stop-color="rgb{ACCENT}" stop-opacity=".13"/>
      <stop offset="1" stop-color="rgb{ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="lightBR" gradientUnits="userSpaceOnUse" cx="{S*.90:.1f}" cy="{S*.96:.1f}" r="{R_BR:.1f}">
      <stop offset="0" stop-color="rgb{ACCENT}" stop-opacity=".09"/>
      <stop offset="1" stop-color="rgb{ACCENT}" stop-opacity="0"/>
    </radialGradient>

    <!-- .out .bubble: linear-gradient(180deg, accent .98, accent .90) -->
    <linearGradient id="outBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{mix(ACCENT, .99)}"/>
      <stop offset="1" stop-color="{mix(ACCENT, .89)}"/>
    </linearGradient>
    <!-- .bubble: linear-gradient(180deg, ink .08, ink .04) — светлее, чтобы читалось на иконке,
         соотношение верх/низ то же -->
    <linearGradient id="inBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{mix((255, 255, 255), .215)}"/>
      <stop offset="1" stop-color="{mix((255, 255, 255), .165)}"/>
    </linearGradient>

    <!-- .bubble: border 1px var(border) — кромка входящего, светлее сверху: отделяет
         серый от тёмного холста, не меняя заливку -->
    <linearGradient id="inEdge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".30"/>
      <stop offset=".5" stop-color="#fff" stop-opacity=".12"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".07"/>
    </linearGradient>
    <!-- Та же кромка на лайме: белый поверх яркого лайма заметен слабее, поэтому плотнее -->
    <linearGradient id="outEdge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".62"/>
      <stop offset=".5" stop-color="#fff" stop-opacity=".22"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".14"/>
    </linearGradient>

    <filter id="shadow" x="-30%" y="-100%" width="160%" height="320%">
      <feGaussianBlur stdDeviation="{SHADOW_SD:.1f}"/>
    </filter>
{"".join(f'''
    <filter id="halo{j}" x="-60%" y="-250%" width="220%" height="600%">
      <feGaussianBlur stdDeviation="{sd:.1f}"/>
    </filter>''' for j, (sd, _) in enumerate(HALOS))}
"""


def inset(d, dy, fill, opacity, cid):
    """CSS inset 0 {dy}px 0 color: часть пузыря, не накрытая им же со сдвигом."""
    big = f"M-50,-50 H{S+50} V{S+50} H-50 Z"
    return (f'<g clip-path="url(#{cid})"><path d="{big} {d}" fill-rule="evenodd" fill="{fill}" '
            f'opacity="{opacity}" transform="translate(0 {dy:.1f})"/></g>')


def layers():
    """Пузыри в координатах мастер-холста 0..S: (defs, разметка теней+ореолов+тел)."""
    defs = [DEFS]
    shadows, halos, bodies = [], [], []
    for i, (kind, x, y, w, r) in enumerate(bubbles()):
        d = rrect(x, y, w, H, *r)
        out = kind == "out"
        cid = f"c{i}"
        defs.append(f'<clipPath id="{cid}"><path d="{d}"/></clipPath>')

        shadows.append(f'<path d="{d}" fill="#000" opacity="{.42 if out else .7}" '
                       f'transform="translate(0 {SHADOW_DY:.1f})" filter="url(#shadow)"/>')
        if out:
            for j, (_, op) in enumerate(HALOS):
                halos.append(f'<path d="{d}" fill="rgb{ACCENT}" opacity="{op}" filter="url(#halo{j})"/>')

        # inset-кромки: сдвиг фигуры на +EDGE оставляет полоску сверху, на −EDGE — снизу
        if out:
            top = inset(d, EDGE, "#fff", .24, cid)
            bottom = inset(d, -EDGE, "rgb(85,104,0)", .22, cid)
        else:
            top = inset(d, EDGE, "#fff", .16, cid)
            bottom = inset(d, -EDGE, "#000", .22, cid)
        # обводка внутри контура (половина штриха срезается клипом)
        bottom += (f'\n    <g clip-path="url(#{cid})"><path d="{d}" fill="none" '
                   f'stroke="url(#{"outEdge" if out else "inEdge"})" stroke-width="{2 * EDGE:.1f}"/></g>')
        bodies.append(f'<path d="{d}" fill="url(#{"outBody" if out else "inBody"})"/>\n    {top}\n    {bottom}')
    return "".join(defs), "\n  ".join(shadows + halos + bodies)


def canvas(x0=0.0, y0=0.0, size=S):
    """Холст --bg со светом «Фокуса со свечением» (свет привязан к квадрату 0..S)."""
    return "\n  ".join(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{size:.1f}" height="{size:.1f}" fill="{f}"/>'
                       for f in (BG, "url(#lightTL)", "url(#lightBR)"))


def doc(view, defs, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="{S}" height="{S}">\n'
            f'  <defs>{defs}\n  </defs>\n  {body}\n</svg>\n')


# Пузыри внутри плитки иконки: блок шириной 82% кадра почти касался краёв под
# маской (Dock, iOS) — ужимаем к центру. Ступени тянут массу вправо, поэтому блок
# чуть сдвинут влево (оптический, а не геометрический центр). Холст и свет — как были.
ICON_SCALE = 0.80
ICON_SHIFT_X = -10


def placed(bubbles_):
    cx, cy, _ = bubble_block()
    return (f'<g transform="translate({S/2 + ICON_SHIFT_X:.1f} {S/2:.1f}) scale({ICON_SCALE}) '
            f'translate({-cx:.1f} {-cy:.1f})">\n  {bubbles_}\n  </g>')


def svg_square():
    """Мастер: квадрат во весь кадр. Веб, iOS, Windows — маску кладёт система."""
    defs, bubbles_ = layers()
    return doc(f"0 0 {S} {S}", defs, canvas() + "\n  " + placed(bubbles_))


# ── macOS ─────────────────────────────────────────────────────────────────────
# macOS сама иконку не обрезает: форму и тень надо запечь, иначе в Dock будет
# чёрный квадрат среди скруглённых иконок (а macOS 26+ сажает «неправильные»
# иконки на серую подложку). Сетка Apple: тело 824×824 в холсте 1024 (поле 100),
# контур — суперэллипс (n≈5, «непрерывные углы»), тень вниз ~30%.
MAC_BODY, MAC_PAD = 824, 100


def superellipse(cx, cy, a, n=5.0, steps=720):
    pts = []
    for k in range(steps):
        t = 2 * math.pi * k / steps
        c, s_ = math.cos(t), math.sin(t)
        pts.append((cx + a * math.copysign(abs(c) ** (2 / n), c),
                    cy + a * math.copysign(abs(s_) ** (2 / n), s_)))
    return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts) + " Z"


def svg_macos():
    defs, bubbles_ = layers()
    tile = superellipse(S / 2, S / 2, MAC_BODY / 2)
    k = MAC_BODY / S
    defs += (f'<clipPath id="tile"><path d="{tile}"/></clipPath>'
             f'<filter id="tileShadow" x="-20%" y="-20%" width="140%" height="150%">'
             f'<feGaussianBlur stdDeviation="10"/></filter>')
    body = (f'<path d="{tile}" fill="#000" opacity=".34" transform="translate(0 10)" filter="url(#tileShadow)"/>\n  '
            f'<g clip-path="url(#tile)">\n  <g transform="translate({MAC_PAD} {MAC_PAD}) scale({k})">\n  '
            f'{canvas()}\n  {placed(bubbles_)}\n  </g>\n  '
            # еле заметная светлая кромка — как --border у поверхностей приложения
            f'<path d="{tile}" fill="none" stroke="#fff" stroke-opacity=".10" stroke-width="4"/>\n  </g>')
    return doc(f"0 0 {S} {S}", defs, body)


# ── Android adaptive icon ─────────────────────────────────────────────────────
# Слой 108dp, видимая часть — центральные 72dp, гарантированно видимая при
# любой маске (круг Pixel) — круг 66dp. Фон: холст, где видимые 72dp = наш квадрат.
# Передний план: пузыри, вписанные в круг 66dp.
A_LAYER, A_VISIBLE, A_SAFE = 108, 72, 66


def svg_android_bg():
    defs, _ = layers()
    span = S * A_LAYER / A_VISIBLE
    o = (span - S) / 2
    return doc(f"{-o:.1f} {-o:.1f} {span:.1f} {span:.1f}", defs, canvas(-o, -o, span))


def bubble_block():
    """Центр блока пузырей и радиус описанной окружности их контура."""
    bs = bubbles()
    cx = (L + RIGHT) / 2
    cy = (bs[0][2] + bs[-1][2] + H) / 2
    R = 0.0
    for _, x, y, w, (tl, tr, br, bl) in bs:
        for px, py, r in ((x + tl, y + tl, tl), (x + w - tr, y + tr, tr),
                          (x + w - br, y + H - br, br), (x + bl, y + H - bl, bl)):
            R = max(R, math.hypot(px - cx, py - cy) + r)
    return cx, cy, R


def android_fg_view():
    cx, cy, R = bubble_block()
    span = 2 * R * A_LAYER / A_SAFE
    return cx - span / 2, cy - span / 2, span


def svg_android_fg():
    defs, bubbles_ = layers()
    vx, vy, span = android_fg_view()
    return doc(f"{vx:.1f} {vy:.1f} {span:.1f} {span:.1f}", defs, bubbles_)


def android_monochrome_xml():
    """Тематическая иконка Android 13+: силуэт пузырей в масштабе переднего плана."""
    vx, vy, span = android_fg_view()
    k = A_LAYER / span
    paths = "\n".join(
        f'        <path android:fillColor="#FFFFFFFF" android:pathData="{rrect(x, y, w, H, *r)}"/>'
        for _, x, y, w, r in bubbles())
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!-- {GENERATED} -->\n'
            f'<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            f'    android:width="{A_LAYER}dp"\n    android:height="{A_LAYER}dp"\n'
            f'    android:viewportWidth="{A_LAYER}"\n    android:viewportHeight="{A_LAYER}">\n'
            f'    <group\n        android:scaleX="{k:.6f}"\n        android:scaleY="{k:.6f}"\n'
            f'        android:translateX="{-vx * k:.4f}"\n        android:translateY="{-vy * k:.4f}">\n'
            f'{paths}\n    </group>\n</vector>\n')


def android_notification_xml():
    """Маленький значок уведомления Android: тот же силуэт, но вписанный в 24dp.

    Системе нужна альфа-маска на всю площадь 24dp — а монохромный слой лаунчера
    рассчитан на безопасную зону адаптивной иконки (силуэт в нём в разы мельче)."""
    bs = bubbles()
    x0, x1 = L, RIGHT
    y0, y1 = bs[0][2], bs[-1][2] + H
    size, margin = 24, 1.0
    k = (size - 2 * margin) / max(x1 - x0, y1 - y0)
    tx = (size - (x1 - x0) * k) / 2 - x0 * k
    ty = (size - (y1 - y0) * k) / 2 - y0 * k
    paths = "\n".join(
        f'        <path android:fillColor="#FFFFFFFF" android:pathData="{rrect(x, y, w, H, *r)}"/>'
        for _, x, y, w, r in bs)
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!-- {GENERATED} -->\n'
            f'<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            f'    android:width="{size}dp"\n    android:height="{size}dp"\n'
            f'    android:viewportWidth="{size}"\n    android:viewportHeight="{size}">\n'
            f'    <group\n        android:scaleX="{k:.6f}"\n        android:scaleY="{k:.6f}"\n'
            f'        android:translateX="{tx:.4f}"\n        android:translateY="{ty:.4f}">\n'
            f'{paths}\n    </group>\n</vector>\n')


# ── Windows ───────────────────────────────────────────────────────────────────
# Windows тоже не скругляет иконки: острый чёрный квадрат среди скруглённых иконок
# Windows 11 — чужой. Плитка со скруглением в духе Win11 (меньше, чем у macOS, без
# тени), небольшое поле и та же светлая кромка, что отделяет плитку от тёмной
# панели задач. 16–32px рисуются отдельно — см. small_icon().
WIN_INSET = 32
WIN_RADIUS = 0.19           # доля стороны плитки
# Сырые RGBA для трея и окна: main.rs выбирает размер по системной метрике иконки
WIN_RGBA_SIZES = (16, 20, 24, 32, 48, 64)


def svg_windows():
    defs, bubbles_ = layers()
    side = S - 2 * WIN_INSET
    r = side * WIN_RADIUS
    tile = rrect(WIN_INSET, WIN_INSET, side, side, r, r, r, r)
    defs += f'<clipPath id="tile"><path d="{tile}"/></clipPath>'
    body = (f'<g clip-path="url(#tile)">\n  <g transform="translate({WIN_INSET} {WIN_INSET}) scale({side / S})">\n  '
            f'{canvas()}\n  {placed(bubbles_)}\n  </g>\n  '
            f'<path d="{tile}" fill="none" stroke="#fff" stroke-opacity=".10" stroke-width="4"/>\n  </g>')
    return doc(f"0 0 {S} {S}", defs, body)


# Пиксельная сетка пяти пузырей для иконок 16–32px, подобрана руками: высоты и
# зазоры — целые пиксели, иначе уменьшенная большая иконка превращается в лаймовое
# пятно (зазоры тоньше пикселя, серое тонет в фоне). Лайм не тоньше серого, зазор
# между репликами не меньше зазора внутри реплики — как в логотипе. Если блок не
# делится поровну, он стоит на полпикселя выше центра — как и в мастере.
# 24px — главный размер (панель задач при 100%): все полосы по 3px, как пять равных
# пузырей большого логотипа (ширина/высота полосы ≈ 6, как 840/136).
# n: (поле сверху, [высоты 5 полос], [4 зазора]); поле снизу — остаток
SMALL_LAYOUTS = {
    16: (1, [2, 2, 2, 2, 2], [1, 1, 1, 1]),
    20: (2, [2, 2, 2, 2, 2], [2, 1, 1, 2]),
    24: (2, [3, 3, 3, 3, 3], [1, 1, 1, 1]),
    32: (3, [4, 4, 4, 4, 4], [2, 1, 1, 2]),
}
for _n, (_top, _hs, _gs) in SMALL_LAYOUTS.items():
    _bottom = _n - _top - sum(_hs) - sum(_gs)
    assert _bottom in (_top, _top + 1), _n


def small_icon(n, ss=8):
    """Упрощённая иконка 16–32px: плитка, плоские пузыри по пиксельной сетке, без
    свечения и теней (на таком размере они дают только муть). Кромка плитки — как у
    большой Windows-плитки: отделяет её от тёмной панели задач."""
    from PIL import Image, ImageDraw
    m, hs, gs = SMALL_LAYOUTS[n]
    mx = max(2, round(n * .11))
    width = n - 2 * mx
    img = Image.new("RGBA", (n * ss, n * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    tile_r = max(3, round(n * WIN_RADIUS)) * ss
    d.rounded_rectangle((0, 0, n * ss - 1, n * ss - 1), radius=tile_r, fill=BG)
    gray = mix((255, 255, 255), .26)   # чуть светлее большой иконки: иначе серое на 16px пропадает
    lime = "#%02x%02x%02x" % ACCENT
    y = m
    for i, (kind, x, _, w, (tl, tr, br, bl)) in enumerate(bubbles()):
        left = mx + round((x - L) / W * width)
        x0, x1 = left * ss, (mx + width) * ss
        y0, y1 = y * ss, (y + hs[i]) * ss
        big = hs[i] * ss / 2
        small = min(big, ss * .75)
        rad = [big if v == P else small for v in (tl, tr, br, bl)]
        fill = lime if kind == "out" else gray
        d.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=big, fill=fill)
        # углы со стыком внутри реплики — малые: закрашиваем четверть заново
        xm, ym = (x0 + x1) / 2, (y0 + y1) / 2
        quads = [((x0, y0, xm, ym), (True, False, False, False)), ((xm, y0, x1 - 1, ym), (False, True, False, False)),
                 ((xm, ym, x1 - 1, y1 - 1), (False, False, True, False)), ((x0, ym, xm, y1 - 1), (False, False, False, True))]
        for (box, corners), r_ in zip(quads, rad):
            if r_ != big:
                d.rounded_rectangle(box, radius=r_, fill=fill, corners=corners)
        y += hs[i] + (gs[i] if i < 4 else 0)
    d.rounded_rectangle((0, 0, n * ss - 1, n * ss - 1), radius=tile_r, outline=(255, 255, 255, 26), width=ss)
    return img.reduce(ss)


# ── Установщик Windows (Inno Setup, тёмная тема) ──────────────────────────────
# Левая панель на страницах «Добро пожаловать» и «Готово», пропорция 164:314.
# Холст и свет — как у окна приложения; в центре логотип, над и под ним бледные
# силуэты переписки (заливка входящего в «Фокусе», --f-fill = ink .065), гаснущие
# к краям. Справа панель переходит в фон страницы (WizardBackColor = --bg), поэтому
# свет у правого края гасится маской — без шва.
PANEL_W = S * 164 / 314
PANEL_X = (S - PANEL_W) / 2
# (вид, доля ширины) — сверху вниз; ближние к логотипу ярче
GHOSTS_ABOVE = [("in", .58), ("out", .36), ("out", .62), ("in", .44)]
GHOSTS_BELOW = [("out", .48), ("in", .66), ("in", .38), ("out", .54)]


def ghost_rows(rows, edge, upward):
    """Силуэты пузырей от края логотипа (edge) вверх или вниз. Подряд с одной стороны —
    одна реплика: малый зазор и малые углы на стыке, как в чате."""
    seq = list(reversed(rows)) if upward else list(rows)   # от логотипа наружу
    placed_, cur, prev = [], edge, None
    for dist, (kind, frac) in enumerate(seq):
        gap = GAP_GROUP if kind == prev else GAP
        if upward:
            y = cur - gap - H
            cur = y
        else:
            y = cur + gap
            cur = y + H
        w = W * frac
        placed_.append([kind, L if kind == "in" else RIGHT - w, y, w, dist])
        prev = kind
    placed_.sort(key=lambda t: t[2])
    res = []
    for j, (kind, x, y, w, dist) in enumerate(placed_):
        up = j > 0 and placed_[j - 1][0] == kind
        down = j + 1 < len(placed_) and placed_[j + 1][0] == kind
        r = (C if up else P, P, P, C if down else P) if kind == "in" else (P, C if up else P, C if down else P, P)
        res.append((x, y, w, r, dist))
    return res


def svg_installer_panel():
    defs, bubbles_ = layers()
    pw, px = PANEL_W, PANEL_X
    r_tl = math.hypot(pw * .88, S * .94) * .26
    r_br = math.hypot(pw * .90, S * .96) * .28
    defs += (f'<radialGradient id="pTL" gradientUnits="userSpaceOnUse" cx="{px + pw*.12:.1f}" cy="{S*.06:.1f}" r="{r_tl:.1f}">'
             f'<stop offset="0" stop-color="rgb{ACCENT}" stop-opacity=".13"/><stop offset="1" stop-color="rgb{ACCENT}" stop-opacity="0"/></radialGradient>'
             f'<radialGradient id="pBR" gradientUnits="userSpaceOnUse" cx="{px + pw*.90:.1f}" cy="{S*.96:.1f}" r="{r_br:.1f}">'
             f'<stop offset="0" stop-color="rgb{ACCENT}" stop-opacity=".09"/><stop offset="1" stop-color="rgb{ACCENT}" stop-opacity="0"/></radialGradient>'
             f'<linearGradient id="pFade" gradientUnits="userSpaceOnUse" x1="{px + pw*.55:.1f}" y1="0" x2="{px + pw:.1f}" y2="0">'
             f'<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>'
             f'<mask id="pMask"><rect x="0" y="0" width="{S}" height="{S}" fill="url(#pFade)"/></mask>')
    bs = bubbles()
    top, bottom = bs[0][2], bs[-1][2] + H
    ghosts = ghost_rows(GHOSTS_ABOVE, top, upward=True) + ghost_rows(GHOSTS_BELOW, bottom, upward=False)
    fade = [.9, .55, .3, .14]
    ghost_svg = "\n  ".join(
        f'<path d="{rrect(x, y, w, H, *r)}" fill="#fff" opacity="{.065 * fade[dist] / fade[0]:.4f}"/>'
        for x, y, w, r, dist in ghosts)
    cx, cy, _ = bubble_block()
    k = pw * .74 / W
    content = (f'<g transform="translate({px + pw / 2:.1f} {S * .47:.1f}) scale({k:.5f}) translate({-cx:.1f} {-cy:.1f})">\n  '
               f'{ghost_svg}\n  {bubbles_}\n  </g>')
    body = (f'<rect width="{S}" height="{S}" fill="{BG}"/>\n  '
            f'<g mask="url(#pMask)"><rect width="{S}" height="{S}" fill="url(#pTL)"/>'
            f'<rect width="{S}" height="{S}" fill="url(#pBR)"/></g>\n  {content}')
    return doc(f"0 0 {S} {S}", defs, body)


ANDROID_ADAPTIVE = (f'<?xml version="1.0" encoding="utf-8"?>\n<!-- {GENERATED} -->\n'
                    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                    '    <background android:drawable="@mipmap/ic_launcher_background"/>\n'
                    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
                    '    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n'
                    '</adaptive-icon>\n')

SVGS = {
    "zali-logo.svg": svg_square,
    "zali-logo-macos.svg": svg_macos,
    "zali-logo-android-bg.svg": svg_android_bg,
    "zali-logo-android-fg.svg": svg_android_fg,
    "zali-logo-windows.svg": svg_windows,
    "installer-panel.svg": svg_installer_panel,
}


# ── Экспорт иконок во все шеллы ───────────────────────────────────────────────
def _quicklook(svg_text, name, tmp):
    import subprocess
    from PIL import Image
    path = os.path.join(tmp, name)
    with open(path, "w") as f:
        f.write(svg_text)
    subprocess.run(["qlmanage", "-t", "-s", str(S), "-o", tmp, path],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    img = Image.open(path + ".png").convert("RGB")
    if img.size != (S, S):
        raise SystemExit(f"{name}: QuickLook отдал {img.size}, ждали {S}×{S}")
    return img


def render(svg_path, tmp):
    """SVG → RGBA 1024 через QuickLook (WebKit): фильтры и градиенты как в браузере.

    QuickLook отдаёт картинку без альфы, на белом. Поэтому рисуем дважды — на
    чёрной и на белой подложке — и восстанавливаем альфу по разнице:
    a = 1 − (белый − чёрный), цвет = чёрный / a. Точно для обычного наложения."""
    from PIL import Image, ImageChops
    text = open(svg_path).read()
    vx, vy, vw, vh = text.split('viewBox="', 1)[1].split('"', 1)[0].split()
    under = '</defs>\n  <rect x="{}" y="{}" width="{}" height="{}" fill="{{}}"/>'.format(vx, vy, vw, vh)
    base = os.path.basename(svg_path)
    on_black = _quicklook(text.replace("</defs>", under.format("#000"), 1), "b-" + base, tmp)
    on_white = _quicklook(text.replace("</defs>", under.format("#fff"), 1), "w-" + base, tmp)
    alpha = ImageChops.invert(ImageChops.subtract(on_white, on_black).convert("L"))
    out = Image.new("RGBA", (S, S))
    px_b, al, px_o = on_black.load(), alpha.load(), out.load()
    for yy in range(S):
        for xx in range(S):
            av = al[xx, yy]
            if av == 0:
                px_o[xx, yy] = (0, 0, 0, 0)
                continue
            r, g, b = px_b[xx, yy]
            k = 255 / av
            px_o[xx, yy] = (min(255, round(r * k)), min(255, round(g * k)), min(255, round(b * k)), av)
    return out


def export():
    import json
    import shutil
    import subprocess
    import tempfile
    from PIL import Image

    def out(rel):
        path = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path

    def sized(img, n):
        return img if img.size[0] == n else img.resize((n, n), Image.LANCZOS)

    tmp = tempfile.mkdtemp(prefix="zali-logo-")
    master = render(os.path.join(HERE, "zali-logo.svg"), tmp)
    mac = render(os.path.join(HERE, "zali-logo-macos.svg"), tmp)
    a_bg = render(os.path.join(HERE, "zali-logo-android-bg.svg"), tmp)
    a_fg = render(os.path.join(HERE, "zali-logo-android-fg.svg"), tmp)
    master.convert("RGB").save(os.path.join(HERE, "zali-logo-1024.png"), optimize=True)
    mac.save(os.path.join(HERE, "zali-logo-macos-1024.png"), optimize=True)

    # Веб / PWA (иконка веб-уведомлений — тоже icon-192)
    shutil.copyfile(os.path.join(HERE, "zali-logo.svg"), out("web/icon.svg"))
    for n, name in ((192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")):
        sized(master, n).convert("RGB").save(out(f"web/{name}"), optimize=True)

    # iOS: один 1024 без альфы, маску кладёт система
    appicon = out("apps/ios/ZaliMessenger/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png")
    master.convert("RGB").save(appicon, optimize=True)
    with open(os.path.join(os.path.dirname(appicon), "Contents.json"), "w") as f:
        json.dump({"images": [{"filename": "AppIcon-1024.png", "idiom": "universal",
                               "platform": "ios", "size": "1024x1024"}],
                   "info": {"author": "xcode", "version": 1}}, f, indent=2)
    with open(out("apps/ios/ZaliMessenger/Assets.xcassets/Contents.json"), "w") as f:
        json.dump({"info": {"author": "xcode", "version": 1}}, f, indent=2)

    # macOS: .icns из iconset (Swift-клиент и Rust-шелл берут один файл)
    iconset = os.path.join(tmp, "AppIcon.iconset")
    os.makedirs(iconset)
    for n in (16, 32, 128, 256, 512):
        sized(mac, n).save(os.path.join(iconset, f"icon_{n}x{n}.png"))
        sized(mac, n * 2).save(os.path.join(iconset, f"icon_{n}x{n}@2x.png"))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out("apps/macos/AppIcon.icns")], check=True)

    # Windows: .ico для установщика и ярлыков + сырой RGBA для трея и окна
    # (tao/tray-icon берут from_rgba — без декодера картинок в бинарнике).
    # 16–32 — отдельный упрощённый рисунок, 40+ — плитка со скруглением.
    win = render(os.path.join(HERE, "zali-logo-windows.svg"), tmp)
    win.save(os.path.join(HERE, "zali-logo-windows-1024.png"), optimize=True)
    small = {n: small_icon(n) for n in (16, 20, 24, 32)}
    win_sizes = {n: (small[n] if n in small else sized(win, n)) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)}
    win_sizes[256].save(out("apps/windows/assets/zali.ico"), sizes=[(n, n) for n in win_sizes],
                        append_images=[img for n, img in win_sizes.items() if n != 256])
    for n in WIN_RGBA_SIZES:
        with open(out(f"apps/windows/assets/icon-{n}.rgba"), "wb") as f:
            f.write(win_sizes[n].tobytes())
    # превью мелких размеров рядом с исходником — проверять глазами после правок
    strip = Image.new("RGBA", (sum(n * 4 + 16 for n in small), 32 * 4 + 16), (32, 32, 32, 255))
    x = 8
    for n, img in small.items():
        strip.alpha_composite(img.resize((n * 4, n * 4), Image.NEAREST), (x, 8 + (32 - n) * 2))
        x += n * 4 + 16
    strip.save(os.path.join(HERE, "zali-logo-windows-small-x4.png"))

    # Установщик (Inno Setup 6.7+, тёмная тема): левая панель 164:314 под разные DPI
    # (100/150/200/250%) и плитка для шапки внутренних страниц (прозрачный PNG).
    # .iss берёт их по маске wizard\large-*.png / wizard\small-*.png — Setup сам
    # выбирает подходящий размер.
    wiz = "apps/windows/installer/wizard"
    panel = render(os.path.join(HERE, "installer-panel.svg"), tmp).convert("RGB")
    x0 = round(PANEL_X)
    panel = panel.crop((x0, 0, x0 + round(PANEL_W), S))
    for w_, h_ in ((164, 314), (246, 471), (328, 628), (410, 785)):
        panel.resize((w_, h_), Image.LANCZOS).save(out(f"{wiz}/large-{w_}.png"), optimize=True)
    for n in (58, 87, 116, 147):
        sized(win, n).save(out(f"{wiz}/small-{n}.png"), optimize=True)

    # Android: адаптивная иконка (minSdk 26 — только adaptive) + монохромный слой
    res = "apps/android/app/src/main/res"
    for dpi, mult in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
        n = round(A_LAYER * mult)
        sized(a_bg, n).convert("RGB").save(out(f"{res}/mipmap-{dpi}/ic_launcher_background.png"), optimize=True)
        sized(a_fg, n).save(out(f"{res}/mipmap-{dpi}/ic_launcher_foreground.png"), optimize=True)
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        with open(out(f"{res}/mipmap-anydpi-v26/{name}"), "w") as f:
            f.write(ANDROID_ADAPTIVE)
    with open(out(f"{res}/drawable/ic_launcher_monochrome.xml"), "w") as f:
        f.write(android_monochrome_xml())
    with open(out(f"{res}/drawable/ic_notification.xml"), "w") as f:
        f.write(android_notification_xml())

    shutil.rmtree(tmp)
    print("иконки экспортированы")


if __name__ == "__main__":
    for name, fn in SVGS.items():
        with open(os.path.join(HERE, name), "w") as f:
            f.write(fn())
    if "--export" in sys.argv:
        export()
    else:
        print("SVG записаны; --export — отрисовать и разложить иконки по шеллам")
