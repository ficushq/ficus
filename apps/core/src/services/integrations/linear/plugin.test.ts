import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstPartyIntegrationPlugin } from '../first-party-plugins'
import { projectIntegrationAssignments } from '../projection/projector'
import { runCapturedProcess } from '../../../test-utils/captured-process'
import { LINEAR_CLI_RELEASE, linearCliSetupStep } from './cli'
import { linearPlugin, linearQuery } from './plugin'

const repoRoot = join(import.meta.dir, '../../../../../..')

test('Linear checks GraphQL errors and validates an API key without leaking provider error text', async () => {
  const old = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      Response.json({ errors: [{ message: 'sensitive provider detail' }] })) as unknown as typeof fetch
    await expect(linearQuery('test-key', '{}')).rejects.toThrow('provider_query_failed')
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe('https://api.linear.app/graphql')
      expect(new Headers(init?.headers).get('Authorization')).toBe('test-key')
      return Response.json({ data: { viewer: { id: 'viewer' } } })
    }) as typeof fetch
    expect(
      await linearPlugin.runtime.provider.validate({ credential: 'test-key', configuration: { version: 1 } } as never)
    ).toEqual({ ok: true, grantedScopes: ['issues:read'] })
  } finally {
    globalThis.fetch = old
  }
})

describe('linearPlugin CLI projection', () => {
  test('is registered with the read and write capability claim and unchanged API-key connection mode', () => {
    expect(firstPartyIntegrationPlugin('linear')).toBe(linearPlugin)
    expect(linearPlugin.presentation).toEqual({
      label: 'Linear',
      description:
        'Connect issue tracking, route assignments to squads, search Linear issues, and let agents read, create, update and comment on issues with the Linear CLI.',
      icon: 'linear',
      connectionMode: 'credential',
      assignable: true,
      requiredCapabilities: ['issues:read', 'issues:write', 'comments:write'],
    })
    expect(linearPlugin.authorization).toEqual({ kind: 'manual' })
    expect(linearPlugin.lifecycle).toEqual({ refresh: false, revoke: false })
    expect(linearPlugin.runtime.provider.outputs).toBeDefined()
  })

  test('wraps the linear binary and injects the credential verbatim with env-file loading off and a pinned endpoint', () => {
    expect(linearPlugin.execution?.binaries).toEqual(['linear'])
    const environment = linearPlugin.execution!.environment
    expect(Object.keys(environment).sort()).toEqual([
      'LINEAR_API_KEY',
      'LINEAR_GRAPHQL_ENDPOINT',
      'LINEAR_IGNORE_ENV_FILE',
    ])
    const resolve = (credential: string) =>
      Object.fromEntries(
        Object.entries(environment).map(([name, value]) => [name, value({ credential, configuration: { version: 1 } })])
      )
    expect(resolve('lin_api_synthetic-key')).toEqual({
      LINEAR_API_KEY: 'lin_api_synthetic-key',
      LINEAR_IGNORE_ENV_FILE: '1',
      LINEAR_GRAPHQL_ENDPOINT: 'https://api.linear.app/graphql',
    })
    // A later OAuth connection supplies a complete Authorization value; it must pass through unchanged.
    expect(resolve('Bearer synthetic-oauth-token').LINEAR_API_KEY).toBe('Bearer synthetic-oauth-token')
  })

  test('installs a pinned, digest-checked release with a version readiness check and the linear skill', () => {
    expect(LINEAR_CLI_RELEASE.version).toBe('3.1.0')
    expect(linearPlugin.sandbox.packages).toEqual(['nodejs@24.12.0', 'xz@5.8.3'])
    expect(linearPlugin.sandbox.setupSteps).toHaveLength(1)
    const [step] = linearPlugin.sandbox.setupSteps
    expect(step!.id).toBe('linear-cli@3.1.0')
    for (const asset of Object.values(LINEAR_CLI_RELEASE.assets)) {
      expect(asset.url).toStartWith('https://github.com/schpet/linear-cli/releases/download/v3.1.0/')
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(step!.script).toContain(`url='${asset.url}'; digest='${asset.sha256}'`)
    }
    expect(step!.script).toContain('if [ "$actual" != "$digest" ]')
    expect(step!.script).not.toContain('npm install')
    expect(step!.script).not.toContain('@latest')
    expect(linearPlugin.sandbox.initHooks).toEqual(['export PATH="$DEVBOX_PROJECT_ROOT/npm/bin:$PATH"'])
    expect(linearPlugin.sandbox.readiness).toEqual([
      { id: 'linear-cli', command: 'linear --version', expectedSubstring: 'linear 3.1.0' },
    ])
    expect(linearPlugin.sandbox.skills).toEqual(['linear'])
    expect(linearPlugin.sandbox.protectedBindings).toEqual([])
    expect(existsSync(join(repoRoot, 'config/skills/linear/SKILL.md'))).toBe(true)
  })

  test('projects the CLI and skill without any credential in the public declaration', () => {
    const projection = projectIntegrationAssignments([
      { plugin: linearPlugin, connection: { id: 'linear-connection', configuration: { version: 1 } } } as any,
    ])
    expect(projection.publicDeclaration.skills).toEqual(['linear'])
    expect(projection.publicDeclaration.readiness).toContainEqual({
      id: 'linear-cli',
      command: 'linear --version',
      expectedSubstring: 'linear 3.1.0',
    })
    expect(projection.publicDeclaration.setupSteps.map((step) => step.id)).toEqual(['linear-cli@3.1.0'])
    expect(JSON.stringify(projection.publicDeclaration)).not.toContain('LINEAR_API_KEY')
  })

  test('the linear skill keeps authentication with Ficus and states the write rules', () => {
    const skill = readFileSync(join(repoRoot, 'config/skills/linear/SKILL.md'), 'utf8')
    expect(skill).toStartWith('---\nname: linear\n')
    for (const phrase of [
      'linear auth login',
      'LINEAR_API_KEY',
      '--json',
      'linear api',
      'explicit confirmation',
      'workflow state',
      'delegate',
      '--workspace',
    ])
      expect(skill).toContain(phrase)
  })
})

describe('Linear CLI installer', () => {
  /** Runs the setup step with fake uname, curl and xz in an isolated project root. */
  async function runInstaller(options: { arch: string; archive: string }) {
    const root = mkdtempSync(join(tmpdir(), 'linear-cli-install-'))
    const bin = join(root, 'bin'),
      temp = join(root, 'tmp'),
      project = join(root, 'project')
    for (const path of [bin, temp, join(project, 'npm/bin')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(project, 'npm/bin/linear'), 'original-cli')
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'uname'), `#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo '${options.arch}'\n`, {
      mode: 0o755,
    })
    writeFileSync(join(root, 'archive'), options.archive)
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\necho called > '${join(root, 'curl-called')}'\ncp '${join(root, 'archive')}' cli.tar.xz\n`,
      { mode: 0o755 }
    )
    writeFileSync(join(bin, 'xz'), `#!/bin/sh\necho called > '${join(root, 'xz-called')}'\nexit 1\n`, { mode: 0o755 })
    try {
      const result = await runCapturedProcess(['/bin/sh', '-c', linearCliSetupStep().script], {
        env: { HOME: root, TMPDIR: temp, PATH: `${bin}:/usr/bin:/bin`, DEVBOX_PROJECT_ROOT: project },
        timeoutMs: 5000,
      })
      return {
        result,
        installed: readFileSync(join(project, 'npm/bin/linear'), 'utf8'),
        versionDir: existsSync(join(project, 'linear-cli')),
        curlCalled: existsSync(join(root, 'curl-called')),
        xzCalled: existsSync(join(root, 'xz-called')),
        tempEntries: readdirSync(temp),
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  for (const arch of ['x86_64', 'aarch64'])
    test(`rejects a tampered ${arch} archive before extracting or installing and cleans temporary files`, async () => {
      const outcome = await runInstaller({ arch, archive: 'tampered archive bytes' })
      expect(outcome.result.kind).toBe('exited')
      if (outcome.result.kind === 'exited') expect(outcome.result.code).not.toBe(0)
      expect(outcome.result.stderr).toContain('Linear CLI archive digest mismatch')
      expect(outcome.curlCalled).toBe(true)
      expect(outcome.xzCalled).toBe(false)
      expect(outcome.installed).toBe('original-cli')
      expect(outcome.versionDir).toBe(false)
      expect(outcome.tempEntries).toEqual([])
    })

  test('refuses an unsupported architecture before downloading', async () => {
    const outcome = await runInstaller({ arch: 'riscv64', archive: '' })
    expect(outcome.result.kind).toBe('exited')
    if (outcome.result.kind === 'exited') expect(outcome.result.code).not.toBe(0)
    expect(outcome.result.stderr).toContain('Unsupported Linear CLI platform')
    expect(outcome.curlCalled).toBe(false)
    expect(outcome.installed).toBe('original-cli')
    expect(outcome.tempEntries).toEqual([])
  })
})
