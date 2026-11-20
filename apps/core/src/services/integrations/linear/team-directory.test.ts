import { describe, expect, mock, test } from 'bun:test'
import type { IntegrationConnectionRecord } from '../connection-repository'
import { LinearRateLimitedError } from './plugin'
import {
  LINEAR_TEAM_CACHE_TTL_MS,
  LINEAR_TEAM_MAX_PAGES,
  LINEAR_TEAM_PAGE_SIZE,
  createLinearTeamDirectory,
} from './team-directory'

function connection(
  id: string,
  overrides: Partial<IntegrationConnectionRecord> & { isDefault?: boolean } = {}
): IntegrationConnectionRecord & { isDefault: boolean } {
  return {
    id,
    providerKey: 'linear',
    adapterVersion: 1,
    clientAuthority: 'local',
    authorizationKind: 'manual',
    authorizationFlowId: null,
    displayName: `Linear ${id}`,
    configuration: {},
    credentialRef: `ref-${id}`,
    materialRevision: 'rev-1',
    validatedRevision: 'rev-1',
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    grantedScopes: [],
    validatedAt: new Date(),
    validationExpiresAt: new Date(Date.now() + 60_000),
    lastErrorCode: null,
    updatedAt: new Date(),
    isDefault: false,
    ...overrides,
  }
}

type Page = { nodes: Array<{ id: string; key: string; name: string }>; hasNextPage?: boolean; endCursor?: string }

function page({ nodes, hasNextPage = false, endCursor }: Page) {
  return { teams: { nodes, pageInfo: { hasNextPage, endCursor: endCursor ?? null } } }
}

/** A fake Linear: one listing per Authorization value, so a test sees which credential was used. */
function fakeLinear(byAuthorization: Record<string, Page[] | Error>) {
  return mock(async (authorization: string, _query: string, variables?: Record<string, unknown>) => {
    const pages = byAuthorization[authorization]
    if (!pages) throw new Error('invalid_auth')
    if (pages instanceof Error) throw pages
    const index = variables?.after ? Number(String(variables.after).replace('cursor-', '')) : 0
    return page(pages[index]) as never
  })
}

const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' }
const DES = { id: 'team-des', key: 'DES', name: 'Design' }
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' }

describe('Linear team directory', () => {
  test('queries each attached connection with its own credential, app and API key alike', async () => {
    const app = connection('app', { authorizationKind: 'oauth2', isDefault: true })
    const key = connection('key')
    const authorize = mock(async (record: IntegrationConnectionRecord) => ({
      authorization: record.id === 'app' ? 'Bearer app-token' : 'lin_api_key',
    }))
    const query = fakeLinear({
      'Bearer app-token': [{ nodes: [ENG, DES] }],
      lin_api_key: [{ nodes: [ENG, OPS] }],
    })
    const directory = createLinearTeamDirectory({ listAttached: async () => [app, key], authorize, query })

    const result = await directory.list('squad-1')

    expect(authorize.mock.calls.map(([record]) => record.id)).toEqual(['app', 'key'])
    expect(query.mock.calls.map(([authorization]) => authorization).sort()).toEqual(['Bearer app-token', 'lin_api_key'])
    expect(result.teams).toEqual([
      { ...DES, connectionIds: ['app'] },
      { ...ENG, connectionIds: ['app', 'key'] },
      { ...OPS, connectionIds: ['key'] },
    ])
    expect(result.connections).toEqual([
      { id: 'app', displayName: 'Linear app', isDefault: true, status: 'ok' },
      { id: 'key', displayName: 'Linear key', isDefault: false, status: 'ok' },
    ])
    expect(JSON.stringify(result)).not.toMatch(/app-token|lin_api_key|ref-/)
  })

  test('asks only for the squad’s attached connections', async () => {
    const listAttached = mock(async (_squadId: string) => [connection('only')])
    const query = fakeLinear({ secret: [{ nodes: [ENG] }] })
    const directory = createLinearTeamDirectory({
      listAttached,
      authorize: async () => ({ authorization: 'secret' }),
      query,
    })
    await directory.list('squad-7')
    expect(listAttached).toHaveBeenCalledWith('squad-7')
  })

  test('reports a squad with no Linear connection as an empty directory', async () => {
    const query = fakeLinear({})
    const directory = createLinearTeamDirectory({
      listAttached: async () => [],
      authorize: async () => ({ authorization: 'x' }),
      query,
    })
    expect(await directory.list('squad-1')).toEqual({ teams: [], connections: [] })
    expect(query).not.toHaveBeenCalled()
  })

  test('never calls Linear for a disabled or unusable connection', async () => {
    const authorize = mock(async (record: IntegrationConnectionRecord) =>
      record.id === 'expired' ? null : { authorization: 'ok' }
    )
    const query = fakeLinear({ ok: [{ nodes: [ENG] }] })
    const directory = createLinearTeamDirectory({
      listAttached: async () => [connection('disabled', { enabled: false }), connection('expired'), connection('ok')],
      authorize,
      query,
    })
    const result = await directory.list('squad-1')
    expect(authorize.mock.calls.map(([record]) => record.id)).toEqual(['expired', 'ok'])
    expect(query).toHaveBeenCalledTimes(1)
    expect(result.connections.map(({ id, status, error }) => ({ id, status, error }))).toEqual([
      { id: 'disabled', status: 'error', error: 'connection_unusable' },
      { id: 'expired', status: 'error', error: 'connection_unusable' },
      { id: 'ok', status: 'ok', error: undefined },
    ])
    expect(result.teams.map((team) => team.id)).toEqual(['team-eng'])
  })

  test('names a connection that needs Reconnect, a missing scope included, without calling Linear', async () => {
    const authorize = mock(async () => ({ authorization: 'never-used' }))
    const query = fakeLinear({})
    const directory = createLinearTeamDirectory({
      listAttached: async () => [
        connection('scope', { authState: 'reauthorization_required', lastErrorCode: 'insufficient_scope' }),
        connection('revoked', { authState: 'reauthorization_required', lastErrorCode: 'invalid_grant' }),
      ],
      authorize,
      query,
    })
    const result = await directory.list('squad-1')
    expect(result.connections.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: 'scope', error: 'insufficient_scope' },
      { id: 'revoked', error: 'reconnect_required' },
    ])
    expect(authorize).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  test('maps Linear failures per connection and keeps the teams others listed', async () => {
    const query = fakeLinear({
      good: [{ nodes: [ENG] }],
      limited: new LinearRateLimitedError(30_000),
      down: new Error('provider_unavailable'),
      odd: new Error('provider_query_failed'),
    })
    const directory = createLinearTeamDirectory({
      listAttached: async () => [
        connection('good'),
        connection('revoked'),
        connection('limited'),
        connection('down'),
        connection('odd'),
      ],
      authorize: async (record) => ({ authorization: record.id }),
      query,
    })
    const result = await directory.list('squad-1')
    expect(Object.fromEntries(result.connections.map((entry) => [entry.id, entry.error ?? entry.status]))).toEqual({
      good: 'ok',
      revoked: 'invalid_auth',
      limited: 'rate_limited',
      down: 'provider_unavailable',
      odd: 'provider_unavailable',
    })
    expect(result.teams.map((team) => team.key)).toEqual(['ENG'])
  })

  test('follows pages and flags a workspace larger than the cap', async () => {
    const pages: Page[] = Array.from({ length: LINEAR_TEAM_MAX_PAGES }, (_, index) => ({
      nodes: [{ id: `team-${index}`, key: `T${index}`, name: `Team ${String(index).padStart(2, '0')}` }],
      hasNextPage: true,
      endCursor: `cursor-${index + 1}`,
    }))
    const query = fakeLinear({
      big: pages,
      small: [{ ...pages[0], hasNextPage: true, endCursor: 'cursor-1' }, { nodes: [DES] }],
    })
    const directory = createLinearTeamDirectory({
      listAttached: async () => [connection('big'), connection('small')],
      authorize: async (record) => ({ authorization: record.id }),
      query,
    })
    const result = await directory.list('squad-1')
    const bigCalls = query.mock.calls.filter(([authorization]) => authorization === 'big')
    expect(bigCalls).toHaveLength(LINEAR_TEAM_MAX_PAGES)
    expect(bigCalls[0][2]).toEqual({ first: LINEAR_TEAM_PAGE_SIZE, after: null })
    expect(bigCalls[1][2]).toEqual({ first: LINEAR_TEAM_PAGE_SIZE, after: 'cursor-1' })
    expect(result.connections.find((entry) => entry.id === 'big')?.truncated).toBe(true)
    expect(result.connections.find((entry) => entry.id === 'small')?.truncated).toBeUndefined()
    expect(result.teams).toHaveLength(LINEAR_TEAM_MAX_PAGES + 1)
  })

  test('caches a listing briefly, per credential revision, and never caches a failure', async () => {
    let clock = 1_000
    let failNext = false
    const query = mock(async () => {
      if (failNext) {
        failNext = false
        throw new Error('provider_unavailable')
      }
      return page({ nodes: [ENG] }) as never
    })
    let record = connection('one')
    const directory = createLinearTeamDirectory({
      listAttached: async () => [record],
      authorize: async () => ({ authorization: 'key' }),
      query,
      now: () => clock,
    })

    await directory.list('squad-1')
    await directory.list('squad-2')
    expect(query).toHaveBeenCalledTimes(1)

    clock += LINEAR_TEAM_CACHE_TTL_MS + 1
    await directory.list('squad-1')
    expect(query).toHaveBeenCalledTimes(2)

    record = connection('one', { materialRevision: 'rev-2' })
    failNext = true
    expect((await directory.list('squad-1')).connections[0].status).toBe('error')
    expect(query).toHaveBeenCalledTimes(3)
    expect((await directory.list('squad-1')).connections[0].status).toBe('ok')
    expect(query).toHaveBeenCalledTimes(4)
  })
})
