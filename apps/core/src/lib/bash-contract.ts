export const BASH_DEFAULT_TIMEOUT_SECONDS = 180
export const BASH_MAX_TIMEOUT_SECONDS = 3_600

export const FOREGROUND_BASH_GUIDANCE =
  'Work that must complete reliably must stay in this foreground invocation; set timeout up to 3600s. ' +
  'Detached background processes are unsupported for completion-critical work (including &, nohup, setsid, disown, and hand-launched tmux) and may be terminated when a remote box idles.'

/**
 * How bash output is truncated. pi's bash tools run with `persistFullOutput: false`: by default
 * pi keeps output past the display limit in an unredacted /tmp/pi-bash-*.log file on the Core
 * host that is never deleted (and that sandboxed agents cannot reach anyway), so the full
 * output is not saved and the agent is told to keep long output itself.
 */
export const BASH_OUTPUT_TRUNCATION_NOTE =
  'Output is truncated to last 2000 lines or 50KB (whichever is hit first) and the rest is not kept; redirect long output to a file to read it in parts.'

/** Normalize a user-facing Bash timeout to the supported foreground window. */
export function normalizeBashTimeoutSeconds(timeout?: number): number {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) return BASH_DEFAULT_TIMEOUT_SECONDS
  return Math.min(timeout, BASH_MAX_TIMEOUT_SECONDS)
}
