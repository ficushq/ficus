import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../../../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('retired exposure routes, services, prompts and web panel are absent', () => {
  for (const path of [
    'apps/core/src/routes/agent-secrets.ts',
    'apps/core/src/services/agent/secrets.ts',
    'apps/core/src/lib/prompts/agent-secrets-prompt.ts',
    'apps/core/src/services/sandbox/agent-secrets-file.ts',
    'apps/web/src/components/AgentSecretsPanel.tsx',
  ])
    expect(existsSync(resolve(root, path))).toBe(false)
})

test('active generators and runtime entrypoints cannot source or render exposures', () => {
  for (const path of [
    'apps/core/src/services/squad/env.ts',
    'apps/core/src/services/sandbox/asset-manifest.ts',
    'apps/core/src/services/sandbox/ensure.ts',
    'apps/core/src/tools/sandbox-tools.ts',
    'apps/core/src/tools/docker-sandbox.ts',
    'apps/core/src/index.ts',
    ...['subagent', 'squad-worker', 'squad-manager'].map((n) => `apps/core/src/entities/agent-runners/${n}-runner.ts`),
  ])
    expect(read(path)).not.toMatch(/renderSecretExports|normalizeSecretKeys|agentSecrets|AgentSecrets|SecretExposures/)
})

test('Workspace keeps custom environment values and explicitly describes visibility', () => {
  const ui = read('apps/web/src/components/squads/SquadEnvConfig.tsx')
  expect(ui).not.toMatch(/Secret Store|WorkspaceEnvSecrets|selectedSecretKeys/)
  expect(ui).toContain('visible to agents and terminals')
})

test('worker owns immediate/periodic cleanup and restore cannot resurrect retired files', () => {
  expect(read('apps/core/src/worker.ts')).toContain('startExposureCleanup')
  const provisioning = read('scripts/machine/box-provision.sh')
  const extractions = provisioning.split('\n').filter((l) => /tar (?:-x|xzf)/.test(l) && !l.trimStart().startsWith('#'))
  expect(extractions.length).toBe(2)
  for (const line of extractions) expect(line).toContain("--exclude='*/.ficus/agent-secrets.env'")
})

test('restoring an old VM archive excludes retired managed files but preserves env.user', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'restore-retirement-'))
  try {
    const src = join(root, 'src'),
      home = join(root, 'dest'),
      archive = join(root, 'private.tar.gz')
    mkdirSync(join(src, '.private/.ficus'), { recursive: true })
    mkdirSync(join(src, 'workspace/.ficus'), { recursive: true })
    mkdirSync(home)
    writeFileSync(join(src, '.private/.ficus/agent-secrets.env'), 'SYNTH_TOKEN=retired')
    writeFileSync(join(src, 'workspace/.ficus/.env'), 'SYNTH_TOKEN=retired')
    writeFileSync(join(src, 'workspace/.ficus/env.user'), 'CUSTOM=keep')
    expect(Bun.spawnSync(['tar', 'czf', archive, '-C', src, '.private', 'workspace']).exitCode).toBe(0)
    const extraction = read('scripts/machine/box-provision.sh')
      .split('\n')
      .find((l) => l.includes('tar xzf "${RESTORE_TAR}"'))!
    const result = Bun.spawnSync([
      'bash',
      '-c',
      `SUDO=(); RESTORE_TAR=$1; home=$2; ${extraction}`,
      'restore',
      archive,
      home,
    ])
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(home, '.private/.ficus/agent-secrets.env'))).toBe(false)
    expect(existsSync(join(home, 'workspace/.ficus/.env'))).toBe(false)
    expect(readFileSync(join(home, 'workspace/.ficus/env.user'), 'utf8')).toBe('CUSTOM=keep')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
