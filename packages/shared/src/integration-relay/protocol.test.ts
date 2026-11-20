import { expect, test } from 'bun:test'
import {
  githubRepositoryKey,
  relaySubscribeRequest,
  relayAckRequest,
  relayPullRequest,
  INSTANCE_INTEGRATION_SCOPES,
  slackTeamId,
  slackRelaySubscribeRequest,
  slackRelayPullRequest,
  slackRelayDelivery,
  slackRelayPullResponse,
  SLACK_RELAY_EVENT_TYPES,
  RELAY_PROVIDER_KEYS,
  LINEAR_RELAY_CODES,
  LINEAR_RELAY_EVENT_TYPES,
  linearOrganizationId,
  linearRelayDelivery,
  linearRelayPullRequest,
  linearRelayPullResponse,
  linearRelaySubscribeRequest,
} from './protocol'

test('relay subscriptions accept exact normalized repositories and reject authority/callback injection', () => {
  const body = {
    connectionId: crypto.randomUUID(),
    connectionRevision: crypto.randomUUID(),
    accessToken: 'token',
    repositories: ['ficushq/Ficus'],
  }
  expect(relaySubscribeRequest.parse(body).repositories).toEqual(['ficushq/ficus'])
  for (const extra of [{ tenantId: crypto.randomUUID() }, { callbackUrl: 'https://other.test' }])
    expect(relaySubscribeRequest.safeParse({ ...body, ...extra }).success).toBe(false)
  for (const key of ['../private', 'owner/..', 'owner/*', 'owner/repo?token=secret', 'https://github.com/a/b'])
    expect(githubRepositoryKey.safeParse(key).success).toBe(false)
  expect(relaySubscribeRequest.safeParse({ ...body, repositories: Array(101).fill('a/b') }).success).toBe(false)
  expect(INSTANCE_INTEGRATION_SCOPES).toContain('integrations.events:consume')
})
test('acknowledgments require a delivery lease and connection revision', () => {
  expect(
    relayAckRequest.safeParse({ connectionId: crypto.randomUUID(), deliveries: [{ id: crypto.randomUUID() }] }).success
  ).toBe(false)
})

test('RELAY_PROVIDER_KEYS lists the supported relay providers', () => {
  expect(RELAY_PROVIDER_KEYS).toEqual(['github', 'slack', 'linear'])
})

test('slackTeamId accepts real team ids and rejects malformed/injected values', () => {
  expect(slackTeamId.safeParse('T1234567890').success).toBe(true)
  expect(slackTeamId.safeParse('T0123ABCDEFGHIJKLMNOPQRSTU').success).toBe(true)
  for (const bad of ['t1234567890', 'U1234567890', 'T1', 'T' + 'A'.repeat(40), '../T1234567890', 'T12345 67890', ''])
    expect(slackTeamId.safeParse(bad).success).toBe(false)
})

test('slack subscribe requests carry only a connection and access token, not a resource list', () => {
  const body = { connectionId: crypto.randomUUID(), connectionRevision: crypto.randomUUID(), accessToken: 'xoxb-token' }
  expect(slackRelaySubscribeRequest.safeParse(body).success).toBe(true)
  expect(slackRelaySubscribeRequest.safeParse({ ...body, teamId: 'T1234567890' }).success).toBe(false)
  expect(slackRelaySubscribeRequest.safeParse({ ...body, repositories: ['a/b'] }).success).toBe(false)
})

test('slack pull requests reuse the GitHub pull request shape', () => {
  expect(slackRelayPullRequest).toBe(relayPullRequest)
})

test('slack deliveries accept documented event types keyed by team id, and reject unknown types/keys', () => {
  const base = {
    id: crypto.randomUUID(),
    leaseToken: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    connectionRevision: crypto.randomUUID(),
    deliveryId: 'Ev0123ABCD',
    resourceId: 'T1234567890',
    resourceKey: 'T1234567890',
    payload: { type: 'event_callback' },
  }
  for (const eventType of SLACK_RELAY_EVENT_TYPES) {
    expect(slackRelayDelivery.safeParse({ ...base, eventType }).success).toBe(true)
  }
  expect(SLACK_RELAY_EVENT_TYPES).toEqual(['event_callback', 'slash_command', 'app_uninstalled', 'tokens_revoked'])
  expect(slackRelayDelivery.safeParse({ ...base, eventType: 'reaction_added' }).success).toBe(false)
  expect(slackRelayDelivery.safeParse({ ...base, eventType: 'event_callback', resourceId: 'not-a-team' }).success).toBe(
    false
  )
  expect(slackRelayDelivery.safeParse({ ...base, eventType: 'event_callback', extra: true }).success).toBe(false)
  expect(slackRelayDelivery.safeParse({ ...base, eventType: 'event_callback', deliveryId: '' }).success).toBe(false)
  expect(slackRelayPullResponse.safeParse({ deliveries: [{ ...base, eventType: 'event_callback' }] }).success).toBe(
    true
  )
  expect(
    slackRelayPullResponse.safeParse({ deliveries: Array(11).fill({ ...base, eventType: 'event_callback' }) }).success
  ).toBe(false)
})

test('linear organization ids are UUIDs and reject malformed or injected values', () => {
  expect(linearOrganizationId.safeParse(crypto.randomUUID()).success).toBe(true)
  for (const bad of ['acme', '', '../' + crypto.randomUUID(), `${crypto.randomUUID()}?x=1`, 'T1234567890'])
    expect(linearOrganizationId.safeParse(bad).success).toBe(false)
})

test('linear subscribe requests carry only a connection and access token, never a claimed organization', () => {
  const body = { connectionId: crypto.randomUUID(), connectionRevision: crypto.randomUUID(), accessToken: 'token' }
  expect(linearRelaySubscribeRequest.safeParse(body).success).toBe(true)
  for (const extra of [
    { organizationId: crypto.randomUUID() },
    { appUserId: crypto.randomUUID() },
    { repositories: ['a/b'] },
    { callbackUrl: 'https://other.test' },
  ])
    expect(linearRelaySubscribeRequest.safeParse({ ...body, ...extra }).success).toBe(false)
  expect(linearRelaySubscribeRequest.safeParse({ ...body, accessToken: '' }).success).toBe(false)
  expect(linearRelaySubscribeRequest.safeParse({ ...body, connectionId: 'not-a-uuid' }).success).toBe(false)
})

test('linear pull requests reuse the GitHub pull request shape', () => {
  expect(linearRelayPullRequest).toBe(relayPullRequest)
})

test('linear relay codes are the safe codes Platform answers', () => {
  expect(LINEAR_RELAY_CODES).toEqual({
    organizationClaimed: 'linear_organization_claimed',
    authorizationRequired: 'linear_authorization_required',
  })
})

test('linear deliveries accept the relayed app webhook categories keyed by organization id', () => {
  const organizationId = crypto.randomUUID()
  const base = {
    id: crypto.randomUUID(),
    leaseToken: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    connectionRevision: crypto.randomUUID(),
    deliveryId: crypto.randomUUID(),
    resourceId: organizationId,
    resourceKey: organizationId,
    payload: { type: 'AgentSessionEvent', organizationId },
  }
  expect(LINEAR_RELAY_EVENT_TYPES).toEqual([
    'AgentSessionEvent',
    'AppUserNotification',
    'PermissionChange',
    'OAuthApp',
    'Issue',
    'Comment',
  ])
  for (const eventType of LINEAR_RELAY_EVENT_TYPES)
    expect(linearRelayDelivery.safeParse({ ...base, eventType }).success).toBe(true)
  const valid = { ...base, eventType: 'AgentSessionEvent' }
  for (const eventType of ['Project', 'IssueLabel', 'agentSessionEvent', 'event_callback', ''])
    expect(linearRelayDelivery.safeParse({ ...base, eventType }).success).toBe(false)
  expect(linearRelayDelivery.safeParse({ ...valid, resourceId: 'T1234567890' }).success).toBe(false)
  expect(linearRelayDelivery.safeParse({ ...valid, resourceKey: 'acme' }).success).toBe(false)
  expect(linearRelayDelivery.safeParse({ ...valid, deliveryId: '' }).success).toBe(false)
  expect(linearRelayDelivery.safeParse({ ...valid, extra: true }).success).toBe(false)
  expect(linearRelayPullResponse.safeParse({ deliveries: [valid] }).success).toBe(true)
  expect(linearRelayPullResponse.safeParse({ deliveries: Array(11).fill(valid) }).success).toBe(false)
})
