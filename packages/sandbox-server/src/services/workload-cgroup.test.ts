import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCgroupBackend } from '../test-fixtures/fake-cgroup'
import {
  OOMD_KILL_COUNT_XATTR,
  OOMD_OMIT_XATTR,
  summarizeCommand,
  workloadKillMessage,
  WorkloadCgroups,
} from './workload-cgroup'

const UNIT = '/ficus.slice/ficus-box.slice/ficus-box-box_aaaaaaaaaaaa.slice/ficus-box-box_aaaaaaaaaaaa.service'
let root: string
let logs: string[]
const log = (message: string) => logs.push(message)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-cgroup-')))
  logs = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function setUp(options: Parameters<typeof fakeCgroupBackend>[2] = {}) {
  const backend = fakeCgroupBackend(root, `${UNIT}/supervisor`, options)
  const workloads = await WorkloadCgroups.initialize({ backend, platform: 'linux', log })
  return { backend, workloads: workloads!, unit: join(root, UNIT) }
}

describe('WorkloadCgroups.initialize', () => {
  it('enables memory and pids below the unit, omits the server from systemd-oomd and creates workload/', async () => {
    const { workloads, unit } = await setUp()
    expect(workloads).not.toBeNull()
    expect(readFileSync(join(unit, 'cgroup.subtree_control'), 'utf8')).toBe('+memory +pids')
    expect(readFileSync(join(unit, 'supervisor', `xattr.${OOMD_OMIT_XATTR}`), 'utf8')).toBe('1')
    expect(workloads.workloadDir).toBe(join(unit, 'workload'))
    expect(readFileSync(join(unit, 'workload', 'cgroup.subtree_control'), 'utf8')).toBe('+memory +pids')
    expect(logs.at(-1)).toContain('Workload cgroups: on')
  })

  it('stays off when the server is not in a delegated supervisor subgroup (old unit, k8s, docker)', async () => {
    const backend = fakeCgroupBackend(root, UNIT)
    expect(await WorkloadCgroups.initialize({ backend, platform: 'linux', log })).toBeNull()
    expect(logs).toEqual(['Workload cgroups: off (the server unit is not delegated; commands share its cgroup)'])
    expect(existsSync(join(root, UNIT, 'workload'))).toBe(false)
  })

  it('does nothing off Linux', async () => {
    const backend = fakeCgroupBackend(root, `${UNIT}/supervisor`)
    expect(await WorkloadCgroups.initialize({ backend, platform: 'darwin', log })).toBeNull()
    expect(logs).toEqual([])
  })

  it('still separates workloads, loudly, when the omit mark cannot be set', async () => {
    const { workloads } = await setUp({ failSetXattr: true })
    expect(workloads).not.toBeNull()
    expect(logs.some((line) => line.includes('could not mark the server cgroup user.oomd_omit'))).toBe(true)
  })

  it('enables only the controllers the unit was delegated', async () => {
    const { unit } = await setUp({ controllers: 'cpu pids' })
    expect(readFileSync(join(unit, 'cgroup.subtree_control'), 'utf8')).toBe('+pids')
  })

  it('is fail-open when the cgroup tree cannot be written', async () => {
    const backend = fakeCgroupBackend(root, `${UNIT}/supervisor`)
    backend.mkdir = async () => {
      throw new Error('EACCES')
    }
    expect(await WorkloadCgroups.initialize({ backend, platform: 'linux', log })).toBeNull()
    expect(logs.at(-1)).toContain('workload cgroups unavailable')
  })
})

describe('WorkloadCgroups placement and kill reporting', () => {
  it('moves an invocation into its own leaf', async () => {
    const { workloads, unit } = await setUp()
    expect(await workloads.place(4242, 'abc-123', 'next dev --port 3000')).toBe(true)
    expect(readFileSync(join(unit, 'workload', 'inv-abc-123', 'cgroup.procs'), 'utf8')).toBe('4242')
  })

  it('refuses unsafe leaf names and pids without touching the tree', async () => {
    const { workloads, unit } = await setUp()
    expect(await workloads.place(4242, '../escape', 'x')).toBe(false)
    expect(await workloads.place(1, 'ok', 'x')).toBe(false)
    expect(existsSync(join(unit, 'workload', 'inv-ok'))).toBe(false)
  })

  it('reports an oomd kill of the invocation once, then never as a notice', async () => {
    const { workloads, unit } = await setUp()
    await workloads.place(4242, 'inv1', 'bun run build')
    writeFileSync(join(unit, 'workload', 'inv-inv1', `xattr.${OOMD_KILL_COUNT_XATTR}`), '1')
    const kills = await workloads.takeInvocationKills('inv1')
    expect(kills).toEqual({ oomd: 1, kernel: 0 })
    expect(workloadKillMessage(kills)).toStartWith(
      'Killed by systemd-oomd: this box was under sustained memory pressure'
    )
    expect(await workloads.takeInvocationKills('inv1')).toEqual({ oomd: 0, kernel: 0 })
    writeFileSync(join(unit, 'workload', 'inv-inv1', 'cgroup.events'), 'populated 1\nfrozen 0\n')
    expect(await workloads.takeNotices()).toEqual([])
  })

  it('names a kernel OOM kill (the box reached MemoryMax) from memory.events', async () => {
    const { workloads, unit } = await setUp()
    await workloads.place(4242, 'inv2', 'make -j64')
    writeFileSync(join(unit, 'workload', 'inv-inv2', 'memory.events'), 'low 0\nhigh 9\nmax 3\noom 1\noom_kill 2\n')
    const kills = await workloads.takeInvocationKills('inv2')
    expect(kills).toEqual({ oomd: 0, kernel: 2 })
    expect(workloadKillMessage(kills)).toBe(
      'Killed by the kernel OOM killer: this box reached its memory limit and 2 processes of this command were ' +
        'stopped. Run it again with less memory, and stop dev servers and test databases you no longer need.'
    )
  })

  it('announces a later kill of a finished command (a background dev server) once, and removes empty leaves', async () => {
    const { workloads, unit } = await setUp()
    await workloads.place(4242, 'bg', 'nohup next dev --port 34562 > dev.log 2>&1 &')
    expect(await workloads.takeInvocationKills('bg')).toEqual({ oomd: 0, kernel: 0 })
    const leaf = join(unit, 'workload', 'inv-bg')
    writeFileSync(join(leaf, 'cgroup.events'), 'populated 1\n')
    expect(await workloads.takeNotices()).toEqual([])
    writeFileSync(join(leaf, `xattr.${OOMD_KILL_COUNT_XATTR}`), '1')
    writeFileSync(join(leaf, 'cgroup.events'), 'populated 0\n')
    expect(await workloads.takeNotices()).toEqual([
      '[ficus] systemd-oomd killed the processes started by an earlier command in this box ' +
        '(`nohup next dev --port 34562 > dev.log 2>&1 &`) because the box was under sustained memory pressure. ' +
        'Restart it only if you still need it.',
    ])
    expect(existsSync(leaf)).toBe(false)
    expect(await workloads.takeNotices()).toEqual([])
  })

  it('leaves a running attached invocation to report its own kill', async () => {
    const { workloads, unit } = await setUp()
    await workloads.place(4242, 'live', 'next build')
    writeFileSync(join(unit, 'workload', 'inv-live', `xattr.${OOMD_KILL_COUNT_XATTR}`), '1')
    expect(await workloads.takeNotices()).toEqual([])
    expect((await workloads.takeInvocationKills('live')).oomd).toBe(1)
  })

  it('counts processes across workload leaves for the idle-exit census', async () => {
    const { workloads, unit } = await setUp()
    await workloads.place(10, 'a', 'x')
    await workloads.place(11, 'b', 'y')
    writeFileSync(join(unit, 'workload', 'inv-a', 'cgroup.procs'), '10\n12\n')
    mkdirSync(join(unit, 'workload', 'not-a-leaf'))
    expect(await workloads.countProcesses()).toBe(3)
  })
})

describe('summarizeCommand', () => {
  it('keeps one bounded line', () => {
    expect(summarizeCommand('  cd app &&\n  next dev  ')).toBe('cd app &&')
    expect(summarizeCommand('a'.repeat(300))).toHaveLength(120)
  })
})
