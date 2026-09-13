#!/usr/bin/env bash
# notify-doctor — доходит ли уведомление о сообщении до пользователя.
#
#   ./scripts/notify_doctor/run.sh
#
# Исполняет боевой web/src/interface.js. Провал здесь — провал в продакшн-коде.
set -uo pipefail
cd "$(dirname "$0")/../.."

FAILED=0
run() {
  local label="$1"; shift
  echo ""
  echo "──────── $label"
  if "$@"; then :; else FAILED=1; echo "  ✗ $label failed"; fi
}

run "уведомления" node scripts/notify_doctor/check_notifications.mjs
run "service worker" node scripts/notify_doctor/check_service_worker.mjs

echo ""
if [ "$FAILED" = "0" ]; then echo "notify-doctor: all checks passed"; else echo "notify-doctor: FAILURES"; fi
exit $FAILED
