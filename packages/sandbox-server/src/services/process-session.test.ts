import { describe, expect, test } from 'bun:test'
import {
  createDarwinProcessSessionDriver,
  createProcessSessionDriver,
  parseDarwinBsdInfo,
  parseDarwinPs,
  parseProcStat,
  terminateOwnedSession,
  type DarwinBsdInfo,
  type DarwinProcessNativeBackend,
  type ProcessIdentity,
  type ProcessSessionDriver,
  isIgnorableProcScanError,
  linuxProcessSessionDriver,
} from './process-session'

const identity = (pid: number, pgid = pid, sid = pid, state = 'T', startToken = `test:${pid}`): ProcessIdentity => ({
  pid,
  pgid,
  sid,
  state,
  startToken,
})

function driver(
  snapshots: ProcessIdentity[][]
): ProcessSessionDriver & { signals: Array<[number, NodeJS.Signals | 0]> } {
  const signals: Array<[number, NodeJS.Signals | 0]> = []
  const catalog = new Map(snapshots.flat().map((member) => [member.pid, member]))
  return {
    signals,
    signal(target, signal) {
      signals.push([target, signal])
    },
    readIdentity(pid) {
      return Promise.resolve(catalog.get(pid))
    },
    scanSessionIdentities() {
      return Promise.resolve(snapshots.shift() ?? [])
    },
    async scanSession(sid) {
      return (snapshots[0] ?? []).filter((member) => member.sid === sid).map(({ pid }) => pid)
    },
    waitForExit() {
      return Promise.resolve(false)
    },
  }
}

describe('terminateOwnedSession', () => {
  test('rejects unsafe process identities', async () => {
    const d = driver([])
    await expect(terminateOwnedSession({ pid: 1, pgid: 1, sid: 1, startToken: 'test:1' }, d)).rejects.toThrow('unsafe')
    expect(d.signals).toEqual([])
  })

  test('terminates the group and escalates every remaining group in the owned session', async () => {
    const owner = identity(4312)
    const child = identity(4313, 4400, 4312)
    const d = driver([[owner, child], [owner, child], []])
    const result = await terminateOwnedSession(owner, d)
    expect(d.signals).toEqual([
      [-4312, 'SIGTERM'],
      [-4400, 'SIGTERM'],
      [-4312, 'SIGKILL'],
      [-4400, 'SIGKILL'],
    ])
    expect(result.remainingPids).toEqual([])
  })

  test('fails closed before signaling a changed leader tuple', async () => {
    const owner = identity(70)
    const d = driver([[owner]])
    d.readIdentity = async () => ({ ...owner, startToken: 'test:reused' })
    await expect(terminateOwnedSession(owner, d)).rejects.toThrow('leader identity changed')
    expect(d.signals).toEqual([])
  })

  test('revalidates the representative before TERM and signals neither it nor a neighbor on ambiguity', async () => {
    const owner = identity(71)
    const neighbor = identity(72)
    const d = driver([[owner]])
    let reads = 0
    d.readIdentity = async (pid) => {
      if (pid === neighbor.pid) return neighbor
      reads += 1
      return reads === 1 ? owner : { ...owner, startToken: 'test:changed-before-term' }
    }
    await expect(terminateOwnedSession(owner, d)).rejects.toThrow('member changed before signal')
    expect(d.signals).toEqual([])
  })

  test('revalidates the representative before KILL and never signals the ambiguous group', async () => {
    const owner = identity(73)
    const d = driver([[owner], [owner]])
    let reads = 0
    d.readIdentity = async () => {
      reads += 1
      return reads <= 2 ? owner : { ...owner, startToken: 'test:changed-before-kill' }
    }
    await expect(terminateOwnedSession(owner, d)).rejects.toThrow('member changed before signal')
    expect(d.signals).toEqual([[-73, 'SIGTERM']])
  })

  test('does not escalate once the session is empty', async () => {
    const owner = identity(77)
    const d = driver([[owner], []])
    d.waitForExit = () => Promise.resolve(true)
    await terminateOwnedSession(owner, d)
    expect(d.signals).toEqual([[-77, 'SIGTERM']])
  })

  test('waits for killed session members to be reaped before proving cleanup', async () => {
    const owner = identity(99)
    const d = driver([[owner], [owner], []])
    await expect(terminateOwnedSession(owner, d)).resolves.toEqual({ remainingPids: [] })
  })

  test('fails cleanup proof when members survive KILL', async () => {
    const owner = identity(88)
    const d = driver([[owner], [owner], [owner]])
    await expect(terminateOwnedSession(owner, d)).rejects.toThrow('still owns processes: 88')
  })
})

describe('Linux process inspection', () => {
  test('parses state and kernel start ticks from proc stat', () => {
    const fields = ['T', '1', '41', '41', ...Array.from({ length: 15 }, () => '0'), '9001']
    expect(parseProcStat(`41 (helper name) ${fields.join(' ')}`)).toMatchObject({
      pid: 41,
      pgid: 41,
      sid: 41,
      state: 'T',
      startToken: 'linux:9001',
    })
  })

  test('rejects incomplete, unsafe, and malformed proc identities', () => {
    expect(() => parseProcStat('not stat')).toThrow('invalid /proc')
    expect(() => parseProcStat('1 (x) T 0 1 1')).toThrow('fields')
    const fields = ['T', '1', '0', '1', ...Array.from({ length: 15 }, () => '0'), '1']
    expect(() => parseProcStat(`2 (x) ${fields.join(' ')}`)).toThrow('PGID')
  })
})

describe('Darwin process inspection', () => {
  const records = new Map<number, DarwinBsdInfo>([
    [41, { pid: 41, status: 4, reportedProcessGroup: 41, startSeconds: 1_723_852_801n, startMicroseconds: 123n }],
    [42, { pid: 42, status: 2, reportedProcessGroup: 50, startSeconds: 1_723_852_801n, startMicroseconds: 124n }],
    [43, { pid: 43, status: 3, reportedProcessGroup: 41, startSeconds: 1_723_852_802n, startMicroseconds: 0n }],
    [44, { pid: 44, status: 5, reportedProcessGroup: 41, startSeconds: 1_723_852_803n, startMicroseconds: 0n }],
  ])
  const backend = (overrides: Partial<DarwinProcessNativeBackend> = {}): DarwinProcessNativeBackend => ({
    listPids: async () => [...records.keys()],
    readBsdInfo: async (pid) => records.get(pid),
    getProcessGroup: async (pid) => (pid === 42 ? 50 : 41),
    getSessionId: async () => 41,
    ...overrides,
  })

  test('uses exact native state and microsecond start tokens', async () => {
    const driver = createDarwinProcessSessionDriver(backend())
    const forcedDriver = createProcessSessionDriver('darwin', backend())
    expect(await forcedDriver.readIdentity(41)).toMatchObject({ startToken: 'darwin:1723852801:123' })
    expect(await driver.readIdentity(41)).toEqual({
      pid: 41,
      pgid: 41,
      sid: 41,
      state: 'T',
      startToken: 'darwin:1723852801:123',
    })
    expect((await driver.readIdentity(42))?.startToken).toBe('darwin:1723852801:124')
    expect((await driver.readIdentity(42))?.state).toBe('R')
    expect((await driver.readIdentity(43))?.state).toBe('S')
    expect((await driver.readIdentity(44))?.state).toBe('Z')
    expect(await driver.scanSessionIdentities(41)).toHaveLength(4)
  })

  test('does not inspect protected processes outside the owned session, but fails closed inside it', async () => {
    const native = backend({
      listPids: async () => [41, 99],
      getSessionId: async (pid) => (pid === 99 ? 99 : 41),
      readBsdInfo: async (pid) => {
        if (pid === 99) throw new Error('protected process BSD info denied')
        return records.get(pid)
      },
    })
    expect(await createDarwinProcessSessionDriver(native).scanSession(41)).toEqual([41])
    native.getSessionId = async () => 41
    await expect(createDarwinProcessSessionDriver(native).scanSession(41)).rejects.toThrow('BSD info denied')
  })

  test('ignores kernel PID zero while scanning positive native identities', async () => {
    const requested: number[] = []
    const driver = createDarwinProcessSessionDriver(
      backend({
        listPids: async () => [0, 41],
        readBsdInfo: async (pid) => {
          requested.push(pid)
          return records.get(pid)
        },
      })
    )

    expect(await driver.scanSessionIdentities(41)).toEqual([
      {
        pid: 41,
        pgid: 41,
        sid: 41,
        state: 'T',
        startToken: 'darwin:1723852801:123',
      },
    ])
    expect(requested).toEqual([41])
  })

  test('treats ps output as diagnostic and never as an authoritative token', async () => {
    const output = '41 41 41 T Sun Aug 16 19:00:01 2026\n42 50 41 R Sun Aug 16 19:00:01 2026\n'
    const diagnostic = parseDarwinPs(output)
    expect(diagnostic.map((row) => row.startToken)).toEqual([
      'darwin-ps:Sun Aug 16 19:00:01 2026',
      'darwin-ps:Sun Aug 16 19:00:01 2026',
    ])
    const d = driver([[diagnostic[0]!]])
    await expect(terminateOwnedSession(diagnostic[0]!, d)).rejects.toThrow('unsafe')
    expect(d.signals).toEqual([])
  })

  test('parses the exact proc_bsdinfo ABI and rejects short buffers', () => {
    const bytes = new Uint8Array(136)
    const view = new DataView(bytes.buffer)
    view.setUint32(4, 4, true)
    view.setUint32(12, 41, true)
    view.setUint32(100, 41, true)
    view.setBigUint64(120, 10n, true)
    view.setBigUint64(128, 20n, true)
    expect(parseDarwinBsdInfo(bytes, 41)).toEqual({
      pid: 41,
      status: 4,
      reportedProcessGroup: 41,
      startSeconds: 10n,
      startMicroseconds: 20n,
    })
    expect(() => parseDarwinBsdInfo(bytes.subarray(0, 135), 41)).toThrow('buffer')
    expect(() => parseDarwinBsdInfo(bytes, 42)).toThrow('PID mismatch')
  })

  test('rejects malformed, duplicate, mismatched, and inexact native identities', async () => {
    expect(() => parseDarwinPs('not a row')).toThrow('invalid Darwin')
    expect(() => parseDarwinPs('41 41 41 T now\n41 41 41 T later')).toThrow('duplicate')
    await expect(
      createDarwinProcessSessionDriver(
        backend({
          readBsdInfo: async () => ({
            pid: 99,
            status: 4,
            reportedProcessGroup: 41,
            startSeconds: 1n,
            startMicroseconds: 1n,
          }),
        })
      ).readIdentity(41)
    ).rejects.toThrow('PID mismatch')
    await expect(
      createDarwinProcessSessionDriver(
        backend({
          readBsdInfo: async (pid) => ({
            pid,
            status: 99,
            reportedProcessGroup: 41,
            startSeconds: 1n,
            startMicroseconds: 1n,
          }),
        })
      ).readIdentity(41)
    ).rejects.toThrow('status')
    await expect(
      createDarwinProcessSessionDriver(
        backend({
          readBsdInfo: async (pid) => ({
            pid,
            status: 4,
            reportedProcessGroup: 41,
            startSeconds: 1n,
            startMicroseconds: 1_000_000n,
          }),
        })
      ).readIdentity(41)
    ).rejects.toThrow('start time')
    await expect(
      createDarwinProcessSessionDriver(backend({ getProcessGroup: async () => 99 })).readIdentity(41)
    ).rejects.toThrow('cross-check')
  })

  test('fails closed on duplicate native list rows and unsupported platforms', async () => {
    const driver = createDarwinProcessSessionDriver(backend({ listPids: async () => [41, 41] }))
    await expect(driver.scanSessionIdentities(41)).rejects.toThrow('duplicate')
    expect(() => createProcessSessionDriver('win32')).toThrow('unsupported')
  })
})

describe('kernel-thread and unparseable /proc entries (2026-08-26 crash-loop regression)', () => {
  test('a kernel-thread stat line (pgid 0, sid 0) throws with code EINVALIDPROC, not a bare error', () => {
    // Exactly what /proc/2/stat looks like for kthreadd on a VM machine host.
    const kthreadd =
      '2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 0 0 0 20 0 1 0 21 0 0 18446744073709551615 0 0 0 0 0 0 0 2147483647 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0'
    let thrown: unknown
    try {
      parseProcStat(kthreadd)
    } catch (error) {
      thrown = error
    }
    expect((thrown as NodeJS.ErrnoException)?.code).toBe('EINVALIDPROC')
  })

  test('isIgnorableProcScanError skips exactly gone-or-unownable processes', () => {
    expect(isIgnorableProcScanError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    expect(isIgnorableProcScanError(Object.assign(new Error('x'), { code: 'ESRCH' }))).toBe(true)
    expect(isIgnorableProcScanError(Object.assign(new Error('x'), { code: 'EINVALIDPROC' }))).toBe(true)
    expect(isIgnorableProcScanError(new Error('unrelated'))).toBe(false)
    expect(isIgnorableProcScanError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false)
  })

  test('linux driver: scanning the session on a real host /proc never throws on kernel threads', async () => {
    // On a real Linux host (CI runner VM, machine host) /proc contains kernel
    // threads whose pgid/sid are 0. Pre-fix this crashed EVERY
    // terminateOwnedSession via scanSessionIdentities — the box-server
    // crash-feedback loop. Containerized /proc has no kernel threads, so this
    // only bites (and only meaningfully tests) on non-container Linux.
    if (process.platform !== 'linux') return
    const identities = await linuxProcessSessionDriver.scanSessionIdentities(process.pid > 1 ? await sidOfSelf() : 1)
    for (const identity of identities) {
      expect(identity.pgid).toBeGreaterThan(0)
      expect(identity.sid).toBeGreaterThan(0)
    }
  })
})

async function sidOfSelf(): Promise<number> {
  const { readFile } = await import('node:fs/promises')
  return parseProcStat(await readFile(`/proc/${process.pid}/stat`, 'utf8')).sid
}
