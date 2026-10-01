#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CORE="$ROOT/apps/core"
POLICY="$CORE/src/services/rbac/agent-resource-access.ts"
ENTITY="$CORE/src/middleware/require-entity-permission.ts"
AGENTS="$CORE/src/routes/agents.ts"
INBOX="$CORE/src/routes/inbox.ts"
MONITORS="$CORE/src/routes/monitors.ts"
FILES=("$POLICY" "$ENTITY" "$AGENTS" "$INBOX" "$MONITORS")
TMP=$(mktemp -d)

[[ -n ${DATABASE_URL:-} && "$DATABASE_URL" == */ficus_test && "$DATABASE_URL" != *:5432/* ]] || {
  echo 'DATABASE_URL must name an owned /ficus_test database on a non-5432 port' >&2
  exit 2
}

for file in "${FILES[@]}"; do cp "$file" "$TMP/$(basename "$file")"; done
before=$(shasum -a 256 "${FILES[@]}")
restore() {
  for file in "${FILES[@]}"; do cp "$TMP/$(basename "$file")" "$file"; done
}
cleanup() {
  restore
  [[ "$(shasum -a 256 "${FILES[@]}")" == "$before" ]] || {
    echo 'source restoration hash mismatch' >&2
    exit 1
  }
  rm -rf "$TMP"
}
trap cleanup EXIT

run_test() {
  local file=$1 pattern=$2
  (cd "$CORE" && bun test "$file" --test-name-pattern "$pattern")
}

run_test src/services/rbac/agent-resource-access.test.ts 'enforces squad, private owner'
run_test src/middleware/require-entity-permission.test.ts 'user-less agent cannot'
run_test src/routes/agents.orphan-auth.test.ts 'enforces orphan agent REST policy'
run_test src/routes/agents.orphan-auth.test.ts 'enforces private agent hard-delete ownership'
run_test src/routes/inbox.private-agent-auth.test.ts 'keeps private agent inbox content owner-exclusive'
run_test src/routes/inbox-amtp-attachments.test.ts 'foreign wildcard-backed agent cannot reuse a private attachment'
run_test src/routes/monitors.private-agent-auth.test.ts 'keeps private monitor reads owner-exclusive'

mutate() {
  local name=$1
  local target_file=$2
  local old=$3
  local new=$4
  local test_file=$5
  local pattern=$6
  restore
  OLD="$old" NEW="$new" FILE="$target_file" python3 - <<'PY'
import os
p=os.environ['FILE']; old=os.environ['OLD']; new=os.environ['NEW']; s=open(p).read()
if s.count(old) != 1: raise SystemExit(f'mutation seam count was {s.count(old)}, expected 1')
open(p, 'w').write(s.replace(old, new))
PY
  local output status
  set +e
  output=$(run_test "$test_file" "$pattern" 2>&1)
  status=$?
  set -e
  local marker
  case "$name" in
    owner-equality) marker='Expected: 200' ;;
    inbox-missing-child) marker='Expected: 403' ;;
    inbox-anti-exfil) marker='Expected: 400' ;;
    attachment-override-removal|monitor-cancel-override-removal) marker='Expected: 200' ;;
    monitor-filter-owner) marker='Expected to not contain' ;;
    monitor-entity-wiring) marker='Expected number of calls: 0' ;;
    *) marker='Expected: 403' ;;
  esac
  if [[ $status -eq 0 || "$output" != *"$pattern"* || "$output" != *"$marker"* ]]; then
    printf '%s\n' "$output" >&2
    echo "SURVIVED OR INVALID: $name (missing intended marker: $marker)" >&2
    exit 1
  fi
  echo "KILLED: $name"
}

mutate owner-equality "$POLICY" \
  'if (target.ownerUserId) return identityUserId(identity) === target.ownerUserId' \
  'if (target.ownerUserId) return false' \
  src/routes/inbox.private-agent-auth.test.ts 'keeps private agent inbox content owner-exclusive'
mutate generic-orphan-denial "$ENTITY" \
  'if (squadId === null && isUserlessAgentIdentity(identity)) {' \
  'if (false) {' \
  src/routes/agents.orphan-auth.test.ts 'enforces orphan agent REST policy'
mutate agent-delete-wiring "$AGENTS" \
  "requireAgentResourcePermission('agents:delete', (c) => Agent.find(c.req.param('id')))" \
  "requireEntityPermission('agents:delete', async (c) => agentSquadId(c.req.param('id')))" \
  src/routes/agents.orphan-auth.test.ts 'enforces private agent hard-delete ownership'
mutate inbox-self-precedence "$INBOX" \
  'if (!targetAgent.squadId) {' \
  $'if (identity.agentId === recipientId) return null\n    if (!targetAgent.squadId) {' \
  src/routes/inbox.private-agent-auth.test.ts 'keeps private agent inbox content owner-exclusive'
mutate inbox-missing-child "$INBOX" \
  "if (!message) return { response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) }" \
  "if (!message) return { response: new Response(JSON.stringify({ error: 'Inbox message not found' }), { status: 404 }) }" \
  src/routes/inbox.private-agent-auth.test.ts 'keeps private agent inbox content owner-exclusive'
mutate inbox-anti-exfil "$INBOX" \
  'if (denial) return c.json({ error: '\''Attachment not accessible'\'' }, 400)' \
  'if (false) return c.json({ error: '\''Attachment not accessible'\'' }, 400)' \
  src/routes/inbox-amtp-attachments.test.ts 'foreign wildcard-backed agent cannot reuse a private attachment'
mutate attachment-override-removal "$INBOX" \
  'result.attachment &&' \
  'false && result.attachment &&' \
  src/routes/inbox.private-agent-auth.test.ts 'keeps private agent inbox content owner-exclusive'
mutate monitor-filter-owner "$MONITORS" \
  'if (target.ownerUserId) return ownerUserId === target.ownerUserId' \
  'if (target.ownerUserId) return true' \
  src/routes/monitors.private-agent-auth.test.ts 'keeps private monitor reads owner-exclusive'
mutate monitor-cancel-override-removal "$MONITORS" \
  'allowGlobalOverride: true' \
  'allowGlobalOverride: false' \
  src/routes/monitors.private-agent-auth.test.ts 'keeps private monitor reads owner-exclusive'
mutate monitor-entity-wiring "$MONITORS" \
  'return Agent.find(monitor.agentId)' \
  'return { squadId: null, ownerUserId: null }' \
  src/routes/monitors.private-agent-auth.test.ts 'keeps private monitor reads owner-exclusive'

restore
echo 'All ten private-agent REST authorization mutations were killed.'
