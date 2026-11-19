#!/usr/bin/env bash
# Шарды тестов сервера для CI (job `server` в .github/workflows/ci.yml): один
# шард — одна параллельная машина.
#
#   scripts/ci_server_tests.sh chain|security|core|rest   # прогнать шард
#   scripts/ci_server_tests.sh --check                    # только сверка состава шардов
#
# Шарды названы по тяжёлым файлам; `rest` — это ВСЕ интеграционные тесты из
# server/Cargo.toml, не назначенные другим шардам, так что новый [[test]]
# попадает в CI сам и молча не теряется. Если файл переименовали, а здесь он
# остался старым именем — скрипт падает, а не пропускает его.
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST=server/Cargo.toml

# Балансировка по времени прогона (локально, секунды): hash_chain 63;
# security 42 + moderation 18 + raffles 10; остальное делится поровну.
named_tests() {
  case "$1" in
    chain)    echo "hash_chain" ;;
    security) echo "security moderation raffles" ;;
    core)     echo "lib coin_gifts treasury addons addon_store addon_cloud servers_channels_roles" ;;
    rest)     echo "" ;;
    *) echo "неизвестный шард: $1 (chain|security|core|rest)" >&2; exit 2 ;;
  esac
}

all_integration_tests() {
  sed -n 's/^name = "\(.*\)"$/\1/p' <(awk '/^\[\[test\]\]/{t=1; next} /^\[/{t=0} t' "$MANIFEST")
}

assigned_elsewhere() {
  for s in chain security core; do named_tests "$s"; done | tr ' ' '\n' | sed '/^$/d'
}

# Список целей шарда: `lib` или имя интеграционного теста.
shard_targets() {
  local shard="$1" t
  if [ "$shard" = rest ]; then
    for t in $(all_integration_tests); do
      assigned_elsewhere | grep -qx "$t" || echo "$t"
    done
  else
    for t in $(named_tests "$shard"); do echo "$t"; done
  fi
}

check() {
  local known t
  known="$(all_integration_tests)"
  for t in $(assigned_elsewhere); do
    [ "$t" = lib ] && continue
    echo "$known" | grep -qx "$t" || { echo "ОШИБКА: '$t' назначен шарду, но [[test]] с таким именем нет в $MANIFEST" >&2; exit 1; }
  done
  for s in chain security core rest; do
    echo "$s: $(shard_targets "$s" | tr '\n' ' ')"
  done
}

if [ "${1:-}" = "--check" ]; then
  check
  exit 0
fi

SHARD="${1:?укажи шард: chain|security|core|rest}"
check >/dev/null   # сверка состава перед каждым прогоном

ARGS=()
while IFS= read -r t; do
  [ -z "$t" ] && continue
  if [ "$t" = lib ]; then ARGS+=(--lib); else ARGS+=(--test "$t"); fi
done < <(shard_targets "$SHARD")

[ "${#ARGS[@]}" -gt 0 ] || { echo "шард '$SHARD' пуст" >&2; exit 1; }
echo "cargo test ${ARGS[*]}"
exec cargo test --manifest-path "$MANIFEST" --locked "${ARGS[@]}"
