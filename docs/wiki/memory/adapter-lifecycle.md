# Memory Adapter Lifecycle

Memory source adapters normalize source-specific content into `memoryDocuments` and `memoryChunks` without requiring search, grants, or indexing code to know source details. New sources should implement either the indexed `MemorySourceAdapter` contract or the live `LiveMemorySourceAdapter` contract.

## Indexed lifecycle

```text
discover  → adapter.list(squadId)                returns DiscoveredItem[]
fetch     → adapter.fetch(squadId, sourceId)     returns FetchedContent | null
normalize → IndexedDocumentWriter.normalize()    title, sensitivity, chunkMetadata, wikilinks
sourceId  → caller-provided string; adapter must accept whatever it returned from list()
upsert    → IndexedDocumentWriter.upsert()       document + chunk-diff + link rebuild
reconcile → adapter.reconcile()                  removes docs not in list()
remove    → adapter.remove(sourceId)             cascading delete
```

`BaseMemorySourceAdapter` provides default `indexAll()` and `reconcile()` implementations. Most indexed adapters only need source-specific `list()`, `fetch()`, `index()`, `exists()`, and `remove()` methods plus validators.

## Capability matrix

| Adapter          | Kind    | Capabilities                                          | Default sensitivity |
| ---------------- | ------- | ----------------------------------------------------- | ------------------- |
| `memory_file`    | indexed | searchable, readable, writable, incremental, external | `internal`          |
| `agent_thread`   | indexed | searchable, readable, incremental                     | `internal`          |
| `workspace_file` | indexed | searchable, readable, external                        | `internal`          |
| `slack_thread`   | indexed | searchable, readable, incremental, external           | `internal`          |
| `slack_canvas`   | indexed | searchable, readable, incremental, external           | `internal`          |
| `github_issue`   | indexed | searchable, readable, incremental, external           | `internal`          |
| `linear_issue`   | live    | searchable, live, external                            | `internal`          |

Capability meanings:

- `searchable` — emits searchable results, either via chunks or live `search()`.
- `readable` — full content can be resolved by memory read flows.
- `writable` — Ficus can create/update documents in the source.
- `incremental` — `list()` can support cheap sync using cursors or timestamps.
- `external` — content originates outside Ficus's core database.
- `live` — source is queried at search time and does not persist chunks.

## Writing an indexed adapter

This example sketches a document-shaped external adapter. Real adapters should keep API clients behind a small source-specific client and leave document/chunk writes to `IndexedDocumentWriter`.

```ts
import { and, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryDocuments } from '../../../db/schema'
import { BaseMemorySourceAdapter, sourceCapabilities, type DiscoveredItem, type FetchedContent } from './adapter'
import { IndexedDocumentWriter } from './IndexedDocumentWriter'
import type { IndexResult } from './types'

export class DocsSource extends BaseMemorySourceAdapter {
  readonly sourceType = 'docs_page'
  readonly capabilities = sourceCapabilities(['searchable', 'readable', 'incremental', 'external'])
  readonly defaultSensitivity = 'internal' as const

  async list(squadId: string, opts?: { since?: string }): Promise<DiscoveredItem[]> {
    const pages = await docsClient.listPages({ squadId, updatedAfter: opts?.since })
    return pages.map((page) => ({ sourceId: page.id, cursor: page.updatedAt }))
  }

  async fetch(squadId: string, sourceId: string): Promise<FetchedContent | null> {
    const page = await docsClient.getPage({ squadId, id: sourceId })
    if (!page) return null
    return {
      content: page.markdown,
      title: page.title,
      path: page.url,
      frontmatter: { kind: 'docs_page', tags: page.labels, sourceLinks: [page.url] },
      sensitivity: page.private ? 'restricted' : this.defaultSensitivity,
      chunkMetadata: { sourceType: this.sourceType, url: page.url },
    }
  }

  async index(squadId: string, sourceId: string): Promise<IndexResult> {
    const fetched = await this.fetch(squadId, sourceId)
    if (!fetched) {
      await this.remove(squadId, sourceId)
      return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }
    }
    return IndexedDocumentWriter.instance().writeDocument({
      squadId,
      sourceType: this.sourceType,
      sourceId,
      fetched,
      adapterDefaultSensitivity: this.defaultSensitivity,
      chunker: 'markdown',
    })
  }

  async exists(squadId: string, sourceId: string): Promise<boolean> {
    return (await docsClient.getPage({ squadId, id: sourceId })) !== null
  }

  async remove(squadId: string, sourceId: string): Promise<void> {
    await db
      .delete(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, this.sourceType),
          eq(memoryDocuments.sourceId, sourceId)
        )
      )
  }
}
```

## Writing a live adapter

Live adapters are for sources with good native search or fast-changing data. They do not implement indexing methods and must return source-backed provenance on every result.

```ts
import { sourceCapabilities } from './adapter'
import type { LiveMemorySourceAdapter, LiveSearchResult, LiveSearchScope } from './live-adapter'

export class LinearLiveSource implements LiveMemorySourceAdapter {
  readonly sourceType = 'linear_issue'
  readonly capabilities = sourceCapabilities(['searchable', 'live', 'external'])
  readonly defaultSensitivity = 'internal' as const
  readonly timeoutMs = 2_000
  readonly rateLimit = { perMinute: 30 }

  async search(query: string, opts: LiveSearchScope): Promise<LiveSearchResult[]> {
    const issues = await linearClient.searchIssues({
      query,
      scopes: opts.scopes,
      timeoutMs: opts.deadlineMs,
    })
    return issues.map((issue) => ({
      sourceSquadId: issue.squadId,
      sourceType: this.sourceType,
      sourceId: issue.id,
      title: issue.title,
      snippet: issue.summary,
      score: issue.score,
      sensitivity: issue.sensitivity ?? this.defaultSensitivity,
      provenance: { url: issue.url, teamKey: issue.teamKey, status: issue.status },
      event: issue.updatedAt ? { ts: issue.updatedAt, actor: issue.updatedBy } : undefined,
    }))
  }
}
```

`SearchService` runs indexed search and eligible live adapters in parallel, enforces per-adapter timeout/rate limits, and fail-closes live errors by omitting that adapter's rows rather than throwing to the caller.

## Provenance conventions

### Document-shaped metadata

Each indexed source item is represented by one document row:

```text
memory_documents.sourceType         // 'memory_file', 'agent_thread', 'workspace_file', 'slack_message', 'pr_event', ...
memory_documents.sourceId           // adapter-stable string
memory_documents.path               // human-readable path or null
memory_documents.title              // display title or null
memory_documents.sensitivity        // capped at ingest, NEVER null
memory_documents.frontmatter.kind   // logical type (decision, ownership, runbook, thread, slack_thread, ...)
memory_documents.frontmatter.tags   // string[]
memory_documents.frontmatter.sourceLinks  // optional URLs back to origin
```

### Event-shaped metadata

Chunks that represent messages, comments, transcript turns, or other events carry event metadata:

```text
memory_chunks.metadata.sourceType   // mirrors document.sourceType for filter convenience
memory_chunks.metadata.event        // { ts: ISO string, actor: string, externalId?: string }
memory_chunks.metadata.parent       // { threadTs?, prNumber?, channelId?, workStreamId?, agentId? }
```

Every chunk must carry `sourceSquadId` via the `squadId` column, `sourceType`, `sensitivity`, and event metadata when applicable, populated at ingest. Retrofits are forbidden: if a future UI/filter/agent needs provenance, the adapter should write it from day one.

## Validators and source-specific filters

Adapters own their source-specific validation. Ficus deliberately does not provide a generic authorization framework for every external system.

- `validatePolicy(policy)` validates ingestion policy stored in `squad_source_configs` for that adapter.
- `validateGrantFilter(filter)` validates adapter-specific grant filters before scope expansion uses a grant.
- `buildSearchSqlFilter(filter)` optionally turns a validated indexed grant filter into an SQL predicate for `SearchService`.

Rules for all three hooks:

1. Return `null` for valid input; return a list of errors for invalid input.
2. Unknown source types and invalid filters fail closed: the grant/config is ignored rather than widened.
3. Query-time filters may only narrow access; they never expand grants.
4. Keep filters source-shaped (for example Slack `channelIds`, GitHub `repo`, Linear `teamKey`) and avoid cross-source abstractions until multiple adapters prove the need.

## Adapter author checklist

1. Pick a stable `sourceType` and `sourceId` shape.
2. Declare capabilities and `defaultSensitivity`.
3. Decide indexed vs live per source, not globally.
4. Populate document frontmatter and chunk/live provenance at ingest/search time.
5. Add `validatePolicy()` for ingestion bounds and `validateGrantFilter()` for permission filters.
6. Add fail-closed tests for unknown source types, invalid filters, and adapter errors/timeouts.
7. Document the source page with its capability line and source-specific metadata fields.
