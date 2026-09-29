/**
 * Task 36c: the one-shot rewrite of pre-rename names in files under HOME_DIR, the file-backed half of
 * migration 0196 (which covers the database). Two kinds of file hold them:
 *
 * - Agent session transcripts (`sessions/<agentId>/*.jsonl`): the short-term-memory snapshot entry
 *   type, plus entity references and the memory_search provenance marker in stored message text.
 *   Signed thinking blocks are never touched (a provider rejects an altered one on replay).
 * - Squad memory files (`memory/<squadId>/**.md`): entity references, rewritten through the memory
 *   WriteService under its per-file lock, which also schedules the reindex and sync push.
 *
 * The worker runs it at startup before any agent session opens, and records completion in a marker
 * file so later starts skip it. A file that fails is logged and retried on the next start.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  jsonStringChanges,
  applyJsonStringChanges,
  PRE_RENAME_SNAPSHOT_TYPE,
  rewriteStoredText,
  SNAPSHOT_TYPE,
  STORED_TEXT_CANDIDATE,
} from '../db/stored-text-rewrite'
import { createLogger } from '../lib/infra/logger'
import { getSessionDir } from '../lib/infra/session-files'
import { getHomeDir } from '../lib/utils/home'
import { getSquadMemoryBasePath } from './memory/paths'
import { validateMemoryPath, WriteService } from './memory/WriteService'

const log = createLogger('home-text-rewrite')

export const HOME_TEXT_REWRITE_MARKER = '.ficus-home-text-v1'
const CANDIDATE = new RegExp(`${STORED_TEXT_CANDIDATE}|${PRE_RENAME_SNAPSHOT_TYPE}`, 'i')

const isSignedReasoning = (object: Record<string, unknown>) =>
  object.type === 'thinking' || object.type === 'redacted_thinking'

/** One session-transcript line rewritten, or the same string when nothing in it changes. */
export function rewriteSessionLine(line: string): string {
  if (!CANDIDATE.test(line)) return line
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return line
  }
  let changed = false
  if (entry.type === 'custom' && entry.customType === PRE_RENAME_SNAPSHOT_TYPE) {
    entry.customType = SNAPSHOT_TYPE
    changed = true
  }
  const changes = jsonStringChanges(entry, rewriteStoredText, isSignedReasoning)
  if (changes.length) {
    applyJsonStringChanges(entry, changes)
    changed = true
  }
  return changed ? JSON.stringify(entry) : line
}

/** Rewrites one transcript in place (atomically, keeping its mode). Returns whether it changed. */
export async function rewriteSessionFile(file: string): Promise<boolean> {
  const content = await readFile(file, 'utf8')
  if (!CANDIDATE.test(content)) return false
  const lines = content.split('\n')
  const next = lines.map(rewriteSessionLine)
  if (next.every((line, index) => line === lines[index])) return false
  const temp = `${file}.ficus-rewrite.tmp`
  await writeFile(temp, next.join('\n'), { mode: (await stat(file)).mode })
  await rename(temp, file)
  return true
}

async function* walk(dir: string, keep: (name: string) => boolean): AsyncGenerator<string> {
  if (!existsSync(dir)) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path, keep)
    else if (entry.isFile() && keep(entry.name)) yield path
  }
}

/** Squad memory file `/memory/...` paths through the memory WriteService; a path it rejects is skipped. */
async function rewriteMemoryFile(memoryBase: string, file: string): Promise<boolean> {
  const [squadId, ...rest] = relative(memoryBase, file).split('/')
  if (!squadId || !rest.length || !CANDIDATE.test(await readFile(file, 'utf8'))) return false
  const path = `/memory/${rest.join('/')}`
  try {
    validateMemoryPath(path)
  } catch (error) {
    // Nothing can write such a file through Core, so a retry could never succeed.
    log.warn(`Left memory file ${file} as it is: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  return WriteService.instance().rewrite(squadId, path, rewriteStoredText)
}

export async function rewriteHomeText(
  rewriters: {
    session?: (file: string) => Promise<boolean>
    memory?: (memoryBase: string, file: string) => Promise<boolean>
  } = {}
): Promise<{ sessions: number; memory: number; failed: number } | null> {
  const { session = rewriteSessionFile, memory = rewriteMemoryFile } = rewriters
  const marker = join(getHomeDir(), HOME_TEXT_REWRITE_MARKER)
  if (existsSync(marker)) return null
  const counts = { sessions: 0, memory: 0, failed: 0 }

  const sweep = async (
    label: 'sessions' | 'memory',
    files: AsyncGenerator<string>,
    rewrite: (file: string) => Promise<boolean>
  ) => {
    try {
      for await (const file of files) {
        try {
          if (await rewrite(file)) counts[label] += 1
        } catch (error) {
          counts.failed += 1
          log.warn(`Could not rewrite ${label} file ${file}:`, error)
        }
      }
    } catch (error) {
      counts.failed += 1
      log.warn(`Could not list ${label} files:`, error)
    }
  }

  await sweep(
    'sessions',
    walk(getSessionDir(''), (name) => name.endsWith('.jsonl')),
    session
  )
  const memoryBase = getSquadMemoryBasePath()
  await sweep(
    'memory',
    walk(memoryBase, (name) => name.endsWith('.md')),
    (file) => memory(memoryBase, file)
  )

  if (counts.failed === 0) {
    await writeFile(marker, `${new Date().toISOString()}\n`).catch((error) =>
      log.warn('Could not record the finished rewrite; it runs again at the next start:', error)
    )
  }
  log.info(
    `Rewrote pre-rename names in ${counts.sessions} session file(s) and ${counts.memory} memory file(s)` +
      (counts.failed ? `; ${counts.failed} failed and will be retried at the next start` : '')
  )
  return counts
}
