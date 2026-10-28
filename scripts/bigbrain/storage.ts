import { z } from 'zod'
import { managedPaths } from './paths'
import { MANAGED_BIGBRAIN_MAX_VAULTS } from '@ficus/shared/managed-bigbrain'

const uint = z.int().safe().nonnegative()
const uuid = z.uuid().regex(/^[0-9a-f-]{36}$/)
const policySchema = z.strictObject({
  maxVaults: uint.min(2).max(MANAGED_BIGBRAIN_MAX_VAULTS),
  perVaultDiskBytes: uint.min(16 * 1024 * 1024).max(512 * 1024 * 1024),
  minCoreFreeDiskBytes: uint.min(2 * 1024 ** 3),
})
export const storageReservationSchema = z.strictObject({
  vaultId: uuid,
  username: z.string().regex(/^bbv_[0-9a-f]{24}$/),
  port: uint.min(30000).max(30099),
  diskBytes: uint.min(1).max(512 * 1024 * 1024),
  mount: z.string(),
  image: z.string(),
})
export type StorageReservation = z.infer<typeof storageReservationSchema>

/** Called under the host lifecycle lock, before allocating anything. Existing reservations
 * include failed/partial creates until their owned resources have actually been removed.
 * This computes intent only; it is not proof that an account, mount or quota exists.
 */
export function planVaultStorage(input: {
  vaultId: string
  existing: StorageReservation[]
  policy: { maxVaults: number; perVaultDiskBytes: number; minCoreFreeDiskBytes: number }
  freeDiskBytes: number
  root?: string
}): StorageReservation {
  const parsed = z
    .strictObject({
      vaultId: uuid,
      existing: z.array(storageReservationSchema).max(MANAGED_BIGBRAIN_MAX_VAULTS),
      policy: policySchema,
      freeDiskBytes: uint,
      root: z.string().optional(),
    })
    .safeParse(input)
  if (!parsed.success) throw new Error('invalid_request')
  const { vaultId, existing, policy, freeDiskBytes, root } = parsed.data
  const paths = managedPaths({ vaultId, root })
  const username = `bbv_${vaultId.replaceAll('-', '').slice(0, 24)}`
  if (
    new Set(existing.map((v) => v.vaultId)).size !== existing.length ||
    new Set(existing.map((v) => v.port)).size !== existing.length
  )
    throw new Error('identity_mismatch')
  for (const reservation of existing) {
    const expected = managedPaths({ vaultId: reservation.vaultId, root })
    if (
      reservation.mount !== expected.mount ||
      reservation.image !== expected.image ||
      reservation.username !== `bbv_${reservation.vaultId.replaceAll('-', '').slice(0, 24)}`
    )
      throw new Error('identity_mismatch')
  }
  if (existing.some((v) => v.vaultId === vaultId)) throw new Error('request_conflict')
  if (existing.some((v) => v.username === username)) throw new Error('identity_mismatch')
  if (existing.length >= policy.maxVaults) throw new Error('capacity')
  // Free space already excludes preallocated existing images, but staging needs a second copy.
  const staging = existing.reduce((sum, v) => sum + v.diskBytes, policy.perVaultDiskBytes)
  if (freeDiskBytes < policy.perVaultDiskBytes + staging + policy.minCoreFreeDiskBytes) throw new Error('capacity')
  const port = Array.from({ length: 100 }, (_, i) => i + 30000).find((port) => !existing.some((v) => v.port === port))
  if (port === undefined) throw new Error('capacity')
  return { vaultId, username, port, diskBytes: policy.perVaultDiskBytes, mount: paths.mount, image: paths.image }
}

/** Verify the recorded mounted device before any upstream process may write. The control
 * receipt binds the loop device to the root-owned preallocated image inode separately.
 * Missing/foreign mounts never fall back to the unbounded underlying directory.
 */
export function verifyVaultMount(
  expected: { mount: string; device: string; filesystem: 'ext4' },
  mountinfo: string
): void {
  if (!/^7:\d+$/.test(expected.device) || expected.filesystem !== 'ext4') throw new Error('storage_unavailable')
  const matches = mountinfo
    .split('\n')
    .map((line) => line.split(' '))
    .filter((fields) => fields[4] === expected.mount)
  if (matches.length !== 1) throw new Error('storage_unavailable')
  const fields = matches[0]!
  const separator = fields.indexOf('-')
  const options = new Set(fields[5]?.split(','))
  if (
    fields[2] !== expected.device ||
    fields[3] !== '/' ||
    separator < 6 ||
    fields[separator + 1] !== 'ext4' ||
    !/^\/dev\/loop\d+$/.test(fields[separator + 2] ?? '') ||
    !['rw', 'nodev', 'nosuid', 'noexec'].every((v) => options.has(v))
  )
    throw new Error('storage_unavailable')
}

/** The device of the one ext4 loop mount at `mount`, or null. Loop numbers are assigned at
 * mount time (a reboot or remount may pick another), so restart checks derive the live device
 * and prove its backing file instead of trusting the number recorded at create. */
export function currentLoopMountDevice(mount: string, mountinfo: string): string | null {
  const matches = mountinfo
    .split('\n')
    .map((line) => line.split(' '))
    .filter((fields) => fields[4] === mount)
  const device = matches.length === 1 ? matches[0]![2] : undefined
  return device && /^7:\d+$/.test(device) ? device : null
}

/** Linux dev_t is not a32-bit major/minor pair. fstat of the held directory must
 * match the verified loop device BEFORE ownership changes or creating any child.
 */
export function linuxDeviceId(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('storage_unavailable')
  const device = BigInt(value)
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n)
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n)
  return `${major}:${minor}`
}
