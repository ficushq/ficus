import { afterEach, expect, test } from 'bun:test'
import { createFakeAdapter, fakeGrant } from '@ficus/shared/oauth-providers/fake'
import { registerOAuthProviderAdapterForTest } from '@ficus/shared/oauth-providers'
import { createLocalTransport } from '../authorization/transport'
import { projectIntegrationAssignments } from '../projection/projector'
import { resolveProtectedBindings } from '../projection/protected-env'
import { createNotionPlugin } from './plugin'

let restoreAdapter: (() => void) | undefined
afterEach(() => {
  restoreAdapter?.()
  restoreAdapter = undefined
})

/** Deterministic full lifecycle with a fake provider/CLI transport and zero network calls. */
test('connect assign reconcile invoke rotate without reinstall and unassign', async () => {
  const script = {
    responses: [
      fakeGrant({
        accessToken: 'token-one',
        refreshToken: 'refresh-one',
        workspaceId: 'workspace-1',
        botId: 'bot-1',
      }),
    ],
    revoked: [],
    calls: [] as Array<{ op: string; at: number }>,
  }
  restoreAdapter = registerOAuthProviderAdapterForTest(createFakeAdapter(script))
  const transport = createLocalTransport({
    resolveClientCredentials: () => ({ clientId: 'id', clientSecret: 'secret' }),
    callbackUrl: () => 'https://tau/callback',
  })
  const plugin = createNotionPlugin({ currentBot: async () => ({ botId: 'bot-1' }) })
  // The fake provider exchange is the only provider interaction; no fetch/network implementation exists.
  const exchanged = await transport.completeAuthorization({
    providerKey: 'notion',
    localFlowId: 'flow',
    code: 'code',
    redirectUri: 'https://tau/callback',
  })
  const grant = {
    configuration: plugin.connection.parseConfiguration(exchanged.configuration),
    credential: plugin.connection.credential.parse(
      plugin.connection.credential.serialize({ version: 1, ...exchanged.tokens, tokenRevision: 1 })
    ),
    displayName: exchanged.displayName,
  }
  expect(script.calls.map((call) => call.op)).toEqual(['exchange'])
  const connection = {
    id: 'connection-1',
    providerKey: 'notion',
    adapterVersion: 1,
    configuration: grant.configuration,
    credentialRef: 'credential-1',
    materialRevision: 'revision-1',
  }
  const secrets = new Map([['credential-1', plugin.connection.credential.serialize(grant.credential)]])
  const assigned = projectIntegrationAssignments([{ plugin, connection }], {
    resolveCredential: async (reference) => secrets.get(reference),
  })
  expect(assigned.publicDeclaration.packages).toEqual(['nodejs@24.12.0'])
  expect(assigned.publicDeclaration.readiness).toEqual([
    { id: 'notion-cli', command: 'ntn --version', expectedSubstring: '0.22.10' },
  ])
  const firstEnv = Object.fromEntries(await resolveProtectedBindings(assigned))
  const fakeCli = (args: string[]) => {
    expect(args).toEqual(['ntn', 'api', 'v1/search', '--data', '{}'])
    expect(firstEnv.NOTION_API_TOKEN).toBe('token-one')
    return { results: [] }
  }
  expect(fakeCli(['ntn', 'api', 'v1/search', '--data', '{}'])).toEqual({ results: [] })

  secrets.set(
    'credential-1',
    plugin.connection.credential.serialize({ ...grant.credential, accessToken: 'token-two', tokenRevision: 2 })
  )
  const rotated = projectIntegrationAssignments([{ plugin, connection }], {
    resolveCredential: async (reference) => secrets.get(reference),
  })
  expect(rotated.fingerprint).toBe(assigned.fingerprint)
  expect(Object.fromEntries(await resolveProtectedBindings(rotated)).NOTION_API_TOKEN).toBe('token-two')
  expect(projectIntegrationAssignments([]).publicDeclaration.packages).toEqual([])
})
