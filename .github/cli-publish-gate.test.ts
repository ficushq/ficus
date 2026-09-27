import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CLI releases must publish the complete archive and installer set without
// depending on SSH access to a deployment host.

interface Step {
  name?: string
  if?: string
  uses?: string
  env?: Record<string, unknown>
  run?: string
  with?: Record<string, unknown>
}

interface Workflow {
  permissions?: Record<string, string>
  jobs?: Record<string, { steps?: Step[]; permissions?: Record<string, string> }>
}

const workflowPath = join(import.meta.dir, 'workflows/cli-binaries.yml')
const workflow = Bun.YAML.parse(readFileSync(workflowPath, 'utf8')) as Workflow
const steps = workflow.jobs?.['publish-cli-release']?.steps ?? []

function indexOfStep(name: string): number {
  const index = steps.findIndex((candidate) => candidate.name === name)
  if (index === -1) throw new Error(`cli-binaries.yml: no step named ${JSON.stringify(name)} — did it get renamed?`)
  return index
}

const releaseStepIndexes = steps
  .map((step, index) => ({ step, index }))
  .filter(({ step }) => String(step.uses ?? '').startsWith('softprops/action-gh-release'))

describe('CLI publish gate', () => {
  test('all five binaries are built in the release job without Actions artifact storage', () => {
    const serialized = JSON.stringify(workflow)
    expect(serialized).not.toContain('actions/upload-artifact')
    expect(serialized).not.toContain('actions/download-artifact')
    const collect = indexOfStep('Collect release assets')
    for (const target of [
      'bun-darwin-arm64',
      'bun-darwin-x64',
      'bun-linux-arm64',
      'bun-linux-x64',
      'bun-windows-x64',
    ]) {
      const compile = steps.findIndex((step) => step.run?.includes(`--target=${target}`))
      expect(compile).toBeGreaterThan(-1)
      expect(compile).toBeLessThan(collect)
    }
    expect(steps[indexOfStep('Collect release assets')].run).toContain('find dist/packages')
  })

  // `ficus skill install <name>` resolves from the archive's skills/ directory,
  // so every bundled skill under external/skills must be copied — a per-skill
  // `cp` silently ships an archive on which `ficus skill install ficus` fails.
  test('every compile step bundles the whole external/skills directory', () => {
    const compileSteps = steps.filter((step) => step.run?.includes('--compile'))
    expect(compileSteps.length).toBe(5)
    for (const step of compileSteps) {
      expect({ name: step.name, bundlesAllSkills: step.run?.includes('cp -R external/skills/. ') }).toEqual({
        name: step.name,
        bundlesAllSkills: true,
      })
      expect(step.run).not.toContain('external/skills/ficus-memory')
    }
  })

  test('the publish job actually has steps (the parser did not silently find nothing)', () => {
    expect(steps.length).toBeGreaterThan(0)
  })

  // Deliberately serialized rather than `step.run`-only: a marketplace action
  // (burnett01/rsync-deployments and friends) reaches the host through `uses`
  // + `with`, never touching `run`, and a run-only scan waves it straight
  // through.
  test('no step reaches for rsync, ssh or scp — in a run block or a marketplace action', () => {
    const offenders = steps
      .filter((step) => /rsync|\bssh\b|\bscp\b/.test(JSON.stringify(step)))
      .map((step) => step.name ?? step.uses ?? '<unnamed>')
    expect(offenders).toEqual([])
  })

  // The sharper check, and the one that survives a rename: whatever a future
  // step is called and however it reaches the host, it needs credentials, and
  // these five are the only ones that ever pointed at the droplet or the
  // Cloudflare cache. They still exist in GitHub; nothing here may consume
  // them.
  test('the publish job references none of the retired host/Cloudflare secrets', () => {
    const job = JSON.stringify(workflow.jobs?.['publish-cli-release'] ?? {})
    for (const secretName of [
      'PLATFORM_DEPLOY_KEY',
      'PLATFORM_HOST',
      'PLATFORM_HOST_KEY',
      'CLOUDFLARE_CACHE_PURGE_TOKEN',
      'CLOUDFLARE_ZONE_ID',
    ]) {
      expect({ secretName, referenced: job.includes(secretName) }).toEqual({ secretName, referenced: false })
    }
  })

  test('the GitHub release is the delivery surface, with unmatched files failing the run', () => {
    expect(releaseStepIndexes.length).toBeGreaterThan(0)
    const strict = releaseStepIndexes.filter(({ step }) => step.with?.fail_on_unmatched_files === true)
    expect(strict.length).toBe(releaseStepIndexes.length)
  })

  test('the CLI manifest and installer URLs point at the live control plane, not a redirecting host', () => {
    const run = String(steps[indexOfStep('Collect release assets')]?.run ?? '')
    expect(run).not.toContain('hiretau.ai')
    expect(run).toContain('"baseUrl": "https://ficus.sh/cli"')
    expect(JSON.stringify(workflow)).not.toContain('hiretau.ai')
  })

  // The host's publisher (Platform's CLI-publish unit) reads manifest.json's
  // `commit` and the five `assets` keys, and requires each value to be a plain
  // .tar.gz/.zip file name that the release actually carries. Only the names
  // change with the rename; the contract does not.
  test('the manifest lists the five ficus-* archives under the platform keys the host publisher requires', () => {
    const run = String(steps[indexOfStep('Collect release assets')]?.run ?? '')
    const manifestText = run.slice(run.indexOf('cat > dist/release/manifest.json <<EOF'), run.indexOf('\nEOF\n'))
    const json = manifestText.slice(manifestText.indexOf('{'))
    const manifest = JSON.parse(json.replace(/\$[A-Z_]+|\$\([^)]*\)/g, 'x')) as {
      commit: string
      assets: Record<string, string>
    }
    expect(manifest.commit).toBe('x')
    expect(manifest.assets).toEqual({
      'macos-arm64': 'ficus-macos-arm64.tar.gz',
      'macos-x64': 'ficus-macos-x64.tar.gz',
      'linux-arm64': 'ficus-linux-arm64.tar.gz',
      'linux-x64': 'ficus-linux-x64.tar.gz',
      'windows-x64': 'ficus-windows-x64.zip',
    })
    // Each listed archive is one a package step actually writes.
    const packaged = steps
      .filter((step) => /^(tar -czf|cd dist\/)/.test(step.run ?? ''))
      .map((step) => /packages\/([\w.-]+\.(?:tar\.gz|zip))/.exec(step.run ?? '')?.[1])
    expect(packaged.sort()).toEqual(Object.values(manifest.assets).sort())
  })

  test('every archive holds only the ficus binary and the skills, and no step names the old binary', () => {
    const unix = steps.filter((step) => step.run?.startsWith('tar -czf'))
    expect(unix.length).toBe(4)
    for (const step of unix)
      expect(step.run).toMatch(/^tar -czf dist\/packages\/ficus-[\w-]+\.tar\.gz -C dist\/ficus-[\w-]+ ficus skills$/)
    const windows = steps.filter((step) => step.run?.includes('zip -r'))
    expect(windows.map((step) => step.run)).toEqual([
      'cd dist/ficus-windows-x64 && zip -r ../packages/ficus-windows-x64.zip ficus.exe skills',
    ])
    for (const step of steps.filter((candidate) => candidate.run?.includes('--compile'))) {
      expect(step.run).toMatch(/--outfile=dist\/ficus-[\w-]+\/ficus(\.exe)?\n/)
    }
    const oldName = /\btau(\.exe)?\b|\btau-(macos|linux|windows)/
    const offenders = steps
      .filter((step) => oldName.test(`${step.name ?? ''} ${step.run ?? ''}`))
      .map((step) => step.name)
    expect(offenders).toEqual([])
  })

  test('the Linux smoke test runs the ficus binary', () => {
    const smoke = steps.find((step) => step.name?.includes('Smoke test'))
    expect(smoke?.run).toContain('./dist/ficus-linux-x64/ficus --help')
    expect(smoke?.run).toContain('./dist/ficus-linux-x64/ficus --version')
  })

  test('Collect release assets copies install.sh and setup.sh into the published set', () => {
    const run = String(steps[indexOfStep('Collect release assets')]?.run ?? '')
    expect(run).toContain('scripts/install.sh')
    expect(run).toContain('dist/release/install.sh')
    expect(run).toContain('scripts/setup.sh')
    expect(run).toContain('dist/release/setup.sh')
  })

  test('every release step runs AFTER the assets are collected', () => {
    const collect = indexOfStep('Collect release assets')
    for (const { step, index } of releaseStepIndexes) {
      expect({ name: step.name, after: index > collect }).toEqual({ name: step.name, after: true })
    }
  })

  // softprops/action-gh-release reuses the `nightly` release and only adds or
  // overwrites same-named files, and the host publisher mirrors EVERY release
  // asset. Without a prune, an archive the build stopped producing (the
  // pre-rename binary's) would be served from /cli forever.
  describe('nightly prune', () => {
    const pruneIndex = () => indexOfStep('Prune stale nightly assets')
    const prune = () => steps[pruneIndex()]

    test('runs on main, after the nightly upload, with the job token and contents: write', () => {
      const nightly = steps.findIndex((step) => step.with?.tag_name === 'nightly')
      expect(nightly).toBeGreaterThan(-1)
      expect(pruneIndex()).toBeGreaterThan(nightly)
      expect(prune().if).toBe(steps[nightly].if)
      expect(prune().env?.GH_TOKEN).toBe('${{ github.token }}')
      const job = workflow.jobs?.['publish-cli-release']
      expect(job?.permissions?.contents ?? workflow.permissions?.contents).toBe('write')
      expect(prune().run).toContain('gh release view nightly')
      expect(prune().run).toContain('--json assets')
      expect(prune().run).toContain('gh release delete-asset nightly')
      expect(prune().run).not.toMatch(/\btau\b|tau-/)
    })

    test('deletes exactly the nightly assets that are not in dist/release (run against a stub gh)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-prune-'))
      try {
        const current = ['ficus-linux-x64.tar.gz', 'ficus-windows-x64.zip', 'manifest.json', 'install.sh', 'setup.sh']
        mkdirSync(join(dir, 'dist/release'), { recursive: true })
        for (const name of current) writeFileSync(join(dir, 'dist/release', name), 'x')
        const onRelease = [...current, 'old-linux-x64.tar.gz', 'old-windows-x64.zip', 'notes with space.txt']
        mkdirSync(join(dir, 'bin'))
        const log = join(dir, 'gh.log')
        writeFileSync(
          join(dir, 'bin/gh'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >>'${log}'\nif [ "$2" = view ]; then printf '%s\\n' ${onRelease
            .map((name) => `'${name}'`)
            .join(' ')}; fi\n`
        )
        chmodSync(join(dir, 'bin/gh'), 0o755)
        const result = Bun.spawnSync(['bash', '-c', String(prune().run)], {
          cwd: dir,
          env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, GITHUB_REPOSITORY: 'owner/repo', RUNNER_TEMP: dir },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: '' })
        const calls = readFileSync(log, 'utf8').trim().split('\n')
        expect(calls[0]).toBe('release view nightly --repo owner/repo --json assets --jq .assets[].name')
        expect(calls.slice(1)).toEqual([
          'release delete-asset nightly old-linux-x64.tar.gz --repo owner/repo --yes',
          'release delete-asset nightly old-windows-x64.zip --repo owner/repo --yes',
          'release delete-asset nightly notes with space.txt --repo owner/repo --yes',
        ])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
