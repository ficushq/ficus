import { describe, expect, spyOn, test } from 'bun:test'
import { GitHubPollingProvider } from './provider'
import type { EventPollingCapability } from '../types'

describe('GitHubPollingProvider', () => {
  test('exposes event polling with an injected credential resolver', async () => {
    const provider = new GitHubPollingProvider(
      async () => 'squad-token',
      async () => new Response(null, { status: 304 })
    )
    const capability = provider.capabilities.event_polling!
    const connection = {
      id: 'github:s1',
      squadId: 's1',
      providerKey: 'github',
      adapterVersion: 1,
      configuration: { owner: 'acme', repo: 'widgets', number: 42 },
    }

    await capability.poll(connection, {
      etags: { pr: 'p', issue: 'i', issueComments: 'c', reviews: 'r', reviewComments: 'rc' },
      pr: { headSha: 'a', state: 'open', merged: false },
      issue: {},
      pullRequest: { state: 'open', merged: false, head: { sha: 'a' }, base: { repo: { full_name: 'acme/widgets' } } },
      issueComments: {},
      reviews: {},
      reviewComments: {},
    })

    expect(provider.key).toBe('github')
    expect(provider.parseConfig(connection.configuration)).toEqual(connection.configuration)
  })

  test('roundtrips delivery mode and verified webhook metadata without coercion', () => {
    const provider = new GitHubPollingProvider(async () => undefined)
    const resource = { owner: 'acme', repo: 'widgets', number: 7 }
    const lastVerifiedWebhookDeliveryAt = '2026-10-01T21:00:00.000Z'
    for (const deliveryPresentation of [true, false]) {
      const config = { ...resource, deliveryPresentation, lastVerifiedWebhookDeliveryAt }
      expect(provider.parseConfig(config)).toEqual(config)
      expect(provider.parseConfig(provider.parseConfig(config))).toEqual(config)
    }
    for (const deliveryPresentation of [undefined, null, 'true', 'false', 1, 0, {}, []]) {
      expect(provider.parseConfig({ ...resource, deliveryPresentation, lastVerifiedWebhookDeliveryAt })).toEqual({
        ...resource,
        lastVerifiedWebhookDeliveryAt,
      })
    }
  })

  test('rejects malformed resource configurations', () => {
    const provider = new GitHubPollingProvider(async () => undefined)
    expect(() => provider.parseConfig({ owner: '', repo: 'x', number: 0 })).toThrow(
      'Invalid GitHub polling configuration'
    )
  })
})

test('the GitHub plugin/parser retains repository issue polling and emits new assignment outputs', async () => {
  const { createGitHubPlugin } = await import('./plugin')
  const item = (id: number) => ({
    id,
    event: 'assigned',
    created_at: '2026-10-01T00:00:00Z',
    issue: { id: 42, number: 7, title: 'Fix issue', state: 'open', updated_at: '2026-10-01T00:00:00Z' },
    assignee: { login: 'testbot' },
    actor: { login: 'noah' },
  })
  let events = [item(1)]
  const request = spyOn(globalThis, 'fetch').mockImplementation((async (url: any) => {
    expect(String(url)).toContain('/repos/acme/widgets/issues/events')
    return Response.json(events)
  }) as typeof fetch)
  try {
    const plugin = createGitHubPlugin(
      { currentUser: async () => ({ version: 1, userId: 1, login: 'testbot' }) },
      async () => 'token'
    )
    const connection = {
      id: 'account',
      squadId: 'squad',
      providerKey: 'github',
      adapterVersion: 1,
      configuration: { kind: 'issue-events', owner: 'acme', repo: 'widgets' },
    }
    // Runner watches carry resource configs, not account configs; exercise the
    // real plugin/parser through its provider-neutral polling capability.
    const poll = plugin.runtime.provider.capabilities.event_polling! as EventPollingCapability
    const baseline = await poll.poll(connection, null)
    expect(baseline.events).toEqual([])
    events = [item(2), item(1)]
    const next = await poll.poll(connection, baseline.nextCursor)
    expect(next.events).toHaveLength(1)
    expect(plugin.runtime.provider.outputs!.normalize(next.events[0]!)[0]).toMatchObject({
      output: 'issue.assigned',
      data: { repository: 'acme/widgets', assignee: 'testbot' },
    })
  } finally {
    request.mockRestore()
  }
})
