#!/usr/bin/env bash
# Шарды тестов сервера для CI (job `server` в .github/workflows/ci.yml): один
# шард — одна параллельная машина.
#
#   scripts/ci_server_tests.sh <шард>      # прогнать шард
#   scripts/ci_server_tests.sh --check     # только сверка состава шардов
#   scripts/ci_server_tests.sh --list      # имена шардов (для matrix)
#
# Шарды названы по тяжёлым файлам; `rest` — это ВСЕ интеграционные тесты из
# server/Cargo.toml, не назначенные другим шардам, так что новый [[test]]
# попадает в CI сам и молча не теряется. Если файл переименовали, а здесь он
# остался старым именем — скрипт падает, а не пропускает его.
#
# Токен `имя@K/N` — K-я из N частей ОДНОГО тест-файла, поделённого по именам
# тестов (отсортированным); так делится hash_chain.rs, который один занимает
# больше всех остальных шардов. Такой токен — единственный в своём шарде.
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST=server/Cargo.toml

SHARDS="chain1 chain2 security core economy social rest"

# Балансировка по времени прогона на раннере CI (секунды): hash_chain 152 (две части
# по ~76), security 40, servers_channels_roles 24, coin_gifts 22, addons 17,
# conversation_keys 15, lib 14, moderation 13, treasury 13, voice 13, profiles 11.
named_tests() {
  case "$1" in
    chain1)   echo "hash_chain@1/2" ;;
    chain2)   echo "hash_chain@2/2" ;;
    security) echo "security raffles" ;;
    core)     echo "lib addons addon_cloud addon_store treasury" ;;
    economy)  echo "coin_gifts servers_channels_roles moderation" ;;
    social)   echo "conversation_keys voice profiles messages_and_realtime" ;;
    rest)     echo "" ;;
    *) echo "неизвестный шард: $1 ($SHARDS)" >&2; exit 2 ;;
  esac
}

all_integration_tests() {
  awk '/^\[\[test\]\]/{t=1; next} /^\[/{t=0} t && /^name = /{gsub(/"/,"",$3); print $3}' "$MANIFEST"
}

# Базовые имена (без @K/N) всего, что назначено шардам кроме rest.
assigned_elsewhere() {
  local s t
  for s in $SHARDS; do
    [ "$s" = rest ] && continue
    for t in $(named_tests "$s"); do echo "${t%@*}"; done
  done | sort -u
}

# Список целей шарда: `lib`, имя интеграционного теста или `имя@K/N`.
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
  local known base s t n k seen
  known="$(all_integration_tests)"
  for base in $(assigned_elsewhere); do
    [ "$base" = lib ] && continue
    echo "$known" | grep -qx "$base" || { echo "ОШИБКА: '$base' назначен шарду, но [[test]] с таким именем нет в $MANIFEST" >&2; exit 1; }
  done
  # Тест не должен оказаться в двух шардах целиком, а поделённый файл — потерять часть.
  for s in $SHARDS; do
    for t in $(shard_targets "$s"); do
      case "$t" in
        *@*)
          [ "$(shard_targets "$s" | wc -l | tr -d ' ')" = 1 ] || { echo "ОШИБКА: $t должен быть единственным в шарде $s" >&2; exit 1; }
          n="${t#*/}"; k="${t#*@}"; k="${k%/*}"
          seen=""
          for x in $SHARDS; do
            for y in $(shard_targets "$x"); do [ "${y%@*}" = "${t%@*}" ] && seen="$seen $y"; done
          done
          [ "$(echo $seen | wc -w | tr -d ' ')" = "$n" ] || { echo "ОШИБКА: ${t%@*} поделён на $n части, а в шардах их: $seen" >&2; exit 1; }
          ;;
      esac
    done
  done
  for s in $SHARDS; do
    echo "$s: $(shard_targets "$s" | tr '\n' ' ')"
  done
}

case "${1:-}" in
  --check) check; exit 0 ;;
  --list)  echo "$SHARDS"; exit 0 ;;
  "")      echo "укажи шард: $SHARDS" >&2; exit 2 ;;
esac

SHARD="$1"
check >/dev/null   # сверка состава перед каждым прогоном

TARGETS="$(shard_targets "$SHARD")"
[ -n "$TARGETS" ] || { echo "шард '$SHARD' пуст" >&2; exit 1; }

# Поделённый файл: имена тестов этой части — через `-- --exact`.
case "$TARGETS" in
  *@*)
    base="${TARGETS%@*}"; k="${TARGETS#*@}"; n="${k#*/}"; k="${k%/*}"
    # Сборка тест-бинарника — здесь же, повторный cargo test ниже возьмёт её из кэша.
    names=()
    while IFS= read -r line; do names+=("$line"); done < <(
      cargo test --manifest-path "$MANIFEST" --locked --test "$base" -- --list --format terse 2>/dev/null \
        | sed -n 's/: test$//p' | sort | awk -v k="$k" -v n="$n" '(NR - 1) % n == k - 1'
    )
    [ "${#names[@]}" -gt 0 ] || { echo "в $base не нашлось тестов для части $k/$n" >&2; exit 1; }
    echo "cargo test --test $base (часть $k/$n, ${#names[@]} тестов)"
    exec cargo test --manifest-path "$MANIFEST" --locked --test "$base" -- --exact "${names[@]}"
    ;;
esac

ARGS=()
for t in $TARGETS; do
  if [ "$t" = lib ]; then ARGS+=(--lib); else ARGS+=(--test "$t"); fi
done
echo "cargo test ${ARGS[*]}"
exec cargo test --manifest-path "$MANIFEST" --locked "${ARGS[@]}"
