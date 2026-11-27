import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { apiUnavailable, type ApiRoutes } from '../test/apiMock'
import { getAgentLabel } from '../lib/agentDisplay'
import { agentTypeNamesStorageKey } from '../lib/agentTypeNamesStorage'
import { getApiUrl } from '../api/client'
import { AgentTypeNamesProvider, StaticAgentTypeNames, useAgentTypeNames } from './useAgentTypeNames'

const builder = { id: 'a', agentTypeId: 'engineer', metadata: { purpose: 'Payments' } } as unknown as Agent
const custom = { id: 'b', agentTypeId: 'qa-bot', metadata: {} } as unknown as Agent

function Labels() {
  const typeNames = useAgentTypeNames()
  return (
    <output>
      {getAgentLabel(builder, undefined, typeNames)} | {getAgentLabel(custom, undefined, typeNames)}
    </output>
  )
}

async function renderWithProvider(
  agentTypes: ApiRoutes[string],
  { remembered, beforeAnswer }: { remembered?: string; beforeAnswer?: (text: string | null) => void } = {}
) {
  let reads = 0
  let answer: () => void = () => {}
  const answered = new Promise<void>((resolve) => (answer = resolve))
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    api: {
      '/api/agent-types': async (request) => {
        reads += 1
        if (beforeAnswer) await answered
        return typeof agentTypes === 'function' ? agentTypes(request) : agentTypes
      },
    },
  })
  const storageKey = agentTypeNamesStorageKey(getApiUrl())
  if (remembered !== undefined) window.localStorage.setItem(storageKey, remembered)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rendered = dom.createRoot()
  const shown = () => rendered.container.querySelector('output')!.textContent
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={client}>
          <AgentTypeNamesProvider>
            <Labels />
            <Labels />
          </AgentTypeNamesProvider>
        </QueryClientProvider>
      )
    )
    if (beforeAnswer) {
      beforeAnswer(shown())
      answer()
    }
    await dom.act(async () => Bun.sleep(10))
    return { text: shown(), reads, stored: window.localStorage.getItem(storageKey) }
  } finally {
    await dom.cleanup()
    client.clear()
  }
}

test('one shared read names every agent by its configured type name, custom types included', async () => {
  const { text, reads } = await renderWithProvider([
    { id: 'engineer', name: 'Builder' },
    { id: 'qa-bot', name: 'Release QA' },
  ])
  expect(text).toBe('Builder (Payments) | Release QA')
  expect(reads).toBe(1)
})

test('without the list (refused or unreachable) labels fall back to the title-cased type id', async () => {
  for (const answer of [new Response(null, { status: 403 }), apiUnavailable]) {
    const { text, stored } = await renderWithProvider(answer)
    expect(text).toBe('Engineer (Payments) | Qa Bot')
    expect(stored).toBeNull()
  }
})

test('a page load names agents from the last read until the new read answers, then remembers it', async () => {
  let firstPaint: string | null = null
  const { text, stored } = await renderWithProvider(
    [
      { id: 'engineer', name: 'Implementer' },
      { id: 'qa-bot', name: 'Release QA' },
    ],
    {
      remembered: JSON.stringify({ engineer: 'Builder', 'qa-bot': 'Release QA' }),
      beforeAnswer: (shown) => (firstPaint = shown),
    }
  )
  // No title-cased "Engineer" or "Qa Bot" before the read: the remembered names hold the labels.
  expect(firstPaint).toBe('Builder (Payments) | Release QA')
  // A rename since the last visit takes over when the read answers, and is remembered for next time.
  expect(text).toBe('Implementer (Payments) | Release QA')
  expect(JSON.parse(stored!)).toEqual({ engineer: 'Implementer', 'qa-bot': 'Release QA' })
})

test('the first read in a browser is remembered for the next page load', async () => {
  const { stored } = await renderWithProvider([
    { id: 'engineer', name: 'Builder' },
    { id: 'blank', name: '  ' },
  ])
  expect(JSON.parse(stored!)).toEqual({ engineer: 'Builder' })
})

test('an unreachable server keeps the remembered names; a refusal forgets them', async () => {
  const remembered = JSON.stringify({ engineer: 'Builder' })
  const offline = await renderWithProvider(apiUnavailable, { remembered })
  expect(offline.text).toBe('Builder (Payments) | Qa Bot')
  expect(offline.stored).toBe(remembered)

  const refused = await renderWithProvider(new Response(null, { status: 403 }), { remembered })
  expect(refused.text).toBe('Engineer (Payments) | Qa Bot')
  expect(refused.stored).toBeNull()
})

test('unreadable remembered names are ignored', async () => {
  for (const remembered of ['not json', '["Builder"]', JSON.stringify({ engineer: 7 })]) {
    let firstPaint: string | null = null
    await renderWithProvider([{ id: 'engineer', name: 'Builder' }], {
      remembered,
      beforeAnswer: (shown) => (firstPaint = shown),
    })
    expect(firstPaint).toBe('Engineer (Payments) | Qa Bot')
  }
})

test('outside the provider nothing is read and the title-cased id is used', () => {
  expect(renderToStaticMarkup(<Labels />)).toBe('<output>Engineer (Payments) | Qa Bot</output>')
  expect(
    renderToStaticMarkup(
      <StaticAgentTypeNames names={{ engineer: 'Builder' }}>
        <Labels />
      </StaticAgentTypeNames>
    )
  ).toBe('<output>Builder (Payments) | Qa Bot</output>')
})
