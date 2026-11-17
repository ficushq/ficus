export const BASH_DEFAULT_TIMEOUT_SECONDS = 180
export const BASH_MAX_TIMEOUT_SECONDS = 3_600

export const FOREGROUND_BASH_GUIDANCE =
  'Work that must complete reliably must stay in this foreground invocation; set timeout up to 3600s. ' +
  'Detached background processes are unsupported for completion-critical work (including &, nohup, setsid, disown, and hand-launched tmux) and may be terminated when a remote box idles.'

/**
 * Sandboxed runtimes only (the box server tracks what each agent command leaves
 * running; see packages/sandbox-server/src/services/leftover-processes.ts). The
 * host runtime has no box server and no such cleanup.
 */
export const LEFTOVER_PROCESS_GUIDANCE =
  'Processes your commands leave running in the background (dev servers, test databases) are stopped automatically ' +
  'when your flow step ends, when you go dormant, when the work stream is done or canceled, and when the last slot ' +
  'claim you held while starting them is released or expires; stop them yourself ' +
  'as soon as you no longer need them. To keep a service running past that, start it with FICUS_KEEP_RUNNING=1 in ' +
  'its environment (for example `FICUS_KEEP_RUNNING=1 npm run dev &`), or use `ficus deploy` for an app.'

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
