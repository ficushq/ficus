/**
 * Core-side import of a managed vault's private read handoff.
 *
 * The root control worker writes `/var/lib/ficus-bigbrain/read-handoff/<vaultId>.json` (owner
 * root, no write for anyone else, never world-readable). Core reads it with a no-follow open and
 * checks type/owner/mode/size on the opened descriptor, then the strict shared schema. The token
 * never leaves this module except into the credential store; nothing here is logged or returned
 * in any DTO.
 */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { managedBigbrainReadHandoffSchema, type ManagedBigbrainReadHandoff } from '@ficus/shared/managed-bigbrain'

export const MANAGED_READ_HANDOFF_DIRECTORY = '/var/lib/ficus-bigbrain/read-handoff'
const MAX_HANDOFF_BYTES = 4096
const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class ManagedReadMaterialError extends Error {
  constructor(readonly code: 'invalid_request' | 'storage_unavailable' | 'invalid_response') {
    super(code)
    this.name = 'ManagedReadMaterialError'
  }
}

/** The handoff for one vault, or null when the host has not written one (yet, or after revoke). */
export async function readManagedReadHandoff(
  vaultId: string,
  options: { directory?: string; owner?: number } = {}
): Promise<ManagedBigbrainReadHandoff | null> {
  if (!VAULT_ID.test(vaultId)) throw new ManagedReadMaterialError('invalid_request')
  const directory = options.directory ?? MANAGED_READ_HANDOFF_DIRECTORY
  const owner = options.owner ?? 0
  let parent
  try {
    parent = await lstat(directory)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw new ManagedReadMaterialError('storage_unavailable')
  }
  if (!parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o022) !== 0)
    throw new ManagedReadMaterialError('storage_unavailable')
  let file
  try {
    file = await open(
      join(directory, `${vaultId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw new ManagedReadMaterialError('storage_unavailable')
  }
  try {
    const info = await file.stat()
    // Owner-written only; group read is tolerated for a future dedicated Core group, never other.
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== owner ||
      (info.mode & 0o037) !== 0 ||
      info.size > MAX_HANDOFF_BYTES
    )
      throw new ManagedReadMaterialError('storage_unavailable')
    const buffer = Buffer.alloc(MAX_HANDOFF_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_HANDOFF_BYTES) throw new ManagedReadMaterialError('storage_unavailable')
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)))
    } catch {
      throw new ManagedReadMaterialError('invalid_response')
    }
    const parsed = managedBigbrainReadHandoffSchema.safeParse(value)
    if (!parsed.success || parsed.data.vaultId !== vaultId) throw new ManagedReadMaterialError('invalid_response')
    return parsed.data
  } finally {
    await file.close().catch(() => {})
  }
}

/** Split a handoff into its persistable, token-free facts and the secret token. */
export function splitReadHandoff(handoff: ManagedBigbrainReadHandoff): {
  material: Omit<ManagedBigbrainReadHandoff, 'token'>
  token: string
} {
  const { token, ...material } = handoff
  return { material, token }
}
