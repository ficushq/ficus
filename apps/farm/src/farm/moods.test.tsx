import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ROBOT_MODEL_MOODS, ROBOT_MOODS, type Agent, type RobotMood, type RobotMoodState } from '@ficus/shared'
import { layoutFarm, type FarmInput } from './layout'
import { createMoodStore, displayMood, fieldRobots, moodLabel, shownMoods, visibleRobotIds } from './moods'
import { SceneWorld } from './Scene'
import { iso } from './iso'
import { makeAgent, makeAgentError, makeSquad, makeStream } from './testFixtures'
import type { RobotPlacement } from './types'
import { SKINS, SkinContext } from '../skins'
import { keysForEvent } from '../live/invalidation'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** One squad, a stream per agent, each agent tending its own plant. */
function farm(agents: Agent[], extra: Partial<FarmInput> = {}): FarmInput {
  return {
    squads: [makeSquad()],
    streams: agents.map((agent, n) =>
      makeStream({ id: `ws-${n}`, agentIds: [agent.id], ownerAgentId: agent.id, status: 'active' })
    ),
    doneCount: 0,
    canceledCount: 0,
    agents,
    assistants: [],
    pendingActions: [],
    now: 0,
    ...extra,
  }
}

const state = (mood: RobotMood): RobotMoodState => ({ mood, source: 'model', at: 1 })

const placement = (overrides: Partial<RobotPlacement> = {}, agent: Partial<Agent> = {}): RobotPlacement => ({
  agent: makeAgent({ id: id(1), ...agent }),
  role: 'worker',
  i: 0,
  j: 0,
  face: 'happy',
  helpers: 0,
  facing: 'right',
  asking: false,
  ...overrides,
})

describe('which mood a robot shows', () => {
  it('a working robot shows its mood', () => {
    for (const mood of ROBOT_MODEL_MOODS) expect(displayMood(placement(), state(mood))).toBe(mood)
    expect(displayMood(placement(), state('looping'))).toBe('looping')
  })

  it('halted, asking and waiting faces take priority', () => {
    expect(displayMood(placement({ face: 'error' }), state('risky'))).toBeNull()
    expect(displayMood(placement({ face: 'question', asking: true }), state('risky'))).toBeNull()
    expect(displayMood(placement({}, { status: 'waiting-input' }), state('struggling'))).toBeNull()
  })

  it('a robot that is not running shows none, and idle or waiting have no drawing', () => {
    expect(displayMood(placement({ face: 'normal' }, { status: 'idle' }), state('focused'))).toBeNull()
    expect(displayMood(placement(), state('idle'))).toBeNull()
    expect(displayMood(placement(), state('waiting'))).toBeNull()
    expect(displayMood(placement(), undefined)).toBeNull()
  })
})

describe('the mood store', () => {
  it('a watching report replaces what it held for the robots it named', () => {
    const store = createMoodStore()
    store.apply({ agentId: 'a', mood: 'risky', source: 'model', at: 1 })
    store.apply({ agentId: 'b', mood: 'stuck', source: 'signal', at: 1 })
    store.report(['a'], { enabled: true, moods: {} })
    expect([...store.get().moods.keys()]).toEqual(['b'])
    store.report(['a', 'b'], { enabled: true, moods: { a: state('exploring') } })
    expect(store.get()).toEqual({ enabled: true, moods: new Map([['a', state('exploring')]]) })
  })

  it('off clears everything', () => {
    const store = createMoodStore()
    store.apply({ agentId: 'a', mood: 'risky', source: 'model', at: 1 })
    store.report([], { enabled: false, moods: {} })
    expect(store.get().enabled).toBe(false)
    expect(store.get().moods.size).toBe(0)
  })

  it('ignores older and unknown moods', () => {
    const store = createMoodStore()
    store.apply({ agentId: 'a', mood: 'risky', source: 'model', at: 5 })
    store.apply({ agentId: 'a', mood: 'focused', source: 'model', at: 4 })
    store.apply({ agentId: 'a', mood: 'ecstatic', source: 'model', at: 6 })
    store.apply(null)
    expect(store.get().moods.get('a')?.mood).toBe('risky')
  })

  it('agent.mood events refetch nothing', () => {
    expect(keysForEvent({ type: 'event', topic: 'agents', event: 'agent.mood', data: { agentId: 'a' } })).toEqual([])
  })
})

describe('the robots on screen', () => {
  const agents = [makeAgent({ id: id(1) }), makeAgent({ id: id(2) }), makeAgent({ id: id(3) })]
  const layout = layoutFarm(farm(agents))

  it('are the field robots inside the viewport (plus a margin), sorted', () => {
    const robots = fieldRobots(layout)
    expect(robots.length).toBeGreaterThanOrEqual(3)
    const [x, y] = iso(robots[0]!.i, robots[0]!.j)
    // Zoomed in on the first robot only.
    const close = visibleRobotIds(layout, { x, y: y - 30, zoom: 4 }, { width: 120, height: 120 }, 0)
    expect(close).toEqual([robots[0]!.agent.id])
    const all = visibleRobotIds(layout, { x, y, zoom: 0.1 }, { width: 2000, height: 2000 })
    expect(all).toEqual([id(1), id(2), id(3)])
  })

  it('leave out stand-ins that are not agents, and nothing is visible before the viewport is measured', () => {
    const withPorch = layoutFarm(farm(agents, { assistants: [makeAgent({ id: 'farm:assistant', squadId: null })] }))
    expect(visibleRobotIds(withPorch, { x: 0, y: 0, zoom: 0.05 }, { width: 4000, height: 4000 })).not.toContain(
      'farm:assistant'
    )
    expect(visibleRobotIds(layout, { x: 0, y: 0, zoom: 1 }, { width: 0, height: 0 })).toEqual([])
  })
})

describe('drawing moods', () => {
  const SHOWN = ROBOT_MOODS.filter((mood) => mood !== 'idle' && mood !== 'waiting')
  const agents = SHOWN.map((_, n) => makeAgent({ id: id(n + 1) }))

  const render = (input: FarmInput, moods: Record<string, RobotMood>, skin = SKINS[0]!) => {
    const layout = layoutFarm(input)
    const shown = shownMoods(layout, {
      enabled: true,
      moods: new Map(Object.entries(moods).map(([agentId, mood]) => [agentId, state(mood)])),
    })
    return renderToStaticMarkup(
      <SkinContext.Provider value={{ skin, setSkin: () => {} }}>
        <svg>
          <SceneWorld
            layout={layout}
            selection={null}
            mailboxCount={0}
            onSelect={() => {}}
            onReveal={() => {}}
            moods={shown}
          />
        </svg>
      </SkinContext.Provider>
    )
  }

  for (const skin of SKINS) {
    it(`${skin.id} draws each mood, says it in words, and moves only the restless ones`, () => {
      const html = render(farm(agents), Object.fromEntries(SHOWN.map((mood, n) => [id(n + 1), mood])), skin)
      for (const mood of SHOWN) {
        if (mood === 'focused') continue
        expect({ mood, mark: html.includes(`class="g-mood-mark" data-mood="${mood}"`) }).toEqual({ mood, mark: true })
        expect(html).toContain(moodLabel(mood))
      }
      // Focused is the plain working face: words on hover, no mark.
      expect(html).not.toContain('class="g-mood-mark" data-mood="focused"')
      expect(html).toContain(`: ${moodLabel('focused')}</title>`)
      expect(html).toContain('g-mood-body-pacing')
      expect(html).toContain('g-mood-body-looking')
      expect(html).toContain('g-mood-body-hop')
    })
  }

  it('halted and asking robots show those instead of a mood', () => {
    const halted = makeAgent({ id: id(1) })
    const asking = makeAgent({ id: id(2), status: 'waiting-input' })
    const working = makeAgent({ id: id(3) })
    const html = render(farm([halted, asking, working], { pendingActions: [makeAgentError(id(1))] }), {
      [id(1)]: 'risky',
      [id(2)]: 'struggling',
      [id(3)]: 'exploring',
    })
    expect(html).not.toContain('data-mood="risky"')
    expect(html).not.toContain('data-mood="struggling"')
    expect(html).toContain('data-mood="exploring"')
    expect(html).toContain('halted')
  })

  it('nothing at all when moods are off', () => {
    const layout = layoutFarm(farm(agents))
    expect(shownMoods(layout, { enabled: false, moods: new Map([[id(1), state('risky')]]) })).toBeNull()
  })
})
