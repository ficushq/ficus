import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import type { Monitor, MonitorStatus } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { PermissionsProvider } from '../hooks/usePermissions'
import { AgentMonitorStatus } from './AgentMonitorStatus'
import { QueryInvalidator } from './QueryInvalidator'
import { queryKeys } from '../queryKeys'
import { PLANT_HIDE_MS } from '../hooks/usePlantPresence'

type Callback = (entry: { event: string; data: unknown }) => void

const ACTIVE_LIST_KEY = (agentId: string) =>
  queryKeys.monitors.list({ agentId, squadId: undefined, status: 'starting,running,canceling' })

function monitor(id: string, label: string, status: MonitorStatus = 'running'): Monitor {
  return {
    id,
    agentId: 'agent-a',
    sandboxId: 'sandbox-a',
    label,
    description: `${label} description`,
    command: 'tail -F app.log',
    cwd: null,
    status,
    processId: `proc-${id}`,
    timeoutMs: 60_000,
    maxBatchLines: 20,
    maxBatchBytes: 4096,
    batchDebounceMs: 750,
    exitCode: null,
    failureReason: null,
    failureKind: null,
    linesEmitted: 3,
    bytesEmitted: 30,
    createdAt: '2026-10-22T00:00:00.000Z',
    startedAt: '2026-10-22T00:00:01.000Z',
    endedAt: null,
    lastBatchAt: null,
    restartPolicy: 'never',
    restartLimit: 5,
    restartCount: 0,
    rapidRestartCount: 0,
    launchedAt: null,
    deadlineAt: null,
    nextRestartAt: null,
    lastRestartAt: null,
    lastRestartReason: null,
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('AgentMonitorStatus', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: import('react-dom/client').Root
  let client: QueryClient
  let monitors: Map<string, Monitor[]>
  let listStatus: number
  let pendingList: Promise<Response> | undefined
  let listRequests: string[]
  let detailRequests: string[]
  let captured: Map<string, Callback>
  let permissions: string[]
  let permissionsLoading: boolean
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
    monitors = new Map([
      ['agent-a', [monitor('m1', 'deploy logs'), monitor('m2', 'ci watcher', 'starting')]],
      ['agent-b', []],
    ])
    listStatus = 200
    pendingList = undefined
    listRequests = []
    detailRequests = []
    permissions = ['monitors:read']
    permissionsLoading = false
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/monitors') {
        listRequests.push(`${url.pathname}${url.search}`)
        if (pendingList) return pendingList
        if (listStatus !== 200) return json({ error: 'Forbidden' }, listStatus)
        return json(monitors.get(url.searchParams.get('agentId') ?? '') ?? [])
      }
      const logs = url.pathname.match(/^\/api\/monitors\/([^/]+)\/logs$/)
      if (logs) return json({ lines: [] })
      const detail = url.pathname.match(/^\/api\/monitors\/([^/]+)$/)
      if (detail) {
        detailRequests.push(detail[1])
        const found = [...monitors.values()].flat().find((m) => m.id === detail[1])
        return found ? json(found) : json({ ...monitor(detail[1], 'ended monitor', 'exited') })
      }
      throw new Error(`Unexpected fixture request ${url.pathname}`)
    }) as typeof fetch
  })
  afterEach(async () => {
    await dom.act(async () => {
      await client.cancelQueries()
    })
    await dom.cleanup()
    client.clear()
  })

  async function render(agentId = 'agent-a', isConnected = false, agentIdle = false) {
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsProvider usePermissions={usePermissions}>
            <AgentMonitorStatus key={agentId} agentId={agentId} squadId="squad-a" agentIdle={agentIdle} />
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
  const doc = () => dom.window.document
  const text = () => doc().body.textContent ?? ''
  const buttons = () => [...doc().querySelectorAll<HTMLButtonElement>('[role="status"] button')]
  const dialog = () => doc().querySelector('[role="dialog"]')
  const plant = () => doc().querySelector<HTMLElement>('[data-testid="monitor-hanging-plant"]')
  // Past the plant's retreat (PLANT_HIDE_MS and its fallback margin); the test DOM fires no animationend.
  async function afterRetreat() {
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, PLANT_HIDE_MS + 120))
    })
  }
  const plantState = () => plant()?.querySelector('.ficus-plant-peek')?.getAttribute('data-state')
  async function emit(event: string, agentId = 'agent-a') {
    await dom.act(async () => {
      captured.get('monitors')!({ event, data: { agentId } })
    })
  }

  test('names every active monitor in one live status row, querying only active statuses', async () => {
    await render()
    await eventually(() => expect(text()).toContain('Monitoring: deploy logs · ci watcher'))
    const status = doc().querySelectorAll('[role="status"]')
    expect(status).toHaveLength(1)
    expect(status[0].getAttribute('aria-live')).toBe('polite')
    expect(buttons().map((button) => button.textContent)).toEqual(['deploy logs', 'ci watcher'])
    expect(buttons().every((button) => button.type === 'button')).toBe(true)
    expect(listRequests).toEqual(['/api/monitors?agentId=agent-a&status=starting%2Crunning%2Ccanceling'])
  })

  test('each label opens the details modal for its own monitor', async () => {
    await render()
    await eventually(() => expect(buttons()).toHaveLength(2))
    await dom.act(async () => buttons()[1].click())
    await eventually(() => expect(dialog()?.textContent).toContain('m2'))
    expect(dialog()?.textContent).toContain('ci watcher')
    expect(detailRequests).toContain('m2')
    await dom.act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    await eventually(() => expect(dialog()).toBeNull())
    await dom.act(async () => buttons()[0].click())
    await eventually(() => expect(dialog()?.textContent).toContain('m1'))
    expect(dialog()?.textContent).toContain('deploy logs')
  })

  test('removes the row live when the last monitor ends, keeping an open modal', async () => {
    monitors.set('agent-a', [monitor('m1', 'deploy logs')])
    await render()
    await eventually(() => expect(text()).toContain('Monitoring: deploy logs'))
    await dom.act(async () => buttons()[0].click())
    await eventually(() => expect(dialog()?.textContent).toContain('m1'))
    monitors.set('agent-a', [])
    await emit('monitor.ended')
    await eventually(() => expect(doc().querySelector('[role="status"]')).toBeNull())
    expect(dialog()).not.toBeNull()
  })

  test('appears live when a monitor is created', async () => {
    monitors.set('agent-a', [])
    await render()
    await eventually(() => expect(listRequests).toHaveLength(1))
    expect(text()).not.toContain('Monitoring')
    monitors.set('agent-a', [monitor('m3', 'new watcher')])
    await emit('monitor.created')
    await eventually(() => expect(text()).toContain('Monitoring: new watcher'))
  })

  test('ignores monitors that are no longer active in the response', async () => {
    monitors.set('agent-a', [monitor('m1', 'old', 'exited'), monitor('m2', 'stopping', 'canceling')])
    await render()
    await eventually(() => expect(text()).toContain('Monitoring: stopping'))
    expect(text()).not.toContain('old')
  })

  test('does not fetch or render without monitors:read, or while permissions load', async () => {
    client.setQueryData(ACTIVE_LIST_KEY('agent-a'), [monitor('m1', 'cached')])
    permissions = ['slots:use']
    await render()
    permissionsLoading = true
    permissions = ['monitors:read']
    await render()
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(listRequests).toEqual([])
    expect(text()).toBe('')
  })

  test('hides silently when the read fails', async () => {
    listStatus = 403
    await render()
    await eventually(() => expect(listRequests).toHaveLength(1))
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(text()).toBe('')
    expect(doc().querySelector('[role="status"]')).toBeNull()
  })

  test('hides cache from before mount until this mount has fetched it', async () => {
    client.setQueryData(ACTIVE_LIST_KEY('agent-a'), [monitor('stale', 'stale watcher')])
    let release!: (response: Response) => void
    pendingList = new Promise((resolve) => {
      release = resolve
    })
    await render()
    await eventually(() => expect(listRequests).toHaveLength(1))
    expect(text()).not.toContain('stale watcher')
    await dom.act(async () => release(json([monitor('m1', 'deploy logs')])))
    await eventually(() => expect(text()).toContain('Monitoring: deploy logs'))
  })

  test('keeps the row mounted while a background refetch is pending', async () => {
    await render()
    await eventually(() => expect(buttons()).toHaveLength(2))
    const row = doc().querySelector('[role="status"]')
    let release!: (response: Response) => void
    pendingList = new Promise((resolve) => {
      release = resolve
    })
    await emit('monitor.updated')
    await eventually(() => expect(listRequests).toHaveLength(2))
    expect(doc().querySelector('[role="status"]')).toBe(row)
    expect(text()).toContain('Monitoring: deploy logs · ci watcher')
    await dom.act(async () => release(json([monitor('m1', 'deploy logs')])))
    await eventually(() => expect(text()).not.toContain('ci watcher'))
    expect(text()).toContain('Monitoring: deploy logs')
  })

  test('switching agents never shows the previous agent monitors', async () => {
    await render('agent-a')
    await eventually(() => expect(buttons()).toHaveLength(2))
    await render('agent-b')
    expect(text()).not.toContain('deploy logs')
    await eventually(() => expect(listRequests).toHaveLength(2))
    expect(text()).toBe('')
  })

  test('accents the icon and the Monitoring label, keeping the labels as dotted links', async () => {
    await render()
    await eventually(() => expect(buttons()).toHaveLength(2))
    const status = doc().querySelector('[role="status"]')!
    expect(status.querySelector('svg')!.getAttribute('class')).toContain('text-accent-light')
    const label = [...status.querySelectorAll('span')].find((span) => span.textContent === 'Monitoring:')!
    expect(label.className).toContain('text-accent-light')
    for (const button of buttons()) {
      expect(button.className).toContain('decoration-dotted')
      expect(button.className).not.toContain('text-accent')
    }
  })

  test('hangs the plant from the row only while the agent is idle with an active monitor', async () => {
    await render('agent-a', false, true)
    await eventually(() => expect(plantState()).toBe('in'))
    // Decorative and outside the status row, which keeps its live semantics.
    expect(plant()!.getAttribute('aria-hidden')).toBe('true')
    expect(plant()!.closest('[role="status"]')).toBeNull()
    expect(plant()!.querySelector('.ficus-plant-hang button.ficus-plant-jump')).not.toBeNull()
    expect(doc().querySelectorAll('[role="status"]')).toHaveLength(1)

    await render('agent-b', false, true)
    await eventually(() => expect(listRequests).toHaveLength(2))
    expect(plant()).toBeNull()
  })

  test('shows no plant while the agent works, and retreats when it starts working', async () => {
    await render('agent-a', false, false)
    await eventually(() => expect(buttons()).toHaveLength(2))
    expect(plant()).toBeNull()

    await render('agent-a', false, true)
    await eventually(() => expect(plantState()).toBe('in'))
    await render('agent-a', false, false)
    expect(plantState()).toBe('out')
    await afterRetreat()
    expect(plant()).toBeNull()
    expect(text()).toContain('Monitoring: deploy logs · ci watcher')
  })

  test('retreats behind the row when the last monitor ends, then the row goes', async () => {
    monitors.set('agent-a', [monitor('m1', 'deploy logs')])
    await render('agent-a', false, true)
    await eventually(() => expect(plantState()).toBe('in'))
    monitors.set('agent-a', [])
    await emit('monitor.ended')
    // The row stays, naming the monitor, while the plant jumps back up behind it.
    await eventually(() => expect(plantState()).toBe('out'))
    expect(text()).toContain('Monitoring: deploy logs')
    await afterRetreat()
    expect(doc().querySelector('[role="status"]')).toBeNull()
    expect(plant()).toBeNull()
  })
})
