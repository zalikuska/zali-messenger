#!/usr/bin/env python3
"""PreToolUse-хук: требует graphify перед поиском/чтением исходников.

Заменяет два inline-хука из settings.json (Bash-поиск и Read/Glob). Условия
срабатывания и полный текст те же, но полный текст выдаётся только первые
FULL_TIMES раз за сессию для каждого вида; дальше — короткое напоминание. Один и тот
же абзац на каждый Read обходился примерно в десять тысяч токенов за сессию, а
правило при этом остаётся в CLAUDE.md и напоминается на каждом вызове.

    argv[1] = bash | read
"""
import json
import os
import re
import sys
import tempfile

FULL_TIMES = 2

SEARCH_TOOLS = ("grep", "rg ", "ripgrep", "find ", "fd ", "ack ", "ag ")
EXTS = (".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb", ".c", ".h", ".cpp", ".hpp",
        ".cc", ".cs", ".kt", ".swift", ".php", ".scala", ".lua", ".sh", ".md", ".rst", ".txt", ".mdx")

FULL = {
    "bash": (
        "MANDATORY: graphify-out/graph.json exists. You MUST run `graphify query \"<question>\"` before "
        "grepping raw files. Only grep after graphify has oriented you, or to modify/debug specific lines."
    ),
    "read": (
        "MANDATORY: graphify-out/graph.json exists. You MUST run graphify before reading source files. Use: "
        "`graphify query \"<question>\"` (scoped subgraph), `graphify explain \"<concept>\"`, or "
        "`graphify path \"<A>\" \"<B>\"`. Only read raw files after graphify has oriented you, or to "
        "modify/debug specific lines. This rule applies to subagents too — include it in every subagent "
        "prompt involving code exploration."
    ),
}
SHORT = "graphify-out/graph.json есть: сначала `graphify query \"<вопрос>\"` (или explain/path), потом сырые файлы."


def matches(kind, tool_input):
    if kind == "bash":
        cmd = str(tool_input.get("command") or "")
        return any(t in cmd for t in SEARCH_TOOLS)
    s = " ".join(str(tool_input.get(k) or "") for k in ("file_path", "pattern", "path")).lower().replace("\\", "/")
    return "graphify-out/" not in s and any(e in s for e in EXTS)


def main():
    kind = sys.argv[1]
    data = json.load(sys.stdin)
    root = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    if not os.path.isfile(os.path.join(root, "graphify-out", "graph.json")):
        return
    if not matches(kind, data.get("tool_input") or data):
        return

    session = re.sub(r"[^A-Za-z0-9_-]", "", str(data.get("session_id") or "nosession"))[:64]
    counter = os.path.join(tempfile.gettempdir(), f"zali-graphify-{session}-{kind}")
    try:
        seen = int(open(counter).read() or 0)
    except (OSError, ValueError):
        seen = 0
    with open(counter, "w") as f:
        f.write(str(seen + 1))

    text = FULL[kind] if seen < FULL_TIMES else SHORT
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": text}}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
