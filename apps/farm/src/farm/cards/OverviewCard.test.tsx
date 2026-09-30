import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act } from 'react'
import { fakeMultiplayer, renderWith } from '../../multiplayer/testing'
import { layoutFarm, type FarmInput } from '../layout'
import { at, makeAgent, makeSquad, makeStream } from '../testFixtures'
import { FarmCardContext, type FarmCardEnv } from './context'
import { OverviewCard } from './OverviewCard'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
})

async function openOverview() {
  const garden = makeSquad({ id: 'sq', name: 'Garden', managerAgentId: 'boss' })
  const orchard = makeSquad({ id: 'sq-2', name: 'Orchard', managerAgentId: null })
  const agents = [
    makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'active', metadata: { name: 'Basil' } }),
    makeAgent({ id: 'w1', squadId: 'sq', status: 'active', metadata: { name: 'Wren' } }),
  ]
  const input: FarmInput = {
    squads: [garden, orchard],
    streams: [
      makeStream({ id: 'ws-1', squadId: 'sq', title: 'Rename the product', agentIds: ['w1'] }),
      makeStream({ id: 'ws-2', squadId: 'sq', title: 'Tidy the docs', agentIds: ['w1'] }),
    ],
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
    squadsById: new Map([garden, orchard].map((s) => [s.id, s])),
    halted: new Set<string>(),
    select: mock(() => {}),
  } as unknown as FarmCardEnv
  const view = await renderWith(
    <FarmCardContext.Provider value={env}>
      <OverviewCard />
    </FarmCardContext.Provider>,
    await fakeMultiplayer()
  )
  mounted.push(view.unmount)
  return { container: view.container, env }
}

describe('OverviewCard', () => {
  it('shows every plot with its plants and its robots, each robot once', async () => {
    const { container } = await openOverview()
    expect(container.querySelector('.g-card-text')?.textContent).toBe('2 growing in 2 plots')
    const [garden, orchard] = [...container.querySelectorAll('.g-overview-plot')]
    expect(garden!.querySelector('.g-overview-name')?.textContent).toBe('Garden')
    expect([...garden!.querySelectorAll('.g-list-title')].map((t) => t.textContent)).toEqual([
      'Rename the product',
      'Tidy the docs',
    ])
    // Wren tends both plants but shows up once, beside the farmer.
    expect([...garden!.querySelectorAll('.g-overview-robot')].map((r) => r.getAttribute('aria-label'))).toEqual([
      'Basil',
      'Wren',
    ])
    expect(orchard!.textContent).toContain('Nothing growing right now.')
    expect(orchard!.querySelector('.g-overview-robots')).toBeNull()
  })

  it('opens the plot, the plant or the robot', async () => {
    const { container, env } = await openOverview()
    const garden = container.querySelector('.g-overview-plot')!
    await act(async () => garden.querySelector<HTMLButtonElement>('.g-overview-head')!.click())
    expect(env.select).toHaveBeenLastCalledWith({ kind: 'yard', squadId: 'sq' })
    await act(async () => garden.querySelector<HTMLButtonElement>('.g-list-row')!.click())
    expect(env.select).toHaveBeenLastCalledWith({ kind: 'plot', streamId: 'ws-1' })
    await act(async () => garden.querySelector<HTMLButtonElement>('[aria-label="Wren"]')!.click())
    expect(env.select).toHaveBeenLastCalledWith({ kind: 'robot', agentId: 'w1' })
  })
})
