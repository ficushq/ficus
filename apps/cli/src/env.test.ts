import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDotenvEnv, getExplicitEnv, loadEnv } from './env'

const dirs: string[] = []
const originalPassword = process.env.FICUS_PASSWORD

afterEach(() => {
  if (originalPassword === undefined) delete process.env.FICUS_PASSWORD
  else process.env.FICUS_PASSWORD = originalPassword
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('loadEnv', () => {
  it('loads only the runtime CWD dotenv rather than compiled source ancestry', () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-env-'))
    dirs.push(root)
    const runtime = join(root, 'runtime')
    const compiled = join(root, 'compiled', 'source')
    mkdirSync(runtime, { recursive: true })
    mkdirSync(compiled, { recursive: true })
    writeFileSync(join(runtime, '.env'), 'FICUS_PASSWORD=runtime-stale\n')
    writeFileSync(join(root, 'compiled', '.env'), 'FICUS_PASSWORD=compiled-stale\n')
    const env: NodeJS.ProcessEnv = {}

    loadEnv({ cwd: runtime, env })

    expect(env.FICUS_PASSWORD).toBe('runtime-stale')
    expect(Object.values(env)).not.toContain('compiled-stale')
  })

  it("bridges the file's legacy TAU_ keys without letting them replace explicit FICUS_ values", () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-env-'))
    dirs.push(root)
    writeFileSync(join(root, '.env'), 'TAU_API_URL=https://file.example\nTAU_PASSWORD=from-file\n')
    const env: NodeJS.ProcessEnv = { FICUS_PASSWORD: 'explicit' }

    loadEnv({ cwd: root, env })

    expect(env).toEqual({ FICUS_API_URL: 'https://file.example', FICUS_PASSWORD: 'explicit' })
  })

  it('does not replace explicit values', () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-env-'))
    dirs.push(root)
    writeFileSync(join(root, '.env'), 'FICUS_PASSWORD=dotenv\n')
    const env: NodeJS.ProcessEnv = { FICUS_PASSWORD: 'explicit' }

    loadEnv({ cwd: root, env })

    expect(env.FICUS_PASSWORD).toBe('explicit')
  })

  it('distinguishes process values injected by dotenv from runtime overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-env-'))
    dirs.push(root)
    writeFileSync(join(root, '.env'), 'FICUS_PASSWORD=dotenv\n')
    delete process.env.FICUS_PASSWORD

    loadEnv({ cwd: root })
    expect(getDotenvEnv('FICUS_PASSWORD')).toBe('dotenv')
    expect(getExplicitEnv('FICUS_PASSWORD')).toBeUndefined()

    process.env.FICUS_PASSWORD = 'explicit'
    expect(getExplicitEnv('FICUS_PASSWORD')).toBe('explicit')
    expect(getDotenvEnv('FICUS_PASSWORD')).toBeUndefined()
  })

  // The shipped CLI is dist/ficus.js with `#!/usr/bin/env bun`, and Bun auto-loads ./.env into
  // process.env BEFORE any user code runs. loadEnv() therefore finds the key already set and
  // injects nothing — but the value is still the dotenv file's, not something the user chose.
  // Classifying it as "explicit" is what let a stale repo .env outrank the auth store.
  it('treats a value Bun already auto-loaded from the cwd dotenv as implicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-env-'))
    dirs.push(root)
    // A value unique to this file: bookkeeping left behind by an earlier test must not be
    // what makes this pass.
    writeFileSync(join(root, '.env'), 'FICUS_PASSWORD=bun-preloaded-secret\n')
    process.env.FICUS_PASSWORD = 'bun-preloaded-secret'

    loadEnv({ cwd: root })

    expect(getExplicitEnv('FICUS_PASSWORD')).toBeUndefined()
    expect(getDotenvEnv('FICUS_PASSWORD')).toBe('bun-preloaded-secret')
  })

  it('keeps a runtime value that differs from the dotenv file explicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-env-'))
    dirs.push(root)
    writeFileSync(join(root, '.env'), 'FICUS_PASSWORD=file-secret\n')
    process.env.FICUS_PASSWORD = 'exported-by-the-user'

    loadEnv({ cwd: root })

    expect(getExplicitEnv('FICUS_PASSWORD')).toBe('exported-by-the-user')
    expect(getDotenvEnv('FICUS_PASSWORD')).toBeUndefined()
  })

  it('continues without throwing when the cwd dotenv exists but is unreadable', () => {
    if (process.getuid?.() === 0) {
      console.log('skipping: running as root, which ignores file mode bits')
      return
    }

    const root = mkdtempSync(join(tmpdir(), 'tau-env-'))
    dirs.push(root)
    const envPath = join(root, '.env')
    writeFileSync(envPath, 'FICUS_PASSWORD=unreadable\n')
    chmodSync(envPath, 0o000)
    const env: NodeJS.ProcessEnv = {}

    try {
      expect(() => loadEnv({ cwd: root, env })).not.toThrow()
      expect(env.FICUS_PASSWORD).toBeUndefined()
    } finally {
      chmodSync(envPath, 0o600)
    }
  })
})
