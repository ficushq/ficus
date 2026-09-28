import { afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../test-utils/maintenance-test-isolation'
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { PLATFORM_MAINTENANCE_HEADERS } from '@ficus/shared'
import { db, instanceMaintenanceAudit, instanceMaintenanceState, systemTokens } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders } from '../test-utils'
import { createSystemToken, resolveSystemToken } from '../services/auth/system-tokens'
import { maintenanceStore } from '../services/maintenance'
import { systemTokensRouter } from './system-tokens'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
beforeAll(async () => {
  releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(() => releaseMaintenanceIsolation?.())

const app = new Hono().use('*', identityMiddleware).route('/api/system-tokens', systemTokensRouter)
const endpoint = '/api/system-tokens/self/platform-maintenance-upgrade'

beforeAll(() => maintenanceStore.initialize())
beforeEach(async () => {
  await db.delete(instanceMaintenanceAudit)
  await db.delete(systemTokens)
})
afterAll(async () => {
  await db.delete(instanceMaintenanceAudit)
  await db.delete(systemTokens)
})

async function audits() {
  return db.select().from(instanceMaintenanceAudit).orderBy(instanceMaintenanceAudit.createdAt)
}

describe('platform maintenance token self-upgrade', () => {
  it('audits upgraded and idempotent attempts without credential material', async () => {
    const { token, record } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    for (let i = 0; i < 2; i++) {
      const response = await app.request(endpoint, { method: 'POST', headers: authHeaders(token) })
      expect(response.status).toBe(200)
      expect((await response.json()).scopes).toEqual(['machines:write', 'machines:read', 'system:pause'])
    }
    expect((await resolveSystemToken(token))?.scopes).toEqual(['machines:write', 'machines:read', 'system:pause'])
    const rows = await audits()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.metadata?.outcome)).toEqual(['upgraded', 'already_explicit'])
    expect(rows[0]).toMatchObject({
      action: 'platform_token_upgrade_attempt',
      actor: `system-token:${record.id}`,
      metadata: {
        principalClass: 'system',
        endpoint,
        protocolVersion: null,
        callerVersion: null,
        instanceId: null,
        correlationId: null,
        policy: 'observe',
        outcome: 'upgraded',
        reasonCode: 'eligible',
      },
    })
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('audits wrong-name and missing-read tokens without changing scopes', async () => {
    const cases = [
      { name: 'other', scopes: ['machines:write', 'machines:read'], reasonCode: 'wrong_name' },
      { name: 'platform-orchestrator', scopes: ['machines:write'], reasonCode: 'missing_machine_scope' },
    ]
    for (const input of cases) {
      const { token } = await createSystemToken({ name: input.name, scopes: input.scopes })
      const response = await app.request(endpoint, { method: 'POST', headers: authHeaders(token) })
      expect(response.status).toBe(403)
      expect((await resolveSystemToken(token))?.scopes).toEqual(input.scopes)
    }
    const rows = await audits()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.metadata?.reasonCode)).toEqual(cases.map(({ reasonCode }) => reasonCode))
    expect(rows.every((row) => row.metadata?.outcome === 'denied')).toBe(true)
  })

  it('copies validated compatibility context into the audit', async () => {
    const { token } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    const context = {
      callerVersion: 'a'.repeat(40),
      instanceId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
    }
    const response = await app.request(endpoint, {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        [PLATFORM_MAINTENANCE_HEADERS.protocol]: '1',
        [PLATFORM_MAINTENANCE_HEADERS.callerVersion]: context.callerVersion,
        [PLATFORM_MAINTENANCE_HEADERS.instanceId]: context.instanceId,
        [PLATFORM_MAINTENANCE_HEADERS.correlationId]: context.correlationId,
      },
    })
    expect(response.status).toBe(200)
    expect((await audits())[0]?.metadata).toMatchObject({ protocolVersion: 1, ...context })
  })

  it('denies unsupported complete context and preserves its sanitized audit fields', async () => {
    const { token } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    const context = {
      callerVersion: 'd'.repeat(40),
      instanceId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
    }
    const response = await app.request(endpoint, {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        [PLATFORM_MAINTENANCE_HEADERS.protocol]: '999',
        [PLATFORM_MAINTENANCE_HEADERS.callerVersion]: context.callerVersion,
        [PLATFORM_MAINTENANCE_HEADERS.instanceId]: context.instanceId,
        [PLATFORM_MAINTENANCE_HEADERS.correlationId]: context.correlationId,
      },
    })
    expect(response.status).toBe(426)
    expect((await resolveSystemToken(token))?.scopes).toEqual(['machines:write', 'machines:read'])
    expect((await audits())[0]?.metadata).toMatchObject({
      outcome: 'denied',
      reasonCode: 'compatibility_floor',
      protocolVersion: 999,
      ...context,
    })
  })

  it('denies incomplete context while auditing only its validated fields', async () => {
    const { token } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    const instanceId = crypto.randomUUID()
    const response = await app.request(endpoint, {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        [PLATFORM_MAINTENANCE_HEADERS.instanceId]: instanceId,
      },
    })
    expect(response.status).toBe(426)
    expect((await audits())[0]?.metadata).toMatchObject({
      outcome: 'denied',
      reasonCode: 'compatibility_floor',
      protocolVersion: null,
      callerVersion: null,
      instanceId,
      correlationId: null,
    })
  })

  it('audits malformed context and does not mutate the token', async () => {
    const { token, record } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    const response = await app.request(endpoint, {
      method: 'POST',
      headers: { ...authHeaders(token), [PLATFORM_MAINTENANCE_HEADERS.protocol]: 'infinite' },
    })
    expect(response.status).toBe(400)
    const [stored] = await db.select().from(systemTokens).where(eq(systemTokens.id, record.id))
    expect(stored?.scopes).toEqual(['machines:write', 'machines:read'])
    expect((await audits())[0]?.metadata).toMatchObject({ outcome: 'denied', reasonCode: 'invalid_context' })
  })

  it('serializes concurrent upgrades into upgraded then already_explicit', async () => {
    const { token } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    const responses = await Promise.all(
      [1, 2].map(() => app.request(endpoint, { method: 'POST', headers: authHeaders(token) }))
    )
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect((await audits()).map((row) => row.metadata?.outcome).sort()).toEqual(['already_explicit', 'upgraded'])
  })

  it('recreates the maintenance singleton before auditing', async () => {
    await db.delete(instanceMaintenanceState)
    const { token } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    expect((await app.request(endpoint, { method: 'POST', headers: authHeaders(token) })).status).toBe(200)
    expect(await audits()).toHaveLength(1)
    expect(await db.select().from(instanceMaintenanceState)).toHaveLength(1)
  })
})

describe('platform maintenance upgrade service invariants', () => {
  it('denies enforce/disabled compatibility decisions with audited statuses', async () => {
    const { upgradePlatformMaintenanceToken } = await import('../services/auth/system-tokens')
    const { decidePlatformMaintenanceCompatibility, parsePlatformMaintenanceHeaders } =
      await import('../services/auth/platform-maintenance-compatibility')
    const { record } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    const identity = {
      type: 'system' as const,
      systemTokenId: record.id,
      name: record.name,
      scopes: record.scopes,
    }
    for (const [policy, status] of [
      ['enforce', 426],
      ['disabled', 410],
    ] as const) {
      const parsed = parsePlatformMaintenanceHeaders(() => undefined)
      const result = await upgradePlatformMaintenanceToken({
        identity,
        actor: `system-token:${record.id}`,
        principalClass: 'system',
        policy,
        compatibility: decidePlatformMaintenanceCompatibility(policy, parsed),
      })
      expect(result).toMatchObject({ ok: false, status })
    }
    expect((await audits()).map((row) => row.metadata?.reasonCode)).toEqual([
      'compatibility_floor',
      'compatibility_disabled',
    ])
  })

  it('audits a wrong principal that reaches the service', async () => {
    const { upgradePlatformMaintenanceToken } = await import('../services/auth/system-tokens')
    const result = await upgradePlatformMaintenanceToken({
      identity: { type: 'legacy' },
      actor: 'legacy',
      principalClass: 'legacy',
      policy: 'observe',
      compatibility: {
        allowed: true,
        context: { protocolVersion: null, callerVersion: null, instanceId: null, correlationId: null },
        legacyUnknown: true,
      },
    })
    expect(result).toMatchObject({ ok: false, status: 403, reasonCode: 'wrong_principal' })
    expect((await audits())[0]?.metadata).toMatchObject({ outcome: 'denied', reasonCode: 'wrong_principal' })
  })

  it('rolls back scope mutation when the audit write fails', async () => {
    const { upgradePlatformMaintenanceToken } = await import('../services/auth/system-tokens')
    const { record } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    await expect(
      upgradePlatformMaintenanceToken(
        {
          identity: {
            type: 'system',
            systemTokenId: record.id,
            name: record.name,
            scopes: record.scopes,
          },
          actor: `system-token:${record.id}`,
          principalClass: 'system',
          policy: 'observe',
          compatibility: {
            allowed: true,
            context: { protocolVersion: null, callerVersion: null, instanceId: null, correlationId: null },
            legacyUnknown: true,
          },
        },
        { writeAudit: async () => Promise.reject(new Error('injected audit failure')) }
      )
    ).rejects.toThrow('injected audit failure')
    const [stored] = await db.select().from(systemTokens).where(eq(systemTokens.id, record.id))
    expect(stored?.scopes).toEqual(['machines:write', 'machines:read'])
  })

  it('uses the database clock for lease effectiveness despite host skew', async () => {
    const [{ databaseNow }] = await db
      .select({ databaseNow: sql<string>`clock_timestamp()` })
      .from(instanceMaintenanceState)
      .limit(1)
    const leaseId = crypto.randomUUID()
    const expiry = new Date(new Date(databaseNow!).getTime() + 60_000)
    await db
      .update(instanceMaintenanceState)
      .set({
        platformLeaseId: leaseId,
        platformLeaseOwnerTokenId: crypto.randomUUID(),
        platformLeaseHolder: 'test',
        platformLeaseAcquiredAt: new Date(databaseNow!),
        platformLeaseExpiresAt: expiry,
        generation: 7,
      })
      .where(eq(instanceMaintenanceState.id, 'global'))
    const { token } = await createSystemToken({
      name: 'platform-orchestrator',
      scopes: ['machines:write', 'machines:read'],
    })
    setSystemTime(new Date(expiry.getTime() + 60_000))
    try {
      expect((await app.request(endpoint, { method: 'POST', headers: authHeaders(token) })).status).toBe(200)
    } finally {
      setSystemTime()
    }
    expect((await audits())[0]).toMatchObject({
      generation: 7,
      leaseId,
      leaseExpiresAt: expiry,
      effective: true,
    })
  })
})
