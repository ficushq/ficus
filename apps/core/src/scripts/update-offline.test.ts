import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OfflineUpdateBlockedError, STALE_RUN_MS, planOfflineUpdate, runOfflineUpdate } from './update-offline'
import type { DeploymentFlavor } from '../services/updates/deployment-flavor'

const flavor: DeploymentFlavor = { source: 'git-checkout', supervisor: 'pm2', sandboxRuntime: 'host' }

describe('planOfflineUpdate', () => {
  it('selects the same tasks as the in-app updater and drops restart commands', () => {
    const plan = planOfflineUpdate(['apps/core/src/x.ts', 'apps/web/src/y.tsx'], flavor)
    expect(plan.tasks).toEqual(['core', 'web'])
    expect(plan.commands.map((c) => c.command.join(' '))).toEqual(['bun run build:core', 'bun run build:web'])
  })
  it('includes install and cli for dependency changes and k3d import only for k3d-local', () => {
    expect(planOfflineUpdate(['bun.lock'], flavor).tasks).toEqual(['install', 'cli', 'core', 'web'])
    expect(planOfflineUpdate(['packages/k8s-sandbox/a'], flavor).tasks).toEqual(['core'])
    expect(planOfflineUpdate(['packages/k8s-sandbox/a'], { ...flavor, sandboxRuntime: 'k3d-local' }).tasks).toEqual([
      'sandbox',
      'core',
    ])
  })
  it('is empty when nothing relevant changed', () => {
    expect(planOfflineUpdate(['README.md'], flavor).commands).toEqual([])
  })
})

describe('runOfflineUpdate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tau-offline-'))
    mkdirSync(join(root, '.git'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('runs the planned commands in the root and persists an offline run', async () => {
    const ran: string[] = []
    const run = await runOfflineUpdate({
      repoRoot: root,
      fromSha: 'a'.repeat(40),
      env: { FICUS_SANDBOX_RUNTIME: 'host' },
      git: async (args) => (args[0] === 'diff' ? 'apps/core/src/x.ts\n' : 'b'.repeat(40) + '\n'),
      runProcess: async (command, cwd) => {
        ran.push(`${cwd}:${command.join(' ')}`)
        return { exitCode: 0, output: '' }
      },
      now: () => '2026-09-02T00:00:00.000Z',
    })
    expect(ran).toEqual([`${root}:bun run build:core`])
    expect(run.mode).toBe('offline')
    expect(run.status).toBe('succeeded')
    expect(run.beforeSha).toBe('a'.repeat(40))
    expect(run.afterSha).toBe('b'.repeat(40))
    expect(run.flavor?.supervisor).toBe('unknown')
    const persisted = JSON.parse(readFileSync(join(root, '.tau', 'local-update-status.json'), 'utf8'))
    expect(persisted.id).toBe(run.id)
    expect(persisted.status).toBe('succeeded')
  })
  it('honours an explicit FICUS_UPDATE_SUPERVISOR', async () => {
    const run = await runOfflineUpdate({
      repoRoot: root,
      fromSha: 'a'.repeat(40),
      env: { FICUS_SANDBOX_RUNTIME: 'host', FICUS_UPDATE_SUPERVISOR: 'systemd' },
      git: async () => '',
      runProcess: async () => ({ exitCode: 0, output: '' }),
    })
    expect(run.flavor?.supervisor).toBe('systemd')
  })
  it('records a failed run when a command fails', async () => {
    const run = await runOfflineUpdate({
      repoRoot: root,
      fromSha: 'a'.repeat(40),
      env: { FICUS_SANDBOX_RUNTIME: 'host' },
      git: async (args) => (args[0] === 'diff' ? 'apps/web/src/y.tsx\n' : 'b'.repeat(40)),
      runProcess: async () => ({ exitCode: 2, output: 'boom' }),
    }).catch((e) => e)
    expect(run).toBeInstanceOf(Error)
    const persisted = JSON.parse(readFileSync(join(root, '.tau', 'local-update-status.json'), 'utf8'))
    expect(persisted.status).toBe('failed')
    expect(persisted.commands[0].status).toBe('failed')
  })
  it('refuses to run while a persisted run is still running', async () => {
    mkdirSync(join(root, '.tau'))
    writeFileSync(
      join(root, '.tau', 'local-update-status.json'),
      JSON.stringify({
        id: 'x',
        status: 'running',
        mode: 'manual',
        startedAt: 't',
        changedFiles: [],
        selectedTasks: [],
        commands: [],
      })
    )
    await expect(
      runOfflineUpdate({
        repoRoot: root,
        fromSha: 'a'.repeat(40),
        env: {},
        git: async () => '',
        runProcess: async () => ({ exitCode: 0, output: '' }),
      })
    ).rejects.toThrow(OfflineUpdateBlockedError)
  })
  it('refuses to run while a persisted checking run is still fresh', async () => {
    mkdirSync(join(root, '.tau'))
    const nowIso = '2026-09-02T00:01:00.000Z'
    writeFileSync(
      join(root, '.tau', 'local-update-status.json'),
      JSON.stringify({
        id: 'x',
        status: 'checking',
        mode: 'manual',
        startedAt: '2026-09-02T00:00:00.000Z',
        changedFiles: [],
        selectedTasks: [],
        commands: [],
      })
    )
    await expect(
      runOfflineUpdate({
        repoRoot: root,
        fromSha: 'a'.repeat(40),
        env: {},
        git: async () => '',
        runProcess: async () => ({ exitCode: 0, output: '' }),
        now: () => nowIso,
      })
    ).rejects.toThrow(OfflineUpdateBlockedError)
  })
  it('reconciles a stale offline run left running regardless of age and proceeds', async () => {
    mkdirSync(join(root, '.tau'))
    writeFileSync(
      join(root, '.tau', 'local-update-status.json'),
      JSON.stringify({
        id: 'x',
        status: 'running',
        mode: 'offline',
        startedAt: '2026-09-02T00:00:00.000Z',
        changedFiles: [],
        selectedTasks: [],
        commands: [],
      })
    )
    const run = await runOfflineUpdate({
      repoRoot: root,
      fromSha: 'a'.repeat(40),
      env: { FICUS_SANDBOX_RUNTIME: 'host' },
      git: async (args) => (args[0] === 'diff' ? 'apps/core/src/x.ts\n' : 'b'.repeat(40)),
      runProcess: async () => ({ exitCode: 0, output: '' }),
      now: () => '2026-09-02T00:00:30.000Z',
    })
    expect(run.status).toBe('succeeded')
    const persisted = JSON.parse(readFileSync(join(root, '.tau', 'local-update-status.json'), 'utf8'))
    expect(persisted.id).toBe(run.id)
  })
  it('reconciles a stale (>2h) non-offline running run and proceeds', async () => {
    mkdirSync(join(root, '.tau'))
    writeFileSync(
      join(root, '.tau', 'local-update-status.json'),
      JSON.stringify({
        id: 'x',
        status: 'running',
        mode: 'manual',
        startedAt: '2026-09-01T21:00:00.000Z',
        changedFiles: [],
        selectedTasks: [],
        commands: [],
      })
    )
    const run = await runOfflineUpdate({
      repoRoot: root,
      fromSha: 'a'.repeat(40),
      env: { FICUS_SANDBOX_RUNTIME: 'host' },
      git: async (args) => (args[0] === 'diff' ? 'apps/core/src/x.ts\n' : 'b'.repeat(40)),
      runProcess: async () => ({ exitCode: 0, output: '' }),
      // 3 hours after the persisted run's startedAt (> STALE_RUN_MS = 2h).
      now: () => new Date(Date.parse('2026-09-01T21:00:00.000Z') + 3 * 60 * 60 * 1000).toISOString(),
    })
    expect(run.status).toBe('succeeded')
  })
  it('still throws for a fresh (<2h) non-offline running run', async () => {
    mkdirSync(join(root, '.tau'))
    const startedAt = '2026-09-02T00:00:00.000Z'
    writeFileSync(
      join(root, '.tau', 'local-update-status.json'),
      JSON.stringify({
        id: 'x',
        status: 'running',
        mode: 'manual',
        startedAt,
        changedFiles: [],
        selectedTasks: [],
        commands: [],
      })
    )
    await expect(
      runOfflineUpdate({
        repoRoot: root,
        fromSha: 'a'.repeat(40),
        env: {},
        git: async () => '',
        runProcess: async () => ({ exitCode: 0, output: '' }),
        // 1 minute after startedAt — well under STALE_RUN_MS.
        now: () => new Date(Date.parse(startedAt) + 60_000).toISOString(),
      })
    ).rejects.toThrow(OfflineUpdateBlockedError)
  })
  it('exposes STALE_RUN_MS as 2 hours', () => {
    expect(STALE_RUN_MS).toBe(2 * 60 * 60 * 1000)
  })
  it('succeeds with no runProcess calls when the diff yields an empty plan', async () => {
    const ran: string[] = []
    const run = await runOfflineUpdate({
      repoRoot: root,
      fromSha: 'a'.repeat(40),
      env: { FICUS_SANDBOX_RUNTIME: 'host' },
      git: async (args) => (args[0] === 'diff' ? '' : 'b'.repeat(40)),
      runProcess: async (command, cwd) => {
        ran.push(`${cwd}:${command.join(' ')}`)
        return { exitCode: 0, output: '' }
      },
    })
    expect(ran).toEqual([])
    expect(run.status).toBe('succeeded')
    expect(run.message).toBe('No build tasks needed for the changed files.')
    expect(run.commands).toEqual([])
  })
})
