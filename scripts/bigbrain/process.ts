import { isAbsolute } from 'node:path'

export type PrivateCommandResult = {
  code: number
  /** Private, success-only output. Never log or serialize generically. */ stdout: string
}
export type PrivateCommandRunner = (
  argv: string[],
  options?: { input?: string; timeoutMs?: number }
) => Promise<PrivateCommandResult>
/** Internal root-controller primitive, NOT a helper/HTTP command API. Every caller supplies
 * fixed root-owned executables and validated source-built argv, never a caller command/path.
 * The enclosing bounded control unit owns/kills ALL descendants, including after SSH loss.
 */
export const runPrivateCommand: PrivateCommandRunner = async (argv, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 15000
  if (
    !argv.length ||
    !isAbsolute(argv[0]!) ||
    argv.length > 100 ||
    argv.some((a) => a.includes('\0')) ||
    Buffer.byteLength(argv.join('\0')) > 8192 ||
    (options.input !== undefined && Buffer.byteLength(options.input) > 8192) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 45000
  )
    throw new Error('invalid_request')
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
        if (size > 16384) {
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
export function vaultCommand(identity: { uid: number; gid: number }, binary: string, args: string[]): string[] {
  if (
    ![identity.uid, identity.gid].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 0xfffffffe) ||
    !/^\/opt\/ficus-bigbrain\/releases\/[a-f0-9]{64}\/(?:bigbrain-shared|bigbrain-owner-link)$/.test(binary)
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
    binary,
    ...args,
  ]
}
