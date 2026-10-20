import { loadLaunchPathLines, recordLaunchPathCommand, runWithLaunchPath } from '../sandbox/launch-path'
import { TMUX_UNREACHABLE_MARKER, tmuxShellFunctions } from '../sandbox/tmux'
import { isHostRuntime, isVmRuntime } from '../sandbox/runtime'
import { WORKSPACE_DOT_DIR } from '../workspace/dot-dir'
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
 * The stored sandboxId selects the execution box. VM private boxes use their
 * own private root; squad boxes use their shared workspace. Derive the squad
 * root from the stored target so it survives changes to the owning agent.
 * Container and host layouts retain their existing shared workspace behavior.
 */
export function monitorWorkRoot(ctx: WorkspaceLayoutContext): string {
  const targetSquadId = ctx.sandboxId?.startsWith('squad_') ? ctx.sandboxId.slice('squad_'.length) : undefined
  const target = targetSquadId ? { ...ctx, squadId: targetSquadId } : ctx
  if (isHostRuntime()) return hostWorkspaceLayout(target).workspaceMount
  if (isVmRuntime()) return vmWorkspaceLayout({ sandboxId: ctx.sandboxId, squadId: targetSquadId }).workspaceMount
  return containerWorkspaceLayout(target).workspaceMount
}

export function monitorDir(workspaceMount: string, monitorId: string): string {
  return `${workspaceMount}/${WORKSPACE_DOT_DIR}/monitors/${monitorId}`
}

export function sessionNameForMonitor(monitorId: string): string {
  return `ficus-monitor-${monitorId.slice(0, 8)}`
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

/**
 * Written to `exitCode` when the in-sandbox watchdog stopped the command at
 * its deadline (coreutils `timeout`'s convention). The authoritative signal is
 * the {@link MONITOR_TIMED_OUT_FILE} marker, which the watchdog writes BEFORE
 * it signals anything, so a timeout is recognised even if the launcher dies
 * before it can write `exitCode`.
 */
export const MONITOR_TIMEOUT_EXIT_CODE = 124
/** Marker file the in-sandbox watchdog writes when the deadline passes. */
export const MONITOR_TIMED_OUT_FILE = 'timedOut'
/** Seconds between SIGTERM and SIGKILL when the watchdog stops a command. */
export const MONITOR_KILL_GRACE_SECONDS = 5
/** Longest single watchdog sleep, so a suspended box notices its deadline soon after it resumes. */
const WATCHDOG_MAX_SLEEP_SECONDS = 10

/**
 * Seconds the in-sandbox watchdog allows a (re)launch: the time left until the
 * monitor's absolute deadline, or the full timeout on the very first launch
 * (the deadline is fixed when that launch is recorded). Rounded UP so the
 * sandbox never fires ahead of the deadline by rounding; at least 1 because a
 * relaunch at or past the deadline is never attempted (the supervisor times it
 * out instead).
 */
export function monitorLaunchTimeoutSeconds(
  monitor: { deadlineAt: Date | null; startedAt: Date | null; timeoutMs: number; effectiveDeadline(): Date },
  nowMs: number
): number {
  const remainingMs =
    monitor.deadlineAt || monitor.startedAt ? monitor.effectiveDeadline().getTime() - nowMs : monitor.timeoutMs
  return Math.max(1, Math.ceil(remainingMs / 1000))
}

/**
 * The launcher a monitor's tmux session runs. Besides running the command and
 * recording its exit, it enforces the monitor's deadline INSIDE the sandbox,
 * so the deadline holds while Core is down or restarting (Core detaches, it
 * does not cancel, on shutdown).
 *
 * Why a shell watchdog rather than coreutils `timeout`: `timeout` is missing
 * on stock macOS (the host runtime), and busybox's only signals its direct
 * child, so a pipeline like `tail -F | grep` would leave orphans. Bash is
 * already the launcher's one hard dependency, and everything below is bash
 * builtins plus `date`/`sleep`, which every runtime has.
 *
 * Process-group isolation: `set -m` puts the command job into a NEW process
 * group whose id is the job's own pid (`$job`), containing exactly the
 * command's subshell, its pipeline and anything they spawn. Every signal the
 * launcher or watchdog sends goes to that group (`kill -- -$job`), so it can
 * never reach the launcher itself, the tmux server, other sessions, or
 * unrelated processes. If job control is unavailable the job stays in the
 * launcher's group and only the job's own pid is signalled (degraded: its
 * children may survive) — the launcher's group is never targeted.
 *
 * Because the command no longer shares the pane's process group, the SIGHUP
 * `tmux kill-session` delivers (Core cancel/timeout) would no longer reach it,
 * so the launcher traps it, stops the command's group (SIGTERM, then SIGKILL
 * after {@link MONITOR_KILL_GRACE_SECONDS}s) and exits WITHOUT an `exitCode`,
 * exactly as before. A natural exit also HUPs the group (what the closing
 * pane used to do to leftover background children).
 *
 * At the deadline the watchdog writes {@link MONITOR_TIMED_OUT_FILE} first,
 * then SIGTERMs the group; the launcher allows
 * {@link MONITOR_KILL_GRACE_SECONDS}s, SIGKILLs whatever is left, and records
 * exit code {@link MONITOR_TIMEOUT_EXIT_CODE}. The watchdog is its own
 * background job, so it still fires if the launcher itself is killed; it
 * also stops the command (without a marker: a loss) within
 * {@link WATCHDOG_MAX_SLEEP_SECONDS}s of noticing the launcher is gone.
 *
 * The deadline is taken from the sandbox's own clock (`now +
 * FICUS_MONITOR_TIMEOUT_SECONDS` at launch), so clock skew between Core and
 * the box cannot move it, and it is re-checked against wall time at least
 * every {@link WATCHDOG_MAX_SLEEP_SECONDS}s.
 */
export const LAUNCHER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FICUS_MONITOR_DIR/logs"
${TIMESTAMP} > "$FICUS_MONITOR_DIR/startedAt" || true
${loadLaunchPathLines('FICUS_MONITOR_DIR')}
set +e
job=''
job_group=0
watchdog=''
deadline=''
if [ -n "\${FICUS_MONITOR_TIMEOUT_SECONDS:-}" ]; then
  deadline=$(( $(date +%s) + FICUS_MONITOR_TIMEOUT_SECONDS ))
fi
# Signal the command job: its own process group, or only its pid without job control.
signal_job() {
  [ -n "$job" ] || return 0
  if [ "$job_group" = 1 ]; then kill -"$1" -- -"$job" 2>/dev/null; else kill -"$1" "$job" 2>/dev/null; fi
  return 0
}
stop_watchdog() {
  [ -n "$watchdog" ] && { kill -TERM -- -"$watchdog" 2>/dev/null || kill -TERM "$watchdog" 2>/dev/null; }
  watchdog=''
  return 0
}
# SIGTERM the job, then SIGKILL whatever of its group is left after the grace period.
stop_job() {
  signal_job TERM
  [ "$job_group" = 1 ] || return 0
  waited=0
  while [ "$waited" -lt ${MONITOR_KILL_GRACE_SECONDS} ] && kill -0 -- -"$job" 2>/dev/null; do
    sleep 1
    waited=$(( waited + 1 ))
  done
  signal_job KILL
}
# tmux kill-session (cancel, Core-side timeout): stop the command, record no exit.
trap "trap '' HUP INT TERM; stop_watchdog; stop_job; exit 129" HUP INT TERM
# Run directory setup inside the captured pipeline too: a failed cd is a normal
# command failure, with diagnostics and exitCode, not unexplained process loss.
set -m
( set +m; ( cd "$FICUS_MONITOR_CWD" && ${runWithLaunchPath('FICUS_MONITOR_COMMAND')} ) 2>&1 | tee -a "$FICUS_MONITOR_DIR/logs/current.log"; exit "\${PIPESTATUS[0]}" ) </dev/null &
job=$!
kill -0 -- -"$job" 2>/dev/null && job_group=1
if [ -n "$deadline" ]; then
  launcher=$$
  (
    set +m
    trap - HUP INT TERM
    while now=$(date +%s) && [ "$now" -lt "$deadline" ]; do
      # The launcher was killed outright (its traps never ran): stop the
      # command as the closing pane used to. No marker: that is a loss.
      kill -0 "$launcher" 2>/dev/null || { signal_job TERM; exit 0; }
      left=$(( deadline - now ))
      [ "$left" -gt ${WATCHDOG_MAX_SLEEP_SECONDS} ] && left=${WATCHDOG_MAX_SLEEP_SECONDS}
      sleep "$left"
    done
    : > "$FICUS_MONITOR_DIR/${MONITOR_TIMED_OUT_FILE}"
    signal_job TERM
  ) </dev/null >/dev/null 2>&1 &
  watchdog=$!
fi
set +m
wait "$job"
status=$?
stop_watchdog
# The job's pid has been reaped by now: only its process group (which lives
# on while any member does) may still be signalled.
if [ -f "$FICUS_MONITOR_DIR/${MONITOR_TIMED_OUT_FILE}" ]; then
  # Members that outlived the subshell (or ignored SIGTERM) get the grace period, then SIGKILL.
  [ "$job_group" = 1 ] && stop_job
  status=${MONITOR_TIMEOUT_EXIT_CODE}
elif [ "$job_group" = 1 ]; then
  # What the closing pane used to do to anything the command left running.
  signal_job HUP
fi
trap - HUP INT TERM
set -e
echo "$status" > "$FICUS_MONITOR_DIR/exitCode"
${TIMESTAMP} > "$FICUS_MONITOR_DIR/exitedAt" || true
exit "$status"
`

/** Probe answers ({@link monitorProbeCommand}): the work dir is gone, or the session is, without an exit. */
export const MONITOR_DIR_GONE = '__MONITOR_DIR_GONE__'
export const MONITOR_PROCESS_GONE = '__MONITOR_PROCESS_GONE__'
/** The in-sandbox watchdog stopped the command at its deadline (see LAUNCHER_SCRIPT). */
export const MONITOR_PROBE_TIMED_OUT = '__MONITOR_TIMED_OUT__'
/** Prefix of the launch command's report of the log size before the run. */
export const MONITOR_LOG_SIZE_MARKER = '__FICUS_MONITOR_LOG_SIZE__='

/**
 * The box command that (re)launches a monitor: writes {@link LAUNCHER_SCRIPT},
 * records the caller's PATH and starts the session with the pinned tmux on the
 * Ficus socket (see sandbox/tmux.ts), in the monitor's OWN box — a private
 * agent box or the squad box alike. Prints the log size before the run.
 *
 * The session name is unique to the monitor, and a relaunch only follows a
 * probe that found the session gone, so an old server no tmux can reach does
 * not block the launch (`kill` is best effort). Starting a session on a Ficus
 * server no tmux can reach exits with the unreachable marker.
 */
export function monitorLaunchCommand(args: {
  dir: string
  logFile: string
  processId: string
  env: Record<string, string>
}): string {
  const { dir, logFile, processId } = args
  const script = `${dir}/run.sh`
  const launchCommand = [
    ...Object.entries(args.env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    `bash ${shellQuote(script)}`,
  ].join(' ')
  return [
    'set -e',
    `mkdir -p ${shellQuote(`${dir}/logs`)}`,
    `cat > ${shellQuote(script)} <<'EOF'\n${LAUNCHER_SCRIPT}EOF`,
    `chmod +x ${shellQuote(script)}`,
    // The tmux session gets the tmux server's PATH, not ours (see launch-path.ts).
    recordLaunchPathCommand(dir),
    // A stale exitCode (or timeout marker) from a lost run must not read as this run's.
    `rm -f ${shellQuote(`${dir}/exitCode`)} ${shellQuote(`${dir}/exitedAt`)} ${shellQuote(`${dir}/${MONITOR_TIMED_OUT_FILE}`)}`,
    `touch ${shellQuote(logFile)}`,
    // Measured BEFORE the new run can append to it.
    `log_size=$(wc -c < ${shellQuote(logFile)} | tr -d ' ')`,
    tmuxShellFunctions(),
    `ficus_tmux_kill ${shellQuote(processId)} || true`,
    `ficus_tmux_status=0; ficus_tmux_new ${shellQuote(processId)} ${shellQuote(launchCommand)} || ficus_tmux_status=$?`,
    `[ "$ficus_tmux_status" = 2 ] && ficus_tmux_unreachable`,
    `[ "$ficus_tmux_status" = 0 ] || exit "$ficus_tmux_status"`,
    `echo "${MONITOR_LOG_SIZE_MARKER}$log_size"`,
  ].join('\n')
}

/**
 * One liveness probe. Order matters: tmux liveness is sampled BEFORE the
 * exitCode file, and the launcher writes exitCode before its session ends,
 * so "no session and no exitCode" can only mean the process was lost.
 *
 * The watchdog's timeout marker wins over both: it is written before the
 * watchdog signals anything, so a run it stopped is reported timed out even
 * if the launcher died before recording an exit code (never a loss).
 *
 * A tmux server no installed tmux can reach (tmux status 2) is UNKNOWN, never
 * "gone": the run may be alive on a server of another tmux version, so the
 * probe answers with the unreachable marker instead of
 * {@link MONITOR_PROCESS_GONE}. Empty output means still running.
 */
export function monitorProbeCommand(dir: string, processId: string): string {
  return (
    `${tmuxShellFunctions()}\n` +
    `if [ ! -d ${shellQuote(dir)} ]; then echo ${MONITOR_DIR_GONE}; ` +
    `else tmux_state=0; ficus_tmux_has ${shellQuote(processId)} || tmux_state=$?; ` +
    `if [ -f ${shellQuote(`${dir}/${MONITOR_TIMED_OUT_FILE}`)} ]; then echo ${MONITOR_PROBE_TIMED_OUT}; ` +
    `elif [ -f ${shellQuote(`${dir}/exitCode`)} ]; then cat ${shellQuote(`${dir}/exitCode`)}; ` +
    `elif [ "$tmux_state" = 1 ]; then echo ${MONITOR_PROCESS_GONE}; ` +
    `elif [ "$tmux_state" = 2 ]; then echo "${TMUX_UNREACHABLE_MARKER} $ficus_tmux_error"; fi; fi`
  )
}
