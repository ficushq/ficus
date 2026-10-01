import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'fs'

// Mock the home module to use a temp directory
const originalEnv = process.env.HOME_DIR
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'squad-env-test-'))
  process.env.HOME_DIR = tempDir
})

afterEach(async () => {
  try {
    const { setGloballyExposedSecretKeys } = await getModule()
    await setGloballyExposedSecretKeys([])
  } catch {
    // Some tests intentionally run before the module has all helpers available.
  }
  if (originalEnv === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalEnv
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

async function createTestSquad(squadId: string) {
  const { db, squads } = await import('../../db')
  await db.insert(squads).values({ id: squadId, name: `Squad ${squadId}`, purpose: 'test' })
}

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
    const squadId = randomUUID()
    await regenerateEnvFileForSquad(squadId)
    const path = join(getSquadWorkspacePath(squadId), '.ficus', '.env')
    const first = readFileSync(path, 'utf-8')
    await regenerateEnvFileForSquad(squadId)
    expect(readFileSync(path, 'utf-8')).toBe(first)
    expect(getEnvFile(squadId)).toBe('')
    expect(first.match(/gh\(\)/g)).toHaveLength(1)
  })

  describe('getEnvFile', () => {
    it('returns null when .ficus/.env does not exist', async () => {
      const { getEnvFile } = await getModule()
      const squadId = randomUUID()

      const result = getEnvFile(squadId)

      expect(result).toBeNull()
    })

    it('reads a workspace still under the legacy dot dir by moving it to .ficus first', async () => {
      const { getEnvFile } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const { LEGACY_WORKSPACE_DOT_DIR, WORKSPACE_DOT_DIR } = await import('../workspace/dot-dir')
      const squadId = randomUUID()
      const root = getSquadWorkspacePath(squadId)
      mkdirSync(join(root, LEGACY_WORKSPACE_DOT_DIR), { recursive: true })
      writeFileSync(join(root, LEGACY_WORKSPACE_DOT_DIR, 'env.user'), 'KEPT=1')

      expect(getEnvFile(squadId)).toBe('KEPT=1')
      expect(readFileSync(join(root, WORKSPACE_DOT_DIR, 'env.user'), 'utf-8')).toBe('KEPT=1')
      expect(readlinkSync(join(root, LEGACY_WORKSPACE_DOT_DIR))).toBe(WORKSPACE_DOT_DIR)
    })

    it('returns content when .ficus/.env exists', async () => {
      const { getEnvFile, setEnvFile } = await getModule()
      const squadId = randomUUID()
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
      const squadId = randomUUID()
      const content = 'SECRET_KEY=abc123'

      await setEnvFile(squadId, content)

      const workspacePath = getSquadWorkspacePath(squadId)
      const envPath = join(workspacePath, '.ficus', '.env')
      expect(existsSync(envPath)).toBe(true)
      expect(readFileSync(envPath, 'utf-8')).toContain(content)
      expect(readFileSync(envPath, 'utf-8')).toContain('ficus integration exec github')
    })

    it('creates .env file with restricted owner or group-only permissions', async () => {
      const { setEnvFile } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = randomUUID()
      const content = 'SECRET=value'

      await setEnvFile(squadId, content)

      const workspacePath = getSquadWorkspacePath(squadId)
      const envPath = join(workspacePath, '.ficus', '.env')
      const stats = statSync(envPath)
      expect([0o600, 0o660]).toContain(stats.mode & 0o777)
    })

    it('overwrites existing .env file', async () => {
      const { setEnvFile, getEnvFile } = await getModule()
      const squadId = randomUUID()

      await setEnvFile(squadId, 'FIRST=1')
      expect(getEnvFile(squadId)).toBe('FIRST=1')

      await setEnvFile(squadId, 'SECOND=2')
      expect(getEnvFile(squadId)).toBe('SECOND=2')
    })

    it('handles empty content', async () => {
      const { setEnvFile, getEnvFile } = await getModule()
      const squadId = randomUUID()

      await setEnvFile(squadId, '')
      expect(getEnvFile(squadId)).toBe('')
    })

    it('handles multiline content', async () => {
      const { setEnvFile, getEnvFile } = await getModule()
      const squadId = randomUUID()
      const content = `# Comment
API_KEY=secret123
DATABASE_URL=postgres://localhost/db
MULTILINE="line1
line2"`

      await setEnvFile(squadId, content)
      expect(getEnvFile(squadId)).toBe(content)
    })
  })

  describe('Secret Store exposure allowlist', () => {
    it('renders only selected secrets into generated sandbox env', async () => {
      const { renderEnvForSecrets } = await getModule()

      const rendered = renderEnvForSecrets('APP_ENV=localDeployment', ['DEPLOY_VERCEL_TOKEN'], (key: string) => {
        const values: Record<string, string> = {
          DEPLOY_VERCEL_TOKEN: 'vercel-secret',
          DEPLOY_NETLIFY_TOKEN: 'netlify-secret',
        }
        return values[key]
      })

      expect(rendered).toContain('APP_ENV=localDeployment')
      expect(rendered).toContain("export DEPLOY_VERCEL_TOKEN='vercel-secret'")
      expect(rendered).not.toContain('DEPLOY_NETLIFY_TOKEN')
      expect(rendered).not.toContain('netlify-secret')
    })

    it('renders protected integration values last so user and selected-secret overrides cannot win', async () => {
      const { renderEnvForSecrets } = await getModule()
      const rendered = renderEnvForSecrets(
        'NOTION_API_TOKEN=user-value',
        ['NOTION_API_TOKEN'],
        () => 'selected-secret-value',
        [
          ['NOTION_WORKSPACE_ID', 'workspace-id'],
          ['NOTION_API_TOKEN', "oauth-'value"],
        ]
      )
      expect(rendered.lastIndexOf('export NOTION_API_TOKEN=')).toBeGreaterThan(
        rendered.indexOf("export NOTION_API_TOKEN='selected-secret-value'")
      )
      expect(rendered).toEndWith("export NOTION_WORKSPACE_ID='workspace-id'")
      expect(rendered).toContain("export NOTION_API_TOKEN='oauth-'\"'\"'value'")
    })

    it('does not treat a non-managed double-underscore environment name as platform-managed', async () => {
      const { renderEnvForSecrets } = await getModule()
      const rendered = renderEnvForSecrets(
        'APP_ENV=x',
        ['__internal_token', 'DEPLOY_VERCEL_TOKEN'],
        (key: string) =>
          ({
            __internal_token: 'self-hosted-client-secret',
            DEPLOY_VERCEL_TOKEN: 'vercel-secret',
          })[key]
      )
      expect(rendered).toContain("export __internal_token='self-hosted-client-secret'")
      expect(rendered).toContain("export DEPLOY_VERCEL_TOKEN='vercel-secret'")
    })

    it('NEVER renders a reserved identity key into a squad env, even when exposed', async () => {
      const { renderEnvForSecrets } = await getModule()
      // A Secret Store key literally named FICUS_API_URL would otherwise be
      // rendered into .ficus/.env and sourced into every agent shell — the exact
      // thing the write-time check on user content refuses.
      const rendered = renderEnvForSecrets(
        'APP_ENV=x',
        ['FICUS_API_URL', 'FICUS_TOKEN', 'DEPLOY_VERCEL_TOKEN'],
        (key: string) =>
          ({
            FICUS_API_URL: 'https://cloud.example.com',
            FICUS_TOKEN: 'operator-token',
            DEPLOY_VERCEL_TOKEN: 'vercel-secret',
          })[key]
      )
      expect(rendered).not.toContain('FICUS_API_URL')
      expect(rendered).not.toContain('operator-token')
      expect(rendered).toContain("export DEPLOY_VERCEL_TOKEN='vercel-secret'")
    })

    it('excludes the self-hosted relay credential from explicit squad exposure', async () => {
      const prior = process.env.FICUS_MANAGED_SECRET_KEYS
      delete process.env.FICUS_MANAGED_SECRET_KEYS
      try {
        const { renderEnvForSecrets } = await getModule()
        const lookedUp: string[] = []
        const rendered = renderEnvForSecrets('', ['FICUS_PUSH_RELAY_TOKEN', 'DEPLOY_VERCEL_TOKEN'], (key: string) => {
          lookedUp.push(key)
          return key === 'FICUS_PUSH_RELAY_TOKEN' ? 'relay-canary' : 'allowed-value'
        })
        expect(lookedUp).toEqual(['DEPLOY_VERCEL_TOKEN'])
        expect(rendered).not.toContain('FICUS_PUSH_RELAY_TOKEN')
        expect(rendered).not.toContain('relay-canary')
        expect(rendered).toContain('allowed-value')
      } finally {
        if (prior === undefined) delete process.env.FICUS_MANAGED_SECRET_KEYS
        else process.env.FICUS_MANAGED_SECRET_KEYS = prior
      }
    })

    it('NEVER renders a platform-managed key into a squad env, even when named explicitly', async () => {
      const privateKeys = [
        'APNS_KEY_ID',
        'FICUS_PLATFORM_INSTANCE_TOKEN',
        'FICUS_PLATFORM_USAGE_TOKEN',
        'NOTION_OAUTH_CLIENT_ID',
        'NOTION_OAUTH_CLIENT_SECRET',
      ]
      process.env.FICUS_MANAGED_SECRET_KEYS = privateKeys.join(',')
      try {
        const { renderEnvForSecrets } = await getModule()
        // A tenant names the managed keys explicitly in the exposure allowlist…
        const rendered = renderEnvForSecrets('APP_ENV=x', [...privateKeys, 'DEPLOY_VERCEL_TOKEN'], (key: string) =>
          key === 'DEPLOY_VERCEL_TOKEN' ? 'vercel-secret' : `${key}-platform-secret`
        )
        // …but they are filtered out at the single chokepoint (normalizeSecretKeys),
        // so neither their names nor values reach the sandbox env.
        for (const key of privateKeys) {
          expect(rendered).not.toContain(key)
          expect(rendered).not.toContain(`${key}-platform-secret`)
        }
        // Non-managed keys still render normally.
        expect(rendered).toContain("export DEPLOY_VERCEL_TOKEN='vercel-secret'")
      } finally {
        delete process.env.FICUS_MANAGED_SECRET_KEYS
      }
    })

    it('renders globally exposed secrets into existing squad env files immediately', async () => {
      const { setEnvFile, setGloballyExposedSecretKeys } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const firstSquadId = randomUUID()
      const secondSquadId = randomUUID()
      await createTestSquad(firstSquadId)
      await createTestSquad(secondSquadId)
      process.env.DEPLOY_VERCEL_TOKEN = 'global-vercel-secret'

      await setEnvFile(firstSquadId, 'APP_ENV=first')
      await setEnvFile(secondSquadId, 'APP_ENV=second')
      await setGloballyExposedSecretKeys(['DEPLOY_VERCEL_TOKEN'])

      const firstEnv = readFileSync(join(getSquadWorkspacePath(firstSquadId), '.ficus', '.env'), 'utf-8')
      const secondEnv = readFileSync(join(getSquadWorkspacePath(secondSquadId), '.ficus', '.env'), 'utf-8')
      expect(firstEnv).toContain('APP_ENV=first')
      expect(firstEnv).toContain("export DEPLOY_VERCEL_TOKEN='global-vercel-secret'")
      expect(secondEnv).toContain('APP_ENV=second')
      expect(secondEnv).toContain("export DEPLOY_VERCEL_TOKEN='global-vercel-secret'")

      delete process.env.DEPLOY_VERCEL_TOKEN
    })

    it('renders globally exposed secrets when a future squad env file is generated', async () => {
      const { setGloballyExposedSecretKeys, regenerateEnvFileForSquad } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = randomUUID()
      await createTestSquad(squadId)
      process.env.DEPLOY_VERCEL_TOKEN = 'future-global-secret'

      await setGloballyExposedSecretKeys(['DEPLOY_VERCEL_TOKEN'])
      await regenerateEnvFileForSquad(squadId)

      const generatedEnv = readFileSync(join(getSquadWorkspacePath(squadId), '.ficus', '.env'), 'utf-8')
      expect(generatedEnv).toContain("export DEPLOY_VERCEL_TOKEN='future-global-secret'")

      delete process.env.DEPLOY_VERCEL_TOKEN
    })

    it('does not expose secret values through getEnvFile', async () => {
      const { setEnvFile, getEnvFile, setExposedSecretKeys } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = randomUUID()
      await createTestSquad(squadId)
      process.env.DEPLOY_VERCEL_TOKEN = 'vercel-secret'

      await setEnvFile(squadId, 'APP_ENV=localDeployment')
      await setExposedSecretKeys(squadId, ['DEPLOY_VERCEL_TOKEN'])

      expect(getEnvFile(squadId)).toBe('APP_ENV=localDeployment')
      const generatedEnv = readFileSync(join(getSquadWorkspacePath(squadId), '.ficus', '.env'), 'utf-8')
      expect(generatedEnv).toContain("export DEPLOY_VERCEL_TOKEN='vercel-secret'")

      delete process.env.DEPLOY_VERCEL_TOKEN
    })

    it('preserves pre-env.user .ficus/.env content on first secret exposure', async () => {
      const { getEnvFile, setExposedSecretKeys } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = randomUUID()
      await createTestSquad(squadId)
      const ficusDir = join(getSquadWorkspacePath(squadId), '.ficus')
      const envPath = join(ficusDir, '.env')
      mkdirSync(ficusDir, { recursive: true })
      writeFileSync(envPath, 'APP_ENV=localDeployment')
      process.env.DEPLOY_VERCEL_TOKEN = 'vercel-secret'

      await setExposedSecretKeys(squadId, ['DEPLOY_VERCEL_TOKEN'])

      const generatedEnv = readFileSync(envPath, 'utf-8')
      expect(generatedEnv).toContain('APP_ENV=localDeployment')
      expect(generatedEnv).toContain("export DEPLOY_VERCEL_TOKEN='vercel-secret'")
      expect(getEnvFile(squadId)).toBe('APP_ENV=localDeployment')
      expect(readFileSync(join(ficusDir, 'env.user'), 'utf-8')).toBe('APP_ENV=localDeployment')

      delete process.env.DEPLOY_VERCEL_TOKEN
    })

    it('ignores forged workspace secret allowlist files when generating sandbox env', async () => {
      const { setEnvFile, setExposedSecretKeys, regenerateEnvFilesForSecretKey } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = randomUUID()
      await createTestSquad(squadId)
      const ficusDir = join(getSquadWorkspacePath(squadId), '.ficus')
      const envPath = join(ficusDir, '.env')

      process.env.DEPLOY_VERCEL_TOKEN = 'approved-secret'
      process.env.DEPLOY_NETLIFY_TOKEN = 'forged-secret'
      await setEnvFile(squadId, 'APP_ENV=localDeployment')
      await setExposedSecretKeys(squadId, ['DEPLOY_VERCEL_TOKEN'])
      writeFileSync(join(ficusDir, 'forged-secret-allowlist.json'), JSON.stringify({ keys: ['DEPLOY_NETLIFY_TOKEN'] }))

      await regenerateEnvFilesForSecretKey('DEPLOY_VERCEL_TOKEN')

      const generatedEnv = readFileSync(envPath, 'utf-8')
      expect(generatedEnv).toContain("export DEPLOY_VERCEL_TOKEN='approved-secret'")
      expect(generatedEnv).not.toContain('DEPLOY_NETLIFY_TOKEN')
      expect(generatedEnv).not.toContain('forged-secret')

      delete process.env.DEPLOY_VERCEL_TOKEN
      delete process.env.DEPLOY_NETLIFY_TOKEN
    })

    it('regenerates exposed secret values after rotation', async () => {
      const { setEnvFile, setExposedSecretKeys, regenerateEnvFilesForSecretKey } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = randomUUID()
      await createTestSquad(squadId)
      const envPath = join(getSquadWorkspacePath(squadId), '.ficus', '.env')

      process.env.DEPLOY_VERCEL_TOKEN = 'old-secret'
      await setEnvFile(squadId, 'APP_ENV=localDeployment')
      await setExposedSecretKeys(squadId, ['DEPLOY_VERCEL_TOKEN'])
      expect(readFileSync(envPath, 'utf-8')).toContain("export DEPLOY_VERCEL_TOKEN='old-secret'")

      process.env.DEPLOY_VERCEL_TOKEN = 'new-secret'
      await regenerateEnvFilesForSecretKey('DEPLOY_VERCEL_TOKEN')

      const generatedEnv = readFileSync(envPath, 'utf-8')
      expect(generatedEnv).toContain("export DEPLOY_VERCEL_TOKEN='new-secret'")
      expect(generatedEnv).not.toContain('old-secret')
      delete process.env.DEPLOY_VERCEL_TOKEN
    })

    it('removes exposed secret values after deletion', async () => {
      const { setEnvFile, setExposedSecretKeys, regenerateEnvFilesForSecretKey } = await getModule()
      const { getSquadWorkspacePath } = await import('./workspace')
      const squadId = randomUUID()
      await createTestSquad(squadId)
      const envPath = join(getSquadWorkspacePath(squadId), '.ficus', '.env')

      process.env.DEPLOY_VERCEL_TOKEN = 'deleted-secret'
      await setEnvFile(squadId, 'APP_ENV=localDeployment')
      await setExposedSecretKeys(squadId, ['DEPLOY_VERCEL_TOKEN'])
      expect(readFileSync(envPath, 'utf-8')).toContain('deleted-secret')

      delete process.env.DEPLOY_VERCEL_TOKEN
      await regenerateEnvFilesForSecretKey('DEPLOY_VERCEL_TOKEN')

      const generatedEnv = readFileSync(envPath, 'utf-8')
      expect(generatedEnv).toContain('APP_ENV=localDeployment')
      expect(generatedEnv).toContain('unset GH_TOKEN GITHUB_TOKEN GITHUB_USER')
      expect(generatedEnv).not.toContain('deleted-secret')
    })
  })
})
