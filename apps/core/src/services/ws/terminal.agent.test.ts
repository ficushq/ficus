import { describe, expect, test } from 'bun:test'
import type { Agent } from '../../entities/Agent'
import type { Squad } from '../../entities/Squad'
import type { AgentPrivateTarget } from '../agent-private/access'
import type { StartAgentSandboxOutcome } from '../agent-private/sandbox'
import { prepareTerminalSandbox, type TerminalSandboxDeps } from './terminal'

const AGENT = '11111111-1111-4111-8111-111111111111'
const SQUAD = '22222222-2222-4222-8222-222222222222'

function target(overrides: Partial<AgentPrivateTarget> = {}): AgentPrivateTarget {
  return {
    agent: { id: AGENT } as unknown as Agent,
    sandboxId: `agent_${AGENT}`,
    squadId: SQUAD,
    live: true,
    ...overrides,
  }
}

function deps(overrides: Partial<TerminalSandboxDeps> = {}) {
  const calls: string[] = []
  const value: TerminalSandboxDeps = {
    findSquad: async (id) => (id === SQUAD ? ({ id } as unknown as Squad) : null),
    ensureSquad: async () => {
      calls.push('ensureSquad')
      return '/host/workspaces/squads/s'
    },
    findAgentTarget: async (id) => (id === AGENT ? target() : null),
    startAgent: async (): Promise<StartAgentSandboxOutcome> => {
      calls.push('startAgent')
      return { ok: true }
    },
    privateRoot: () => '/private',
    ...overrides,
  }
  return { value, calls }
}

describe('prepareTerminalSandbox', () => {
  test('squad boxes behave as before: ensure the squad box, shell in its workspace', async () => {
    const { value, calls } = deps()
    expect(await prepareTerminalSandbox(`squad_${SQUAD}`, value)).toEqual({
      ok: true,
      workspacePath: '/host/workspaces/squads/s',
    })
    expect(calls).toEqual(['ensureSquad'])
  })

  test('agent boxes are ensured through the agent path and the shell starts in the private dir', async () => {
    const { value, calls } = deps()
    expect(await prepareTerminalSandbox(`agent_${AGENT}`, value)).toEqual({ ok: true, cwd: '/private' })
    expect(calls).toEqual(['startAgent'])
  })

  test('unknown agents and malformed agent ids never start anything', async () => {
    const { value, calls } = deps()
    expect(await prepareTerminalSandbox('agent_22222222-2222-4222-8222-222222222222', value)).toMatchObject({
      ok: false,
      code: 4004,
    })
    expect(await prepareTerminalSandbox('agent_not-a-uuid', value)).toMatchObject({ ok: false, code: 4004 })
    expect(calls).toEqual([])
  })

  test('a refused start (e.g. dormant agent) closes with its reason', async () => {
    const { value } = deps({
      startAgent: async () => ({ ok: false, reason: 'dormant', message: 'This agent is dormant.' }),
    })
    expect(await prepareTerminalSandbox(`agent_${AGENT}`, value)).toEqual({
      ok: false,
      code: 4009,
      reason: 'This agent is dormant.',
    })
  })
})
