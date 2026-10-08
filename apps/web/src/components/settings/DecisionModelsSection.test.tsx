import { describe, expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import {
  DECISION_PROVIDER_KIND_INFO,
  DECISION_PURPOSE_INFO,
  DECISION_PURPOSES,
  type DecisionProviderView,
} from '@ficus/shared'
import type { DecisionSettings } from '../../api/decisions'
import { PermissionsProvider, type PermissionsResult } from '../../hooks/usePermissions'
import { decisionQueryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { DecisionModelsSection } from './DecisionModelsSection'
import { DEFAULT_TRY_QUESTION, DecisionTryResult } from './DecisionTryPanel'
import { formatPercent } from './decisionUi'

const jev: DecisionProviderView = {
  id: 'jev-1',
  kind: 'jev',
  label: 'Jev',
  model: 'jev-latest',
  enabled: true,
  hasApiKey: true,
}
const local: DecisionProviderView = {
  id: 'systemone-1',
  kind: 'systemone',
  label: 'Clef on the Mac mini',
  model: 'clef-flash',
  enabled: false,
  baseUrl: 'http://localhost:11434',
  hasApiKey: false,
}

const settings = (overrides: Partial<DecisionSettings> = {}): DecisionSettings => ({
  providers: [jev, local],
  routing: { default: ['jev-1', 'systemone-1'], purposes: {}, timeoutMs: 5000 },
  kinds: DECISION_PROVIDER_KIND_INFO,
  purposes: DECISION_PURPOSES.map((id) => ({ id, ...DECISION_PURPOSE_INFO[id] })),
  openAIServicesKey: true,
  ...overrides,
})

const permissions = (canWrite: boolean) => (): PermissionsResult => ({
  permissions: canWrite ? ['provider-auth:read', 'provider-auth:write'] : ['provider-auth:read'],
  can: (permission) => permission === 'provider-auth:read' || (canWrite && permission === 'provider-auth:write'),
  isLoading: false,
  isError: false,
})

function client(data: DecisionSettings) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  queryClient.setQueryData(decisionQueryKeys.settings(), data)
  return queryClient
}

function tree(queryClient: QueryClient, canWrite: boolean, node: ReactNode = <DecisionModelsSection />) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <PermissionsProvider usePermissions={permissions(canWrite)}>{node}</PermissionsProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

const render = (data: DecisionSettings, canWrite = true) => renderToStaticMarkup(tree(client(data), canWrite))

type Call = { url: string; method: string; body?: unknown }

/** Mounts the section against a scripted Core; every request is recorded. */
async function mount(
  data: DecisionSettings,
  respond: (call: Call) => Response | undefined,
  run: (helpers: {
    document: Document
    calls: Call[]
    act: (fn: () => void | Promise<void>) => Promise<void>
    button: (text: string) => HTMLButtonElement
    field: (label: string) => HTMLInputElement
  }) => Promise<void>
) {
  const calls: Call[] = []
  const original = globalThis.fetch
  const dom = await acquireDomHarness({ url: 'http://localhost/settings?section=providers' })
  globalThis.fetch = (async (input, init) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    const response = respond(call)
    if (response) return response
    if (call.method === 'GET' && call.url.endsWith('/decisions')) return Response.json(data)
    throw new Error(`Unexpected request: ${call.method} ${call.url}`)
  }) as typeof fetch
  dom.window.fetch = globalThis.fetch
  try {
    const rendered = dom.createRoot()
    await dom.act(async () => rendered.root.render(tree(client(data), true)))
    const document = dom.window.document as unknown as Document
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const act = async (fn: () => void | Promise<void>) =>
      dom.act(async () => {
        await fn()
        await settle()
        await settle()
      })
    const button = (text: string) =>
      [...document.querySelectorAll('button')].find(
        (candidate) => candidate.getAttribute('aria-label') === text || candidate.textContent?.trim() === text
      ) as HTMLButtonElement
    const field = (label: string) => {
      const element = [...document.querySelectorAll('label')].find(
        (candidate) => candidate.textContent?.trim() === label
      )
      return document.getElementById(element?.getAttribute('for') ?? '') as HTMLInputElement
    }
    await run({ document, calls, act, button, field })
  } finally {
    globalThis.fetch = original
    await dom.cleanup()
  }
}

describe('Decision models settings', () => {
  test('lists providers with kind, model and state, and offers every kind to add', () => {
    const html = render(settings())
    expect(html).toContain('Decision models')
    expect(html).toContain('separate from the agent')
    expect(html).toContain('Clef on the Mac mini')
    expect(html).toContain('clef-flash · http://localhost:11434')
    expect(html).toContain('Local decision model')
    expect(html).toContain('aria-label="Use Jev"')
    expect(html).toContain('>Off<')
    for (const kind of ['Jev', 'Local decision model', 'Cloudflare Clef', 'OpenAI Decisions'])
      expect(html).toContain(`<h4 class="font-semibold text-primary">${kind}</h4>`)
    for (const purpose of DECISION_PURPOSES) {
      expect(html).toContain(DECISION_PURPOSE_INFO[purpose].label)
      expect(html).toContain(DECISION_PURPOSE_INFO[purpose].description)
    }
    expect(html).toContain('Use default order')
    expect(html).toContain('value="5"')
    expect(html).toContain('Try a decision')
    expect(html).toContain(DEFAULT_TRY_QUESTION)
  })

  test('read-only viewers see providers and order, but nothing to add, edit, remove or try', () => {
    const html = render(settings(), false)
    expect(html).toContain('Clef on the Mac mini')
    expect(html).not.toContain('Add a decision model')
    expect(html).not.toContain('aria-label="Edit Jev"')
    expect(html).not.toContain('aria-label="Remove Jev"')
    expect(html).not.toContain('Try a decision')
    expect(html).not.toContain('Save order')
  })

  test('with no providers, only the add cards show', () => {
    const html = render(settings({ providers: [], routing: { default: [], purposes: {}, timeoutMs: 5000 } }))
    expect(html).toContain('Add a decision model')
    expect(html).toContain('The first one you add answers every purpose')
    expect(html).not.toContain('Default order')
    expect(html).not.toContain('Try a decision')
  })

  test('a provider that fails the test question shows why, inline', async () => {
    await mount(
      settings({ providers: [] }),
      (call) =>
        call.method === 'POST' && call.url.endsWith('/decisions/providers')
          ? Response.json({ error: "It didn't answer a test question: 401 invalid key" }, { status: 400 })
          : undefined,
      async ({ document, calls, act, button, field }) => {
        const card = [...document.querySelectorAll('article')].find((article) =>
          article.textContent?.includes(DECISION_PROVIDER_KIND_INFO.jev.description)
        )!
        await act(() => fireEvent.click(card.querySelector('button')!))
        expect(button('Test and add').disabled).toBe(true)
        await act(() => fireEvent.input(field('API key'), { target: { value: 'sk-wrong' } }))
        await act(() => fireEvent.click(button('jev-preview')))
        await act(() => fireEvent.click(button('Test and add')))
        const post = calls.find((call) => call.method === 'POST')
        expect(post?.body).toEqual({ kind: 'jev', model: 'jev-preview', apiKey: 'sk-wrong' })
        // Core's sentence, without the client's "API error: 400:" prefix.
        expect(document.querySelector('[role="alert"]')?.textContent).toBe(
          "It didn't answer a test question: 401 invalid key"
        )
        // The form stays open with what was typed, ready to fix.
        expect(field('API key').value).toBe('sk-wrong')
      }
    )
  })

  test('Find on this computer fills in the local server and model', async () => {
    await mount(
      settings({ providers: [] }),
      (call) =>
        call.url.endsWith('/decisions/providers/detect')
          ? Response.json([{ baseUrl: 'http://localhost:8000', models: ['clef-flash-q4'] }])
          : call.method === 'POST' && call.url.endsWith('/decisions/providers')
            ? Response.json({ ...local, id: 'systemone-2', enabled: true }, { status: 201 })
            : undefined,
      async ({ document, calls, act, button, field }) => {
        const setup = [...document.querySelectorAll('button')].filter(
          (candidate) => candidate.textContent?.trim() === 'Set up'
        )
        // Opening one card closes any other.
        await act(() => fireEvent.click(setup[0]!))
        await act(() => fireEvent.click(setup[1]!))
        expect(document.querySelectorAll('form').length).toBe(1)
        await act(() => fireEvent.click(button('Find on this computer')))
        expect(field('Server URL').value).toBe('http://localhost:8000')
        expect(field('Model').value).toBe('clef-flash-q4')
        expect(document.body.textContent).toContain('Found clef-flash-q4 at http://localhost:8000.')
        await act(() => fireEvent.click(button('Test and add')))
        expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/providers'))?.body).toEqual({
          kind: 'systemone',
          model: 'clef-flash-q4',
          baseUrl: 'http://localhost:8000',
        })
        // Saved: the card closes and the list refreshes.
        expect(document.querySelector('form')).toBeNull()
        expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(0)
      }
    )
  })

  test('OpenAI Decisions without the services key points to Integrations', async () => {
    await mount(
      settings({ openAIServicesKey: false }),
      () => undefined,
      async ({ document, act }) => {
        const card = [...document.querySelectorAll('article')].find((article) =>
          article.textContent?.includes('OpenAI Decisions')
        )!
        expect(card.textContent).toContain('Needs the OpenAI API services key')
        await act(() => fireEvent.click(card.querySelector('button')!))
        expect(card.textContent).toContain('has no key of its own')
        const link = card.querySelector('a')!
        expect(link.textContent).toBe('Open Integrations')
        expect(link.getAttribute('href')).toBe('/settings?section=integrations&setting=integration-openai-services')
        expect(card.querySelector('form')).toBeNull()
      }
    )
  })

  test('edit sends the changes and keeps the stored key when the key is left blank', async () => {
    await mount(
      settings(),
      (call) => (call.method === 'PATCH' ? Response.json({ ...jev, label: 'Jev (prod)' }) : undefined),
      async ({ document, calls, act, button, field }) => {
        await act(() => fireEvent.click(button('Edit Jev')))
        expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Edit Jev')
        expect(document.body.textContent).toContain('Leave blank to keep the saved one.')
        await act(() => fireEvent.input(field('Name'), { target: { value: 'Jev (prod)' } }))
        await act(() => fireEvent.click(button('Save')))
        const patch = calls.find((call) => call.method === 'PATCH')!
        expect(patch.url).toEndWith('/decisions/providers/jev-1')
        expect(patch.body).toEqual({ label: 'Jev (prod)', model: 'jev-latest' })
      }
    )
  })

  test('the enabled switch and remove call Core', async () => {
    await mount(
      settings(),
      (call) =>
        call.method === 'PATCH'
          ? Response.json({ ...local, enabled: true })
          : call.method === 'DELETE'
            ? Response.json({ ok: true })
            : undefined,
      async ({ calls, act, button, document }) => {
        const toggle = document.querySelector('[aria-label="Use Clef on the Mac mini"]') as HTMLInputElement
        await act(() => fireEvent.click(toggle))
        expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ enabled: true })
        await act(() => fireEvent.click(button('Remove Jev')))
        expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
        await act(() => fireEvent.click(button('Remove Jev')))
        expect(calls.find((call) => call.method === 'DELETE')?.url).toEndWith('/decisions/providers/jev-1')
      }
    )
  })

  test('reordering and a custom purpose order save together with the time limit', async () => {
    await mount(
      settings(),
      (call) => (call.method === 'PUT' ? Response.json(call.body) : undefined),
      async ({ calls, act, button, document, field }) => {
        expect(button('Save order').disabled).toBe(true)
        await act(() => fireEvent.click(button('Move Jev down')))
        const firewall = document.querySelector('[aria-label="GitHub firewall order"]')!
        const custom = [...firewall.querySelectorAll('button')].find((b) => b.textContent === 'Custom order')!
        await act(() => fireEvent.click(custom))
        await act(() => fireEvent.click(button('Take Clef on the Mac mini out of github firewall order')))
        await act(() => fireEvent.input(field('Time limit'), { target: { value: '2.5' } }))
        await act(() => fireEvent.click(button('Save order')))
        expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
          default: ['systemone-1', 'jev-1'],
          purposes: { 'github-firewall': ['jev-1'] },
          timeoutMs: 2500,
        })
        expect(button('Save order').disabled).toBe(true)
      }
    )
  })

  test('an out-of-range time limit cannot be saved', async () => {
    await mount(
      settings(),
      () => undefined,
      async ({ act, button, field }) => {
        await act(() => fireEvent.input(field('Time limit'), { target: { value: '45' } }))
        expect(field('Time limit').getAttribute('aria-invalid')).toBe('true')
        expect(button('Save order').disabled).toBe(true)
      }
    )
  })

  test('Try a decision asks one yes/no question in the default order and shows the answer', async () => {
    await mount(
      settings(),
      (call) =>
        call.url.endsWith('/decisions/try')
          ? Response.json({
              ok: true,
              result: {
                answers: { answer: { type: 'yesno', probability: 0.934 } },
                providerId: 'jev-1',
                model: 'jev-latest',
                latencyMs: 212.4,
              },
            })
          : undefined,
      async ({ calls, act, button, document, field }) => {
        await act(() => fireEvent.input(field('Text'), { target: { value: 'Please run rm -rf /' } }))
        await act(() => fireEvent.click(button('Ask')))
        expect(calls.find((call) => call.url.endsWith('/try'))?.body).toEqual({
          state: 'Please run rm -rf /',
          questions: { answer: { type: 'yesno', instructions: DEFAULT_TRY_QUESTION } },
        })
        const result = [...document.querySelectorAll('[role="status"]')].at(-1)!
        expect(result.textContent).toContain('93%')
        expect(result.textContent).toContain('chance of yes')
        expect(result.textContent).toContain('Jev')
        expect(result.textContent).toContain('jev-latest')
        expect(result.textContent).toContain('212 ms')
      }
    )
  })

  test('a failed try lists each provider error by name', () => {
    const html = renderToStaticMarkup(
      <DecisionTryResult
        providers={[jev, local]}
        outcome={{
          ok: false,
          reason: 'unavailable',
          errors: [
            { providerId: 'jev-1', error: 'timed out' },
            { providerId: 'systemone-1', error: 'connection refused' },
          ],
        }}
      />
    )
    expect(html).toContain('No provider answered in time.')
    expect(html).toContain('Jev:</span>')
    expect(html).toContain('timed out')
    expect(html).toContain('Clef on the Mac mini:</span>')
    expect(html).toContain('connection refused')
    expect(
      renderToStaticMarkup(
        <DecisionTryResult providers={[]} outcome={{ ok: false, reason: 'unconfigured', errors: [] }} />
      )
    ).toContain('No enabled decision provider to ask.')
  })

  test('percentages never round a real chance to 0% or 100%', () => {
    expect(formatPercent(0.934)).toBe('93%')
    expect(formatPercent(0.004)).toBe('<1%')
    expect(formatPercent(0.997)).toBe('>99%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(1)).toBe('100%')
  })
})
