import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CONSULTANT_SCRATCH_ARCHIVE_BATCH,
  CONSULTANT_SCRATCH_ARCHIVE_DIR,
  CONSULTANT_SCRATCH_PRUNE_INTERVAL_MS,
  maybePruneConsultantScratch,
  pruneConsultantScratch,
  resetConsultantScratchPruneForTest,
} from './consultant-scratch'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-20T00:00:00Z')

/** Runs the argv locally, like a sandbox exec, so the real shell scripts are exercised. */
const localManager = {
  exec: async (_sandboxId: string, args: string[]) => {
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${result.stderr.toString()}`)
    return Buffer.from(result.stdout)
  },
}

describe('consultant scratch pruning', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'consultant-scratch-'))
    resetConsultantScratchPruneForTest()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function scratch(id: string, withSecrets = false): string {
    const dir = join(root, 'conversations', id)
    mkdirSync(join(dir, 'notes'), { recursive: true })
    writeFileSync(join(dir, 'notes', 'draft.md'), `scratch of ${id}`)
    if (withSecrets) {
      mkdirSync(join(dir, '.ficus'), { recursive: true })
      writeFileSync(join(dir, '.ficus', 'agent-secrets.env'), 'TOKEN=secret')
    }
    return dir
  }

  const archiveRoot = () => join(root, CONSULTANT_SCRATCH_ARCHIVE_DIR)
  const prune = (statuses: Record<string, string>, now = NOW) =>
    pruneConsultantScratch('squad-1', {
      getManager: () => localManager,
      privateRoot: root,
      loadStatuses: async (ids) => new Map(ids.filter((id) => id in statuses).map((id) => [id, statuses[id]])),
      getRetentionDays: () => 7,
      now,
    })

  it('archives a terminated consultant without its secrets, and a deleted one, keeping live and dormant ones', async () => {
    const [terminated, deleted, idle, dormant] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    scratch(terminated, true)
    scratch(deleted)
    scratch(idle)
    scratch(dormant)
    mkdirSync(join(root, 'conversations', 'not-an-agent'))

    const result = await prune({ [terminated]: 'terminated', [idle]: 'idle', [dormant]: 'dormant' })

    expect(result).toEqual({ kept: 2, archived: 2, purged: 0 })
    expect(readdirSync(join(root, 'conversations')).sort()).toEqual([dormant, idle, 'not-an-agent'].sort())
    const archivedTerminated = join(archiveRoot(), `${terminated}-${NOW.getTime()}`)
    expect(readFileSync(join(archivedTerminated, 'notes', 'draft.md'), 'utf8')).toBe(`scratch of ${terminated}`)
    expect(existsSync(join(archivedTerminated, '.ficus', 'agent-secrets.env'))).toBe(false)
    expect(existsSync(join(archiveRoot(), `${deleted}-${NOW.getTime()}`))).toBe(true)
  })

  it("keeps a dormant (storage-reclaimed) agent's scratch through dormancy and after it wakes", async () => {
    const id = randomUUID()
    scratch(id)
    expect(await prune({ [id]: 'dormant' })).toMatchObject({ kept: 1, archived: 0 })
    // Long after the archive retention: dormancy alone never archives or purges it.
    expect(await prune({ [id]: 'dormant' }, new Date(NOW.getTime() + 400 * DAY))).toMatchObject({ archived: 0 })
    expect(await prune({ [id]: 'idle' }, new Date(NOW.getTime() + 401 * DAY))).toMatchObject({ kept: 1, archived: 0 })
    expect(readFileSync(join(root, 'conversations', id, 'notes', 'draft.md'), 'utf8')).toBe(`scratch of ${id}`)
  })

  it('purges archived scratch older than the archive retention and keeps newer archives', async () => {
    const oldEntry = join(archiveRoot(), `${randomUUID()}-${NOW.getTime() - 8 * DAY}`)
    const recentEntry = join(archiveRoot(), `${randomUUID()}-${NOW.getTime() - 6 * DAY}`)
    const unrelated = join(archiveRoot(), 'keep-me')
    for (const dir of [oldEntry, recentEntry, unrelated]) mkdirSync(dir, { recursive: true })

    expect(await prune({})).toEqual({ kept: 0, archived: 0, purged: 1 })
    expect(existsSync(oldEntry)).toBe(false)
    expect(existsSync(recentEntry)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('archives a backlog larger than one batch in bounded execs and purges once', async () => {
    const ids = Array.from({ length: CONSULTANT_SCRATCH_ARCHIVE_BATCH * 2 + 1 }, () => randomUUID())
    for (const id of ids) mkdirSync(join(root, 'conversations', id), { recursive: true })
    const expired = join(archiveRoot(), `${randomUUID()}-${NOW.getTime() - 8 * DAY}`)
    mkdirSync(expired, { recursive: true })
    const calls: string[][] = []
    const result = await pruneConsultantScratch('squad-1', {
      getManager: () => ({
        exec: async (sandboxId, args) => {
          calls.push(args)
          return localManager.exec(sandboxId, args)
        },
      }),
      privateRoot: root,
      loadStatuses: async () => new Map(),
      getRetentionDays: () => 7,
      now: NOW,
    })

    expect(result).toEqual({ kept: 0, archived: ids.length, purged: 1 })
    // One listing, then three archive batches, each within the batch size.
    const archiveCalls = calls.slice(1)
    expect(archiveCalls).toHaveLength(3)
    for (const args of archiveCalls) expect(args.length - 7).toBeLessThanOrEqual(CONSULTANT_SCRATCH_ARCHIVE_BATCH)
    // Only the last batch carries the retention cutoff.
    expect(archiveCalls.map((args) => args[6] === '0')).toEqual([true, true, false])
    expect(readdirSync(join(root, 'conversations'))).toEqual([])
    expect(existsSync(expired)).toBe(false)
  })

  it('never follows a symlinked scratch dir', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'consultant-scratch-outside-'))
    try {
      writeFileSync(join(outside, 'precious'), 'keep')
      const id = randomUUID()
      mkdirSync(join(root, 'conversations'), { recursive: true })
      symlinkSync(outside, join(root, 'conversations', id))
      expect(await prune({ [id]: 'terminated' })).toEqual({ kept: 0, archived: 0, purged: 0 })
      expect(readFileSync(join(outside, 'precious'), 'utf8')).toBe('keep')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does nothing harmful when the runtime has no conversations yet', async () => {
    expect(await prune({})).toEqual({ kept: 0, archived: 0, purged: 0 })
  })

  it('runs at most once per interval per squad and never throws', async () => {
    let calls = 0
    const failing = {
      exec: async () => {
        calls++
        throw new Error('runtime unavailable')
      },
    }
    const deps = { getManager: () => failing, privateRoot: root, getRetentionDays: () => 7 }
    expect(await maybePruneConsultantScratch('squad-1', { ...deps, nowMs: 0 })).toBeNull()
    expect(await maybePruneConsultantScratch('squad-1', { ...deps, nowMs: 1000 })).toBeNull()
    expect(calls).toBe(1)
    await maybePruneConsultantScratch('squad-2', { ...deps, nowMs: 1000 })
    expect(calls).toBe(2)
    await maybePruneConsultantScratch('squad-1', { ...deps, nowMs: CONSULTANT_SCRATCH_PRUNE_INTERVAL_MS + 1 })
    expect(calls).toBe(3)
  })
})
