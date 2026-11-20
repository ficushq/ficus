import { describe, expect, test } from 'bun:test'
import { HostedIntegrationRelayRunner } from './runner'
import { githubRelayProvider } from './runtime'
import { slackRelayProvider, type SlackRelayInterest } from './slack-runtime'
import { PlatformRequestError, type platformRequest } from '../../platform/instance-client'
import { linearRelayProvider, type LinearRelayInterest } from './linear-runtime'
import type { LinearRelayDelivery, RelayDelivery, SlackRelayDelivery } from '@ficus/shared/integration-relay'

function fixture(options: { prepare?: (deliveries: RelayDelivery[]) => Promise<void> } = {}) {
  const id = crypto.randomUUID(),
    revision = crypto.randomUUID()
  const state = {
    now: 0,
    managed: true,
    enabled: true,
    available: true,
    revision,
    token: 'current-token',
    interests: [{ connectionId: id, squadId: 's1', repository: 'org/repo' }],
    remote: [] as { connectionId: string; connectionRevision: string }[],
    deliveries: [] as RelayDelivery[],
    calls: [] as { path: string; body: any }[],
    dispatched: [] as string[],
    errors: [] as string[],
    failAck: false,
    failDispatch: false,
    duringPull: () => {},
  }
  const delivery: RelayDelivery = {
    id: crypto.randomUUID(),
    leaseToken: crypto.randomUUID(),
    connectionId: id,
    connectionRevision: revision,
    deliveryId: crypto.randomUUID(),
    resourceId: '12',
    resourceKey: 'org/repo',
    eventType: 'issues',
    payload: {},
  }
  const request: typeof platformRequest = async (input) => {
    state.calls.push({ path: input.path.split('/').at(-1)!, body: input.body })
    const path = state.calls.at(-1)!.path
    if (path === 'status') return input.schema.parse({ enabled: state.enabled, connections: state.remote })
    if (path === 'pull') {
      state.duringPull()
      return input.schema.parse({ deliveries: state.deliveries })
    }
    if (path === 'ack' && state.failAck) throw new PlatformRequestError('broker_unavailable', true)
    return input.schema.parse({ ok: true })
  }
  const runner = new HostedIntegrationRelayRunner(githubRelayProvider, {
    managed: () => state.managed,
    interests: async () => state.interests,
    resolve: async (connectionId) =>
      state.available ? { id: connectionId, revision: state.revision, accessToken: state.token } : undefined,
    request,
    dispatch: async (event, interests) => {
      if (state.failDispatch) throw new Error('relay_authorization_unavailable')
      state.dispatched.push(...interests.map((interest) => `${event.id}:${interest.squadId}`))
    },
    ...(options.prepare ? { prepare: options.prepare } : {}),
    now: () => state.now,
    onError: (code) => state.errors.push(code),
  })
  return { state, runner, delivery, id }
}

/** Slack-flavored counterpart of `fixture()`, exercising the same runner mechanics through `slackRelayProvider`. */
function slackFixture() {
  const id = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    teamId = 'T12345678'
  const state = {
    now: 0,
    managed: true,
    enabled: true,
    available: true,
    revision,
    token: 'current-token',
    interests: [{ connectionId: id, teamId }] satisfies SlackRelayInterest[],
    remote: [] as { connectionId: string; connectionRevision: string }[],
    deliveries: [] as SlackRelayDelivery[],
    calls: [] as { path: string; fullPath: string; body: any }[],
    dispatched: [] as string[],
    errors: [] as string[],
    statusStatus: 200 as number,
  }
  const delivery: SlackRelayDelivery = {
    id: crypto.randomUUID(),
    leaseToken: crypto.randomUUID(),
    connectionId: id,
    connectionRevision: revision,
    deliveryId: crypto.randomUUID(),
    resourceId: teamId,
    resourceKey: teamId,
    eventType: 'event_callback',
    payload: {},
  }
  const request: typeof platformRequest = async (input) => {
    const path = input.path.split('/').at(-1)!
    state.calls.push({ path, fullPath: input.path, body: input.body })
    if (path === 'status') {
      if (state.statusStatus === 404) throw new PlatformRequestError('invalid_response', false, 404)
      return input.schema.parse({ enabled: state.enabled, connections: state.remote })
    }
    if (path === 'pull') return input.schema.parse({ deliveries: state.deliveries })
    return input.schema.parse({ ok: true })
  }
  const runner = new HostedIntegrationRelayRunner(slackRelayProvider, {
    managed: () => state.managed,
    interests: async () => state.interests,
    resolve: async (connectionId) =>
      state.available ? { id: connectionId, revision: state.revision, accessToken: state.token } : undefined,
    request,
    dispatch: async (event, interests) => {
      state.dispatched.push(...interests.map((interest) => `${event.id}:${interest.connectionId}`))
    },
    now: () => state.now,
    onError: (code) => state.errors.push(code),
  })
  return { state, runner, delivery, id }
}
describe('managed relay consumer', () => {
  test('self-hosted and an unconfigured Platform do no subscription or delivery work', async () => {
    const { state, runner } = fixture()
    state.managed = false
    runner.start()
    await runner.tick()
    expect(state.calls).toEqual([])
    state.managed = true
    state.enabled = false
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['status'])
    await runner.stop()
  })
  test('subscribes automatically, renews on metadata/revision change, and sends refreshed tokens', async () => {
    const { state, runner } = fixture()
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['status', 'subscribe', 'pull'])
    state.calls = []
    state.now += 5_000
    state.token = 'rotated'
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['pull'])
    expect(state.calls[0]!.body.accessToken).toBe('rotated')
    state.interests[0]!.repository = 'org/other'
    await runner.tick()
    expect(state.calls.at(-2)!.body.repositories).toEqual(['org/other'])
    state.revision = crypto.randomUUID()
    await runner.tick()
    expect(state.calls.at(-2)!.body.connectionRevision).toBe(state.revision)
    state.calls = []
    state.now += 300_000
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toContain('subscribe')
  })
  test('only current connection/squad/repository interests receive a delivery', async () => {
    const { state, runner, delivery } = fixture()
    state.deliveries = [delivery]
    state.interests.push({ ...state.interests[0]!, squadId: 's2' })
    await runner.tick()
    expect(state.dispatched).toEqual([`${delivery.id}:s1`, `${delivery.id}:s2`])
    expect(state.calls.at(-1)!.path).toBe('ack')
  })
  test('prepare sees the whole current batch before any delivery is dispatched; its failure does not stop dispatch', async () => {
    const order: string[] = []
    let fail = false
    const { state, runner, delivery } = fixture({
      prepare: async (deliveries) => {
        order.push(`prepare:${deliveries.map((item) => item.id).join(',')}`)
        if (fail) throw new Error('slow provider')
      },
    })
    const second = { ...delivery, id: crypto.randomUUID(), leaseToken: crypto.randomUUID() }
    const stale = { ...delivery, id: crypto.randomUUID(), connectionRevision: crypto.randomUUID() }
    state.deliveries = [delivery, second]
    const dispatched = state.dispatched
    dispatched.push = (...items: string[]) => (order.push(...items), Array.prototype.push.apply(dispatched, items))
    await runner.tick()
    expect(order).toEqual([`prepare:${delivery.id},${second.id}`, `${delivery.id}:s1`, `${second.id}:s1`])
    // A delivery for another revision is never prepared (dispatch then rejects the batch as before).
    order.length = 0
    state.deliveries = [stale]
    await runner.tick()
    expect(order).toEqual([])
    order.length = 0
    fail = true
    state.now += 120_000
    state.deliveries = [delivery]
    await runner.tick()
    expect(order).toEqual([`prepare:${delivery.id}`, `${delivery.id}:s1`])
    expect(state.calls.at(-1)!.path).toBe('ack')
  })
  test('detach or reconnect during the HTTP request cannot dispatch old content', async () => {
    for (const mode of ['detach', 'revision', 'interest']) {
      const { state, runner, delivery } = fixture()
      state.deliveries = [delivery]
      state.duringPull = () => {
        if (mode === 'detach') state.available = false
        else if (mode === 'revision') state.revision = crypto.randomUUID()
        else state.interests = []
      }
      await runner.tick()
      expect(state.dispatched).toEqual([])
    }
  })
  test('lost acknowledgments remain retryable and stale response authority is rejected', async () => {
    const { state, runner, delivery } = fixture()
    state.deliveries = [delivery]
    state.failAck = true
    await runner.tick()
    expect(state.errors).toEqual(['broker_unavailable'])
    state.calls = []
    state.now += 5_000
    await runner.tick()
    expect(state.calls).toEqual([])
    state.now += 120_000
    state.failAck = false
    await runner.tick()
    expect(state.calls.at(-1)!.path).toBe('ack')
    state.deliveries = [{ ...delivery, connectionRevision: crypto.randomUUID() }]
    await runner.tick()
    expect(state.errors.at(-1)).toBe('invalid_response')
  })
  test('failed dispatch leaves a pulled event unacknowledged until authorization recovers', async () => {
    const { state, runner, delivery } = fixture()
    state.deliveries = [delivery]
    state.failDispatch = true
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['status', 'subscribe', 'pull'])
    expect(state.dispatched).toEqual([])
    expect(state.errors).toEqual(['relay_unavailable'])
    state.failDispatch = false
    state.now += 120_000
    await runner.tick()
    expect(state.dispatched).toEqual([`${delivery.id}:s1`])
    expect(state.calls.at(-1)!.path).toBe('ack')
  })
  test('restart discovers orphan subscriptions, and bounded round-robin does not starve connections', async () => {
    const { state, runner } = fixture()
    state.remote = [{ connectionId: crypto.randomUUID(), connectionRevision: crypto.randomUUID() }]
    state.interests = Array.from({ length: 6 }, () => ({
      connectionId: crypto.randomUUID(),
      squadId: 's1',
      repository: 'org/repo',
    }))
    await runner.tick()
    expect(state.calls.some((call) => call.path === 'unsubscribe')).toBe(true)
    expect(state.calls.filter((call) => call.path === 'pull')).toHaveLength(4)
    await runner.tick()
    expect(new Set(state.calls.filter((call) => call.path === 'pull').map((call) => call.body.connectionId)).size).toBe(
      6
    )
  })
  test('stop aborts in-flight transport and waits for the owned scan', async () => {
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    let aborted = false
    const runner = new HostedIntegrationRelayRunner(githubRelayProvider, {
      managed: () => true,
      interests: async () => [],
      resolve: async () => undefined,
      request: async (input) => {
        ready()
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true }
          )
        )
        throw new Error('aborted')
      },
      dispatch: async () => {},
      onError: () => {
        throw new Error('shutdown must not report error')
      },
    })
    runner.start()
    await started
    await runner.stop()
    expect(aborted).toBe(true)
  })
})

describe('managed relay consumer — Slack provider', () => {
  test('requests use the slack route segment and a repository-free subscribe body', async () => {
    const { state, runner, id } = slackFixture()
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['status', 'subscribe', 'pull'])
    const subscribe = state.calls.find((call) => call.path === 'subscribe')!
    expect(subscribe.fullPath).toBe('/api/integration-relay/slack/subscribe')
    expect(subscribe.body).toEqual({
      connectionId: id,
      connectionRevision: state.revision,
      accessToken: state.token,
    })
    expect(subscribe.body.repositories).toBeUndefined()
  })
  test('a delivery is dispatched only to the interest for its team', async () => {
    const { state, runner, delivery } = slackFixture()
    state.deliveries = [delivery]
    await runner.tick()
    expect(state.dispatched).toEqual([`${delivery.id}:${delivery.connectionId}`])
    expect(state.calls.at(-1)!.path).toBe('ack')
  })
  test('a delivery for a different team than the declared interest is never dispatched', async () => {
    const { state, runner, delivery } = slackFixture()
    state.deliveries = [{ ...delivery, resourceId: 'T99999999', resourceKey: 'T99999999' }]
    await runner.tick()
    expect(state.dispatched).toEqual([])
    // Still acknowledged: an unmatched-but-otherwise-valid delivery must not be redelivered forever.
    expect(state.calls.at(-1)!.path).toBe('ack')
  })
  test('an older Platform with no Slack relay route backs off quietly instead of crashing or tight-looping', async () => {
    const { state, runner } = slackFixture()
    state.statusStatus = 404
    await runner.tick()
    expect(state.calls.map((call) => call.path)).toEqual(['status'])
    expect(state.errors).toEqual(['invalid_response'])
    state.calls = []
    state.errors = []
    // Immediately ticking again must not re-hit `status`: the failed check already backed off.
    await runner.tick()
    expect(state.calls).toEqual([])
    expect(state.errors).toEqual([])
  })
})

/** Linear-flavored fake Platform: subscribe and pull can answer the Linear relay's safe codes. */
function linearFixture() {
  const id = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    organizationId = crypto.randomUUID()
  const state = {
    now: 0,
    revision,
    token: 'token-1',
    tokenRevision: 1,
    interests: [{ connectionId: id, organizationId }] satisfies LinearRelayInterest[],
    deliveries: [] as LinearRelayDelivery[],
    calls: [] as { path: string; fullPath: string; body: any }[],
    dispatched: [] as string[],
    errors: [] as string[],
    rejected: [] as { connectionId: string; connectionRevision: string; code: string }[],
    /** Platform's view: the token proven at the last subscribe, and whether another tenant holds the workspace. */
    subscribedToken: undefined as string | undefined,
    claimedElsewhere: false,
  }
  const delivery = (overrides: Partial<LinearRelayDelivery> = {}): LinearRelayDelivery => ({
    id: crypto.randomUUID(),
    leaseToken: crypto.randomUUID(),
    connectionId: id,
    connectionRevision: state.revision,
    deliveryId: crypto.randomUUID(),
    resourceId: organizationId,
    resourceKey: organizationId,
    eventType: 'AgentSessionEvent',
    payload: { type: 'AgentSessionEvent', organizationId },
    ...overrides,
  })
  const request: typeof platformRequest = async (input) => {
    const path = input.path.split('/').at(-1)!
    const body = input.body as any
    state.calls.push({ path, fullPath: input.path, body })
    if (path === 'status') return input.schema.parse({ enabled: true, connections: [] })
    if (path === 'subscribe') {
      if (state.claimedElsewhere) throw new PlatformRequestError('linear_organization_claimed', false, 409)
      state.subscribedToken = body.accessToken
      return input.schema.parse({ ok: true })
    }
    if (path === 'pull') {
      if (body.accessToken !== state.subscribedToken)
        throw new PlatformRequestError('linear_authorization_required', false, 422)
      const deliveries = state.deliveries
      state.deliveries = []
      return input.schema.parse({ deliveries })
    }
    return input.schema.parse({ ok: true })
  }
  const runner = new HostedIntegrationRelayRunner(linearRelayProvider, {
    managed: () => true,
    interests: async () => state.interests,
    resolve: async (connectionId) => ({
      id: connectionId,
      revision: state.revision,
      accessToken: state.token,
      credentialRevision: state.tokenRevision,
    }),
    request,
    dispatch: async (event, interests) => {
      state.dispatched.push(...interests.map((interest) => `${event.deliveryId}:${interest.organizationId}`))
    },
    onSubscribeRejected: async (rejection) => {
      state.rejected.push(rejection)
    },
    now: () => state.now,
    onError: (code) => state.errors.push(code),
  })
  const paths = () => state.calls.map((call) => call.path)
  return { state, runner, delivery, id, organizationId, paths }
}

describe('hosted Linear relay (fake Platform)', () => {
  test('pulls every 2 seconds under /linear and subscribes with only the connection and token', async () => {
    expect(linearRelayProvider.intervalMs).toBe(2_000)
    const { state, runner, paths } = linearFixture()
    await runner.tick()
    expect(paths()).toEqual(['status', 'subscribe', 'pull'])
    expect(state.calls.every((call) => call.fullPath.startsWith('/api/integration-relay/linear/'))).toBe(true)
    expect(state.calls[1]!.body).toEqual({
      connectionId: state.interests[0]!.connectionId,
      connectionRevision: state.revision,
      accessToken: 'token-1',
    })
    state.calls = []
    state.now += 2_000
    await runner.tick()
    expect(paths()).toEqual(['pull'])
  })

  test('dispatches deliveries for the connection workspace and acknowledges every pulled delivery', async () => {
    const { state, runner, delivery, organizationId } = linearFixture()
    const ours = delivery()
    const otherWorkspace = delivery({ resourceId: crypto.randomUUID(), resourceKey: crypto.randomUUID() })
    state.deliveries = [ours, otherWorkspace]
    await runner.tick()
    expect(state.dispatched).toEqual([`${ours.deliveryId}:${organizationId}`])
    const ack = state.calls.at(-1)!
    expect(ack.path).toBe('ack')
    expect(ack.body.deliveries.map((entry: { id: string }) => entry.id)).toEqual([ours.id, otherWorkspace.id])
  })

  test('re-subscribes with the new token after a rotation, before pulling', async () => {
    const { state, runner, paths } = linearFixture()
    await runner.tick()
    state.calls = []
    state.now += 2_000
    // An OAuth refresh rotates the token without a new connection revision.
    state.token = 'token-2'
    state.tokenRevision = 2
    await runner.tick()
    expect(paths()).toEqual(['subscribe', 'pull'])
    expect(state.calls[0]!.body.accessToken).toBe('token-2')
    expect(state.calls[0]!.body.connectionRevision).toBe(state.revision)
    expect(state.errors).toEqual([])
  })

  test('a linear_authorization_required pull answer re-subscribes at once and pulls again in the same pass', async () => {
    const { state, runner, paths, delivery } = linearFixture()
    await runner.tick()
    // Platform lost or replaced the subscribed token hash without Core noticing a rotation.
    state.subscribedToken = 'something-else'
    state.deliveries = [delivery()]
    state.calls = []
    state.now += 2_000
    await runner.tick()
    expect(paths()).toEqual(['pull', 'subscribe', 'pull', 'ack'])
    expect(state.dispatched).toHaveLength(1)
    expect(state.errors).toEqual([])
  })

  test('a second linear_authorization_required in a row backs off instead of looping', async () => {
    const { state, runner, paths } = linearFixture()
    await runner.tick()
    const request = (runner as any).deps.request as typeof platformRequest
    ;(runner as any).deps.request = async (input: Parameters<typeof platformRequest>[0]) => {
      if (input.path.endsWith('/pull')) {
        state.calls.push({ path: 'pull', fullPath: input.path, body: input.body })
        throw new PlatformRequestError('linear_authorization_required', false, 422)
      }
      return request(input)
    }
    state.calls = []
    state.now += 2_000
    await runner.tick()
    expect(paths()).toEqual(['pull', 'subscribe', 'pull'])
    expect(state.errors).toEqual(['linear_authorization_required'])
    state.calls = []
    state.now += 2_000
    await runner.tick()
    expect(paths()).toEqual([])
  })

  test('409 linear_organization_claimed parks that connection revision: no pull, no retries, recorded once', async () => {
    const { state, runner, paths, id } = linearFixture()
    state.claimedElsewhere = true
    await runner.tick()
    expect(paths()).toEqual(['status', 'subscribe'])
    expect(state.rejected).toEqual([
      { connectionId: id, connectionRevision: state.revision, code: 'linear_organization_claimed' },
    ])
    expect(state.errors).toEqual(['linear_organization_claimed'])
    for (const step of [2_000, 60_000, 300_000, 3_600_000]) {
      state.calls = []
      state.now += step
      // A token rotation of the same revision does not retry either.
      state.token = `token-${step}`
      state.tokenRevision += 1
      await runner.tick()
      expect(paths()).toEqual(step === 300_000 || step === 3_600_000 ? ['status'] : [])
    }
    expect(state.rejected).toHaveLength(1)
    // A reconnect (new material revision) subscribes again, and succeeds once the other instance lets go.
    state.claimedElsewhere = false
    state.revision = crypto.randomUUID()
    state.calls = []
    state.now += 2_000
    await runner.tick()
    expect(paths()).toEqual(['subscribe', 'pull'])
  })

  test('other subscribe failures keep retrying after the normal backoff', async () => {
    const { state, runner, paths } = linearFixture()
    const request = (runner as any).deps.request as typeof platformRequest
    let failures = 1
    ;(runner as any).deps.request = async (input: Parameters<typeof platformRequest>[0]) => {
      if (input.path.endsWith('/subscribe') && failures-- > 0) {
        state.calls.push({ path: 'subscribe', fullPath: input.path, body: input.body })
        throw new PlatformRequestError('broker_unavailable', true, 503)
      }
      return request(input)
    }
    await runner.tick()
    expect(state.rejected).toEqual([])
    state.calls = []
    state.now += 60_000
    await runner.tick()
    expect(paths()).toEqual(['subscribe', 'pull'])
  })
})
