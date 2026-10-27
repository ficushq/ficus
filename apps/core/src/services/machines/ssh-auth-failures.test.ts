import { describe, expect, it } from 'bun:test'
import {
  countMatchingLines,
  createSshAuthFailureSampler,
  type JournalProcess,
  type JournalSpawn,
} from './ssh-auth-failures'

const encoder = new TextEncoder()

/** A fake journalctl: emits CHUNKS, then exits with CODE; or, with `hang`, never ends until killed. */
function fakeProcess(chunks: string[], code = 0, hang = false): JournalProcess & { killed: () => boolean } {
  let killed = false
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  let i = 0
  const stdout = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (killed) return controller.close()
      if (i < chunks.length) return controller.enqueue(encoder.encode(chunks[i++]))
      if (hang) return new Promise(() => {}) // a journalctl that keeps the pipe open
      controller.close()
      resolveExit(code)
    },
  })
  return {
    stdout,
    exited,
    kill: () => {
      killed = true
      resolveExit(137)
    },
    killed: () => killed,
  }
}

const FAILED = 'Failed password for root from 203.0.113.9 port 50122 ssh2\n'

describe('countMatchingLines', () => {
  it('counts failed passwords, invalid users and PAM authentication failures, across chunk boundaries', async () => {
    const out = [
      'Failed password for root from 203.0.113.9 port 50122 ssh2\nInvalid us',
      'er admin from 203.0.113.9 port 50124\n',
      'pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.9\n',
      'Accepted publickey for root from 198.51.100.4 port 40022 ssh2: ED25519 SHA256:x\n',
      'Connection closed by 203.0.113.9 port 50126 [preauth]',
    ]
    expect(await countMatchingLines(fakeProcess(out), { maxBytes: 1 << 20, timeoutMs: 5000 })).toEqual({
      count: 3,
      exitCode: 0,
      cut: false,
    })
  })

  it('stops at the byte cap: the process is killed and what was read so far is counted', async () => {
    const proc = fakeProcess(
      Array.from({ length: 1000 }, () => FAILED),
      0,
      true
    )
    const result = await countMatchingLines(proc, { maxBytes: 10 * FAILED.length, timeoutMs: 5000 })
    expect(result.cut).toBe(true)
    expect(result.count).toBe(10)
    expect(proc.killed()).toBe(true)
  })

  it('bounds a real process that never stops writing (yes): killed at the cap, nothing held', async () => {
    const child = Bun.spawn(['yes', FAILED.trim()], { stdout: 'pipe', stderr: 'ignore' })
    const result = await countMatchingLines(
      { stdout: child.stdout as ReadableStream<Uint8Array>, exited: child.exited, kill: () => child.kill('SIGKILL') },
      { maxBytes: 64 * 1024, timeoutMs: 5000 }
    )
    expect(result.cut).toBe(true)
    expect(result.count).toBe(Math.floor((64 * 1024) / FAILED.length))
    expect(child.killed).toBe(true)
  })

  it('stops at the deadline when journalctl never finishes', async () => {
    const proc = fakeProcess([FAILED, FAILED], 0, true)
    const started = Date.now()
    const result = await countMatchingLines(proc, { maxBytes: 1 << 20, timeoutMs: 100 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result).toMatchObject({ cut: true, count: 2 })
    expect(proc.killed()).toBe(true)
  })
})

describe('createSshAuthFailureSampler', () => {
  const T0 = 1_800_000_000_000
  function sampler(replies: Array<() => JournalProcess>, clock: { now: number }, limits = {}) {
    const calls: string[][] = []
    const spawn: JournalSpawn = (argv) => {
      calls.push(argv)
      const next = replies.shift()
      if (!next) throw new Error('spawn failed')
      return next()
    }
    return {
      calls,
      sampler: createSshAuthFailureSampler({ spawn, firstWindowSeconds: 300, now: () => clock.now, ...limits }),
    }
  }

  it('reads consecutive whole-second windows of ssh.service that never overlap', async () => {
    const clock = { now: T0 }
    const { calls, sampler: s } = sampler(
      [() => fakeProcess([FAILED]), () => fakeProcess([FAILED, FAILED]), () => fakeProcess([])],
      clock
    )
    expect(await s.sample()).toBe(1)
    clock.now += 300_000
    expect(await s.sample()).toBe(2)
    clock.now += 300_000
    expect(await s.sample()).toBe(0)
    expect(calls[0]).toEqual([
      'journalctl',
      '--unit=ssh',
      '--output=cat',
      '--no-pager',
      '--quiet',
      '--since=@1799999700',
      '--until=@1799999999',
    ])
    expect(calls[1]!.slice(-2)).toEqual(['--since=@1800000000', '--until=@1800000299'])
    expect(calls[2]!.slice(-2)).toEqual(['--since=@1800000300', '--until=@1800000599'])
  })

  it('two samples within one second read nothing the second time', async () => {
    const clock = { now: T0 }
    const { calls, sampler: s } = sampler([() => fakeProcess([FAILED])], clock)
    await s.sample()
    expect(await s.sample()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('a capped read reports its lower bound, and the next window starts after it (no backlog)', async () => {
    const clock = { now: T0 }
    const burst = () =>
      fakeProcess(
        Array.from({ length: 10_000 }, () => FAILED),
        0,
        true
      )
    const { calls, sampler: s } = sampler([burst, () => fakeProcess([FAILED])], clock, {
      maxBytes: 100 * FAILED.length,
    })
    expect(await s.sample()).toBe(100)
    clock.now += 300_000
    expect(await s.sample()).toBe(1)
    expect(calls[1]!.slice(-2)).toEqual(['--since=@1800000000', '--until=@1800000299'])
  })

  it('a timed-out or failed read is null, and never wedges the samples after it', async () => {
    const clock = { now: T0 }
    const { calls, sampler: s } = sampler(
      [() => fakeProcess([], 0, true), () => fakeProcess([], 1), () => fakeProcess([FAILED])],
      clock,
      { timeoutMs: 100 }
    )
    expect(await s.sample()).toBeNull() // timed out before seeing anything
    clock.now += 300_000
    expect(await s.sample()).toBeNull() // journalctl failed (no journal access)
    clock.now += 300_000
    expect(await s.sample()).toBe(1)
    expect(await s.sample()).toBe(0)
    expect(calls[2]!.slice(-2)).toEqual(['--since=@1800000300', '--until=@1800000599'])
    // A spawn failure is null too.
    clock.now += 300_000
    expect(await s.sample()).toBeNull()
  })
})
