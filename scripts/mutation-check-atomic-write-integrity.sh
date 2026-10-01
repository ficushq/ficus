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
  queue-bypass) filter='registers every direct-path write exactly once on its resolved destination queue'; boundary='direct-write-queue-registration'; signature='Received.*\[\]|\+ \[\]' ;;
  alias-key-split) filter='uses the resolved physical target as both queue key and rename destination for a final symlink'; boundary='alias-canonical-queue-key'; signature='alias\.txt' ;;
  stage-verify-remove) filter='rejects dropped suffix during handle readback before rename'; boundary='stage-readback-prevents-rename'; signature='Expected: false|Received: true' ;;
  post-handle-verify-remove) filter='rejects post-rename handle readback no-progress with published-phase wording'; boundary='published-handle-readback'; signature='Received value: undefined' ;;
  inode-compare-remove) filter='rejects a post-rename handle-to-path inode mismatch with published-phase wording'; boundary='published-inode-identity'; signature='Received value: undefined' ;;
  pathname-readback-remove) filter='reports post-rename mismatch as candidate may have been published'; boundary='published-pathname-readback'; signature='Received value: undefined' ;;
  ordering-swap-verify-chmod) filter='orders handle verification, mode, sync, final observation, publication, readbacks, and close'; boundary='verify-before-chmod-order'; signature='Expected: >= 1|Received: 0' ;;
  chmod-remove) filter='lands explicit, preserved, and new-file modes exactly under a restrictive subprocess umask'; boundary='chmod-explicit-preserved-modes'; signature='Expected.*640|Expected.*416|toEqual' ;;
  umask-ignore) filter='lands explicit, preserved, and new-file modes exactly under a restrictive subprocess umask'; boundary='umask-default-mode'; signature='Expected: 384|Received: 438|toBe' ;;
  cleanup-primary-mask) filter='flattens stage, close, and cleanup failures in sanitized primary-first order'; boundary='stage-close-cleanup-aggregation'; signature='Expected constructor: \[class AggregateError extends Error\]' ;;
  close-primary-mask) filter='aggregates inner write primary before close failure'; boundary='write-close-primary-aggregation'; signature='Expected constructor: \[class AggregateError extends Error\]' ;;
  branding-spoof-trust) filter='sanitizes raw resolver failures before publication'; boundary='branding-resolver'; signature='SECRET-CANDIDATE' ;;
  post-phase-downgrade) filter='rejects post-rename handle readback no-progress with published-phase wording'; boundary='published-handle-readback'; signature='candidate was not published by this writer' ;;
  rename-brand-remove) filter='rename failure uses ambiguous-publication phase wording'; boundary='ambiguous-rename-branding'; signature='candidate was not published by this writer' ;;
  *) echo "unknown mutation mode: $mode" >&2; exit 2 ;;
esac

[[ -z $(git -C "$root" status --short -- "$prod" "$testsrc") ]] || { echo 'mutation sources must be clean' >&2; exit 2; }
baseline_status=$(git -C "$root" status --porcelain)
baseline_hash=$(sha256sum "$prod" | cut -d' ' -f1)
backup="$prod.mutation-backup.$$"
work=$(mktemp -d "${TMPDIR:-/tmp}/atomic-write-mutation.XXXXXX")
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
'queue-bypass':('return operations.withPathMutationQueue(destination, async () => {','return Promise.resolve().then(async () => {'),
'alias-key-split':('return operations.withPathMutationQueue(destination, async () => {','return operations.withPathMutationQueue(request.path, async () => {'),
'stage-verify-remove':("""      if (!sameIdentity(await readHandleIdentity(handle, resultIdentity.bytes, false), resultIdentity)) {
        throw prePublicationError('Atomic write staged byte identity mismatch')
      }
""",''),
'post-handle-verify-remove':("""      if (!sameIdentity(await readHandleIdentity(handle, resultIdentity.bytes, true), resultIdentity)) {
        throw publishedError('Atomic write publication verification failed after atomic rename')
      }
""",''),
'inode-compare-remove':("""      if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
        throw publishedError('Atomic write published inode verification failed')
      }
""",''),
'pathname-readback-remove':("""      if ((finalMode & 0o444) !== 0) {
        if (!sameIdentity(identity(await operations.readPath(destination)), resultIdentity)) {
          throw publishedError('Atomic write published pathname readback failed')
        }
      }
""",''),
'ordering-swap-verify-chmod':("""      if (!sameIdentity(await readHandleIdentity(handle, resultIdentity.bytes, false), resultIdentity)) {
        throw prePublicationError('Atomic write staged byte identity mismatch')
      }
      await handle.chmod(finalMode)
""","""      await handle.chmod(finalMode)
      if (!sameIdentity(await readHandleIdentity(handle, resultIdentity.bytes, false), resultIdentity)) {
        throw prePublicationError('Atomic write staged byte identity mismatch')
      }
"""),
'chmod-remove':('      await handle.chmod(finalMode)\n',''),
'umask-ignore':('const finalMode = request.mode ?? initial?.mode ?? (0o666 & ~operations.capturedUmask)','const finalMode = request.mode ?? initial?.mode ?? 0o666'),
'cleanup-primary-mask':('if (primary && cleanupError) throw aggregateErrors(primary, cleanupError)','if (primary && cleanupError) throw cleanupError'),
'close-primary-mask':('primary = primary ? aggregateErrors(primary, closeError) : closeError','primary = closeError'),
'branding-spoof-trust':('return error instanceof PublicAtomicWriteError','return error instanceof Error'),
'post-phase-downgrade':('readHandleIdentity(handle, resultIdentity.bytes, true)','readHandleIdentity(handle, resultIdentity.bytes, false)'),
'rename-brand-remove':('throw renameOutcomeError()','throw new Error(renameOutcomeError().message)'),
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
(cd "$root" && bun test --timeout 30000 packages/sandbox-server/src/services/atomic-write.test.ts -t "$filter") >"$log" 2>&1
status=$?
set -e
cat "$log"
[[ $status -ne 0 ]] || { echo "SURVIVED: $mode" >&2; exit 1; }
grep -F "MUTATION_BOUNDARY:$boundary" "$log" >/dev/null
grep -Eq "$signature" "$log"
atomic_copy "$backup" "$prod"
[[ $(sha256sum "$prod" | cut -d' ' -f1) == "$baseline_hash" ]]
rm -f "$backup"
[[ $(git -C "$root" status --porcelain) == "$baseline_status" ]]
echo "KILLED: $mode (MUTATION_BOUNDARY:$boundary)"
