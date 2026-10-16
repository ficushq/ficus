import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { storageHomeResults, storageScanItems, storageScanPasses, storageUsageSamples } from '../../db/schema'
import type { Machine } from '../machines/queries'
import type { SshRunner } from '../machines/ssh'
import { SshTimeoutError } from '../machines/ssh'
import { assembleHome, MAX_ITEMS_PER_PASS, RETAIN_PASSES, scanMachine, type ScanContext } from './scanner'
import { fakeRemote, fixtureTree } from './scan.test-helper'
import { buildStorageSnapshot } from './view'

const machine = { id: crypto.randomUUID(), name: 'Scan test host', status: 'ready' } as Machine
const homesOf = (dirs: Map<string, number>) => [...dirs.keys()].filter((path) => path.split('/').length === 3)
const owners = (homes: string[]) =>
  homes.map((home) => ({ home, squadId: 'squad', squadName: 'Product', label: home.slice(6) }))

async function cleanup() {
  await db.delete(storageScanPasses).where(eq(storageScanPasses.machineId, machine.id))
  await db.delete(storageHomeResults).where(eq(storageHomeResults.machineId, machine.id))
  await db.delete(storageUsageSamples).where(eq(storageUsageSamples.machineId, machine.id))
}
beforeEach(cleanup)
afterEach(cleanup)

function context(runner: SshRunner, overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    runner,
    deadline: Date.now() + 60_000,
    intervalMs: 3_600_000,
    requestedAt: null,
    holdsLease: async () => true,
    sleep: async () => {},
    ...overrides,
  }
}

const passes = () =>
  db
    .select()
    .from(storageScanPasses)
    .where(eq(storageScanPasses.machineId, machine.id))
    .orderBy(storageScanPasses.generation)
const results = async () =>
  new Map(
    (await db.select().from(storageHomeResults).where(eq(storageHomeResults.machineId, machine.id))).map((row) => [
      row.home,
      row,
    ])
  )
async function items() {
  const ids = (await passes()).map((pass) => pass.id)
  return ids.length ? db.select().from(storageScanItems).where(inArray(storageScanItems.passId, ids)) : []
}

describe('incremental storage scanner', () => {
  test('a tree larger than one chunk completes across multiple chunks with exact totals', async () => {
    const dirs = fixtureTree(20, 3)
    const remote = fakeRemote(dirs, { budget: 40 })
    await scanMachine({ machine, homes: homesOf(dirs) }, context(remote.runner))
    expect(remote.calls.length).toBeGreaterThan(3)
    // Paths cut off behind others in a batch were retried alone and finished without splitting.
    expect(remote.calls.some((call) => call.kind === 'measure' && call.paths.length === 1)).toBe(true)
    expect(remote.calls.some((call) => call.kind === 'list')).toBe(false)
    const [pass] = await passes()
    expect(pass).toMatchObject({ generation: 1, status: 'completed', homes: 20, usedBytes: 1000, totalBytes: 2000 })
    const saved = await results()
    for (const home of homesOf(dirs)) {
      expect(saved.get(home)).toMatchObject({ bytes: remote.total(home), status: 'available', generation: 1 })
      expect(saved.get(home)!.folder.children).toHaveLength(3)
    }
    // The queue is removed once results are materialized.
    expect(await items()).toHaveLength(0)
    // Paths travel only on stdin.
    for (const call of remote.calls) for (const path of call.paths) expect(call.command).not.toContain(path)
  })

  test('a chunk timeout retries alone, then splits into subdirectories, and still totals exactly', async () => {
    const dirs = fixtureTree(3, 6)
    // Budget below one home (1 + 6 + 36 directories): homes must be split.
    const remote = fakeRemote(dirs, { budget: 20 })
    await scanMachine({ machine, homes: homesOf(dirs) }, context(remote.runner))
    expect(remote.calls.some((call) => call.kind === 'list')).toBe(true)
    // The first home timed out with the full budget and was split; later homes were retried alone first.
    expect(remote.calls.filter((call) => call.kind === 'measure' && call.paths.length === 1).length).toBeGreaterThan(0)
    const saved = await results()
    for (const home of homesOf(dirs)) {
      expect(saved.get(home)).toMatchObject({ bytes: remote.total(home), status: 'available' })
      const child = saved.get(home)!.folder.children.find((folder) => folder.name === 'd0')!
      expect(child.bytes).toBe(remote.total(`${home}/d0`))
      expect(child.children).toHaveLength(6)
    }
    expect((await passes())[0]!.status).toBe('completed')
  })

  test('a directory that cannot be measured even after splitting fails alone and the pass terminates', async () => {
    const dirs = fixtureTree(2, 4)
    const flat = '/home/box_000000000000/d1/e1'
    // Too large for any chunk, with nothing below it to split into; listing it hangs the connection.
    const remote = fakeRemote(dirs, { budget: 6, cost: new Map([[flat, 1000]]) })
    const runner: SshRunner = {
      run: async (target, command, opts) => {
        if (command.includes('find') && String(opts?.stdin ?? '').includes(`${flat}\0`)) {
          remote.calls.push({ kind: 'list', paths: [flat], command })
          throw new SshTimeoutError('slow')
        }
        return remote.runner.run(target, command, opts)
      },
    }
    await scanMachine({ machine, homes: homesOf(dirs) }, context(runner))
    expect(remote.calls.length).toBeLessThan(50)
    // First in its batch (so it had the full time limit), then listed once: no step repeated.
    const flatCalls = remote.calls.filter((call) => call.paths.includes(flat))
    expect(flatCalls.map((call) => [call.kind, call.paths[0] === flat])).toEqual([
      ['measure', true],
      ['list', true],
    ])
    expect((await passes())[0]!.status).toBe('completed')
    const saved = await results()
    const broken = saved.get('/home/box_000000000000')!
    expect(broken.status).toBe('partial')
    expect(broken.errors).toEqual(['scan_timeout'])
    // Everything measurable is still counted; the unmeasured folder is shown, not zero.
    expect(broken.bytes).toBe(remote.total('/home/box_000000000000') - dirs.get(flat)!)
    const d1 = broken.folder.children.find((folder) => folder.name === 'd1')!
    expect(d1.status).toBe('partial')
    expect(d1.children.find((folder) => folder.name === 'e1')).toMatchObject({ bytes: null, status: 'unavailable' })
    expect(saved.get('/home/box_000000000001')).toMatchObject({ status: 'available' })
  })

  test('a hung or killed command advances its path instead of retrying it forever', async () => {
    const dirs = fixtureTree(2, 2)
    const stuck = '/home/box_000000000001/d0'
    const remote = fakeRemote(dirs, { budget: 100, cost: new Map([[stuck, 1000]]) })
    let killed = 0
    const runner: SshRunner = {
      run: async (target, command, opts) => {
        if (String(opts?.stdin ?? '').startsWith(`${stuck}\0`)) {
          remote.calls.push({ kind: command.includes('find') ? 'list' : 'measure', paths: [stuck], command })
          killed++
          return { exitCode: killed === 1 ? 137 : 125, stdout: 'Used 1B-blocks\n1000 2000\n\0', stderr: '' }
        }
        // Let the home itself time out so the stuck subdirectory is measured on its own.
        if (String(opts?.stdin ?? '') === '/home/box_000000000001\0' && command.includes('du '))
          return { exitCode: 124, stdout: 'Used 1B-blocks\n1000 2000\n\0', stderr: '' }
        return remote.runner.run(target, command, opts)
      },
    }
    await scanMachine({ machine, homes: homesOf(dirs) }, context(runner))
    expect(killed).toBeGreaterThanOrEqual(1)
    expect(killed).toBeLessThanOrEqual(3)
    expect((await passes())[0]!.status).toBe('completed')
    expect((await results()).get('/home/box_000000000001')).toMatchObject({
      status: 'partial',
      errors: ['scan_timeout'],
    })
  })

  test('a restart mid-pass resumes from the saved queue without re-measuring finished homes', async () => {
    const dirs = fixtureTree(12, 2)
    const homes = homesOf(dirs)
    const first = fakeRemote(dirs, { budget: 14 })
    const ctx = context(first.runner)
    const interrupted: SshRunner = {
      run: async (...args) => {
        // The process "dies" after two chunks: no further chunk starts.
        if (first.calls.length === 1) ctx.deadline = 0
        return first.runner.run(...args)
      },
    }
    await scanMachine(
      { machine, homes },
      {
        ...ctx,
        runner: interrupted,
        get deadline() {
          return ctx.deadline
        },
      }
    )
    const done = new Set([...(await results()).keys()])
    expect(done.size).toBeGreaterThan(0)
    expect(done.size).toBeLessThan(homes.length)
    expect((await passes())[0]!.status).toBe('running')

    const second = fakeRemote(dirs, { budget: 14 })
    await scanMachine({ machine, homes }, context(second.runner))
    const remeasured = second.calls.flatMap((call) => call.paths).filter((path) => done.has(path))
    expect(remeasured).toEqual([])
    const all = await passes()
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('completed')
    expect((await results()).size).toBe(homes.length)
  })

  test('a machine outage keeps the queue, backs off, and resumes when it is back', async () => {
    const dirs = fixtureTree(6, 2)
    const homes = homesOf(dirs)
    const remote = fakeRemote(dirs, { budget: 10 })
    remote.fail(() => ({ exitCode: 255, stdout: '', stderr: 'ssh: connect to host: Connection refused' }))
    await scanMachine({ machine, homes }, context(remote.runner))
    let [pass] = await passes()
    expect(pass).toMatchObject({ status: 'running', lastError: 'ssh_failed' })
    expect((await items()).every((item) => item.state === 'pending')).toBe(true)

    remote.fail(null)
    const calls = remote.calls.length
    await scanMachine({ machine, homes }, context(remote.runner))
    expect(remote.calls.length).toBe(calls) // Backing off.

    await db.update(storageScanPasses).set({ lastErrorAt: sql`now() - interval '10 minutes'` })
    await scanMachine({ machine, homes }, context(remote.runner))
    ;[pass] = await passes()
    expect(pass).toMatchObject({ status: 'completed', lastError: null })
    expect((await results()).size).toBe(homes.length)
    const snapshot = await buildStorageSnapshot([{ machine, owners: owners(homes) }])
    expect(JSON.stringify(snapshot)).not.toContain('Connection refused')
  })

  test('while a pass runs the view keeps last-known totals with freshness and progress', async () => {
    const dirs = fixtureTree(8, 2)
    const homes = homesOf(dirs)
    await scanMachine({ machine, homes }, context(fakeRemote(dirs, { budget: 100 }).runner))
    const second = fakeRemote(dirs, { budget: 14 })
    const ctx = context(second.runner, { requestedAt: new Date() })
    const stopping: SshRunner = {
      run: async (...args) => {
        ctx.deadline = 0
        return second.runner.run(...args)
      },
    }
    await scanMachine(
      { machine, homes },
      {
        ...ctx,
        runner: stopping,
        get deadline() {
          return ctx.deadline
        },
      }
    )

    const snapshot = await buildStorageSnapshot([{ machine, owners: owners(homes) }])
    const view = snapshot.machines[0]!
    expect(snapshot.scanning).toBe(true)
    expect(view.scan).toMatchObject({ state: 'running', generation: 2, totalHomes: 8 })
    expect(view.scan!.measuredHomes).toBeGreaterThan(0)
    expect(view.scan!.measuredHomes).toBeLessThan(8)
    const folders = view.squads[0]!.folders
    expect(folders).toHaveLength(8)
    expect(folders.every((folder) => folder.bytes !== null && folder.measuredAt)).toBe(true)
    const fresh = folders.filter((folder) => folder.freshness === 'current').length
    expect(fresh).toBe(view.scan!.measuredHomes)
    expect(folders.filter((folder) => folder.freshness === 'previous')).toHaveLength(8 - fresh)
    expect(view.status).toBe('available')
    expect(view.unattributedBytes).toBe(Math.max(0, 1000 - folders.reduce((sum, folder) => sum + folder.bytes!, 0)))
  })

  test('growth is computed per home, squad and host between passes', async () => {
    const dirs = fixtureTree(2, 2)
    const homes = homesOf(dirs)
    await scanMachine({ machine, homes }, context(fakeRemote(dirs, { budget: 100, used: 1000 }).runner))
    // Age the first pass's samples by a day.
    await db
      .update(storageUsageSamples)
      .set({ measuredAt: sql`${storageUsageSamples.measuredAt} - interval '25 hours'` })
      .where(eq(storageUsageSamples.machineId, machine.id))
    const grown = new Map(dirs)
    grown.set('/home/box_000000000000/d0/e0', dirs.get('/home/box_000000000000/d0/e0')! + 12 * 1024 ** 3)
    await scanMachine(
      { machine, homes },
      context(fakeRemote(grown, { budget: 100, used: 5000 }).runner, { requestedAt: new Date() })
    )
    const view = (await buildStorageSnapshot([{ machine, owners: owners(homes) }])).machines[0]!
    const home = view.squads[0]!.folders.find((folder) => folder.path === '/home/box_000000000000')!
    expect(home.growth?.bytes).toBe(12 * 1024 ** 3)
    expect(Date.now() - Date.parse(home.growth!.since)).toBeGreaterThan(24 * 3_600_000)
    expect(view.squads[0]!.growth?.bytes).toBe(12 * 1024 ** 3)
    expect(view.diskGrowth?.bytes).toBe(4000)
  })

  test('hostile directory names are queued, measured and displayed as data', async () => {
    const home = '/home/box_aaaaaaaaaaaa'
    const names = ['$(reboot)', 'a\'b"c', 'line\nbreak', 'tab\there', '--max-depth=9']
    const dirs = new Map<string, number>([[home, 4096]])
    for (const name of names) {
      dirs.set(`${home}/${name}`, 4096)
      for (let i = 0; i < 4; i++) dirs.set(`${home}/${name}/x${i}`, 8192)
    }
    const remote = fakeRemote(dirs, { budget: 8 })
    await scanMachine({ machine, homes: [home] }, context(remote.runner))
    const saved = (await results()).get(home)!
    expect(saved.bytes).toBe(remote.total(home))
    expect(saved.folder.children.map((folder) => folder.name).sort()).toEqual([...names].sort())
    for (const call of remote.calls) for (const name of names) expect(call.command).not.toContain(name)
  })

  test('old passes, queues and history are pruned', async () => {
    const dirs = fixtureTree(2, 1)
    const homes = homesOf(dirs)
    await db.insert(storageUsageSamples).values({
      machineId: machine.id,
      subject: 'host',
      bytes: 1,
      measuredAt: new Date(Date.now() - 9 * 86_400_000),
    })
    for (let i = 0; i < RETAIN_PASSES + 3; i++)
      await scanMachine(
        { machine, homes },
        context(fakeRemote(dirs, { budget: 100 }).runner, { requestedAt: new Date() })
      )
    const all = await passes()
    expect(all.length).toBeLessThanOrEqual(RETAIN_PASSES)
    expect(all.at(-1)!.generation).toBe(RETAIN_PASSES + 3)
    expect(await items()).toHaveLength(0)
    const samples = await db.select().from(storageUsageSamples).where(eq(storageUsageSamples.machineId, machine.id))
    expect(samples.every((sample) => Date.now() - sample.measuredAt.getTime() < 8 * 86_400_000)).toBe(true)
    expect((await results()).size).toBe(2)
    expect(MAX_ITEMS_PER_PASS).toBeLessThanOrEqual(20_000)
  })

  test('a worker that lost the scan lease writes nothing', async () => {
    const dirs = fixtureTree(2, 1)
    await scanMachine(
      { machine, homes: homesOf(dirs) },
      context(fakeRemote(dirs, { budget: 100 }).runner, { holdsLease: async () => false })
    )
    expect(await results()).toEqual(new Map())
    expect((await items()).every((item) => item.state === 'pending')).toBe(true)
  })
})

describe('home assembly', () => {
  test('split directories add their own files to their children; failures make ancestors partial', () => {
    const home = '/home/box_aaaaaaaaaaaa'
    const assembled = assembleHome(home, [
      { path: home, state: 'split', bytes: 10, details: null, error: null },
      { path: `${home}/a`, state: 'done', bytes: 100, details: { [`${home}/a/x`]: 60 }, error: null },
      { path: `${home}/b`, state: 'split', bytes: 5, details: null, error: 'permission_denied' },
      { path: `${home}/b/c`, state: 'failed', bytes: null, details: null, error: 'scan_timeout' },
      { path: `${home}/b/d`, state: 'done', bytes: 20, details: null, error: null },
    ])
    expect(assembled.bytes).toBe(135)
    expect(assembled.errors).toEqual(['permission_denied', 'scan_timeout'])
    expect([...assembled.entries]).toEqual(
      expect.arrayContaining([
        [home, 135],
        [`${home}/a`, 100],
        [`${home}/a/x`, 60],
        [`${home}/b`, 25],
      ])
    )
    expect([...assembled.partial].sort()).toEqual([home, `${home}/b`, `${home}/b/c`])
  })
})
