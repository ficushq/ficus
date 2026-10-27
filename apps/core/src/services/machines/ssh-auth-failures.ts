/**
 * Failed SSH logins on this Core host, for the platform usage sample's `sshAuthFailures`: the
 * number of sshd journal lines matching {@link SSH_AUTH_FAILURE_PATTERN} since the previous
 * sample. The platform alerts on it (brute force against a hosted Core VM); this side only counts.
 *
 * Read with `journalctl --unit=ssh` (Ubuntu's sshd unit), which a non-root Core can do through
 * the `systemd-journal` group the setup toolkit gives it. Successive samples are joined by the
 * journal cursor, so no line is counted twice and none is missed between two samples; until the
 * journal has returned a cursor, a read starts where the previous one did (the first one of a
 * process covers the last report interval). Every line matching the pattern counts
 * (one rejected attempt can log both `Invalid user` and `Failed password for invalid user`), so
 * this is an alerting signal, not an exact attempt count. A failed read is `null`: the sample
 * omits the key rather than report a zero it did not observe.
 */

export const SSH_AUTH_FAILURE_PATTERN = /Failed password|Invalid user|authentication failure/

const CURSOR_PREFIX = '-- cursor: '

export interface JournalRead {
  exitCode: number
  stdout: string
}

export type JournalRunner = (argv: string[]) => Promise<JournalRead>

/** Count the matching lines of `journalctl --output=cat --show-cursor` output, and its cursor. */
export function parseSshAuthJournal(output: string): { count: number; cursor?: string } {
  let count = 0
  let cursor: string | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith(CURSOR_PREFIX)) cursor = line.slice(CURSOR_PREFIX.length).trim() || undefined
    else if (SSH_AUTH_FAILURE_PATTERN.test(line)) count++
  }
  return { count, cursor }
}

async function runJournalctl(argv: string[]): Promise<JournalRead> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  const timeout = setTimeout(() => proc.kill(), 10_000)
  try {
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { exitCode, stdout }
  } finally {
    clearTimeout(timeout)
  }
}

export interface SshAuthFailureSampler {
  /** Matching lines since the previous successful sample; null when the journal could not be read. */
  sample(): Promise<number | null>
}

export function createSshAuthFailureSampler(
  options: { run?: JournalRunner; firstWindowSeconds?: number; now?: () => number } = {}
): SshAuthFailureSampler {
  const run = options.run ?? runJournalctl
  const now = options.now ?? Date.now
  let cursor: string | undefined
  // Until the journal has given a cursor: where the next read starts (epoch seconds).
  let since = Math.floor(now() / 1000) - (options.firstWindowSeconds ?? 300)
  return {
    async sample() {
      const startedAt = Math.floor(now() / 1000)
      const argv = [
        'journalctl',
        '--unit=ssh',
        '--output=cat',
        '--no-pager',
        '--quiet',
        '--show-cursor',
        cursor ? `--after-cursor=${cursor}` : `--since=@${since}`,
      ]
      let read: JournalRead
      try {
        read = await run(argv)
      } catch {
        return null
      }
      if (read.exitCode !== 0) return null
      const parsed = parseSshAuthJournal(read.stdout)
      if (parsed.cursor) cursor = parsed.cursor
      else if (!cursor) since = startedAt // nothing logged yet: continue from this read
      return parsed.count
    },
  }
}
