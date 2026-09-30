import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act } from 'react'
import type { SquadActivityItem, SquadActivityPage } from '@ficus/shared'
import { fakeMultiplayer, renderWith } from '../../multiplayer/testing'
import { layoutFarm, type FarmInput } from '../layout'
import { at, makeAgent, makeSquad, makeStream } from '../testFixtures'
import { FarmCardContext, type FarmCardEnv } from './context'
import { FieldLogCard } from './FieldLogCard'

const originalFetch = globalThis.fetch
const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  globalThis.fetch = originalFetch
})

const item = (id: string, over: Partial<SquadActivityItem>): SquadActivityItem => ({
  id,
  at: new Date(Date.now() - 5 * 60_000).toISOString(),
  agentId: 'w1',
  agentTypeId: 'engineer',
  kind: 'message',
  summary: `summary ${id}`,
  preview: [],
  ref: { type: 'agent', agentId: 'w1', view: 'chat' },
  ...over,
})

async function openLog(pages: Record<string, SquadActivityPage>) {
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    const cursor = new URL(url).searchParams.get('cursor') ?? 'first'
    return new Response(JSON.stringify(pages[cursor] ?? { items: [], hasMore: false, nextCursor: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const squad = makeSquad({ id: 'sq', name: 'Garden', managerAgentId: 'boss' })
  const agents = [
    makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'active' }),
    makeAgent({ id: 'w1', squadId: 'sq', status: 'active', metadata: { name: 'Wren' } }),
  ]
  const input: FarmInput = {
    squads: [squad],
    streams: [makeStream({ id: 'ws-1', squadId: 'sq', title: 'Rename the product', agentIds: ['w1'] })],
    doneCount: 0,
    canceledCount: 0,
    agents,
    assistants: [],
    pendingActions: [],
    now: at(60).getTime(),
  }
  const env = {
    layout: layoutFarm(input),
    input,
    agentsById: new Map(agents.map((a) => [a.id, a])),
    squadsById: new Map([[squad.id, squad]]),
    halted: new Set<string>(),
    select: mock(() => {}),
    openChat: mock(() => {}),
  } as unknown as FarmCardEnv
  const view = await renderWith(
    <FarmCardContext.Provider value={env}>
      <FieldLogCard squadId="sq" />
    </FarmCardContext.Provider>,
    await fakeMultiplayer()
  )
  mounted.push(view.unmount)
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))))
  await settle()
  return { container: view.container, env, requests, settle }
}

const rows = (root: ParentNode) => [...root.querySelectorAll('.g-log-row')]

describe('FieldLogCard', () => {
  it('lists what the squad robots did, newest first, with who and when', async () => {
    const { container, requests } = await openLog({
      first: {
        items: [
          item('a', { summary: 'Opened a pull request', preview: [{ text: 'Opened ' }, { text: '#12', bold: true }] }),
          item('b', { agentId: null, summary: 'A system note', ref: { type: 'workstream', workStreamId: 'gone' } }),
        ],
        hasMore: false,
        nextCursor: null,
      },
    })
    expect(requests[0]).toContain('/api/squads/sq/activity')
    expect(container.textContent).toContain('Garden · field log')
    const [first, second] = rows(container)
    expect(first!.textContent).toContain('Wren')
    expect(first!.textContent).toContain('5m ago')
    expect(first!.querySelector('strong')?.textContent).toBe('#12')
    expect(second!.textContent).toContain('Ficus')
    expect(second!.textContent).toContain('A system note')
    // A work stream that isn't on the farm any more isn't a link.
    expect(second!.tagName).toBe('DIV')
  })

  it('opens what an entry is about: the robot chat, or the plant', async () => {
    const { container, env } = await openLog({
      first: {
        items: [
          item('chat', {}),
          item('plant', { kind: 'workstream', ref: { type: 'workstream', workStreamId: 'ws-1' } }),
        ],
        hasMore: false,
        nextCursor: null,
      },
    })
    const [chat, plant] = rows(container) as HTMLButtonElement[]
    await act(async () => chat!.click())
    expect(env.openChat).toHaveBeenLastCalledWith('w1')
    await act(async () => plant!.click())
    expect(env.select).toHaveBeenLastCalledWith({ kind: 'plot', streamId: 'ws-1' })
  })

  it('filters by kind, asking the server for just those kinds', async () => {
    const { container, requests, settle } = await openLog({
      first: { items: [item('a', {})], hasMore: false, nextCursor: null },
    })
    const work = [...container.querySelectorAll<HTMLButtonElement>('.g-log-filter')].find(
      (b) => b.textContent === 'Work'
    )!
    await act(async () => work.click())
    await settle()
    expect(work.getAttribute('aria-pressed')).toBe('true')
    const last = new URL(requests.at(-1)!)
    expect(last.searchParams.getAll('kind')).toEqual(['execution', 'handoff', 'subagent', 'workstream'])
  })

  it('loads earlier entries a page at a time', async () => {
    const { container, requests, settle } = await openLog({
      first: { items: [item('new', {})], hasMore: true, nextCursor: 'c2' },
      c2: { items: [item('old', { summary: 'An older entry' })], hasMore: false, nextCursor: null },
    })
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Load earlier')!
    await act(async () => more.click())
    await settle()
    expect(requests.some((url) => new URL(url).searchParams.get('cursor') === 'c2')).toBe(true)
    expect(rows(container)).toHaveLength(2)
    expect(container.textContent).toContain('An older entry')
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Load earlier')).toBe(false)
  })

  it('says so when nothing has happened', async () => {
    const { container } = await openLog({ first: { items: [], hasMore: false, nextCursor: null } })
    expect(container.textContent).toContain('Nothing has happened here yet.')
  })
})
