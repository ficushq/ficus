import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Command } from 'commander'
import { registerAuthCommands } from './auth'
import { loadAuthStore, redactBackend, saveAuthStore } from '../auth-store'
import { apiGet } from '../client'
import { config } from '../config'
import { output, setOutputOptions } from '../output'
import { loadEnv } from '../env'

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} })
  registerAuthCommands(program)
  return program
}

describe('auth CLI commands', () => {
  let dir: string
  let authPath: string
  const originalAuthStore = process.env.FICUS_AUTH_STORE
  const originalPassword = process.env.FICUS_PASSWORD
  const originalToken = process.env.FICUS_TOKEN
  const originalApiUrl = process.env.FICUS_API_URL

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tau-auth-test-'))
    authPath = join(dir, '.tau', 'cli', 'auth.json')
    process.env.FICUS_AUTH_STORE = authPath
    delete process.env.FICUS_PASSWORD
    delete process.env.FICUS_TOKEN
    delete process.env.FICUS_API_URL
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(output as ReturnType<typeof mock>).mockClear()
    setOutputOptions({})
  })

  afterEach(() => {
    if (originalAuthStore === undefined) delete process.env.FICUS_AUTH_STORE
    else process.env.FICUS_AUTH_STORE = originalAuthStore
    if (originalPassword === undefined) delete process.env.FICUS_PASSWORD
    else process.env.FICUS_PASSWORD = originalPassword
    if (originalToken === undefined) delete process.env.FICUS_TOKEN
    else process.env.FICUS_TOKEN = originalToken
    if (originalApiUrl === undefined) delete process.env.FICUS_API_URL
    else process.env.FICUS_API_URL = originalApiUrl
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers auth subcommands', () => {
    const program = createProgram()
    const auth = program.commands.find((c) => c.name() === 'auth')
    expect(auth).toBeDefined()
    expect(auth?.commands.map((c) => c.name()).sort()).toEqual([
      'introspect',
      'list',
      'login',
      'logout',
      'status',
      'switch',
    ])
  })

  it('custom auth store path does not chmod the parent directory', () => {
    chmodSync(dir, 0o755)

    saveAuthStore(
      {
        active: 'work',
        backends: {
          work: { apiUrl: 'https://ficus.example.com', password: 'secret' },
        },
      },
      join(dir, 'auth.json')
    )

    expect((statSync(dir).mode & 0o777).toString(8)).toBe('755')
    expect((statSync(join(dir, 'auth.json')).mode & 0o777).toString(8)).toBe('600')
  })

  it('login creates a restrictive auth store and active backend', async () => {
    const program = createProgram()
    await program.parseAsync([
      'node',
      'tau',
      'auth',
      'login',
      'work',
      '--api-url',
      'https://ficus.example.com',
      '--password',
      'secret',
    ])

    const store = loadAuthStore(authPath)
    expect(store.active).toBe('work')
    expect(store.backends.work).toEqual({ apiUrl: 'https://ficus.example.com', password: 'secret' })
    expect((statSync(authPath).mode & 0o777).toString(8)).toBe('600')
  })

  it('switch changes the active backend', async () => {
    saveAuthStore(
      {
        active: 'work',
        backends: {
          work: { apiUrl: 'https://work.example.com', password: 'work-secret' },
          local: { apiUrl: 'http://localhost:3000', password: 'local-secret' },
        },
      },
      authPath
    )

    const program = createProgram()
    await program.parseAsync(['node', 'tau', 'auth', 'switch', 'local'])

    expect(loadAuthStore(authPath).active).toBe('local')
  })

  it('logout removes active backend and selects a remaining backend', async () => {
    saveAuthStore(
      {
        active: 'work',
        backends: {
          work: { apiUrl: 'https://work.example.com', password: 'work-secret' },
          local: { apiUrl: 'http://localhost:3000', password: 'local-secret' },
        },
      },
      authPath
    )

    const program = createProgram()
    await program.parseAsync(['node', 'tau', 'auth', 'logout'])

    const store = loadAuthStore(authPath)
    expect(store.backends.work).toBeUndefined()
    expect(store.active).toBe('local')
  })

  it('active stored credentials beat values injected by dotenv while runtime overrides still win', () => {
    saveAuthStore(
      {
        active: 'work',
        backends: {
          work: { apiUrl: 'https://work.example.com', password: 'work-secret' },
        },
      },
      authPath
    )
    writeFileSync(join(dir, '.env'), 'FICUS_API_URL=https://stale.example.com\nFICUS_PASSWORD=stale-secret\n')
    loadEnv({ cwd: dir })

    expect(config.apiUrl).toBe('https://work.example.com')
    expect(config.password).toBe('work-secret')

    process.env.FICUS_API_URL = 'https://override.example.com'
    process.env.FICUS_PASSWORD = 'override-secret'

    expect(config.apiUrl).toBe('https://override.example.com')
    expect(config.password).toBe('override-secret')
  })

  // Regression: a stale repo .env made `ficus auth login` skip the browser device flow entirely
  // and write the dotenv value into auth.json as the backend password. Bun auto-loads ./.env
  // into process.env before any user code runs, so seed process.env exactly as Bun would.
  it('login runs the device flow rather than storing a dotenv password', async () => {
    // A value unique to this file, so bookkeeping left by an earlier test cannot mask the bug.
    writeFileSync(join(dir, '.env'), 'FICUS_PASSWORD=preloaded-secret\n')
    process.env.FICUS_PASSWORD = 'preloaded-secret'
    loadEnv({ cwd: dir })

    const exitCodes: number[] = []
    const originalExit = process.exit
    const originalError = console.error
    console.error = () => {}
    // The device flow reaches an unreachable API and the command exits 1. Capture that instead
    // of killing the test process; the point is that the flow was ENTERED at all.
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0)
      throw new Error('process.exit')
    }) as typeof process.exit
    try {
      await createProgram()
        .parseAsync(['node', 'tau', 'auth', 'login', 'work', '--api-url', 'http://localhost:1'])
        .catch(() => {})
    } finally {
      process.exit = originalExit
      console.error = originalError
    }

    expect(exitCodes).toEqual([1])
    expect(loadAuthStore(authPath).backends.work).toBeUndefined()
  })

  it('logout points at --local-only when the device cannot be revoked', async () => {
    saveAuthStore(
      {
        active: 'work',
        backends: { work: { apiUrl: 'http://localhost:1', password: 'work-secret', deviceId: 'd1' } },
      },
      authPath
    )

    const errors: string[] = []
    const originalExit = process.exit
    const originalError = console.error
    console.error = (message?: unknown) => {
      errors.push(String(message))
    }
    process.exit = (() => {
      throw new Error('process.exit')
    }) as typeof process.exit
    try {
      await createProgram()
        .parseAsync(['node', 'tau', 'auth', 'logout'])
        .catch(() => {})
    } finally {
      process.exit = originalExit
      console.error = originalError
    }

    expect(errors.join('\n')).toContain('--local-only')
  })

  it('status reports the injected agent token as the effective credential (sandbox case)', async () => {
    // No auth-store backend at all — exactly a sandbox, where every command
    // works via FICUS_TOKEN. Status must not claim "No active Ficus backend".
    process.env.FICUS_TOKEN = 'agent-token'
    process.env.FICUS_API_URL = 'https://demo.ficus.sh'
    const program = createProgram()
    await program.parseAsync(['node', 'tau', 'auth', 'status'])
    const [data, summary] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [any, string]
    expect(data.source).toBe('env-token')
    expect(data.authenticated).toBe(true)
    expect(data.apiUrl).toBe('https://demo.ficus.sh')
    expect(summary).toContain('agent token (FICUS_TOKEN)')
    expect(summary).toContain('https://demo.ficus.sh')
    expect(JSON.stringify(data)).not.toContain('agent-token')
  })

  it('status prefers the stored active backend over nothing and reports "none" when unauthenticated', async () => {
    saveAuthStore({ active: 'work', backends: { work: { apiUrl: 'https://work.example.com', password: 'pw' } } })
    let program = createProgram()
    await program.parseAsync(['node', 'tau', 'auth', 'status'])
    let [data, summary] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [any, string]
    expect(data.source).toBe('auth-store')
    expect(data.label).toBe('work')
    expect(data.backend.password).toBe('<redacted>')
    expect(summary).toBe('Active Ficus backend: work (https://work.example.com)')

    saveAuthStore({ active: null, backends: {} })
    program = createProgram()
    await program.parseAsync(['node', 'tau', 'auth', 'status'])
    ;[data, summary] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [any, string]
    expect(data.source).toBe('none')
    expect(data.authenticated).toBe(false)
    expect(summary).toContain('No active Ficus backend configured')
  })

  it('redacts passwords for list/status output', () => {
    const redacted = redactBackend('work', { apiUrl: 'https://work.example.com', password: 'super-secret' }, 'work')

    expect(redacted).toEqual({
      label: 'work',
      apiUrl: 'https://work.example.com',
      active: true,
      password: '<redacted>',
    })
    expect(JSON.stringify(redacted)).not.toContain('super-secret')
  })

  it('introspect fetches effective identity roles and permissions with optional squad scope', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      identity: { type: 'agent', agentId: 'agent-1', squadId: 'squad-1' },
      squadId: 'squad-1',
      roles: [{ slug: 'default-manager', scope: 'squad', source: 'agentType' }],
      permissions: ['squads:read', 'squads:update'],
    })

    const program = createProgram()
    await program.parseAsync(['node', 'tau', 'auth', 'introspect', '--squad', 'squad-1'])

    expect(apiGet).toHaveBeenCalledWith('/api/auth/introspect?squadId=squad-1')
    expect(output).toHaveBeenCalledWith(
      {
        identity: { type: 'agent', agentId: 'agent-1', squadId: 'squad-1' },
        squadId: 'squad-1',
        roles: [{ slug: 'default-manager', scope: 'squad', source: 'agentType' }],
        permissions: ['squads:read', 'squads:update'],
      },
      'Identity agent; roles: default-manager; permissions: 2'
    )
  })
})
