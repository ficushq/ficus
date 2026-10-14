import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act } from 'react'
import { fakeMultiplayer, renderWith } from '../../multiplayer/testing'
import { layoutFarm, type FarmInput } from '../layout'
import { moodStore } from '../moods'
import { makeAgent, makeAgentError, makeSquad, makeStream } from '../testFixtures'
import { FarmCardContext, type FarmCardEnv } from './context'
import { RobotCard } from './RobotCard'

const ROBOT = '00000000-0000-4000-8000-000000000001'
const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  moodStore.reset()
})

async function openRobot({ halted = false } = {}) {
  const squad = makeSquad({ id: 'sq', name: 'Garden' })
  const agents = [makeAgent({ id: ROBOT, squadId: 'sq', metadata: { name: 'Robo' } })]
  const input: FarmInput = {
    squads: [squad],
    streams: [makeStream({ id: 'ws', squadId: 'sq', agentIds: [ROBOT], ownerAgentId: ROBOT, status: 'active' })],
    doneCount: 0,
    canceledCount: 0,
    agents,
    assistants: [],
    pendingActions: halted ? [makeAgentError(ROBOT, 'sq')] : [],
    now: 0,
  }
  const layout = layoutFarm(input)
  const env = {
    layout,
    input,
    agentsById: new Map(agents.map((a) => [a.id, a])),
    squadsById: new Map([[squad.id, squad]]),
    halted: new Set(halted ? [ROBOT] : []),
    select: mock(() => {}),
    openChat: mock(() => {}),
    shareInChat: mock(() => {}),
  } as unknown as FarmCardEnv
  const view = await renderWith(
    <FarmCardContext.Provider value={env}>
      <RobotCard agentId={ROBOT} />
    </FarmCardContext.Provider>,
    await fakeMultiplayer()
  )
  mounted.push(view.unmount)
  return view.container
}

const tag = (container: HTMLElement) => container.querySelector('.g-state-tag')

describe('RobotCard mood', () => {
  it('says the mood in words while moods are on', async () => {
    const container = await openRobot()
    expect(tag(container)?.textContent).toBe('Working')
    act(() => moodStore.apply({ agentId: ROBOT, mood: 'risky', source: 'model', at: 1 }))
    expect(tag(container)?.textContent).toBe('Working · About to do something risky')
    expect(tag(container)?.getAttribute('title')).toBe('Mood: About to do something risky')
  })

  it('a halted robot says that instead', async () => {
    const container = await openRobot({ halted: true })
    act(() => moodStore.apply({ agentId: ROBOT, mood: 'struggling', source: 'model', at: 1 }))
    expect(tag(container)?.textContent).toBe('Halted — needs a nudge')
  })
})
