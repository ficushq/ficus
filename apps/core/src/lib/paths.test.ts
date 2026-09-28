import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

// mkdtemp on macOS returns a /var/folders path that the child's process.cwd()
// canonicalizes to /private/var/…; realpath the fixture up front so the cwd
// split rule's output matches.
function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'tau-root-')))
}

// MONOREPO_ROOT is resolved ONCE, at module-load, from the environment and
// cwd, so its behavior can only be observed by evaluating the module fresh in a
// child process with the env/cwd we want to exercise.
const pathsModule = join(import.meta.dir, 'paths.ts')

function monorepoRootIn(opts: { cwd: string; tauRoot?: string }): string {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.FICUS_ROOT
  if (opts.tauRoot !== undefined) env.FICUS_ROOT = opts.tauRoot

  const proc = Bun.spawnSync(
    ['bun', '-e', `import { MONOREPO_ROOT } from ${JSON.stringify(pathsModule)}; process.stdout.write(MONOREPO_ROOT)`],
    { cwd: opts.cwd, env, stdout: 'pipe', stderr: 'pipe' }
  )
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr))
  return new TextDecoder().decode(proc.stdout)
}

describe('MONOREPO_ROOT', () => {
  it('uses FICUS_ROOT verbatim when set (never inferred across a symlink rename)', () => {
    const dir = tempDir()
    expect(monorepoRootIn({ cwd: dir, tauRoot: '/opt/tau-core/current' })).toBe('/opt/tau-core/current')
  })

  it('FICUS_ROOT wins even when cwd sits under an apps/core tree', () => {
    const base = tempDir()
    const appCore = join(base, 'apps/core')
    mkdirSync(appCore, { recursive: true })
    expect(monorepoRootIn({ cwd: appCore, tauRoot: '/explicit/anchor' })).toBe('/explicit/anchor')
  })

  it('falls back to the cwd split rule when FICUS_ROOT is unset', () => {
    const base = tempDir()
    const appCore = join(base, 'apps/core')
    mkdirSync(appCore, { recursive: true })
    // cwd = <base>/apps/core → split('apps/core')[0] → '<base>/', which join
    // leaves with its trailing slash (the long-standing shape of MONOREPO_ROOT
    // in normal operation, where cwd is .../apps/core).
    expect(monorepoRootIn({ cwd: appCore })).toBe(`${base}/`)
  })

  it('treats an empty FICUS_ROOT as unset (falls back to the cwd rule)', () => {
    const dir = tempDir()
    // No apps/core in the path → the split rule returns cwd unchanged.
    expect(monorepoRootIn({ cwd: dir, tauRoot: '' })).toBe(dir)
  })

  it('expands a leading ~ in FICUS_ROOT (before resolving)', () => {
    const dir = tempDir()
    expect(monorepoRootIn({ cwd: dir, tauRoot: '~/tau-root-fixture' })).toBe(join(homedir(), 'tau-root-fixture'))
  })

  it('resolves a relative FICUS_ROOT against the subprocess cwd (a stray relative .env value must not silently redirect config paths)', () => {
    const dir = tempDir()
    expect(monorepoRootIn({ cwd: dir, tauRoot: 'relative-root' })).toBe(resolve(dir, 'relative-root'))
  })
})
