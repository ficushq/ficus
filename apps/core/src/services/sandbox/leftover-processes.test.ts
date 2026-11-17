import { describe, expect, it } from 'bun:test'
import type { LeftoverProcessSelector, LeftoverStopReason, LeftoverStopResponse } from './client/http-client'
import {
  endedAgentAttempts,
  leftoverSandboxIds,
  leftoverStopMessage,
  stopLeftoverProcesses,
  stopLeftoversForDormantAgent,
  stopLeftoversForEndedAttempts,
  stopLeftoversForEndedClaim,
  stopLeftoversForFinishedStream,
  type LeftoverCleanupDeps,
} from './leftover-processes'

const SQUAD = '11111111-1111-4111-8111-111111111111'
const STREAM = '22222222-2222-4222-8222-222222222222'
const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function group(agentId: string, overrides: Partial<LeftoverStopResponse['stopped'][number]> = {}) {
  return {
    invocationId: 'inv',
    agentId,
    workStreamId: STREAM,
    attemptId: 2,
    command: 'astro dev &',
    startedAt: '2026-11-17T00:00:00.000Z',
    pids: [101],
    keptPids: [],
    killedPids: [],
    survivingPids: [],
    ...overrides,
  }
}

/** Boxes by sandbox id; records every call and every notice. */
function harness(boxes: Record<string, LeftoverStopResponse['stopped'] | Error | null>) {
  const calls: Array<{ sandboxId: string; selector: LeftoverProcessSelector; reason: LeftoverStopReason }> = []
  const notices: Array<{ agentId: string; subject: string; content: string; metadata: Record<string, unknown> }> = []
  const deps: LeftoverCleanupDeps = {
    getClient: async (sandboxId) => {
      const box = boxes[sandboxId]
      if (box === null || box === undefined) return null
      return {
        stopLeftoverProcesses: async (selector, reason) => {
          calls.push({ sandboxId, selector, reason })
          if (box instanceof Error) throw box
          return { reason, stopped: box, kept: [] }
        },
      }
    },
    notify: async (agentId, subject, content, metadata) => {
      notices.push({ agentId, subject, content, metadata })
    },
  }
  return { deps, calls, notices }
}

describe('endedAgentAttempts (attempt-end trigger)', () => {
  it('names agent attempts that were active before a transition and are not after it', () => {
    expect(
      endedAgentAttempts([{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 2 }, { id: 4 }], {
        '1': AGENT_A,
        '2': AGENT_B,
        '3': AGENT_B,
        '4': AGENT_A,
      })
    ).toEqual([
      { attemptId: 1, agentId: AGENT_A },
      { attemptId: 3, agentId: AGENT_B },
    ])
  })

  it('ignores attempts without an agent (human approvals, decisions)', () => {
    expect(endedAgentAttempts([{ id: 5 }], [], {})).toEqual([])
  })

  it('names nothing when the same attempt is still active (an agent turn ending is not an attempt ending)', () => {
    expect(endedAgentAttempts([{ id: 1 }], [{ id: 1 }], { '1': AGENT_A })).toEqual([])
  })
})

describe('stopLeftoverProcesses', () => {
  it('stops an ended attempt in the squad box and the attempt agent own box, selecting by stream and attempt', async () => {
    const { deps, calls, notices } = harness({
      [`squad_${SQUAD}`]: [group(AGENT_A)],
      [`agent_${AGENT_A}`]: [group(AGENT_A, { command: 'vite &', pids: [7] })],
    })
    await stopLeftoversForEndedAttempts(STREAM, SQUAD, [{ attemptId: 2, agentId: AGENT_A }], deps)
    expect(calls).toEqual([
      { sandboxId: `squad_${SQUAD}`, selector: { workStreamId: STREAM, attemptId: 2 }, reason: 'attempt-ended' },
      { sandboxId: `agent_${AGENT_A}`, selector: { workStreamId: STREAM, attemptId: 2 }, reason: 'attempt-ended' },
    ])
    // One message per agent, naming both commands and where they ran.
    expect(notices).toHaveLength(1)
    expect(notices[0]!.agentId).toBe(AGENT_A)
    expect(notices[0]!.content).toContain('Ficus stopped 2 processes that your earlier commands left running')
    expect(notices[0]!.content).toContain('because the flow step they were started in ended')
    expect(notices[0]!.content).toContain('`astro dev &` in the shared squad box')
    expect(notices[0]!.content).toContain('`vite &` in your own box')
    expect(notices[0]!.content).toContain('FICUS_KEEP_RUNNING=1')
    expect(notices[0]!.metadata).toEqual({
      source: 'leftover-processes',
      reason: 'attempt-ended',
      workStreamId: STREAM,
      attemptId: 2,
    })
  })

  it('stops a dormant agent leftovers in its squad box by agent', async () => {
    const { deps, calls, notices } = harness({ [`squad_${SQUAD}`]: [group(AGENT_A)] })
    await stopLeftoversForDormantAgent(AGENT_A, SQUAD, deps)
    expect(calls).toEqual([{ sandboxId: `squad_${SQUAD}`, selector: { agentId: AGENT_A }, reason: 'agent-dormant' }])
    expect(notices[0]!.content).toContain('because you went dormant')
  })

  it('stops every agent leftovers for a finished stream and tells each agent separately', async () => {
    const { deps, calls, notices } = harness({ [`squad_${SQUAD}`]: [group(AGENT_A), group(AGENT_B)] })
    await stopLeftoversForFinishedStream(STREAM, SQUAD, deps)
    expect(calls).toEqual([
      { sandboxId: `squad_${SQUAD}`, selector: { workStreamId: STREAM }, reason: 'stream-finished' },
    ])
    expect(notices.map((notice) => notice.agentId).sort()).toEqual([AGENT_A, AGENT_B])
    expect(notices[0]!.content).toContain('because their work stream is done or canceled')
  })

  it('sends nothing when nothing was stopped', async () => {
    const { deps, notices } = harness({ [`squad_${SQUAD}`]: [] })
    expect(await stopLeftoversForDormantAgent(AGENT_A, SQUAD, deps)).toEqual([])
    expect(notices).toEqual([])
  })

  it('skips boxes that are down or predate the route, and never throws', async () => {
    const old = Object.assign(new Error('Request failed: 404'), { status: 404 })
    const { deps, notices } = harness({
      [`squad_${SQUAD}`]: old,
      [`agent_${AGENT_A}`]: new Error('connection refused'),
    })
    expect(
      await stopLeftoverProcesses(
        {
          sandboxIds: leftoverSandboxIds(SQUAD, [AGENT_A, AGENT_B]),
          selector: { agentId: AGENT_A },
          reason: 'agent-dormant',
        },
        deps
      )
    ).toEqual([])
    expect(notices).toEqual([])
  })

  it('still logs and returns the stop when the agent cannot be told (terminated)', async () => {
    const { deps } = harness({ [`squad_${SQUAD}`]: [group(AGENT_A)] })
    const stopped = await stopLeftoverProcesses(
      { sandboxIds: [`squad_${SQUAD}`], selector: { agentId: AGENT_A }, reason: 'agent-dormant' },
      {
        ...deps,
        notify: async () => {
          throw new Error('Agent is terminated')
        },
      }
    )
    expect(stopped).toHaveLength(1)
  })
})

describe('stopLeftoversForEndedClaim (slot claim trigger)', () => {
  const CLAIM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const OTHER_CLAIM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  it('stops what the owner started under a released claim, in the squad box and its own box', async () => {
    const { deps, calls, notices } = harness({
      [`squad_${SQUAD}`]: [group(AGENT_A, { command: 'bun run test:db:up &', slotClaimIds: [CLAIM] })],
      [`agent_${AGENT_A}`]: [],
    })
    const stopped = await stopLeftoversForEndedClaim(
      { claimId: CLAIM, agentId: AGENT_A, squadId: SQUAD, poolKey: 'shared-box-intensive', reason: 'claim-released' },
      { ...deps, heldClaimIds: async () => [] }
    )
    expect(stopped).toHaveLength(1)
    const selector = { agentId: AGENT_A, slotClaimId: CLAIM, heldSlotClaimIds: [] }
    expect(calls).toEqual([
      { sandboxId: `squad_${SQUAD}`, selector, reason: 'claim-released' },
      { sandboxId: `agent_${AGENT_A}`, selector, reason: 'claim-released' },
    ])
    expect(notices).toHaveLength(1)
    expect(notices[0]!.agentId).toBe(AGENT_A)
    expect(notices[0]!.content).toContain(
      `because your slot claim ${CLAIM} on pool "shared-box-intensive" was released, and they were started while you held it`
    )
    expect(notices[0]!.metadata).toEqual({ source: 'leftover-processes', reason: 'claim-released', claimId: CLAIM })
  })

  it('on expiry passes the claims the owner still holds, so work another claim covers keeps running', async () => {
    const { deps, calls, notices } = harness({ [`squad_${SQUAD}`]: [] })
    // The ended claim itself is never treated as held, even if read before it ended.
    await stopLeftoversForEndedClaim(
      { claimId: CLAIM, agentId: AGENT_A, squadId: SQUAD, poolKey: 'tests', reason: 'claim-expired' },
      { ...deps, heldClaimIds: async () => [CLAIM, OTHER_CLAIM] }
    )
    expect(calls).toEqual([
      {
        sandboxId: `squad_${SQUAD}`,
        selector: { agentId: AGENT_A, slotClaimId: CLAIM, heldSlotClaimIds: [OTHER_CLAIM] },
        reason: 'claim-expired',
      },
    ])
    expect(notices).toEqual([])
  })

  it('names the expiry in plain words', async () => {
    const { deps, notices } = harness({ [`squad_${SQUAD}`]: [group(AGENT_A, { slotClaimIds: [CLAIM] })] })
    await stopLeftoversForEndedClaim(
      { claimId: CLAIM, agentId: AGENT_A, squadId: SQUAD, poolKey: 'tests', reason: 'claim-expired' },
      { ...deps, heldClaimIds: async () => [] }
    )
    expect(notices[0]!.content).toContain(`your slot claim ${CLAIM} on pool "tests" expired`)
  })

  it('stops nothing when the claims still held cannot be read, and never throws', async () => {
    const { deps, calls } = harness({ [`squad_${SQUAD}`]: [group(AGENT_A)] })
    const claim = {
      claimId: CLAIM,
      agentId: AGENT_A,
      squadId: SQUAD,
      poolKey: 'tests',
      reason: 'claim-released' as const,
    }
    expect(await stopLeftoversForEndedClaim(claim, { ...deps, heldClaimIds: async () => undefined })).toEqual([])
    expect(
      await stopLeftoversForEndedClaim(claim, {
        ...deps,
        heldClaimIds: async () => {
          throw new Error('database unavailable')
        },
      })
    ).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('leftoverStopMessage', () => {
  it('says plainly what was killed after the grace period and what may still run', () => {
    const message = leftoverStopMessage('agent-dormant', [
      {
        ...group(AGENT_A, { pids: [1, 2, 3], killedPids: [2], survivingPids: [3] }),
        sandboxId: `squad_${SQUAD}`,
      },
    ])
    expect(message).toContain('Ficus stopped 3 processes')
    expect(message).toContain('1 of them ignored the stop request and was killed after the grace period.')
    expect(message).toContain('Pids 3 could not be stopped and may still be running.')
  })
})
