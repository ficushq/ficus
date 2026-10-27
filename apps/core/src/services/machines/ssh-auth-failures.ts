/**
 * Failed SSH logins on this Core host, for the platform usage sample's `sshAuthFailures`: the
 * number of sshd journal lines matching {@link SSH_AUTH_FAILURE_PATTERN} since the previous
 * sample. The platform alerts on it (brute force against a hosted Core VM); this side only counts.
 *
 * Read with `journalctl --unit=ssh` (Ubuntu's sshd unit), which a non-root Core can do through
 * the `systemd-journal` group the setup toolkit gives it. Every read is bounded, because it runs
 * inside the api/worker and is needed most during a burst:
 *
 * - Samples cover consecutive, non-overlapping time windows (`--since=@a --until=@b`, whole
 *   seconds, both inclusive; the next window starts at b+1). The window advances before the read,
 *   whatever the read does, so a failed, capped or timed-out read never leaves a backlog for the
 *   next one. The first window of a process covers the last report interval.
 * - Lines are counted as they stream in, never held. (journald's own `--grep` is not used: it
 *   exits 1 both for "no match" and for "built without pattern support", so a quiet window and a
 *   broken filter would look the same.)
 * - At most {@link SSH_AUTH_JOURNAL_MAX_BYTES} are read and at most 10 s spent: past either, the
 *   process is killed and the count so far is reported as a lower bound (a burst big enough to
 *   hit the cap is one the platform should alert on anyway).
 *
 * Every matching line counts (one rejected attempt can log both `Invalid user` and `Failed
 * password for invalid user`), so this is an alerting signal, not an exact attempt count. A read
 * that observed nothing (journalctl failed, or timed out before any match) is `null`: the sample
 * omits the key rather than report a zero it did not observe.
 */

export const SSH_AUTH_FAILURE_PATTERN = /Failed password|Invalid user|authentication failure/
export const SSH_AUTH_JOURNAL_MAX_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 10_000

export interface JournalProcess {
  stdout: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(): void
}
export type JournalSpawn = (argv: string[]) => JournalProcess

const spawnJournalctl: JournalSpawn = (argv) => {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill: () => proc.kill('SIGKILL'),
  }
}

/** Count the matching lines of PROC's stdout as they arrive, within the byte and time bounds. */
export async function countMatchingLines(
  proc: JournalProcess,
  limits: { maxBytes: number; timeoutMs: number }
): Promise<{ count: number; exitCode: number; cut: boolean }> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let cut = false
  let pending = ''
  let bytes = 0
  let count = 0
  const stop = () => {
    cut = true
    proc.kill()
    reader.cancel().catch(() => {})
  }
  const timer = setTimeout(stop, limits.timeoutMs)
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      // Never past the cap, even within one (pipe-sized) chunk.
      const chunk = next.value.subarray(0, limits.maxBytes - bytes)
      bytes += chunk.byteLength
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (SSH_AUTH_FAILURE_PATTERN.test(line)) count++
      if (bytes >= limits.maxBytes) {
        stop()
        break
      }
    }
  } catch {
    // The stream errored (the process was killed mid-read): what was counted stands.
  } finally {
    clearTimeout(timer)
  }
  // A final line without a newline counts only when the read was complete.
  if (!cut && SSH_AUTH_FAILURE_PATTERN.test(pending)) count++
  const exitCode = await proc.exited
  return { count, exitCode, cut }
}

export interface SshAuthFailureSampler {
  /** Matching lines since the previous sample; null when nothing could be observed. */
  sample(): Promise<number | null>
}

export function createSshAuthFailureSampler(
  options: {
    spawn?: JournalSpawn
    firstWindowSeconds?: number
    now?: () => number
    maxBytes?: number
    timeoutMs?: number
  } = {}
): SshAuthFailureSampler {
  const spawn = options.spawn ?? spawnJournalctl
  const now = options.now ?? Date.now
  const limits = {
    maxBytes: options.maxBytes ?? SSH_AUTH_JOURNAL_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
  }
  let since = Math.floor(now() / 1000) - (options.firstWindowSeconds ?? 300)

  return {
    async sample() {
      // Whole seconds, both ends inclusive: [since, until], then the next window starts at until+1.
      const until = Math.floor(now() / 1000) - 1
      if (until < since) return 0
      const argv = [
        'journalctl',
        '--unit=ssh',
        '--output=cat',
        '--no-pager',
        '--quiet',
        `--since=@${since}`,
        `--until=@${until}`,
      ]
      // Advance first: whatever this read does, the next one never re-reads this window.
      since = until + 1
      let proc: JournalProcess
      try {
        proc = spawn(argv)
      } catch {
        return null
      }
      const { count, exitCode, cut } = await countMatchingLines(proc, limits)
      // Cut short (byte cap or timeout): the count so far is a lower bound, if it saw anything.
      if (cut) return count > 0 ? count : null
      return exitCode === 0 ? count : null
    },
  }
}
