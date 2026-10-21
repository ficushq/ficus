import { expect, test } from 'bun:test'
import { bigbrainPlugin } from './plugin'
import { bigbrainHostAvailability } from './availability'
import { IntegrationRegistry } from '../registry'

test('catalog exposes connected Core availability without probing bindings or trusting Desktop markers', () => {
  const previous = { ...process.env }
  const registry = new IntegrationRegistry({ plugins: [bigbrainPlugin], compatibilityProviders: [] })
  try {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    process.env.FICUS_DESKTOP_MANAGED = '1'
    delete process.env.FICUS_MANAGED
    expect(registry.catalog()[0]).toMatchObject({
      label: 'BigBrain',
      availability: { available: true },
      description: expect.stringContaining('Core host in one click'),
    })
    process.env.FICUS_MANAGED = '1'
    // Cloud offers managed shared vaults instead, and only once Platform confirms the host; the
    // description (also shown on each squad's card) describes shared vaults, not a local binding.
    expect(registry.catalog()[0]).toMatchObject({
      connectionMode: 'managed',
      description: expect.stringContaining('Attach a vault to a squad'),
      availability: { available: false, reason: expect.stringContaining('not been confirmed') },
    })
    expect(bigbrainHostAvailability()).toMatchObject({
      available: false,
      reason: expect.stringContaining('unavailable on Ficus Cloud'),
    })
    delete process.env.FICUS_MANAGED
    delete process.env.FICUS_SANDBOX_RUNTIME
    expect(registry.catalog()[0]).toMatchObject({
      availability: { available: false, reason: expect.stringContaining('runtime') },
    })
  } finally {
    process.env = previous
  }
})

test('Windows is unsupported even with a configured Desktop host runtime', () => {
  const previous = { ...process.env }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    delete process.env.FICUS_MANAGED
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    process.env.FICUS_DESKTOP_MANAGED = '1'
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(bigbrainHostAvailability()).toEqual({
      available: false,
      reason: expect.stringContaining('Windows is unsupported'),
    })
  } finally {
    process.env = previous
    Object.defineProperty(process, 'platform', platform)
  }
})
