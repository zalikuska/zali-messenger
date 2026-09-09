#!/usr/bin/env bash
# perf-doctor — проверки цены интерфейса.
#
#   ./scripts/perf_doctor/run.sh
#
# Инвариант тот же по духу, что у memory_doctor: не «быстро», а
#
#   > стоимость действия пропорциональна самому действию,
#   > а не размеру всего, что уже накоплено
#
# Каждая проверка исполняет боевой web/src/interface.js. Провал здесь —
# это провал в продакшн-коде, а не в харнессе.
set -uo pipefail
cd "$(dirname "$0")/../.."

FAILED=0
run() {
  local label="$1"; shift
  echo ""
  echo "──────── $label"
  if "$@"; then :; else FAILED=1; echo "  ✗ $label failed"; fi
}

run "цена кадра отрисовки"  node scripts/perf_doctor/check_render_payload.mjs
run "цена сохранения кэша"  node scripts/perf_doctor/check_persist_cost.mjs
run "горячие пути"          node scripts/perf_doctor/check_hot_paths.mjs
run "политика кеша"         node scripts/perf_doctor/check_cache_policy.mjs

echo ""
if [ "$FAILED" = "0" ]; then echo "perf-doctor: all checks passed"; else echo "perf-doctor: FAILURES"; fi
exit $FAILED
