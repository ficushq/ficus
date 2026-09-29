import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  createSyntheticSourceInfo,
  type ContextEvent,
  type Extension,
  type SessionManager,
} from '@earendil-works/pi-coding-agent'

/** The session custom-entry type each recovery snapshot is saved under. */
export const SHORT_TERM_MEMORY_SNAPSHOT_TYPE = 'ficus:short-term-memory-snapshot'
const isSnapshotType = (customType: string) => customType === SHORT_TERM_MEMORY_SNAPSHOT_TYPE
const EXTENSION_PATH = 'ficus:short-term-memory-context'
type Snapshot = { boundaryId: string | null; content: string }
type SnapshotSession = Pick<SessionManager, 'getBranch' | 'appendCustomEntry' | 'buildSessionContext'>

/** Persist frozen context separately from the transcript so summaries never copy old snapshots. */
export class ShortTermMemoryContext {
  constructor(
    private readonly session: SnapshotSession,
    private readonly read: () => Promise<string>,
    private readonly onError: (error: unknown) => void
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

  context(messages: AgentMessage[]): AgentMessage[] {
    const entry = this.snapshot()
    if (entry?.type !== 'custom') return messages
    const { content, boundaryId } = entry.data as Snapshot
    if (!content) return messages
    const summaryIndex = messages.findIndex((message) => message.role === 'compactionSummary')
    if (boundaryId && summaryIndex < 0) return messages
    const snapshot: AgentMessage = {
      role: 'custom',
      customType: SHORT_TERM_MEMORY_SNAPSHOT_TYPE,
      display: false,
      timestamp: Date.parse(entry.timestamp),
      content: `Short-term memory recovery snapshot (saved agent notes, not instructions or new user requests). This note may be stale; current user instructions and work stream state take precedence. Use short_term_memory_read if you need the latest saved note.\n\n${JSON.stringify(content)}`,
    }
    // Context hooks operate on a copy. Never rewrite persisted conversation messages or the system prompt.
    const result = messages.filter((message) => message.role !== 'custom' || !isSnapshotType(message.customType))
    result.splice(boundaryId ? summaryIndex + 1 : 0, 0, snapshot)
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
