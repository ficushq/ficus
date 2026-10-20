import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { fleetStarved, routeDecision } from '@ficus/shared/provider-health'
import { db, settings } from '../../db'
import { fleetIncidentNotifications, fleetIncidents } from '../../db/schema'
import { getSettingsStore, resetSettingsStore } from '../settings'
import { reconcileProviderHealthRecords } from '../fleet-alerts/provider-health-reconciler'
import { runProbeSweepOnce } from './probe-scheduler'
import { anthropicProbe } from './probes/anthropic'
import { providerHealth, resetProviderHealthForTests } from './registry'

// Exercise the real persistence -> hydration -> probe -> alert boundary. Only
// the outbound model-list HTTP request is mocked; no paid or live probes run.
describe('Anthropic probe recovery after simulated worker restart', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
  const provider = 'anthropic'
  const enabledChains = [[{ provider, accountId: 'a1', credentialUsable: true }]]

  beforeEach(async () => {
    resetProviderHealthForTests()
    resetSettingsStore()
    await db.delete(settings)
    await getSettingsStore().initialize()
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
  })

  afterEach(async () => {
    fetchSpy.mockRestore()
    await providerHealth.flushPersistence()
    resetProviderHealthForTests()
    resetSettingsStore()
    const incidents = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    if (incidents.length) {
      await db.delete(fleetIncidentNotifications).where(
        inArray(
          fleetIncidentNotifications.incidentId,
          incidents.map((i) => i.id)
        )
      )
      await db.delete(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    }
  })

  async function reconcile(now: number) {
    return reconcileProviderHealthRecords({
      records: providerHealth.snapshotRecords(),
      enabledChains,
      now: new Date(now),
    })
  }

  async function incidentsAndTransitions() {
    const incidents = await db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
    const transitions = incidents.length
      ? await db
          .select()
          .from(fleetIncidentNotifications)
          .where(
            inArray(
              fleetIncidentNotifications.incidentId,
              incidents.map((i) => i.id)
            )
          )
      : []
    return { incidents, transitions }
  }

  for (const kind of ['plan-credit', 'rate-limit'] as const) {
    for (const expired of [false, true]) {
      it(`preserves hydrated ${kind} and its alert episode with ${expired ? 'elapsed' : 'future'} retry deadline`, async () => {
        const now = Date.now()
        const since = now - 20 * 60_000
        const retryAt = expired ? now - 1_000 : now + 60 * 60_000
        // Persist an aged episode as an earlier worker would, then restart the
        // singleton and settings cache before running the real scheduler.
        await getSettingsStore().set(
          'PROVIDER_HEALTH_STATE',
          JSON.stringify({
            version: 1,
            records: [{ provider, accountId: 'a1', kind, message: 'Provider unavailable.', since, retryAt }],
            revisions: { 'anthropic::a1': 7 },
          }),
          'admin'
        )
        await providerHealth.hydrateFromPersistence()
        await reconcile(now)
        const before = await incidentsAndTransitions()
        expect(before.incidents).toHaveLength(1)
        expect(before.transitions.map((t) => t.kind)).toEqual(['alert'])
        // Recovery notices are owed only after an alert was actually delivered.
        // Seed that boundary without sending any external notification.
        await db
          .update(fleetIncidentNotifications)
          .set({ status: 'delivered', deliveredAt: new Date(now) })
          .where(eq(fleetIncidentNotifications.id, before.transitions[0]!.id))

        resetProviderHealthForTests()
        resetSettingsStore()
        await getSettingsStore().initialize()
        providerHealth.enablePersistence()
        await providerHealth.hydrateFromPersistence()
        const original = providerHealth.snapshotRecords()
        const persistedBeforeProbe = getSettingsStore().get('PROVIDER_HEALTH_STATE')
        const generationAttempt = providerHealth.captureAttempt(provider, 'a1')
        expect(generationAttempt.revision).toBe(7)

        for (let sweep = 0; sweep < 2; sweep++) {
          await runProbeSweepOnce({
            getAccounts: () => [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'test-key' } }],
            getProviders: () => [provider],
            getApiKey: async () => 'test-key',
            getProbe: () => anthropicProbe,
          })
          await reconcile(now + sweep + 1)
        }

        await providerHealth.flushPersistence()
        expect(getSettingsStore().get('PROVIDER_HEALTH_STATE')).toBe(persistedBeforeProbe)
        expect(providerHealth.snapshotRecords()).toEqual(original)
        expect(providerHealth.getRecord(provider, 'a1')).toMatchObject({ since, retryAt })
        expect(providerHealth.captureAttempt(provider, 'a1')).toEqual(generationAttempt)
        expect(fleetStarved(enabledChains, providerHealth.snapshotRecords())).toBe(true)
        expect(routeDecision(enabledChains[0]![0]!, providerHealth.snapshotRecords(), now)).toEqual(
          expired ? { state: 'ready' } : { state: 'cooldown', retryAt }
        )
        const afterProbe = await incidentsAndTransitions()
        expect(afterProbe.incidents.map((i) => ({ id: i.id, resolvedAt: i.resolvedAt }))).toEqual([
          { id: before.incidents[0]!.id, resolvedAt: null },
        ])
        expect(afterProbe.transitions.map((t) => t.kind)).toEqual(['alert'])

        // Another generation failure is still the same episode, not a recovery
        // and fresh exhaustion pair (the erroneous probe used to split it).
        providerHealth.recordFailure(generationAttempt, { kind, retryAt })
        await reconcile(now + 3)
        expect((await incidentsAndTransitions()).transitions.map((t) => t.kind)).toEqual(['alert'])
        expect(providerHealth.getRecord(provider, 'a1')?.since).toBe(since)

        // Real generation success still recovers the account and yields exactly
        // one recovery notification for the original incident.
        expect(providerHealth.recordSuccess(providerHealth.captureAttempt(provider, 'a1'))).toBe(true)
        await reconcile(now + 4)
        const recovered = await incidentsAndTransitions()
        expect(recovered.incidents).toHaveLength(1)
        expect(recovered.incidents[0]?.resolvedAt).toEqual(new Date(now + 4))
        expect(recovered.transitions.map((t) => t.kind).sort()).toEqual(['alert', 'recovery'])
        expect(fleetStarved(enabledChains, providerHealth.snapshotRecords())).toBe(false)
      })
    }
  }
})
