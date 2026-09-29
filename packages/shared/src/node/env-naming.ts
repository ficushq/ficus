import { existsSync, readFileSync } from 'fs'
import { EnvNamingError, foreignEncryptionKeyNames } from '../env-naming'

/**
 * Throws EnvNamingError when the dotenv file at `path` holds an encryption key from before the Ficus
 * naming (see foreignEncryptionKeyNames). A missing file passes. Reads only; never writes.
 */
export function assertEnvFileNaming(path: string): void {
  if (!existsSync(path)) return
  const names = foreignEncryptionKeyNames(readFileSync(path, 'utf8'))
  if (names.length > 0) throw new EnvNamingError(path, names)
}
