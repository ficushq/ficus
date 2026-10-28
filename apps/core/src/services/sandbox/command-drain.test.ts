import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  commandCanceledForRestartError,
  drainCommands,
  isCommandDrainActive,
  resetCommandDrainForTests,
  trackCommand,
} from './command-drain'

afterEach(() => resetCommandDrainForTests())

function command() {
  const done = Promise.withResolvers<void>()
  const cancelForRestart = mock(async () => done.resolve())
  return { settled: done.promise, cancelForRestart, finish: () => done.resolve() }
}

describe('drainCommands', () => {
  test('with nothing running it returns at once and refuses new commands from then on', async () => {
    expect(isCommandDrainActive()).toBe(false)
    expect(await drainCommands(60_000)).toEqual({ finished: 0, canceled: 0 })
    expect(isCommandDrainActive()).toBe(true)
  })

  test('waits for running commands that finish inside the window without canceling them', async () => {
    const quick = command()
    trackCommand(quick)
    const drained = drainCommands(60_000)
    quick.finish()
    expect(await drained).toEqual({ finished: 1, canceled: 0 })
    expect(quick.cancelForRestart).not.toHaveBeenCalled()
  })

  test('cancels what is still running when the window closes, and only that', async () => {
    const quick = command()
    const slow = command()
    trackCommand(quick)
    trackCommand(slow)
    quick.finish()
    await quick.settled
    // Already done before the drain began, the quick one isn't counted. The slow command never
    // finishes on its own: the (short) window is the only way out.
    expect(await drainCommands(5)).toEqual({ finished: 0, canceled: 1 })
    expect(slow.cancelForRestart).toHaveBeenCalledTimes(1)
    expect(quick.cancelForRestart).not.toHaveBeenCalled()
  })
})

const restart = { restartId: 'restart-1', restartedAt: '2026-10-28T21:32:00.000Z' }

test('the exact restart message carries authoritative correlation and partial-effect guidance', () => {
  const confirmed = commandCanceledForRestartError(restart)
  expect(confirmed.message).toStartWith(
    'This command was cancelled by a Ficus restart at 2026-10-28T21:32:00.000Z; nothing is wrong with your work or the box. Re-run it when your sandbox is back.'
  )
  expect(confirmed).toMatchObject({ reason: 'core_restart', restart })
  expect(confirmed.message).toContain('partial effects')
  const unconfirmed = commandCanceledForRestartError(restart, new Error('cancel timed out')).message
  expect(unconfirmed).toContain('could not confirm it stopped (cancel timed out)')
  expect(unconfirmed).toContain('`ps`')
})

test('one drain passes the same restart id and time to every interrupted command', async () => {
  const first = command()
  const second = command()
  trackCommand(first)
  trackCommand(second)
  await drainCommands(1, restart)
  expect(first.cancelForRestart).toHaveBeenCalledWith(restart)
  expect(second.cancelForRestart).toHaveBeenCalledWith(restart)
})
