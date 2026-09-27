import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { setSelectedBackend } from '../config'
import { registerWhoamiCommands, renderWhoami, type WhoamiDependencies, type WhoamiResult } from './whoami'

const tempDirs: string[] = []

function clearEnv() {
  delete process.env.FICUS_AGENT_CONTEXT
  delete process.env.FICUS_AGENT_ID
  delete process.env.FICUS_API_URL
  delete process.env.FICUS_TOKEN
  delete process.env.FICUS_PASSWORD
  delete process.env.FICUS_AUTH_STORE
}

beforeEach(clearEnv)

afterEach(async () => {
  setSelectedBackend(undefined)
  clearEnv()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runWhoami(responses: Record<string, unknown | (() => never)>) {
  const calls: string[] = []
  const printed: Array<{ data: WhoamiResult; message?: string }> = []
  const dependencies = {
    apiGet: mock(async (path: string) => {
      calls.push(path)
      const response = responses[path]
      if (typeof response === 'function') return response()
      if (response === undefined) throw new Error(`Request failed: 404`)
      return response
    }),
    output: mock((data: unknown, message?: string) => {
      printed.push({ data: data as WhoamiResult, message })
    }),
  } as unknown as WhoamiDependencies

  const program = new Command()
  registerWhoamiCommands(program, dependencies)
  await program.parseAsync(['node', 'tau', 'whoami'])
  return { calls, result: printed[0]!.data, message: printed[0]!.message }
}

describe('ficus whoami', () => {
  it('reports server capabilities without a separate request', async () => {
    process.env.FICUS_API_URL = 'http://127.0.0.1:3000'
    process.env.FICUS_TOKEN = 'test-token'
    const server = {
      product: 'ficus',
      version: '0.2.0',
      revision: 'a'.repeat(40),
      apiVersion: 1,
      capabilities: { 'workstreams.workflow-runs': 1 },
    }
    const { calls, result, message } = await runWhoami({
      '/api/auth/introspect': { identity: { type: 'legacy' }, server },
    })
    expect(calls).toEqual(['/api/auth/introspect'])
    expect(result.instance.server).toEqual(server)
    expect(message).toContain('Server: Ficus 0.2.0 · API 1 · aaaaaaaaaaaa')
  })

  it('reports the injected agent identity in an agent shell, without the token', async () => {
    process.env.FICUS_AGENT_CONTEXT = '1'
    process.env.FICUS_AGENT_ID = 'agent-1'
    process.env.FICUS_API_URL = 'http://127.0.0.1:3000'
    process.env.FICUS_TOKEN = 'super-secret-token'

    const { calls, result, message } = await runWhoami({
      '/api/auth/introspect': { identity: { type: 'agent', agentId: 'agent-1', squadId: 'squad-1' } },
    })

    expect(calls).toEqual(['/api/auth/introspect'])
    expect(result.apiUrl).toBe('http://127.0.0.1:3000')
    expect(result.source).toBe('agent-context')
    expect(result.agentId).toBe('agent-1')
    expect(result.identity).toEqual({ type: 'agent', agentId: 'agent-1', squadId: 'squad-1' })
    expect(result.instance.reachable).toBe(true)
    // The credential is never printed, in either output mode.
    expect(JSON.stringify(result)).not.toContain('super-secret-token')
    expect(message).not.toContain('super-secret-token')
    expect(message).toContain('http://127.0.0.1:3000')
    expect(message).toContain('agent-1')
  })

  it('reports the stored backend and the account it belongs to outside an agent shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tau-whoami-'))
    tempDirs.push(dir)
    const authStore = join(dir, 'auth.json')
    await writeFile(
      authStore,
      JSON.stringify({
        active: 'cloud',
        backends: { cloud: { apiUrl: 'https://cloud.example.com', password: 'operator-token' } },
      })
    )
    process.env.FICUS_AUTH_STORE = authStore

    const { calls, result, message } = await runWhoami({
      '/api/auth/introspect': { identity: { type: 'user', userId: 'user-1' } },
      '/api/auth/me': { email: 'operator@example.com', displayName: 'Operator' },
    })

    expect(calls).toEqual(['/api/auth/introspect', '/api/auth/me'])
    expect(result.apiUrl).toBe('https://cloud.example.com')
    expect(result.source).toBe('auth-store')
    expect(result.label).toBe('cloud')
    expect(result.agentId).toBeUndefined()
    expect(result.account).toBe('Operator <operator@example.com>')
    expect(JSON.stringify(result)).not.toContain('operator-token')
    expect(message).toContain('https://cloud.example.com')
    expect(message).toContain('operator@example.com')
  })

  it('still reports the local resolution when the instance cannot be reached', async () => {
    process.env.FICUS_AGENT_CONTEXT = '1'
    process.env.FICUS_API_URL = 'http://127.0.0.1:3000'
    process.env.FICUS_TOKEN = 'agent-token'

    const { result, message } = await runWhoami({
      '/api/auth/introspect': () => {
        throw new Error('connection refused')
      },
    })

    expect(result.source).toBe('agent-context')
    expect(result.identity).toBeNull()
    expect(result.instance).toEqual({ reachable: false, error: 'connection refused' })
    expect(message).toContain('connection refused')
  })

  it('reports the missing variable instead of dying in the state it exists to diagnose', async () => {
    // FICUS_API_URL absent: applying the credential throws, but the diagnostic must not.
    process.env.FICUS_AGENT_CONTEXT = '1'
    process.env.FICUS_AGENT_ID = 'agent-1'

    const { calls, result, message } = await runWhoami({})

    expect(calls).toEqual([])
    expect(result.source).toBe('agent-context')
    expect(result.agentId).toBe('agent-1')
    expect(result.missing).toEqual(['FICUS_API_URL', 'FICUS_TOKEN'])
    expect(result.authenticated).toBe(false)
    expect(result.instance).toEqual({ reachable: false, error: 'FICUS_API_URL and FICUS_TOKEN not set' })
    expect(message).toContain('FICUS_API_URL')
  })

  it('prints every documented key for the agent-context case', async () => {
    process.env.FICUS_AGENT_CONTEXT = '1'
    process.env.FICUS_AGENT_ID = 'agent-1'
    process.env.FICUS_API_URL = 'http://127.0.0.1:3000'
    process.env.FICUS_TOKEN = 'agent-token'

    const { result } = await runWhoami({
      '/api/auth/introspect': { identity: { type: 'agent', agentId: 'agent-1', squadId: null } },
    })

    // The optional keys (`label`, `missing`) are present only where they apply —
    // this pins the shape of THIS case, not a shape common to all of them.
    expect(Object.keys(result).sort()).toEqual([
      'account',
      'agentId',
      'apiUrl',
      'authenticated',
      'identity',
      'instance',
      'source',
    ])
    expect(result.missing).toBeUndefined()
    expect(result.label).toBeUndefined()
  })

  it('renders the unauthenticated case without pretending there is an identity', () => {
    const rendered = renderWhoami({
      apiUrl: 'http://localhost:3000',
      source: 'none',
      authenticated: false,
      identity: null,
      account: null,
      instance: { reachable: false, error: 'Request failed: 401' },
    })

    expect(rendered).toContain('not authenticated')
    expect(rendered).toContain('http://localhost:3000')
  })
})
