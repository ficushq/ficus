import * as fs from 'node:fs'
import { MAX_SQUAD_ENV_BYTES } from '../security/squad-env-detection-repository'

/** Controlled, value/path-free Settings errors; never return editable partial content. */
export class SquadEnvSettingsReadError extends Error {
  readonly code: 'squad_env_too_large' | 'squad_env_unreadable'
  readonly status: 413 | 409

  constructor(reason: 'oversized' | 'unreadable') {
    super(
      reason === 'oversized'
        ? 'Environment exceeds 256 KiB. Output redaction is unavailable for this file. The existing file is unchanged; reduce it outside Settings, then reload and save it here.'
        : 'Environment file cannot be read safely. The existing file is unchanged; repair the file and reload Settings.'
    )
    this.name = 'SquadEnvSettingsReadError'
    this.code = reason === 'oversized' ? 'squad_env_too_large' : 'squad_env_unreadable'
    this.status = reason === 'oversized' ? 413 : 409
  }
}

type FileIO = {
  openSync(path: string, flags: number): number
  fstatSync(fd: number): fs.Stats
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  closeSync(fd: number): void
}

/**
 * GET-only reader. One descriptor and cap+1 actual bytes bound allocations/work
 * even if the mutable file grows or is replaced after its metadata was checked.
 * Missing differs from unreadable: only a missing file permits legacy fallback.
 */
export function readSettingsEnvFile(path: string, io: FileIO = fs): string | null {
  let fd: number
  try {
    fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new SquadEnvSettingsReadError('unreadable')
  }
  try {
    const stat = io.fstatSync(fd)
    if (!stat.isFile()) throw new SquadEnvSettingsReadError('unreadable')
    if (stat.size > MAX_SQUAD_ENV_BYTES) throw new SquadEnvSettingsReadError('oversized')
    const buffer = Buffer.alloc(MAX_SQUAD_ENV_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const read = io.readSync(fd, buffer, size, buffer.length - size, size)
      if (!read) break
      size += read
    }
    if (size > MAX_SQUAD_ENV_BYTES || io.fstatSync(fd).size > MAX_SQUAD_ENV_BYTES)
      throw new SquadEnvSettingsReadError('oversized')
    return buffer.toString('utf8', 0, size)
  } catch (error) {
    if (error instanceof SquadEnvSettingsReadError) throw error
    throw new SquadEnvSettingsReadError('unreadable')
  } finally {
    io.closeSync(fd)
  }
}
