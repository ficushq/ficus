import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { apiUnavailable, type ApiRoutes } from '../test/apiMock'
import { getAgentLabel } from '../lib/agentDisplay'
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

async function renderWithProvider(agentTypes: ApiRoutes[string]) {
  let reads = 0
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    api: {
      '/api/agent-types': (request) => {
        reads += 1
        return typeof agentTypes === 'function' ? agentTypes(request) : agentTypes
      },
    },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rendered = dom.createRoot()
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
    await dom.act(async () => Bun.sleep(10))
    return { text: rendered.container.querySelector('output')!.textContent, reads }
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
    const { text } = await renderWithProvider(answer)
    expect(text).toBe('Engineer (Payments) | Qa Bot')
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
