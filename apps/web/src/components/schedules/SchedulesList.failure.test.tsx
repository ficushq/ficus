import { describe, expect, test } from 'bun:test'
import type { Schedule } from '@ficus/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { queries } from '../../queryOptions'
import { SUBAGENT_WATCHDOG_KIND } from '../../lib/subagentWatchdog'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { SchedulesList } from './SchedulesList'

const dependencies = { useWebSocket: () => ({ subscribe: () => () => undefined, isConnected: false }) }
const base: Schedule = {
  id: 'never',
  scopeType: 'agent',
  scopeId: 'parent-1',
  name: 'Never schedule',
  enabled: true,
  schedule: { interval: '1h' },
  action: { type: 'inbox_message', target: { type: 'agent', agentId: 'parent-1' }, content: 'x' },
  metadata: {},
  triggerCount: 0,
  lastTriggeredAt: null,
  lastSkippedAt: null,
  skipCount: 0,
  lastWebhookTriggerAt: null,
  nextTriggerAt: null,
  webhookEnabled: false,
  healthStatus: 'never_run',
  lastSuccessAt: null,
  lastFailureAt: null,
  lastRecoveredAt: null,
  failureCount: 0,
  consecutiveFailureCount: 0,
  lastErrorCode: null,
  lastErrorSummary: null,
  automaticallyDisabledAt: null,
  automaticDisableReason: null,
  createdAt: new Date('2026-08-26T12:00:00Z'),
  updatedAt: new Date('2026-08-26T12:00:00Z'),
}

async function renderSchedules(schedules: Schedule[], entry = '/') {
  const dom = await acquireDomHarness({ url: `http://localhost${entry}` })
  const rendered = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const params = { scopeType: 'agent' as const, scopeId: 'parent-1', excludeKind: SUBAGENT_WATCHDOG_KIND }
  const listKey = queries.schedules.list(params).queryKey
  client.setQueryData(listKey, schedules)
  await dom.act(async () =>
    rendered.root.render(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
          >
            <SchedulesList scopeType="agent" scopeId="parent-1" dependencies={dependencies} />
          </PermissionsProvider>
        </QueryClientProvider>
      </MemoryRouter>
    )
  )
  return Object.assign(dom, { client, listKey })
}

describe('SchedulesList schedule health', () => {
  test('renders compact health independently from enabled state', async () => {
    const dom = await renderSchedules([
      base,
      { ...base, id: 'healthy', name: 'Healthy schedule', healthStatus: 'healthy', lastSuccessAt: new Date() },
      {
        ...base,
        id: 'failing',
        name: 'Failing schedule',
        healthStatus: 'failing',
        failureCount: 3,
        consecutiveFailureCount: 3,
      },
      {
        ...base,
        id: 'disabled',
        name: 'Disabled schedule',
        enabled: false,
        healthStatus: 'automatically_disabled',
        automaticallyDisabledAt: new Date(),
      },
    ])
    try {
      const text = dom.window.document.body.textContent ?? ''
      expect(text).toContain('Never run')
      expect(text).toContain('Healthy')
      expect(text).toContain('Failing')
      expect(text).toContain('Automatically disabled')
    } finally {
      await dom.cleanup()
    }
  })

  test('invalidates schedule queries when a manual trigger rejects', async () => {
    const originalFetch = globalThis.fetch
    let dom: Awaited<ReturnType<typeof renderSchedules>> | undefined
    const calls: Array<{ url: string; method?: string }> = []
    const rejectedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method })
      return new Response(JSON.stringify({ error: 'failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      dom = await renderSchedules([{ ...base, id: 'rejecting', name: 'Rejecting schedule' }], '/?schedule=rejecting')
      globalThis.fetch = rejectedFetch
      const trigger = dom.window.document.querySelector('button[title="Trigger now"]') as HTMLButtonElement
      expect(trigger).not.toBeNull()
      await dom.act(async () => {
        trigger.dispatchEvent(new dom!.window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      expect(
        calls.filter((call) => call.method === 'POST' && call.url.includes('/schedules/rejecting/trigger'))
      ).toHaveLength(1)
      expect(dom.client.getQueryState(dom.listKey)?.isInvalidated).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      if (dom) await dom.cleanup()
    }
  })

  test('submits expiry clearing without losing action fields through the production detail modal', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ method?: string; body?: string }> = []
    const editing: Schedule = {
      ...base,
      id: 'editing',
      name: 'Editing schedule',
      scopeType: 'squad',
      schedule: { interval: '1h', skipIfUnresolved: true, expiresAt: '2026-09-01T12:00:00.000Z' },
      action: {
        type: 'create_work_stream',
        title: 'Keep fields',
        description: 'description',
        handoffMessage: 'handoff',
        workflow: { kind: 'preset', id: 'solo', customizations: [] },
      },
    }
    let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
    const editFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body as string | undefined })
      const body = init?.method === 'PATCH' ? JSON.stringify(editing) : '[]'
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      dom = await renderSchedules([editing], '/?schedule=editing')
      globalThis.fetch = editFetch
      const edit = dom.window.document.querySelector('button[title="Edit schedule"]') as HTMLButtonElement
      expect(edit).not.toBeNull()
      expect(edit.disabled).toBe(false)
      await dom.act(async () => {
        edit.dispatchEvent(new dom!.window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      const expires = dom.window.document.querySelector('input[type="datetime-local"]') as HTMLInputElement
      expect(expires).not.toBeNull()
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom!.window.HTMLInputElement.prototype, 'value')!.set!.call(expires, '')
        expires.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
      })
      const save = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')
      expect(save).toBeDefined()
      expect((save as HTMLButtonElement).disabled).toBe(false)
      await dom.act(async () => {
        save!.dispatchEvent(new dom!.window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      expect(dom.window.document.body.textContent).not.toContain('requires')
      const patch = calls.find((call) => call.method === 'PATCH')
      expect(patch).toBeDefined()
      const submitted = JSON.parse(patch!.body!)
      expect(submitted.schedule).not.toHaveProperty('expiresAt')
      expect(submitted.action).toEqual(editing.action)
    } finally {
      globalThis.fetch = originalFetch
      if (dom) await dom.cleanup()
    }
  })

  test('renders full active and recovered failure history through the production portal', async () => {
    const failing: Schedule = {
      ...base,
      id: 'failing',
      name: 'Failing schedule',
      healthStatus: 'failing',
      failureCount: 3,
      consecutiveFailureCount: 3,
      lastFailureAt: new Date(),
      lastErrorCode: 'transport_error',
      lastErrorSummary: 'A transport error interrupted the scheduled action.',
    }
    let dom = await renderSchedules([failing], '/?schedule=failing')
    try {
      const dialog = dom.window.document.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('3 total · 3 consecutive')
      expect(dialog?.textContent).toContain('transport_error')
      expect(dialog?.textContent).toContain('A transport error interrupted the scheduled action.')
    } finally {
      await dom.cleanup()
    }

    const recovered = {
      ...failing,
      id: 'recovered',
      healthStatus: 'healthy' as const,
      consecutiveFailureCount: 0,
      lastSuccessAt: new Date(),
      lastRecoveredAt: new Date(),
    }
    dom = await renderSchedules([recovered], '/?schedule=recovered')
    try {
      const dialog = dom.window.document.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('Previous failure')
      expect(dialog?.textContent).toContain('transport_error')
      expect(dialog?.textContent).toContain('A transport error interrupted the scheduled action.')
    } finally {
      await dom.cleanup()
    }
  })
})
