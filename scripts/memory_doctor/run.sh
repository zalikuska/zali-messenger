#!/usr/bin/env bash
# memory-doctor — retention checks for the browser/PWA client.
#
#   ./scripts/memory_doctor/run.sh
#
# The invariant is not "memory is small" but "re-syncing a conversation costs
# memory proportional to the conversation, not to the number of syncs". Every
# check runs the real web/src/interface.js.
set -uo pipefail
cd "$(dirname "$0")/../.."

FAILED=0
run() {
  local label="$1"; shift
  echo ""
  echo "──────── $label"
  if "$@"; then :; else FAILED=1; echo "  ✗ $label failed"; fi
}

run "browser client retention" node scripts/memory_doctor/check_browser_memory.mjs

echo ""
if [ "$FAILED" = "0" ]; then echo "memory-doctor: all checks passed"; else echo "memory-doctor: FAILURES"; fi
exit $FAILED
