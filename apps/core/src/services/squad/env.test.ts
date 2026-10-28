import { inArray } from 'drizzle-orm'
import { db, squads } from '../../db'
import { resetSquadEnvSecretSource } from '../security/squad-env-secret-source'
import { resetContentSafetyRegistry } from '../security/content-safety-registry'
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'

// Mock the home module to use a temp directory
const originalEnv = process.env.HOME_DIR
let tempDir: string
const fixtureSquads: string[] = []
async function newSquad(): Promise<string> {
  const [row] = await db
    .insert(squads)
    .values({ name: `env-${randomUUID()}`, purpose: 'env test' })
    .returning({ id: squads.id })
  fixtureSquads.push(row.id)
  return row.id
}

beforeEach(async () => {
  resetContentSafetyRegistry()
  await resetSquadEnvSecretSource()
  tempDir = await mkdtemp(join(tmpdir(), 'squad-env-test-'))
  process.env.HOME_DIR = tempDir
})

afterEach(async () => {
  resetContentSafetyRegistry()
  await resetSquadEnvSecretSource()
  if (fixtureSquads.length) await db.delete(squads).where(inArray(squads.id, fixtureSquads.splice(0)))
  if (originalEnv === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalEnv
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

// Re-import after setting env
async function getModule() {
  // Clear module cache
  delete require.cache[require.resolve('./env')]
  delete require.cache[require.resolve('./workspace')]
  delete require.cache[require.resolve('../../lib/utils/home')]
  return await import('./env')
}

describe('squad-env', () => {
  it('repeated regeneration never captures generated wrappers as user-authored environment', async () => {
    const { regenerateEnvFileForSquad, getEnvFile } = await getModule()
    const { getSquadWorkspacePath } = await import('./workspace')
    const squadId = await newSquad()
    await regenerateEnvFileForSquad(squadId)
    const path = join(getSquadWorkspacePath(squadId), '.ficus', '.env')
    const first = readFileSync(path, 'utf-8')
    await regenerateEnvFileForSquad(squadId)
    expect(readFileSync(path, 'utf-8')).toBe(first)
    expect(getEnvFile(squadId)).toBe('')
    expect(first).not.toContain('gh()')
    expect(first).not.toContain('git()')
    expect(
      readFileSync(join(getSquadWorkspacePath(squadId), '.ficus', 'integration-bin', '.git-config'), 'utf8').match(
        /git\(\)/g
      )
    ).toHaveLength(1)
  })

  describe('getEnvFile', () => {
    it('returns null when .ficus/.env does not exist', async () => {
      const { getEnvFile } = await getModule()
      const squadId = await newSquad()

      const result = getEnvFile(squadId)

      expect(result).toBeNull()
    })

    it('fails closed with a clear error when canonical settings is a file, and regeneration reports failure', async () => {
      const { getEnvFile, regenerateEnvFileForSquadStrict } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const { WORKSPACE_DOT_DIR, WorkspaceDotDirConflictError } = await import('../workspace/dot-dir')
      const squadId = await newSquad()
      const root = getSquadWorkspacePath(squadId)
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, WORKSPACE_DOT_DIR), 'preserved invalid settings')

      expect(() => getEnvFile(squadId)).toThrow(WorkspaceDotDirConflictError)
      // Strict acknowledgements must fail, without writing into the conflicting path.
      await expect(regenerateEnvFileForSquadStrict(squadId)).rejects.toBeInstanceOf(WorkspaceDotDirConflictError)
      expect(existsSync(join(root, WORKSPACE_DOT_DIR, '.env'))).toBe(false)
      expect(readFileSync(join(root, WORKSPACE_DOT_DIR), 'utf-8')).toBe('preserved invalid settings')
    })

    it('returns content when .ficus/.env exists', async () => {
      const { getEnvFile, setEnvFile } = await getModule()
      const squadId = await newSquad()
      const content = 'MY_SECRET=value\nANOTHER_VAR=123'

      await setEnvFile(squadId, content)
      const result = getEnvFile(squadId)

      expect(result).toBe(content)
    })
  })

  describe('setEnvFile', () => {
    it('creates .ficus directory and .env file', async () => {
      const { setEnvFile } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = await newSquad()
      const content = 'SECRET_KEY=abc123'

      await setEnvFile(squadId, content)

      const workspacePath = getSquadWorkspacePath(squadId)
      const envPath = join(workspacePath, '.ficus', '.env')
      expect(existsSync(envPath)).toBe(true)
      expect(readFileSync(envPath, 'utf-8')).toContain(content)
      expect(readFileSync(join(workspacePath, '.ficus', 'integration-bin', '.git-config'), 'utf8')).toContain(
        'ficus integration exec github'
      )
    })

    it('creates .env file with restricted owner or group-only permissions', async () => {
      const { setEnvFile } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = await newSquad()
      const content = 'SECRET=value'

      await setEnvFile(squadId, content)

      const workspacePath = getSquadWorkspacePath(squadId)
      const envPath = join(workspacePath, '.ficus', '.env')
      const stats = statSync(envPath)
      expect([0o600, 0o660]).toContain(stats.mode & 0o777)
    })

    it('overwrites existing .env file', async () => {
      const { setEnvFile, getEnvFile } = await getModule()
      const squadId = await newSquad()

      await setEnvFile(squadId, 'FIRST=1')
      expect(getEnvFile(squadId)).toBe('FIRST=1')

      await setEnvFile(squadId, 'SECOND=2')
      expect(getEnvFile(squadId)).toBe('SECOND=2')
    })

    it('handles empty content', async () => {
      const { setEnvFile, getEnvFile } = await getModule()
      const squadId = await newSquad()

      await setEnvFile(squadId, '')
      expect(getEnvFile(squadId)).toBe('')
    })

    it('handles multiline content', async () => {
      const { setEnvFile, getEnvFile } = await getModule()
      const squadId = await newSquad()
      const content = `# Comment
API_KEY=secret123
DATABASE_URL=postgres://localhost/db
MULTILINE="line1
line2"`

      await setEnvFile(squadId, content)
      expect(getEnvFile(squadId)).toBe(content)
    })
  })

  it('replaces legacy generated plaintext without promoting it into env.user', async () => {
    const { regenerateEnvFileForSquad, getEnvFile } = await getModule()
    const { getSquadWorkspacePath } = await import('./workspace')
    const id = await newSquad()
    const dir = join(getSquadWorkspacePath(id), '.ficus')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '.env'),
      "# Generated from Ficus Secret Store allowlist. Do not edit values here.\nexport OLD_TOKEN='synthetic-exposure'\n"
    )
    await regenerateEnvFileForSquad(id)
    expect(readFileSync(join(dir, '.env'), 'utf8')).not.toContain('synthetic-exposure')
    expect(readFileSync(join(dir, 'env.user'), 'utf8')).toBe('')
    expect(getEnvFile(id)).toBe('')
  })

  it('preserves env.user and custom files while removing stale exports', async () => {
    const { regenerateEnvFileForSquad } = await getModule()
    const { getSquadWorkspacePath } = await import('./workspace')
    const id = await newSquad()
    const dir = join(getSquadWorkspacePath(id), '.ficus')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'env.user'), 'CUSTOM_SECRET=synthetic-custom\n')
    writeFileSync(join(dir, 'custom.conf'), 'unchanged')
    writeFileSync(join(dir, '.env'), "export OLD_TOKEN='synthetic-exposure'\n")
    await regenerateEnvFileForSquad(id)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('CUSTOM_SECRET=synthetic-custom')
    expect(readFileSync(join(dir, '.env'), 'utf8')).not.toContain('synthetic-exposure')
    expect(readFileSync(join(dir, 'env.user'), 'utf8')).toBe('CUSTOM_SECRET=synthetic-custom\n')
    expect(readFileSync(join(dir, 'custom.conf'), 'utf8')).toBe('unchanged')
  })
})

it('preserves legacy custom env comments that are not the exact retired generation marker', async () => {
  const { getEnvFile, regenerateEnvFileForSquad } = await getModule()
  const { getSquadWorkspacePath } = await import('./workspace')
  const id = await newSquad(),
    dot = join(getSquadWorkspacePath(id), '.ficus')
  const content = '# Generated from Ficus application template, not managed credentials\nAPP_MODE=production\n'
  mkdirSync(dot, { recursive: true })
  writeFileSync(join(dot, '.env'), content)
  expect(getEnvFile(id)).toBe(content)
  await regenerateEnvFileForSquad(id)
  expect(readFileSync(join(dot, 'env.user'), 'utf8')).toBe(content)
  expect(readFileSync(join(dot, '.env'), 'utf8')).toContain('APP_MODE=production')
})

it('env service edits reach process-wide output-only detection without blocking app env writes', async () => {
  const { setEnvFile } = await getModule()
  const { getContentSafetyRegistry, resetContentSafetyRegistry } = await import('../security/content-safety-registry')
  const { StoredSecretToolContainment } = await import('../security/stored-secret-tool-containment')
  const { getSquadWorkspacePath } = await import('./workspace')
  const id = await newSquad()
  resetContentSafetyRegistry()
  const registry = getContentSafetyRegistry()
  try {
    await setEnvFile(id, 'APP_TOKEN=synthetic-squad-env-first\nMODE=production')
    expect(registry.redact('synthetic-squad-env-first production')).not.toContain('synthetic-squad-env-first')
    expect(registry.redactWithStoredKeys('synthetic-squad-env-first').storedKeys).toEqual([])
    const agent: import('../security/stored-secret-tool-containment').StoredSecretToolHookTarget = {}
    const containment = new StoredSecretToolContainment({
      agentId: 'test',
      executionId: 'test',
      sink: async () => {
        throw new Error('env must not audit')
      },
    })
    const detach = containment.attachBeforeToolCall(agent, registry)
    expect(
      await agent.beforeToolCall!({
        args: { path: 'app/.env.local', content: 'APP_TOKEN=synthetic-squad-env-first' },
        toolCall: { id: 'env-write', name: 'write', type: 'toolCall', arguments: {} },
        assistantMessage: {} as never,
        context: {} as never,
      })
    ).toBeUndefined()
    detach()
    await setEnvFile(id, 'APP_TOKEN=synthetic-squad-env-next')
    expect(registry.redact('synthetic-squad-env-next')).not.toContain('synthetic-squad-env-next')
    expect(registry.redact('synthetic-squad-env-first')).toBe('synthetic-squad-env-first')
    // Only API/service writes are authoritative; a later disk edit cannot register a scrubber.
    writeFileSync(join(getSquadWorkspacePath(id), '.ficus', 'env.user'), 'APP_TOKEN=synthetic-squad-env-direct')
    expect(registry.redact('synthetic-squad-env-direct')).toBe('synthetic-squad-env-direct')
  } finally {
    resetContentSafetyRegistry()
  }
})

it('oversized service writes leave an existing environment and trusted snapshot untouched', async () => {
  const { setEnvFile, getEnvFile } = await getModule()
  const id = await newSquad()
  await setEnvFile(id, 'APP_TOKEN=synthetic-existing-safe-token')
  await expect(setEnvFile(id, 'é'.repeat(128 * 1024 + 1))).rejects.toThrow('256 KiB')
  expect(getEnvFile(id)).toBe('APP_TOKEN=synthetic-existing-safe-token')
})
