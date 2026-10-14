import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { acquireDomHarness } from '../../test/domHarness'
import { ConsultantDormancySettings } from './ConsultantDormancySettings'

function permissions(granted: string[]) {
  return () => ({
    permissions: granted,
    can: (permission: string) => granted.includes(permission),
    isLoading: false,
    isError: false,
  })
}

function element(client: QueryClient, days: number | null, granted = ['squads:update']) {
  return (
    <PermissionsProvider usePermissions={permissions(granted)}>
      <QueryClientProvider client={client}>
        <ConsultantDormancySettings squadId="squad-1" consultantIdleDormancyDays={days} />
      </QueryClientProvider>
    </PermissionsProvider>
  )
}

async function harness(days: number | null) {
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-1/settings?section=workspace' })
  const rendered = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const patches: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/squads/squad-1') && init?.method === 'PATCH')
      patches.push(JSON.parse(String(init.body)))
    return new dom.window.Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response
  }) as typeof fetch
  await dom.act(async () => rendered.root.render(element(client, days)))
  const document = dom.window.document
  const toggle = () => document.querySelector('#squad-consultant-idle-dormancy') as HTMLInputElement
  const daysInput = () => document.querySelector('#squad-consultant-idle-dormancy-days') as HTMLInputElement | null
  const save = () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(done()).toBe(true)
  }
  return {
    dom,
    toggle,
    daysInput,
    save,
    patches,
    settle,
    restore: async () => {
      globalThis.fetch = originalFetch
      client.clear()
      await dom.cleanup()
    },
  }
}

describe('ConsultantDormancySettings', () => {
  test('shows the saved threshold, and is read-only without squads:update', () => {
    const client = new QueryClient()
    const on = renderToStaticMarkup(element(client, 30))
    expect(on).toContain('Make consultants dormant after they&#x27;ve been idle')
    expect(on).toContain('value="30"')
    const readOnly = renderToStaticMarkup(element(client, 30, []))
    expect(readOnly).toContain('disabled=""')
    expect(renderToStaticMarkup(element(client, null))).not.toContain('id="squad-consultant-idle-dormancy-days"')
  })

  test('turning the toggle on pre-fills 90 days and saves it', async () => {
    const ui = await harness(null)
    try {
      expect(ui.toggle().checked).toBe(false)
      await ui.dom.act(async () => ui.toggle().click())
      expect(ui.toggle().checked).toBe(true)
      expect(ui.daysInput()?.value).toBe('90')
      await ui.dom.act(async () => ui.save().click())
      await ui.settle(() => ui.patches.length === 1)
      expect(ui.patches[0]).toEqual({ consultantIdleDormancyDays: 90 })
    } finally {
      await ui.restore()
    }
  })

  test('turning the toggle off saves null', async () => {
    const ui = await harness(45)
    try {
      expect(ui.toggle().checked).toBe(true)
      await ui.dom.act(async () => ui.toggle().click())
      expect(ui.daysInput()).toBeNull()
      await ui.dom.act(async () => ui.save().click())
      await ui.settle(() => ui.patches.length === 1)
      expect(ui.patches[0]).toEqual({ consultantIdleDormancyDays: null })
    } finally {
      await ui.restore()
    }
  })
})
