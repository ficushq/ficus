import { isAbsolute } from 'node:path'

/** Kept here (not host-bun.ts) to avoid an import cycle; host-bun re-exports it. */
export const HOST_BUN = '/usr/local/bin/bun'

export type PrivateCommandResult = {
  code: number
  /** Private, success-only output. Never log or serialize generically. */ stdout: string
}
export type PrivateCommandRunner = (
  argv: string[],
  options?: { input?: string; timeoutMs?: number; maxOutputBytes?: number }
) => Promise<PrivateCommandResult>
/** Internal root-controller primitive, NOT a helper/HTTP command API. Every caller supplies
 * fixed root-owned executables and validated source-built argv, never a caller command/path.
 * The enclosing bounded control unit owns/kills ALL descendants, including after SSH loss.
 */
/** The argument policy every runPrivateCommand call must satisfy (throws invalid_request). Exported so
 * tests that inject a runner can hold their callers to the same limits as the real one. */
export function validatePrivateCommand(argv: string[], options: Parameters<PrivateCommandRunner>[1] = {}): void {
  const timeoutMs = options.timeoutMs ?? 15000
  const maxOutputBytes = options.maxOutputBytes ?? 16384
  if (
    !argv.length ||
    !isAbsolute(argv[0]!) ||
    argv.length > 100 ||
    argv.some((a) => a.includes('\0')) ||
    Buffer.byteLength(argv.join('\0')) > 8192 ||
    (options.input !== undefined && Buffer.byteLength(options.input) > 8192) ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1024 ||
    maxOutputBytes > 1048576 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 45000
  )
    throw new Error('invalid_request')
}

export const runPrivateCommand: PrivateCommandRunner = async (argv, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 15000
  validatePrivateCommand(argv, options)
  const maxOutputBytes = options.maxOutputBytes ?? 16384
  const child = (() => {
    try {
      return Bun.spawn(argv, {
        cwd: '/',
        env: { HOME: '/nonexistent', PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch {
      throw new Error('operation_failed')
    }
  })()
  const kill = () => {
    try {
      if (child.exitCode === null) child.kill('SIGKILL')
    } catch {
      /* already exited */
    }
  }
  let timedOut = false
  let overflow = false
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutMs)
  const consume = async (stream: ReadableStream<Uint8Array>, retain: boolean) => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > (retain ? maxOutputBytes : 16384)) {
          overflow = true
          kill()
        } else if (retain && !overflow) chunks.push(next.value)
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } finally {
      reader.releaseLock()
    }
  }
  const out = consume(child.stdout, true)
  const err = consume(child.stderr, false)
  try {
    if (options.input !== undefined) await child.stdin.write(options.input)
    await child.stdin.end()
    const [stdout] = await Promise.all([out, err])
    const code = await child.exited
    if (overflow) throw new Error('output_limit')
    if (timedOut) throw new Error('operation_failed')
    return { code, stdout: code === 0 ? stdout : '' }
  } catch (error) {
    if (overflow || (error instanceof Error && error.message === 'output_limit')) throw new Error('output_limit')
    throw new Error('operation_failed')
  } finally {
    clearTimeout(timer)
    kill()
    await child.exited
    await Promise.allSettled([out, err])
  }
}

/** Only a verified per-vault identity may execute the immutable native component.
 * Explicit group/capability clearing is required: setuid alone is not a supplementary-group fence.
 */
/** A start Ficus asked for (create, resume, backup release) — not a crash-loop restart. systemd
 * counts manual starts toward StartLimitBurst too, so a vault that was deliberately stopped and
 * started a few times would otherwise be refused; `reset-failed` clears only that accounting
 * (Restart=on-failure crash loops are still limited between deliberate starts). */
export async function startServiceDeliberately(
  run: PrivateCommandRunner,
  unit: string,
  options: { enable?: boolean; restart?: boolean } = {}
): Promise<boolean> {
  await run(['/usr/bin/systemctl', 'reset-failed', unit])
  if (options.restart) {
    // `start`/`enable --now` leave an already-running process alone: after an upgrade it would keep
    // serving the previous release's code. `restart` also starts a stopped unit.
    if (options.enable && (await run(['/usr/bin/systemctl', 'enable', unit])).code !== 0) return false
    return (await run(['/usr/bin/systemctl', 'restart', unit], { timeoutMs: 45000 })).code === 0
  }
  const start = options.enable ? ['enable', '--now', unit] : ['start', unit]
  return (await run(['/usr/bin/systemctl', ...start], { timeoutMs: 45000 })).code === 0
}

export function vaultCommand(identity: { uid: number; gid: number }, script: string, args: string[]): string[] {
  if (
    ![identity.uid, identity.gid].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 0xfffffffe) ||
    !/^\/opt\/ficus-bigbrain\/releases\/[a-f0-9]{64}\/(?:bigbrain-shared|bigbrain-owner-link|bigbrain-members)\.js$/.test(
      script
    )
  )
    throw new Error('invalid_request')
  return [
    '/usr/bin/setpriv',
    `--reuid=${identity.uid}`,
    `--regid=${identity.gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    '--pdeathsig=KILL',
    '/usr/bin/env',
    '-i',
    'HOME=/nonexistent',
    'PATH=/usr/bin:/bin',
    'LANG=C.UTF-8',
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0',
    // The verified host interpreter; never auto-installs packages or reads a cwd .env.
    HOST_BUN,
    '--no-install',
    '--no-env-file',
    script,
    ...args,
  ]
}
