import { isHostRuntime, isVmRuntime } from '../sandbox/runtime'
import {
  containerWorkspaceLayout,
  hostWorkspaceLayout,
  vmWorkspaceLayout,
  type WorkspaceLayoutContext,
} from '../sandbox/workspace-layout'

export function shellQuote(value: string | number): string {
  if (typeof value === 'number') return String(value)
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

/**
 * Root directory a monitor's scratch tree ({@link monitorDir}) and default cwd
 * live under, resolved on the active runtime.
 *
 * Monitors exec inside the monitor's OWN sandbox (`monitor.sandboxId` — for a
 * squad member that is its per-agent light sandbox, NOT the squad sandbox):
 *
 * - k8s/docker: the squad workspace is a shared volume mounted into every
 *   member container, so squad monitors keep using `/workspace/<squadId>`
 *   (and solo monitors `/workspace`) — exactly the pre-vm behavior.
 * - vm: the squad workspace lives in the SQUAD box's home, which the member's
 *   box user cannot write — mkdir/launch/tail there would fail. A monitor's
 *   root is therefore always its own box's work root (its `~/.private`,
 *   matching a solo box). Consequence: on the vm runtime monitors observe the
 *   monitor's own box only; monitoring the shared squad workspace is
 *   known-unsupported there (an agent can still watch shared state by polling
 *   through its own tools rather than a filesystem monitor).
 * - host: there are no mounts at all — commands run on the operator's real
 *   filesystem, so the container literals would have the supervisor `mkdir -p
 *   /workspace/<squadId>/...` at the machine root (EACCES, or a stray
 *   `/workspace` tree). The root is the host layout's own work root: the
 *   squad's real workspace directory (honouring `squads.host_workspace_path`)
 *   for a squad monitor, and the agent's `<HOME_DIR>/private/<sandboxId>` for a
 *   solo one — which is exactly `hostWorkspaceLayout`'s `workspaceMount` in
 *   both cases. Unlike vm, every host agent runs as the same unix user, so the
 *   shared squad workspace IS writable and squad monitors keep the pre-vm
 *   "watch the shared workspace" behavior.
 */
export function monitorWorkRoot(ctx: WorkspaceLayoutContext): string {
  if (isHostRuntime()) return hostWorkspaceLayout(ctx).workspaceMount
  if (isVmRuntime()) return vmWorkspaceLayout({ sandboxId: ctx.sandboxId }).workspaceMount
  return containerWorkspaceLayout(ctx).workspaceMount
}

export function monitorDir(workspaceMount: string, monitorId: string): string {
  return `${workspaceMount}/.tau/monitors/${monitorId}`
}

export function sessionNameForMonitor(monitorId: string): string {
  return `tau-monitor-${monitorId.slice(0, 8)}`
}

/**
 * `date -Is` is a GNU abbreviation BSD date rejects ("invalid argument 's' for
 * -I"), so on the host runtime on macOS it exited 1 under `set -e` and killed
 * the launcher on its FOURTH line — before the log file existed and before the
 * monitored command ever ran, which is why a monitor "never produced output or
 * terminated". `+FORMAT` is POSIX and byte-identical on GNU and BSD; `|| true`
 * additionally demotes these breadcrumbs (nothing reads them — they are
 * diagnostics, unlike `exitCode`, which pollExit reads) so no future
 * portability wrinkle in a timestamp can ever again abort a monitor.
 */
const TIMESTAMP = `date -u '+%Y-%m-%dT%H:%M:%SZ'`

export const LAUNCHER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FICUS_MONITOR_DIR/logs"
${TIMESTAMP} > "$FICUS_MONITOR_DIR/startedAt" || true
cd "$FICUS_MONITOR_CWD"
set +e
bash -lc "$FICUS_MONITOR_COMMAND" 2>&1 | tee -a "$FICUS_MONITOR_DIR/logs/current.log"
status=\${PIPESTATUS[0]}
set -e
echo "$status" > "$FICUS_MONITOR_DIR/exitCode"
${TIMESTAMP} > "$FICUS_MONITOR_DIR/exitedAt" || true
exit "$status"
`
