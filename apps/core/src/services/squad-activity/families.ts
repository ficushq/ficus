import type { ExtractedSquadActivity, SquadActivitySourceFamily } from './types'
import {
  extractChatExecution,
  extractExecution,
  extractGitHubIssueDispatch,
  extractGitHubPrDispatch,
  extractInboxMessage,
  extractLinearIssueDispatch,
  extractWait,
  extractWorkStream,
} from './extractors'
import {
  listChatSourcePage,
  listExecutionSourcePage,
  listGitHubIssueSourcePage,
  listGitHubPrSourcePage,
  listInboxSourcePage,
  listLinearIssueSourcePage,
  listWaitSourcePage,
  listWorkStreamSourcePage,
  loadChatSnapshot,
  loadExecutionSnapshot,
  loadGitHubIssueSnapshot,
  loadGitHubPrSnapshot,
  loadInboxSnapshot,
  loadLinearIssueSnapshot,
  loadWaitSnapshot,
  loadWorkStreamSnapshot,
  type ActivitySourceKey,
  type Executor,
  type SourceGroupCursor,
  type SourceGroupPage,
  type SourceSnapshot,
} from './source-loaders'

/**
 * One source family = one entry here. This registry is the single
 * registration point for the Activity materialization engine: the diff
 * engine (materialize.ts), the repair sweep (repair.ts), and the CLI all
 * iterate/dispatch through it, and the Record type makes the compiler reject
 * a family that is added to `SquadActivitySourceFamily` without a complete
 * definition.
 *
 * Adding a family:
 * 1. Add the name to `SquadActivitySourceFamily` (types.ts) and allocate its
 *    lane numbers in @ficus/shared.
 * 2. Write its snapshot loader + source-window pager (source-loaders.ts) and
 *    its pure extractor (extractors.ts).
 * 3. Register the entry below — the compiler forces this step.
 * 4. Wire its live events in event-handlers.ts (the after-commit fast path;
 *    without it the family only converges on the repair cadence).
 * 5. Add its `kind` presentation (label/toggle/renderer) in the web
 *    SquadActivityTab.
 *
 * Removing a family's rows needs no migration: make its extractor return
 * fewer (or no) rows and the desired-state diff deletes the strays on the
 * next repair sweep.
 */
export interface ActivityFamilyDefinition {
  /**
   * Load the full snapshot for one group id on the caller's executor (the
   * materialize transaction during a diff). Return null when the source is
   * gone — the diff then deletes every stored row of the group.
   */
  loadSnapshot(executor: Executor, groupId: string): Promise<SourceSnapshot | null>
  /** Pure projection: snapshot → the complete desired row set for the group. */
  extract(snapshot: SourceSnapshot): ExtractedSquadActivity[]
  /**
   * Page source groups whose facet timestamps fall in [from, to), on an
   * immutable keyset cursor. `scanTo` extends only the receipt-time scan of
   * delayed-delivery sources (the github-pr/github-issue webhook families).
   */
  listSourcePage(
    from: Date,
    to: Date,
    after: SourceGroupCursor | null,
    limit: number,
    scanTo: Date
  ): Promise<SourceGroupPage>
  /**
   * Immutable receipt authority/identity: presentation-only updates may be
   * regenerated from the original source, but rows are never deleted or
   * reattributed. The repair projection anti-join pass is skipped.
   */
  appendOnly: boolean
}

export const ACTIVITY_FAMILIES: Record<SquadActivitySourceFamily, ActivityFamilyDefinition> = {
  chat: {
    loadSnapshot: loadChatSnapshot,
    extract: extractChatExecution as ActivityFamilyDefinition['extract'],
    listSourcePage: (from, to, after, limit) => listChatSourcePage(from, to, after, limit),
    appendOnly: false,
  },
  inbox: {
    loadSnapshot: loadInboxSnapshot,
    extract: extractInboxMessage as ActivityFamilyDefinition['extract'],
    listSourcePage: (from, to, after, limit) => listInboxSourcePage(from, to, after, limit),
    appendOnly: false,
  },
  execution: {
    loadSnapshot: loadExecutionSnapshot,
    extract: extractExecution as ActivityFamilyDefinition['extract'],
    listSourcePage: (from, to, after, limit) => listExecutionSourcePage(from, to, after, limit),
    appendOnly: false,
  },
  workstream: {
    loadSnapshot: loadWorkStreamSnapshot,
    extract: extractWorkStream as ActivityFamilyDefinition['extract'],
    listSourcePage: (from, to, after, limit) => listWorkStreamSourcePage(from, to, after, limit),
    appendOnly: false,
  },
  wait: {
    loadSnapshot: loadWaitSnapshot,
    extract: extractWait as ActivityFamilyDefinition['extract'],
    listSourcePage: (from, to, after, limit) => listWaitSourcePage(from, to, after, limit),
    appendOnly: false,
  },
  'github-pr': {
    loadSnapshot: loadGitHubPrSnapshot,
    extract: extractGitHubPrDispatch as ActivityFamilyDefinition['extract'],
    listSourcePage: listGitHubPrSourcePage,
    appendOnly: true,
  },
  'github-issue': {
    loadSnapshot: loadGitHubIssueSnapshot,
    extract: extractGitHubIssueDispatch as ActivityFamilyDefinition['extract'],
    listSourcePage: listGitHubIssueSourcePage,
    appendOnly: true,
  },
  'linear-issue': {
    loadSnapshot: loadLinearIssueSnapshot,
    extract: extractLinearIssueDispatch as ActivityFamilyDefinition['extract'],
    listSourcePage: listLinearIssueSourcePage,
    appendOnly: true,
  },
}

/** Repair/iteration order. Derived from the registry so it can never drift. */
export const ACTIVITY_SOURCE_FAMILIES = Object.keys(ACTIVITY_FAMILIES) as SquadActivitySourceFamily[]

export function activityFamily(family: SquadActivitySourceFamily): ActivityFamilyDefinition {
  return ACTIVITY_FAMILIES[family]
}

/** Load the snapshot for one source key through its family definition. */
export async function loadActivitySource(executor: Executor, key: ActivitySourceKey): Promise<SourceSnapshot | null> {
  return activityFamily(key.family).loadSnapshot(executor, key.groupId)
}

/** Page one family's source groups through its family definition. */
export async function listSourceGroupPage(
  family: SquadActivitySourceFamily,
  from: Date,
  to: Date,
  after: SourceGroupCursor | null,
  limit = 250,
  scanTo: Date = to
): Promise<SourceGroupPage> {
  return activityFamily(family).listSourcePage(from, to, after, limit, scanTo)
}
