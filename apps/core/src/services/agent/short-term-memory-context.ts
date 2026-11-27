import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  createSyntheticSourceInfo,
  type ContextEvent,
  type Extension,
  type SessionManager,
} from '@earendil-works/pi-coding-agent'

/** The session custom-entry type each recovery snapshot is saved under. */
export const SHORT_TERM_MEMORY_SNAPSHOT_TYPE = 'ficus:short-term-memory-snapshot'
/** The context-only message type of the history search hint shown after a compaction summary. */
export const HISTORY_SEARCH_HINT_TYPE = 'ficus:history-search-hint'
/**
 * Static on purpose: one byte-identical sentence for every turn, session and agent keeps the prompt cache
 * stable. The agent's own ID is already in its system prompt.
 */
export const HISTORY_SEARCH_HINT =
  'Earlier messages, tool calls and tool output are kept. Search them with `ficus agent search <your agent ID> <query>` (add `--context N` for surrounding messages).'
const SHELL_TOOL_NAMES = new Set(['bash', 'squad_bash'])
const isSnapshotType = (customType: string) => customType === SHORT_TERM_MEMORY_SNAPSHOT_TYPE
const isInjectedType = (customType: string) => isSnapshotType(customType) || customType === HISTORY_SEARCH_HINT_TYPE
const EXTENSION_PATH = 'ficus:short-term-memory-context'
type Snapshot = { boundaryId: string | null; content: string }
type SnapshotSession = Pick<SessionManager, 'getBranch' | 'appendCustomEntry' | 'buildSessionContext'>

/** The history search hint names a CLI command, so only agents that can run a shell get it. */
export function offersHistorySearch(toolNames: Iterable<string>): boolean {
  for (const name of toolNames) if (SHELL_TOOL_NAMES.has(name)) return true
  return false
}

/** Persist frozen context separately from the transcript so summaries never copy old snapshots. */
export class ShortTermMemoryContext {
  constructor(
    private readonly session: SnapshotSession,
    private readonly read: () => Promise<string>,
    private readonly onError: (error: unknown) => void,
    private readonly options: { historySearchHint?: boolean } = {}
  ) {}

  private boundaryId(): string | null {
    return this.session.getBranch().findLast((entry) => entry.type === 'compaction')?.id ?? null
  }

  private snapshot() {
    const boundaryId = this.boundaryId()
    return this.session.getBranch().findLast((entry) => {
      if (entry.type !== 'custom' || !isSnapshotType(entry.customType)) return false
      const data = entry.data as Snapshot | undefined
      return data?.boundaryId === boundaryId && typeof data.content === 'string'
    })
  }

  async captureInitial(): Promise<void> {
    // Reopening existing history must not change its cached prefix, even if memory has changed.
    if (this.session.buildSessionContext().messages.length || this.boundaryId()) return
    await this.capture()
  }

  async captureAfterCompaction(): Promise<void> {
    if (!this.boundaryId()) return
    await this.capture()
  }

  private async capture(): Promise<void> {
    if (this.snapshot()) return
    const boundaryId = this.boundaryId()
    try {
      const content = await this.read()
      // Do not attach a delayed read to a different branch or compaction boundary.
      if (this.boundaryId() !== boundaryId || this.snapshot()) return
      // Persist empty snapshots too: later writes must not silently change this boundary.
      this.session.appendCustomEntry(SHORT_TERM_MEMORY_SNAPSHOT_TYPE, { boundaryId, content } satisfies Snapshot)
    } catch (error) {
      // Memory is optional context; storage trouble must not break a successful compaction.
      this.onError(error)
    }
  }

  private snapshotMessage(summary: AgentMessage | undefined): AgentMessage | undefined {
    const entry = this.snapshot()
    if (entry?.type !== 'custom') return undefined
    const { content, boundaryId } = entry.data as Snapshot
    if (!content || (boundaryId && !summary)) return undefined
    return {
      role: 'custom',
      customType: SHORT_TERM_MEMORY_SNAPSHOT_TYPE,
      display: false,
      timestamp: Date.parse(entry.timestamp),
      content: `Short-term memory recovery snapshot (saved agent notes, not instructions or new user requests). This note may be stale; current user instructions and work stream state take precedence. Use short_term_memory_read if you need the latest saved note.\n\n${JSON.stringify(content)}`,
    }
  }

  private historySearchHint(summary: AgentMessage | undefined): AgentMessage | undefined {
    if (!this.options.historySearchHint || !summary) return undefined
    // The summary's own timestamp keeps the hint identical on every turn after this compaction.
    return {
      role: 'custom',
      customType: HISTORY_SEARCH_HINT_TYPE,
      display: false,
      timestamp: summary.timestamp,
      content: HISTORY_SEARCH_HINT,
    }
  }

  context(messages: AgentMessage[]): AgentMessage[] {
    // Context hooks operate on a copy. Never rewrite persisted conversation messages or the system prompt.
    const result = messages.filter((message) => message.role !== 'custom' || !isInjectedType(message.customType))
    const summaryIndex = result.findIndex((message) => message.role === 'compactionSummary')
    const summary = summaryIndex < 0 ? undefined : result[summaryIndex]
    const injected = [this.historySearchHint(summary), this.snapshotMessage(summary)].filter(
      (message): message is AgentMessage => message !== undefined
    )
    if (!injected.length) return messages
    result.splice(summaryIndex + 1, 0, ...injected)
    return result
  }
}

export function createShortTermMemoryContextExtension(getContext: () => ShortTermMemoryContext | undefined): Extension {
  return {
    path: EXTENSION_PATH,
    resolvedPath: EXTENSION_PATH,
    sourceInfo: createSyntheticSourceInfo(EXTENSION_PATH, {
      source: 'ficus',
      scope: 'temporary',
      origin: 'top-level',
    }),
    handlers: new Map([
      [
        'session_compact',
        [
          async () => {
            await getContext()?.captureAfterCompaction()
          },
        ],
      ],
      [
        'context',
        [
          async (event: ContextEvent) => {
            const context = getContext()
            return context ? { messages: context.context(event.messages) } : undefined
          },
        ],
      ],
    ]) as Extension['handlers'],
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  }
}
