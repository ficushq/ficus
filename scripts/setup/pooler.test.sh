#!/usr/bin/env bash
# pooler.test.sh — unit tests for the per-host PgBouncer helpers in lib.sh
# (the pieces setup-host.sh's phase_pooler and phase_env compose): the pooled
# loopback DSN, the rendered pgbouncer.ini + userlist, the pooler unit, the
# core units' After= ordering, the .env database lines, and that no password
# ever lands in the ini or the unit.
#
# Pure renders — no pgbouncer, no postgres, no systemd needed.
#
# Run: bash scripts/setup/pooler.test.sh
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PASS=0 FAIL=0
expect_eq() { # DESCRIPTION ACTUAL EXPECTED
  if [[ $2 == "$3" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected %q, got %q\n' "$1" "$3" "$2" >&2
  fi
}
expect_contains() { # DESCRIPTION HAYSTACK NEEDLE
  if [[ $2 == *"$3"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — %q not found in:\n%s\n' "$1" "$3" "$2" >&2
  fi
}
expect_not_contains() { # DESCRIPTION HAYSTACK NEEDLE
  if [[ $2 != *"$3"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — %q unexpectedly found\n' "$1" "$3" >&2
  fi
}

SCRATCH=$(mktemp -d -t ficus-pooler-test.XXXXXX)
cleanup() { rm -rf "${SCRATCH}"; }
trap cleanup EXIT

export FICUS_HOST_ROOT="${SCRATCH}/host-root" FICUS_SYSTEMD_UNIT_DIR="${SCRATCH}/host-root/units"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# A platform-style tenant DSN: URL-encoded password, verify-full, sslrootcert.
DSN='postgresql://tenant_ab12_acme:p%2Fw-123@private-db.example.test:25060/ficus_ab12_acme?sslmode=verify-full&sslrootcert=%2Fetc%2Fficus%2Fdatabase-ca.crt'

# --- pooled DSN -------------------------------------------------------------
pooled=$(db_pooled_dsn "${DSN}" 6432)
expect_eq 'pooled DSN is loopback, same user/password/db, no TLS params' \
  "${pooled}" 'postgresql://tenant_ab12_acme:p%2Fw-123@127.0.0.1:6432/ficus_ab12_acme'

# --- pgbouncer.ini ----------------------------------------------------------
ini=$(render_pgbouncer_ini "${DSN}" 4 2 /etc/ficus/database-ca.crt 6432 /etc/ficus/pgbouncer/userlist.txt)
expect_contains 'ini maps the database to the cluster host' "${ini}" \
  'ficus_ab12_acme = host=private-db.example.test port=25060 dbname=ficus_ab12_acme'
for line in \
  'listen_addr = 127.0.0.1' \
  'listen_port = 6432' \
  'auth_type = scram-sha-256' \
  'auth_file = /etc/ficus/pgbouncer/userlist.txt' \
  'admin_users = tenant_ab12_acme' \
  'pool_mode = transaction' \
  'default_pool_size = 4' \
  'reserve_pool_size = 2' \
  'reserve_pool_timeout = 1' \
  'server_idle_timeout = 60' \
  'max_client_conn = 100' \
  'max_prepared_statements = 200' \
  'server_tls_sslmode = verify-full' \
  'server_tls_ca_file = /etc/ficus/database-ca.crt'; do
  expect_contains "ini has '${line}'" "${ini}" "${line}"
done
expect_not_contains 'ini never carries the encoded password' "${ini}" 'p%2Fw-123'
expect_not_contains 'ini never carries the decoded password' "${ini}" 'p/w-123'

# --- userlist ---------------------------------------------------------------
userlist=$(render_pgbouncer_userlist "${DSN}")
expect_eq 'userlist is the role and the DECODED password' "${userlist}" '"tenant_ab12_acme" "p/w-123"'

# --- pooler unit ------------------------------------------------------------
RUN_USER=ficus
unit=$(render_pooler_unit "${SCRIPT_DIR}/systemd/ficus-pgbouncer.service.tmpl" /etc/ficus/pgbouncer/pgbouncer.ini)
expect_contains 'unit runs pgbouncer on the rendered ini' "${unit}" 'ExecStart=/usr/sbin/pgbouncer /etc/ficus/pgbouncer/pgbouncer.ini'
expect_contains 'unit runs as the service user' "${unit}" 'User=ficus'
expect_not_contains 'unit has no unrendered placeholder' "${unit}" '@'

# --- core units' ordering ---------------------------------------------------
HL_UNIT_POOLER=ficus-pgbouncer
expect_eq 'container database: units wait for docker' "$(DB_MODE=container POOL_ENABLED=false core_unit_db_after)" ' docker.service'
expect_eq 'external, unpooled: no extra ordering' "$(DB_MODE=external POOL_ENABLED=false core_unit_db_after)" ''
expect_eq 'external, pooled: units wait for the pooler' "$(DB_MODE=external POOL_ENABLED=true core_unit_db_after)" ' ficus-pgbouncer.service'

# --- .env database lines ----------------------------------------------------
lines=$(render_database_env_lines real "${DSN}" false 6432)
expect_eq 'unpooled .env is exactly today' "${lines}" "DATABASE_URL=${DSN}"
lines=$(render_database_env_lines real "${DSN}" true 6432)
expect_eq 'pooled .env: pooled URL, direct URL, pool mode' "${lines}" \
  "DATABASE_URL=${pooled}
DATABASE_DIRECT_URL=${DSN}
DATABASE_POOL_MODE=transaction"
lines=$(render_database_env_lines redact "${DSN}" true 6432)
expect_eq 'pooled dry run redacts both DSNs' "${lines}" \
  'DATABASE_URL=<pooled dsn, redacted>
DATABASE_DIRECT_URL=<external dsn, redacted>
DATABASE_POOL_MODE=transaction'

# --- the backup script prefers the direct DSN ------------------------------
expect_contains 'backup template reads DATABASE_DIRECT_URL before DATABASE_URL' \
  "$(cat "${SCRIPT_DIR}/ficus-backup.sh.tmpl")" 'DATABASE_DIRECT_URL'

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ ${FAIL} -eq 0 ]]
