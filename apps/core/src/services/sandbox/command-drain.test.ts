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

test('the restart message says what happened and what to do, with or without confirmed cleanup', () => {
  const confirmed = commandCanceledForRestartError().message
  expect(confirmed).toContain('Command canceled: the Ficus worker is restarting')
  expect(confirmed).toContain('run it again')
  const unconfirmed = commandCanceledForRestartError(new Error('cancel timed out')).message
  expect(unconfirmed).toContain('could not confirm it stopped (cancel timed out)')
  expect(unconfirmed).toContain('`ps`')
})
