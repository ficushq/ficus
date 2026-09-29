import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureSquadWorkspace } from '../squad/workspace'
import { prewarmSandbox } from './prewarm'

const originalHome = process.env.HOME_DIR

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
})

describe('prewarmSandbox', () => {
  it('uses the common squad ensure gate', async () => {
    const calls: string[] = []
    await prewarmSandbox('sq9', async (squadId) => {
      calls.push(squadId)
      return '/workspace/sq9'
    })
    expect(calls).toEqual(['sq9'])
  })

  it('repeated warmup churn creates only the owning squad leaf', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ficus-prewarm-lifecycle-'))
    process.env.HOME_DIR = home
    const squadId = crypto.randomUUID()
    const sandboxIds: string[] = []

    try {
      for (let cycle = 0; cycle < 10; cycle++) {
        await prewarmSandbox(squadId, async (id) => {
          sandboxIds.push(`squad_${id}`)
          return ensureSquadWorkspace(id)
        })
      }

      const root = join(home, 'workspaces', 'squads')
      expect(readdirSync(root)).toEqual([squadId])
      expect(sandboxIds).toEqual(Array(10).fill(`squad_${squadId}`))
      expect(existsSync(join(root, squadId))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
