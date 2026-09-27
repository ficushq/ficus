import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { authzSentinel } from '../middleware/authz-sentinel'
import type { ExportConsentService } from '../services/integrations/export/consent-service'
import type { Identity } from '../services/rbac'
import { createExternalExportRouter, type ExternalExportRoutes } from './external-export'

const agent = { id: 'agent-1', squadId: 'squad-1', parentAgentId: null }

function createApp(
  options: { identity?: Identity; findAgent?: ExternalExportRoutes['findAgent']; authorized?: boolean } = {}
) {
  const authorize = mock(async () => options.authorized ?? true)
  const status = mock(async () => null)
  const consent = {
    id: 'consent-1',
    connectionId: '00000000-0000-4000-8000-000000000001',
    agentId: agent.id,
    consentedByUserId: 'user-1',
    consentedAt: new Date('2026-08-26T00:00:00.000Z'),
    revokedAt: null,
    policyVersion: 1 as const,
    projectionVersion: 1 as const,
    adoptedEnqueueOrder: 0n,
  }
  const enable = mock(async () => consent)
  const revoke = mock(async () => consent)
  const dependencies: ExternalExportRoutes = {
    authorize,
    findAgent: options.findAgent ?? (async () => agent),
    service: { status, enable, revoke } as unknown as ExportConsentService,
  }
  const app = new Hono()
  const identity = options.identity
  if (identity !== undefined) {
    app.use('/api/*', async (c, next) => {
      c.set('identity', identity)
      await next()
    })
  }
  app.use('/api/*', authzSentinel)
  app.route('/api/agents', createExternalExportRouter(dependencies))
  return { app, authorize, status, enable, revoke }
}

describe('external export routes', () => {
  test('returns disabled status behind the authz sentinel', async () => {
    const { app, authorize, status } = createApp({ identity: { type: 'user', userId: 'user-1' } })

    const response = await app.request('/api/agents/agent-1/external-export')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: 'disabled' })
    expect(authorize).toHaveBeenCalledWith({ type: 'user', userId: 'user-1' }, 'squad-1', 'integrations:read')
    expect(status).toHaveBeenCalledWith('agent-1')
  })

  test('POST creates consent behind the authz sentinel', async () => {
    const { app, authorize, enable } = createApp({ identity: { type: 'user', userId: 'user-1' } })

    const response = await app.request('/api/agents/agent-1/external-export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: '00000000-0000-4000-8000-000000000001',
        consent: true,
        policyVersion: 1,
        projectionVersion: 1,
      }),
    })

    expect(response.status).toBe(201)
    expect(authorize).toHaveBeenCalledWith({ type: 'user', userId: 'user-1' }, 'squad-1', 'integrations:export')
    expect(enable).toHaveBeenCalledTimes(1)
  })

  test('DELETE revokes consent behind the authz sentinel', async () => {
    const identity = { type: 'user' as const, userId: 'user-1' }
    const { app, authorize, revoke } = createApp({ identity })

    const response = await app.request('/api/agents/agent-1/external-export', { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(authorize).toHaveBeenCalledWith(identity, 'squad-1', 'integrations:export')
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['GET', 401, { error: 'Unauthorized' }],
    ['DELETE', 401, { error: 'Unauthorized' }],
  ] as const)('%s without identity returns a stable unauthorized response', async (method, status, body) => {
    const { app, status: getStatus, revoke } = createApp()

    const response = await app.request('/api/agents/agent-1/external-export', { method })

    expect(response.status).toBe(status)
    expect(await response.json()).toEqual(body)
    expect(getStatus).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })

  test('POST without a human identity is rejected before mutation', async () => {
    const { app, enable } = createApp({ identity: { type: 'agent', agentId: 'caller-1', squadId: null } })

    const response = await app.request('/api/agents/agent-1/external-export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        connectionId: '00000000-0000-4000-8000-000000000001',
        consent: true,
        policyVersion: 1,
        projectionVersion: 1,
      }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Sign in with your Ficus account to turn on external export.',
      code: 'user_session_required',
    })
    expect(enable).not.toHaveBeenCalled()
  })

  test.each(['GET', 'POST', 'DELETE'] as const)('%s returns not found for a missing agent', async (method) => {
    const { app, enable, revoke, status } = createApp({
      identity: { type: 'user', userId: 'user-1' },
      findAgent: async () => null,
    })
    const request =
      method === 'POST'
        ? {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              connectionId: '00000000-0000-4000-8000-000000000001',
              consent: true,
              policyVersion: 1,
              projectionVersion: 1,
            }),
          }
        : { method }

    const response = await app.request('/api/agents/missing/external-export', request)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Agent not found' })
    expect(enable).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  test.each([
    ['GET', 'integrations:read'],
    ['POST', 'integrations:export'],
    ['DELETE', 'integrations:export'],
  ] as const)('%s denial returns forbidden without service calls', async (method, permission) => {
    const identity = { type: 'user' as const, userId: 'user-1' }
    const { app, authorize, enable, revoke, status } = createApp({ identity, authorized: false })
    const request =
      method === 'POST'
        ? {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              connectionId: '00000000-0000-4000-8000-000000000001',
              consent: true,
              policyVersion: 1,
              projectionVersion: 1,
            }),
          }
        : { method }

    const response = await app.request('/api/agents/agent-1/external-export', request)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Forbidden' })
    expect(authorize).toHaveBeenCalledWith(identity, 'squad-1', permission)
    expect(enable).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })
})
