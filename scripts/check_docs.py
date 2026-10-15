#!/usr/bin/env python3
"""Проверяет, что CLAUDE.md и скиллы в .claude/skills не разошлись с кодом.

    python3 scripts/check_docs.py

Пять слоёв, каждый ловит свой вид тихого устаревания:
  1. фронтматтер скиллов (только SKILL.md; подфайлы вроде room-lifecycle.md — без него) (name == имя папки, description, закрывающий ---);
  2. ссылки «скилл `x`» и таблица в CLAUDE.md указывают на существующие скиллы;
  3. пути репозитория в обратных кавычках существуют;
  4. числа в тексте скиллов (150 с, 6 камер, 32 КиБ, ...) совпадают с константами
     в коде. Меняешь константу — скрипт падает и показывает, какой скилл править;
  5. версии в четырёх местах согласованы (scripts/bump_version.py --check).

Приватные скиллы zali-ops-* проверяются, только если лежат на диске.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILLS = ROOT / ".claude" / "skills"
errors = []


def fail(msg):
    errors.append(msg)


def skill_dirs():
    return sorted(p for p in SKILLS.iterdir() if (p / "SKILL.md").is_file())


def check_frontmatter():
    for d in skill_dirs():
        lines = (d / "SKILL.md").read_text(encoding="utf-8").splitlines()
        ok = (
            len(lines) > 4
            and lines[0] == "---"
            and lines[1] == f"name: {d.name}"
            and lines[2].startswith("description: ")
            and len(lines[2]) > len("description: ") + 20
            and lines[3] == "---"
        )
        if not ok:
            fail(f"{d.name}: фронтматтер невалиден (ожидается ---/name: {d.name}/description: …/---)")


def skill_files(d):
    """SKILL.md и подфайлы скилла (voice-calls/room-lifecycle.md и т. п.)."""
    return sorted(d.glob("*.md"))


def docs_files():
    return [ROOT / "CLAUDE.md"] + [f for d in skill_dirs() for f in skill_files(d)]


def check_skill_refs():
    names = {d.name for d in skill_dirs()}
    for f in docs_files():
        text = f.read_text(encoding="utf-8")
        refs = set(re.findall(r"скилл[а-яё]*\s+`([a-z][a-z0-9-]*[a-z0-9])`", text))
        if f.name == "CLAUDE.md":
            table = text.split("## Ситуативные скиллы", 1)[-1]
            refs |= set(re.findall(r"\|\s*`([a-z][a-z0-9-]+)`\s*\|\s*$", table, re.M))
        for r in sorted(refs - names):
            # Приватные скиллы в чистом клоне отсутствуют — это нормально.
            if r.startswith("zali-ops-"):
                continue
            fail(f"{f.relative_to(ROOT)}: ссылка на несуществующий скилл `{r}`")


PATH_RE = re.compile(r"`((?:apps|server|web|core|sdk|scripts|docs|tests|\.claude)/[^`\s]+)`")
SKIP_PARTS = ("*", "<", "{", "...", "$", "wasm-pkg", "/target/", "/build/", "dist/")


def check_paths():
    for f in docs_files():
        for raw in set(PATH_RE.findall(f.read_text(encoding="utf-8"))):
            p = re.sub(r"(::\w+|:\d+)$", "", raw.rstrip(".,;)"))
            if any(s in p for s in SKIP_PARTS):
                continue
            if not (ROOT / p).exists():
                fail(f"{f.relative_to(ROOT)}: пути `{p}` нет в репозитории")


# (скилл, фрагмент текста в скилле, файл кода, regex в коде). Пробелы и переносы
# в тексте скилла схлопываются, поэтому фрагмент пишется через один пробел.
CLAIMS = [
    ("voice-calls", "через **150 с** после закрытия", "server/src/realtime.rs", r"from_secs\(150\)"),
    ("voice-calls", "`MAX_MESH_VIDEO_PEERS` (15)", "web/src/interface/voice_media.js", r"MAX_MESH_VIDEO_PEERS\(\)\s*\{\s*return 15;"),
    ("voice-calls", "`MAX_MESH_AUDIO_PEERS` (15)", "web/src/interface/voice_media.js", r"MAX_MESH_AUDIO_PEERS\(\)\s*\{\s*return 15;"),
    ("voice-calls", "Аудио `maxBitrate` — 64 кбит/с", "web/src/interface/voice_media.js", r"maxBitrate = 64000"),
    ("voice-calls", "протокольный `Ping` каждые 20 с", "server/src/realtime.rs", r"interval\(Duration::from_secs\(20\)\)"),
    ("android-client", "`ZaliCoreBridge.MAX_DECRYPT_CANDIDATES` (12)", "apps/android/app/src/main/java/org/zalikus/messenger/ZaliCoreBridge.kt", r"MAX_DECRYPT_CANDIDATES: Int = 12"),
    ("message-lifecycle", "Текст обрезается до 280 символов", "web/src/interface/message_edit.js", r"REPLY_QUOTE_MAX_CHARS\(\)\s*\{\s*return 280;"),
    ("messaging-protocol", "меньше 32 КиБ", "server/src/messages.rs", r"INLINE_ARCHIVE_MAX_BYTES: u64 = 32 \* 1024"),
    ("messaging-protocol", "210 000 итераций", "core/src/crypto.rs", r"PBKDF2_ITERS: u32 = 210_000"),
    ("messaging-protocol", "чанки по 1 МБ", "sdk/Rust/src/lib.rs", r"CHUNK_SIZE: usize = 1024 \* 1024"),
    ("zalicoin-treasury", "`SUM(coin_balances.balance)` + удержанное = 100 000", "server/src/coins.rs", r"ZALICOIN_TOTAL_SUPPLY: i64 = 100_000"),
    ("web-ui-architecture", "после 50 неудачных попыток", "web/src/interface/outbox.js", r"MAX_OUTBOX_ATTEMPTS = 50"),
    ("notifications", "«смотрю» старше 60 с не в счёт", "server/src/push.rs", r"PRESENCE_FRESH: Duration = Duration::from_secs\(60\)"),
]


def check_claims():
    for skill, fragment, code_file, pattern in CLAIMS:
        skill_dir = SKILLS / skill
        if not (skill_dir / "SKILL.md").exists():
            fail(f"CLAIMS ссылается на скилл {skill}, которого нет")
            continue
        text = re.sub(r"\s+", " ", " ".join(f.read_text(encoding="utf-8") for f in skill_files(skill_dir)))
        if fragment not in text:
            fail(f"{skill}: не нашёл фразу «{fragment}» — скилл переписан? обнови CLAIMS в scripts/check_docs.py")
            continue
        code = ROOT / code_file
        if not code.exists():
            fail(f"{skill}: файла кода {code_file} нет")
        elif not re.search(pattern, code.read_text(encoding="utf-8")):
            fail(f"{skill}: «{fragment}» больше не совпадает с кодом ({code_file}, ищу /{pattern}/) — поправь скилл")


def check_versions():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "bump_version.py"), "--check"], capture_output=True, text=True)
    if r.returncode != 0:
        fail("версии расходятся: " + (r.stderr or r.stdout).strip().replace("\n", " "))


if __name__ == "__main__":
    for check in (check_frontmatter, check_skill_refs, check_paths, check_claims, check_versions):
        check()
    if errors:
        print("check_docs: найдено расхождений:", len(errors), file=sys.stderr)
        print(*("  - " + e for e in errors), sep="\n", file=sys.stderr)
        sys.exit(1)
    print(f"check_docs: OK ({len(skill_dirs())} скиллов, {len(CLAIMS)} числовых утверждений сверено с кодом)")
