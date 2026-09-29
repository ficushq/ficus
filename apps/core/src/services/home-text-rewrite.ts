/**
 * Task 36c: the one-shot rewrite of pre-rename names in files under HOME_DIR, the file-backed half of
 * migration 0196 (which covers the database). Two kinds of file hold them:
 *
 * - Agent session transcripts (`sessions/<agentId>/*.jsonl`): the short-term-memory snapshot entry
 *   type (structural), the provenance marker inside memory_search results only, and entity
 *   references in prose only (user and assistant text blocks, the snapshot's saved notes, compaction
 *   summaries). Tool I/O (arguments, file contents, command output) is verbatim and never touched,
 *   nor are signed thinking blocks (a provider rejects an altered one on replay). A rewritten file
 *   keeps its atime and mtime: pi resumes the newest transcript by mtime, so a bumped older one would
 *   silently undo an agent reset.
 * - Squad memory files (`memory/<squadId>/**.md`): entity references, rewritten through the memory
 *   WriteService under its per-file lock, which also schedules the reindex and sync push.
 *
 * The worker runs it at startup before any agent session opens, and records completion in a marker
 * file so later starts skip it. A file that fails is logged and retried at the next start, for at most
 * MAX_ATTEMPTS starts; then the pass is recorded done and the files it could not rewrite are logged.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  PRE_RENAME_SNAPSHOT_TYPE,
  rewriteEntityReferences,
  rewriteMemoryProvenance,
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

const TEMP_SUFFIX = '.ficus-rewrite.tmp'
const MAX_ATTEMPTS = 3

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Rewrites `object[key]` in place when it is a string the rewrite changes. */
function rewriteField(object: Record<string, unknown>, key: string, rewrite: (text: string) => string): boolean {
  const value = object[key]
  if (typeof value !== 'string') return false
  const next = rewrite(value)
  if (next === value) return false
  object[key] = next
  return true
}

/** Rewrites the `text` of every text block in a pi message's content (a string or a block list). */
function rewriteTextBlocks(message: Record<string, unknown>, rewrite: (text: string) => string): boolean {
  if (typeof message.content === 'string') return rewriteField(message, 'content', rewrite)
  if (!Array.isArray(message.content)) return false
  let changed = false
  for (const block of message.content) {
    if (isObject(block) && block.type === 'text') changed = rewriteField(block, 'text', rewrite) || changed
  }
  return changed
}

/** One session-transcript line rewritten, or the same string when nothing in it changes. */
export function rewriteSessionLine(line: string): string {
  if (!CANDIDATE.test(line)) return line
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return line
  }
  // pi writes each line with JSON.stringify, so re-serializing changes only the rewritten strings. A
  // line that does not round-trip exactly (not pi's) is left alone rather than normalized.
  if (!isObject(entry) || JSON.stringify(entry) !== line) return line
  let changed = false
  if (entry.type === 'custom') {
    if (entry.customType === PRE_RENAME_SNAPSHOT_TYPE) {
      entry.customType = SNAPSHOT_TYPE
      changed = true
    }
    if (entry.customType === SNAPSHOT_TYPE && isObject(entry.data)) {
      changed = rewriteField(entry.data, 'content', rewriteEntityReferences) || changed
    }
  } else if (entry.type === 'message' && isObject(entry.message)) {
    const message = entry.message
    if (message.role === 'user' || message.role === 'assistant') {
      changed = rewriteTextBlocks(message, rewriteEntityReferences)
    } else if (message.role === 'toolResult' && message.toolName === 'memory_search') {
      changed = rewriteTextBlocks(message, rewriteMemoryProvenance)
    }
  } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    changed = rewriteField(entry, 'summary', rewriteEntityReferences)
  }
  return changed ? JSON.stringify(entry) : line
}

/**
 * Rewrites one transcript in place: atomically, keeping its mode, atime and mtime (pi picks the
 * session to resume by mtime). Returns whether it changed.
 */
export async function rewriteSessionFile(file: string): Promise<boolean> {
  const content = await readFile(file, 'utf8')
  if (!CANDIDATE.test(content)) return false
  const lines = content.split('\n')
  const next = lines.map(rewriteSessionLine)
  if (next.every((line, index) => line === lines[index])) return false
  const original = await stat(file)
  const temp = `${file}${TEMP_SUFFIX}`
  await writeFile(temp, next.join('\n'), { mode: original.mode })
  // Seconds as a float keep sub-millisecond precision, which a Date would truncate.
  await utimes(temp, original.atimeMs / 1000, original.mtimeMs / 1000)
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
  return WriteService.instance().rewrite(squadId, path, rewriteEntityReferences)
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
  const failures: string[] = []

  // A crash between writing a temp transcript and renaming it leaves the temp file; the original is intact.
  try {
    for await (const temp of walk(getSessionDir(''), (name) => name.endsWith(`.jsonl${TEMP_SUFFIX}`))) {
      await unlink(temp).catch(() => {})
    }
  } catch {
    // Listing trouble surfaces in the sweep below.
  }

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
          failures.push(file)
          log.warn(`Could not rewrite ${label} file ${file}:`, error)
        }
      }
    } catch (error) {
      counts.failed += 1
      failures.push(`${label} listing`)
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

  const attemptsFile = `${marker}.attempts`
  const attempts = counts.failed ? Number((await readFile(attemptsFile, 'utf8').catch(() => '0')).trim()) + 1 || 1 : 0
  const done = counts.failed === 0 || attempts >= MAX_ATTEMPTS
  const record = async (file: string, content: string) =>
    writeFile(file, content).catch((error) => log.warn(`Could not record rewrite progress in ${file}:`, error))
  if (done) {
    await record(marker, `${new Date().toISOString()}\n`)
    await unlink(attemptsFile).catch(() => {})
  } else {
    await record(attemptsFile, `${attempts}\n`)
  }
  log.info(
    `Rewrote pre-rename names in ${counts.sessions} session file(s) and ${counts.memory} memory file(s)` +
      (!counts.failed
        ? ''
        : done
          ? `; gave up after ${attempts} starts on ${counts.failed} file(s): ${failures.join(', ')}`
          : `; ${counts.failed} failed and will be retried at the next start (attempt ${attempts} of ${MAX_ATTEMPTS})`)
  )
  return counts
}
