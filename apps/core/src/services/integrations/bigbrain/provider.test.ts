import { describe, expect, test } from 'bun:test'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
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

describe('managed shared configuration', () => {
  const managed = {
    version: 2 as const,
    mode: 'managed_shared' as const,
    vaultId: '22222222-2222-4222-8222-222222222222',
    upstreamVaultId: '33333333-3333-4333-8333-333333333333',
    upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  }
  const readToken = `sv_0123abcd_${'A'.repeat(43)}`
  const context = (credential: string) => ({
    connection: { id: crypto.randomUUID(), providerKey: 'bigbrain', adapterVersion: 2, configuration: managed },
    credential,
  })

  test('validates by authenticating the read token as the read-only reader, never as a local binding', async () => {
    const seen: string[] = []
    const local = { validate: async () => [] as string[] }
    const provider = new BigbrainProvider({
      client: () => {
        seen.push('local')
        return local
      },
      managedValidate: async (configuration, token, connectionId) => {
        seen.push(`${configuration.vaultId}:${token === readToken}:${connectionId.length}`)
      },
    })
    expect(await provider.validate(context(readToken))).toEqual({ ok: true, grantedScopes: ['read'] })
    expect(seen).toEqual([`${managed.vaultId}:true:36`])
  })

  test('a local client ID, a refused identity or a missing binding never validates', async () => {
    const refused = new BigbrainProvider({
      managedValidate: async () => {
        throw new BigbrainError('invalid_auth')
      },
    })
    expect(await refused.validate(context('0123abcd'))).toEqual({ ok: false, code: 'invalid_configuration' })
    expect(await refused.validate(context(readToken))).toEqual({ ok: false, code: 'invalid_auth' })
    // Default path: no synchronized material/capabilities for this vault.
    expect(await new BigbrainProvider().validate(context(readToken))).toEqual({
      ok: false,
      code: 'binding_unavailable',
    })
  })
})
