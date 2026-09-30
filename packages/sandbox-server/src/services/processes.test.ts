import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BoxProcessError,
  listBoxContainers,
  listBoxProcesses,
  readPressure,
  signalBoxProcess,
  stopBoxContainer,
} from './processes'

const BOX_UID = 30033
const OTHER_UID = 100998
const SELF = 700

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface FakeProcess {
  pid: number
  ppid: number
  uid: number
  comm: string
  cmdline?: string[]
  ticks?: number
  startTicks?: number
  rssKb?: number
}

function stat(p: FakeProcess): string {
  // Fields after "(comm) ": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ... starttime (index 19)
  const rest = ['S', p.ppid, 0, 0, 0, 0, 0, 0, 0, 0, 0, p.ticks ?? 0, 0, 0, 0, 20, 0, 1, 0, p.startTicks ?? 0, 0, 0]
  return `${p.pid} (${p.comm}) ${rest.join(' ')}\n`
}

function writeProcess(root: string, p: FakeProcess) {
  const dir = join(root, String(p.pid))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stat'), stat(p))
  writeFileSync(
    join(dir, 'status'),
    `Name:\t${p.comm}\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\nVmRSS:\t${p.rssKb ?? 0} kB\n`
  )
  writeFileSync(join(dir, 'cmdline'), (p.cmdline ?? []).join('\0'))
}

function fakeProc(processes: FakeProcess[]): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-proc-'))
  roots.push(root)
  writeFileSync(join(root, 'loadavg'), '22.72 31.86 30.52 1/648 2871365\n')
  writeFileSync(
    join(root, 'meminfo'),
    'MemTotal:        8131584 kB\nMemFree:          474112 kB\nMemAvailable:    3700736 kB\n'
  )
  writeFileSync(join(root, 'cpuinfo'), 'processor\t: 0\nprocessor\t: 1\nprocessor\t: 2\nprocessor\t: 3\n')
  writeFileSync(join(root, 'uptime'), '10000.00 1.00\n')
  for (const p of processes) writeProcess(root, p)
  return root
}

// The shape of today's incident: a detached typecheck burning CPU, an idle
// long-running Postgres shim with a large lifetime total, and the box server.
const manager: FakeProcess = {
  pid: 929,
  ppid: 1,
  uid: BOX_UID,
  comm: 'systemd',
  cmdline: ['/usr/lib/systemd/systemd', '--user'],
}
const server: FakeProcess = {
  pid: SELF,
  ppid: 929,
  uid: BOX_UID,
  comm: 'bun',
  cmdline: ['/opt/tau/bin/bun', 'server.js'],
}
const tsc: FakeProcess = {
  pid: 2838629,
  ppid: 2838611,
  uid: BOX_UID,
  comm: 'bun',
  cmdline: ['bun', 'node_modules/.bin/tsc', '-p', 'apps/core', '--noEmit'],
  ticks: 1_000,
  startTicks: 900_000,
  rssKb: 2_166_636,
}
const shim: FakeProcess = {
  pid: 2347410,
  ppid: 929,
  uid: BOX_UID,
  comm: 'containerd-shim',
  cmdline: ['/usr/bin/containerd-shim-runc-v2', '-id', '5da43cf7deaa'],
  ticks: 500_000,
  startTicks: 100_000,
  rssKb: 13_164,
}
const postgres: FakeProcess = { pid: 2347436, ppid: 2347410, uid: OTHER_UID, comm: 'postgres', cmdline: ['postgres'] }

describe('readPressure', () => {
  test('reads cpus, load and memory', () => {
    expect(readPressure(fakeProc([]))).toEqual({
      cpus: 4,
      load: [22.72, 31.86, 30.52],
      memTotalMb: 7941,
      memAvailableMb: 3614,
    })
  })

  test('is null where /proc is unavailable', () => {
    expect(readPressure('/nonexistent-proc')).toBeNull()
  })
})

describe('listBoxProcesses', () => {
  test("lists only the box user's processes by current CPU, not lifetime totals", async () => {
    const root = fakeProc([manager, server, tsc, shim, postgres])
    // Between the two samples tsc uses 2 ticks (100% of a CPU at 100 ticks/s
    // over 20ms); the shim, with a far larger lifetime total, uses none.
    setTimeout(() => writeProcess(root, { ...tsc, ticks: tsc.ticks! + 2 }), 5)
    const processes = await listBoxProcesses({
      procRoot: root,
      uid: BOX_UID,
      selfPid: SELF,
      clockTicks: 100,
      sampleMs: 20,
    })
    expect(processes.map((p) => p.pid)).toEqual([tsc.pid, shim.pid, server.pid, manager.pid])
    expect(processes[0]).toMatchObject({
      pid: tsc.pid,
      cpuPercent: 100,
      memRssMb: 2116,
      ageSeconds: 1000,
      command: 'bun node_modules/.bin/tsc -p apps/core --noEmit',
      protected: false,
    })
    expect(processes.find((p) => p.pid === shim.pid)?.cpuPercent).toBe(0)
    expect(
      processes
        .filter((p) => p.protected)
        .map((p) => p.pid)
        .sort()
    ).toEqual([SELF, manager.pid].sort())
  })
})

describe('signalBoxProcess', () => {
  const opts = (root: string, killed: Array<[number, string]>) => ({
    procRoot: root,
    uid: BOX_UID,
    selfPid: SELF,
    kill: (pid: number, signal: NodeJS.Signals) => void killed.push([pid, signal]),
  })

  test('signals a process the box user owns (TERM by default)', () => {
    const killed: Array<[number, string]> = []
    const root = fakeProc([manager, server, tsc])
    expect(signalBoxProcess(tsc.pid, undefined, opts(root, killed))).toMatchObject({ pid: tsc.pid, signal: 'TERM' })
    expect(signalBoxProcess(tsc.pid, 'kill', opts(root, killed)).signal).toBe('KILL')
    expect(killed).toEqual([
      [tsc.pid, 'SIGTERM'],
      [tsc.pid, 'SIGKILL'],
    ])
  })

  test('refuses other users, the server, its ancestors and the user manager, and bad input', () => {
    const killed: Array<[number, string]> = []
    const root = fakeProc([manager, server, tsc, postgres])
    const refusal = (pid: unknown, signal?: unknown) => {
      try {
        signalBoxProcess(pid, signal, opts(root, killed))
      } catch (error) {
        return error instanceof BoxProcessError ? error.status : error
      }
      return 'signalled'
    }
    expect(refusal(postgres.pid)).toBe(403)
    expect(refusal(SELF)).toBe(403)
    expect(refusal(manager.pid)).toBe(403)
    expect(refusal(424242)).toBe(404)
    expect(refusal(1)).toBe(400)
    expect(refusal('2838629')).toBe(400)
    expect(refusal(tsc.pid, 'HUP')).toBe(400)
    expect(killed).toEqual([])
  })
})

describe('box containers', () => {
  const ps = [
    {
      ID: '4425637ca3c40f628c1e',
      Names: 'tau-core-tsc',
      Image: 'oven/bun:1.4.2-slim',
      State: 'running',
      Status: 'Up 2 hours',
    },
    {
      ID: '5da43cf7deaa0c8b91dd',
      Names: 'tau-test-ebb213d9-postgres-1',
      Image: 'paradedb/paradedb',
      State: 'running',
      Status: 'Up 10 hours',
    },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')
  const stats = JSON.stringify({ ID: '4425637ca3c4', CPUPerc: '187.40%', MemUsage: '2.1GiB / 5GiB' })

  test('lists containers with current CPU where Docker reports it', async () => {
    const docker = async (args: string[]) => (args[0] === 'ps' ? ps : stats)
    const result = await listBoxContainers(docker)
    expect(result).toEqual({
      available: true,
      containers: [
        {
          id: '4425637ca3c4',
          name: 'tau-core-tsc',
          image: 'oven/bun:1.4.2-slim',
          state: 'running',
          status: 'Up 2 hours',
          cpuPercent: 187.4,
          memUsage: '2.1GiB / 5GiB',
        },
        {
          id: '5da43cf7deaa',
          name: 'tau-test-ebb213d9-postgres-1',
          image: 'paradedb/paradedb',
          state: 'running',
          status: 'Up 10 hours',
        },
      ],
    })
  })

  test('reports an unresponsive daemon instead of waiting on it', async () => {
    const docker = async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
    }
    expect(await listBoxContainers(docker)).toEqual({ available: false, reason: 'Docker did not answer within 15s' })
  })

  test('stops a container by id or name, and rejects bad ids and unknown containers', async () => {
    const calls: string[][] = []
    const docker = async (args: string[]) => {
      calls.push(args)
      if (args[3] === 'gone') throw Object.assign(new Error('failed'), { stderr: 'Error: No such container: gone' })
      return ''
    }
    expect(await stopBoxContainer('tau-core-tsc', docker)).toEqual({ id: 'tau-core-tsc' })
    expect(calls).toEqual([['stop', '-t', '10', 'tau-core-tsc']])
    await expect(stopBoxContainer('gone', docker)).rejects.toMatchObject({ status: 404 })
    for (const id of ['', '-rm', 'a b', 'x;reboot', 42])
      await expect(stopBoxContainer(id, docker)).rejects.toMatchObject({ status: 400 })
  })
})
