import { sandboxPressureLabel, sandboxPressureDetail } from '@ficus/shared'
import * as processService from './processes'
import * as fs from 'fs'
import * as childProcess from 'child_process'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BoxProcessError,
  listBoxContainers,
  listBoxProcesses,
  readPressure,
  probeBoxDocker,
  staleRuncExecReason,
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
  cgroup?: string
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
  writeFileSync(join(dir, 'cgroup'), `0::${p.cgroup ?? '/'}\n`)
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
  cmdline: ['/opt/ficus/bin/bun', 'server.js'],
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

describe('bounded Docker health probe', () => {
  test('uses a cheap bounded info request and names timeout vs unavailable', async () => {
    await probeBoxDocker(async (args, ms) => {
      expect(args).toEqual(['info', '--format', '{{.ServerVersion}}'])
      expect(ms).toBe(2_000)
      return '28.0.0'
    })
    await expect(
      probeBoxDocker(async () => {
        throw { killed: true }
      })
    ).rejects.toThrow('Docker did not answer within 2s')
    await expect(
      probeBoxDocker(async () => {
        throw new Error('missing')
      })
    ).rejects.toThrow('Docker is not available in this box')
  })
})

describe('stale detached runc exec control paths', () => {
  test('rejects only old detached exec, not long-running foreground work or another box', () => {
    const root = fakeProc([
      {
        pid: 10,
        ppid: 1,
        uid: BOX_UID,
        comm: 'runc',
        cmdline: ['/usr/bin/runc', '--root', '/run/runc', 'exec', '--detach', 'container'],
        startTicks: 970_100,
      },
      { pid: 11, ppid: 1, uid: BOX_UID, comm: 'runc', cmdline: ['runc', 'exec', 'container', 'sleep', '3600'] },
      { pid: 12, ppid: 1, uid: OTHER_UID, comm: 'runc', cmdline: ['runc', 'exec', '-d', 'container'] },
      { pid: 13, ppid: 1, uid: BOX_UID, comm: 'runc', cmdline: ['runc', 'exec', 'container', 'workload', '--detach'] },
      { pid: 14, ppid: 1, uid: BOX_UID, comm: 'bash', cmdline: ['bash', '-c', 'runc exec --detach container'] },
      { pid: 15, ppid: 1, uid: BOX_UID, comm: 'runc', cmdline: ['runc', 'create', '--detach', 'container'] },
      { pid: 16, ppid: 1, uid: BOX_UID, comm: 'runc', cmdline: ['runc', 'run', 'exec', '--detach'] },
      shim,
      tsc,
    ])
    const options = { procRoot: root, uid: BOX_UID, clockTicks: 100 }
    // 299s is below the 5min setup deadline; normal foreground exec may last hours.
    expect(staleRuncExecReason(options)).toBeUndefined()
    writeProcess(root, {
      pid: 10,
      ppid: 1,
      uid: BOX_UID,
      comm: 'runc',
      cmdline: ['/usr/bin/runc', '--root', '/run/runc', 'exec', '--process', '/tmp/process.json', '-d', 'container'],
      startTicks: 970_000,
    })
    expect(staleRuncExecReason(options)).toBe('Detached runc exec has been stuck for at least 300s')
    rmSync(join(root, '10'), { recursive: true })
    expect(staleRuncExecReason(options)).toBeUndefined()
  })
})

describe('readPressure', () => {
  test('reads cpus, load and memory', () => {
    expect(readPressure(fakeProc([]), { cgroupRoot: '/nonexistent-cgroup' })).toEqual({
      box: { cpuPercent: null, sampleMs: null, cpuPressureSome: null, memoryPressureSome: null },
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
    let time = 0
    const processes = await listBoxProcesses({
      procRoot: root,
      uid: BOX_UID,
      selfPid: SELF,
      clockTicks: 100,
      sampleMs: 20,
      now: () => (time += 20),
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

test('wedged Docker control is forcefully bounded, not left waiting for a TERM-ignoring CLI', async () => {
  let options: childProcess.ExecFileOptions | undefined
  const execute = spyOn(childProcess, 'execFile').mockImplementation(((
    _file: string,
    _args: string[],
    opts: childProcess.ExecFileOptions,
    callback: (error: Error, stdout: string) => void
  ) => {
    options = opts
    callback(Object.assign(new Error('timed out'), { killed: true }), '')
    return {} as childProcess.ChildProcess
  }) as typeof childProcess.execFile)
  try {
    await expect(stopBoxContainer('synthetic-container')).rejects.toMatchObject({ status: 504 })
    expect(options?.timeout).toBe(40_000)
    expect(options?.killSignal).toBe('SIGKILL')
  } finally {
    execute.mockRestore()
  }
})

describe('box attribution from cgroup v2', () => {
  test('samples the whole user slice over the process window, including exited tasks', async () => {
    const root = fakeProc([server])
    const cgroupRoot = join(root, 'cgroups')
    const slice = join(cgroupRoot, 'user.slice', `user-${BOX_UID}.slice`)
    mkdirSync(slice, { recursive: true })
    writeFileSync(join(slice, 'cpu.stat'), 'usage_usec 1000000\nuser_usec 600000\nsystem_usec 400000\n')
    writeFileSync(
      join(slice, 'cpu.pressure'),
      'some avg10=2.50 avg60=1.20 avg300=0.30 total=400\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'
    )
    writeFileSync(join(slice, 'memory.pressure'), 'some avg10=30.00 avg60=20.00 avg300=10.00 total=500\n')
    setTimeout(() => writeFileSync(join(slice, 'cpu.stat'), 'usage_usec 1040000\n'), 5)
    let time = 0
    const result = await processService.listBoxProcessSnapshot({
      procRoot: root,
      cgroupRoot,
      uid: BOX_UID,
      selfPid: SELF,
      sampleMs: 20,
      now: () => (time += 20),
    })
    expect(result.pressure?.box).toEqual({
      cpuPercent: 200,
      sampleMs: 20,
      cpuPressureSome: { avg10: 2.5, avg60: 1.2, avg300: 0.3 },
      memoryPressureSome: { avg10: 30, avg60: 20, avg300: 10 },
    })
    expect(result.pressure?.load).toEqual([22.72, 31.86, 30.52])
    expect(sandboxPressureLabel(result.pressure)).toBe('This sandbox overloaded')
    writeFileSync(join(slice, 'memory.pressure'), 'some avg10=0.00 avg60=0.00 avg300=0.00 total=500\n')
    const quiet = await processService.listBoxProcessSnapshot({
      procRoot: root,
      cgroupRoot,
      uid: BOX_UID,
      selfPid: SELF,
      sampleMs: 20,
      now: () => (time += 20),
    })
    expect(sandboxPressureLabel(quiet.pressure)).toBe('Host overloaded')
    expect(sandboxPressureDetail(quiet.pressure!)).toContain('Host busy with other boxes')
  })

  test('missing and malformed metrics are unknown, not zero or host data', async () => {
    const root = fakeProc([])
    const cgroupRoot = join(root, 'cgroups')
    const slice = join(cgroupRoot, 'user.slice', `user-${BOX_UID}.slice`)
    mkdirSync(slice, { recursive: true })
    writeFileSync(join(slice, 'cpu.stat'), 'usage_usec NaN\n')
    writeFileSync(join(slice, 'cpu.pressure'), 'some avg10=101 avg60=-1 avg300=NaN total=0\n')
    const result = await processService.listBoxProcessSnapshot({
      procRoot: root,
      cgroupRoot,
      uid: BOX_UID,
      sampleMs: 0,
    })
    expect(result.pressure?.box).toEqual({
      cpuPercent: null,
      sampleMs: null,
      cpuPressureSome: null,
      memoryPressureSome: null,
    })
  })
})

describe('runtime protection from fresh cgroups and helper roles', () => {
  const user = `/user.slice/user-${BOX_UID}.slice/user@${BOX_UID}.service/app.slice`
  const docker = `${user}/docker.service`
  const box = `${user}/ficus-sandbox-server.service`
  const fixtures: Array<[FakeProcess, processService.BoxProcess['protectionReason']]> = [
    [{ pid: 201, ppid: 929, uid: BOX_UID, comm: 'dockerd', cgroup: docker }, 'Docker runtime'],
    [
      { pid: 202, ppid: 201, uid: BOX_UID, comm: 'rootlesskit', cgroup: user, cmdline: ['/usr/bin/rootlesskit'] },
      'Docker runtime',
    ],
    [
      { pid: 203, ppid: 202, uid: BOX_UID, comm: 'slirp4netns', cgroup: user, cmdline: ['/usr/bin/slirp4netns'] },
      'Docker runtime',
    ],
    [
      { pid: 204, ppid: 202, uid: BOX_UID, comm: 'docker-proxy', cgroup: user, cmdline: ['/usr/bin/docker-proxy'] },
      'Docker runtime',
    ],
    [
      { pid: 205, ppid: 202, uid: BOX_UID, comm: 'containerd', cgroup: user, cmdline: ['/usr/bin/containerd'] },
      'Docker runtime',
    ],
    [
      {
        pid: 206,
        ppid: 205,
        uid: BOX_UID,
        comm: 'containerd-shim',
        cgroup: user,
        cmdline: ['/usr/bin/containerd-shim-runc-v2'],
      },
      'Docker runtime',
    ],
    [{ pid: 207, ppid: 929, uid: BOX_UID, comm: 'dbus-daemon', cgroup: `${user}/dbus.service` }, 'Session bus'],
    [
      {
        pid: 208,
        ppid: 929,
        uid: BOX_UID,
        comm: 'systemd-socket-',
        cgroup: `${user}/ficus-sandbox-server-proxy.service`,
      },
      'Box listener',
    ],
    [
      {
        pid: 209,
        ppid: 929,
        uid: BOX_UID,
        comm: 'systemd-socket-',
        cgroup: '/system.slice/ficus-box-box_abc-proxy.service',
      },
      'Box listener',
    ],
    // Inheriting a server or helper cgroup / ancestry is not enough to protect agent jobs.
    [
      {
        pid: 210,
        ppid: SELF,
        uid: BOX_UID,
        comm: 'bash',
        cgroup: box,
        cmdline: ['/bin/bash', '-c', 'renice 10; bun test'],
      },
      undefined,
    ],
    [{ pid: 211, ppid: 210, uid: BOX_UID, comm: 'bun', cgroup: box, cmdline: ['bun', 'test'] }, undefined],
    [
      {
        pid: 212,
        ppid: 206,
        uid: BOX_UID,
        comm: 'node',
        cgroup: `${docker}/docker-abc.scope`,
        cmdline: ['node', 'build.js'],
      },
      'Docker runtime',
    ],
    [{ pid: 213, ppid: SELF, uid: BOX_UID, comm: 'dockerd', cgroup: user, cmdline: ['/tmp/dockerd'] }, undefined],
    [{ pid: 214, ppid: SELF, uid: BOX_UID, comm: 'systemd', cgroup: box, cmdline: ['bash', '-c', 'build'] }, undefined],
    [
      { pid: 216, ppid: SELF, uid: BOX_UID, comm: 'systemd', cgroup: box, cmdline: ['/tmp/systemd', '--user'] },
      undefined,
    ],
    [
      { pid: 217, ppid: 929, uid: BOX_UID, comm: 'systemd-socket-', cgroup: `${user}/ficus-sandbox-server.socket` },
      'Box listener',
    ],
    [{ pid: 215, ppid: 203, uid: BOX_UID, comm: 'bash', cgroup: user, cmdline: ['bash', '-c', 'test'] }, undefined],
  ]
  fixtures.push(
    [
      {
        pid: 218,
        ppid: 1,
        uid: BOX_UID,
        comm: 'systemd',
        cgroup: `/user.slice/user-${BOX_UID}.slice/user@${BOX_UID}.service/init.scope`,
        cmdline: ['/usr/lib/systemd/systemd', '--user'],
      },
      'Runs the sandbox',
    ],
    [{ pid: 219, ppid: 218, uid: BOX_UID, comm: '(sd-pam)', cgroup: user }, 'Runs the sandbox']
  )
  test('labels infrastructure but not command wrappers, builds or name lookalikes', async () => {
    const root = fakeProc([manager, server, ...fixtures.map(([p]) => p)])
    const listed = await listBoxProcesses({ procRoot: root, uid: BOX_UID, selfPid: SELF, sampleMs: 0 })
    for (const [p, label] of fixtures) {
      const row = listed.find((row) => row.pid === p.pid)!
      expect([p.pid, row.protected, row.protectionReason]).toEqual([p.pid, !!label, label])
    }
  })
  test('signal route reclassifies at call time without relying on a listing', () => {
    const root = fakeProc([manager, server, ...fixtures.map(([p]) => p)])
    const killed: number[] = []
    const options = {
      procRoot: root,
      uid: BOX_UID,
      selfPid: SELF,
      kill: (pid: number) => {
        killed.push(pid)
      },
    }
    for (const [p, label] of fixtures) {
      if (label) expect(() => signalBoxProcess(p.pid, 'KILL', options)).toThrow(`${label}; cannot be signalled`)
      else expect(signalBoxProcess(p.pid, 'TERM', options).pid).toBe(p.pid)
    }
    writeProcess(root, { ...fixtures[0]![0], pid: 210 })
    expect(() => signalBoxProcess(210, 'TERM', options)).toThrow('Docker runtime; cannot be signalled')
    expect(killed).toEqual(fixtures.filter(([, label]) => !label).map(([p]) => p.pid))
  })
})

test('health pressure sampling is single-flight, non-blocking, and expires old CPU samples', async () => {
  const root = fakeProc([])
  const cgroupRoot = join(root, 'cgroups')
  const slice = join(cgroupRoot, 'user.slice', `user-${BOX_UID}.slice`)
  mkdirSync(slice, { recursive: true })
  writeFileSync(join(slice, 'cpu.stat'), 'usage_usec 1000\n')
  let time = 0
  const sampler = new processService.BoxPressureSampler({
    procRoot: root,
    cgroupRoot,
    uid: BOX_UID,
    now: () => time,
    sampleMs: 10,
  })
  expect(sampler.snapshot()?.box?.cpuPercent).toBeNull()
  const first = sampler.refresh()
  expect(sampler.refresh()).toBe(first)
  writeFileSync(join(slice, 'cpu.stat'), 'usage_usec 11000\n')
  time = 10
  await first
  expect(sampler.snapshot()?.box).toMatchObject({ cpuPercent: 100, sampleMs: 10 })
  time = 31_000
  expect(sampler.snapshot()?.box?.cpuPercent).toBeNull()
})

for (const change of ['pid reuse', 'owner change'] as const)
  test(`signal refuses ${change} during classification`, () => {
    const root = fakeProc([manager, server, tsc])
    const killed: number[] = []
    const original = fs.readFileSync
    let changed = false
    const reading = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const [path] = args
      if (!changed && path === `${root}/${tsc.pid}/cgroup`) {
        changed = true
        writeProcess(root, {
          ...tsc,
          ...(change === 'pid reuse' ? { startTicks: tsc.startTicks! + 1 } : { uid: OTHER_UID }),
        })
      }
      return original(...args)
    }) as typeof fs.readFileSync)
    try {
      expect(() =>
        signalBoxProcess(tsc.pid, 'KILL', {
          procRoot: root,
          uid: BOX_UID,
          selfPid: SELF,
          kill: (pid) => {
            killed.push(pid)
          },
        })
      ).toThrow('changed or exited')
      expect(killed).toEqual([])
    } finally {
      reading.mockRestore()
    }
  })

test('a reset CPU counter and a stalled sample are unavailable rather than negative or stale', async () => {
  const root = fakeProc([])
  const cgroupRoot = join(root, 'cgroups')
  const slice = join(cgroupRoot, 'user.slice', `user-${BOX_UID}.slice`)
  mkdirSync(slice, { recursive: true })
  for (const elapsed of [20, 31_000]) {
    writeFileSync(join(slice, 'cpu.stat'), 'usage_usec 1000000\n')
    setTimeout(() => writeFileSync(join(slice, 'cpu.stat'), `usage_usec ${elapsed === 20 ? 1 : 2000000}\n`), 2)
    let now = 0
    const result = await processService.listBoxProcessSnapshot({
      procRoot: root,
      cgroupRoot,
      uid: BOX_UID,
      sampleMs: 10,
      now: () => (now += elapsed),
    })
    expect(result.pressure?.box?.cpuPercent).toBeNull()
    expect(result.pressure?.box?.sampleMs).toBeNull()
  }
})
