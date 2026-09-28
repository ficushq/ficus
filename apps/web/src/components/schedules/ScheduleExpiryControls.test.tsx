import { describe, expect, it } from 'bun:test'
import type { Schedule } from '@ficus/shared'
import { buildScheduleUpdateFromEditState, createScheduleEditState } from './SchedulesList'
import { buildCreateScheduleConfig, CreateScheduleModal } from './CreateScheduleModal'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import { queries } from '../../queryOptions'

const schedule: Schedule = {
  id: 'schedule-id',
  scopeType: 'squad',
  scopeId: 'squad-id',
  name: 'Temporary check',
  enabled: true,
  schedule: { interval: '1h', skipIfUnresolved: true, expiresAt: '2026-09-01T12:00:00.000Z' },
  action: {
    type: 'create_work_stream',
    title: 'Check',
    description: 'Keep every field',
    handoffMessage: 'Preserve this handoff',
    workflow: { kind: 'preset', id: 'solo', customizations: [] },
  },
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

describe('schedule expiry edit controls', () => {
  it('converts create datetime-local expiry to the exact ISO payload', () => {
    expect(
      buildCreateScheduleConfig({
        scheduleType: 'interval',
        interval: '1h',
        cron: '',
        runAt: '',
        expiresAt: '2026-09-01T12:30',
        actionCreatesWorkStream: false,
        skipIfUnresolved: false,
      })
    ).toEqual({ interval: '1h', expiresAt: new Date('2026-09-01T12:30').toISOString() })
  })

  it('submits create expiry through the production modal form', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const originalFetch = globalThis.fetch
    const calls: Array<{ method?: string; body?: string }> = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body as string | undefined })
      return new dom.window.Response(JSON.stringify(schedule), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      client.setQueryData(queries.squads.list().queryKey, [])
      client.setQueryData(queries.agentTypes.list().queryKey, [])
      const rendered = dom.createRoot()
      await dom.act(async () =>
        rendered.root.render(
          <QueryClientProvider client={client}>
            <CreateScheduleModal isOpen onClose={() => undefined} defaultScope={{ type: 'agent', id: 'agent-1' }} />
          </QueryClientProvider>
        )
      )
      const document = dom.window.document
      const setValue = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        await dom.act(async () => {
          const prototype =
            element instanceof dom.window.HTMLTextAreaElement
              ? dom.window.HTMLTextAreaElement.prototype
              : dom.window.HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
          element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
      }
      await setValue(document.querySelector('input[placeholder="Daily standup reminder"]')!, 'Expiring reminder')
      const textInputs = [...document.querySelectorAll('input[type="text"]')] as HTMLInputElement[]
      await setValue(textInputs[1]!, '30m')
      await setValue(textInputs[2]!, 'agent-1')
      await setValue(document.querySelector('textarea')!, 'hello')
      await setValue(document.querySelector('input[type="datetime-local"]')!, '2026-09-01T12:30')
      const form = document.querySelector('form')
      expect(form).not.toBeNull()
      await dom.act(async () => {
        form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const post = calls.find((call) => call.method === 'POST')
      expect(post).toBeDefined()
      const submitted = JSON.parse(post!.body!)
      expect(submitted.schedule).toEqual({
        interval: '30m',
        expiresAt: new Date('2026-09-01T12:30').toISOString(),
      })
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
    }
  })

  it('converts a stored spawn-and-stream schedule to the squad default without dropping its task', () => {
    const legacy: Schedule = {
      ...schedule,
      action: {
        type: 'spawn_agent',
        agentTypeId: 'engineer',
        prompt: 'Inspect the service',
        workStream: { title: 'Health', description: 'Daily check', completionMode: 'review-approval' },
      },
    }
    const state = createScheduleEditState(legacy)
    expect(state.actionType).toBe('create_work_stream')
    expect(buildScheduleUpdateFromEditState(state).action).toEqual({
      type: 'create_work_stream',
      title: 'Health',
      description: 'Daily check\n\nInspect the service',
    })
  })

  it('preserves expiry with timing and clears only expiry when requested', () => {
    const state = createScheduleEditState(schedule)
    const preserved = buildScheduleUpdateFromEditState(state)
    expect(preserved.schedule).toEqual({
      interval: '1h',
      expiresAt: '2026-09-01T12:00:00.000Z',
      skipIfUnresolved: true,
    })
    expect(preserved.action).toEqual(schedule.action)

    const cleared = buildScheduleUpdateFromEditState({ ...state, expiresAt: '' })
    expect(cleared.schedule).toEqual({ interval: '1h', skipIfUnresolved: true })
    expect(cleared.schedule).not.toHaveProperty('expiresAt')
    expect(cleared.action).toEqual(schedule.action)
  })
})
