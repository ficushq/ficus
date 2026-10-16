import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import { githubRelayDeliveries, integrationConnections } from '../../../db/schema'
import {
  getLastGitHubRelayDeliveries,
  githubRelayLivenessRepository,
  recordGitHubRelayDelivery,
} from './relay-deliveries'

test('only PR, review, comment and issue deliveries for the routed repository prove the relay live', () => {
  const delivery = (eventType: string, fullName: unknown = 'Acme/Widgets', resourceKey = 'acme/widgets') => ({
    eventType,
    resourceKey,
    payload: { repository: { full_name: fullName } },
  })
  for (const type of ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment', 'issues'])
    expect(githubRelayLivenessRepository(delivery(type))).toBe('acme/widgets')
  // Dependabot stays webhook-only policy, and CI never stood in for the PR poller.
  expect(githubRelayLivenessRepository(delivery('dependabot_alert'))).toBeNull()
  expect(githubRelayLivenessRepository(delivery('workflow_run'))).toBeNull()
  expect(githubRelayLivenessRepository(delivery('pull_request', 'acme/other'))).toBeNull()
  expect(githubRelayLivenessRepository(delivery('pull_request', null))).toBeNull()
})

test('relay deliveries are recorded per connection and repository, and only move forward', async () => {
  const [a, b] = await db
    .insert(integrationConnections)
    .values(
      ['a', 'b'].map((name) => ({
        providerKey: 'github',
        adapterVersion: 1,
        displayName: `Relay ${name}`,
        configuration: {},
        credentialRef: `relay-test-${crypto.randomUUID()}`,
      }))
    )
    .returning({ id: integrationConnections.id })
  const ids = [a!.id, b!.id]
  try {
    expect(await getLastGitHubRelayDeliveries([{ connectionId: a!.id, repository: 'acme/widgets' }])).toEqual(new Map())
    await recordGitHubRelayDelivery(a!.id, 'Acme/Widgets')
    const [first] = await db.select().from(githubRelayDeliveries).where(eq(githubRelayDeliveries.connectionId, a!.id))
    // A clock running backwards never moves the evidence back.
    await db
      .update(githubRelayDeliveries)
      .set({ deliveredAt: new Date(first!.deliveredAt.getTime() + 60_000) })
      .where(eq(githubRelayDeliveries.connectionId, a!.id))
    await recordGitHubRelayDelivery(a!.id, 'acme/widgets')
    const latest = await getLastGitHubRelayDeliveries([
      { connectionId: a!.id, repository: 'ACME/widgets' },
      { connectionId: b!.id, repository: 'acme/widgets' },
      { connectionId: 'not-a-uuid', repository: 'acme/widgets' },
    ])
    expect([...latest.keys()]).toEqual([`${a!.id}:acme/widgets`])
    expect(latest.get(`${a!.id}:acme/widgets`)!.getTime()).toBe(first!.deliveredAt.getTime() + 60_000)
    // Another connection's deliveries are its own evidence only.
    await recordGitHubRelayDelivery(b!.id, 'acme/widgets')
    expect((await getLastGitHubRelayDeliveries([{ connectionId: b!.id, repository: 'acme/widgets' }])).size).toBe(1)
  } finally {
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, ids))
  }
})
