import { describe, expect, test } from 'bun:test'
import { GitHubPollingProvider } from './provider'

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
