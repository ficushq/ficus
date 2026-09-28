import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildIngestEndpoint,
  buildUsagePayload,
  countInstanceActivity,
  getBuildVersion,
  pickPrimaryMachineForDiskReport,
  reportUsageSampleOnce,
  resetBuildVersionCache,
  startUsageReporter,
  stopUsageReporter,
  type IngestMachine,
} from './usage-reporter'
import { deleteMachine, insertMachine, listMachines, type Machine } from './queries'
import { listPeriodicRunnerNames } from '../../lib/infra/PeriodicRunner'
import { resetSecretStore } from '../secrets'
import { User } from '../../entities/User'

const prefix = `utest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const userPrefix = `${prefix}-user`
let userIdCounter = 0

function testUserEmail(): string {
  userIdCounter += 1
  return `${userPrefix}-${userIdCounter}@test.local`
}

function machineValues(name: string, overrides: Partial<typeof import('../../db').machines.$inferInsert> = {}) {
  return {
    name: `${prefix}-${name}`,
    provider: 'exe',
    sshHost: '10.0.0.1',
    sshUser: 'tau',
    sshKeyId: 'secret-key-1',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    scope: 'shared',
    purpose: 'shared',
    autoProvisioned: true,
    status: 'ready',
    ...overrides,
  }
}

async function cleanup() {
  const all = await listMachines()
  for (const m of all) {
    if (m.name.startsWith(prefix)) await deleteMachine(m.id)
  }
}

let createdUserIds: string[] = []

/** Seed `count` enabled human users and return the number seeded. */
async function seedUsers(count: number): Promise<number> {
  for (let i = 0; i < count; i++) {
    const user = await User.create({ email: testUserEmail() })
    createdUserIds.push(user.id)
  }
  return count
}

async function cleanupUsers() {
  for (const id of createdUserIds) {
    const user = await User.findById(id)
    if (user) await user.delete()
  }
  createdUserIds = []
}

beforeEach(cleanup)
afterEach(async () => {
  await cleanup()
  await cleanupUsers()
  await stopUsageReporter()
  delete process.env.FICUS_PLATFORM_INGEST_URL
  delete process.env.FICUS_PLATFORM_USAGE_TOKEN
  resetSecretStore()
})
afterAll(cleanup)

describe('buildUsagePayload', () => {
  it('maps machine rows to the ingest contract shape with ISO dates', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    const machine = {
      name: 'm-1',
      provider: 'exe',
      scope: 'shared',
      purpose: 'shared',
      autoProvisioned: true,
      status: 'ready',
      createdAt,
    } as Machine

    const payload = buildUsagePayload([machine], 3, new Date('2026-01-02T00:00:00.000Z'))

    expect(payload.sampledAt).toBe('2026-01-02T00:00:00.000Z')
    expect(payload.userCount).toBe(3)
    expect(payload.machines).toEqual([
      {
        name: 'm-1',
        provider: 'exe',
        scope: 'shared',
        purpose: 'shared',
        autoProvisioned: true,
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ] satisfies IngestMachine[])
  })

  it('truncates and warns past the 1000-machine cap (mocked seam — seeding 1001 DB rows is unnecessary for this)', () => {
    const many: Machine[] = Array.from({ length: 1001 }, (_, i) => ({
      name: `m-${i}`,
      provider: 'exe',
      scope: 'shared',
      purpose: 'shared',
      autoProvisioned: true,
      status: 'ready',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })) as Machine[]

    const payload = buildUsagePayload(many, 0, new Date('2026-01-02T00:00:00.000Z'))
    expect(payload.machines.length).toBe(1000)
  })
})

describe('buildUsagePayload version fields', () => {
  const SHA = 'a'.repeat(40)

  it('carries commitSha + gitRef when a version resolved', () => {
    const payload = buildUsagePayload([], 0, new Date('2026-01-02T00:00:00.000Z'), {
      commitSha: SHA,
      gitRef: 'main',
    })
    expect(payload.commitSha).toBe(SHA)
    expect(payload.gitRef).toBe('main')
  })

  it('OMITS both keys entirely when no version resolved (the platform treats them as optional)', () => {
    const payload = buildUsagePayload([], 0, new Date('2026-01-02T00:00:00.000Z'), null)
    expect('commitSha' in payload).toBe(false)
    expect('gitRef' in payload).toBe(false)
  })

  it('omits gitRef alone when the branch could not be read', () => {
    const payload = buildUsagePayload([], 0, new Date('2026-01-02T00:00:00.000Z'), { commitSha: SHA })
    expect(payload.commitSha).toBe(SHA)
    expect('gitRef' in payload).toBe(false)
  })

  it('carries artifactDigest through when present on the version', () => {
    const payload = buildUsagePayload([], 0, new Date('2026-01-02T00:00:00.000Z'), {
      commitSha: SHA,
      artifactDigest: 'sha256:abc',
    })
    expect(payload.artifactDigest).toBe('sha256:abc')
  })

  it('OMITS artifactDigest when absent on the version', () => {
    const payload = buildUsagePayload([], 0, new Date('2026-01-02T00:00:00.000Z'), { commitSha: SHA })
    expect('artifactDigest' in payload).toBe(false)
  })
})

describe('buildUsagePayload disk fields', () => {
  it('carries diskUsedGb/diskTotalGb when a disk sample is provided', () => {
    const payload = buildUsagePayload([], 0, new Date('2026-01-02T00:00:00.000Z'), null, {
      usedGb: 40,
      totalGb: 80,
    })
    expect(payload.diskUsedGb).toBe(40)
    expect(payload.diskTotalGb).toBe(80)
  })

  it('OMITS both disk keys when no sample was taken (null)', () => {
    const payload = buildUsagePayload([], 0, new Date('2026-01-02T00:00:00.000Z'), null, null)
    expect('diskUsedGb' in payload).toBe(false)
    expect('diskTotalGb' in payload).toBe(false)
  })

  it('OMITS both disk keys when the disk argument is entirely absent (backward-compatible call)', () => {
    const payload = buildUsagePayload([], 0, new Date('2026-01-02T00:00:00.000Z'))
    expect('diskUsedGb' in payload).toBe(false)
    expect('diskTotalGb' in payload).toBe(false)
  })
})

describe('buildUsagePayload metrics field', () => {
  it('omits `metrics` entirely when the aggregate is empty', () => {
    const p = buildUsagePayload([], 1, new Date(), null, null, {})
    expect('metrics' in p).toBe(false)
  })

  it('carries a non-empty metrics block through', () => {
    const p = buildUsagePayload([], 1, new Date(), null, null, { memUsedMbAvg: 100, memTotalMb: 4000, agentsAlive: 3 })
    expect(p.metrics).toEqual({ memUsedMbAvg: 100, memTotalMb: 4000, agentsAlive: 3 })
  })

  it('a metrics block never contains a zero standing in for a failed sample', () => {
    const p = buildUsagePayload([], 1, new Date(), null, null, { memUsedMbAvg: 0 })
    // 0 is a LEGITIMATE measured value; the rule is that absent fields are absent.
    expect(p.metrics).toEqual({ memUsedMbAvg: 0 })
    const q = buildUsagePayload([], 1, new Date(), null, null, {})
    expect('metrics' in q).toBe(false)
  })

  it('OMITS `metrics` entirely when the argument is absent (backward-compatible call)', () => {
    const p = buildUsagePayload([], 1, new Date())
    expect('metrics' in p).toBe(false)
  })

  it('dual-sends legacy machine metrics and explicit host metrics', () => {
    const machineMetrics = { memUsedMbAvg: 0, agentsAlive: 3 }
    const coreMetrics = { cpuPctAvg: 7 }
    const payload = buildUsagePayload([], 1, new Date(), null, null, machineMetrics, coreMetrics)

    expect(payload.metrics).toEqual(machineMetrics)
    expect(payload.hostMetrics).toEqual([
      { hostKind: 'machine_host', hostId: 'primary', metrics: machineMetrics },
      { hostKind: 'core_vm', hostId: 'self', metrics: coreMetrics },
    ])
  })

  it('omits empty host blocks and never copies activity counts to the core host', () => {
    const payload = buildUsagePayload([], 1, new Date(), null, null, { agentsAlive: 0 }, {})
    expect(payload.hostMetrics).toEqual([{ hostKind: 'machine_host', hostId: 'primary', metrics: { agentsAlive: 0 } }])
  })
})

describe('pickPrimaryMachineForDiskReport', () => {
  function machineAt(id: string, createdAt: string, overrides: Partial<Machine> = {}): Machine {
    return {
      id,
      name: id,
      provider: 'exe',
      scope: 'shared',
      purpose: 'shared',
      autoProvisioned: true,
      status: 'ready',
      createdAt: new Date(createdAt),
      ...overrides,
    } as Machine
  }

  it('returns undefined for an empty fleet', () => {
    expect(pickPrimaryMachineForDiskReport([])).toBeUndefined()
  })

  it('picks the single ready machine (the common platform-hosted case)', () => {
    const m = machineAt('a', '2026-01-01T00:00:00Z')
    expect(pickPrimaryMachineForDiskReport([m])).toBe(m)
  })

  it('picks the OLDEST ready machine among several, ignoring creation order in the input array', () => {
    const newer = machineAt('newer', '2026-02-01T00:00:00Z')
    const oldest = machineAt('oldest', '2026-01-01T00:00:00Z')
    const middle = machineAt('middle', '2026-01-15T00:00:00Z')
    expect(pickPrimaryMachineForDiskReport([newer, middle, oldest])).toBe(oldest)
  })

  it('skips non-ready machines (unreachable/parked/terminated) even if older', () => {
    const unreachable = machineAt('unreachable', '2026-01-01T00:00:00Z', { status: 'unreachable' })
    const ready = machineAt('ready', '2026-01-10T00:00:00Z', { status: 'ready' })
    expect(pickPrimaryMachineForDiskReport([unreachable, ready])).toBe(ready)
  })

  it('returns undefined when the fleet has machines but none are ready', () => {
    const parked = machineAt('parked', '2026-01-01T00:00:00Z', { status: 'parked' })
    expect(pickPrimaryMachineForDiskReport([parked])).toBeUndefined()
  })
})

describe('getBuildVersion', () => {
  const SHA = 'b'.repeat(40)

  it('reads the sha and branch from the checkout', async () => {
    const calls: string[][] = []
    const version = await getBuildVersion({
      repoRoot: '/srv/tau',
      git: async (_cwd, args) => {
        calls.push(args)
        return args[0] === 'rev-parse' && args[1] === 'HEAD' ? SHA : 'main'
      },
    })
    expect(version).toEqual({ commitSha: SHA, gitRef: 'main' })
    expect(calls).toEqual([
      ['rev-parse', 'HEAD'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
    ])
  })

  it('returns null (never throws) when git cannot answer — an instance with no checkout still reports usage', async () => {
    expect(await getBuildVersion({ repoRoot: '/srv/tau', git: async () => undefined })).toBeNull()
  })

  it('rejects a non-sha answer rather than reporting garbage as a version', async () => {
    expect(await getBuildVersion({ repoRoot: '/srv/tau', git: async () => 'not-a-sha' })).toBeNull()
  })

  it('resolves once per process and caches the answer (the running BUILD cannot change without a restart)', async () => {
    resetBuildVersionCache()
    // Default seam: the real checkout this test runs from. Two calls, one
    // resolution — asserted by identity, since the cache returns the same object.
    const first = await getBuildVersion()
    const second = await getBuildVersion()
    expect(second).toBe(first)
    resetBuildVersionCache()
  })
})

describe('getBuildVersion artifact mode', () => {
  let tmp: string
  const SHA = 'd'.repeat(40)

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'usage-reporter-artifact-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reads commit + digest from artifact.json, omits gitRef, and never shells to git', async () => {
    writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ commit: SHA, digest: 'sha256:deadbeef' }))
    const version = await getBuildVersion({
      artifactRoot: tmp,
      git: async () => {
        throw new Error('git must not be invoked in artifact mode')
      },
    })
    expect(version).toEqual({ commitSha: SHA, gitRef: undefined, artifactDigest: 'sha256:deadbeef' })
  })

  it('omits artifactDigest when the manifest carries none', async () => {
    writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ commit: SHA }))
    const version = await getBuildVersion({ artifactRoot: tmp })
    expect(version).toEqual({ commitSha: SHA, gitRef: undefined, artifactDigest: undefined })
  })

  it('malformed artifact.json → null, never throws', async () => {
    writeFileSync(join(tmp, 'artifact.json'), 'not json')
    expect(await getBuildVersion({ artifactRoot: tmp })).toBeNull()
  })

  it('git branch is unchanged when artifactRoot has no artifact.json', async () => {
    const version = await getBuildVersion({
      artifactRoot: tmp,
      repoRoot: '/srv/tau',
      git: async (_cwd, args) => (args[0] === 'rev-parse' && args[1] === 'HEAD' ? SHA : 'main'),
    })
    expect(version).toEqual({ commitSha: SHA, gitRef: 'main' })
  })
})

describe('buildIngestEndpoint', () => {
  it('joins a base URL without a trailing slash', () => {
    expect(buildIngestEndpoint('https://platform.example.com')).toBe('https://platform.example.com/api/ingest/usage')
  })

  it('joins a base URL WITH a trailing slash without a double slash', () => {
    expect(buildIngestEndpoint('https://platform.example.com/')).toBe('https://platform.example.com/api/ingest/usage')
  })
})

describe('reportUsageSampleOnce', () => {
  it('is a no-op (no fetch call) when ingestUrl is undefined', async () => {
    const fetchSpy = mock(async () => new Response(null, { status: 204 }))
    await reportUsageSampleOnce({
      ingestUrl: undefined,
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs seeded machine rows with the bearer token and payload shape', async () => {
    const inserted = await insertMachine(machineValues('a'))

    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines,
      countUsers: async () => 7,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(capturedUrl).toBe('https://platform.example.com/api/ingest/usage')
    expect(capturedInit?.method).toBe('POST')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-usage-token')
    expect(headers['content-type']).toBe('application/json')

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.sampledAt).toBe('2026-03-01T12:00:00.000Z')
    expect(body.userCount).toBe(7)
    const mine = body.machines.find((m: IngestMachine) => m.name === inserted.name)
    expect(mine).toEqual({
      name: inserted.name,
      provider: inserted.provider,
      scope: inserted.scope,
      purpose: inserted.purpose,
      autoProvisioned: inserted.autoProvisioned,
      status: inserted.status,
      createdAt: inserted.createdAt.toISOString(),
    })
  })

  it('POSTs a userCount matching the seeded human user rows (default countUsers → real DB)', async () => {
    const baseline = await User.countActive()
    const seeded = await seedUsers(3)

    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      // countUsers deliberately NOT overridden — exercises the real
      // User.countActive() default seam against the seeded DB rows.
    })

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.userCount).toBe(baseline + seeded)
  })

  it('POSTs the running build identity alongside the sample', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      getVersion: async () => ({ commitSha: 'c'.repeat(40), gitRef: 'main' }),
    })

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.commitSha).toBe('c'.repeat(40))
    expect(body.gitRef).toBe('main')
  })

  it('still POSTs a valid sample when the build identity is unresolvable', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      getVersion: async () => null,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(capturedInit?.body as string)
    expect(body.commitSha).toBeUndefined()
    expect(body.gitRef).toBeUndefined()
    expect(body.sampledAt).toBe('2026-03-01T12:00:00.000Z')
  })

  it('logs a warning and completes without throwing when fetch rejects', async () => {
    const fetchSpy = mock(async () => {
      throw new Error('network unreachable')
    })

    await expect(
      reportUsageSampleOnce({
        ingestUrl: 'https://platform.example.com',
        fetch: fetchSpy as unknown as typeof fetch,
        listMachines: async () => [],
      })
    ).resolves.toBeUndefined()
  })

  it('logs a warning and completes without throwing when the user count query fails (no fetch call)', async () => {
    const fetchSpy = mock(async () => new Response(null, { status: 204 }))

    await expect(
      reportUsageSampleOnce({
        ingestUrl: 'https://platform.example.com',
        fetch: fetchSpy as unknown as typeof fetch,
        listMachines: async () => [],
        countUsers: async () => {
          throw new Error('db unreachable')
        },
      })
    ).resolves.toBeUndefined()
    // The count failure aborts the tick before the POST — same "no partial/
    // stale sample" discipline as any other error in the try block.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('logs a warning and completes without throwing on a non-2xx response (401)', async () => {
    const fetchSpy = mock(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))

    await expect(
      reportUsageSampleOnce({
        ingestUrl: 'https://platform.example.com',
        fetch: fetchSpy as unknown as typeof fetch,
        listMachines: async () => [],
      })
    ).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // ── disk-usage sample (T3) ─────────────────────────────────────────────

  it('POSTs diskUsedGb/diskTotalGb when the disk sampler resolves a sample', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      sampleDisk: async () => ({ usedGb: 40, totalGb: 80 }),
    })

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.diskUsedGb).toBe(40)
    expect(body.diskTotalGb).toBe(80)
  })

  it('omits disk fields (never sends zeros) when the disk sampler resolves null (no machines / sample failed)', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      sampleDisk: async () => null,
    })

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.diskUsedGb).toBeUndefined()
    expect(body.diskTotalGb).toBeUndefined()
  })

  it('a THROWING disk sampler does not abort the tick — the rest of the sample still POSTs, disk fields absent', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await expect(
      reportUsageSampleOnce({
        ingestUrl: 'https://platform.example.com',
        fetch: fetchSpy as unknown as typeof fetch,
        listMachines: async () => [],
        countUsers: async () => 1,
        now: () => new Date('2026-03-01T12:00:00.000Z'),
        getToken: () => 'test-usage-token',
        sampleDisk: async () => {
          throw new Error('ssh unreachable')
        },
      })
    ).resolves.toBeUndefined()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(capturedInit?.body as string)
    expect(body.userCount).toBe(1)
    expect(body.diskUsedGb).toBeUndefined()
    expect(body.diskTotalGb).toBeUndefined()
  })

  it('the default disk sampler is a no-op (null) when there are no machines, so the payload never carries fabricated zeros', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      // sampleDisk deliberately NOT overridden — exercises the real default
      // seam (pickPrimaryMachineForDiskReport + sampleMachineDiskUsage)
      // against an empty fleet.
    })

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.diskUsedGb).toBeUndefined()
    expect(body.diskTotalGb).toBeUndefined()
  })

  // ── machine metrics + activity counts (T3) ─────────────────────────────

  it('merges the drained sub-sample aggregate and the activity counts into `metrics`', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      drainMachineMetrics: () => ({ load1: 0.5, cpuPctAvg: 12.5 }),
      countActivity: async () => ({ agentsAlive: 2, boxesTotal: 3, squadsTotal: 1, executionsActive: 0 }),
    })

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.metrics).toEqual({
      load1: 0.5,
      cpuPctAvg: 12.5,
      agentsAlive: 2,
      boxesTotal: 3,
      squadsTotal: 1,
      executionsActive: 0,
    })
  })

  it('posts independent machine and core aggregates even when no machine is ready', async () => {
    let capturedInit: RequestInit | undefined
    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: (async (_url: string, init?: RequestInit) => {
        capturedInit = init
        return new Response(null, { status: 204 })
      }) as typeof fetch,
      listMachines: async () => [],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getVersion: async () => null,
      sampleDisk: async () => null,
      pinMetricsMachine: () => {},
      drainMachineMetrics: () => ({ load1: 0.5 }),
      drainCoreMetrics: () => ({ load1: 1.5 }),
      countActivity: async () => ({ executionsActive: 0 }),
    })

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.metrics).toEqual({ load1: 0.5, executionsActive: 0 })
    expect(body.hostMetrics).toEqual([
      { hostKind: 'machine_host', hostId: 'primary', metrics: { load1: 0.5, executionsActive: 0 } },
      { hostKind: 'core_vm', hostId: 'self', metrics: { load1: 1.5 } },
    ])
  })

  it('omits `metrics` entirely when the drain is empty and every activity count is unavailable', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      drainMachineMetrics: () => ({}),
      countActivity: async () => ({}),
    })

    const body = JSON.parse(capturedInit?.body as string)
    expect('metrics' in body).toBe(false)
  })

  it('a THROWING drainMetrics does not abort the tick — the rest of the sample still POSTs, sub-sample fields absent', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await expect(
      reportUsageSampleOnce({
        ingestUrl: 'https://platform.example.com',
        fetch: fetchSpy as unknown as typeof fetch,
        listMachines: async () => [],
        countUsers: async () => 1,
        now: () => new Date('2026-03-01T12:00:00.000Z'),
        getToken: () => 'test-usage-token',
        drainMachineMetrics: () => {
          throw new Error('drain failed')
        },
        countActivity: async () => ({ agentsAlive: 4 }),
      })
    ).resolves.toBeUndefined()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(capturedInit?.body as string)
    expect(body.userCount).toBe(1)
    expect(body.metrics).toEqual({ agentsAlive: 4 })
  })

  it('a THROWING countActivity does not abort the tick — the rest of the sample still POSTs, activity counts absent', async () => {
    let capturedInit: RequestInit | undefined
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    })

    await expect(
      reportUsageSampleOnce({
        ingestUrl: 'https://platform.example.com',
        fetch: fetchSpy as unknown as typeof fetch,
        listMachines: async () => [],
        countUsers: async () => 1,
        now: () => new Date('2026-03-01T12:00:00.000Z'),
        getToken: () => 'test-usage-token',
        drainMachineMetrics: () => ({ load1: 0.25 }),
        countActivity: async () => {
          throw new Error('db unreachable')
        },
      })
    ).resolves.toBeUndefined()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(capturedInit?.body as string)
    expect(body.userCount).toBe(1)
    expect(body.metrics).toEqual({ load1: 0.25 })
  })

  // ── metrics sub-sampler machine pinning ─────────────────────────────────
  //
  // `metrics`'s sub-samples and the top-level `diskUsedGb`/`diskTotalGb` must
  // describe the SAME host. The sub-sampler's exec target is resolved ONCE
  // per 5-minute tick (via `pinMetricsMachine`) from the tick's own
  // `machines` snapshot — using the exact same `pickPrimaryMachineForDiskReport`
  // pick the disk sample uses — rather than independently re-querying the DB
  // on every 60s sub-sample, where the ready-machine set could have drifted
  // (e.g. mid-resize) and blended two different hosts into one drained window.

  function machineAt(id: string, createdAt: string, overrides: Partial<Machine> = {}): Machine {
    return {
      id,
      name: id,
      provider: 'exe',
      scope: 'shared',
      purpose: 'shared',
      autoProvisioned: true,
      status: 'ready',
      createdAt: new Date(createdAt),
      ...overrides,
    } as Machine
  }

  it('pins the metrics sampler to the SAME primary the disk sample used (the oldest ready machine), resolved ONCE per tick', async () => {
    const older = machineAt('older', '2026-01-01T00:00:00Z')
    const newer = machineAt('newer', '2026-02-01T00:00:00Z')
    const fetchSpy = mock(async () => new Response(null, { status: 204 }))
    const pinned: Array<Machine | undefined> = []

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [newer, older],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      sampleDisk: async () => null,
      pinMetricsMachine: (m) => pinned.push(m),
    })

    // pickPrimaryMachineForDiskReport picks the OLDEST ready machine — same pick, same call.
    expect(pinned).toEqual([older])
  })

  it('unpins (undefined) when no machine is ready this tick, matching the disk sample seeing no primary either', async () => {
    const parked = machineAt('parked', '2026-01-01T00:00:00Z', { status: 'parked' })
    const fetchSpy = mock(async () => new Response(null, { status: 204 }))
    const pinned: Array<Machine | undefined> = []

    await reportUsageSampleOnce({
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [parked],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      sampleDisk: async () => null,
      pinMetricsMachine: (m) => pinned.push(m),
    })

    expect(pinned).toEqual([undefined])
  })

  it('re-pins exactly once per tick even across repeated ticks (no per-sub-sample re-derivation)', async () => {
    const only = machineAt('only', '2026-01-01T00:00:00Z')
    const fetchSpy = mock(async () => new Response(null, { status: 204 }))
    const pinned: Array<Machine | undefined> = []
    const deps = {
      ingestUrl: 'https://platform.example.com',
      fetch: fetchSpy as unknown as typeof fetch,
      listMachines: async () => [only],
      countUsers: async () => 1,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
      getToken: () => 'test-usage-token',
      sampleDisk: async () => null,
      pinMetricsMachine: (m: Machine | undefined) => pinned.push(m),
    }

    await reportUsageSampleOnce(deps)
    await reportUsageSampleOnce(deps)

    // Exactly one pin call per tick — not one per 60s sub-sample.
    expect(pinned).toEqual([only, only])
  })
})

describe('countInstanceActivity', () => {
  it('returns a real, non-throwing snapshot against the live (possibly empty) DB', async () => {
    const counts = await countInstanceActivity()
    expect(typeof counts.agentsAlive).toBe('number')
    expect(typeof counts.boxesTotal).toBe('number')
    expect(typeof counts.squadsTotal).toBe('number')
    expect(typeof counts.executionsActive).toBe('number')
  })

  it('omits ONLY the failed key when one count query rejects — the other three still populate (never a fabricated 0)', async () => {
    const counts = await countInstanceActivity({
      countSquadsTotal: async () => {
        throw new Error('squads table unavailable')
      },
    })
    expect('squadsTotal' in counts).toBe(false)
    expect(typeof counts.agentsAlive).toBe('number')
    expect(typeof counts.boxesTotal).toBe('number')
    expect(typeof counts.executionsActive).toBe('number')
  })

  it('a fully-injected snapshot carries every count through untouched', async () => {
    const counts = await countInstanceActivity({
      countAgentsAlive: async () => 2,
      countBoxesTotal: async () => 3,
      countSquadsTotal: async () => 1,
      countExecutionsActive: async () => 0,
    })
    expect(counts).toEqual({ agentsAlive: 2, boxesTotal: 3, squadsTotal: 1, executionsActive: 0 })
  })
})

describe('startUsageReporter / stopUsageReporter', () => {
  it('does not register a periodic runner when FICUS_PLATFORM_INGEST_URL is unset', async () => {
    delete process.env.FICUS_PLATFORM_INGEST_URL
    startUsageReporter()
    expect(listPeriodicRunnerNames()).not.toContain('platform-usage-reporter')
    await stopUsageReporter() // must not throw even though nothing was started
  })

  it('registers the platform-usage-reporter runner when FICUS_PLATFORM_INGEST_URL is set', async () => {
    process.env.FICUS_PLATFORM_INGEST_URL = 'https://platform.example.com'
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    try {
      startUsageReporter()
      expect(listPeriodicRunnerNames()).toContain('platform-usage-reporter')
    } finally {
      await stopUsageReporter()
      globalThis.fetch = originalFetch
    }
  })
})
