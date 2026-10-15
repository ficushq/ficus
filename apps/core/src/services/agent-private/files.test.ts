import { afterEach, describe, expect, test } from 'bun:test'
import { ConfinedFsError } from '@ficus/shared/confined-fs'
import type { Agent } from '../../entities/Agent'
import { boxHome } from '../machines/box-paths'
import { parseAgentSandboxId, type AgentPrivateTarget } from './access'
import { agentVisiblePrivatePath, agentVisiblePrivateRoot, normalizePrivatePath } from './files'

const AGENT = '11111111-1111-4111-8111-111111111111'
const SQUAD = '22222222-2222-4222-8222-222222222222'
const target: AgentPrivateTarget = {
  agent: { id: AGENT, ownerUserId: null } as unknown as Agent,
  sandboxId: `agent_${AGENT}`,
  squadId: SQUAD,
  live: true,
}

const originalRuntime = process.env.FICUS_SANDBOX_RUNTIME
afterEach(() => {
  if (originalRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = originalRuntime
})

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof ConfinedFsError ? error.code : 'other'
  }
  return undefined
}

describe('parseAgentSandboxId', () => {
  test('accepts only agent_<uuid>', () => {
    expect(parseAgentSandboxId(`agent_${AGENT}`)).toBe(AGENT)
    expect(parseAgentSandboxId(`agent_${AGENT.toUpperCase()}`)).toBe(AGENT)
    expect(parseAgentSandboxId(`squad_${SQUAD}`)).toBeNull()
    expect(parseAgentSandboxId('agent_../../squad_x')).toBeNull()
    expect(parseAgentSandboxId(`agent_${AGENT}/x`)).toBeNull()
    expect(parseAgentSandboxId('agent_')).toBeNull()
  })
})

describe('agent-visible private paths', () => {
  test('container runtimes see /private', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-sysbox'
    expect(agentVisiblePrivateRoot(target)).toBe('/private')
    expect(agentVisiblePrivatePath(target, 'creds/token.txt')).toBe('/private/creds/token.txt')
  })

  test('vm boxes see their own ~/.private, not the squad box', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    expect(agentVisiblePrivateRoot(target)).toBe(`${boxHome(`agent_${AGENT}`)}/.private`)
    expect(agentVisiblePrivateRoot(target)).not.toContain(boxHome(`squad_${SQUAD}`))
  })
})

describe('normalizePrivatePath', () => {
  test('accepts relative paths and absolute paths under the agent-visible root', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-sysbox'
    expect(normalizePrivatePath(target, '')).toEqual([])
    expect(normalizePrivatePath(target, 'a/b.txt')).toEqual(['a', 'b.txt'])
    expect(normalizePrivatePath(target, '/private/a/b.txt')).toEqual(['a', 'b.txt'])
    expect(normalizePrivatePath(target, '/private')).toEqual([])
  })

  test('rejects traversal and absolute paths outside the root', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-sysbox'
    expect(codeOf(() => normalizePrivatePath(target, '../squad/workspace'))).toBe('invalid-path')
    expect(codeOf(() => normalizePrivatePath(target, 'a/../../x'))).toBe('invalid-path')
    expect(codeOf(() => normalizePrivatePath(target, '/workspace/x'))).toBe('invalid-path')
    expect(codeOf(() => normalizePrivatePath(target, '/privateer/x'))).toBe('invalid-path')
    expect(codeOf(() => normalizePrivatePath(target, '/private/../etc/passwd'))).toBe('invalid-path')
  })

  test('reports hidden custody paths as not found', () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-sysbox'
    expect(codeOf(() => normalizePrivatePath(target, '.ficus/identity.pem'))).toBe('not-found')
    expect(codeOf(() => normalizePrivatePath(target, '/private/identity.pem'))).toBe('not-found')
  })
})
