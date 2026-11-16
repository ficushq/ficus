/**
 * Shell helpers that give Ficus-managed long-running commands (managed apps,
 * agent monitors) their own workload cgroup leaf on a VM box.
 *
 * On a box whose sandbox server runs commands in workload cgroups
 * (packages/sandbox-server/src/services/workload-cgroup.ts), systemd-oomd
 * kills one leaf at a time under sustained memory pressure. Managed apps and
 * monitors run under the box's single tmux server, so without these helpers
 * every app and monitor would share the leaf of whichever command first
 * started tmux, and one kill would stop all of them. Instead:
 *
 * - `ficus_tmux_new` moves the tmux server into `workload/tmux-server`, a leaf
 *   the sandbox server marks for systemd-oomd to skip (it holds only tmux and
 *   the small launchers, and killing it would end every session);
 * - each launcher moves its command (not itself) into `app-<id>` or
 *   `monitor-<id>`, so a kill stops only that command, and the launcher lives
 *   on to record the exit status and log why it ended.
 *
 * Everywhere else (k8s and Docker sandboxes, host runtime, boxes provisioned
 * before workload cgroups) these are no-ops: the caller's cgroup is not inside
 * a `workload/` subtree.
 */

/** The leaf the tmux server is moved into; the sandbox server creates it marked user.oomd_omit. */
export const TMUX_SERVER_WORKLOAD_LEAF = 'tmux-server'

/**
 * The full avg10 memory pressure (percent) of a killed leaf above which its
 * SIGKILL is attributed to systemd-oomd, which acts at 50% sustained for 20s.
 * Read right after the kill, while the 10-second average still shows it.
 */
const OOMD_PRESSURE_EVIDENCE = 30

/**
 * Bash function definitions:
 * - `ficus_workload_leaf_dir NAME`: print the leaf's directory, or fail when
 *   this shell is not in a workload cgroup.
 * - `ficus_workload_leaf NAME [PID]`: move PID (default: the calling
 *   (sub)shell) into leaf NAME. Never fails.
 * - `ficus_workload_kill_reason NAME`: print one sentence naming a memory kill
 *   of leaf NAME (kernel OOM or systemd-oomd), or nothing.
 */
export const WORKLOAD_LEAF_SHELL_FUNCTIONS = `ficus_workload_leaf_dir() {
  local cg
  cg=$(sed -n 's/^0:://p' "\${FICUS_WORKLOAD_SELF_CGROUP:-/proc/self/cgroup}" 2>/dev/null) || return 1
  case "$cg" in */workload/*) ;; *) return 1 ;; esac
  printf '%s/workload/%s' "\${FICUS_WORKLOAD_CGROUP_FS:-/sys/fs/cgroup}\${cg%%/workload/*}" "$1"
}
ficus_workload_leaf() {
  local dir
  dir=$(ficus_workload_leaf_dir "$1") || return 0
  mkdir -p "$dir" 2>/dev/null && echo "\${2:-$BASHPID}" > "$dir/cgroup.procs" 2>/dev/null
  return 0
}
ficus_workload_kill_reason() {
  local dir kills full
  dir=$(ficus_workload_leaf_dir "$1") || return 0
  kills=$(sed -n 's/^oom_kill //p' "$dir/memory.events" 2>/dev/null)
  if [ "\${kills:-0}" -gt 0 ] 2>/dev/null; then
    echo "[ficus] Killed by the kernel OOM killer: this box reached its memory limit."
    return 0
  fi
  full=$(sed -n 's/^full avg10=\\([0-9]*\\).*/\\1/p' "$dir/memory.pressure" 2>/dev/null)
  if [ "\${full:-0}" -ge ${OOMD_PRESSURE_EVIDENCE} ] 2>/dev/null; then
    echo "[ficus] Killed by systemd-oomd: this box was under sustained memory pressure and this command was using the most memory."
  fi
  return 0
}`
