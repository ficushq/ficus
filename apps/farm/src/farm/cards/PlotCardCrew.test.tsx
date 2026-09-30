import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act } from 'react'
import { fakeMultiplayer, renderWith } from '../../multiplayer/testing'
import { layoutFarm, type FarmInput } from '../layout'
import { at, makeAgent, makeSquad, makeStream } from '../testFixtures'
import { FarmCardContext, type FarmCardEnv } from './context'
import { PlotCard } from './PlotCard'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
})

const TITLE = 'Rename the product'

const openChat = mock((_agentId: string) => {})

async function openPlot(assignee: 'w1' | null, halted: string[] = [], description?: string) {
  openChat.mockClear()
  const squad = makeSquad({ id: 'sq', name: 'Garden', managerAgentId: 'boss' })
  const agents = [
    makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'active' }),
    makeAgent({ id: 'w1', squadId: 'sq', status: 'active', metadata: { name: `architect · ${TITLE}` } }),
    makeAgent({ id: 'w2', squadId: 'sq', status: 'waiting-input', metadata: { name: 'Wren' } }),
    makeAgent({ id: 'c1', squadId: 'sq', status: 'idle', metadata: { name: 'Egret' } }),
  ]
  const input: FarmInput = {
    squads: [squad],
    streams: [
      makeStream({
        id: 'ws',
        squadId: 'sq',
        title: TITLE,
        assigneeAgentId: assignee,
        agentIds: ['w1', 'w2'],
        creatorAgentId: 'c1',
        ...(description ? { description } : {}),
      }),
    ],
    doneCount: 0,
    canceledCount: 0,
    agents,
    assistants: [],
    pendingActions: [],
    now: at(60 * 24 * 10).getTime(),
  }
  const env = {
    layout: layoutFarm(input),
    input,
    agentsById: new Map(agents.map((a) => [a.id, a])),
    squadsById: new Map([[squad.id, squad]]),
    halted: new Set(halted),
    select: mock(() => {}),
    shareInChat: mock(() => {}),
    openChat,
  } as unknown as FarmCardEnv
  const view = await renderWith(
    <FarmCardContext.Provider value={env}>
      <PlotCard streamId="ws" />
    </FarmCardContext.Provider>,
    await fakeMultiplayer()
  )
  mounted.push(view.unmount)
  return view.container
}

const pills = (root: ParentNode) =>
  [...root.querySelectorAll('.g-status-pill')].map((pill) => [pill.textContent, pill.getAttribute('data-tone')])

describe('PlotCard crew', () => {
  it('leads with who is working on it, then the rest of the crew, each with a status pill', async () => {
    const card = await openPlot('w1')
    const lead = card.querySelector('[aria-label="Who’s on it"], [aria-label="Who\'s on it"]')!
    expect(lead.textContent).toContain('Working on it')
    expect(lead.textContent).toContain('architect')
    expect(pills(lead)).toEqual([['Working', 'working']])
    expect(card.textContent).toContain('Also on the crew')
    const crew = [...card.querySelectorAll('.g-crew')].at(-1)!
    expect(crew.textContent).toContain('Wren')
    expect(crew.textContent).toContain('Creator')
    expect(pills(crew)).toEqual([
      ['Waiting for you', 'needs'],
      ['Idle', 'quiet'],
    ])
    // The stream's own title isn't repeated in the names listed on it.
    expect(lead.querySelector('.g-crew-name')?.textContent).toBe('architect')
    expect(lead.textContent).not.toContain(TITLE)
  })

  it('puts a Talk button beside the lead and each crew member, opening their chat in one tap', async () => {
    const card = await openPlot('w1')
    const lead = card.querySelector('.g-plot-lead')!
    const leadTalk = lead.querySelector<HTMLButtonElement>('.g-crew-talk')!
    expect(leadTalk).not.toBeNull()
    await act(async () => leadTalk.click())
    expect(openChat).toHaveBeenLastCalledWith('w1')

    const crewTalks = [
      ...[...card.querySelectorAll('.g-crew')].at(-1)!.querySelectorAll<HTMLButtonElement>('.g-crew-talk'),
    ]
    expect(crewTalks).toHaveLength(2)
    await act(async () => crewTalks[0]!.click())
    expect(openChat).toHaveBeenLastCalledWith('w2')
  })

  it('shows the description last, folded when long, with Show more', async () => {
    const long = `${'The checklist should explain every step. '.repeat(12)}\n\nAnd a closing line.`
    const card = await openPlot('w1', [], long)
    const headings = [...card.querySelectorAll('h3')].map((h) => h.textContent)
    expect(headings.at(-1)).toBe('Description')
    const text = card.querySelector('.g-expandable-md')!
    expect(text.textContent).toContain('And a closing line.')
    expect(text.getAttribute('data-folded')).toBe('true')
    const toggle = card.querySelector<HTMLButtonElement>('.g-expandable-toggle')!
    expect(toggle.textContent).toBe('Show more')
    await act(async () => toggle.click())
    expect(text.getAttribute('data-folded')).toBeNull()
    expect(toggle.textContent).toBe('Show less')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('renders the description as markdown, not raw syntax', async () => {
    const card = await openPlot('w1', [], '## Goal\n\n1. Cache the **slug** map.\n2. Keep `first paint` the same.')
    const md = card.querySelector('.g-expandable-md .g-card-md')!
    expect(md.querySelector('h2')?.textContent).toBe('Goal')
    expect([...md.querySelectorAll('ol > li')]).toHaveLength(2)
    expect(md.querySelector('strong')?.textContent).toBe('slug')
    expect(md.querySelector('code')?.textContent).toBe('first paint')
    expect(md.textContent).not.toContain('##')
  })

  it('shows a short description whole, with no toggle', async () => {
    const card = await openPlot('w1', [], 'Rename it everywhere.')
    expect(card.querySelector('.g-expandable-md')?.getAttribute('data-folded')).toBeNull()
    expect(card.querySelector('.g-expandable-toggle')).toBeNull()
  })

  it('says who it is assigned to when they are not at work, and halted ones stand out', async () => {
    const card = await openPlot('w1', ['w1'])
    const lead = card.querySelector('.g-plot-lead')!
    expect(lead.textContent).toContain('Assigned to')
    expect(pills(lead)).toEqual([['Halted', 'halted']])
  })
})
