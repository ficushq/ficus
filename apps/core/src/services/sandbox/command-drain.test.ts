import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  commandCanceledForRestartError,
  commandRefusedForRestartError,
  restartContextForCommandError,
  drainCommands,
  isCommandDrainActive,
  resetCommandDrainForTests,
  trackCommand,
  withBoxCommandDrain,
  withIdleBoxCommandFence,
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

test('restart attribution follows genuine causes but rejects fabricated metadata and cycles', () => {
  expect(
    restartContextForCommandError(new Error('wrapped', { cause: commandCanceledForRestartError(restart) }))
  ).toEqual(restart)
  expect(
    restartContextForCommandError(Object.assign(new Error('forged'), { reason: 'core_restart', restart }))
  ).toBeUndefined()
  const cycle = new Error('cycle')
  cycle.cause = cycle
  expect(restartContextForCommandError(cycle)).toBeUndefined()
})

describe('box command drain', () => {
  test('cancels only the selected box, holds admission through restart, and leaves global shutdown open', async () => {
    expect(typeof withBoxCommandDrain).toBe('function')
    const selected = command()
    const unrelated = command()
    trackCommand({ ...selected, sandboxId: 'selected' })
    trackCommand({ ...unrelated, sandboxId: 'unrelated' })
    const result = await withBoxCommandDrain(
      'selected',
      async (context) => {
        expect(context).toEqual(restart)
        expect(isCommandDrainActive('selected')).toBe(true)
        const refused = commandRefusedForRestartError('selected')
        expect(refused.message).toContain('Nothing ran')
        expect(restartContextForCommandError(refused)).toEqual(restart)
        expect(isCommandDrainActive('unrelated')).toBe(false)
        expect(isCommandDrainActive()).toBe(false)
        expect(selected.cancelForRestart).toHaveBeenCalledWith(restart)
        expect(unrelated.cancelForRestart).not.toHaveBeenCalled()
        return 'adopted'
      },
      0,
      restart
    )
    expect(result).toBe('adopted')
    expect(isCommandDrainActive('selected')).toBe(false)
    expect(await drainCommands(0, restart)).toEqual({ finished: 0, canceled: 1 })
    expect(unrelated.cancelForRestart).toHaveBeenCalledWith(restart)
  })

  test('unproven cancellation prevents disconnect, releases the gate, and preserves the cause', async () => {
    const failure = new Error('remote cleanup unproven')
    const selected = command()
    trackCommand({
      ...selected,
      sandboxId: 'selected',
      cancelForRestart: async () => {
        throw failure
      },
    })
    const disconnected = mock(async () => {})
    await expect(withBoxCommandDrain('selected', disconnected, 0, restart)).rejects.toBe(failure)
    expect(disconnected).not.toHaveBeenCalled()
    expect(isCommandDrainActive('selected')).toBe(false)
    selected.finish()
  })

  test('overlapping box drains retain the first restart context and do not reopen each other', async () => {
    const hold = Promise.withResolvers<void>()
    const first = withBoxCommandDrain('selected', async () => hold.promise, 0, restart)
    await withBoxCommandDrain(
      'selected',
      async (context) => {
        expect(context).toEqual(restart)
      },
      0,
      { ...restart, restartId: 'later' }
    )
    expect(isCommandDrainActive('selected')).toBe(true)
    hold.resolve()
    await first
    expect(isCommandDrainActive('selected')).toBe(false)
  })
})

test('an idle-fence tracked-work deferral releases its own gate before the continuation', async () => {
  const work = command()
  trackCommand({ ...work, sandboxId: 'deferred-setup' })
  try {
    expect(
      await withIdleBoxCommandFence(
        'deferred-setup',
        async () => {
          throw new Error('Must defer')
        },
        async () => {
          expect(isCommandDrainActive('deferred-setup')).toBe(false)
          await Promise.resolve()
          expect(isCommandDrainActive('deferred-setup')).toBe(false)
          expect(work.cancelForRestart).not.toHaveBeenCalled()
          return 'reconciled'
        }
      )
    ).toBe('reconciled')
  } finally {
    work.finish()
  }
})
