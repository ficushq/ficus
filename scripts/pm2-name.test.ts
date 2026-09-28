import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, 'pm2-name.ts')

/**
 * Run the helper from a directory with no .env of its own, so the only thing
 * that can name the app is the environment we inject (bun auto-loads the cwd's
 * .env — that is the whole point of the helper, and it must not leak the
 * repo's own .env into these assertions).
 */
async function run(arg: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pm2-name-'))
  try {
    const proc = Bun.spawn([process.execPath, SCRIPT, arg], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('scripts/pm2-name.ts', () => {
  it('prints the instance app name from the environment', async () => {
    expect(await run('api', { FICUS_PM2_API_NAME: 'tau-smoke-api' })).toMatchObject({
      stdout: 'tau-smoke-api',
      code: 0,
    })
    expect(await run('worker', { FICUS_PM2_WORKER_NAME: 'tau-smoke-worker' })).toMatchObject({
      stdout: 'tau-smoke-worker',
      code: 0,
    })
  })
  it('falls back to the default instance names when nothing is set', async () => {
    expect(await run('api')).toMatchObject({ stdout: 'tau-api', code: 0 })
    expect(await run('worker')).toMatchObject({ stdout: 'tau-worker', code: 0 })
  })
  it('ignores the other component name', async () => {
    expect((await run('api', { FICUS_PM2_WORKER_NAME: 'tau-smoke-worker' })).stdout).toBe('tau-api')
  })
  it('exits 2 on a bad argument so a script cannot silently target nothing', async () => {
    const bad = await run('web')
    expect(bad.code).toBe(2)
    expect(bad.stdout).toBe('')
    expect(bad.stderr).toContain('api')
    expect((await run('')).code).toBe(2)
  })
})
