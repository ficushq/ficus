import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { HOME_TEXT_REWRITE_MARKER, rewriteHomeText, rewriteSessionLine } from './home-text-rewrite'
import { ShortTermMemoryContext } from './agent/short-term-memory-context'
import { ReindexScheduler } from './memory/indexer/ReindexScheduler'
import { SyncService } from './memory/sync/SyncService'

// Migration history: these fixtures are the pre-rename spellings Task 36c rewrites in HOME_DIR files.
const PRE_RENAME_SNAPSHOT = 'tau:short-term-memory-snapshot'

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = process.env.HOME_DIR
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ficus-home-text-')))
  process.env.HOME_DIR = home
  try {
    await run(home)
  } finally {
    process.env.HOME_DIR = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** A real pi transcript, written by pi itself, holding every pre-rename form. */
function writeTranscript(dir: string): string {
  const session = SessionManager.continueRecent(dir, dir)
  session.appendMessage({ role: 'user', content: 'What about [#41](tau:ws:41)?', timestamp: 1 })
  session.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The user means tau:ws:41.', thinkingSignature: 'signed-over-tau:ws:41' },
      { type: 'text', text: 'See [#42](tau:ws:42), not `tau:ws:43`.' },
    ],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'fixture',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  } as never)
  session.appendMessage({
    role: 'toolResult',
    toolCallId: 't1',
    toolName: 'memory_search',
    content: [{ type: 'text', text: 'Found 0 result(s):\n<!--tau:memory-provenance [] -->' }],
    isError: false,
    timestamp: 3,
  } as never)
  session.appendCustomEntry(PRE_RENAME_SNAPSHOT, { boundaryId: null, content: 'Working on [#42](tau:ws:42)' })
  return session.getSessionFile()!
}

describe('rewriteSessionLine', () => {
  test('leaves lines without pre-rename names, and lines that are not JSON, byte for byte', () => {
    for (const line of ['{"type":"message","b": 1.50,"a":"x"}', '', 'not json tau:ws:1']) {
      expect(rewriteSessionLine(line)).toBe(line)
    }
  })

  test('renames only the snapshot entry type, not another custom type', () => {
    const other = JSON.stringify({ type: 'custom', customType: 'tau:other', data: {} })
    expect(rewriteSessionLine(other)).toBe(other)
    const snapshot = JSON.parse(
      rewriteSessionLine(JSON.stringify({ type: 'custom', customType: PRE_RENAME_SNAPSHOT, data: { content: '' } }))
    )
    expect(snapshot.customType).toBe('ficus:short-term-memory-snapshot')
  })
})

describe('rewriteHomeText', () => {
  test('moves transcripts and memory files to Ficus names once, and pi reads the result', async () => {
    await withHome(async (home) => {
      const agentId = crypto.randomUUID()
      const sessionDir = join(home, 'sessions', agentId)
      await mkdir(sessionDir, { recursive: true })
      const file = writeTranscript(sessionDir)
      const mode = (await stat(file)).mode

      const squadId = crypto.randomUUID()
      const memoryDir = join(home, 'memory', squadId, 'notes')
      await mkdir(memoryDir, { recursive: true })
      const note = join(memoryDir, 'plan.md')
      await writeFile(note, '# Plan\n\nTrack [#42](tau:ws:42).\n\n```\ntau:ws:42\n```\n')
      const plain = join(memoryDir, 'plain.md')
      await writeFile(plain, '# Nothing to rewrite\n')

      expect(await rewriteHomeText()).toEqual({ sessions: 1, memory: 1, failed: 0 })
      // The memory write path scheduled this squad's reindex and sync push; this fixture squad has neither.
      expect(ReindexScheduler.instance().cancel(squadId)).toBe(true)
      expect(SyncService.instance().cancelPendingPush(squadId)).toBe(true)
      expect(existsSync(join(home, HOME_TEXT_REWRITE_MARKER))).toBe(true)
      expect((await stat(file)).mode).toBe(mode)

      const transcript = await readFile(file, 'utf8')
      expect(transcript).toContain('What about [#41](ficus:ws:41)?')
      expect(transcript).toContain('See [#42](ficus:ws:42), not `tau:ws:43`.')
      expect(transcript).toContain('<!--ficus:memory-provenance [] -->')
      // A signed thinking block is replayed to the provider verbatim, so it is never altered.
      expect(transcript).toContain('"thinking":"The user means tau:ws:41."')
      expect(transcript).not.toContain(PRE_RENAME_SNAPSHOT)

      expect(await readFile(note, 'utf8')).toBe('# Plan\n\nTrack [#42](ficus:ws:42).\n\n```\ntau:ws:42\n```\n')
      expect(await readFile(plain, 'utf8')).toBe('# Nothing to rewrite\n')

      // The reopened session finds its snapshot under the Ficus type instead of taking a new one.
      const reopened = SessionManager.continueRecent(sessionDir, sessionDir)
      let reads = 0
      const context = new ShortTermMemoryContext(
        reopened,
        async () => {
          reads += 1
          return 'fresh'
        },
        () => {}
      )
      await context.captureAfterCompaction()
      await context.captureInitial()
      expect(reads).toBe(0)
      expect(JSON.stringify(context.context(reopened.buildSessionContext().messages))).toContain(
        'Working on [#42](ficus:ws:42)'
      )

      // Done once: a later start skips the sweep entirely.
      await writeFile(note, 'Later [#1](tau:ws:1)')
      expect(await rewriteHomeText()).toBeNull()
      expect(await readFile(note, 'utf8')).toBe('Later [#1](tau:ws:1)')
    })
  })

  test('records nothing when a file fails, so the next start retries it', async () => {
    await withHome(async (home) => {
      const sessionDir = join(home, 'sessions', crypto.randomUUID())
      await mkdir(sessionDir, { recursive: true })
      await writeFile(join(sessionDir, 'a.jsonl'), '{"type":"session"}\n')
      const failing = async () => {
        throw new Error('disk trouble')
      }
      expect(await rewriteHomeText({ session: failing })).toEqual({ sessions: 0, memory: 0, failed: 1 })
      expect(existsSync(join(home, HOME_TEXT_REWRITE_MARKER))).toBe(false)
      expect(await rewriteHomeText()).toEqual({ sessions: 0, memory: 0, failed: 0 })
      expect(existsSync(join(home, HOME_TEXT_REWRITE_MARKER))).toBe(true)
    })
  })

  test('skips a memory file Core could never write, instead of retrying it forever', async () => {
    await withHome(async (home) => {
      const dir = join(home, 'memory', crypto.randomUUID())
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'v1..md'), '[#1](tau:ws:1)')
      expect(await rewriteHomeText()).toEqual({ sessions: 0, memory: 0, failed: 0 })
      expect(await readFile(join(dir, 'v1..md'), 'utf8')).toBe('[#1](tau:ws:1)')
    })
  })
})
