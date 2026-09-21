#!/usr/bin/env python3
"""PreToolUse-хук (Read/Edit/Write/MultiEdit): по пути файла подсказывает,
какой ситуативный скилл из .claude/skills стоит вызвать до правки.

Скиллы не грузятся сами — без этой подсказки их приходится вспоминать по
таблице в CLAUDE.md. Подсказка выдаётся один раз на скилл за сессию (отметки
лежат во временном каталоге под session_id), чтобы не повторяться на каждом Read.
Любая ошибка здесь молча превращается в «без подсказки»: хук не имеет права
мешать работе.
"""
import json
import os
import re
import sys
import tempfile

# Порядок значения не имеет: подсказываются все совпавшие скиллы.
RULES = [
    (r"^web/src/interface/voice_|^web/src/modules/voice\.js|^server/src/(voice|realtime)\.rs", "voice-calls"),
    (r"^apps/android/(?!app/build/)", "android-client"),
    (r"^apps/macos/(?!Sources/ZaliMessenger/(Assets\.swift|Resources/))", "macos-client"),
    (r"^apps/windows/src/native\.rs|^apps/windows/src/native/(?!autostart\.rs)", "windows-client"),
    (r"^apps/windows/installer/|^apps/windows/src/main\.rs|^apps/windows/src/native/autostart\.rs|^scripts/build_windows_app\.ps1", "windows-build-distribution"),
    (r"^apps/windows/src/native/updates\.rs|^scripts/(build_app\.sh|bump_version\.py)|^server/src/updates\.rs", "release-management"),
    (r"^server/src/hash_chain\.rs|^web/src/interface/message_edit\.js", "message-lifecycle"),
    (r"^server/src/(coins|treasury)\.rs|^web/src/interface/(zalicoin|treasury)\.js", "zalicoin-treasury"),
    (r"^server/src/(push|fcm)\.rs|^web/src/interface/(notifications|web_push)\.js|^web/service-worker\.js", "notifications"),
    (r"^web/src/interface/(cache|attachments|message_list|message_render)\.js", "performance"),
    (r"^web/src/(interface\.js|mixin\.js|manifest\.json)", "web-ui-architecture"),
    (r"^server/src/(auth|devices)\.rs", "security-invariants"),
    (r"^(core|sdk)/.+\.(rs|swift)$|^web/src/modules/(wasm_bridge|api_routes)\.js|^web/src/interface/(api|key_envelopes|key_resolution|conversation_keys)\.js|^server/src/(messages|conversation_keys)\.rs", "messaging-protocol"),
    (r"^web/src/modules/wasm_bridge\.js|^web/manifest\.json", "browser-pwa-client"),
]

# Скиллы из нескольких файлов: какой подфайл читать, кроме SKILL.md, для этого пути.
SUBFILES = [
    (r"^web/src/interface/voice_transport\.js|^server/src/voice\.rs", "voice-calls", "room-lifecycle.md"),
    (r"^web/src/interface/voice_media\.js|^server/src/realtime\.rs", "voice-calls", "media-and-ws.md"),
    (r"^web/src/interface/cache\.js", "performance", "asset-cache.md"),
]

# Что прогнать после правки области (замеры на чистом дереве, 2026-09-20).
DOCTORS = {
    "voice-calls": "./scripts/voice_doctor/run.sh (~3 с)",
    "notifications": "./scripts/notify_doctor/run.sh (~1 с)",
    "performance": "./scripts/perf_doctor/run.sh (~2 с) и ./scripts/memory_doctor/run.sh",
    "security-invariants": "./scripts/security_doctor/run.sh (<1 с)",
    "messaging-protocol": "./scripts/crypto_doctor/run.sh (~40 с)",
}


def main():
    data = json.load(sys.stdin)
    path = (data.get("tool_input") or {}).get("file_path") or ""
    if not path:
        return
    root = data.get("cwd") or os.getcwd()
    rel = os.path.relpath(path, root) if os.path.isabs(path) else path
    if rel.startswith(".."):
        return
    rel = rel.replace(os.sep, "/")

    wanted = []
    for pattern, skill in RULES:
        if re.search(pattern, rel) and skill not in wanted:
            wanted.append(skill)
    if not wanted:
        return

    subfiles = [(sk, f) for pattern, sk, f in SUBFILES if re.search(pattern, rel)]

    session = re.sub(r"[^A-Za-z0-9_-]", "", str(data.get("session_id") or "nosession"))[:64]
    state_dir = os.path.join(tempfile.gettempdir(), f"zali-skill-hints-{session}")
    os.makedirs(state_dir, exist_ok=True)

    def first_time(key):
        marker = os.path.join(state_dir, key.replace("/", "__"))
        if os.path.exists(marker):
            return False
        open(marker, "w").close()
        return True

    fresh = [skill for skill in wanted if first_time(skill)]
    fresh_files = [f".claude/skills/{sk}/{f}" for sk, f in subfiles if first_time(f"{sk}/{f}")]
    if not fresh and not fresh_files:
        return

    text = ""
    if fresh:
        names = ", ".join(f"`{s}`" for s in fresh)
        text = (
            f"Файл {rel} относится к области со скиллом {names}: если в этой сессии его ещё не вызывали, "
            f"вызови Skill до правки — там инварианты, на которых уже ломались."
        )
    else:
        text = f"Файл {rel}:"
    if fresh_files:
        text += " Для этого файла прочитай ещё " + ", ".join(f"`{f}`" for f in fresh_files) + " (целиком)."
    checks = [DOCTORS[s] for s in fresh if s in DOCTORS]
    if checks:
        text += " После правки прогони: " + "; ".join(checks) + "."
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": text}}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
