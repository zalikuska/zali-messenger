#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 "$ROOT/scripts/bundle_web.py" >/dev/null

python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
protocol = json.loads((root / "web" / "bridge_protocol.json").read_text(encoding="utf-8"))
messages = protocol.get("messages", {})
if not isinstance(messages, dict) or not messages:
    raise SystemExit("bridge_protocol.json does not define any messages")

swift = (root / "apps" / "macos" / "Sources" / "ZaliMessenger" / "BridgeProtocol.generated.swift").read_text(encoding="utf-8")
native_types = (root / "web" / "src" / "modules" / "native_types.js").read_text(encoding="utf-8")
app_js = (root / "web" / "app.js").read_text(encoding="utf-8")
webview = (root / "apps" / "macos" / "Sources" / "ZaliMessenger" / "Views" / "WebView.swift").read_text(encoding="utf-8")

missing = []
for key in sorted(messages.keys()):
    if f'= "{key}"' not in swift:
        missing.append(f"macOS BridgeProtocol.generated.swift missing {key}")
    if f'{key}: "{key}"' not in native_types:
        missing.append(f"native_types.js missing {key}")
    if key not in app_js:
        missing.append(f"web/app.js missing {key}")

# Маршруты API объявлены дважды: modules/api_routes.js (window.ZaliApiRoutes) и
# DefaultApiRoutes в interface.js, а побеждает всегда первый. Правка/удаление
# сообщения были вписаны только во второй — и с 2026-08-18 удаление молча не работало
# ни на одной платформе, а правка — в браузере и на iOS (ошибка уходила в журнал).
import re

def route_group_keys(source, group):
    start = re.search(r"\b" + group + r"\s*:\s*\{", source)
    if not start:
        return set()
    depth, i = 1, start.end()
    while i < len(source) and depth:
        depth += {"{": 1, "}": -1}.get(source[i], 0)
        i += 1
    body = source[start.end():i - 1]
    return set(re.findall(r"^\s*([A-Za-z_]\w*)\s*:", body, re.M))

web_src = root / "web" / "src"
tables = {
    "modules/api_routes.js": (web_src / "modules" / "api_routes.js").read_text(encoding="utf-8"),
    "interface.js DefaultApiRoutes": (web_src / "interface.js").read_text(encoding="utf-8").split("const DefaultApiRoutes", 1)[-1],
}
used = set()
for path in web_src.rglob("*.js"):
    used.update(re.findall(r"apiRoutes\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)", path.read_text(encoding="utf-8")))
for group, name in sorted(used):
    for label, source in tables.items():
        if name not in route_group_keys(source, group):
            missing.append(f"{label} missing apiRoutes.{group}.{name}")

if "if type ==" in webview or "type == \"" in webview:
    missing.append("macOS WebView.swift still contains string-based type dispatch")

if missing:
    raise SystemExit("\n".join(missing))

print(f"bridge protocol coverage OK ({len(messages)} messages)")
PY

cargo check -q --manifest-path "$ROOT/apps/windows/Cargo.toml"
swift build --package-path "$ROOT/apps/macos" -c debug
# Каждый файл бандла по отдельности: ZaliInterface разложен по web/src/interface/*.js,
# и проверка одного interface.js пропустила бы синтаксическую ошибку в любой части.
while IFS= read -r rel; do
  node --check "$ROOT/web/src/$rel"
done < <(python3 -c "
import json, sys
m = json.load(open('$ROOT/web/src/manifest.json'))
for g in ('vendor', 'modules', 'core', 'interface', 'boot'):
    for rel in m.get(g, []):
        print(rel)
")
node --check "$ROOT/web/app.js"
