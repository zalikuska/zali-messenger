#!/usr/bin/env python3
"""Stop-хук: если исходники веба новее web/app.js — пересобирает бандл.

Правило «после правки web/src/ всегда запускай bundle_web.py» держалось на
памяти, и забытый запуск уже стоил двух недель протухших Android-ассетов.
Хук закрывает его механически: к концу хода бандл всегда свежий.

Провал сборки возвращается кодом 2 со stderr — Claude видит причину и
чинит; stop_hook_active в входе защищает от бесконечного цикла.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BUNDLE = ROOT / "web" / "app.js"
INPUT_FILES = [ROOT / "web" / n for n in ("style.css", "index.html", "bridge_protocol.json")]


def newest_source_mtime():
    times = [p.stat().st_mtime for p in INPUT_FILES if p.exists()]
    times += [p.stat().st_mtime for p in (ROOT / "web" / "src").rglob("*") if p.is_file()]
    return max(times, default=0)


def main():
    try:
        if json.load(sys.stdin).get("stop_hook_active"):
            return 0
    except Exception:
        pass
    if BUNDLE.exists() and BUNDLE.stat().st_mtime >= newest_source_mtime():
        return 0
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "bundle_web.py")],
        cwd=ROOT, capture_output=True, text=True,
    )
    if result.returncode != 0:
        print("bundle_web.py упал после правок web/src — macOS/Windows/Android получат старый JS:", file=sys.stderr)
        print((result.stdout + result.stderr)[-1500:], file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
