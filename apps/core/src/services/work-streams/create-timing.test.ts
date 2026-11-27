import { describe, expect, it, mock } from 'bun:test'
import {
  CREATE_PHASE_ORDER,
  createWorkStreamCreateTimer,
  formatWorkStreamCreateTiming,
  logWorkStreamCreateTiming,
  SLOW_CREATE_MS,
} from './create-timing'
import { repositoryCommandPhase } from './repository-setup'

function clock() {
  let now = 0
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('work stream create timing', () => {
  it('reports every phase in a fixed order, the slowest phase and the notes', async () => {
    const time = clock()
    const timer = createWorkStreamCreateTimer(time.now)
    timer.add('authorize', 100)
    await timer.time('repository-exec', async () => time.advance(300))
    await timer.time('repository-exec', async () => time.advance(200))
    await timer.time('repository-fetch', async () => time.advance(4_000))
    timer.add('squad-lock-wait', 1_500)
    timer.note('sandbox', 'fast')
    time.advance(1_000)

    const line = formatWorkStreamCreateTiming(timer, { outcome: 'created', squadId: 'squad-1', workStreamId: 'ws-1' })
    expect(line).toStartWith('Work stream create timing: outcome=created total=5.5s slowest=repository-fetch ')
    expect(line).toContain('repository-exec=0.5s(2) repository-fetch=4.0s')
    expect(line).toContain('squad-lock-wait=1.5s')
    expect(line).toContain('dispatch=0.0s')
    expect(line).toEndWith('sandbox=fast squad=squad-1 stream=ws-1')
    const positions = CREATE_PHASE_ORDER.map((phase) => line.indexOf(` ${phase}=`))
    expect(positions.every((position) => position > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('counts a phase that throws', async () => {
    const time = clock()
    const timer = createWorkStreamCreateTimer(time.now)
    await expect(
      timer.time('sandbox-ensure', async () => {
        time.advance(2_000)
        throw new Error('box down')
      })
    ).rejects.toThrow('box down')
    expect(timer.phases['sandbox-ensure']).toEqual({ ms: 2_000, count: 1 })
  })

  it('logs slow creates at warn so they can be found by level', () => {
    const time = clock()
    const logger = { info: mock(() => {}), warn: mock(() => {}) }
    const fast = createWorkStreamCreateTimer(time.now)
    time.advance(SLOW_CREATE_MS - 1)
    logWorkStreamCreateTiming(fast, { outcome: 'created' }, logger)
    expect(logger.info).toHaveBeenCalledTimes(1)
    const slow = createWorkStreamCreateTimer(time.now)
    time.advance(SLOW_CREATE_MS)
    logWorkStreamCreateTiming(slow, { outcome: 'failed' }, logger)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String((logger.warn.mock.calls[0] as unknown[])[0])).toContain('outcome=failed')
  })

  it('attributes repository-setup commands to the fetch, worktree-add and other phases', () => {
    expect(repositoryCommandPhase(['git', '-C', '/r', '-c', 'credential.helper=', 'fetch', '--no-tags'])).toBe(
      'repository-fetch'
    )
    expect(repositoryCommandPhase(['git', '-C', '/r', 'worktree', 'add', '-b', 'b', '--', '/t', 'abc'])).toBe(
      'repository-worktree-add'
    )
    expect(repositoryCommandPhase(['git', '-C', '/r', 'rev-parse', '--show-toplevel'])).toBe('repository-exec')
    expect(repositoryCommandPhase(['git', '-C', '/r', 'worktree', 'list'])).toBe('repository-exec')
    expect(repositoryCommandPhase(['sh', '-c', 'cd -- "$1" && pwd -P', 'x', 'fetch'])).toBe('repository-exec')
  })
})
