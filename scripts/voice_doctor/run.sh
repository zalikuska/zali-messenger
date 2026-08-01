#!/usr/bin/env bash
# voice-doctor — everything that can go silently wrong with a call, checked.
#
#   ./scripts/voice_doctor/run.sh              # offline layers (fast, CI-safe)
#   ./scripts/voice_doctor/run.sh --turn       # + live TURN path against prod
#   ./scripts/voice_doctor/run.sh --engine     # + WKWebView engine probes (macOS)
#   ./scripts/voice_doctor/run.sh --all
set -uo pipefail
cd "$(dirname "$0")/../.."

WITH_TURN=0; WITH_ENGINE=0
for arg in "$@"; do
  case "$arg" in
    --turn) WITH_TURN=1 ;;
    --engine) WITH_ENGINE=1 ;;
    --all) WITH_TURN=1; WITH_ENGINE=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

FAILED=0
run() {
  local label="$1"; shift
  echo ""
  echo "──────── $label"
  if "$@"; then :; else FAILED=1; echo "  ✗ $label failed"; fi
}

run "source invariants" node scripts/voice_doctor/check_source.mjs
run "negotiation (real client code, simulated server, virtual time)" \
    node scripts/voice_doctor/check_negotiation.mjs

if [ "$WITH_TURN" = "1" ]; then
  run "live TURN relay path" python3 scripts/voice_doctor/check_turn.py
fi

if [ "$WITH_ENGINE" = "1" ]; then
  echo ""
  echo "──────── WKWebView engine probes"
  if ! command -v swift >/dev/null 2>&1; then
    echo "  skipped: swift not available"
  else
    PORT=8791
    python3 -m http.server "$PORT" --directory scripts/voice_doctor/engine >/dev/null 2>&1 &
    SERVER_PID=$!
    trap 'kill $SERVER_PID 2>/dev/null' EXIT
    sleep 1
    # One page load per check: a stalled AudioContext blocks WKWebView's JS thread,
    # which would swallow every later check in the same page.
    for n in 1 2 3 4; do
      swift scripts/voice_doctor/engine/host.swift "http://localhost:$PORT/index.html?only=$n" 2>&1 \
        | grep -v '"check":"env"' | grep -v '"check":"done"' | sed 's/^/  /'
    done
    kill $SERVER_PID 2>/dev/null
    trap - EXIT
  fi
fi

echo ""
if [ "$FAILED" = "0" ]; then echo "voice-doctor: all checks passed"; else echo "voice-doctor: FAILURES"; fi
exit $FAILED
