import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db, type integrationOutputEvents } from '../../../db'
import { githubOutputAdapter } from '../outputs/github'
import { gitHubFreshnessBindingSQL, hasGitHubFreshnessBinding } from './feedback-freshness-binding'

test('native binding eligibility agrees between final admission and pure SQL inbox reads', async () => {
  const [fact] = githubOutputAdapter.normalize({
    type: 'pull_request',
    githubObservation: { kind: 'webhook', deliveryId: 'binding-fixture' },
    payload: {
      action: 'opened',
      repository: { id: 10, full_name: 'acme/project' },
      pull_request: {
        id: 20,
        number: 3,
        title: 'Title',
        body: 'Body',
        user: { id: 2, login: 'author', type: 'User' },
        created_at: '2026-10-02T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
      },
    },
  })
  const base: typeof integrationOutputEvents.$inferSelect = {
    id: crypto.randomUUID(),
    integration: 'github',
    sourceKey: 'fixture',
    eventKey: fact!.eventKey,
    fact: fact!,
    authority: { kind: 'connection', squadId: crypto.randomUUID(), connectionId: crypto.randomUUID() },
    createdAt: new Date(),
    triggerSquadIds: [],
    matchedAt: null,
    lastErrorCode: null,
  }
  const cases: Array<[string, (event: typeof base) => void, boolean]> = [
    ['native', () => {}, true],
    [
      'legacy',
      (e) => {
        delete e.fact.github
      },
      false,
    ],
    [
      'missing native ID',
      (e) => {
        e.fact.github!.content!.nativeId = null
      },
      false,
    ],
    [
      'malformed native ID',
      (e) => {
        e.fact.github!.content!.nativeId = 'not-a-native-id'
      },
      false,
    ],
    [
      'missing repository',
      (e) => {
        e.fact.github!.content!.repositoryId = null
      },
      false,
    ],
    [
      'unknown provider clock still has capture sequence',
      (e) => {
        e.fact.github!.content!.providerVersion = null
      },
      true,
    ],
    [
      'unbound action',
      (e) => {
        e.fact.github!.content!.objectKind = 'action'
        e.fact.github!.content!.nativeId = `20-${'a'.repeat(24)}`
      },
      false,
    ],
    [
      'bound action',
      (e) => {
        e.fact.github!.rawParent = structuredClone(e.fact.github!.content!)
        e.fact.github!.content!.objectKind = 'action'
        e.fact.github!.content!.nativeId = `20-${'a'.repeat(24)}`
      },
      true,
    ],
    [
      'canonical identity is not an approval',
      (e) => {
        e.sourceKey = 'github-feedback:fixture'
        e.fact.github = { content: null, status: null, revisionId: crypto.randomUUID() }
      },
      true,
    ],
    [
      'malformed canonical identity',
      (e) => {
        e.sourceKey = 'github-feedback:fixture'
        e.fact.github = { content: null, status: null, revisionId: 'bad' }
      },
      false,
    ],
    [
      'proven status projection',
      (e) => {
        e.sourceKey = 'github-status:fixture'
        delete e.fact.github
      },
      true,
    ],
    [
      'native content-free status',
      (e) => {
        e.fact.github = {
          content: null,
          status: { ...structuredClone(e.fact), data: { repository: 'acme/project', projection: 'status' } },
        }
      },
      true,
    ],
    [
      'a status candidate cannot disguise unbound prose',
      (e) => {
        e.fact.github!.status = {
          ...structuredClone(e.fact),
          data: { repository: 'acme/project', projection: 'status' },
        }
        e.fact.github!.content!.nativeId = null
      },
      false,
    ],
  ]
  for (const [label, change, expected] of cases) {
    const event = structuredClone(base)
    change(event)
    expect(hasGitHubFreshnessBinding(event), label).toBe(expected)
    const [result] = await db.execute<{ bound: boolean }>(
      sql`select ${gitHubFreshnessBindingSQL(sql`${JSON.stringify(event.fact)}::jsonb`, sql`${event.sourceKey}::text`)} as bound`
    )
    expect(result!.bound, label).toBe(expected)
  }
})
