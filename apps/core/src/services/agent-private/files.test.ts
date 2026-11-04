import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { ConfinedFsError, type ConfinedEntry } from '@ficus/shared/confined-fs'
import type { Agent } from '../../entities/Agent'
import { boxHome } from '../machines/box-paths'
import { parseAgentSandboxId, type AgentPrivateTarget } from './access'
import * as factory from '../sandbox/factory'
import {
  AgentPrivateUnavailableError,
  agentVisiblePrivatePath,
  agentVisiblePrivateRoot,
  listAgentPrivateDir,
  normalizePrivatePath,
  readAgentPrivateFile,
  writeAgentPrivateFile,
} from './files'

const AGENT = '11111111-1111-4111-8111-111111111111'
const SQUAD = '22222222-2222-4222-8222-222222222222'
const target: AgentPrivateTarget = {
  agent: { id: AGENT, ownerUserId: null } as unknown as Agent,
  sandboxId: `agent_${AGENT}`,
  squadId: SQUAD,
  live: true,
}

const originalRuntime = process.env.FICUS_SANDBOX_RUNTIME
const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
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

/** Request paths that name the private root's settings directory, in every spelling a person could send. */
const settingsPaths = () => [
  '.ficus/agent-secrets.env',
  '.FICUS/agent-secrets.env',
  '.ficus./agent-secrets.env',
  '.ficus /agent-secrets.env',
  './.ficus/agent-secrets.env',
  '.ficus//agent-secrets.env',
  '//.ficus/agent-secrets.env',
  'notes/../.ficus/agent-secrets.env',
  // Absolute, as the agent sees it: /private on docker and k8s, ~/.private on vm.
  `${agentVisiblePrivateRoot(target)}/.ficus/agent-secrets.env`,
]

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

function confinedCode(error: unknown): string | undefined {
  return error instanceof ConfinedFsError ? error.code : undefined
}

describe('settings directory in a remote private area (vm and k8s)', () => {
  for (const runtime of ['vm', 'k8s']) {
    test(`${runtime}: refused in Core before the box is contacted, while ordinary paths reach it`, async () => {
      process.env.FICUS_SANDBOX_RUNTIME = runtime
      const calls: { op: string; root: string; path: string }[] = []
      const entries: ConfinedEntry[] = ['.ficus', '.FICUS.', 'notes'].map((name) => ({
        name,
        type: 'directory',
        size: 0,
        modifiedAt: 0,
      }))
      const client = {
        confinedList: async (request: { root: string; path: string }) => {
          calls.push({ op: 'list', ...request })
          return { entries }
        },
        confinedRead: async (request: { root: string; path: string }) => {
          calls.push({ op: 'read', ...request })
          return { content: Buffer.from('ok').toString('base64'), size: 2, truncated: false }
        },
        confinedUpload: async (request: { root: string; path: string }) => {
          calls.push({ op: 'upload', root: request.root, path: request.path })
          return { status: 'created' as const }
        },
      }
      const manager = { getOrAttachClient: async () => client, getClient: async () => client }
      spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(manager as never))
      const content = new TextEncoder().encode('synthetic')

      for (const requested of settingsPaths()) {
        const write = await errorOf(writeAgentPrivateFile(target, requested, content, { overwrite: true }))
        expect([requested, confinedCode(write)]).toEqual([
          requested,
          // Traversal and a non-private absolute path are invalid; every other spelling is not found.
          requested.includes('..') || requested.startsWith('//') ? 'invalid-path' : 'not-found',
        ])
        expect(confinedCode(await errorOf(readAgentPrivateFile(target, requested, 10)))).toBeDefined()
        expect(confinedCode(await errorOf(listAgentPrivateDir(target, requested)))).toBeDefined()
      }
      expect(confinedCode(await errorOf(listAgentPrivateDir(target, '.ficus')))).toBe('not-found')
      expect(calls).toEqual([])

      // A listing of the root never shows the settings directory, in any spelling the box returns.
      expect(await listAgentPrivateDir(target, '')).toEqual([{ name: 'notes', type: 'directory' }])
      expect(await writeAgentPrivateFile(target, 'notes/a.txt', content, { overwrite: false })).toEqual({
        path: 'notes/a.txt',
        status: 'created',
      })
      expect(calls).toEqual([
        { op: 'list', root: '/private', path: '' },
        { op: 'upload', root: '/private', path: 'notes/a.txt' },
      ])
    })
  }

  test('a dormant remote agent is refused on the path before its box state is checked', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const dormant = { ...target, live: false }
    const content = new TextEncoder().encode('synthetic')
    expect(confinedCode(await errorOf(writeAgentPrivateFile(dormant, '.ficus/x', content, { overwrite: true })))).toBe(
      'not-found'
    )
    expect(await errorOf(writeAgentPrivateFile(dormant, 'notes/x', content, { overwrite: true }))).toBeInstanceOf(
      AgentPrivateUnavailableError
    )
  })
})
