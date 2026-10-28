import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { SlotPool } from '../../api/slots'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { SlotPoolsSettings } from './SlotPoolsSettings'

const SQUAD = 'squad-1'
const HOLDER_AGENT = '11111111-2222-4333-8444-555555555555'

function pool(overrides: Partial<SlotPool> = {}): SlotPool {
  return {
    id: 'pool-1',
    squadId: SQUAD,
    key: 'shared-box-intensive',
    capacity: 2,
    claimTimeoutMs: 45 * 60_000,
    usage: 'Claim before DB-backed tests or native builds.',
    enabled: true,
    disabledAt: null,
    activeCount: 1,
    availableCount: 1,
    queuedCount: 3,
    holders: [
      {
        id: 'claim-1',
        ownerAgentId: HOLDER_AGENT,
        ownerShortId: HOLDER_AGENT.slice(0, 8),
        claimedAt: '2026-10-15T04:00:00.000Z',
        expiresAt: '2026-10-15T04:45:00.000Z',
      },
    ],
    oldestWaiterAgeMs: 12 * 60_000,
    ...overrides,
  }
}

function permissions(granted: string[]) {
  return () => ({
    permissions: granted,
    can: (permission: string) => granted.includes(permission),
    isLoading: false,
    isError: false,
  })
}

function element(client: QueryClient, granted: string[]) {
  return (
    <MemoryRouter>
      <PermissionsProvider usePermissions={permissions(granted)}>
        <QueryClientProvider client={client}>
          <SlotPoolsSettings squadId={SQUAD} />
        </QueryClientProvider>
      </PermissionsProvider>
    </MemoryRouter>
  )
}

function seededClient(pools: SlotPool[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(queryKeys.squads.slotPools(SQUAD), pools)
  client.setQueryData(queries.squads.list().queryKey, [])
  return client
}

describe('SlotPoolsSettings rendering', () => {
  test('shows configuration, guidance, live usage and holders read-only with slots:use', () => {
    const html = renderToStaticMarkup(
      element(seededClient([pool(), pool({ id: 'pool-2', key: 'production-change', usage: null, enabled: false })]), [
        'slots:use',
      ])
    )
    expect(html).toContain('shared-box-intensive')
    expect(html).toContain('Capacity 2 · Claim timeout 45m')
    expect(html).toContain('Claim before DB-backed tests or native builds.')
    expect(html).toContain('1/2 in use')
    expect(html).toContain('3 queued')
    expect(html).toContain('Oldest wait 12m')
    expect(html).toContain('11111111')
    expect(html).toContain('No usage guidance.')
    expect(html).toContain('>Disabled<')
    expect(html).toContain('automatically included in every agent')
    // Read-only: no administration controls.
    expect(html).not.toContain('Add Pool')
    expect(html).not.toContain('>Edit<')
    expect(html).not.toContain('Unregister')
    expect(html).not.toContain('role="switch"')
  })

  test('offers create, edit, enable/disable and unregister with slots:write and links holders', () => {
    const html = renderToStaticMarkup(element(seededClient([pool()]), ['slots:write']))
    expect(html).toContain('Add Pool')
    expect(html).toContain('>Edit<')
    expect(html).toContain('Unregister')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain(`href="/squads/${SQUAD}/agents?agent=${HOLDER_AGENT}"`)
  })

  test('explains missing read permission instead of listing pools', () => {
    const html = renderToStaticMarkup(element(seededClient([pool()]), []))
    expect(html).toContain('permission to view slot pools')
    expect(html).not.toContain('shared-box-intensive')
  })

  test('shows an empty state when no pools are registered', () => {
    expect(renderToStaticMarkup(element(seededClient([]), ['slots:use']))).toContain('No slot pools registered.')
  })
})

type Call = { method: string; path: string; body?: unknown }

async function harness(pools: SlotPool[], respond?: (call: Call) => { status: number; body: unknown } | undefined) {
  const dom = await acquireDomHarness({ url: `http://localhost/squads/${SQUAD}/settings?section=context` })
  const rendered = dom.createRoot()
  const client = seededClient(pools)
  const calls: Call[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    }
    if (call.method !== 'GET') calls.push(call)
    const reply = respond?.(call) ?? {
      status: 200,
      // Refetches of the pool list get the pools; any other read (the squad list) is empty.
      body:
        call.method !== 'GET'
          ? { outcome: 'updated', message: 'ok', pool: {} }
          : call.path.endsWith('/slots')
            ? pools
            : [],
    }
    return new dom.window.Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response
  }) as typeof fetch
  await dom.act(async () => rendered.root.render(element(client, ['slots:write'])))
  const document = dom.window.document
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label) as
      HTMLButtonElement | undefined
  const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await dom.act(async () => {
      fireEvent.input(field, { target: { value } })
      fireEvent.change(field, { target: { value } })
    })
  }
  const click = async (target: HTMLElement) => dom.act(async () => target.click())
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(done()).toBe(true)
  }
  return {
    document,
    button,
    type,
    click,
    settle,
    calls,
    restore: async () => {
      globalThis.fetch = originalFetch
      client.clear()
      await dom.cleanup()
    },
  }
}

describe('SlotPoolsSettings administration', () => {
  test('creates a pool with normalized key, parsed timeout and guidance, and blocks invalid keys', async () => {
    const ui = await harness([])
    try {
      await ui.click(ui.button('Add Pool')!)
      const form = ui.document.querySelector('form')!
      const [keyInput, capacityInput, timeoutInput] = [...form.querySelectorAll('input')] as HTMLInputElement[]
      const usageInput = form.querySelector('textarea') as HTMLTextAreaElement

      await ui.type(keyInput!, '2 bad')
      const submit = () => [...form.querySelectorAll('button')].find((b) => b.type === 'submit') as HTMLButtonElement
      expect(submit().disabled).toBe(true)

      await ui.type(keyInput!, '  Heavy-Tests ')
      await ui.type(capacityInput!, '2')
      await ui.type(timeoutInput!, '45m')
      await ui.type(usageInput, '  Claim before DB-backed tests.  ')
      expect(submit().disabled).toBe(false)
      await ui.click(submit())
      await ui.settle(() => ui.calls.length === 1)
      expect(ui.calls[0]).toEqual({
        method: 'POST',
        path: `/api/squads/${SQUAD}/slots`,
        body: { key: 'heavy-tests', capacity: 2, claimTimeoutMs: 45 * 60_000, usage: 'Claim before DB-backed tests.' },
      })
    } finally {
      await ui.restore()
    }
  })

  test('editing only the guidance sends a partial update', async () => {
    const ui = await harness([pool()])
    try {
      await ui.click(ui.button('Edit')!)
      const usageInput = ui.document.querySelector('textarea') as HTMLTextAreaElement
      expect(usageInput.value).toBe('Claim before DB-backed tests or native builds.')
      await ui.type(usageInput, 'Claim before any DB-backed test.')
      await ui.click(ui.button('Save')!)
      await ui.settle(() => ui.calls.length === 1)
      expect(ui.calls[0]).toEqual({
        method: 'PATCH',
        path: `/api/squads/${SQUAD}/slots/shared-box-intensive`,
        body: { usage: 'Claim before any DB-backed test.' },
      })
    } finally {
      await ui.restore()
    }
  })

  test('clearing the guidance sends usage null', async () => {
    const ui = await harness([pool()])
    try {
      await ui.click(ui.button('Edit')!)
      await ui.type(ui.document.querySelector('textarea') as HTMLTextAreaElement, '   ')
      await ui.click(ui.button('Save')!)
      await ui.settle(() => ui.calls.length === 1)
      expect(ui.calls[0]!.body).toEqual({ usage: null })
    } finally {
      await ui.restore()
    }
  })

  test('the switch disables an enabled pool', async () => {
    const ui = await harness([pool()])
    try {
      const toggle = ui.document.querySelector('[role="switch"]') as HTMLButtonElement
      expect(toggle.getAttribute('aria-label')).toBe('Disable slot pool shared-box-intensive')
      await ui.click(toggle)
      await ui.settle(() => ui.calls.length === 1)
      expect(ui.calls[0]).toEqual({
        method: 'PATCH',
        path: `/api/squads/${SQUAD}/slots/shared-box-intensive`,
        body: { enabled: false },
      })
    } finally {
      await ui.restore()
    }
  })

  test('unregister asks for confirmation and surfaces the server error for a busy pool', async () => {
    const ui = await harness([pool()], (call) =>
      call.method === 'DELETE'
        ? { status: 409, body: { error: 'Slot pool "shared-box-intensive" still has live state.', code: 'pool_busy' } }
        : undefined
    )
    try {
      await ui.click(ui.button('Unregister')!)
      expect(ui.calls).toHaveLength(0)
      await ui.click(ui.button('Unregister?')!)
      await ui.settle(() => ui.document.body.textContent!.includes('still has live state'))
      expect(ui.calls).toEqual([{ method: 'DELETE', path: `/api/squads/${SQUAD}/slots/shared-box-intensive` }])
    } finally {
      await ui.restore()
    }
  })
})
