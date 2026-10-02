import { renderToStaticMarkup } from 'react-dom/server'
import * as icons from './icons'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../test/domHarness'
import { PermissionsProvider } from '../hooks/usePermissions'
import { AgentSlotWaitStatus } from './AgentSlotWaitStatus'
import { agentSlotHoldQueryKeys, agentSlotWaitQueryKeys } from '../queryKeys'
import { QueryInvalidator } from './QueryInvalidator'

type Wait = { waiterId: string; poolKey: string; queuedAt: string }
type Hold = { poolKey: string; expiresAt: string }
const held = (poolKey: string): Hold => ({ poolKey, expiresAt: new Date(Date.now() + 60_000).toISOString() })
type Callback = (entry: { event: string; data: unknown }) => void
const queued = (poolKey: string): Wait => ({ waiterId: poolKey, poolKey, queuedAt: '2026-09-14T21:49:49.000Z' })

describe('AgentSlotWaitStatus', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: import('react-dom/client').Root
  let client: QueryClient
  let responses: Map<string, Wait[]>
  let holds: Hold[]
  let holdStatus: number
  let holdRequests: string[]
  let captured: Map<string, Callback>
  let requests: string[]
  let permissions: string[]
  let permissionsLoading: boolean
  let responseStatus: number
  let pendingHoldResponse: Promise<Response> | undefined
  let pendingResponse: Promise<Response> | undefined
  const subscribe = (topic: string, callback: Callback) => {
    captured.set(topic, callback)
    return () => {
      captured.delete(topic)
    }
  }
  const usePermissions = () => ({
    permissions,
    can: (p: string) => permissions.includes(p),
    isLoading: permissionsLoading,
    isError: false,
  })

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    root = dom.createRoot().root
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    captured = new Map()
    responses = new Map([
      ['agent-a', [queued('shared-box-intensive')]],
      ['agent-b', []],
    ])
    requests = []
    holds = []
    holdStatus = 200
    holdRequests = []
    permissions = ['slots:use']
    permissionsLoading = false
    responseStatus = 200
    pendingHoldResponse = undefined
    pendingResponse = undefined
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/slot-holds')) {
        holdRequests.push(path)
        return (
          pendingHoldResponse ??
          new Response(JSON.stringify(holdStatus === 200 ? holds : { error: 'unavailable' }), { status: holdStatus })
        )
      }
      requests.push(path)
      if (!/^\/api\/agents\/[^/]+\/slot-waits$/.test(path)) throw new Error(`Unexpected fixture request ${path}`)
      return (
        pendingResponse ??
        new Response(
          JSON.stringify(responseStatus === 200 ? (responses.get(path.split('/')[3]) ?? []) : { error: 'Forbidden' }),
          { status: responseStatus, headers: { 'Content-Type': 'application/json' } }
        )
      )
    }) as typeof fetch
  })
  afterEach(async () => {
    await dom.cleanup()
    client.clear()
  })

  async function render(agentId = 'agent-a', isConnected = false, isIdle = true) {
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsProvider usePermissions={usePermissions}>
            <AgentSlotWaitStatus agentId={agentId} squadId="squad-a" isIdle={isIdle} />
            <QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected }} />
          </PermissionsProvider>
        </QueryClientProvider>
      )
    })
  }
  async function eventually(assert: () => void) {
    await dom.act(async () => {
      await waitFor(assert)
    })
  }
  const text = () => dom.window.document.body.textContent ?? ''
  async function emit(event: string, squadId = 'squad-a') {
    await dom.act(async () => {
      captured.get('squads')!({ event, data: { squadId } })
    })
  }

  test('shows holding and waiting independently, deduplicating names within each state', async () => {
    const long = 'held-slot-'.repeat(40)
    holds = [held('shared-box-intensive'), held(long), held('shared-box-intensive')]
    await render()
    await eventually(() => expect(text()).toContain(`Holding slots: shared-box-intensive · ${long}`))
    expect(text()).toContain('Waiting for slot: shared-box-intensive')
    expect(dom.window.document.querySelectorAll('[role="status"]')).toHaveLength(2)
    await render('agent-a', false, false)
    expect(text()).toContain('Slot queue: shared-box-intensive')
    expect(text()).toContain('Holding slots:')
    expect(dom.window.document.querySelectorAll('button, details')).toHaveLength(0)
  })

  test.each(['hold', 'wait', 'both'] as const)('one neutral divider for %s status', async (state) => {
    holds = state === 'wait' ? [] : [held('build')]
    responses.set('agent-a', state === 'hold' ? [] : [queued('build')])
    await render('agent-a', false, false)
    await eventually(() =>
      expect(dom.window.document.querySelectorAll('[role="status"]')).toHaveLength(state === 'both' ? 2 : 1)
    )
    const dividers = dom.window.document.querySelectorAll('.border-b')
    expect(dividers).toHaveLength(1)
    expect(dividers[0]!.className).toContain('border-th-border')
    expect(dividers[0]!.querySelectorAll('[role="status"]')).toHaveLength(state === 'both' ? 2 : 1)
    const rows = [...dom.window.document.querySelectorAll('[role="status"]')]
    for (const row of rows) {
      const Icon = row.textContent?.startsWith('Holding') ? icons.TicketIcon : icons.HourglassIcon
      expect(row.querySelector('svg')?.outerHTML).toBe(
        renderToStaticMarkup(<Icon className="mt-0.5 h-3 w-3 shrink-0" />)
      )
      expect(row.outerHTML).not.toMatch(/animate-|rounded-full|status-progress|[⌛⏳🎟🎫]/u)
    }
    holds = []
    responses.set('agent-a', [])
    await emit('slots.updated')
    await eventually(() => expect(text()).toBe(''))
    expect(dom.window.document.querySelector('.border-b')).toBeNull()
  })

  test('held-only idle agents show informational ownership, removed on release and reconnect', async () => {
    responses.set('agent-a', [])
    holds = [held('build')]
    await render()
    await eventually(() => expect(text()).toBe('Holding slot: build'))
    holds = []
    await emit('slots.updated', 'other-squad')
    expect(holdRequests).toHaveLength(1)
    await render('agent-a', true)
    await eventually(() => expect(text()).toBe(''))
    holds = [held('renewed')]
    await emit('slots.updated')
    await eventually(() => expect(text()).toBe('Holding slot: renewed'))
    holds = []
    await emit('slots.updated')
    await eventually(() => expect(text()).toBe(''))
  })

  test.each([403, 404, 500])('optional held endpoint failure %i cannot erase valid waiting context', async (status) => {
    holds = [held('private')]
    await render()
    await eventually(() => expect(text()).toContain('Holding slot: private'))
    holdStatus = status
    await emit('slots.updated')
    await eventually(() => expect(text()).not.toContain('private'))
    await eventually(() => expect(text()).toBe('Waiting for slot: shared-box-intensive'))
  })

  test('a failed waiting read cannot erase valid held context', async () => {
    holds = [held('build')]
    responseStatus = 403
    await render()
    await eventually(() => expect(text()).toContain('Holding slot: build'))
    expect(text()).toContain('Slot wait status unavailable')
    expect(dom.window.document.querySelectorAll('.border-b')).toHaveLength(1)
  })

  test('expired and malformed wire facts never fabricate holding', async () => {
    holds = [
      { poolKey: 'expired', expiresAt: new Date(0).toISOString() },
      { poolKey: 'invalid', expiresAt: 'not a date' },
      { poolKey: 'missing' } as Hold,
    ]
    await render()
    await eventually(() => expect(holdRequests).toHaveLength(1))
    expect(text()).not.toContain('Holding')
  })

  test('cached ownership is hidden during revalidation, including an in-flight reconnect', async () => {
    client.setQueryData(agentSlotHoldQueryKeys.agent('squad-a', 'agent-a'), [held('old-private')])
    let resolve!: (response: Response) => void
    pendingHoldResponse = new Promise((r) => {
      resolve = r
    })
    await render()
    expect(text()).not.toContain('old-private')
    expect(text()).not.toContain('Holding')
    pendingHoldResponse = undefined
    holds = []
    await render('agent-a', true)
    await dom.act(async () => resolve(new Response(JSON.stringify([held('missed-release')]))))
    await eventually(() => expect(holdRequests).toHaveLength(2))
    await eventually(() => expect(text()).not.toContain('Holding'))
  })

  test('lease expiry removes ownership locally without polling; renewal reschedules its deadline', async () => {
    let now = 1_800_000_000_000
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const realTimeout = globalThis.setTimeout
    const deadlines: Array<() => void> = []
    globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
      if (delay === 60_000 || delay === 120_000) deadlines.push(callback)
      return realTimeout(callback, delay, ...args)
    }) as typeof setTimeout
    try {
      holds = [held('build')]
      await render()
      await eventually(() => expect(text()).toContain('Holding slot: build'))
      expect(deadlines).toHaveLength(1)
      holds = [{ poolKey: 'build', expiresAt: new Date(now + 120_000).toISOString() }]
      await emit('slots.updated')
      await eventually(() => expect(text()).toContain('Holding slot: build'))
      await eventually(() => expect(deadlines).toHaveLength(2))
      now += 120_000
      await dom.act(async () => deadlines[1]!())
      expect(text()).not.toContain('Holding')
      expect(text()).toContain('Waiting for slot:')
      expect(holdRequests).toHaveLength(2)
    } finally {
      globalThis.setTimeout = realTimeout
      clock.mockRestore()
    }
  })

  test('always shows distinct names inline without disclosure, counts or pool language', async () => {
    responses.set('agent-a', [
      queued('shared-box-intensive'),
      queued('production-change'),
      { ...queued('shared-box-intensive'), waiterId: 'duplicate' },
    ])
    await render()
    await eventually(() => expect(text()).toBe('Waiting for slot: shared-box-intensive · production-change'))
    expect(dom.window.document.querySelector('details, summary, button, ul')).toBeNull()
    const status = dom.window.document.querySelector('[role="status"]')!
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(status.outerHTML).not.toMatch(/pool|position|ETA|only reason|idle because/i)
    expect(status.className).toContain('text-secondary')
    expect(status.className).not.toContain('status-queue')
    expect(status.querySelector('svg')?.outerHTML).toBe(
      renderToStaticMarkup(<icons.HourglassIcon className="mt-0.5 h-3 w-3 shrink-0" />)
    )
    expect(status.outerHTML).not.toMatch(/animate-|rounded-full|status-progress|[⌛⏳🎟🎫]/u)
  })

  test('keeps a single long name visible and wrappable at narrow widths', async () => {
    const name = 'shared-box-intensive-'.repeat(20)
    responses.set('agent-a', [queued(name)])
    await render()
    await eventually(() => expect(text()).toBe(`Waiting for slot: ${name}`))
    const label = dom.window.document.querySelector('[role="status"] span:last-child')!
    expect(label.className).toContain('[overflow-wrap:anywhere]')
    expect(label.className).not.toMatch(/truncate|line-clamp|overflow-hidden/)
  })

  test('running agent keeps secondary context without claiming it is waiting', async () => {
    await render('agent-a', false, false)
    await eventually(() => expect(text()).toBe('Slot queue: shared-box-intensive'))
    expect(text()).not.toContain('Waiting for slot')
  })

  test('does not present a stale cached wait as live while revalidating it', async () => {
    client.setQueryData(agentSlotWaitQueryKeys.agent('squad-a', 'agent-a'), [queued('old-pool')])
    let resolve!: (response: Response) => void
    pendingResponse = new Promise((r) => {
      resolve = r
    })
    await render()
    expect(text()).not.toContain('Waiting for slot')
    expect(text()).not.toContain('old-pool')
    await dom.act(async () => {
      resolve(new Response('[]'))
    })
    await eventually(() => expect(text()).toBe(''))
  })

  test('renders nothing for no waits (including an agent that only owns claims)', async () => {
    responses.set('agent-a', [])
    await render()
    await eventually(() =>
      expect(
        client
          .getQueryCache()
          .getAll()
          .some((q) => q.state.status === 'success')
      ).toBe(true)
    )
    expect(text()).toBe('')
  })

  for (const transition of ['granted', 'canceled', 'expired', 'unsubscribed']) {
    test(`removes the queued status after ${transition} invalidation without a reload`, async () => {
      await render()
      await eventually(() => expect(text()).toContain('shared-box-intensive'))
      responses.set('agent-a', [])
      await emit('slots.updated')
      await eventually(() => expect(text()).toBe(''))
      expect(requests).toHaveLength(2)
    })
  }

  test('repairs missed updates on reconnect and ignores another squad invalidation', async () => {
    await render()
    await eventually(() => expect(text()).toContain('shared-box-intensive'))
    responses.set('agent-a', [])
    await emit('slots.updated', 'other-squad')
    expect(requests).toHaveLength(1)
    await render('agent-a', true)
    await eventually(() => expect(text()).toBe(''))
    expect(requests).toHaveLength(2)
  })

  test('reconnect repairs a stale response already in flight when the socket opens', async () => {
    let resolve!: (response: Response) => void
    pendingResponse = new Promise((r) => {
      resolve = r
    })
    await render()
    expect(requests).toHaveLength(1)
    pendingResponse = undefined
    responses.set('agent-a', [])
    await render('agent-a', true)
    await dom.act(async () => {
      resolve(new Response(JSON.stringify([queued('old-wait')])))
    })
    await eventually(() => expect(requests).toHaveLength(2))
    await eventually(() => expect(text()).toBe(''))
  })

  test('agent navigation clears the previous indicator while the next request is pending', async () => {
    await render()
    await eventually(() => expect(text()).toContain('shared-box-intensive'))
    let resolve!: (response: Response) => void
    pendingResponse = new Promise((r) => {
      resolve = r
    })
    await render('agent-b')
    expect(text()).not.toContain('shared-box-intensive')
    await dom.act(async () => {
      resolve(new Response('[]'))
    })
    await eventually(() => expect(requests).toContain('/api/agents/agent-b/slot-waits'))
    expect(text()).toBe('')
  })

  test('does not fetch while permission is loading or denied, even with previously cached waits', async () => {
    permissionsLoading = true
    await render()
    expect(requests).toHaveLength(0)
    expect(text()).toBe('')
    permissionsLoading = false
    permissions = []
    await render()
    expect(requests).toHaveLength(0)
    permissions = ['slots:write']
    await render()
    await eventually(() => expect(text()).toContain('shared-box-intensive'))
    permissions = []
    await render()
    expect(text()).toBe('')
  })

  test('does not claim an active wait during initial loading and hides stale data after a forbidden response', async () => {
    let resolve!: (response: Response) => void
    pendingResponse = new Promise((r) => {
      resolve = r
    })
    await render()
    expect(text()).not.toContain('Queued')
    await dom.act(async () => {
      resolve(new Response(JSON.stringify([queued('shared-box-intensive')])))
    })
    await eventually(() => expect(text()).toContain('shared-box-intensive'))
    pendingResponse = undefined
    responseStatus = 403
    await emit('slots.updated')
    await eventually(() => expect(text()).not.toContain('shared-box-intensive'))
    expect(text()).not.toContain('Queued')
  })
})
