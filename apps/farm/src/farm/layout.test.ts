import { describe, expect, it } from 'bun:test'
import type { Agent, PendingAction, Squad, WorkStream } from '@ficus/shared'
import {
  HOMESTEAD,
  layoutFarm,
  MAX_DECOR,
  occupiedTiles,
  tileKey,
  yardSize,
  type FarmInput,
  PLOT_PITCH,
} from './layout'
import type { FarmLayout, RobotPlacement } from './types'
import { iso } from './iso'
import { at, makeAgent, makeAgentError, makeSquad, makeStream, makeWait, shuffled } from './testFixtures'

const NOW = at(60 * 24 * 10).getTime()

function farm(overrides: Partial<FarmInput> = {}): FarmInput {
  return {
    squads: [],
    streams: [],
    doneCount: 0,
    canceledCount: 0,
    agents: [],
    assistants: [],
    pendingActions: [],
    now: NOW,
    ...overrides,
  }
}

/** A busy, mixed farm: several squads with managers, consultants, workers, subagents and streams. */
function busyFarm(squadCount: number, streamsPerSquad: number, agentsPerSquad: number): FarmInput {
  const squads: Squad[] = []
  const streams: WorkStream[] = []
  const agents: Agent[] = []
  const pendingActions: PendingAction[] = []
  const statuses = ['active', 'idle', 'waiting-input', 'dormant', 'compacting', 'idle', 'terminated'] as const
  for (let s = 0; s < squadCount; s++) {
    const squadId = `squad-${s}`
    const managerId = `${squadId}-manager`
    squads.push(makeSquad({ id: squadId, name: `Squad ${s}`, managerAgentId: managerId, createdAt: at(s % 7) }))
    agents.push(makeAgent({ id: managerId, squadId, agentTypeId: 'manager', status: 'active' }))
    agents.push(makeAgent({ id: `${squadId}-consultant`, squadId, agentTypeId: 'consultant', status: 'idle' }))
    const workers: string[] = []
    for (let a = 0; a < agentsPerSquad - 2; a++) {
      const id = `${squadId}-worker-${a}`
      workers.push(id)
      agents.push(makeAgent({ id, squadId, status: statuses[(a + s) % statuses.length] }))
      if (a % 5 === 0) agents.push(makeAgent({ id: `${id}-sub`, squadId, parentAgentId: id, status: 'active' }))
      if (a % 11 === 3) pendingActions.push(makeAgentError(id, squadId))
    }
    for (let n = 0; n < streamsPerSquad; n++) {
      const kind = n % 6
      streams.push(
        makeStream({
          id: `${squadId}-ws-${n}`,
          squadId,
          createdAt: at(n * 3 + s),
          status: kind === 5 ? 'queued' : 'active',
          derivedState: kind === 0 ? 'in_progress' : undefined,
          openWaits:
            kind === 1
              ? [makeWait('question')]
              : kind === 2
                ? [makeWait('review')]
                : kind === 3
                  ? [makeWait('manual')]
                  : kind === 4
                    ? [makeWait('dependency')]
                    : [],
          agentIds: [workers[n % workers.length]!, workers[(n * 7 + 1) % workers.length]!, managerId],
          assigneeAgentId: workers[(n + 3) % workers.length]!,
        })
      )
    }
  }
  const assistants = [0, 1, 2, 3].map((n) =>
    makeAgent({ id: `assistant-${n}`, squadId: null, agentTypeId: 'assistant' })
  )
  return farm({ squads, streams, agents, assistants, pendingActions, doneCount: 12, canceledCount: 3 })
}

function allRobots(layout: FarmLayout): RobotPlacement[] {
  const robots = [...layout.porch.robots]
  for (const yard of layout.yards) {
    robots.push(...yard.dock.robots, ...yard.stand.robots)
    if (yard.farmer) robots.push(yard.farmer)
    for (const plot of yard.plots) if (plot.tender) robots.push(plot.tender)
  }
  return robots
}

const squad = makeSquad({ id: 'sq', name: 'Farm', managerAgentId: 'boss' })
const boss = makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'active' })

describe('yard sizing', () => {
  it('follows w = clamp(ceil(sqrt(1.6n)), 3, 6), h = max(2, ceil((n + 1) / w)), always leaving a free square', () => {
    expect(yardSize(0)).toEqual({ w: 3, h: 2 })
    expect(yardSize(1)).toEqual({ w: 3, h: 2 })
    expect(yardSize(5)).toEqual({ w: 3, h: 2 })
    expect(yardSize(6)).toEqual({ w: 4, h: 2 })
    expect(yardSize(7)).toEqual({ w: 4, h: 2 })
    expect(yardSize(8)).toEqual({ w: 4, h: 3 })
    expect(yardSize(16)).toEqual({ w: 6, h: 3 })
    expect(yardSize(30)).toEqual({ w: 6, h: 6 })
    for (const n of [0, 5, 6, 8, 12, 18, 30]) {
      const { w, h } = yardSize(n)
      expect(w * h).toBeGreaterThan(n)
    }
  })

  it('gives an empty squad a 3×2 yard and sizes yards by live streams only', () => {
    const streams = [
      ...Array.from({ length: 10 }, (_, n) => makeStream({ id: `ws-${n}`, squadId: 'sq', createdAt: at(n) })),
      makeStream({ id: 'done', squadId: 'sq', status: 'done' }),
    ]
    const layout = layoutFarm(farm({ squads: [squad, makeSquad({ id: 'empty', createdAt: at(5) })], streams }))
    expect(layout.yards.map((y) => [y.squad.id, y.w, y.h, y.plots.length])).toEqual([
      ['sq', 4 * PLOT_PITCH, 3 * PLOT_PITCH, 10],
      ['empty', 3 * PLOT_PITCH, 2 * PLOT_PITCH, 0],
    ])
  })
})

describe('layout determinism', () => {
  it('returns deep-equal output for the same input', () => {
    const input = busyFarm(6, 9, 12)
    expect(layoutFarm(input)).toEqual(layoutFarm(input))
  })

  it('ignores input order', () => {
    const input = busyFarm(7, 11, 10)
    const reordered: FarmInput = {
      ...input,
      squads: shuffled(input.squads, 3),
      streams: shuffled(input.streams, 5),
      agents: shuffled(input.agents, 7),
      assistants: shuffled(input.assistants, 11),
      pendingActions: shuffled(input.pendingActions, 13),
    }
    expect(layoutFarm(reordered)).toEqual(layoutFarm(input))
  })

  it('orders squads by createdAt then name', () => {
    const squads = [
      makeSquad({ id: 'c', name: 'Beta', createdAt: at(1) }),
      makeSquad({ id: 'a', name: 'Zeta', createdAt: at(0) }),
      makeSquad({ id: 'b', name: 'Alpha', createdAt: at(1) }),
    ]
    expect(layoutFarm(farm({ squads })).yards.map((y) => y.squad.id)).toEqual(['a', 'b', 'c'])
  })

  it('accepts ISO-string timestamps as the API sends them', () => {
    const squads = [
      makeSquad({ id: 'late', createdAt: '2026-09-02T00:00:00Z' as unknown as Date }),
      makeSquad({ id: 'early', createdAt: '2026-09-01T00:00:00Z' as unknown as Date }),
    ]
    expect(layoutFarm(farm({ squads })).yards.map((y) => y.squad.id)).toEqual(['early', 'late'])
  })
})

describe('plots', () => {
  const streams = [
    makeStream({ id: 'third', squadId: 'sq', createdAt: at(3) }),
    makeStream({ id: 'first', squadId: 'sq', createdAt: at(1) }),
    makeStream({ id: 'second', squadId: 'sq', createdAt: at(2) }),
    makeStream({ id: 'fourth', squadId: 'sq', createdAt: at(4) }),
  ]

  it('fills plots row by row in createdAt order, on the plot pitch', () => {
    const [yard] = layoutFarm(farm({ squads: [squad], streams })).yards
    const cell = (p: { i: number; j: number }) => [
      (p.i - yard!.i0 - 0.25) / PLOT_PITCH,
      (p.j - yard!.j0 - 0.25) / PLOT_PITCH,
    ]
    expect(yard!.plots.map((p) => [p.stream.id, ...cell(p)])).toEqual([
      ['first', 0, 0],
      ['second', 1, 0],
      ['third', 2, 0],
      ['fourth', 0, 1],
    ])
  })

  it('keeps existing plants in place when a newer stream arrives', () => {
    const before = layoutFarm(farm({ squads: [squad], streams })).yards[0]!.plots
    const after = layoutFarm(
      farm({ squads: [squad], streams: [...streams, makeStream({ id: 'fifth', squadId: 'sq', createdAt: at(5) })] })
    ).yards[0]!.plots
    for (const plot of before) {
      const moved = after.find((p) => p.stream.id === plot.stream.id)!
      expect([moved.i, moved.j]).toEqual([plot.i, plot.j])
    }
  })

  it('carries plant state, badge and crop', () => {
    const [yard] = layoutFarm(
      farm({ squads: [squad], streams: [makeStream({ id: 'q', squadId: 'sq', openWaits: [makeWait('question')] })] })
    ).yards
    expect(yard!.plots[0]).toMatchObject({ state: 'question', badge: 'question' })
  })
})

describe('tenders', () => {
  const worker = (id: string, status: Agent['status']) => makeAgent({ id, squadId: 'sq', status })
  const plotFor = (agents: Agent[], pendingActions: PendingAction[] = [], stream: Partial<WorkStream> = {}) =>
    layoutFarm(
      farm({
        squads: [squad],
        agents: [boss, ...agents],
        pendingActions,
        streams: [makeStream({ id: 'ws', squadId: 'sq', agentIds: agents.map((a) => a.id).concat('boss'), ...stream })],
      })
    ).yards[0]!.plots[0]!

  it('prefers waiting-input, then halted, then active, tie-broken by id', () => {
    const agents = [worker('d-active', 'active'), worker('c-halted', 'waiting-input'), worker('b-ask', 'waiting-input')]
    const halted = [makeAgentError('c-halted')]
    let plot = plotFor(agents, halted)
    expect(plot.tender?.agent.id).toBe('b-ask')
    expect(plot.tender?.face).toBe('question')
    expect(plot.extraTenders).toBe(2)

    plot = plotFor(
      agents.filter((a) => a.id !== 'b-ask'),
      halted
    )
    expect(plot.tender?.agent.id).toBe('c-halted')
    expect(plot.tender?.face).toBe('error')
    expect(plot.extraTenders).toBe(1)

    plot = plotFor([worker('z-active', 'active'), worker('y-active', 'compacting'), worker('x-active', 'active')])
    expect(plot.tender?.agent.id).toBe('x-active')
    expect(plot.extraTenders).toBe(2)
  })

  it('counts a question asked without stopping: the asker tends, with the question face', () => {
    const question = { ...makeAgentError('b-asks'), id: 'q-1', type: 'agent-question' as const }
    const plot = plotFor([worker('a-active', 'active'), worker('b-asks', 'active')], [question])
    expect(plot.tender).toMatchObject({ agent: { id: 'b-asks' }, face: 'question', asking: true })
    // The others aren't asking.
    expect(plotFor([worker('a-active', 'active')]).tender).toMatchObject({ face: 'happy', asking: false })
  })

  it('stands in the path beside its plot, not on the plant', () => {
    const plot = plotFor([worker('w', 'active')])
    expect([plot.tender!.i, plot.tender!.j]).toEqual([plot.i + 1.1, plot.j + 0.7])
    // It stands to the plant's right, so it faces left, toward it.
    expect(plot.tender!.facing).toBe('left')
  })

  it('counts assignee and owner as participants', () => {
    const plot = plotFor([], [], { agentIds: null, assigneeAgentId: 'boss', ownerAgentId: 'owner' })
    expect(plot.tender).toBeNull()
    const withOwner = layoutFarm(
      farm({
        squads: [squad],
        agents: [boss, worker('owner', 'active'), worker('assignee', 'active')],
        streams: [
          makeStream({ id: 'ws', squadId: 'sq', agentIds: null, assigneeAgentId: 'assignee', ownerAgentId: 'owner' }),
        ],
      })
    ).yards[0]!.plots[0]!
    expect(withOwner.tender?.agent.id).toBe('assignee')
    expect(withOwner.extraTenders).toBe(1)
  })

  it('never uses the manager, consultants, idle or sleeping agents as tenders', () => {
    const consultant = makeAgent({ id: 'con', squadId: 'sq', agentTypeId: 'consultant', status: 'active' })
    const plot = plotFor([consultant, worker('idle', 'idle'), worker('zz', 'dormant'), worker('gone', 'terminated')])
    expect(plot.tender).toBeNull()
    expect(plot.extraTenders).toBe(0)
  })

  it('draws an agent at one plant only', () => {
    const w = worker('w', 'active')
    const layout = layoutFarm(
      farm({
        squads: [squad],
        agents: [boss, w],
        streams: [
          makeStream({ id: 'a', squadId: 'sq', agentIds: ['w'], createdAt: at(1) }),
          makeStream({ id: 'b', squadId: 'sq', agentIds: ['w'], createdAt: at(2) }),
        ],
      })
    )
    expect(layout.yards[0]!.plots.map((p) => p.tender?.agent.id ?? null)).toEqual(['w', null])
  })
})

describe('farmer, sign, dock and bench', () => {
  it('places the sign at the gate and the manager beside it', () => {
    const [yard] = layoutFarm(farm({ squads: [squad], agents: [boss] })).yards
    expect(yard!.sign).toEqual({ i: yard!.i0 + yard!.w / 2, j: yard!.j0 + yard!.h + 0.35 })
    expect(yard!.farmer?.agent.id).toBe('boss')
    expect(yard!.farmer?.role).toBe('manager')
    expect(yard!.farmer!.i).toBeGreaterThan(yard!.sign.i)
    expect(yard!.farmer!.j).toBeGreaterThan(yard!.j0 + yard!.h)
    expect(yard!.dock).toMatchObject({ i: yard!.i0 + yard!.w + 0.75, j: yard!.j0 - 0.9 })
    expect(yard!.stand.i).toBeLessThan(yard!.i0)
  })

  it('keeps every charging hut clear of the consulting stands and farmers of neighbouring yards', () => {
    // Yards of mixed sizes on a 3×3 grid, so huts meet stands and farmers across every kind of lane.
    const counts = [2, 14, 5, 30, 1, 9, 20, 3, 7]
    const squads = counts.map((_, s) => makeSquad({ id: `sq-${s}`, name: `Squad ${s}`, managerAgentId: `boss-${s}` }))
    const streams = counts.flatMap((n, s) =>
      Array.from({ length: n }, (_, k) => makeStream({ id: `ws-${s}-${k}`, squadId: `sq-${s}` }))
    )
    const agents = counts.map((_, s) => makeAgent({ id: `boss-${s}`, squadId: `sq-${s}`, agentTypeId: 'manager' }))
    const { yards } = layoutFarm(farm({ squads, streams, agents }))
    // Screen boxes [left, top, width, height] around the anchor: the largest style's (Nostalgic) sprites.
    type Box = readonly [number, number, number, number]
    const HUT: Box = [-64, -96, 128, 118]
    const STAND: Box = [-58, -100, 116, 118]
    const ROBOT: Box = [-22, -74, 44, 80]
    const place = (i: number, j: number, [l, t, w, h]: Box) => {
      const [x, y] = iso(i, j)
      return { x0: x + l, y0: y + t, x1: x + l + w, y1: y + t + h }
    }
    const overlaps = (a: ReturnType<typeof place>, b: ReturnType<typeof place>) =>
      a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
    for (const yard of yards) {
      const hut = place(yard.dock.i, yard.dock.j, HUT)
      for (const other of yards) {
        expect(overlaps(hut, place(other.stand.i, other.stand.j, STAND))).toBe(false)
        if (other !== yard && other.farmer)
          expect(overlaps(hut, place(other.farmer.i, other.farmer.j, ROBOT))).toBe(false)
      }
    }
  })

  it('falls back to a manager-typed agent in the squad', () => {
    const noPointer = makeSquad({ id: 'sq', managerAgentId: null })
    const [yard] = layoutFarm(farm({ squads: [noPointer], agents: [boss] })).yards
    expect(yard!.farmer?.agent.id).toBe('boss')
  })

  it('rests every idle worker in the charging hut, one peeking out', () => {
    const agents = [
      boss,
      ...['e', 'a', 'd', 'b', 'c'].map((id) => makeAgent({ id, squadId: 'sq', status: 'idle' })),
      makeAgent({ id: 'busy', squadId: 'sq', status: 'active' }),
      makeAgent({ id: 'sleep', squadId: 'sq', status: 'dormant' }),
      makeAgent({ id: 'halted', squadId: 'sq', status: 'idle' }),
      makeAgent({ id: 'con', squadId: 'sq', agentTypeId: 'consultant', status: 'idle' }),
    ]
    const [yard] = layoutFarm(farm({ squads: [squad], agents, pendingActions: [makeAgentError('halted')] })).yards
    expect(yard!.dock.ids).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(yard!.dock.robots.map((r) => r.agent.id)).toEqual(['a'])
    expect(yard!.dock.robots[0]).toMatchObject({ face: 'normal', i: yard!.dock.i, j: yard!.dock.j })
    expect(yard!.dock.overflow).toBe(4)
    // One hut whatever the count, diagonally off the back-right corner.
    expect(yard!.dock.i).toBeGreaterThan(yard!.i0 + yard!.w)
    expect(yard!.dock.j).toBeLessThan(yard!.j0)
  })

  it('lists the consultant chats people started at the stand, with one on duty behind the counter', () => {
    const consultant = (id: string, status: Agent['status'], origin?: string) =>
      makeAgent({
        id,
        squadId: 'sq',
        agentTypeId: 'consultant',
        status,
        context: { scope: { type: 'consultant', id: 'sq' }, ...(origin ? { origin } : {}) },
      })
    const agents = [
      boss,
      consultant('c1', 'idle', 'user'),
      consultant('c2', 'active', 'user'),
      consultant('legacy', 'idle'),
      consultant('asleep', 'dormant', 'user'),
      consultant('gone', 'terminated', 'user'),
      consultant('slack', 'idle', 'channel'),
      consultant('task', 'idle', 'assistant'),
      consultant('event', 'idle', 'integration'),
    ]
    const [yard] = layoutFarm(farm({ squads: [squad], agents })).yards
    expect([...yard!.stand.ids!].sort()).toEqual(['asleep', 'c1', 'c2', 'legacy'])
    expect(yard!.stand.robots).toHaveLength(1)
    expect(yard!.stand.robots[0]).toMatchObject({ role: 'consultant' })
    expect(yard!.stand.robots[0]!.agent.status).not.toBe('dormant')
    expect(yard!.stand.overflow).toBe(3)
  })

  it('knows which consultants at the stand are asking you something, and puts them first', () => {
    const consultant = (id: string, status: Agent['status']) =>
      makeAgent({
        id,
        squadId: 'sq',
        agentTypeId: 'consultant',
        status,
        context: { scope: { type: 'consultant', id: 'sq' }, origin: 'user' },
      })
    const question = { ...makeAgentError('c-asks'), id: 'q', type: 'agent-question' as const }
    const agents = [
      boss,
      consultant('c-idle', 'idle'),
      consultant('c-asks', 'active'),
      consultant('c-waits', 'waiting-input'),
    ]
    const [yard] = layoutFarm(farm({ squads: [squad], agents, pendingActions: [question] })).yards
    expect([...yard!.stand.asking!].sort()).toEqual(['c-asks', 'c-waits'])
    expect(yard!.stand.ids!.slice(0, 2).sort()).toEqual(['c-asks', 'c-waits'])
    expect(
      layoutFarm(farm({ squads: [squad], agents: [boss, consultant('c-idle', 'idle')] })).yards[0]!.stand.asking
    ).toEqual([])
  })
})

describe('who is drawn', () => {
  it('never draws dormant or terminated agents', () => {
    const layout = layoutFarm(busyFarm(5, 12, 14))
    const robots = allRobots(layout)
    expect(robots.length).toBeGreaterThan(10)
    expect(robots.some((r) => r.agent.status === 'dormant' || r.agent.status === 'terminated')).toBe(false)

    const sleepyBoss = makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'dormant' })
    expect(layoutFarm(farm({ squads: [squad], agents: [sleepyBoss] })).yards[0]!.farmer).toBeNull()
  })

  it('never draws an agent twice', () => {
    const ids = allRobots(layoutFarm(busyFarm(6, 15, 20))).map((r) => r.agent.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('counts running subagents onto their parent instead of drawing them', () => {
    const worker = makeAgent({ id: 'w', squadId: 'sq', status: 'active' })
    const subs = [
      makeAgent({ id: 's1', squadId: 'sq', parentAgentId: 'w', status: 'active' }),
      makeAgent({ id: 's2', squadId: 'sq', parentAgentId: 'w', status: 'waiting-input' }),
      makeAgent({ id: 's3', squadId: 'sq', parentAgentId: 'w', status: 'idle' }),
      makeAgent({ id: 's4', squadId: 'sq', parentAgentId: 'boss', status: 'compacting' }),
      makeAgent({ id: 's5', squadId: 'sq', parentAgentId: 'w', status: 'dormant' }),
    ]
    const layout = layoutFarm(
      farm({
        squads: [squad],
        agents: [boss, worker, ...subs],
        streams: [makeStream({ id: 'ws', squadId: 'sq', agentIds: ['w', 's1', 's2'] })],
      })
    )
    const [yard] = layout.yards
    expect(yard!.plots[0]!.tender?.agent.id).toBe('w')
    expect(yard!.plots[0]!.tender?.helpers).toBe(2)
    expect(yard!.plots[0]!.extraTenders).toBe(0)
    expect(yard!.farmer?.helpers).toBe(1)
    expect(allRobots(layout).some((r) => r.agent.parentAgentId)).toBe(false)
  })

  it('leaves the porch empty: the Assistant lives in the toolbar', () => {
    const assistants = ['a', 'b'].map((id) => makeAgent({ id, squadId: null, agentTypeId: 'assistant' }))
    expect(layoutFarm(farm({ assistants })).porch.robots).toEqual([])
  })
})

describe('needs you', () => {
  it('counts badged plots plus halted agents in the squad', () => {
    const agents = [boss, makeAgent({ id: 'h', squadId: 'sq', status: 'waiting-input' })]
    const streams = [
      makeStream({ id: 'q', squadId: 'sq', openWaits: [makeWait('question')] }),
      makeStream({ id: 'r', squadId: 'sq', openWaits: [makeWait('review')] }),
      makeStream({ id: 'd', squadId: 'sq', openWaits: [makeWait('dependency')] }),
      makeStream({ id: 'g', squadId: 'sq' }),
    ]
    const pendingActions = [makeAgentError('h'), makeAgentError('h'), makeAgentError('elsewhere', 'other')]
    const [yard] = layoutFarm(farm({ squads: [squad], agents, streams, pendingActions })).yards
    expect(yard!.needsYou).toBe(3)
  })
})

describe('the whole farm', () => {
  it('keeps the homestead, mailbox and crates where they belong', () => {
    const layout = layoutFarm(busyFarm(4, 8, 6))
    expect(layout.farmhouse).toEqual({ i: -4.5, j: -2 })
    expect(layout.seedShed).toEqual({ i: -7, j: 2 })
    // Between the seed shed and the porch, inside the homestead.
    expect(layout.mailbox).toEqual({ i: -6, j: 0.2 })
    expect(layout.mailbox.i).toBeGreaterThan(layout.seedShed.i)
    expect(layout.mailbox.i).toBeLessThan(layout.porch.i)
    expect(layout.porch).toMatchObject({ i: -4.15, j: 0.35 })
    const lastFront = Math.max(...layout.yards.map((y) => y.j0 + y.h))
    expect(layout.crates).toMatchObject({ count: 12 })
    expect(layout.compost).toMatchObject({ count: 3 })
    expect(layout.crates.j).toBeGreaterThan(lastFront + 1)
    expect(layout.compost.j).toBe(layout.crates.j)
  })

  it('never overlaps yards (including their 2-tile lanes) or the homestead', () => {
    const layout = layoutFarm(busyFarm(20, 30, 10))
    const varied = layoutFarm({
      ...busyFarm(13, 0, 4),
      streams: busyFarm(13, 30, 4).streams.filter((_, n) => n % 7 < (n % 13) / 2),
    })
    for (const { yards } of [layout, varied]) {
      for (const [index, a] of yards.entries()) {
        expect(a.i0).toBeGreaterThan(HOMESTEAD.maxI)
        for (const b of yards.slice(index + 1)) {
          const apartI = a.i0 + a.w + 2 <= b.i0 || b.i0 + b.w + 2 <= a.i0
          const apartJ = a.j0 + a.h + 2 <= b.j0 || b.j0 + b.h + 2 <= a.j0
          expect(apartI || apartJ).toBe(true)
        }
      }
    }
  })

  it('bounds everything placed with a 3-tile margin', () => {
    const layout = layoutFarm(busyFarm(5, 10, 8))
    const points = [
      ...allRobots(layout),
      layout.farmhouse,
      layout.seedShed,
      { i: HOMESTEAD.minI, j: HOMESTEAD.minJ },
      { i: HOMESTEAD.maxI + 1, j: HOMESTEAD.maxJ + 1 },
      layout.mailbox,
      layout.crates,
      layout.compost,
      ...layout.decor,
      ...layout.yards.flatMap((y) => [
        { i: y.i0, j: y.j0 },
        { i: y.i0 + y.w, j: y.j0 + y.h },
      ]),
    ]
    const { minI, maxI, minJ, maxJ } = layout.bounds
    for (const p of points) {
      expect(p.i).toBeGreaterThanOrEqual(minI)
      expect(p.i).toBeLessThanOrEqual(maxI)
      expect(p.j).toBeGreaterThanOrEqual(minJ)
      expect(p.j).toBeLessThanOrEqual(maxJ)
    }
    const structural = points.filter((p) => !('kind' in p))
    expect(Math.min(...structural.map((p) => p.i))).toBe(minI + 3)
    expect(Math.max(...structural.map((p) => p.j))).toBe(maxJ - 3)
  })
})

describe('decor', () => {
  for (const [name, input] of [
    ['empty farm', farm()],
    ['one squad', farm({ squads: [squad], agents: [boss] })],
    ['busy farm', busyFarm(9, 14, 8)],
    ['huge farm', busyFarm(20, 30, 10)],
  ] as const) {
    it(`stays off occupied tiles and stays sparse (${name})`, () => {
      const layout = layoutFarm(input)
      const occupied = occupiedTiles(layout)
      for (const item of layout.decor) {
        expect(occupied.has(tileKey(Math.floor(item.i), Math.floor(item.j)))).toBe(false)
        // Also off every yard (+1 margin) by direct geometry, independent of occupiedTiles.
        for (const yard of layout.yards) {
          const inside =
            item.i >= yard.i0 - 1 &&
            item.i < yard.i0 + yard.w + 1 &&
            item.j >= yard.j0 - 1 &&
            item.j < yard.j0 + yard.h + 1
          expect(inside).toBe(false)
        }
      }
      const { minI, maxI, minJ, maxJ } = layout.bounds
      let free = 0
      for (let tj = Math.ceil(minJ); tj < Math.floor(maxJ); tj++)
        for (let ti = Math.ceil(minI); ti < Math.floor(maxI); ti++) if (!occupied.has(tileKey(ti, tj))) free++
      expect(layout.decor.length).toBeLessThanOrEqual(Math.min(MAX_DECOR, Math.round(free / 12)))
      expect(layout.decor.length).toBeGreaterThan(0)
      const tiles = new Set(layout.decor.map((d) => tileKey(Math.floor(d.i), Math.floor(d.j))))
      expect(tiles.size).toBe(layout.decor.length)
    })
  }

  it('puts trees mostly in the border', () => {
    const layout = layoutFarm(busyFarm(9, 14, 8))
    const trees = layout.decor.filter((d) => d.kind === 'tree' || d.kind === 'fruitTree')
    expect(trees.length).toBeGreaterThan(layout.decor.length / 2)
  })

  it('is stable for the same squads and changes with them', () => {
    const a = layoutFarm(busyFarm(3, 4, 4)).decor
    expect(layoutFarm(busyFarm(3, 4, 4)).decor).toEqual(a)
    const renamed = busyFarm(3, 4, 4)
    renamed.squads = renamed.squads.map((s) => ({ ...s, id: `${s.id}-x` }))
    expect(layoutFarm(renamed).decor).not.toEqual(a)
  })
})

describe('performance', () => {
  it('lays out 20 squads × 30 streams × 200 agents quickly', () => {
    const input = busyFarm(20, 30, 10)
    expect(input.agents.filter((a) => !a.parentAgentId).length).toBe(200)
    layoutFarm(input) // warm up
    const runs = 10
    const start = performance.now()
    for (let n = 0; n < runs; n++) layoutFarm(input)
    const perRun = (performance.now() - start) / runs
    expect(perRun).toBeLessThan(50)
  })
})

describe('stand order', () => {
  it('lists consultants waiting on you first, then the most recently active', () => {
    const sq = makeSquad({ id: 'sq', managerAgentId: null })
    const consultant = (id: string, minutes: number, status: Agent['status'] = 'idle') =>
      makeAgent({ id, squadId: 'sq', agentTypeId: 'consultant', status, updatedAt: at(minutes), lastMessageAt: null })
    const agents = [
      consultant('old', 1),
      consultant('newest', 30),
      consultant('asking', 2, 'waiting-input'),
      consultant('mid', 10),
    ]
    const [yard] = layoutFarm({
      squads: [sq],
      streams: [],
      doneCount: 0,
      canceledCount: 0,
      agents,
      assistants: [],
      pendingActions: [],
      now: at(60).getTime(),
    }).yards
    expect(yard!.stand.ids).toEqual(['asking', 'newest', 'mid', 'old'])
    expect(yard!.stand.robots.map((r) => r.agent.id)).toEqual(['asking'])
  })
})
