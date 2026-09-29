import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
      {
        type: 'toolCall',
        id: 'c1',
        name: 'edit',
        arguments: { oldText: 'const ref = "tau:agent:deadbeef"', newText: 'x' },
      },
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
  session.appendMessage({
    role: 'toolResult',
    toolCallId: 'c2',
    toolName: 'read',
    content: [{ type: 'text', text: "expect(parseEntityReference('tau:ws:42'))" }],
    isError: false,
    timestamp: 4,
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

  test('rewrites prose but never tool I/O, and marks only memory_search results', () => {
    const line = (entry: unknown) => JSON.stringify(entry)
    const result = (toolName: string) =>
      line({
        type: 'message',
        message: {
          role: 'toolResult',
          toolName,
          content: [{ type: 'text', text: '[x](tau:ws:1) <!--tau:memory-provenance [] -->' }],
        },
      })
    expect(rewriteSessionLine(result('bash'))).toBe(result('bash'))
    expect(JSON.parse(rewriteSessionLine(result('memory_search'))).message.content[0].text).toBe(
      '[x](tau:ws:1) <!--ficus:memory-provenance [] -->'
    )
    const user = line({ type: 'message', message: { role: 'user', content: 'See [x](tau:ws:1)' } })
    expect(JSON.parse(rewriteSessionLine(user)).message.content).toBe('See [x](ficus:ws:1)')
    const compaction = line({ type: 'compaction', summary: 'Worked on [x](tau:ws:1)' })
    expect(JSON.parse(rewriteSessionLine(compaction)).summary).toBe('Worked on [x](ficus:ws:1)')
  })

  test('leaves a line that JSON.stringify would not reproduce exactly', () => {
    const line = '{"type":"message", "message":{"role":"user","content":"[x](tau:ws:1)"}}'
    expect(rewriteSessionLine(line)).toBe(line)
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
      const { mode, mtimeMs: mtime } = await stat(file)

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
      // Tool I/O is verbatim: an edit's arguments and a file read keep the old scheme.
      expect(transcript).toContain('"oldText":"const ref = \\"tau:agent:deadbeef\\""')
      expect(transcript).toContain("expect(parseEntityReference('tau:ws:42'))")
      // mtime is kept: pi resumes the newest transcript by mtime.
      expect(Math.abs((await stat(file)).mtimeMs - mtime)).toBeLessThan(0.001)
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

  test('retries a failed file at the next starts, then records the pass done and logs what it left', async () => {
    await withHome(async (home) => {
      const sessionDir = join(home, 'sessions', crypto.randomUUID())
      await mkdir(sessionDir, { recursive: true })
      await writeFile(join(sessionDir, 'a.jsonl'), '{"type":"session"}\n')
      const failing = async () => {
        throw new Error('disk trouble')
      }
      const marker = join(home, HOME_TEXT_REWRITE_MARKER)
      for (let attempt = 1; attempt < 3; attempt += 1) {
        expect(await rewriteHomeText({ session: failing })).toEqual({ sessions: 0, memory: 0, failed: 1 })
        expect(existsSync(marker)).toBe(false)
      }
      expect(await rewriteHomeText({ session: failing })).toEqual({ sessions: 0, memory: 0, failed: 1 })
      expect(existsSync(marker)).toBe(true)
      expect(existsSync(`${marker}.attempts`)).toBe(false)
    })
  })

  test('a transient failure is retried and then recorded done', async () => {
    await withHome(async (home) => {
      const sessionDir = join(home, 'sessions', crypto.randomUUID())
      await mkdir(sessionDir, { recursive: true })
      await writeFile(join(sessionDir, 'a.jsonl'), '{"type":"session"}\n')
      const failing = async () => {
        throw new Error('disk trouble')
      }
      expect(await rewriteHomeText({ session: failing })).toEqual({ sessions: 0, memory: 0, failed: 1 })
      expect(await rewriteHomeText()).toEqual({ sessions: 0, memory: 0, failed: 0 })
      expect(existsSync(join(home, HOME_TEXT_REWRITE_MARKER))).toBe(true)
    })
  })

  test('keeps the newest transcript newest, so pi resumes the post-reset session', async () => {
    await withHome(async (home) => {
      const sessionDir = join(home, 'sessions', crypto.randomUUID())
      await mkdir(sessionDir, { recursive: true })
      const older = writeTranscript(sessionDir)
      await utimes(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
      // A reset starts a fresh transcript beside the old one; it holds nothing to rewrite.
      const reset = SessionManager.continueRecent(sessionDir, sessionDir)
      reset.newSession()
      reset.appendMessage({ role: 'user', content: 'after the reset', timestamp: 10 })
      reset.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'fresh start' }],
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
        timestamp: 11,
      } as never)
      const newer = reset.getSessionFile()!
      await utimes(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))
      const newerBefore = await readFile(newer, 'utf8')

      expect(await rewriteHomeText()).toEqual({ sessions: 1, memory: 0, failed: 0 })
      expect((await stat(older)).mtime.toISOString()).toBe('2026-01-01T00:00:00.000Z')
      expect(await readFile(older, 'utf8')).toContain('[#42](ficus:ws:42)')
      expect(await readFile(newer, 'utf8')).toBe(newerBefore)
      expect((await stat(newer)).mtime.toISOString()).toBe('2026-02-01T00:00:00.000Z')
      expect(SessionManager.continueRecent(sessionDir, sessionDir).getSessionFile()).toBe(newer)
    })
  })

  test('clears a temp transcript a crash left behind', async () => {
    await withHome(async (home) => {
      const sessionDir = join(home, 'sessions', crypto.randomUUID())
      await mkdir(sessionDir, { recursive: true })
      const temp = join(sessionDir, 'a.jsonl.ficus-rewrite.tmp')
      await writeFile(temp, 'partial')
      await rewriteHomeText()
      expect(existsSync(temp)).toBe(false)
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
