#!/usr/bin/env python3
"""PostToolUse-хук (Edit/Write/MultiEdit): после правки ядра напоминает про Android.

`.so` в apps/android/.../jniLibs лежит вне git и Gradle его не собирает и не
проверяет на устаревание: 0.2b33 нашёл библиотеку на неделю старше core/src, и
фича вышла на десктопах, молча миновав Android. Напоминание один раз за сессию.
"""
import glob
import json
import os
import re
import sys
import tempfile

CORE_RE = re.compile(r"^(core/(src/.+\.rs|Cargo\.toml)|sdk/Rust/src/.+\.rs)$")


def main():
    data = json.load(sys.stdin)
    path = (data.get("tool_input") or {}).get("file_path") or ""
    root = data.get("cwd") or os.getcwd()
    rel = os.path.relpath(path, root).replace(os.sep, "/") if os.path.isabs(path) else path
    if not CORE_RE.match(rel):
        return

    session = re.sub(r"[^A-Za-z0-9_-]", "", str(data.get("session_id") or "nosession"))[:64]
    marker = os.path.join(tempfile.gettempdir(), f"zali-android-core-{session}")
    if os.path.exists(marker):
        return
    open(marker, "w").close()

    libs = glob.glob(os.path.join(root, "apps/android/app/src/main/jniLibs/*/libzali_messenger_core.so"))
    state = "нет ни одной собранной .so" if not libs else "лежащие в jniLibs .so теперь старее исходников"
    text = (
        f"Правка {rel}: {state}. Android грузит ядро только из jniLibs, а Gradle его не собирает "
        f"и об устаревании молчит. Перед сборкой APK: "
        f"ANDROID_NDK_HOME=... ./apps/android/build_android_core.sh (нужен cargo-ndk). "
        f"Если правка меняет формат/крипто — то же нужно в sdk/Swift (macOS). Скажи пользователю, если пересобрать сейчас нельзя."
    )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
