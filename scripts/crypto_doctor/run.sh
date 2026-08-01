#!/usr/bin/env bash
# crypto-doctor — encryption and, above all, conversation-key synchronisation.
#
#   ./scripts/crypto_doctor/run.sh            # JS layers (fast, CI-safe)
#   ./scripts/crypto_doctor/run.sh --archive  # + the Rust .zali archive/format tests
#   ./scripts/crypto_doctor/run.sh --all
set -uo pipefail
cd "$(dirname "$0")/../.."

WITH_ARCHIVE=0
for arg in "$@"; do
  case "$arg" in
    --archive|--all) WITH_ARCHIVE=1 ;;
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

run "source invariants" node scripts/crypto_doctor/check_source.mjs
run "crypto primitives (envelopes, vault, fingerprints, RNG)" \
    node scripts/crypto_doctor/check_crypto.mjs
run "key synchronisation (real client code, simulated server)" \
    node scripts/crypto_doctor/check_keysync.mjs

if [ "$WITH_ARCHIVE" = "1" ]; then
  # The .zali archive layer (AES-256-GCM chunking, per-chunk nonce derivation,
  # PBKDF2) lives in Rust and Swift, not in the JS client — its own test suites
  # are the authority, including the byte-for-byte interop cases.
  run "archive SDK (Rust)" cargo test --manifest-path sdk/Rust/Cargo.toml --quiet
  run "core (Rust)" cargo test --manifest-path core/Cargo.toml --quiet
fi

echo ""
if [ "$FAILED" = "0" ]; then echo "crypto-doctor: all checks passed"; else echo "crypto-doctor: FAILURES"; fi
exit $FAILED
