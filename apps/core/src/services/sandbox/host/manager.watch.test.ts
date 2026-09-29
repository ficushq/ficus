import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HostSandboxManager } from './manager'
import { clearHostWorkspaceOverrides, setHostWorkspaceOverride } from './workspace-overrides'
import type { WorkspaceFilesIngestInput } from '../../memory/workspace-files'

const SQUAD_A = 'aaaaaaaa-0000-4000-8000-000000000001'

describe('HostSandboxManager workspace watch', () => {
  let home: string
  let prevHome: string | undefined
  let ingested: Array<{ squadId: string; payload: WorkspaceFilesIngestInput }>
  let manager: HostSandboxManager

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ficus-host-watch-'))
    prevHome = process.env.HOME_DIR
    process.env.HOME_DIR = home
    clearHostWorkspaceOverrides()
    ingested = []
    manager = new HostSandboxManager({
      baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
      ingestWorkspaceFiles: async (squadId, payload) => {
        ingested.push({ squadId, payload })
        return { squadFound: true, indexed: 1, deleted: 0, skipped: 0, errors: 0, removed: 0 }
      },
    })
  })
  afterEach(async () => {
    try {
      await manager.cleanup()
    } finally {
      clearHostWorkspaceOverrides()
      if (prevHome === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('configureWatch scans the override-aware squad workspace and reconciles once', async () => {
    const override = join(home, 'override-repo')
    setHostWorkspaceOverride(SQUAD_A, override)
    mkdirSync(join(override, 'docs'), { recursive: true })
    writeFileSync(join(override, 'docs', 'a.md'), '# A')

    const result = await manager.configureWatch(SQUAD_A, { include: ['docs/**/*.md'], exclude: [] })
    expect(result.owned).toBe(true)
    expect(result.fileCount).toBe(1)
    expect(ingested).toHaveLength(1)
    expect(ingested[0].squadId).toBe(SQUAD_A)
    expect(ingested[0].payload.reconcile).toBe(true)
    expect(ingested[0].payload.files[0]).toMatchObject({ path: 'docs/a.md', event: 'change' })

    // repeated identical configure must not rescan (watcher idempotency)
    await manager.configureWatch(SQUAD_A, { include: ['docs/**/*.md'], exclude: [] })
    expect(ingested).toHaveLength(1)
  })

  test('live file change reaches ingest without reconcile', async () => {
    const ws = join(home, 'workspaces', 'squads', SQUAD_A)
    mkdirSync(join(ws, 'docs'), { recursive: true })
    writeFileSync(join(ws, 'docs', 'a.md'), '# v1')
    await manager.configureWatch(SQUAD_A, { include: ['docs/**/*.md'], exclude: [] })

    writeFileSync(join(ws, 'docs', 'a.md'), '# v2')
    const deadline = Date.now() + 10_000
    while (ingested.length < 2 && Date.now() < deadline) await Bun.sleep(250)
    expect(ingested[1].payload.files[0]).toMatchObject({ path: 'docs/a.md', event: 'change' })
    expect(ingested[1].payload.reconcile).toBe(false)
  }, 20_000)

  test('squad-box stop/remove stop watching; member-agent stop does not', async () => {
    const ws = join(home, 'workspaces', 'squads', SQUAD_A)
    mkdirSync(join(ws, 'docs'), { recursive: true })
    await manager.ensureSandbox(`squad_${SQUAD_A}`, { workspacePath: '' })
    await manager.configureWatch(SQUAD_A, { include: ['docs/**'], exclude: [] })
    expect(manager.getWatchStatus(SQUAD_A).active).toBe(true)

    await manager.ensureSandbox('agent_x', { workspacePath: '', squadId: SQUAD_A })
    await manager.stopSandbox('agent_x') // member agent — must not kill the squad watcher
    expect(manager.getWatchStatus(SQUAD_A).active).toBe(true)

    await manager.stopSandbox(`squad_${SQUAD_A}`)
    expect(manager.getWatchStatus(SQUAD_A).active).toBe(false)

    await manager.configureWatch(SQUAD_A, { include: ['docs/**'], exclude: [] })
    await manager.removeSandbox(`squad_${SQUAD_A}`)
    expect(manager.getWatchStatus(SQUAD_A).active).toBe(false)
  })

  test('a second manager (sibling process) cannot own the same squad until released', async () => {
    mkdirSync(join(home, 'workspaces', 'squads', SQUAD_A, 'docs'), { recursive: true })
    await manager.configureWatch(SQUAD_A, { include: ['docs/**'], exclude: [] })

    const sibling = new HostSandboxManager({
      baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
      ingestWorkspaceFiles: async () => ({ squadFound: true }),
    })
    try {
      const denied = await sibling.configureWatch(SQUAD_A, { include: ['docs/**'], exclude: [] })
      expect(denied.owned).toBe(false)
      expect(sibling.getWatchStatus(SQUAD_A).active).toBe(false)

      await manager.stopWatch(SQUAD_A) // release ownership
      const granted = await sibling.configureWatch(SQUAD_A, { include: ['docs/**'], exclude: [] })
      expect(granted.owned).toBe(true)
    } finally {
      await sibling.cleanup()
    }
  })

  test('rejects patterns that escape the workspace and leaves no watcher behind', async () => {
    mkdirSync(join(home, 'workspaces', 'squads', SQUAD_A), { recursive: true })
    await expect(manager.configureWatch(SQUAD_A, { include: ['../elsewhere/**'], exclude: [] })).rejects.toThrow(
      'Unsafe watch pattern'
    )
    expect(manager.getWatchStatus(SQUAD_A).active).toBe(false)
  })
})
