import { expect, test } from 'bun:test'
import { planVaultStorage, verifyVaultMount, linuxDeviceId } from './storage'
import { managedPaths } from './paths'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const GiB = 1024 ** 3
const policy = { maxVaults: 2, perVaultDiskBytes: GiB / 2, minCoreFreeDiskBytes: 2 * GiB }

test('reserves independent users, ports, images and mounts under an aggregate budget', () => {
  const a = planVaultStorage({ vaultId: A, existing: [], policy, freeDiskBytes: 6 * GiB })
  const b = planVaultStorage({ vaultId: B, existing: [a], policy, freeDiskBytes: 5 * GiB })
  expect(a.username).not.toBe(b.username)
  expect(a.port).not.toBe(b.port)
  expect(a.mount).not.toBe(b.mount)
  expect(a.image).not.toBe(b.image)
  expect(a.diskBytes).toBe(GiB / 2)
  expect(() => planVaultStorage({ vaultId: A, existing: [a, b], policy, freeDiskBytes: 10 * GiB })).toThrow(
    'request_conflict'
  )
  expect(() =>
    planVaultStorage({
      vaultId: '33333333-3333-4333-8333-333333333333',
      existing: [a, b],
      policy,
      freeDiskBytes: 10 * GiB,
    })
  ).toThrow('capacity')
})
test('refuses overcommit including worst-case backup staging and Core reserve', () => {
  expect(() => planVaultStorage({ vaultId: A, existing: [], policy, freeDiskBytes: 2.5 * GiB })).toThrow('capacity')
  expect(() =>
    planVaultStorage({
      vaultId: A,
      existing: [],
      policy: { ...policy, minCoreFreeDiskBytes: 1 },
      freeDiskBytes: 10 * GiB,
    })
  ).toThrow('invalid_request')
})
test('full-ID check refuses a truncated username collision, never adopts an existing account', () => {
  const a = planVaultStorage({ vaultId: A, existing: [], policy, freeDiskBytes: 10 * GiB })
  const collision = '11111111-1111-4111-8111-111111111112'
  expect(() => planVaultStorage({ vaultId: collision, existing: [a], policy, freeDiskBytes: 10 * GiB })).toThrow(
    'identity_mismatch'
  )
})
test('mount preflight checks actual ext4 device, mountpoint and mandatory options', () => {
  const paths = managedPaths({ vaultId: A })
  const recorded = { mount: paths.mount, device: '7:1', filesystem: 'ext4' as const }
  const line = `91 20 7:1 / ${paths.mount} rw,nodev,nosuid,noexec,relatime - ext4 /dev/loop1 rw\n`
  expect(() => verifyVaultMount(recorded, line)).not.toThrow()
  for (const mountinfo of [
    '',
    line.replace('7:1', '7:2'),
    line.replace(',noexec', ''),
    line.replace('ext4', 'tmpfs'),
    line.replace(paths.mount, paths.mount + '/child'),
  ]) {
    expect(() => verifyVaultMount(recorded, mountinfo)).toThrow('storage_unavailable')
  }
})

test('decodes Linux fstat device identity without32-bit truncation; invalid descriptors refuse', () => {
  expect(linuxDeviceId(2049)).toBe('8:1')
  expect(linuxDeviceId(1796)).toBe('7:4')
  expect(linuxDeviceId(2 ** 48)).toBe('65536:0')
  expect(linuxDeviceId(2 ** 48 + 2 ** 32)).toBe('65536:1048576')
  expect(() => linuxDeviceId(-1)).toThrow('storage_unavailable')
  expect(() => linuxDeviceId(Number.MAX_SAFE_INTEGER + 1)).toThrow('storage_unavailable')
})
