/**
 * The root-owned installed host record (`/etc/ficus/bigbrain/host.json`). Hosted Core runs as
 * root (an accepted, documented boundary) and reads it to build the helper envelope: tenant,
 * physical-host binding, epoch, zone, limits, pin and artifact digest. It is read with a
 * no-follow open and owner/mode/size checks on the opened descriptor; it is never written here.
 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  MANAGED_BIGBRAIN_HOST_RECORD,
  managedBigbrainInstalledHostSchema,
  managedBigbrainVaultOrigin,
  type ManagedBigbrainInstalledHost,
} from '@ficus/shared/managed-bigbrain'
import { ManagedHostError } from './host-client'

const MAX_HOST_RECORD_BYTES = 16 * 1024

export async function readInstalledHost(
  options: { path?: string; owner?: number } = {}
): Promise<ManagedBigbrainInstalledHost> {
  const path = options.path ?? MANAGED_BIGBRAIN_HOST_RECORD
  const owner = options.owner ?? 0
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new ManagedHostError('not_installed', false)
    throw new ManagedHostError('storage_unavailable', false)
  }
  try {
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== owner ||
      (info.mode & 0o022) !== 0 ||
      info.size > MAX_HOST_RECORD_BYTES
    )
      throw new ManagedHostError('storage_unavailable', false)
    const buffer = Buffer.alloc(MAX_HOST_RECORD_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_HOST_RECORD_BYTES) throw new ManagedHostError('storage_unavailable', false)
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)))
    } catch {
      throw new ManagedHostError('not_installed', false)
    }
    const parsed = managedBigbrainInstalledHostSchema.safeParse(value)
    if (!parsed.success) throw new ManagedHostError('not_installed', false)
    return parsed.data
  } finally {
    await file.close().catch(() => {})
  }
}

/** The vault origin Core assigns at create, from the installed zone and Platform-written tenant
 * label (never a client value or request Host). Persisted with the vault and never re-derived. */
export function managedVaultOrigin(
  vaultId: string,
  host: Pick<ManagedBigbrainInstalledHost, 'zone' | 'tenantLabel'>
): string {
  return managedBigbrainVaultOrigin({ vaultId, zone: host.zone, tenantLabel: host.tenantLabel })
}
