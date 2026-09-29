import { afterEach, describe, expect, it, mock } from 'bun:test'
import { fakeMultiplayer, renderWith } from '../../multiplayer/testing'
import { layoutFarm, type FarmInput } from '../layout'
import { at, makeAgent, makeSquad } from '../testFixtures'
import { FarmCardContext, type FarmCardEnv } from './context'
import { StandCard } from './StandCard'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
})

async function openStand() {
  const squad = makeSquad({ id: 'sq', name: 'Garden', managerAgentId: 'boss' })
  const consultant = (id: string, extra: Parameters<typeof makeAgent>[0] = {}) =>
    makeAgent({
      id,
      squadId: 'sq',
      agentTypeId: 'consultant',
      status: 'idle',
      context: { scope: { type: 'consultant', id: 'sq' } },
      metadata: { name: id },
      ...extra,
    })
  const agents = [
    makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'active' }),
    // Fifteen chats people started: more than a screenful.
    ...Array.from({ length: 15 }, (_, k) => consultant(`chat-${k}`)),
    // Not counted: a Slack thread's and an Assistant task's consultants from before origins were stamped.
    consultant('slack', { context: { scope: { type: 'consultant' }, channelInstance: { id: 'slack-1' } } }),
    consultant('task', { metadata: { name: 'Assistant task' } }),
  ]
  const input: FarmInput = {
    squads: [squad],
    streams: [],
    doneCount: 0,
    canceledCount: 0,
    agents,
    assistants: [],
    pendingActions: [],
    now: at(60).getTime(),
  }
  const layout = layoutFarm(input)
  const env = {
    layout,
    input,
    agentsById: new Map(agents.map((a) => [a.id, a])),
    squadsById: new Map([[squad.id, squad]]),
    halted: new Set<string>(),
    select: mock(() => {}),
    openChat: mock(() => {}),
    startConsultant: mock(() => {}),
  } as unknown as FarmCardEnv
  const view = await renderWith(
    <FarmCardContext.Provider value={env}>
      <StandCard squadId="sq" />
    </FarmCardContext.Provider>,
    await fakeMultiplayer()
  )
  mounted.push(view.unmount)
  return { container: view.container, counted: layout.yards[0]!.stand.ids?.length }
}

describe('StandCard', () => {
  it('lists every consultant chat the stand counts', async () => {
    const { container, counted } = await openStand()
    expect(counted).toBe(15)
    expect(container.querySelector('.g-card-title')?.textContent).toBe('15 consultant chats')
    expect(container.querySelectorAll('.g-crew > li')).toHaveLength(15)
    expect(container.textContent).not.toContain('slack')
  })
})
