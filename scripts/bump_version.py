#!/usr/bin/env python3
"""Ставит одну версию во все четыре места сразу.

    python3 scripts/bump_version.py 0.2b46    # записать
    python3 scripts/bump_version.py --check   # только сверить, что все места согласованы

Места: APP_VERSION (macOS), APP_DISPLAY_VERSION (Windows), version в Cargo.toml
(SemVer-двойник: 0.2b46 -> 0.2.46) и versionName/versionCode (Android,
versionCode = MAJOR*10000 + MINOR*1000 + BUILD).
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Необязательный хвост «.K» — подсборка альфы (0.2a48.1): в Cargo и versionCode
# не попадает, там только BUILD.
VERSION_RE = re.compile(r"^(\d+)\.(\d+)([abr])(\d+)(?:\.(\d+))?$")

# (файл, regex с двумя группами вокруг значения). Якоря нужны, чтобы не задеть
# комментарии: в build.gradle.kts те же слова встречаются в тексте.
MACOS = (ROOT / "scripts/build_app.sh", r'^(APP_VERSION=")[^"]*(")')
WINDOWS = (ROOT / "apps/windows/src/native.rs", r'^(const APP_DISPLAY_VERSION: &str = ")[^"]*(";)')
CARGO = (ROOT / "apps/windows/Cargo.toml", r'^(version = ")[^"]*(")')
ANDROID_NAME = (ROOT / "apps/android/app/build.gradle.kts", r'^(\s*versionName = ")[^"]*(")')
ANDROID_CODE = (ROOT / "apps/android/app/build.gradle.kts", r"^(\s*versionCode = )\d+()")


def expected_values(version):
    major, minor, _, build, _sub = VERSION_RE.match(version).groups()
    return [
        (MACOS, version),
        (WINDOWS, version),
        (CARGO, f"{major}.{minor}.{build}"),
        (ANDROID_NAME, version),
        (ANDROID_CODE, str(int(major) * 10000 + int(minor) * 1000 + int(build))),
    ]


def read_value(spot):
    path, pattern = spot
    m = re.search(pattern, path.read_text(encoding="utf-8"), re.M)
    if not m:
        return None
    return m.group(0)[len(m.group(1)) : len(m.group(0)) - len(m.group(2))]


def check():
    macos = read_value(MACOS)
    if macos is None or not VERSION_RE.match(macos):
        print(f"APP_VERSION в build_app.sh не в схеме MAJOR.MINOR{{a|b|r}}BUILD: {macos!r}", file=sys.stderr)
        return 1
    bad = [
        f"{spot[0].relative_to(ROOT)}: ожидалось {want!r}, стоит {read_value(spot)!r}"
        for spot, want in expected_values(macos)
        if read_value(spot) != want
    ]
    if bad:
        print("версии расходятся (эталон — APP_VERSION в build_app.sh):", *bad, sep="\n  ", file=sys.stderr)
        return 1
    print(f"OK: везде {macos}")
    return 0


def bump(version):
    if not VERSION_RE.match(version):
        print(f"нужна схема MAJOR.MINOR{{a|b|r}}BUILD[.K], например 0.2b46 или 0.2a48.1, а не {version!r}", file=sys.stderr)
        return 2
    # Сначала считаем новые тексты всех файлов и только потом пишем: сбой на
    # четвёртом месте не должен оставить три файла уже изменёнными.
    texts = {}
    for (path, pattern), value in expected_values(version):
        src = texts.get(path) or path.read_text(encoding="utf-8")
        new, n = re.subn(pattern, lambda m, v=value: m.group(1) + v + m.group(2), src, count=1, flags=re.M)
        if n != 1:
            print(f"{path.relative_to(ROOT)}: не нашёл место по {pattern!r}; ничего не записано", file=sys.stderr)
            return 1
        texts[path] = new
    for path, text in texts.items():
        path.write_text(text, encoding="utf-8")
        print(f"записано: {path.relative_to(ROOT)}")
    return check()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(check() if sys.argv[1] == "--check" else bump(sys.argv[1]))
