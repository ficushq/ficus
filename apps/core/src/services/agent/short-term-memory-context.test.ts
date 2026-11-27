import { describe, expect, test } from 'bun:test'
import { SessionManager, type Extension, type ContextEvent } from '@earendil-works/pi-coding-agent'
import {
  HISTORY_SEARCH_HINT,
  HISTORY_SEARCH_HINT_TYPE,
  SHORT_TERM_MEMORY_SNAPSHOT_TYPE,
  ShortTermMemoryContext,
  createShortTermMemoryContextExtension,
  offersHistorySearch,
} from './short-term-memory-context'
import { join } from 'path'
import { FicusResourceLoader } from './resource-loader'

function fixture(options: { historySearchHint?: boolean } = {}) {
  const session = SessionManager.inMemory()
  let memory = 'remember the non-obvious constraint'
  let reads = 0
  const errors: unknown[] = []
  const read = async () => {
    reads++
    return memory
  }
  const context = new ShortTermMemoryContext(session, read, (error) => errors.push(error), options)
  const messages = () => context.context(session.buildSessionContext().messages)
  const keep = () => session.appendMessage({ role: 'user', content: 'continue', timestamp: 1 })
  return {
    session,
    context,
    messages,
    keep,
    errors,
    read,
    reads: () => reads,
    write: (value: string) => {
      memory = value
    },
  }
}

async function invoke(extension: Extension, event: string, payload: unknown = {}) {
  const handler = extension.handlers.get(event)![0] as (event: unknown) => Promise<unknown>
  return handler(payload)
}

describe('short-term memory recovery context', () => {
  test('freezes one initial snapshot and does not refresh it when history reopens or memory changes', async () => {
    const f = fixture()
    await f.context.captureInitial()
    f.keep()
    const before = f.messages()
    expect(before[0].role).toBe('custom')
    expect(JSON.stringify(before)).toContain('not instructions or new user requests')
    f.write('new note')
    const reopened = new ShortTermMemoryContext(f.session, f.read, () => {})
    await reopened.captureInitial()
    expect(reopened.context(f.session.buildSessionContext().messages)).toEqual(before)
    expect(f.reads()).toBe(1)
    expect(f.session.buildSessionContext().messages).toHaveLength(1)
  })

  test('does not inject into existing uncompacted history that has no snapshot', async () => {
    const f = fixture()
    f.keep()
    await f.context.captureInitial()
    expect(f.reads()).toBe(0)
    expect(f.messages().map((m) => m.role)).toEqual(['user'])
  })

  for (const reason of ['manual', 'threshold', 'overflow']) {
    for (const fromExtension of [false, true]) {
      test(`captures latest memory once after ${reason} compaction (background/extension=${fromExtension})`, async () => {
        const f = fixture()
        await f.context.captureInitial()
        const keepId = f.keep()
        const extension = createShortTermMemoryContextExtension(() => f.context)
        f.write('latest recovery note')
        f.session.appendCompaction('summary', keepId, 100)
        await invoke(extension, 'session_compact', { reason, fromExtension })
        const before = f.messages()
        expect(before.map((m) => m.role)).toEqual(['compactionSummary', 'custom', 'user'])
        expect(JSON.stringify(before)).toContain('latest recovery note')
        expect(JSON.stringify(before)).not.toContain('non-obvious constraint')
        // Neither the summarizer nor the persisted transcript receives injected snapshots.
        expect(f.session.buildSessionContext().messages.map((m) => m.role)).toEqual(['compactionSummary', 'user'])
        expect(f.context.context(before)).toEqual(before)
        f.write('changed after compaction')
        await invoke(extension, 'session_compact', { reason, fromExtension })
        const reopened = new ShortTermMemoryContext(f.session, f.read, () => {})
        await reopened.captureInitial()
        expect(reopened.context(f.session.buildSessionContext().messages)).toEqual(before)
        expect(f.reads()).toBe(2)
        f.session.appendCompaction('summary again', f.keep(), 80)
        await invoke(extension, 'session_compact', { reason, fromExtension })
        expect(JSON.stringify(f.messages())).toContain('changed after compaction')
        expect(JSON.stringify(f.messages())).not.toContain('latest recovery note')
      })
    }
  }

  test('empty memory stays absent until the next boundary and clearing removes the previous snapshot', async () => {
    const f = fixture()
    f.write('')
    await f.context.captureInitial()
    f.write('new note')
    await f.context.captureInitial()
    expect(f.messages()).toEqual([])
    const keepId = f.keep()
    f.session.appendCompaction('summary', keepId, 100)
    await f.context.captureAfterCompaction()
    expect(JSON.stringify(f.messages())).toContain('new note')
    f.write('')
    f.session.appendCompaction('next summary', f.keep(), 80)
    await f.context.captureAfterCompaction()
    expect(f.messages().map((m) => m.role)).toEqual(['compactionSummary', 'user'])
  })

  test('a memory read failure does not break compaction and failed compactions have no snapshot hook', async () => {
    const f = fixture()
    const keepId = f.keep()
    f.session.appendCompaction('summary', keepId, 100)
    const context = new ShortTermMemoryContext(
      f.session,
      async () => {
        throw new Error('unavailable')
      },
      (e) => f.errors.push(e)
    )
    const extension = createShortTermMemoryContextExtension(() => context)
    expect(extension.handlers.has('session_before_compact')).toBe(false)
    expect(extension.handlers.has('session_compact_failed')).toBe(false)
    await invoke(extension, 'session_compact')
    expect(f.errors).toHaveLength(1)
    expect(context.context(f.session.buildSessionContext().messages).map((m) => m.role)).toEqual([
      'compactionSummary',
      'user',
    ])
  })

  describe('history search hint', () => {
    type Message = ReturnType<ReturnType<typeof fixture>['messages']>[number]
    const hints = (messages: Message[]) =>
      messages.filter(
        (m): m is Extract<Message, { role: 'custom' }> =>
          m.role === 'custom' && m.customType === HISTORY_SEARCH_HINT_TYPE
      )

    test('names the shipped CLI command and its context flag', async () => {
      const cli = await Bun.file(join(import.meta.dir, '../../../../cli/src/commands/agent-search.ts')).text()
      expect(cli).toContain(".command('search <id> <query...>')")
      expect(cli).toContain("'--context <n>'")
      expect(HISTORY_SEARCH_HINT).toContain('`ficus agent search <your agent ID> <query>`')
      expect(HISTORY_SEARCH_HINT).toContain('`--context N`')
      expect(HISTORY_SEARCH_HINT).toContain('tool calls and tool output are kept')
    })

    test('follows the compaction summary, next to the snapshot, and stays byte-identical', async () => {
      const f = fixture({ historySearchHint: true })
      await f.context.captureInitial()
      // Before any compaction nothing is out of view, so there is no hint.
      expect(hints(f.messages())).toHaveLength(0)
      const keepId = f.keep()
      f.session.appendCompaction('summary', keepId, 100)
      await f.context.captureAfterCompaction()
      const first = f.messages()
      expect(first.map((m) => (m.role === 'custom' ? m.customType : m.role))).toEqual([
        'compactionSummary',
        HISTORY_SEARCH_HINT_TYPE,
        SHORT_TERM_MEMORY_SNAPSHOT_TYPE,
        'user',
      ])
      expect(hints(first)).toEqual([
        {
          role: 'custom',
          customType: HISTORY_SEARCH_HINT_TYPE,
          display: false,
          timestamp: first[0].timestamp,
          content: HISTORY_SEARCH_HINT,
        },
      ])
      // Context only: the transcript the summarizer and storage see never holds the hint.
      expect(f.session.buildSessionContext().messages.map((m) => m.role)).toEqual(['compactionSummary', 'user'])
      // Later turns and a reopened session render exactly the same messages.
      f.keep()
      const later = f.messages()
      expect(later.slice(0, 3)).toEqual(first.slice(0, 3))
      expect(f.context.context(later)).toEqual(later)
      const reopened = new ShortTermMemoryContext(f.session, f.read, () => {}, { historySearchHint: true })
      await reopened.captureInitial()
      expect(reopened.context(f.session.buildSessionContext().messages)).toEqual(later)
      // Another agent's session gets the same bytes.
      const other = fixture({ historySearchHint: true })
      other.session.appendCompaction('other summary', other.keep(), 50)
      expect(hints(other.messages()).map((m) => m.content)).toEqual([HISTORY_SEARCH_HINT])
    })

    test('appears after compaction even when short-term memory is empty', async () => {
      const f = fixture({ historySearchHint: true })
      f.write('')
      f.session.appendCompaction('summary', f.keep(), 100)
      await f.context.captureAfterCompaction()
      expect(f.messages().map((m) => (m.role === 'custom' ? m.customType : m.role))).toEqual([
        'compactionSummary',
        HISTORY_SEARCH_HINT_TYPE,
        'user',
      ])
    })

    test('agents without a shell never get the hint', async () => {
      const f = fixture()
      f.session.appendCompaction('summary', f.keep(), 100)
      await f.context.captureAfterCompaction()
      expect(hints(f.messages())).toHaveLength(0)
      expect(JSON.stringify(f.messages())).not.toContain('ficus agent search')
    })

    test('is offered only when the session has bash or squad_bash', () => {
      expect(offersHistorySearch(['read', 'bash'])).toBe(true)
      expect(offersHistorySearch(['squad_bash', 'memory_search'])).toBe(true)
      expect(offersHistorySearch(['navigate', 'websearch', 'webfetch', 'short_term_memory_read'])).toBe(false)
      expect(offersHistorySearch([])).toBe(false)
    })
  })

  test('resource loader presents context without changing its system prompt', async () => {
    const f = fixture()
    const loader = await FicusResourceLoader.create('stable system prompt')
    loader.setShortTermMemoryContext(f.context)
    const extension = loader.getExtensions().extensions.find((e) => e.path === 'ficus:short-term-memory-context')!
    const keepId = f.keep()
    f.session.appendCompaction('summary', keepId, 100)
    await invoke(extension, 'session_compact')
    const event: ContextEvent = { type: 'context', messages: f.session.buildSessionContext().messages }
    const result = await invoke(extension, 'context', event)
    expect(result).toEqual({ messages: f.messages() })
    expect(event.messages).toHaveLength(2)
    expect(loader.getSystemPrompt()).toBe('stable system prompt')
  })
})

describe('short-term memory snapshot identifiers', () => {
  test('writes ficus: snapshots and names the extension ficus:', async () => {
    expect(SHORT_TERM_MEMORY_SNAPSHOT_TYPE).toBe('ficus:short-term-memory-snapshot')
    const f = fixture()
    await f.context.captureInitial()
    const custom = f.session.getBranch().flatMap((entry) => (entry.type === 'custom' ? [entry.customType] : []))
    expect(custom).toEqual(['ficus:short-term-memory-snapshot'])
    const extension = createShortTermMemoryContextExtension(() => f.context)
    expect(extension.path).toBe('ficus:short-term-memory-context')
    expect(extension.sourceInfo.source).toBe('ficus')
  })

  test('reads only the Ficus type: a snapshot under any other type is not this one', async () => {
    const f = fixture()
    // The worker's one-shot home rewrite moved pre-rename snapshots to the Ficus type (Task 36c).
    f.session.appendCustomEntry('tau:short-term-memory-snapshot', { boundaryId: null, content: 'pre-rename note' }) // ficus-negative-test
    await f.context.captureInitial()
    f.keep()
    expect(f.reads()).toBe(1)
    const messages = JSON.stringify(f.messages())
    expect(messages).toContain('remember the non-obvious constraint')
    expect(messages).not.toContain('pre-rename note')
  })
})
