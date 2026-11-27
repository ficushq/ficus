import { describe, expect, test } from 'bun:test'
import type { AgentStatus } from '@ficus/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { queries } from '../../queryOptions'
import { hasWorkingAgent, SquadList } from './SquadList'

function agents(...statuses: AgentStatus[]) {
  return statuses.map((status, index) => ({ id: String(index), status }))
}

describe('hasWorkingAgent', () => {
  test('only exact active agents claim activity in progress', () => {
    expect(hasWorkingAgent(agents('active'))).toBe(true)
    expect(hasWorkingAgent(agents('idle'))).toBe(false)
    expect(hasWorkingAgent(agents('waiting-input'))).toBe(false)
    expect(hasWorkingAgent(agents('compacting'))).toBe(false)
    expect(hasWorkingAgent(agents('resetting'))).toBe(false)
    expect(hasWorkingAgent(agents('idle', 'active'))).toBe(true)
  })
})

describe('squad cards', () => {
  const squad = { id: 'sq', name: 'Chlea', purpose: 'Short', status: 'active', isAnonymous: false, avatarUrl: null }
  const agent = (id: string, status: AgentStatus, agentTypeId = 'engineer') => ({
    id,
    squadId: 'sq',
    agentTypeId,
    status,
  })

  function renderCards(
    squadAgents: ReturnType<typeof agent>[],
    workStreams: Record<string, unknown>[] = [],
    pendingActions: Record<string, unknown>[] = []
  ) {
    const client = new QueryClient()
    client.setQueryData(queries.squads.list('active').queryKey, [squad] as never)
    // The cards count agents from summary rows of the live ones, not the full agent list.
    client.setQueryData(queries.agents.summaries({ live: true }).queryKey, squadAgents as never)
    client.setQueryData(queries.squads.activeWorkStreams().queryKey, workStreams as never)
    client.setQueryData(queries.actions.pending().queryKey, pendingActions as never)
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SquadList />
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  test('show the active agent count alone, and pin the counts to the card bottom', () => {
    const html = renderCards([agent('a', 'active'), agent('b', 'idle'), agent('c', 'idle')])
    expect(html).toContain('1 active agent<')
    expect(html).not.toMatch(/\d+\/\d+ active agents?/)
    expect(html).toContain('mt-auto flex items-center gap-3 text-xs text-muted')
  })

  test('count an active consultant like any other agent', () => {
    const html = renderCards([agent('c', 'active', 'consultant')])
    expect(html).toContain('1 active agent<')
    expect(html).toContain('Agent activity in progress')
  })

  const work = (number: number, updatedAt: string, extra: Record<string, unknown> = {}) => ({
    id: `ws-${number}`,
    number,
    title: `Stream ${number}`,
    squadId: 'sq',
    status: 'active',
    updatedAt,
    createdAt: updatedAt,
    openWaits: [],
    ...extra,
  })

  function rowTitles(html: string) {
    return [
      ...html.matchAll(/data-testid="squad-card-work-row"[^>]*>[\s\S]*?<span class="min-w-0[^"]*">([^<]*)</g),
    ].map((match) => match[1])
  }

  test('list the active work as rows that open each stream, with the viewer’s first', () => {
    const html = renderCards(
      [],
      [
        work(1, '2026-11-20T00:00:00Z'),
        work(2, '2026-11-25T00:00:00Z'),
        work(3, '2026-11-01T00:00:00Z'),
        work(4, '2026-11-22T00:00:00Z', { status: 'queued' }),
      ],
      [
        {
          id: 'r',
          type: 'workstream-review',
          priority: 2,
          createdAt: '',
          canRespond: true,
          data: { workStreamId: 'ws-3' },
        },
      ]
    )
    expect(rowTitles(html)).toEqual(['#3 · Stream 3', '#2 · Stream 2', '#4 · Stream 4', '#1 · Stream 1'])
    expect(html).toContain('href="/squads/sq/work?ws=3"')
    expect(html).toContain('Queued</span>')
    expect(html).not.toContain('more</a>')
    expect(html).not.toContain('No active work')
  })

  test('show four rows, then a "+N more" link to the squad’s Work tab', () => {
    const html = renderCards(
      [],
      [1, 2, 3, 4, 5, 6].map((n) => work(n, `2026-11-2${n}T00:00:00Z`))
    )
    expect(rowTitles(html)).toEqual(['#6 · Stream 6', '#5 · Stream 5', '#4 · Stream 4', '#3 · Stream 3'])
    expect(html).toMatch(
      /<a [^>]*aria-label="2 more active work streams in Chlea" href="\/squads\/sq\/work"[^>]*>\+2 more<\/a>/
    )
  })

  test('a squad with no active work says so in one quiet line', () => {
    const html = renderCards([], [work(1, '2026-11-20T00:00:00Z', { status: 'done' })])
    expect(html).toContain('<p class="mb-3 text-sm text-muted">No active work</p>')
    expect(rowTitles(html)).toEqual([])
  })

  test('the card opens the squad without wrapping the rows in its link', () => {
    const html = renderCards([], [work(1, '2026-11-20T00:00:00Z')])
    // One stretched link to the squad, the row's link to its stream, and no link inside another.
    expect(html).toMatch(/<a class="[^"]*after:absolute after:inset-0[^"]*" href="\/squads\/sq"[^>]*>Chlea<\/a>/)
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*<a /)
    // The drag handle stays on the card, above the stretched link.
    expect(html).toMatch(
      /<button[^>]*class="[^"]*absolute bottom-2 right-2 z-10[^"]*"[^>]*aria-label="Drag to reorder Chlea"/
    )
  })
})
