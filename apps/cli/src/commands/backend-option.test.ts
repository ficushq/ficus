import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadAuthStore } from '../auth-store'
import { config, setSelectedBackend } from '../config'
import { loadEnv } from '../env'

const tempDirs: string[] = []

async function makeAuthStore() {
  const dir = await mkdtemp(join(tmpdir(), 'tau-backend-test-'))
  tempDirs.push(dir)
  const authStore = join(dir, 'auth.json')
  await writeFile(
    authStore,
    JSON.stringify({
      active: 'work',
      backends: {
        work: { apiUrl: 'https://work.example.com', password: 'work-token' },
        local: { apiUrl: 'http://localhost:3000', password: 'local-token' },
      },
    })
  )
  return authStore
}

beforeEach(() => {
  delete process.env.FICUS_PASSWORD
  delete process.env.FICUS_API_URL
  delete process.env.FICUS_TOKEN
})

afterEach(async () => {
  setSelectedBackend(undefined)
  delete process.env.FICUS_AUTH_STORE
  delete process.env.FICUS_PASSWORD
  delete process.env.FICUS_API_URL
  delete process.env.FICUS_TOKEN
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('selected backend config', () => {
  it('uses the selected backend for API requests without changing active backend', async () => {
    process.env.FICUS_AUTH_STORE = await makeAuthStore()
    setSelectedBackend('local')

    expect(config.apiUrl).toBe('http://localhost:3000')
    expect(config.password).toBe('local-token')
    expect(loadAuthStore().active).toBe('work')
  })

  it('keeps a selected backend paired ahead of implicit dotenv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tau-backend-dotenv-'))
    tempDirs.push(dir)
    await writeFile(join(dir, '.env'), 'FICUS_API_URL=https://stale.example.com\nFICUS_PASSWORD=stale-token\n')
    loadEnv({ cwd: dir })
    process.env.FICUS_AUTH_STORE = await makeAuthStore()
    setSelectedBackend('local')

    expect(config.apiUrl).toBe('http://localhost:3000')
    expect(config.password).toBe('local-token')
  })

  it('keeps a selected backend indivisible ahead of conflicting ambient credentials', async () => {
    process.env.FICUS_AUTH_STORE = await makeAuthStore()
    process.env.FICUS_TOKEN = 'ambient-sandbox-token'
    process.env.FICUS_PASSWORD = 'ambient-password'
    process.env.FICUS_API_URL = 'https://ambient.example.com'
    setSelectedBackend('local')

    expect(config.apiUrl).toBe('http://localhost:3000')
    expect(config.password).toBe('local-token')
    expect(loadAuthStore().active).toBe('work')
  })

  // The production shape: Bun auto-loads ./.env into process.env before any user code runs,
  // so by the time loadEnv() executes the keys are already set. A stale repo .env must not
  // outrank the active stored backend — that made `ficus squad list` fail with an expired token.
  it('keeps the active backend ahead of a dotenv value Bun auto-loaded into the process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tau-backend-dotenv-'))
    tempDirs.push(dir)
    // Values unique to this file, so leftover bookkeeping from an earlier test cannot be what
    // makes this pass.
    await writeFile(join(dir, '.env'), 'FICUS_API_URL=https://preloaded.example.com\nFICUS_PASSWORD=preloaded-token\n')
    process.env.FICUS_API_URL = 'https://preloaded.example.com'
    process.env.FICUS_PASSWORD = 'preloaded-token'
    loadEnv({ cwd: dir })
    process.env.FICUS_AUTH_STORE = await makeAuthStore()

    expect(config.apiUrl).toBe('https://work.example.com')
    expect(config.password).toBe('work-token')
  })

  it('uses explicit ambient credentials when no backend is selected', async () => {
    process.env.FICUS_AUTH_STORE = await makeAuthStore()
    process.env.FICUS_TOKEN = 'ambient-sandbox-token'
    process.env.FICUS_API_URL = 'https://ambient.example.com'

    expect(config.apiUrl).toBe('https://ambient.example.com')
    expect(config.password).toBe('ambient-sandbox-token')
  })
})
