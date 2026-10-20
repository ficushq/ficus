import { lstat, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HOST_BUN, runPrivateCommand, type PrivateCommandRunner } from './process'

/** The interpreter every managed BigBrain bundle runs under (installed root-owned by setup). */
export { HOST_BUN }

async function assertOperatorOwned(path: string, uid: number): Promise<void> {
  // The file itself and EVERY ancestor: a writable parent could swap the interpreter.
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current)
    const stickyRoot = info.isDirectory() && info.uid === 0 && (info.mode & 0o1000) !== 0
    if ((info.uid !== 0 && info.uid !== uid) || ((info.mode & 0o022) !== 0 && !stickyRoot && !info.isSymbolicLink()))
      throw new Error('unsupported_host')
    if (current === '/') return
  }
}

/** The bundles are only as trustworthy as the interpreter: the configured path, its resolved
 * target and every parent directory must be operator-owned and not group/other-writable, and it
 * must report EXACTLY the Bun version the artifact was built and smoke-tested with.
 */
export async function verifyHostBun(
  expectedVersion: string,
  options: { path?: string; uid?: number; run?: PrivateCommandRunner } = {}
): Promise<void> {
  const path = options.path ?? HOST_BUN
  const uid = options.uid ?? 0
  try {
    await assertOperatorOwned(path, uid)
    const target = await realpath(path)
    await assertOperatorOwned(target, uid)
    if (!(await lstat(target)).isFile()) throw new Error()
    const result = await (options.run ?? runPrivateCommand)([target, '--version'])
    if (result.code !== 0 || result.stdout.trim() !== expectedVersion) throw new Error()
  } catch {
    throw new Error('unsupported_host')
  }
}
