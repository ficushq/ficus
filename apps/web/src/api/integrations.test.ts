import { describe, expect, mock, test } from 'bun:test'
import {
  assignIntegration,
  getBigbrainLocalBindings,
  createLocalBigbrainIntegration,
  callbackIntegrationAuthorization,
  completeIntegrationAuthorization,
  configureIntegrationOAuthApp,
  getIntegrationOAuthApp,
  getSquadIntegrationSelection,
  listIntegrationPool,
  removeIntegration,
  startIntegrationAuthorization,
  unassignIntegration,
} from './integrations'

const fetcher = mock(async () => undefined as unknown)

describe('integration pool API', () => {
  test('lists the global provider pool', async () => {
    fetcher.mockResolvedValueOnce([])
    await listIntegrationPool('bigbrain', fetcher)
    expect(fetcher).toHaveBeenCalledWith('/integrations/connections?provider=bigbrain')
  })

  test('gets and mutates the squad assignment through separate routes', async () => {
    fetcher.mockResolvedValueOnce({ providerKey: 'bigbrain', assignment: null, connections: [] })
    await getSquadIntegrationSelection('squad-1', 'bigbrain', fetcher)
    expect(fetcher).toHaveBeenLastCalledWith('/squads/squad-1/integrations/bigbrain')

    fetcher.mockResolvedValueOnce({})
    await assignIntegration('squad-1', 'bigbrain', 'connection-1', fetcher)
    expect(fetcher).toHaveBeenLastCalledWith('/squads/squad-1/integrations/bigbrain/assignment', {
      method: 'PUT',
      body: JSON.stringify({ connectionId: 'connection-1' }),
    })
    await unassignIntegration('squad-1', 'bigbrain', fetcher)
    expect(fetcher).toHaveBeenLastCalledWith('/squads/squad-1/integrations/bigbrain/assignment', { method: 'DELETE' })
  })

  test('reads and configures only safe OAuth application settings', async () => {
    fetcher.mockResolvedValueOnce({ authority: 'local', configured: false, clientId: null })
    await getIntegrationOAuthApp('notion', fetcher)
    expect(fetcher).toHaveBeenLastCalledWith('/integrations/providers/notion/oauth-app')
    const input = { clientId: 'client-id', clientSecret: 'secret', capabilitiesAcknowledged: true as const }
    await configureIntegrationOAuthApp('notion', input, fetcher)
    expect(fetcher).toHaveBeenLastCalledWith('/integrations/providers/notion/oauth-app', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  })

  test('starts and completes provider-qualified OAuth without a scope parameter', async () => {
    fetcher.mockResolvedValueOnce({ authorizationUrl: 'https://api.notion.com/oauth/authorize' })
    await startIntegrationAuthorization('notion', { returnTo: '/settings', connectionId: 'connection-1' }, fetcher)
    expect(fetcher).toHaveBeenLastCalledWith('/integrations/providers/notion/authorization/start', {
      method: 'POST',
      body: JSON.stringify({ returnTo: '/settings', connectionId: 'connection-1' }),
    })
    fetcher.mockResolvedValueOnce({ returnTo: '/settings' })
    await callbackIntegrationAuthorization('notion', { state: 'state', code: 'code' }, fetcher)
    expect(fetcher).toHaveBeenLastCalledWith('/integrations/providers/notion/authorization/callback', {
      method: 'POST',
      body: JSON.stringify({ state: 'state', code: 'code' }),
    })
    fetcher.mockResolvedValueOnce({ returnTo: '/settings' })
    await completeIntegrationAuthorization('notion', { localFlowId: 'flow', handle: 'handle' }, fetcher)
    expect(fetcher).toHaveBeenLastCalledWith('/integrations/providers/notion/authorization/complete', {
      method: 'POST',
      body: JSON.stringify({ localFlowId: 'flow', handle: 'handle' }),
    })
  })

  test('confirmed global removal sends explicit confirmation', async () => {
    fetcher.mockResolvedValueOnce(undefined)
    await removeIntegration('connection-1', true, fetcher)
    expect(fetcher).toHaveBeenCalledWith('/integrations/connections/connection-1?confirmAssigned=true', {
      method: 'DELETE',
    })
  })
})

test('local BigBrain API sends only an approved binding selection', async () => {
  await getBigbrainLocalBindings(fetcher)
  expect(fetcher).toHaveBeenLastCalledWith('/integrations/providers/bigbrain/local-bindings')
  await createLocalBigbrainIntegration({ bindingId: 'approved', displayName: 'Memory' }, fetcher)
  expect(fetcher).toHaveBeenLastCalledWith('/integrations/providers/bigbrain/local-connections', {
    method: 'POST',
    body: JSON.stringify({ bindingId: 'approved', displayName: 'Memory' }),
  })
})
