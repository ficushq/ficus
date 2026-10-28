/**
 * Spawn a child, capture both streams, and report an outcome that NAMES what
 * happened.
 *
 * Why this exists (docs/history/design/ci-stability-and-flake-eradication.md, Part A):
 * tests that spawn real binaries were written as
 *
 *     const child = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
 *     await child.exited
 *     return child.exitCode
 *
 * which has two defects.
 *
 * 1. **The output is discarded.** A failure reports `Expected: 0, Received:
 *    101` and nothing else. Identifying 101 as a Rust panic required probing
 *    the binary by hand.
 * 2. **A killed child's pipes do not necessarily close.** `sh -c '…; sleep 30'`
 *    leaves `sleep` holding the write end, so a read that only resolves at
 *    end-of-stream hangs past the kill and turns a caller's budget into an
 *    unattributable test timeout. This helper accumulates chunk by chunk and
 *    can abandon the read, so a budget is always reportable.
 *
 * Measured, so the comment does not outlive the fact: Bun does NOT reproduce
 * the classic ~64 KB pipe deadlock. `await child.exited` returns in ~8 ms with
 * 5 MB pending and the full output is still readable afterwards, because Bun
 * buffers the pipe internally. Draining concurrently is still what makes the
 * timeout path work — the accumulated text has to already exist when the read
 * is abandoned — but it is not load-bearing against a deadlock here.
 *
 * It also distinguishes the failure classes that `exitCode` alone collapses.
 * `exitCode` is `null` when a child is killed by a signal, so the common
 * `expect(code).not.toBe(0)` silently accepts a SIGTERM'd child as "the
 * command correctly failed". {@link expectFailedExit} does not.
 *
 * Consumers: `notion/cli.e2e.test.ts`, `notion/core-lifecycle.e2e.test.ts`.
 * Captured output is sanitized through {@link ContentSafety} before it can
 * reach an assertion message, so diagnostics never carry credentials.
 */
import { ContentSafety } from '../services/security/content-safety'

/** Pattern-based only — no known secret values, which is correct for child output. */
const outputSafety = ContentSafety.fromSecretEntries([])

/** How many characters of each stream reach an assertion message. */
export const MAX_DIAGNOSTIC_CHARS = 4000

export type ProcessOutcome =
  /** Ran to completion and returned a status. `code` may be zero or non-zero. */
  | { kind: 'exited'; code: number; signal: null; stdout: string; stderr: string }
  /** Killed by a signal. Bun reports `exitCode: null` here. */
  | { kind: 'signaled'; code: null; signal: string; stdout: string; stderr: string }
  /** Never started — ENOENT, EBADF, permission. */
  | { kind: 'spawn-failed'; code: null; signal: null; stdout: string; stderr: string; error: string }
  /** Exceeded the caller's explicit budget and was killed. Partial output is kept. */
  | { kind: 'timed-out'; code: null; signal: null; stdout: string; stderr: string; timeoutMs: number }
  /** Neither a status nor a signal — fail closed rather than guess. */
  | { kind: 'malformed'; code: null; signal: null; stdout: string; stderr: string; error: string }

export interface RunCapturedProcessOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /**
   * Kill the child after this many ms and report `timed-out` with whatever it
   * had written. Optional and unset by default: a budget belongs to the caller
   * that can justify one, and an invisible default is exactly the accidental
   * assertion about machine speed this program is removing.
   */
  timeoutMs?: number
}

function clip(raw: string): string {
  const safe = outputSafety.redact(raw)
  return safe.length > MAX_DIAGNOSTIC_CHARS ? `${safe.slice(0, MAX_DIAGNOSTIC_CHARS)}…[truncated]` : safe
}

/**
 * Accumulate a stream chunk by chunk so the text so far is always available,
 * and the read can be abandoned.
 *
 * Not `new Response(stream).text()`: that resolves only at end-of-stream, and
 * killing a child does NOT close its pipes when a grandchild inherited them —
 * `sh -c '…; sleep 30'` leaves `sleep` holding the write end. The read then
 * hangs past the kill and the caller's budget becomes an unattributable test
 * timeout. Verified: the first version of this helper used `Response.text()`
 * and its own timeout test hit Bun's 5 s default instead of reporting.
 */
function drain(stream: ReadableStream<Uint8Array> | undefined | null): {
  done: Promise<void>
  text: () => string
  abandon: () => void
} {
  // Bun types a spawned stream as ReadableStream | number | undefined, and it
  // really can be absent: observed in CI as
  // `TypeError: undefined is not an object (evaluating 'stream.getReader')`
  // even with stdout: 'pipe'. Losing the output is bad; throwing a TypeError
  // from the helper whose job is to EXPLAIN failures is worse — it replaces
  // the child's diagnostic with one about this file. Report no output instead,
  // and let the exit classification still stand.
  if (!stream || typeof stream.getReader !== 'function') {
    return { done: Promise.resolve(), text: () => '', abandon: () => {} }
  }
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  const done = (async () => {
    try {
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        if (value) chunks.push(value)
      }
    } catch {
      // Cancelled, or the pipe broke. Whatever arrived is still in `chunks`.
    }
  })()
  return {
    done,
    text: () => {
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const joined = new Uint8Array(total)
      let at = 0
      for (const c of chunks) {
        joined.set(c, at)
        at += c.length
      }
      return new TextDecoder().decode(joined)
    },
    abandon: () => void reader.cancel().catch(() => {}),
  }
}

export async function runCapturedProcess(
  command: readonly string[],
  options: RunCapturedProcessOptions = {}
): Promise<ProcessOutcome> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...command], {
      cwd: options.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: options.env as Record<string, string>,
    })
  } catch (error) {
    // ENOENT/EACCES/EBADF: never started, so there is no status to report.
    return {
      kind: 'spawn-failed',
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  // The whole point: both streams drain WHILE the child runs. Awaiting
  // `child.exited` first would deadlock a child that outruns the pipe buffer.
  const outDrain = drain(child.stdout as ReadableStream<Uint8Array> | undefined)
  const errDrain = drain(child.stderr as ReadableStream<Uint8Array> | undefined)

  let timedOut = false
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          child.kill()
          // Abandon the reads too. The kill alone does not settle them if a
          // grandchild inherited the pipes.
          outDrain.abandon()
          errDrain.abandon()
        }, options.timeoutMs)

  await Promise.all([outDrain.done, errDrain.done, child.exited])
  if (timer !== undefined) clearTimeout(timer)

  const out = clip(outDrain.text())
  const err = clip(errDrain.text())

  if (timedOut) {
    return { kind: 'timed-out', code: null, signal: null, stdout: out, stderr: err, timeoutMs: options.timeoutMs! }
  }
  if (child.signalCode) {
    return { kind: 'signaled', code: null, signal: String(child.signalCode), stdout: out, stderr: err }
  }
  if (typeof child.exitCode === 'number') {
    return { kind: 'exited', code: child.exitCode, signal: null, stdout: out, stderr: err }
  }
  // Neither status nor signal. Report it rather than coercing to a number —
  // a normalized 0 here would be a green that is not evidence.
  return {
    kind: 'malformed',
    code: null,
    signal: null,
    stdout: out,
    stderr: err,
    error: `child reported neither an exit status nor a signal (exitCode=${String(child.exitCode)}, signalCode=${String(child.signalCode)})`,
  }
}

/** One line naming the class, plus sanitized output. Safe to put in an assertion message. */
export function describeProcessOutcome(outcome: ProcessOutcome): string {
  const headline = (() => {
    switch (outcome.kind) {
      case 'exited':
        return `exited with status ${outcome.code}`
      case 'signaled':
        return `killed by signal ${outcome.signal} (exit status is null, NOT a non-zero exit)`
      case 'spawn-failed':
        return `never started: ${outcome.error}`
      case 'timed-out':
        return `exceeded its ${outcome.timeoutMs} ms budget and was killed`
      case 'malformed':
        return outcome.error
    }
  })()
  return [headline, `stdout: ${outcome.stdout || '<empty>'}`, `stderr: ${outcome.stderr || '<empty>'}`].join('\n')
}

/**
 * Assert the child ran to completion with status 0. Every other class — signal,
 * spawn failure, timeout, malformed — fails, and says which.
 */
export function expectCleanExit(outcome: ProcessOutcome): void {
  if (outcome.kind === 'exited' && outcome.code === 0) return
  throw new Error(`expected the process to exit 0, but it ${describeProcessOutcome(outcome)}`)
}

/**
 * Assert the child ran to completion and CHOSE a non-zero status — i.e. the
 * command under test rejected its input.
 *
 * Deliberately stricter than `expect(code).not.toBe(0)`: a signal kill, a spawn
 * failure, a timeout and a malformed result are all environmental, and each
 * would satisfy `.not.toBe(0)` while proving nothing about the command.
 */
export function expectFailedExit(outcome: ProcessOutcome): void {
  if (outcome.kind === 'exited' && outcome.code !== 0) return
  if (outcome.kind === 'exited') {
    throw new Error(`expected the process to exit non-zero, but it ${describeProcessOutcome(outcome)}`)
  }
  throw new Error(
    `expected the process to exit non-zero, but it ${describeProcessOutcome(outcome)} — ` +
      'that is an environmental failure, not the command rejecting its input'
  )
}
