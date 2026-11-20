import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('linear')
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, userLinearIdentities, users } from '../../../db'
import { ensureQueryIndex } from '../../../test-utils/message-query-indexes'
import { DbOAuthStateRepository } from '../authorization/db-state-repository'
import { AuthorizationFlowError } from '../authorization/service'
import type { OAuthTransport } from '../authorization/transport'
import { linearPlugin } from './plugin'
import { LinearIdentityAuthorization, recordLinearIdentity, resolveStoredLinearPurpose } from './identity-authorization'

const userIds: string[] = []
async function addUser() {
  const id = randomUUID()
  await db.insert(users).values({ id, email: `linear-identity-${id}@example.com` })
  userIds.push(id)
  return id
}

function fakeTransport() {
  const calls: Array<{ op: string; providerKey: string; token?: string }> = []
  const transport: OAuthTransport = {
    authority: 'local',
    requireConfigured: () => undefined,
    async authorizationUrl(input) {
      calls.push({ op: 'authorize', providerKey: input.providerKey })
      const url = new URL('https://linear.app/oauth/authorize')
      url.searchParams.set('state', input.localFlowId)
      url.searchParams.set('actor', input.providerKey === 'linear-identity' ? 'user' : 'app')
      return { authorizationUrl: url.toString(), expiresAt: new Date(Date.now() + 600_000).toISOString() }
    },
    async completeAuthorization(input) {
      calls.push({ op: 'exchange', providerKey: input.providerKey })
      return {
        tokens: { accessToken: 'person-token', refreshToken: 'person-refresh', expiresAt: null },
        configuration: null,
        displayName: 'Linear',
      }
    },
    async refresh() {
      throw new Error('unused')
    },
    async revoke(input) {
      calls.push({ op: 'revoke', providerKey: input.providerKey, token: input.token })
    },
  }
  return { transport, calls }
}

function linking(transport: OAuthTransport, identity = { linearUserId: 'linear-person', organizationId: 'org-1' }) {
  return new LinearIdentityAuthorization({
    transport,
    client: { userIdentity: async () => identity },
    authorization: {
      states: new DbOAuthStateRepository(),
      resolvePlugin: (key) => (key === 'linear' ? linearPlugin : undefined),
      transport,
      callbackUrl: () => 'https://ficus.example.com/settings/integrations/oauth/callback/linear',
      installGrant: async () => {
        throw new Error('an identity link must never install a connection')
      },
    },
  })
}

beforeAll(async () => {
  await ensureQueryIndex('uq_user_linear_identities_linear_user')
})
afterEach(async () => {
  if (userIds.length) {
    await db.delete(userLinearIdentities).where(inArray(userLinearIdentities.userId, userIds))
    await db.delete(users).where(inArray(users.id, userIds.splice(0)))
  }
})

describe('Linear identity linking', () => {
  test('a user-actor authorization records who the person is and keeps no token', async () => {
    const userId = await addUser()
    const { transport, calls } = fakeTransport()
    const service = linking(transport)
    const { authorizationUrl } = await service.start({ userId, returnTo: '/settings/linear-identity' })
    const state = new URL(authorizationUrl).searchParams.get('state')!
    expect(new URL(authorizationUrl).searchParams.get('actor')).toBe('user')
    // The stored purpose, not a request hint, routes the callback to the identity finalizer.
    expect(await resolveStoredLinearPurpose({ userId, source: { kind: 'callback', state } })).toBe('linear_identity')
    const result = await service.callback({ providerKey: 'linear', userId, state, code: 'code' })
    expect(result.returnTo).toBe('/settings/linear-identity')
    expect(await db.select().from(userLinearIdentities).where(eq(userLinearIdentities.userId, userId))).toMatchObject([
      { organizationId: 'org-1', linearUserId: 'linear-person' },
    ])
    expect(calls.map((call) => [call.op, call.providerKey])).toEqual([
      ['authorize', 'linear-identity'],
      ['exchange', 'linear-identity'],
      ['revoke', 'linear-identity'],
    ])
    expect(calls.at(-1)!.token).toBe('person-token')
  })

  test('another user’s state never resolves, and a refused identity records nothing', async () => {
    const userId = await addUser()
    const other = await addUser()
    const { transport } = fakeTransport()
    const service = new LinearIdentityAuthorization({
      transport,
      client: {
        userIdentity: async () => {
          throw new Error('not_user_actor')
        },
      },
      authorization: {
        states: new DbOAuthStateRepository(),
        resolvePlugin: (key) => (key === 'linear' ? linearPlugin : undefined),
        transport,
        callbackUrl: () => 'https://ficus.example.com/cb',
        installGrant: async () => undefined,
      },
    })
    const { authorizationUrl } = await service.start({ userId, returnTo: '/settings/linear-identity' })
    const state = new URL(authorizationUrl).searchParams.get('state')!
    expect(await resolveStoredLinearPurpose({ userId: other, source: { kind: 'callback', state } })).toBeNull()
    const error = await service
      .callback({ providerKey: 'linear', userId, state, code: 'code' })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(AuthorizationFlowError)
    expect((error as AuthorizationFlowError).code).toBe('not_user_actor')
    expect(await db.select().from(userLinearIdentities).where(eq(userLinearIdentities.userId, userId))).toEqual([])
  })

  test('a Linear account belongs to one Ficus user; linking it again moves it', async () => {
    const first = await addUser()
    const second = await addUser()
    await recordLinearIdentity({ userId: first, organizationId: 'org-2', linearUserId: 'shared-person' })
    await recordLinearIdentity({ userId: second, organizationId: 'org-2', linearUserId: 'shared-person' })
    const rows = await db.select().from(userLinearIdentities).where(eq(userLinearIdentities.organizationId, 'org-2'))
    expect(rows.map((row) => row.userId)).toEqual([second])
    expect(await linking(fakeTransport().transport).unlink(second, 'org-2')).toBe(true)
  })
})
