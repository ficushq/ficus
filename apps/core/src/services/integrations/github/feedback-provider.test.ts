import { expect, test } from 'bun:test'
import type { IntegrationOutputFact } from '@ficus/shared'
import type { VerifiedIngressEvent } from '../types'
import { githubOutputAdapter } from '../outputs/github'
import * as provider from './feedback-provider'

const squadId = crypto.randomUUID(),
  connectionId = crypto.randomUUID()
const authority = { kind: 'connection' as const, squadId, connectionId }
const time = '2026-10-02T10:00:00Z'
const native = {
  id: 9,
  user: { id: 2, login: 'outside', type: 'User' },
  body: 'EXACT',
  html_url: 'https://github.com/acme/project/pull/3#pullrequestreview-9',
  submitted_at: time,
  state: 'commented',
}
const input: VerifiedIngressEvent = {
  type: 'pull_request_review',
  githubObservation: { kind: 'webhook' },
  payload: {
    action: 'submitted',
    repository: { id: 10, full_name: 'acme/project' },
    pull_request: { id: 100, number: 3, updated_at: time },
    review: native,
  },
}
const source = (fact: IntegrationOutputFact) => ({ authority, fact })

test('repository identity enrichment uses assigned access and never guesses a missing numeric ID', async () => {
  expect(provider.resolveGitHubFeedbackRepository).toBeDefined()
  const event = { ...input, payload: { ...(input.payload as any), repository: { full_name: 'acme/project' } } }
  const calls: unknown[] = []
  const resolved = await provider.resolveGitHubFeedbackRepository(event, authority, async (...args) => {
    calls.push(args)
    return { id: 10, full_name: 'Acme/Project' }
  })
  expect(calls).toEqual([['/repos/acme/project', squadId, connectionId]])
  expect(githubOutputAdapter.normalize(resolved)[0]!.github!.content!.repositoryId).toBe('10')
  for (const repo of [null, { id: '10', full_name: 'acme/project' }, { id: 10, full_name: 'wrong/repo' }]) {
    expect(
      githubOutputAdapter.normalize(
        await provider.resolveGitHubFeedbackRepository(event, authority, async () => repo)
      )[0]!.github!.content!.repositoryId
    ).toBeNull()
  }
  expect(
    await provider.resolveGitHubFeedbackRepository(event, { kind: 'instance' }, async () => {
      throw new Error('Must not fetch')
    })
  ).toEqual(event)
})

test('authenticated current review read verifies exact ID, owner, resource, state and full body without upgrading editor proof', async () => {
  expect(provider.readCurrentGitHubFeedback).toBeDefined()
  const fact = githubOutputAdapter.normalize(input)[0]!,
    content = fact.github!.content!
  const calls: unknown[] = []
  const get = async (...args: unknown[]) => {
    calls.push(args)
    return String(args[0]).startsWith('/repositories/') ? { id: 10, full_name: 'acme/project' } : native
  }
  expect(await provider.readCurrentGitHubFeedback(source(fact), content, get)).toEqual({
    contentHash: content.contentHash,
  })
  expect(calls).toEqual([
    ['/repositories/10', squadId, connectionId],
    ['/repos/acme/project/pulls/3/reviews/9', squadId, connectionId],
  ])
  for (const changed of [
    { ...native, body: 'UNSEEN' },
    { ...native, id: 99 },
    { ...native, user: { ...native.user, id: 3 } },
    { ...native, state: 'dismissed' },
    null,
  ]) {
    expect(
      await provider.readCurrentGitHubFeedback(source(fact), content, async (path) =>
        path.startsWith('/repositories/') ? { id: 10, full_name: 'acme/project' } : changed
      )
    ).toBeNull()
  }
  expect(content.attribution).toBe('creation')
})

test('unknown native identity, repo mismatch and vanished provider object cannot certify freshness', async () => {
  const fact = githubOutputAdapter.normalize(input)[0]!,
    content = fact.github!.content!
  expect(
    await provider.readCurrentGitHubFeedback(source(fact), { ...content, nativeId: null }, async () => {
      throw new Error('Must not fetch')
    })
  ).toBeNull()
  expect(
    await provider.readCurrentGitHubFeedback(source(fact), content, async () => ({ id: 20, full_name: 'wrong/repo' }))
  ).toBeNull()
  expect(
    await provider.readCurrentGitHubFeedback(source(fact), content, async () => {
      throw new Error('Provider unavailable')
    })
  ).toBeNull()
})

test('current object ID alone cannot certify a different parent resource', async () => {
  const fact = githubOutputAdapter.normalize(input)[0]!,
    content = fact.github!.content!
  expect(
    await provider.readCurrentGitHubFeedback(source(fact), content, async (path) =>
      path.startsWith('/repositories/')
        ? { id: 10, full_name: 'acme/project' }
        : { ...native, html_url: 'https://github.com/acme/project/pull/4#pullrequestreview-9' }
    )
  ).toBeNull()
})
