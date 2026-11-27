#!/usr/bin/env python3
"""Собирает дистрибутив msg.zalikus.org: сайт на корне, веб-клиент в /web/.

    python3 scripts/build_site_dist.py [--web-root DIR] [--out DIR]

Результат (по умолчанию dist/site/) — готовое дерево для раздачи nginx'ом:

    /index.html, /logo.svg, /icon-192.png, /apple-touch-icon.png   ← site/
    /service-worker.js                                              ← копия web/service-worker.js
    /web/index.html, app.js, style.css, manifest.json, иконки,
        wasm-pkg/                                                   ← web/

Зачем копия сервис-воркера в корне. Пока клиент жил на корне домена, воркер был
зарегистрирован как /service-worker.js со scope «/», и у установивших PWA на нём
висят подписки Web Push. Если регистрацию бросить, они продолжат получать пуши, но
клик по уведомлению откроет сайт, а клиент в /web/ заведёт вторую регистрацию и
дубль каждого уведомления. Поэтому скрипт остаётся в корне под прежним URL (обновится
сам и сохранит подписки), только с APP_ROOT = '/web/' — маркер `@app-root`.

Бандл (web/app.js, web/wasm-pkg/) в git не лежит: сначала scripts/build_web_wasm.sh и
scripts/bundle_web.py в том дереве, откуда берётся клиент (--web-root).
"""
import argparse
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MARKER = "const APP_ROOT = './'; // @app-root"
WEB_FILES = ["index.html", "app.js", "style.css", "manifest.json", "icon.svg",
             "icon-192.png", "icon-512.png", "apple-touch-icon.png"]
WASM_FILES = ["zali_core.js", "zali_core_bg.wasm"]
SITE_FILES = ["index.html", "logo.svg", "icon-192.png", "apple-touch-icon.png"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--web-root", type=Path, default=REPO, help="корень дерева с web/ и site/ (по умолчанию — этот репозиторий)")
    ap.add_argument("--out", type=Path, default=REPO / "dist" / "site")
    args = ap.parse_args()
    root, out = args.web_root.resolve(), args.out.resolve()
    web, site = root / "web", root / "site"

    missing = [str(p.relative_to(root)) for p in
               [site / f for f in SITE_FILES] + [web / f for f in WEB_FILES]
               + [web / "wasm-pkg" / f for f in WASM_FILES] + [web / "service-worker.js"]
               if not p.is_file()]
    if missing:
        print("нет файлов (бандл собран? scripts/build_web_wasm.sh && scripts/bundle_web.py):", *missing, sep="\n  ", file=sys.stderr)
        return 1

    sw = (web / "service-worker.js").read_text(encoding="utf-8")
    if sw.count(MARKER) != 1:
        print(f"в web/service-worker.js должен быть ровно один маркер: {MARKER}", file=sys.stderr)
        return 1

    if out.exists():
        shutil.rmtree(out)
    (out / "web" / "wasm-pkg").mkdir(parents=True)
    for f in SITE_FILES:
        shutil.copy2(site / f, out / f)
    for f in WEB_FILES:
        shutil.copy2(web / f, out / "web" / f)
    for f in WASM_FILES:
        shutil.copy2(web / "wasm-pkg" / f, out / "web" / "wasm-pkg" / f)
    (out / "service-worker.js").write_text(sw.replace(MARKER, "const APP_ROOT = '/web/'; // @app-root"), encoding="utf-8")

    files = sorted(p for p in out.rglob("*") if p.is_file())
    for p in files:
        print(f"  {p.relative_to(out)}  {p.stat().st_size} B")
    print(f"ok: {len(files)} файлов → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
