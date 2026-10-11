#!/usr/bin/env bash
# ui-doctor — общие UI-компоненты: стилизованные выпадающие списки, полосы прокрутки.
#
#   ./scripts/ui_doctor/run.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

FAILED=0
echo ""
echo "──────── выпадающие списки и прокрутка"
node scripts/ui_doctor/check_select.mjs || FAILED=1

echo ""
if [ "$FAILED" = "0" ]; then echo "ui-doctor: all checks passed"; else echo "ui-doctor: FAILURES"; fi
exit $FAILED
