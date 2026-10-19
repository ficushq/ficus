import { expect, test } from 'bun:test'
import { BigbrainProvider } from './provider'
import { BigbrainError } from './errors'
const configuration = {
  version: 2 as const,
  bindingId: 'personal',
  bindingFingerprint: 'a'.repeat(64),
  vaultPath: '/vault',
  executablePath: '/bin/bigbrain',
}
test('local provider has no API endpoint or bearer credential configuration', () => {
  const provider = new BigbrainProvider()
  expect(provider.adapterVersion).toBe(2)
  expect(provider.parseConfig(configuration)).toEqual(configuration)
  expect(() => provider.parseConfig({ version: 1, apiBase: 'https://old.invalid' })).toThrow()
})
test('provider validates authenticated use rather than trusting discovery', async () => {
  const provider = new BigbrainProvider({
    client: () => ({
      validate: async () => {
        throw new BigbrainError('invalid_auth')
      },
    }),
  })
  expect(
    await provider.validate({
      connection: { id: 'connection', providerKey: 'bigbrain', adapterVersion: 2, configuration },
      credential: 'aabb0011',
    })
  ).toEqual({ ok: false, code: 'invalid_auth' })
})
