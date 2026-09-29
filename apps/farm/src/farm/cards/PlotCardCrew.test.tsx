import { afterEach, describe, expect, it, mock } from 'bun:test'
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

async function openPlot(assignee: 'w1' | null, halted: string[] = []) {
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

  it('says who it is assigned to when they are not at work, and halted ones stand out', async () => {
    const card = await openPlot('w1', ['w1'])
    const lead = card.querySelector('.g-plot-lead')!
    expect(lead.textContent).toContain('Assigned to')
    expect(pills(lead)).toEqual([['Halted', 'halted']])
  })
})
