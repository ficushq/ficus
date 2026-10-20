import { expect, test } from 'bun:test'
import { assertCgroupBudget, proveSocketBindPolicy, verifyLoopBacking } from './preflight'
const facts = {
  memoryMax: '268435456',
  swapMax: '0',
  pidsMax: '64',
  aggregateMemoryMax: '671088640',
  aggregateMemoryHigh: '536870912',
  aggregateSwapMax: '0',
  aggregatePidsMax: '192',
  aggregateCpuMax: '50000 100000',
  limits: 'Max open files            256                  256                  files',
}
test('preflight reads enforceable cgroup-v2 values, not unit declarations or an optimistic marker', () => {
  expect(() => assertCgroupBudget('vault', facts)).not.toThrow()
  for (const bad of [
    { ...facts, memoryMax: 'max' },
    { ...facts, swapMax: '1' },
    { ...facts, memoryMax: '268435457' },
    { ...facts, aggregateMemoryMax: 'max' },
    { ...facts, aggregateCpuMax: 'max 100000' },
    { ...facts, aggregateCpuMax: '60000 100000' },
    { ...facts, pidsMax: 'max' },
    { ...facts, limits: 'Max open files 512 512 files' },
  ])
    expect(() => assertCgroupBudget('vault', bad)).toThrow('unsupported_host')
})
test('own port must bind, a denied arbitrary port must return policy denial, never collision; probes close even if unsupported', async () => {
  const calls: number[] = []
  let closed = 0
  const binder = async (port: number) => {
    calls.push(port)
    if (port === 0) throw Object.assign(new Error(), { code: 'EACCES' })
    return {
      close: async () => {
        closed++
      },
    }
  }
  await proveSocketBindPolicy(30000, binder)
  expect(calls).toEqual([30000, 0])
  expect(closed).toBe(1)
  for (const code of ['EADDRINUSE', 'UNKNOWN'])
    await expect(
      proveSocketBindPolicy(null, async () => {
        throw Object.assign(new Error(), { code })
      })
    ).rejects.toThrow('unsupported_host')
  await proveSocketBindPolicy(null, async () => {
    throw Object.assign(new Error(), { code: 'EPERM' })
  })
  await expect(
    proveSocketBindPolicy(null, async () => ({
      close: async () => {
        closed++
      },
    }))
  ).rejects.toThrow('unsupported_host')
  expect(closed).toBe(2)
})
test('loop device is tied to the exact root-owned image inode and backing filesystem, not merely a path', () => {
  const expected = { device: '7:4', image: '/var/lib/ficus-bigbrain/volumes/a.img', inode: 321, imageDevice: 2049 }
  const loop = { name: '/dev/loop4', 'back-file': expected.image, 'back-ino': 321, 'back-maj:min': '8:1' }
  expect(() => verifyLoopBacking(expected, { loopdevices: [loop] })).not.toThrow()
  for (const bad of [
    { ...loop, name: '/dev/loop5' },
    { ...loop, 'back-ino': 322 },
    { ...loop, 'back-file': expected.image + '.other' },
    { ...loop, 'back-maj:min': '8:2' },
  ])
    expect(() => verifyLoopBacking(expected, { loopdevices: [bad] })).toThrow('storage_unavailable')
})
