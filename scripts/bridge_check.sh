#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 "$ROOT/bundle_web.py" >/dev/null

python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
protocol = json.loads((root / "Web" / "bridge_protocol.json").read_text(encoding="utf-8"))
messages = protocol.get("messages", {})
if not isinstance(messages, dict) or not messages:
    raise SystemExit("bridge_protocol.json does not define any messages")

swift = (root / "macOS" / "Sources" / "ZaliMessenger" / "BridgeProtocol.generated.swift").read_text(encoding="utf-8")
native_types = (root / "Web" / "src" / "modules" / "native_types.js").read_text(encoding="utf-8")
app_js = (root / "Web" / "app.js").read_text(encoding="utf-8")
webview = (root / "macOS" / "Sources" / "ZaliMessenger" / "Views" / "WebView.swift").read_text(encoding="utf-8")

missing = []
for key in sorted(messages.keys()):
    if f'= "{key}"' not in swift:
        missing.append(f"macOS BridgeProtocol.generated.swift missing {key}")
    if f'{key}: "{key}"' not in native_types:
        missing.append(f"native_types.js missing {key}")
    if key not in app_js:
        missing.append(f"Web/app.js missing {key}")

if "if type ==" in webview or "type == \"" in webview:
    missing.append("macOS WebView.swift still contains string-based type dispatch")

if missing:
    raise SystemExit("\n".join(missing))

print(f"bridge protocol coverage OK ({len(messages)} messages)")
PY

cargo check -q --manifest-path "$ROOT/Windows/Cargo.toml"
swift build --package-path "$ROOT/macOS" -c debug
node --check "$ROOT/Web/src/interface.js"
node --check "$ROOT/Web/app.js"
