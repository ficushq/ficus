import { expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { authzSentinel } from '../middleware/authz-sentinel'
import type { Identity } from '../services/rbac'
import { ManagedVaultAuthorizationError } from '../services/integrations/bigbrain/managed/authorization'
import { ManagedBigbrainPlatformError } from '../services/integrations/bigbrain/managed/platform-client'
import { ManagedVaultServiceError } from '../services/integrations/bigbrain/managed/service'
import { createBigbrainSharedRouter, type ManagedVaultRouteService } from './bigbrain-shared'

const VAULT = '22222222-2222-4222-8222-222222222222'
const invite = {
  inviteUrl: `https://bb-${'2'.repeat(32)}.vaults.example.com/invite#${'A'.repeat(43)}`,
  expiresAt: '2026-10-20T01:00:00.000Z',
}
function app(identity: Identity | undefined, overrides: Partial<ManagedVaultRouteService> = {}) {
  const service = {
    list: mock(async () => []),
    get: mock(async () => ({ vaultId: VAULT })),
    create: mock(async () => ({ vaultId: VAULT, state: 'provisioning' })),
    rename: mock(async () => ({ vaultId: VAULT })),
    retry: mock(async () => ({ vaultId: VAULT })),
    setReadAccess: mock(async () => ({ vaultId: VAULT })),
    ownerInvite: mock(async () => invite),
    delete: mock(async () => ({ vaultId: VAULT, state: 'deleting' })),
    ...overrides,
  } as unknown as ManagedVaultRouteService
  const hono = new Hono()
  if (identity)
    hono.use('/api/*', async (c, next) => {
      c.set('identity', identity)
      await next()
    })
  hono.use('/api/*', authzSentinel)
  hono.route('/api/integrations/providers/bigbrain/shared-vaults', createBigbrainSharedRouter(service))
  return { hono, service }
}
const user: Identity = { type: 'user', userId: '11111111-1111-4111-8111-111111111111' }
const path = '/api/integrations/providers/bigbrain/shared-vaults'
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('every route requires an identity and is never cacheable', async () => {
  const anonymous = app(undefined)
  expect((await anonymous.hono.request(path)).status).toBe(401)
  const { hono } = app(user)
  for (const [route, init] of [
    [path, undefined],
    [path, json({})],
    [`${path}/${VAULT}`, undefined],
    [`${path}/${VAULT}`, json({}, 'PATCH')],
    [`${path}/${VAULT}/retry`, json({})],
    [`${path}/${VAULT}/read-access`, json({})],
    [`${path}/${VAULT}`, json({}, 'DELETE')],
  ] as const) {
    const response = await hono.request(route, init)
    expect([route, response.status < 300]).toEqual([route, true])
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
})

test('the owner device link is no-store and no-referrer', async () => {
  const { hono, service } = app(user)
  const response = await hono.request(
    `${path}/${VAULT}/owner-invite`,
    json({ requestId: VAULT, expectedGeneration: 1 })
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(await response.json()).toEqual(invite)
  expect(service.ownerInvite).toHaveBeenCalledWith(user, VAULT, { requestId: VAULT, expectedGeneration: 1 })
})

test('refusals are code-only with the right status; unexpected errors are not swallowed', async () => {
  for (const [error, status, body] of [
    [new ManagedVaultAuthorizationError('permission_required'), 403, { code: 'permission_required' }],
    [
      new ManagedVaultServiceError('generation_conflict', 409, 4),
      409,
      { code: 'generation_conflict', currentGeneration: 4 },
    ],
    [new ManagedVaultServiceError('confirmation_mismatch', 409), 409, { code: 'confirmation_mismatch' }],
    [new ManagedVaultServiceError('owner_unavailable', 409), 409, { code: 'owner_unavailable' }],
    [new ManagedBigbrainPlatformError('host_unreachable', true), 503, { code: 'host_unreachable', retryable: true }],
  ] as const) {
    const { hono } = app(user, {
      delete: mock(async () => {
        throw error
      }),
    } as never)
    const response = await hono.request(`${path}/${VAULT}`, json({}, 'DELETE'))
    expect([response.status, await response.json()]).toEqual([status, body])
  }
  const { hono } = app(user, {
    list: mock(async () => {
      throw new Error('unexpected sv_secret')
    }),
  } as never)
  const failed = await hono.request(path)
  expect(failed.status).toBe(500)
  expect(await failed.text()).not.toContain('sv_secret')
})
