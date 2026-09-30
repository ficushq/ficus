#!/usr/bin/env bash
set -euo pipefail
[[ -z "$(git status --porcelain)" ]] || { echo 'mutation check requires a clean worktree' >&2; exit 2; }
if [[ -n "${MUTATION_RUN_DIR:-}" ]]; then
  [[ "$MUTATION_RUN_DIR" = /* && ! -L "$MUTATION_RUN_DIR" ]] || { echo 'unsafe mutation evidence directory' >&2; exit 2; }
  mkdir -m 700 "$MUTATION_RUN_DIR"
  RUN_DIR=$MUTATION_RUN_DIR
  REMOVE_RUN_DIR=0
else
  RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/bash-tree-mutations.XXXXXX")
  REMOVE_RUN_DIR=1
fi
cleanup() {
  local status=$?
  if bun run test:db:down >/dev/null 2>&1; then : >"$RUN_DIR/db-down.complete"; fi
  (( REMOVE_RUN_DIR )) && rm -rf "$RUN_DIR"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
START_LABEL=${MUTATION_START_LABEL:-}
case "$START_LABEL" in
  '') EXPECTED_SKIPS=0; EXPECTED_EXECUTIONS=41; START_REACHED=1 ;;
  registry-no-partial-history) EXPECTED_SKIPS=27; EXPECTED_EXECUTIONS=14; START_REACHED=0 ;;
  retention-cap) EXPECTED_SKIPS=34; EXPECTED_EXECUTIONS=7; START_REACHED=0 ;;
  *) echo "unsupported mutation start label: $START_LABEL" >&2; exit 2 ;;
esac
START_MATCHES=0
SKIPPED_MUTATIONS=0
EXECUTED_MUTATIONS=0
mutate() {
  local label=$1 file=$2 old=$3 new=$4 test_file=$5 test_name=$6 backup="$RUN_DIR/backup"
  if [[ "$label" == "$START_LABEL" && -n "$START_LABEL" ]]; then
    START_REACHED=1
    ((START_MATCHES += 1))
  fi
  if (( ! START_REACHED )); then
    printf 'preserved mutation evidence: %s\n' "$label" >"$RUN_DIR/$label.skipped"
    ((SKIPPED_MUTATIONS += 1))
    echo "skipped with preserved evidence: $label"
    return
  fi
  ((EXECUTED_MUTATIONS += 1))
  cp "$file" "$backup"
  OLD="$old" NEW="$new" FILE="$file" python3 - <<'PY'
import os
from pathlib import Path
p=Path(os.environ['FILE']); s=p.read_text(); old=os.environ['OLD']
if s.count(old) != 1: raise SystemExit(f"expected one target, found {s.count(old)}")
p.write_text(s.replace(old, os.environ['NEW']))
PY
  set +e; bun test "$test_file" -t "$test_name" >"$RUN_DIR/$label.log" 2>&1; status=$?; set -e
  cp "$backup" "$file"
  [[ $status -ne 0 ]] || { echo "mutation survived: $label" >&2; exit 1; }
  ! grep -Eiq 'this test timed out after [0-9]+ms|TimeoutError:.*test timed out|unhandled|preload|module not found|cannot find module' "$RUN_DIR/$label.log" || { cat "$RUN_DIR/$label.log"; echo "invalid mutation settlement: $label" >&2; exit 1; }
  grep -F '(fail)' "$RUN_DIR/$label.log" | grep -F "$test_name" >/dev/null || { cat "$RUN_DIR/$label.log"; echo "wrong failure: $label" >&2; exit 1; }
  grep -E '(^error:|Expected:|Received:)' "$RUN_DIR/$label.log" >"$RUN_DIR/$label.assertion"
  [[ -s "$RUN_DIR/$label.assertion" ]] || { cat "$RUN_DIR/$label.log"; echo "missing mutation assertion: $label" >&2; exit 1; }
  if [[ "$label" == isolation ]]; then
    ! grep -Eiq 'isolation-.*(did-not-settle|survived)|isolation fixture cleanup failed' "$RUN_DIR/$label.log" || { cat "$RUN_DIR/$label.log"; echo 'invalid isolation cleanup' >&2; exit 1; }
  fi
  git diff --exit-code -- "$file" >/dev/null
  echo "killed at intended assertion: $label"
}
BASH=packages/sandbox-server/src/services/bash.ts
SESSION=packages/sandbox-server/src/services/process-session.ts
REGISTRY=packages/sandbox-server/src/services/bash-invocation-registry.ts
mutate isolation "$BASH" "detached: process.platform !== 'win32'" 'detached: false' packages/sandbox-server/src/services/bash.test.ts 'removes descendants before reporting a timeout'
mutate admission-no-stop "$BASH" "return ['-c', 'kill -STOP \$\$; exec \"\$@\"', '--', 'bash', '-c', command]" "return ['-c', 'exec \"\$@\"', '--', 'bash', '-c', command]" packages/sandbox-server/src/services/bash.test.ts 'launches a same-PID self-stopping wrapper before the user command'
mutate admission-no-state "$BASH" "(observed.state === 'T' || observed.state === 't')" 'true' packages/sandbox-server/src/services/bash.test.ts 'waits through unsafe and running transitions before the sole CONT'
mutate admission-no-starting-record "$BASH" 'await lease.markStarting({' 'await Promise.resolve({' packages/sandbox-server/src/services/bash.test.ts 'waits through unsafe and running transitions before the sole CONT'
mutate admission-store-transitional-groups "$BASH" 'await lease.markStarting({ pid: observed.pid, startToken: observed.startToken })' 'await lease.markStarting({ pid: observed.pid, startToken: observed.startToken, pgid: observed.pgid, sid: observed.sid })' packages/sandbox-server/src/services/bash.test.ts 'waits through unsafe and running transitions before the sole CONT'
mutate admission-no-final-revalidation "$BASH" 'if (!stoppedIdentityMatches(confirmed, observed)) {' 'if (false) {' packages/sandbox-server/src/services/bash.test.ts 'revalidates the complete stopped tuple after markRunning and before CONT'
mutate admission-no-cont "$BASH" "dependencies.processDriver.signal(-observed.pgid, 'SIGCONT')" 'void observed.pgid' packages/sandbox-server/src/services/bash.test.ts 'waits through unsafe and running transitions before the sole CONT'
mutate admission-no-token-pin "$BASH" 'observed.startToken !== pinnedStartToken' 'false' packages/sandbox-server/src/services/bash.test.ts 'rejects PID reuse before CONT'
mutate admission-poll-first "$BASH" $'      exited.then(() => \'exit\' as const),\n      dependencies.waitForAdmissionPoll().then(() => \'poll\' as const),' $'      dependencies.waitForAdmissionPoll().then(() => \'poll\' as const),\n      exited.then(() => \'exit\' as const),' packages/sandbox-server/src/services/bash.test.ts 'fails closed when the wrapper exits before stopped admission'
mutate parent-only "$SESSION" 'driver.signal(-pgid, signal)' 'driver.signal(representative.pid, signal)' packages/sandbox-server/src/services/process-session.test.ts 'terminates the group and escalates every remaining group'
mutate skip-join "$SESSION" $'    await signalProvenSessionGroups(owner.sid, remaining, \'SIGKILL\', driver)\n    await driver.waitForExit(owner.pid, graceMs)\n    if (driver.waitForSessionEmpty) await driver.waitForSessionEmpty(owner.sid, graceMs)\n    remaining = await driver.scanSessionIdentities(owner.sid)' $'    await signalProvenSessionGroups(owner.sid, remaining, \'SIGKILL\', driver)\n    remaining = []' packages/sandbox-server/src/services/process-session.test.ts 'fails cleanup proof when members survive KILL'
mutate early-retry "$REGISTRY" 'await this.options.reconcile(previous)' '/* mutation: skipped cleanup proof */' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'reconciles a nonterminal durable owner before allowing retry'
mutate weak-fence "$REGISTRY" 'if (this.active.has(key)) throw new InvocationActiveError()' 'if (false) throw new InvocationActiveError()' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'fences an active duplicate and advances generation only after terminal proof'
mutate no-kill "$SESSION" "await signalProvenSessionGroups(owner.sid, remaining, 'SIGKILL', driver)" "await signalProvenSessionGroups(owner.sid, remaining, 'SIGTERM', driver)" packages/sandbox-server/src/services/process-session.test.ts 'terminates the group and escalates every remaining group'
mutate pre-spawn-cancel "$BASH" 'return controller.desiredSize === null || controller.desiredSize <= 0' 'return false' packages/sandbox-server/src/services/bash.test.ts 'cancellation during Docker readiness prevents a later spawn'
mutate invocation-response-id "$BASH" 'id: invocationId' "id: 'server-fallback'" packages/sandbox-server/src/services/bash.test.ts 'reports the actual generated invocation ID and preserves a supplied ID'
mutate no-cancel "$BASH" '    cancel() {' $'    cancel() {\n      return Promise.resolve()' packages/sandbox-server/src/services/bash.test.ts 'response cancellation removes the owned session before settling'
# Round-three portability, quarantine, cancellation, parity, retention, and causality guards.
mutate darwin-procfs packages/sandbox-server/src/services/process-session.ts "if (platform === 'darwin') return createDarwinProcessSessionDriver(darwinBackend)" "if (platform === 'darwin') return linuxProcessSessionDriver" packages/sandbox-server/src/services/process-session.test.ts 'uses exact native state and microsecond start tokens'
mutate darwin-drop-microseconds packages/sandbox-server/src/services/process-session.ts 'startToken: `darwin:${info.startSeconds}:${info.startMicroseconds}`' 'startToken: `darwin:${info.startSeconds}`' packages/sandbox-server/src/services/process-session.test.ts 'uses exact native state and microsecond start tokens'
mutate session-no-token-revalidation packages/sandbox-server/src/services/process-session.ts 'leader.startToken !== owner.startToken' 'false' packages/sandbox-server/src/services/process-session.test.ts 'fails closed before signaling a changed leader tuple'
mutate session-no-group-refresh packages/sandbox-server/src/services/process-session.ts 'const current = await driver.readIdentity(representative.pid)' 'const current = representative' packages/sandbox-server/src/services/process-session.test.ts 'revalidates the representative before TERM and signals neither it nor a neighbor on ambiguity'
mutate darwin-weaken-stopped packages/sandbox-server/src/services/process-session.ts "4: 'T', // SSTOP" "4: 'R', // mutation: SSTOP admitted as running" packages/sandbox-server/src/services/process-session.test.ts 'uses exact native state and microsecond start tokens'
mutate darwin-ps-authoritative packages/sandbox-server/src/services/process-session.ts 'startToken: `darwin-ps:${match[5]!.trim()}`' 'startToken: `darwin:${match[5]!.trim()}`' packages/sandbox-server/src/services/process-session.test.ts 'treats ps output as diagnostic and never as an authoritative token'
mutate unsupported-linux-fallback packages/sandbox-server/src/services/process-session.ts 'throw new ProcessSessionCapabilityError(`Process session inspection is unsupported on ${platform}`)' 'return linuxProcessSessionDriver' packages/sandbox-server/src/services/process-session.test.ts 'fails closed on duplicate native list rows and unsupported platforms'
mutate cancel-deadline apps/core/src/services/sandbox/client/http-client.ts 'signal: AbortSignal.timeout(this.cancelTimeoutMs),' 'signal: undefined,' apps/core/src/services/sandbox/client/http-client.bash-cancel.test.ts 'bounds a hanging cancellation request and remains single flight'
mutate quarantine-neighbor packages/sandbox-server/src/services/bash-invocation-registry.ts "await this.quarantine(key, record, 'RECONCILIATION_AMBIGUOUS')" 'throw new Error("mutation: global reconciliation failure")' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'quarantines one ambiguous key while unrelated acquisition continues'
mutate registry-state-validation packages/sandbox-server/src/services/bash-invocation-registry.ts '!states.includes(record.state) ||' 'false ||' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'quarantines malformed JSON, invalid schema/state, and ambiguous ownership independently'
mutate registry-no-partial-history "$REGISTRY" 'const partialStartingHistory =' 'const partialStartingHistory = false &&' packages/sandbox-server/src/services/bash.test.ts 'reconciles a restart at the partial starting-owner barrier before retry'
mutate advisory-lock-atomic packages/sandbox-server/src/services/bash-invocation-registry.ts "if (await advisory(file.fd, 'lock')) {" 'if (true) {' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'allows only one of two crash-lock recoverers into the same key'
mutate lock-release-deadlock packages/sandbox-server/src/services/bash-invocation-registry.ts $'      try {\n        await releaseFileLock?.()\n      } finally {\n        release()\n        if (this.locks.get(key) === chained) this.locks.delete(key)\n      }' $'      await releaseFileLock?.()\n      release()\n      if (this.locks.get(key) === chained) this.locks.delete(key)' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'releases the in-memory queue even when advisory unlock reports an error'
mutate legacy-migration-bound packages/sandbox-server/src/services/bash-invocation-registry.ts 'if (files.length >= limit || inspected >= limit + 8) break' 'if (false) break' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'bounds backward-compatible legacy terminal migration per startup'
mutate legacy-foreign-progress packages/sandbox-server/src/services/bash-invocation-registry.ts 'await rename(join(this.options.runtimeDir, entry.name), join(quarantineDir, `legacy.${randomUUID()}`))' 'void entry.name' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'bounds backward-compatible legacy terminal migration per startup'
mutate legacy-migration-periodic packages/sandbox-server/src/services/bash-invocation-registry.ts $'    if (this.maintenanceOperations % interval === 0) {\n      await this.migrateLegacyBatch()\n      await this.pruneTerminalRecords()' $'    if (this.maintenanceOperations % interval === 0) {\n      await this.pruneTerminalRecords()' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'bounds backward-compatible legacy terminal migration per startup'
mutate squad-owner apps/core/src/tools/squad-bash.ts '{ agentId, invocationOwnerId }' '{ agentId, invocationOwnerId: undefined }' apps/core/src/tools/squad-bash.test.ts 'threads execution ownership independently from outage watch ownership'
mutate retention-cap packages/sandbox-server/src/services/bash-invocation-registry.ts 'const doomed = records.filter(({ terminalTime }, index) => index >= min && (index >= max || terminalTime < cutoff))' 'const doomed = records.filter(() => false)' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'prunes only eligible oldest terminal records at the hard cap'
mutate retention-periodic packages/sandbox-server/src/services/bash-invocation-registry.ts 'if (count >= threshold) {' 'if (false) {' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'triggers bounded count pruning during long-lived operation'
mutate prune-enoent packages/sandbox-server/src/services/bash-invocation-registry.ts "if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue" "if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error" packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'treats a concurrent prune unlink ENOENT as benign across registry instances'
mutate prune-active-generation packages/sandbox-server/src/services/bash-invocation-registry.ts 'const path = join(this.terminalDir(), file)' 'const path = this.path(key)' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'pruning immutable generation zero cannot delete a concurrent generation one owner'
mutate prune-error-global packages/sandbox-server/src/services/bash-invocation-registry.ts "await this.quarantine(key, await this.readValidated(key), 'PRUNE_UNLINK_FAILED')" 'throw error' packages/sandbox-server/src/services/bash-invocation-registry.test.ts 'quarantines a non-ENOENT prune failure per record without poisoning readiness'
mutate outage-causality apps/core/src/tools/sandbox-tools.ts 'reject(attachSecondaryFailure(mapped, cleanupError))' 'reject(cleanupError)' apps/core/src/tools/sandbox-tools.test.ts 'preserves structured outage when cleanup fails'
mutate abort-cleanup-barrier apps/core/src/tools/sandbox-tools.ts "options.signal.addEventListener('abort', abortHandler, { once: true })" '/* mutation: abort cleanup handler removed */' apps/core/src/tools/sandbox-tools.test.ts 'awaits remote cleanup proof before abort settlement'
if [[ -n "$START_LABEL" ]]; then
  [[ $START_REACHED -eq 1 && $START_MATCHES -eq 1 ]] || { echo "mutation start label was not reached exactly once: $START_LABEL" >&2; exit 2; }
fi
[[ $SKIPPED_MUTATIONS -eq $EXPECTED_SKIPS && $EXECUTED_MUTATIONS -eq $EXPECTED_EXECUTIONS ]] || {
  echo "unexpected mutation totals: skipped=$SKIPPED_MUTATIONS executed=$EXECUTED_MUTATIONS" >&2
  exit 2
}
printf 'preserved_skipped=%d newly_executed=%d\n' "$SKIPPED_MUTATIONS" "$EXECUTED_MUTATIONS" | tee "$RUN_DIR/mutation-totals"
echo 'all sandbox exec process-tree mutations were killed'
