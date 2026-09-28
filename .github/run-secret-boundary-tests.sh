#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
: "${DATABASE_URL:?DATABASE_URL is required for the sterile security test boundary}"
if [[ "${SECRET_BOUNDARY_REQUIRE_ISOLATED_DB:-0}" == "1" && "$DATABASE_URL" != */tau_secret_boundary_test ]]; then
  echo "Sterile secret-boundary CI requires its isolated database" >&2
  exit 1
fi
if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc 'SELECT 1' >/dev/null 2>&1; then
  echo "Sterile secret-boundary database is unreachable" >&2
  exit 1
fi

run_sterile() {
  # Defense in depth around the shared sterile preload: inherit no ambient
  # credentials and reintroduce only the non-secret process inputs required.
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    DATABASE_URL="$DATABASE_URL" \
    CI=true \
    TERM="${TERM:-dumb}" \
    NODE_ENV=test \
    FICUS_TEST_MODE=1 \
    SECRET_BOUNDARY_REQUIRE_ISOLATED_DB="${SECRET_BOUNDARY_REQUIRE_ISOLATED_DB:-0}" \
    FICUS_TEST_SCHEMA_PUSH_NO_FORCE=1 \
    FICUS_TEST_SKIP_SUBPROCESS=1 \
    timeout --foreground 30s bun test "$@" || {
      status=$?
      if [[ "$status" == "124" ]]; then
        echo "Sterile secret-boundary test process timed out during noninteractive setup or execution" >&2
      fi
      return "$status"
    }
}

# Every suite runs in its own process so module cycles and singleton/timer state
# cannot make the security gate depend on Bun's cross-file evaluation order.
security_tests=(
  apps/core/src/services/security/content-safety-registry.test.ts
  apps/core/src/services/security/content-safety.test.ts
  apps/core/src/services/security/logger-content-safety.test.ts
  apps/core/src/services/security/stored-secret-tool-audit.test.ts
  apps/core/src/services/security/stored-secret-tool-containment.test.ts
  apps/core/src/services/security/tool-output-redaction.test.ts
)
legacy_tests=(
  apps/core/src/services/secrets/store-hermetic.test.ts
  apps/core/src/services/secrets/store.test.ts
  apps/core/src/entities/agent-runners/base.test.ts
)
for test_file in "${security_tests[@]}" "${legacy_tests[@]}"; do
  run_sterile "$test_file"
done
