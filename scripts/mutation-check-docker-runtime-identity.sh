#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
test -z "$(git status --short)" || { echo 'mutation check requires a clean worktree' >&2; exit 2; }
CONFIG=bunfig.fifo-restart.toml
baseline() {
  bun --config="$CONFIG" test \
    apps/core/src/services/sandbox/docker/command-identity.test.ts \
    apps/core/src/services/sandbox/docker/command-identity-source.test.ts \
    apps/core/src/services/sandbox/docker/startup-contract.test.ts \
    apps/core/src/services/sandbox/docker/runtime-contract.test.ts \
    apps/core/src/services/sandbox/docker/manager-status.test.ts \
    apps/core/src/services/sandbox/k8s/network-policy.test.ts \
    apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts \
    apps/core/src/tools/docker-tool-boundary.test.ts \
    packages/sandbox-server/src/services/command-identity.test.ts \
    packages/sandbox-server/src/services/auth.test.ts \
    packages/sandbox-server/src/services/health.test.ts
}
[ "${1:-}" != --baseline ] || { baseline; exit; }
baseline
mutate() {
  local name=$1 file=$2 old=$3 new=$4 test_file=$5 needle=$6 backup
  backup=$(mktemp)
  cp "$file" "$backup"
  python3 - "$file" "$old" "$new" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); s=p.read_text(); old=sys.argv[2]
if s.count(old)!=1: raise SystemExit(f'exact mutation count was {s.count(old)}, expected 1')
p.write_text(s.replace(old,sys.argv[3]))
PY
  set +e
  output=$(bun --config="$CONFIG" test "$test_file" 2>&1)
  rc=$?
  set -e
  mv "$backup" "$file"
  test "$rc" -ne 0 || { echo "SURVIVED: $name" >&2; exit 1; }
  grep -F "$needle" <<<"$output" >/dev/null || { echo "wrong failure: $name" >&2; exit 1; }
  git diff --quiet -- "$file" || { echo "restore failed: $name" >&2; exit 1; }
  echo "KILLED: $name"
}
mutate spec-image-id apps/core/src/services/sandbox/docker/runtime-contract.ts 'imageId: inputs.imageId' "imageId: 'removed'" apps/core/src/services/sandbox/docker/runtime-contract.test.ts 'same-tag immutable image and executor protocol drift'
mutate spec-executor-protocol apps/core/src/services/sandbox/docker/runtime-contract.ts 'executorProtocolVersion: inputs.executorProtocolVersion' 'executorProtocolVersion: 1' apps/core/src/services/sandbox/docker/runtime-contract.test.ts 'same-tag immutable image and executor protocol drift'
mutate health-missing apps/core/src/services/sandbox/docker/runtime-contract.ts 'if (!contract) throw' 'if (false && !contract) throw' apps/core/src/services/sandbox/docker/runtime-contract.test.ts 'requires exact non-root executor capabilities and identity'
mutate capability apps/core/src/services/sandbox/docker/runtime-contract.ts 'if (!required.every((value) => contract.capabilities?.includes(value)))' 'if (false && !required.every((value) => contract.capabilities?.includes(value)))' apps/core/src/services/sandbox/docker/runtime-contract.test.ts 'requires exact non-root executor capabilities and identity'
mutate identity-uid apps/core/src/services/sandbox/docker/runtime-contract.ts 'identity?.uid !== expected.uid' 'false' apps/core/src/services/sandbox/docker/runtime-contract.test.ts 'requires exact non-root executor capabilities and identity'
mutate identity-gid apps/core/src/services/sandbox/docker/runtime-contract.ts 'identity?.gid !== expected.gid' 'false' apps/core/src/services/sandbox/docker/runtime-contract.test.ts 'requires exact non-root executor capabilities and identity'
mutate identity-source apps/core/src/services/sandbox/docker/runtime-contract.ts 'identity?.source !== expected.source' 'false' apps/core/src/services/sandbox/docker/runtime-contract.test.ts 'requires exact non-root executor capabilities and identity'
mutate active-security apps/core/src/services/sandbox/docker/lifecycle-runtime.ts "'SECURITY_DRIFT_ACTIVE'" "'LEGACY_RECREATION_DEFERRED'" apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts 'active identity drift is distinguished behaviorally'
mutate ownership-label apps/core/src/services/sandbox/docker/lifecycle-contract.ts "labels[set.sandboxIdLabel] === sandboxId" 'true' apps/core/src/services/sandbox/docker/manager-status.test.ts 'rejects a labeled neighbor under either identity set'
mutate unknown-as-absent apps/core/src/services/sandbox/docker/lifecycle-contract.ts "return 'unknown'" "return 'not_found'" apps/core/src/services/sandbox/docker/manager-status.test.ts 'recognizes only an authoritative missing-container response as absent'
mutate immutable-target apps/core/src/services/sandbox/docker/lifecycle-runtime.ts 'return immutableId' "return 'mutable-name'" apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts 'stops the immutable inspected ID'
mutate swallow-stop apps/core/src/services/sandbox/docker/lifecycle-runtime.ts "state === 'unknown' || state === 'running' || (result.exitCode !== 0 && state !== 'not_found')" 'false' apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts 'retains tracked state and throws typed'
mutate swallow-remove apps/core/src/services/sandbox/docker/lifecycle-runtime.ts ": state !== 'not_found'" ': false' apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts 'retains tracked state and throws typed'
mutate cleanup-aggregation apps/core/src/services/sandbox/docker/lifecycle-runtime.ts "if (failures.length) throw new AggregateError(failures, 'Docker sandbox cleanup was not proven')" "if (false) throw new AggregateError()" apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts 'cleanup attempts all entries and reports every failure'
mutate direct-tool-docker apps/core/src/tools/docker-tool-boundary.ts 'manager.execWithStdin' 'manager.exec' apps/core/src/tools/docker-tool-boundary.test.ts 'writes only through the verified stdin execution boundary'
mutate stdin-identity apps/core/src/services/sandbox/docker/lifecycle-runtime.ts "...userArgs, '-w'" "'-w'" apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts 'stdin execution behavior includes the exact command-user boundary'
mutate launch-user packages/sandbox-server/src/services/command-identity.ts "executable: 'su-exec'" "executable: 'bash'" packages/sandbox-server/src/services/command-identity.test.ts 'uses an execing named-user launcher'
mutate startup-writability apps/core/docker-sandbox/startup.sh 'test -w /home/ficus' 'true' apps/core/src/services/sandbox/docker/startup-contract.test.ts 'fails closed on identity collisions and reports the resolved source'
mutate bounded-kill apps/core/docker-sandbox/shutdown.sh 'kill -KILL "$pid"' 'kill -TERM "$pid"' apps/core/src/services/sandbox/docker/startup-contract.test.ts 'a TERM-resistant child cannot hang final cleanup'
mutate primary-cleanup apps/core/src/services/sandbox/docker/lifecycle-runtime.ts 'await cleanup()' 'return await cleanup()' apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts 'rethrows the primary failure when cleanup succeeds'
mutate cleanup-client apps/core/src/services/sandbox/docker/lifecycle-runtime.ts 'if (options.isTracked() && options.close)' 'if (false && options.isTracked() && options.close)' apps/core/src/services/sandbox/docker/lifecycle-contract.test.ts 'failed initialization cleanup orders remove before client-close'
test -z "$(git status --short)"
echo '21/21 Docker runtime production-seam mutants killed'
