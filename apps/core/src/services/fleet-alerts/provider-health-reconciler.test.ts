import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import type { ProviderHealthRecord, ProviderRoute } from '@ficus/shared/provider-health'
import { db } from '../../db'
import { fleetIncidentNotifications, fleetIncidents } from '../../db/schema'
import { reconcileProviderHealthRecords } from './provider-health-reconciler'

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000

describe('provider health alert reconciliation', () => {
  let provider: string

  beforeEach(() => {
    provider = `provider-reconcile-${crypto.randomUUID()}`
  })

  afterEach(async () => {
    const incidentIds = (
      await db.select({ id: fleetIncidents.id }).from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    ).map((row) => row.id)
    if (incidentIds.length) {
      await db.delete(fleetIncidentNotifications).where(inArray(fleetIncidentNotifications.incidentId, incidentIds))
      await db.delete(fleetIncidents).where(inArray(fleetIncidents.id, incidentIds))
    }
  })

  const record = (accountId: string, since: number): ProviderHealthRecord => ({
    provider,
    accountId,
    kind: 'expired-oauth',
    message: 'OAuth refresh credential expired or was revoked.',
    since,
  })
  const route = (accountId: string): ProviderRoute => ({ provider, accountId, credentialUsable: true })

  async function transitions() {
    const incidents = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    if (incidents.length === 0) return []
    return db
      .select()
      .from(fleetIncidentNotifications)
      .where(
        inArray(
          fleetIncidentNotifications.incidentId,
          incidents.map((incident) => incident.id)
        )
      )
  }

  test('uses shared account record continuity and alerts only when strictly older than 15 minutes', async () => {
    const since = Date.parse('2026-08-17T00:00:00.000Z')
    const records = [record('a1', since)]
    const enabledChains = [[route('a1')]]

    const exactBoundary = await reconcileProviderHealthRecords({
      records,
      enabledChains,
      now: new Date(since + FIFTEEN_MINUTES_MS),
    })
    expect(exactBoundary.fleetStarved).toBe(true)
    const [incident] = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    expect(incident).toMatchObject({
      kind: 'provider_unhealthy',
      provider,
      accountId: 'a1',
      scopeKey: `provider:${provider}:account:a1`,
      healthKind: 'expired-oauth',
      startedAt: new Date(since),
    })
    expect(await transitions()).toEqual([])

    await reconcileProviderHealthRecords({
      records,
      enabledChains,
      now: new Date(since + FIFTEEN_MINUTES_MS + 1),
    })
    expect((await transitions()).map((transition) => transition.kind)).toEqual(['alert'])
  })

  test('keeps accounts independent and shares fleetStarved route resolution', async () => {
    const since = Date.parse('2026-08-17T00:00:00.000Z')
    const records = [record('a1', since), { ...record('a2', since), kind: 'plan-credit' as const }]
    const enabledChains = [[route('a1'), route('a2')]]

    const result = await reconcileProviderHealthRecords({ records, enabledChains, now: new Date(since + 1) })

    expect(result.fleetStarved).toBe(true)
    const incidents = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    expect(
      incidents
        .map((incident) => ({ accountId: incident.accountId, scopeKey: incident.scopeKey }))
        .sort((left, right) => left.accountId!.localeCompare(right.accountId!))
    ).toEqual([
      { accountId: 'a1', scopeKey: `provider:${provider}:account:a1` },
      { accountId: 'a2', scopeKey: `provider:${provider}:account:a2` },
    ])

    const oneHealthyRoute = await reconcileProviderHealthRecords({
      records: [record('a1', since)],
      enabledChains,
      now: new Date(since + 2),
    })
    expect(oneHealthyRoute.fleetStarved).toBe(false)
    const afterRecovery = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    expect(afterRecovery.find((incident) => incident.accountId === 'a1')?.resolvedAt).toBeNull()
    expect(afterRecovery.find((incident) => incident.accountId === 'a2')?.resolvedAt).toEqual(new Date(since + 2))
  })

  test('does not alert a provider-wide record overridden by exact-account recovery', async () => {
    const since = Date.parse('2026-08-17T00:00:00.000Z')
    const providerWide: ProviderHealthRecord = {
      provider,
      kind: 'network',
      message: 'Provider network is unavailable.',
      since,
    }
    const recoveredExact = { ...record('a1', since), lastSuccessAt: since + 1 }

    const result = await reconcileProviderHealthRecords({
      records: [providerWide, recoveredExact],
      enabledChains: [[route('a1')]],
      now: new Date(since + FIFTEEN_MINUTES_MS + 1),
    })

    expect(result.fleetStarved).toBe(false)
    expect(await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))).toEqual([])
  })

  test('resolves an incident when its route disappears', async () => {
    const since = Date.parse('2026-08-17T00:00:00.000Z')
    const records = [record('a1', since)]
    await reconcileProviderHealthRecords({ records, enabledChains: [[route('a1')]], now: new Date(since + 1) })

    await reconcileProviderHealthRecords({ records, enabledChains: [], now: new Date(since + 2) })

    const [incident] = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    expect(incident.resolvedAt).toEqual(new Date(since + 2))
  })

  test('resolves an incident when the configured route no longer has usable credentials', async () => {
    const since = Date.parse('2026-08-17T00:00:00.000Z')
    const records = [record('a1', since)]
    await reconcileProviderHealthRecords({ records, enabledChains: [[route('a1')]], now: new Date(since + 1) })

    await reconcileProviderHealthRecords({
      records,
      enabledChains: [[{ ...route('a1'), credentialUsable: false }]],
      now: new Date(since + 2),
    })

    const [incident] = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    expect(incident.resolvedAt).toEqual(new Date(since + 2))
  })

  test('uses an explicit sentinel for provider-wide incident ownership', async () => {
    const since = Date.parse('2026-08-17T00:00:00.000Z')
    const providerWide: ProviderHealthRecord = {
      provider,
      kind: 'network',
      message: 'Provider network is unavailable.',
      since,
    }

    await reconcileProviderHealthRecords({
      records: [providerWide],
      enabledChains: [[route('a1')]],
      now: new Date(since + 1),
    })

    const [incident] = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    expect(incident.accountId).toBeNull()
    expect(incident.scopeKey).toBe(`provider:${provider}:account:__provider__`)
  })

  test('a genuine later success resolves the stale shared-record incident', async () => {
    const since = Date.parse('2026-08-17T00:00:00.000Z')
    const enabledChains = [[route('a1')]]
    await reconcileProviderHealthRecords({
      records: [record('a1', since)],
      enabledChains,
      now: new Date(since + 1000),
    })

    const recovered = await reconcileProviderHealthRecords({
      records: [{ ...record('a1', since), lastSuccessAt: since + 2000 }],
      enabledChains,
      now: new Date(since + 2000),
    })

    expect(recovered.fleetStarved).toBe(false)
    const [incident] = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    expect(incident.resolvedAt).toEqual(new Date(since + 2000))
    expect(await transitions()).toEqual([])
  })
})
