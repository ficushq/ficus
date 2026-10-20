import { expect, test } from 'bun:test'
import { BigbrainLocalConnections } from './local-connections'
import type { SafeIntegrationConnection } from '../connection-service'
const configuration = {
  version: 2 as const,
  bindingId: 'approved',
  bindingFingerprint: 'a'.repeat(64),
  vaultPath: '/vault',
  executablePath: '/bin/bigbrain',
}
test('selection installs only operator-bound material through the trusted creation path', async () => {
  let installed: unknown
  const createdConnection: SafeIntegrationConnection = {
    id: 'connection',
    providerKey: 'bigbrain',
    adapterVersion: 2,
    displayName: 'Memory',
    configuration,
    credentialConfigured: true,
    enabled: false,
    authState: 'pending',
    healthState: 'unknown',
    grantedScopes: [],
    validatedAt: null,
    validationExpiresAt: null,
    lastErrorCode: null,
    usage: { squadCount: 0, squads: [] },
  }
  const local = new BigbrainLocalConnections(
    {
      resolve: async () => ({
        configuration,
        clientId: 'aabb0011',
        label: 'Approved',
        configuredExecutablePath: '/bin/bigbrain',
      }),
      list: async () => [{ id: 'approved', label: 'Approved', vaultPath: '/vault', executablePath: '/bin/bigbrain' }],
    },
    {
      create: async (input) => {
        installed = input
        return createdConnection
      },
    }
  )
  const result = await local.create({ bindingId: 'approved', displayName: 'Memory' }, 'user:operator')
  expect(result).toBe(createdConnection)
  expect(result.enabled).toBe(false)
  expect(installed).toEqual({
    providerKey: 'bigbrain',
    adapterVersion: 2,
    configuration,
    credential: 'aabb0011',
    displayName: 'Memory',
    actor: 'user:operator',
    clientAuthority: 'local',
    authorizationGrant: true,
  })
  expect(JSON.stringify(await local.list())).not.toContain('aabb0011')
})
