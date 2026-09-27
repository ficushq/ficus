import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { cleanupTestRbac, createTestAdmin, createTestCredential } from '../../test-utils/rbac'
import type { Identity } from '../rbac'
import { FIRST_ADMIN_INCOMPLETE, USER_SESSION_REQUIRED, userSessionRequired } from './user-session-required'

const PREFIX = 'user-session-required-test'

afterEach(() => cleanupTestRbac(PREFIX))

async function respond(identity: Identity | undefined) {
  const app = new Hono()
  app.get('/', (c) => userSessionRequired(c, identity, 'connect GitHub'))
  const res = await app.request('/')
  return { status: res.status, body: await res.json() }
}

describe('userSessionRequired', () => {
  test('the bootstrap session before any admin passkey is told to finish admin setup', async () => {
    expect(await respond({ type: 'legacy' })).toEqual({
      status: 403,
      body: { error: 'Finish setting up your admin account to connect GitHub.', code: FIRST_ADMIN_INCOMPLETE },
    })
  })

  test('the bootstrap session once an admin holds a passkey gets the generic code', async () => {
    const admin = await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })
    await createTestCredential({ userId: admin.id })
    expect((await respond({ type: 'legacy' })).body.code).toBe(USER_SESSION_REQUIRED)
  })

  test('agents and system tokens are asked for a person', async () => {
    const agent = await respond({ type: 'agent', agentId: 'agent-1', squadId: null })
    expect(agent).toEqual({
      status: 403,
      body: { error: 'Sign in with your Ficus account to connect GitHub.', code: USER_SESSION_REQUIRED },
    })
    const system = await respond({ type: 'system', systemTokenId: 'token-1', name: 'ci', scopes: [] })
    expect(system.body.code).toBe(USER_SESSION_REQUIRED)
  })
})
