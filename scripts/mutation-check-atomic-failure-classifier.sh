#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
root=$(git rev-parse --show-toplevel)
prod="$root/packages/sandbox-server/src/services/atomic-write.ts"
testsrc="$root/packages/sandbox-server/src/services/atomic-write.test.ts"
: "${DATABASE_URL:?DATABASE_URL must name the explicitly owned worktree test database}"
: "${TEST_DB_PROJECT:?TEST_DB_PROJECT must name the explicitly owned ficus-test-* project}"
[[ $TEST_DB_PROJECT == ficus-test-* ]] || { echo 'TEST_DB_PROJECT must start with ficus-test-' >&2; exit 2; }
[[ $(bun --version) == "$(cat "$root/.bun-version")" ]]

case "$mode" in
  conflict-generic-pre) boundary='classifier-conflict-code'; signature='Received: "pre-publication"' ;;
  nested-primary-bypass) boundary='classifier-nested-primary'; signature='Received: "pre-publication"' ;;
  generic-pre-wrong) boundary='classifier-generic-pre-code'; signature='Received: "post-publication"' ;;
  post-wrong) boundary='classifier-post-code'; signature='Received: "pre-publication"' ;;
  rename-unknown-wrong) boundary='classifier-rename-code'; signature='Received: "pre-publication"' ;;
  trust-unbranded-spoof) boundary='classifier-unbranded-spoof'; signature='Received: "edit-conflict"' ;;
  *) echo "unknown classifier mutation mode: $mode" >&2; exit 2 ;;
esac

[[ -z $(git -C "$root" status --short -- "$prod" "$testsrc") ]] || { echo 'mutation sources must be clean' >&2; exit 2; }
baseline_status=$(git -C "$root" status --porcelain)
baseline_hash=$(sha256sum "$prod" | cut -d' ' -f1)
backup="$prod.classifier-backup.$$"
work=$(mktemp -d "${TMPDIR:-/tmp}/atomic-classifier-mutation.XXXXXX")
log="$work/output.log"

atomic_copy() {
  python3 - "$1" "$2" <<'PY'
from pathlib import Path
import os,sys,tempfile
source=Path(sys.argv[1]); target=Path(sys.argv[2]); data=source.read_bytes()
fd,tmp=tempfile.mkstemp(dir=target.parent,prefix='.'+target.name+'.',suffix='.atomic')
try:
  with os.fdopen(fd,'wb') as handle: handle.write(data); handle.flush(); os.fsync(handle.fileno())
  os.replace(tmp,target)
  directory=os.open(target.parent,os.O_RDONLY); os.fsync(directory); os.close(directory)
finally:
  if os.path.exists(tmp): os.unlink(tmp)
PY
}
atomic_copy "$prod" "$backup"
cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  if [[ -f $backup ]]; then atomic_copy "$backup" "$prod" || status=1; rm -f "$backup"; fi
  rm -rf "$work"
  (cd "$root/apps/core" && bun run test:db:down >/dev/null 2>&1) || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

MODE=$mode PROD=$prod python3 - <<'PY'
from pathlib import Path
import os,tempfile
path=Path(os.environ['PROD']); mode=os.environ['MODE']; source=path.read_text()
mutations={
'conflict-generic-pre':('  return primary.failureCode\n',"  return primary.failureCode === 'edit-conflict' ? 'pre-publication' : primary.failureCode\n"),
'nested-primary-bypass':('  return error.errors.length > 0 ? primaryError(error.errors[0]) : undefined\n','  return error.errors.length > 0 ? primaryError(error.errors.at(-1)) : undefined\n'),
'generic-pre-wrong':('  return primary.failureCode\n',"  return primary.failureCode === 'pre-publication' ? 'post-publication' : primary.failureCode\n"),
'post-wrong':('  return primary.failureCode\n',"  return primary.failureCode === 'post-publication' ? 'pre-publication' : primary.failureCode\n"),
'rename-unknown-wrong':('  return primary.failureCode\n',"  return primary.failureCode === 'rename-outcome-unknown' ? 'pre-publication' : primary.failureCode\n"),
'trust-unbranded-spoof':('  if (!(primary instanceof PublicAtomicWriteError)) return undefined\n',"  if (!(primary instanceof PublicAtomicWriteError)) {\n    if (primary instanceof Error && primary.message.startsWith('Edit conflict')) return 'edit-conflict'\n    return undefined\n  }\n"),
}
old,new=mutations[mode]
if source.count(old)!=1: raise SystemExit(f'exact mutation source count was {source.count(old)}, expected 1')
data=source.replace(old,new).encode()
fd,tmp=tempfile.mkstemp(dir=path.parent,prefix='.'+path.name+'.',suffix='.mutation')
try:
  with os.fdopen(fd,'wb') as handle: handle.write(data); handle.flush(); os.fsync(handle.fileno())
  os.replace(tmp,path)
  directory=os.open(path.parent,os.O_RDONLY); os.fsync(directory); os.close(directory)
finally:
  if os.path.exists(tmp): os.unlink(tmp)
PY

set +e
(cd "$root" && bun test --timeout 30000 packages/sandbox-server/src/services/atomic-write.test.ts -t 'stable atomic failure classification') >"$log" 2>&1
status=$?
set -e
cat "$log"
[[ $status -ne 0 ]] || { echo "SURVIVED: $mode" >&2; exit 1; }
grep -F "MUTATION_BOUNDARY:$boundary" "$log" >/dev/null
grep -F "$signature" "$log" >/dev/null
atomic_copy "$backup" "$prod"
[[ $(sha256sum "$prod" | cut -d' ' -f1) == "$baseline_hash" ]]
rm -f "$backup"
[[ $(git -C "$root" status --porcelain) == "$baseline_status" ]]
echo "KILLED: $mode (MUTATION_BOUNDARY:$boundary)"
