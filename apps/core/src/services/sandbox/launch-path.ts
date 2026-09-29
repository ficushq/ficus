/**
 * PATH hand-off for commands Ficus runs detached in a box's tmux (managed
 * local deployments, monitors).
 *
 * A tmux session does not inherit its caller's environment: it gets the
 * environment the box's one tmux server started with, which is whichever
 * process (another app, a monitor, an agent) happened to launch it first. A
 * command that was a bare `node` therefore ran fine on one start and failed
 * "node: command not found" on the next. The start command runs through the
 * box's own command runner, which activates the box toolchain exactly as it
 * does for agent commands, so it records that PATH beside the launcher and the
 * launcher restores it — after the login shell's profile, so the box toolchain
 * wins — rather than trusting the tmux server's.
 */

export const LAUNCH_PATH_FILE = 'launch-path'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Start-command line that records the caller's PATH in `dir`. */
export function recordLaunchPathCommand(dir: string): string {
  return `printf '%s\\n' "$PATH" > ${shellQuote(`${dir}/${LAUNCH_PATH_FILE}`)}`
}

/**
 * Launcher-script lines (for a `set -u` bash script) that load the recorded
 * PATH from the directory named by `$<dirVar>`. A missing file loads nothing.
 */
export function loadLaunchPathLines(dirVar: string): string {
  return [
    `FICUS_LAUNCH_PATH="$(cat "$${dirVar}/${LAUNCH_PATH_FILE}" 2>/dev/null || true)"`,
    'export FICUS_LAUNCH_PATH',
  ].join('\n')
}

/**
 * Launcher-script command that runs `$<commandVar>` in a login shell with the
 * loaded PATH in front. The hand-off variable is unset before the command runs.
 */
export function runWithLaunchPath(commandVar: string): string {
  return `bash -lc '[ -n "$FICUS_LAUNCH_PATH" ] && export PATH="$FICUS_LAUNCH_PATH\${PATH:+:$PATH}"; unset FICUS_LAUNCH_PATH; eval "$${commandVar}"'`
}
