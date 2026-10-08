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
  type DecisionFeatureSwitch,
  type DecisionFeatureView,
  type DecisionProviderView,
  type DecisionSpend,
} from '@ficus/shared'
import type { DecisionFeature, DecisionSettings } from '../../api/decisions'
import { PermissionsProvider, type PermissionsResult } from '../../hooks/usePermissions'
import { decisionQueryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { DecisionModelsSection } from './DecisionModelsSection'
import { DEFAULT_TRY_QUESTION, DecisionTryResult } from './DecisionTryPanel'
import { featureSwitchState, formatPercent, formatPrice, formatUsd } from './decisionUi'

const jev: DecisionProviderView = {
  id: 'jev-1',
  kind: 'jev',
  label: 'Jev',
  model: 'jev-latest',
  enabled: true,
  hasApiKey: true,
  effectivePricePerMillionInput: 0.042,
}
const local: DecisionProviderView = {
  id: 'systemone-1',
  kind: 'systemone',
  label: 'Clef on the Mac mini',
  model: 'clef-flash',
  enabled: false,
  baseUrl: 'http://localhost:11434',
  hasApiKey: false,
  effectivePricePerMillionInput: 0,
}

const features = (toolSwitch: DecisionFeatureSwitch = 'auto', enabled = true): DecisionFeatureView[] =>
  DECISION_PURPOSES.map((id) => ({
    id,
    ...DECISION_PURPOSE_INFO[id],
    ...(DECISION_PURPOSE_INFO[id].scope === 'instance' ? { switch: toolSwitch } : {}),
    enabled,
  }))

const settings = (overrides: Partial<DecisionSettings> = {}): DecisionSettings => ({
  providers: [jev, local],
  routing: { default: ['jev-1', 'systemone-1'], purposes: {}, timeoutMs: 5000 },
  kinds: DECISION_PROVIDER_KIND_INFO,
  purposes: DECISION_PURPOSES.map((id) => ({ id, ...DECISION_PURPOSE_INFO[id] })),
  features: features(),
  openAIServicesKey: true,
  ...overrides,
})

const permissions = (canWrite: boolean) => (): PermissionsResult => ({
  permissions: canWrite ? ['provider-auth:read', 'provider-auth:write'] : ['provider-auth:read'],
  can: (permission) => permission === 'provider-auth:read' || (canWrite && permission === 'provider-auth:write'),
  isLoading: false,
  isError: false,
})

const noSpend = (days: number): DecisionSpend => ({
  days,
  totalUsd: 0,
  approximate: false,
  byPurpose: [],
  byProvider: [],
})

function client(data: DecisionSettings, spend: Partial<Record<1 | 7 | 30, DecisionSpend>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  queryClient.setQueryData(decisionQueryKeys.settings(), data)
  for (const [days, value] of Object.entries(spend))
    queryClient.setQueryData(decisionQueryKeys.spend(Number(days)), value)
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

/** One feature row's markup. */
const featureRow = (html: string, label: string) =>
  html.slice(html.lastIndexOf('<li', html.indexOf(`aria-label="${label}"`))).split('</li>')[0]!

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
  const dom = await acquireDomHarness({ url: 'http://localhost/settings?section=decision-providers' })
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
    const days = call.url.match(/\/decisions\/spend\?days=(\d+)/)?.[1]
    if (call.method === 'GET' && days) return Response.json(noSpend(Number(days)))
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
    expect(html).toContain('Decision Providers')
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

  test('with no providers: the add cards and the features, which need a decision model', () => {
    const html = render(
      settings({
        providers: [],
        routing: { default: [], purposes: {}, timeoutMs: 5000 },
        features: features('auto', false),
      })
    )
    expect(html).toContain('Add a decision model')
    expect(html).toContain('The first one you add answers every purpose')
    expect(html).toContain('Tool result firewall')
    expect(html).toContain('Needs a decision model')
    expect(html).toMatch(/aria-label="Use the tool result firewall"[^>]*disabled=""/)
    expect(html).not.toContain('Use default order')
    expect(html).not.toContain('Default order')
    expect(html).not.toContain('Try a decision')
  })

  test('every feature shows how it is turned on', () => {
    const html = render(settings())
    const row = (label: string) => featureRow(html, label)
    for (const purpose of DECISION_PURPOSES)
      expect(html).toContain(`aria-label="${DECISION_PURPOSE_INFO[purpose].label}"`)
    expect(row('Tool result firewall')).toContain('>On<')
    expect(row('Tool result firewall')).toContain('On by default once a decision model is set up.')
    expect(row('Tool result firewall')).toMatch(/role="switch"[^>]*checked=""/)
    expect(row('GitHub firewall')).toContain('Chosen per squad')
    expect(row('GitHub firewall')).toContain('Set in each squad&#x27;s GitHub settings.')
    expect(row('GitHub firewall')).not.toContain('role="switch"')
    expect(row('Workflow decisions')).toContain('Runs where you add it')
    expect(row('Event rule conditions')).toContain('Runs where you add it')
    // Every feature keeps its own order choice; a sub-feature's starts as its parent's.
    const subFeatures = DECISION_PURPOSES.filter((purpose) => DECISION_PURPOSE_INFO[purpose].parent)
    expect(html.match(/>Use default order</g)?.length).toBe(DECISION_PURPOSES.length - subFeatures.length)
    expect(html.match(/>Same as parent</g)?.length).toBe(subFeatures.length)
    // Switched on by hand counts as on even when auto would not be; off is off.
    expect(featureRow(render(settings({ features: features('on', false) })), 'Tool result firewall')).toContain('>On<')
    expect(featureRow(render(settings({ features: features('off', false) })), 'Tool result firewall')).toContain(
      '>Off<'
    )
  })

  test('the tool result firewall switch turns off, and back on to automatic', async () => {
    await mount(
      settings(),
      (call) =>
        call.method === 'PUT' && call.url.includes('/decisions/features/')
          ? Response.json(features((call.body as { value: DecisionFeatureSwitch }).value, true))
          : undefined,
      async ({ calls, act, document }) => {
        const toggle = () => document.querySelector('[aria-label="Use the tool result firewall"]') as HTMLInputElement
        expect(toggle().checked).toBe(true)
        await act(() => fireEvent.click(toggle()))
        const puts = calls.filter((call) => call.method === 'PUT')
        expect(puts[0]?.url).toEndWith('/decisions/features/tool-results')
        expect(puts[0]?.body).toEqual({ value: 'off' })
        expect(toggle().checked).toBe(false)
        await act(() => fireEvent.click(toggle()))
        expect(calls.filter((call) => call.method === 'PUT')[1]?.body).toEqual({ value: 'auto' })
        expect(toggle().checked).toBe(true)
      }
    )
  })

  test('shell fetches are listed under the tool result firewall, with their own switch, status and spend', () => {
    const month: DecisionSpend = {
      ...noSpend(30),
      totalUsd: 0.5,
      byPurpose: [
        { purpose: 'tool-results', calls: 40, answered: 40, inputTokens: 1000, costUsd: 0.3 },
        { purpose: 'tool-results-shell', calls: 12, answered: 12, inputTokens: 500, costUsd: 0.2 },
      ],
    }
    const html = renderToStaticMarkup(tree(client(settings(), { 30: month }), true))
    const nested = html.slice(html.indexOf('aria-label="Parts of the tool result firewall"'))
    expect(nested).toStartWith('aria-label="Parts of the tool result firewall"')
    // Nested inside the parent's row, before any other feature.
    expect(html.indexOf('aria-label="Shell fetches"')).toBeGreaterThan(
      html.indexOf('aria-label="Tool result firewall"')
    )
    expect(html.indexOf('aria-label="Shell fetches"')).toBeLessThan(html.indexOf('aria-label="GitHub firewall"'))
    const shell = featureRow(html, 'Shell fetches')
    expect(shell).toContain(DECISION_PURPOSE_INFO['tool-results-shell'].description)
    expect(shell).toContain('>On<')
    expect(shell).toContain('On by default while the tool result firewall is on.')
    expect(shell).toContain('$0.20 · 12 calls')
    expect(shell).toMatch(/aria-label="Use the tool result firewall for shell fetches"[^>]*checked=""/)
    expect(shell).toContain('Custom order')
    // Each counts only its own spend.
    expect(featureRow(html, 'Tool result firewall')).toContain('$0.30 · 40 calls')
  })

  test('with the tool result firewall off, shell fetches can’t be switched and say why', () => {
    const off = features('auto', true).map((feature) =>
      feature.id === 'tool-results'
        ? { ...feature, switch: 'off' as const, enabled: false }
        : feature.id === 'tool-results-shell'
          ? { ...feature, enabled: false }
          : feature
    )
    const shell = featureRow(render(settings({ features: off })), 'Shell fetches')
    expect(shell).toContain('>Off<')
    expect(shell).toContain('Turn on the tool result firewall first.')
    expect(shell).toMatch(/aria-label="Use the tool result firewall for shell fetches"[^>]*disabled=""/)
    expect(shell).not.toMatch(/aria-label="Use the tool result firewall for shell fetches"[^>]*checked=""/)
    // Its own switch on doesn't make it run while the parent is off.
    const forced = off.map((feature) =>
      feature.id === 'tool-results-shell' ? { ...feature, switch: 'on' as const } : feature
    )
    expect(featureRow(render(settings({ features: forced })), 'Shell fetches')).toContain('>Off<')
  })

  test('the shell fetches switch turns off, and back on to automatic', async () => {
    let current = features('auto', true)
    await mount(
      settings({ features: current }),
      (call) => {
        if (call.method !== 'PUT' || !call.url.includes('/decisions/features/')) return undefined
        const id = call.url.split('/').pop()
        const value = (call.body as { value: DecisionFeatureSwitch }).value
        current = current.map((feature) =>
          feature.id === id ? { ...feature, switch: value, enabled: value !== 'off' } : feature
        )
        return Response.json(current)
      },
      async ({ calls, act, document }) => {
        const toggle = () =>
          document.querySelector('[aria-label="Use the tool result firewall for shell fetches"]') as HTMLInputElement
        expect(toggle().checked).toBe(true)
        expect(toggle().disabled).toBe(false)
        await act(() => fireEvent.click(toggle()))
        const puts = () => calls.filter((call) => call.method === 'PUT')
        expect(puts()[0]?.url).toEndWith('/decisions/features/tool-results-shell')
        expect(puts()[0]?.body).toEqual({ value: 'off' })
        expect(toggle().checked).toBe(false)
        // The parent stays on.
        expect(
          (document.querySelector('[aria-label="Use the tool result firewall"]') as HTMLInputElement).checked
        ).toBe(true)
        await act(() => fireEvent.click(toggle()))
        expect(puts()[1]?.body).toEqual({ value: 'auto' })
        expect(toggle().checked).toBe(true)
      }
    )
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

  test('features show what they cost, with a total and a month projection marked as estimates', () => {
    const month: DecisionSpend = {
      days: 30,
      totalUsd: 1.2345,
      approximate: true,
      byPurpose: [
        { purpose: 'tool-results', calls: 1204, answered: 1200, inputTokens: 9_000_000, costUsd: 0.42 },
        { purpose: 'github-firewall', calls: 3, answered: 3, inputTokens: 900, costUsd: 0.00004 },
        { purpose: 'workflow-steps', calls: 0, answered: 0, inputTokens: 0, costUsd: 0 },
      ],
      byProvider: [{ providerId: 'jev-1', calls: 1207, inputTokens: 9_000_900, costUsd: 0.31 }],
    }
    const week: DecisionSpend = { ...month, days: 7, totalUsd: 0.7, approximate: false }
    const html = renderToStaticMarkup(tree(client(settings(), { 30: month, 7: week }), true))
    expect(html).toContain('≈ $1.23')
    expect(html).toContain('in the last 30 days')
    expect(html).toContain('about <span class="tabular-nums">$3.00</span> a month at this rate')
    expect(html).toContain(
      'Some providers don&#x27;t report tokens, or a price isn&#x27;t known, so this is an estimate.'
    )
    expect(featureRow(html, 'Tool result firewall')).toContain('≈ $0.42 · 1,204 calls')
    expect(featureRow(html, 'GitHub firewall')).toContain('≈ &lt; $0.01 · 3 calls')
    expect(featureRow(html, 'Workflow decisions')).not.toContain('calls')
    expect(featureRow(html, 'Event rule conditions')).not.toContain('$')
    // The period picker, 30 days by default.
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>30 days</)
    // Providers: their price, and what they cost this month.
    expect(featureRow(html, 'Jev')).toContain('$0.042 per million input tokens')
    expect(featureRow(html, 'Jev')).toContain('≈ $0.31 this month')
    expect(featureRow(html, 'Clef on the Mac mini')).toContain('Free')
    expect(featureRow(html, 'Clef on the Mac mini')).not.toContain('this month')
  })

  test('picking a period fetches its spend', async () => {
    await mount(
      settings(),
      () => undefined,
      async ({ calls, act, document }) => {
        const picker = document.querySelector('[aria-label="Spend period"]')!
        await act(() => fireEvent.click([...picker.querySelectorAll('button')].find((b) => b.textContent === '24h')!))
        expect(calls.some((call) => call.url.endsWith('/decisions/spend?days=1'))).toBe(true)
        expect(document.body.textContent).toContain('in the last 24 hours')
      }
    )
  })

  test('amounts and prices read naturally', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.004)).toBe('< $0.01')
    expect(formatUsd(0.426)).toBe('$0.43')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatPrice(0.042)).toBe('$0.042 per million input tokens')
    expect(formatPrice(0.1)).toBe('$0.10 per million input tokens')
    expect(formatPrice(0)).toBe('Free')
    expect(formatPrice(null)).toBe('Price unknown')
  })

  test('a provider with no known price says so', () => {
    const custom = { ...jev, id: 'jev-2', label: 'Jev beta', model: 'jev-next', effectivePricePerMillionInput: null }
    expect(featureRow(render(settings({ providers: [custom] })), 'Jev beta')).toContain('Price unknown')
  })

  test('the edit dialog sets a price, and clearing it goes back to the list price', async () => {
    const priced = { ...jev, pricePerMillionInput: 0.05, effectivePricePerMillionInput: 0.05 }
    await mount(
      settings({ providers: [priced] }),
      (call) => (call.method === 'PATCH' ? Response.json(priced) : undefined),
      async ({ calls, act, button, field, document }) => {
        expect(featureRow(document.body.innerHTML, 'Jev')).toContain('(your price)')
        await act(() => fireEvent.click(button('Edit Jev')))
        const price = field('Price per million input tokens (USD)')
        expect(price.value).toBe('0.05')
        expect(price.getAttribute('placeholder')).toBe('0.042')
        await act(() => fireEvent.input(price, { target: { value: '' } }))
        await act(() => fireEvent.click(button('Save')))
        expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
          label: 'Jev',
          model: 'jev-latest',
          pricePerMillionInput: null,
        })
      }
    )
    await mount(
      settings(),
      (call) => (call.method === 'PATCH' ? Response.json(jev) : undefined),
      async ({ calls, act, button, field }) => {
        await act(() => fireEvent.click(button('Edit Jev')))
        expect(field('Price per million input tokens (USD)').value).toBe('')
        await act(() => fireEvent.input(field('Price per million input tokens (USD)'), { target: { value: '0.03' } }))
        await act(() => fireEvent.click(button('Save')))
        expect(
          (calls.find((call) => call.method === 'PATCH')?.body as { pricePerMillionInput?: number })
            .pricePerMillionInput
        ).toBe(0.03)
      }
    )
  })

  test('a feature that is off by default reads off under auto, turns on with on, and off with auto', async () => {
    // Robot moods is not a purpose yet, so it borrows one id; only its flags matter here.
    const only = (value: DecisionFeatureSwitch): DecisionFeature[] => [
      {
        id: 'tool-results',
        label: 'Robot moods',
        description: 'Guesses how the agents feel.',
        scope: 'instance',
        switch: value,
        enabled: value === 'on',
        offByDefault: true,
      },
    ]
    // Core may report it could run (a model exists), but auto still means off for it.
    expect(featureSwitchState({ ...only('auto')[0]!, enabled: true })).toEqual({
      on: false,
      offByDefault: true,
      turnOn: 'on',
      turnOff: 'auto',
    })
    expect(featureSwitchState(features('auto', true)[0]!)).toEqual({
      on: true,
      offByDefault: false,
      turnOn: 'auto',
      turnOff: 'off',
    })
    await mount(
      settings({ features: only('auto') }),
      (call) =>
        call.method === 'PUT' && call.url.includes('/decisions/features/')
          ? Response.json(only((call.body as { value: DecisionFeatureSwitch }).value))
          : undefined,
      async ({ calls, act, document }) => {
        const row = () => featureRow(document.body.innerHTML, 'Robot moods')
        expect(row()).toContain("Off by default; turn on if it's worth the cost.")
        expect(row()).toContain('>Off<')
        const toggle = () => document.querySelector('[aria-label="Use the robot moods"]') as HTMLInputElement
        expect(toggle().checked).toBe(false)
        await act(() => fireEvent.click(toggle()))
        expect(calls.filter((call) => call.method === 'PUT')[0]?.body).toEqual({ value: 'on' })
        expect(toggle().checked).toBe(true)
        await act(() => fireEvent.click(toggle()))
        expect(calls.filter((call) => call.method === 'PUT')[1]?.body).toEqual({ value: 'auto' })
        expect(toggle().checked).toBe(false)
      }
    )
  })
})
