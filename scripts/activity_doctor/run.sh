#!/usr/bin/env bash
# activity-doctor — игровой статус «Играет в …»: приватность, контракт с
# оболочкой и сервером, недоверенный ввод.
#
#   ./scripts/activity_doctor/run.sh
#
# Исполняет боевой web/src/interface.js. Провал здесь — провал в продакшн-коде.
set -uo pipefail
cd "$(dirname "$0")/../.."

FAILED=0
echo ""
echo "──────── игровой статус (веб)"
node scripts/activity_doctor/check_activity.mjs || FAILED=1

echo ""
echo "──────── режим «в игре» (веб)"
node scripts/activity_doctor/check_focus.mjs || FAILED=1

echo ""
echo "──────── игровой статус (сервер)"
cargo test --manifest-path server/Cargo.toml -p zali_server --lib -- activity:: focus:: 2>&1 | tail -3 || FAILED=1

echo ""
if [ "$FAILED" = "0" ]; then echo "activity-doctor: all checks passed"; else echo "activity-doctor: FAILURES"; fi
exit $FAILED
