import { expect, test } from 'bun:test'
import { acquireDerivation, abortable } from './operation'
test('abort releases synchronously and late cleanup cannot unlock a successor', async () => {
  const a = acquireDerivation('fixture')
  const pending = abortable(new Promise(() => {}), a.signal)
  a.cancel()
  const b = acquireDerivation('fixture')
  a.dispose()
  expect(() => acquireDerivation('fixture')).toThrow('derivation_in_progress')
  await expect(pending).rejects.toBeDefined()
  b.dispose()
})
test('terminal and abort races have one winner; already cancelled requests do not own locks', () => {
  const a = acquireDerivation('fixture')
  expect(a.complete()).toBe(true)
  a.cancel()
  expect(a.complete()).toBe(false)
  a.dispose()
  const controller = new AbortController(); controller.abort()
  const b = acquireDerivation('fixture', controller.signal)
  expect(b.signal.aborted).toBe(true)
  const c = acquireDerivation('fixture'); b.dispose(); c.dispose()
})
