#!/usr/bin/env bash
# security-doctor — invariants that keep an attacker off the native bridge.
#
#   ./scripts/security_doctor/run.sh          # static checks (fast, CI-safe)
#   ./scripts/security_doctor/run.sh --tests  # + the server integration tests
#   ./scripts/security_doctor/run.sh --all
#
# The static half exists because the parts it covers have no runtime test at
# all: none of the four native shells are exercised by `cargo test` or by the JS
# harnesses, and they are exactly where a mistake hands the session token and the
# conversation keys to a page the user merely tapped a link to.
set -uo pipefail
cd "$(dirname "$0")/../.."

WITH_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --tests|--all) WITH_TESTS=1 ;;
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

run "native shells (origin pin, media capture)" node scripts/security_doctor/check_native_shells.mjs
run "server (credentials, rate limits, stored secrets, headers)" node scripts/security_doctor/check_server.mjs
run "web UI (escaping, sinks, links, key material)" node scripts/security_doctor/check_web.mjs

if [ "$WITH_TESTS" = "1" ]; then
  # Behaviour, against a real server on a real socket. Slower than the rules
  # above mostly because the rate-limit cases have to lose real bcrypt rounds.
  run "server integration tests" \
      cargo test --manifest-path server/Cargo.toml --test security --quiet
fi

echo ""
if [ "$FAILED" = "0" ]; then
  echo "security-doctor: all checks passed"
else
  echo "security-doctor: FAILURES"
fi
exit $FAILED
