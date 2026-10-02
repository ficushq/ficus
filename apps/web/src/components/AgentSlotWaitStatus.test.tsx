import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../test/domHarness'
import { PermissionsProvider } from '../hooks/usePermissions'
import { AgentSlotWaitStatus } from './AgentSlotWaitStatus'
import { agentSlotWaitQueryKeys } from '../queryKeys'
import { QueryInvalidator } from './QueryInvalidator'

type Wait = { waiterId: string; poolKey: string; queuedAt: string }
type Callback = (entry: { event: string; data: unknown }) => void
const queued = (poolKey: string): Wait => ({ waiterId: poolKey, poolKey, queuedAt: '2026-09-14T21:49:49.000Z' })

describe('AgentSlotWaitStatus', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: import('react-dom/client').Root
  let client: QueryClient
  let responses: Map<string, Wait[]>
  let captured: Map<string, Callback>
  let requests: string[]
  let permissions: string[]
  let permissionsLoading: boolean
  let responseStatus: number
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
    permissions = ['slots:use']
    permissionsLoading = false
    responseStatus = 200
    pendingResponse = undefined
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
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
    const dot = status.querySelector('[aria-hidden="true"]')!
    expect(dot.className).toContain('motion-safe:animate-pulse')
    expect(dot.className).toContain('bg-status-progress-solid')
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
