import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const repoRoot = join(__dirname, '../../../../..')
const resolver = join(repoRoot, 'config/webhooks/scripts/ficus-cli.sh')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A throwaway checkout layout holding only the resolver, plus the given CLI entry files. */
function fakeRoot(entries: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ficus-cli-resolver-'))
  roots.push(root)
  const scripts = join(root, 'config/webhooks/scripts')
  mkdirSync(scripts, { recursive: true })
  copyFileSync(resolver, join(scripts, 'ficus-cli.sh'))
  chmodSync(join(scripts, 'ficus-cli.sh'), 0o755)
  for (const [path, body] of Object.entries(entries)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

const echoEntry = (name: string) => `console.log(${JSON.stringify(name)}, JSON.stringify(process.argv.slice(2)))\n`
const run = (root: string, args: string[]) =>
  spawnSync('bash', [join(root, 'config/webhooks/scripts/ficus-cli.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  })

describe('ficus-cli.sh resolver', () => {
  it('runs the built apps/cli/dist/ficus.js with every argument', () => {
    const root = fakeRoot({
      'apps/cli/dist/ficus.js': echoEntry('dist'),
      'apps/cli/src/index.ts': echoEntry('src'),
    })
    const result = run(root, ['workstream', 'get', 'a b'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('dist ["workstream","get","a b"]')
  })

  it('falls back to apps/cli/src/index.ts when there is no dist build', () => {
    const root = fakeRoot({ 'apps/cli/src/index.ts': echoEntry('src') })
    const result = run(root, ['inbox', 'list'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('src ["inbox","list"]')
  })

  it('exits 127 naming the ficus CLI when neither exists', () => {
    const root = fakeRoot({})
    const result = run(root, ['--help'])
    expect(result.status).toBe(127)
    expect(result.stderr).toBe(
      `ficus-cli.sh: no ficus CLI found (looked for ${root}/apps/cli/dist/ficus.js and ${root}/apps/cli/src/index.ts)\n`
    )
  })

  it('runs the CLI from source when no dist build exists (the tenant case)', () => {
    // The resolver must produce a working CLI without apps/cli/dist. Proven by
    // reaching the CLI's own arg parsing: --help exits 0 and prints usage.
    const run = spawnSync('bash', [resolver, '--help'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env } })
    expect(run.status).toBe(0)
    expect(`${run.stdout}${run.stderr}`.toLowerCase()).toContain('workstream')
  })
})
