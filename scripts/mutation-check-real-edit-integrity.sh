#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
root=$(git rev-parse --show-toplevel)
factory="$root/apps/core/src/tools/sandbox-tools.ts"
executor="$root/apps/core/src/tools/verified-edit.ts"
: "${DATABASE_URL:?DATABASE_URL must name the explicitly owned worktree test database}"
: "${TEST_DB_PROJECT:?TEST_DB_PROJECT must name the explicitly owned ficus-test-* project}"
[[ $TEST_DB_PROJECT == ficus-test-* ]] || { echo 'TEST_DB_PROJECT must start with ficus-test-' >&2; exit 2; }
[[ $(bun --version) == "$(cat "$root/.bun-version")" ]]

case "$mode" in
  verified-route-expected-result-drop) source=$factory; filter='diff-text transport contamination rejected by server'; signature='Expected: 500'; test_file='src/tools/sandbox-tools.real-edit.test.ts' ;;
  verified-route-expected-original-drop) source=$factory; filter='concurrent stale-base edit refuses after cooperating restore'; signature='expectedOriginal'; test_file='src/tools/sandbox-tools.real-edit.test.ts' ;;
  factory-legacy-write-fallback) source=$factory; filter='verified large-file edit preserves distant suffix'; signature='verified edit must never fall back to legacy write'; test_file='src/tools/sandbox-tools.test.ts' ;;
  commit-response-identity-skip) source=$executor; filter='suppresses success on a commit response identity mismatch'; signature='Received value: undefined'; test_file='src/tools/verified-edit.test.ts' ;;
  core-final-readback-skip) source=$executor; filter='corrupt Core final readback suppresses success after server response'; signature='expected real edit rejection'; test_file='src/tools/sandbox-tools.real-edit.test.ts' ;;
  post-commit-abort-generic) source=$executor; filter='honors abort checkpoints without releasing around an unsettled commit'; signature='Received: "Operation aborted"'; test_file='src/tools/verified-edit.test.ts' ;;
  post-readback-abort-generic) source=$executor; filter='reports post-publication uncertainty for abort after final readback'; signature='Received: "Operation aborted"'; test_file='src/tools/verified-edit.test.ts' ;;
  crlf-normalization-drop) source=$executor; filter='matches multiline LF edit text against CRLF bytes'; signature='match was not found'; test_file='src/tools/verified-edit.test.ts' ;;
  *) echo "unknown real-edit mutation mode: $mode" >&2; exit 2 ;;
esac

[[ -z $(git -C "$root" status --short -- "$factory" "$executor") ]] || { echo 'production mutation sources must be clean' >&2; exit 2; }
baseline_status=$(git -C "$root" status --porcelain)
baseline_hash=$(sha256sum "$source" | cut -d' ' -f1)
backup="$source.real-edit-backup.$$"
work=$(mktemp -d "${TMPDIR:-/tmp}/real-edit-mutation.XXXXXX")
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
atomic_copy "$source" "$backup"
cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  if [[ -f $backup ]]; then atomic_copy "$backup" "$source" || status=1; rm -f "$backup"; fi
  rm -rf "$work"
  (cd "$root/apps/core" && bun run test:db:down >/dev/null 2>&1) || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

MODE=$mode SOURCE=$source python3 - <<'PY'
from pathlib import Path
import os,tempfile
path=Path(os.environ['SOURCE']); mode=os.environ['MODE']; source=path.read_text()
mutations={
'verified-route-expected-result-drop':('          expectedResult: identity.result,','          // MUTATION_BOUNDARY:expected-result-drop'),
'verified-route-expected-original-drop':('          expectedOriginal: identity.original,','          // MUTATION_BOUNDARY:expected-original-drop'),
'factory-legacy-write-fallback':('        return await client.writeVerified({','        return await client.write({'),
'commit-response-identity-skip':('        if (response.bytesWritten !== resultIdentity.bytes || response.sha256 !== resultIdentity.sha256) {','        if (false && (response.bytesWritten !== resultIdentity.bytes || response.sha256 !== resultIdentity.sha256)) {'),
'core-final-readback-skip':('        if (readback.byteLength !== resultIdentity.bytes || sha256(readback) !== resultIdentity.sha256) {','        if (false && (readback.byteLength !== resultIdentity.bytes || sha256(readback) !== resultIdentity.sha256)) {'),
'post-commit-abort-generic':("""        throwIfAbortedAfterCommit()
        if (response.bytesWritten""","""        throwIfAborted()
        if (response.bytesWritten"""),
'post-readback-abort-generic':("""        const readback = await operations.readFile(absolutePath)
        throwIfAbortedAfterCommit()
""","""        const readback = await operations.readFile(absolutePath)
        throwIfAborted()
"""),
'crlf-normalization-drop':(r"""function newlineVariants(value: string): string[] {
  const variants = [value]
  if (value.includes('\n') && !value.includes('\r\n')) variants.push(value.replaceAll('\n', '\r\n'))
  return variants
}""",r"""function newlineVariants(value: string): string[] {
  return [value]
}"""),
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
(cd "$root/apps/core" && bun test --timeout 30000 "$test_file" -t "$filter") >"$log" 2>&1
status=$?
set -e
cat "$log"
[[ $status -ne 0 ]] || { echo "SURVIVED: $mode" >&2; exit 1; }
grep -F "$signature" "$log" >/dev/null
atomic_copy "$backup" "$source"
[[ $(sha256sum "$source" | cut -d' ' -f1) == "$baseline_hash" ]]
rm -f "$backup"
[[ $(git -C "$root" status --porcelain) == "$baseline_status" ]]
echo "KILLED: $mode ($signature)"
