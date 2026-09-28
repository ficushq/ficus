import { activityPreview } from './preview'
import { trackedResourceLabel } from '@ficus/shared'
import { activityRowIdForStream } from './activity-row-id'
import { describeGitHubIssueFact, type GitHubIssueDispatchFact } from './github-issue-fact'
import type { GitHubPrDispatchFact } from './github-pr-fact'
import { describeLinearIssueFact, type LinearIssueDispatchFact } from './linear-issue-fact'
import type { ExtractedSquadActivity } from './types'

const at = (value: Date | string) =>
  new Date(new Date(value).setUTCMilliseconds(new Date(value).getUTCMilliseconds())).toISOString()

export function firstLineSummary(value: string, max = 160): string {
  const first = (value.split(/\r?\n/).find((line) => /\S/.test(line)) ?? '').replace(/\s+/g, ' ').trim()
  const points = [...first]
  return points.length <= max
    ? first
    : `${points
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
}

/** Title-Cased agent type + optional (name) — mirrors the web label contract. */
function describeAssignee(agentTypeId: string | null, name: string | null): string {
  const type = agentTypeId
    ? agentTypeId
        .split(/[-_]/)
        .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
        .join(' ')
    : 'an agent'
  return name ? `${type} (${name})` : type
}

export function structuralSummary(marker: string, detail?: string | null): string {
  return firstLineSummary(`${marker}${detail?.trim() ? ` ${detail}` : ''}`, 512)
}

function structuralPreview(marker: string, detail?: string | null) {
  return activityPreview(detail ?? '', 512, marker)
}

export interface ChatExecutionSnapshot {
  squadId: string
  executionId: string
  agentId: string
  agentTypeId: string
  messages: Array<{ id: string; role: string; content: string; createdAt: Date | string }>
}

export function extractChatExecution(snapshot: ChatExecutionSnapshot): ExtractedSquadActivity[] {
  // Only the FIRST substantive assistant message per execution becomes a row
  // (operator decision 2026-08-27, with the Verbose toggle retired): later
  // messages were never shown anywhere, so they are not extracted at all —
  // the desired-state diff deletes historical non-first rows on the next
  // repair sweep, and live materialization of later messages is a no-op.
  return [...snapshot.messages]
    .filter((message) => message.role === 'assistant' && /\S/.test(message.content))
    .sort((left, right) =>
      at(left.createdAt) === at(right.createdAt)
        ? left.id.localeCompare(right.id)
        : at(left.createdAt).localeCompare(at(right.createdAt))
    )
    .slice(0, 1)
    .map((message, index) => ({
      id: `10:${message.id}`,
      lane: 10,
      rowId: message.id,
      squadId: snapshot.squadId,
      at: at(message.createdAt),
      agentId: snapshot.agentId,
      agentTypeId: snapshot.agentTypeId,
      kind: 'message',
      ...activityPreview(message.content),
      ref: {
        type: 'agent',
        agentId: snapshot.agentId,
        view: 'chat',
        messageId: message.id,
        executionId: snapshot.executionId,
      },
      sourceFamily: 'chat',
      sourceGroupId: snapshot.executionId,
      workStreamId: null,
      quietEligible: index === 0,
      accessScope: 'agents',
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    }))
}

export interface ExecutionSnapshot {
  squadId: string
  id: string
  agentId: string
  agentTypeId: string
  status: string
  runStartedAt: Date | string | null
  endedAt: Date | string | null
  /** Set when the executing agent is a subagent — its parent's identity. */
  parentAgentId?: string | null
  parentAgentTypeId?: string | null
  /** The subagent's own display detail: metadata name or purpose. */
  subagentName?: string | null
}
// 'completed' deliberately absent: a finishing subagent always sends its
// parent an inbox report, which already rows as "Sent message to <Parent>"
// immediately after — a "finished" line would double every completion
// (operator decision 2026-08-27). Abnormal ends keep their status row: no
// inbox report accompanies them.
const rowWorthyTerminalStatuses = new Set(['failed', 'stopped', 'canceled'])
export function extractExecution(snapshot: ExecutionSnapshot): ExtractedSquadActivity[] {
  // Operator decisions 2026-08-27: generic execution lifecycle rows
  // ([execution started]/[execution <status>]) are low-level noise and are no
  // longer produced — EXCEPT for subagents, whose starts/finishes are the only
  // feed-visible trace of their work. Subagent rows are attributed to the
  // PARENT agent (the feed identity a reader knows); the web label appends
  // "'s subagent" for this kind. Historical non-subagent rows are deleted by
  // the repair's desired-state diff.
  if (!snapshot.parentAgentId || !snapshot.parentAgentTypeId) return []
  const subagent = snapshot.subagentName ? `Subagent "${snapshot.subagentName}"` : 'Subagent'
  const base = {
    squadId: snapshot.squadId,
    agentId: snapshot.parentAgentId,
    agentTypeId: snapshot.parentAgentTypeId,
    sourceFamily: 'execution' as const,
    sourceGroupId: snapshot.id,
    workStreamId: null,
    quietEligible: true,
    accessScope: 'agents' as const,
    inboxRecipientId: null,
    agentTypeRequiresAgentsRead: false,
    // The parent's chat is where the subagent panel (and transcript) lives.
    ref: { type: 'agent' as const, agentId: snapshot.parentAgentId, view: 'chat' as const, executionId: snapshot.id },
  }
  const rows: ExtractedSquadActivity[] = []
  if (snapshot.runStartedAt)
    rows.push({
      ...base,
      id: `60:${snapshot.id}`,
      lane: 60,
      rowId: snapshot.id,
      at: at(snapshot.runStartedAt),
      kind: 'execution',
      ...activityPreview(`${subagent} spawned.`, 512),
    })
  if (snapshot.endedAt && rowWorthyTerminalStatuses.has(snapshot.status))
    rows.push({
      ...base,
      id: `61:${snapshot.id}`,
      lane: 61,
      rowId: snapshot.id,
      at: at(snapshot.endedAt),
      kind: 'execution',
      ...activityPreview(`${subagent} ${snapshot.status}.`, 512),
    })
  return rows
}

export interface WorkStreamSnapshot {
  squadId: string
  id: string
  title: string
  creatorAgentId: string | null
  creatorAgentTypeId: string | null
  createdAt: Date | string
}
export function extractWorkStream(snapshot: WorkStreamSnapshot): ExtractedSquadActivity[] {
  return [
    {
      id: `30:${snapshot.id}`,
      lane: 30,
      rowId: snapshot.id,
      squadId: snapshot.squadId,
      at: at(snapshot.createdAt),
      agentId: snapshot.creatorAgentId,
      agentTypeId: snapshot.creatorAgentTypeId,
      kind: 'workstream',
      ...structuralPreview(`[ws-${snapshot.id.slice(0, 4)} created]`, snapshot.title),
      ref: { type: 'workstream', workStreamId: snapshot.id },
      sourceFamily: 'workstream',
      sourceGroupId: snapshot.id,
      workStreamId: snapshot.id,
      quietEligible: true,
      accessScope: 'workstreams',
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: true,
    },
  ]
}

export interface WaitSnapshot {
  squadId: string
  id: string
  workStreamId: string
  type: string
  message: string | null
  createdByAgentId: string | null
  createdByAgentTypeId: string | null
  openedAt: Date | string
  closedAt: Date | string | null
  resolution: string | null
  resolutionNote: string | null
}
export function extractWait(snapshot: WaitSnapshot): ExtractedSquadActivity[] {
  const ref = { type: 'workstream' as const, workStreamId: snapshot.workStreamId }
  const common = {
    squadId: snapshot.squadId,
    rowId: snapshot.id,
    kind: 'wait' as const,
    ref,
    sourceFamily: 'wait' as const,
    sourceGroupId: snapshot.id,
    workStreamId: snapshot.workStreamId,
    quietEligible: true,
    accessScope: 'workstreams' as const,
    inboxRecipientId: null,
    agentTypeRequiresAgentsRead: true,
  }
  const rows: ExtractedSquadActivity[] = [
    {
      ...common,
      id: `40:${snapshot.id}`,
      lane: 40,
      at: at(snapshot.openedAt),
      agentId: snapshot.createdByAgentId,
      agentTypeId: snapshot.createdByAgentTypeId,
      ...structuralPreview(`[ws-${snapshot.workStreamId.slice(0, 4)} · ${snapshot.type} opened]`, snapshot.message),
    },
  ]
  if (snapshot.closedAt)
    rows.push({
      ...common,
      id: `41:${snapshot.id}`,
      lane: 41,
      at: at(snapshot.closedAt),
      agentId: null,
      agentTypeId: null,
      ...structuralPreview(
        `[ws-${snapshot.workStreamId.slice(0, 4)} · ${snapshot.type} ${snapshot.resolution ?? 'resolved'}]`,
        snapshot.resolutionNote
      ),
    })
  return rows
}

export interface InboxSnapshot {
  id: string
  createdAt: Date | string
  recipientType: string
  recipientId: string
  recipientSquadId: string | null
  recipientAgentTypeId: string | null
  /** Assignee display detail: metadata name (preferred) or purpose. */
  recipientName?: string | null
  senderType: string
  senderId: string | null
  senderAgentExists?: boolean
  /** Sender attribution (same-squad senders only; survives termination). */
  senderAgentTypeId?: string | null
  /** Sender display detail: metadata name (preferred) or purpose. */
  senderName?: string | null
  /** The sender's parent agent type (subagent reports label as the parent). */
  senderParentAgentTypeId?: string | null
  subject?: string | null
  content: string
  metadata: Record<string, unknown> | null
  workStream: {
    id: string
    squadId: string
    title: string
    ownerAgentId: string | null
    managerAgentId: string | null
  } | null
}
export function extractInboxMessage(snapshot: InboxSnapshot): ExtractedSquadActivity[] {
  if (snapshot.recipientType !== 'agent' || !snapshot.recipientSquadId) return []
  const base = {
    squadId: snapshot.recipientSquadId,
    rowId: snapshot.id,
    at: at(snapshot.createdAt),
    sourceFamily: 'inbox' as const,
    sourceGroupId: snapshot.id,
    quietEligible: true,
    inboxRecipientId: snapshot.recipientId,
  }
  if (snapshot.senderType === 'agent' && snapshot.senderId) {
    // Subagent reports to their parent are the subagent's COMPLETION signal
    // (the finished row was retired in their favor) — they get their own
    // lane + kind so the web's Messages AND Subagents filters both include
    // them (operator decision 2026-08-27). The recipient join keeps
    // terminated agents: a parent's termination at stream completion was
    // silently deleting its entire received-report history via the repair
    // diff (observed live: 225 of 228 subagent reports gone in 24h).
    const fromSubagent = snapshot.senderAgentTypeId === 'subagent'
    return [
      {
        ...base,
        id: fromSubagent ? `22:${snapshot.id}` : `20:${snapshot.id}`,
        lane: fromSubagent ? (22 as const) : (20 as const),
        agentId: snapshot.senderAgentExists === false ? null : snapshot.senderId,
        // Attributed to the SENDER (previously null, which rendered every
        // agent-to-agent message as 'system'). Redacted for viewers without
        // agents-read via the flag below.
        // Subagent reports are attributed to the PARENT type (the feed
        // identity readers know) — rendered as "› Reviewer" alongside the
        // spawn rows, which already carry the parent type.
        agentTypeId: fromSubagent
          ? (snapshot.senderParentAgentTypeId ?? snapshot.senderAgentTypeId ?? null)
          : (snapshot.senderAgentTypeId ?? null),
        kind: fromSubagent ? ('subagent' as const) : ('message' as const),
        ...activityPreview(
          snapshot.content,
          512,
          `${fromSubagent ? 'Subagent sent message to' : 'Sent message to'} ${describeAssignee(snapshot.recipientAgentTypeId, null)}:`
        ),
        ref: { type: 'agent', agentId: snapshot.recipientId, view: 'inbox', messageId: snapshot.id },
        workStreamId: null,
        accessScope: 'inbox',
        agentTypeRequiresAgentsRead: true,
      },
    ]
  }
  const event = typeof snapshot.metadata?.event === 'string' ? snapshot.metadata.event : null
  const workStreamId = typeof snapshot.metadata?.workStreamId === 'string' ? snapshot.metadata.workStreamId : null
  const ws = snapshot.workStream
  if (snapshot.senderType !== 'system') return []
  // System notices WITHOUT a work-stream event marker are operator-visible
  // deliveries in their own right — webhook script notifications ("PR #x: CI
  // passed"), schedule firings, watchdog nudges (operator decision
  // 2026-08-27). Work-stream event notices are EXCLUDED here: the wait/
  // handoff/workstream families already row those transitions, and a second
  // inbox-sourced copy would double the feed.
  if (!event)
    return [
      {
        ...base,
        id: `21:${snapshot.id}`,
        lane: 21,
        agentId: null,
        agentTypeId: null,
        kind: 'message',
        ...activityPreview(
          snapshot.subject?.trim() ? snapshot.subject : snapshot.content,
          512,
          `Sent message to ${describeAssignee(snapshot.recipientAgentTypeId, null)}:`
        ),
        ref: { type: 'agent', agentId: snapshot.recipientId, view: 'inbox', messageId: snapshot.id },
        workStreamId: null,
        accessScope: 'inbox',
        agentTypeRequiresAgentsRead: true,
      },
    ]
  if (!workStreamId || !ws || ws.id !== workStreamId || ws.squadId !== snapshot.recipientSquadId) return []
  if (event === 'assigned')
    return [
      {
        ...base,
        id: `50:${snapshot.id}`,
        lane: 50,
        agentId: snapshot.recipientId,
        agentTypeId: snapshot.recipientAgentTypeId,
        kind: 'handoff',
        ...structuralPreview(
          `[ws-${ws.id.slice(0, 4)} handoff]`,
          // Type only, no agent name; trailing period matches the done row
          // (operator decision 2026-08-27).
          `Work stream "${ws.title}" has been handed off to ${describeAssignee(snapshot.recipientAgentTypeId, null)}.`
        ),
        ref: { type: 'workstream', workStreamId: ws.id },
        workStreamId: ws.id,
        accessScope: 'workstreams_inbox',
        agentTypeRequiresAgentsRead: true,
      },
    ]
  const owner = typeof snapshot.metadata?.ownerAgentId === 'string' ? snapshot.metadata.ownerAgentId : null
  if (
    ['done', 'canceled', 'reopened'].includes(event) &&
    owner &&
    snapshot.recipientId === (owner || ws.managerAgentId)
  )
    return [
      {
        ...base,
        id: `31:${snapshot.id}`,
        lane: 31,
        agentId: null,
        agentTypeId: null,
        kind: 'workstream',
        ...structuralPreview(`[ws-${ws.id.slice(0, 4)} ${event}]`, snapshot.content),
        ref: { type: 'workstream', workStreamId: ws.id },
        workStreamId: ws.id,
        accessScope: 'workstreams_inbox',
        agentTypeRequiresAgentsRead: false,
      },
    ]
  return []
}

export interface GitHubPrSnapshot {
  /** Namespaced durable authority identity: hook:<uuid> or poll:<uuid>. */
  sourceId: string
  activityId: string
  squadId: string
  /** Every stream in the squad tracking the PR, oldest first. Never empty. */
  workStreamIds: string[]
  fact: GitHubPrDispatchFact
}
/**
 * Human phrasing for a PR fact. GitHub's raw action names were misleading in
 * the feed (operator report 2026-08-27): `issue_comment created` rendered as
 * "[PR #n created] by github-actions[bot]" — reading as if the BOT created
 * the PR — and `synchronize` is jargon for "new commits pushed".
 */
function describeGitHubPrFact(fact: GitHubPrSnapshot['fact']): string {
  if (fact.eventType === 'issue_comment') return fact.action === 'edited' ? 'comment edited' : 'comment'
  if (fact.eventType === 'pull_request_review_comment')
    return fact.action === 'edited' ? 'review comment edited' : 'review comment'
  if (fact.eventType === 'pull_request_review') return 'reviewed'
  if (fact.action === 'synchronize') return 'updated'
  return fact.action // merged | closed | reopened
}

/** One row per tracking stream; the shared `pr` ref names no stream, the row column does. */
export function extractGitHubPrDispatch(snapshot: GitHubPrSnapshot): ExtractedSquadActivity[] {
  const summary = structuralPreview(
    `[PR #${snapshot.fact.prNumber} ${describeGitHubPrFact(snapshot.fact)}]`,
    snapshot.fact.actorLogin ? `by ${snapshot.fact.actorLogin}` : null
  )
  return snapshot.workStreamIds.map((workStreamId, index) => {
    const rowId = activityRowIdForStream(snapshot.fact.logicalRowId, workStreamId, index)
    return {
      id: `70:${rowId}`,
      lane: 70,
      rowId,
      squadId: snapshot.squadId,
      at: at(snapshot.fact.occurredAt),
      agentId: null,
      agentTypeId: null,
      kind: 'pr',
      ...summary,
      ref: { type: 'pr', url: snapshot.fact.url },
      sourceFamily: 'github-pr',
      sourceGroupId: `${snapshot.sourceId}:${snapshot.squadId}`,
      workStreamId,
      quietEligible: true,
      accessScope: 'workstreams',
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    }
  })
}

export interface GitHubIssueSnapshot {
  /** Namespaced durable authority identity: hook:<uuid> or poll:<uuid>. */
  sourceId: string
  activityId: string
  squadId: string
  /** Every stream in the squad tracking the issue, oldest first. Never empty. */
  workStreamIds: string[]
  fact: GitHubIssueDispatchFact
}

export function extractGitHubIssueDispatch(snapshot: GitHubIssueSnapshot): ExtractedSquadActivity[] {
  // A title-less issue (or an actor-less synthesized poll fact) must not leave a
  // dangling separator or a doubled space behind the marker.
  const detail = [snapshot.fact.issueTitle.trim(), snapshot.fact.actorLogin ? `by ${snapshot.fact.actorLogin}` : '']
    .filter(Boolean)
    .join(' · ')
  const summary = structuralPreview(
    `[Issue #${snapshot.fact.issueNumber} ${describeGitHubIssueFact(snapshot.fact)}]`,
    detail
  )
  return snapshot.workStreamIds.map((workStreamId, index) => {
    const rowId = activityRowIdForStream(snapshot.fact.logicalRowId, workStreamId, index)
    return {
      id: `71:${rowId}`,
      lane: 71,
      rowId,
      squadId: snapshot.squadId,
      at: at(snapshot.fact.occurredAt),
      agentId: null,
      agentTypeId: null,
      kind: 'issue',
      ...summary,
      ref: { type: 'issue', url: snapshot.fact.url, workStreamId },
      sourceFamily: 'github-issue',
      sourceGroupId: `${snapshot.sourceId}:${snapshot.squadId}`,
      workStreamId,
      quietEligible: true,
      accessScope: 'workstreams',
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    }
  })
}

export interface LinearIssueSnapshot {
  /** Namespaced durable authority identity: hook:<uuid>. */
  sourceId: string
  activityId: string
  squadId: string
  /** Every stream in the squad tracking the issue, oldest first. Never empty. */
  workStreamIds: string[]
  /**
   * The link the squad's own tracked entry stores, used when the delivery carries
   * none. Linear issue URLs embed a workspace slug no payload field implies, so a
   * link that is not in the delivery can only come from what the squad recorded.
   */
  trackedUrl: string | null
  fact: LinearIssueDispatchFact
}

/** The issue as a person refers to it: `ENG-12` when known, else Linear's own id. */
function linearIssueLabel(fact: LinearIssueDispatchFact): string {
  if (fact.identifier) return fact.identifier
  return fact.teamKey && fact.number
    ? trackedResourceLabel({ integration: 'linear', repository: fact.teamKey, number: fact.number })
    : fact.issueId
}

export function extractLinearIssueDispatch(snapshot: LinearIssueSnapshot): ExtractedSquadActivity[] {
  // A title-less issue (or an actor-less delivery) must not leave a dangling
  // separator or a doubled space behind the marker.
  // The name Linear gave the actor reads better than its id, and neither identifies the row.
  const actor = snapshot.fact.actorName ?? snapshot.fact.actorId
  const detail = [snapshot.fact.title.trim(), actor ? `by ${actor}` : ''].filter(Boolean).join(' · ')
  const summary = structuralPreview(
    `[Issue ${linearIssueLabel(snapshot.fact)} ${describeLinearIssueFact(snapshot.fact)}]`,
    detail
  )
  const url = snapshot.fact.url ?? snapshot.trackedUrl ?? ''
  return snapshot.workStreamIds.map((workStreamId, index) => {
    const rowId = activityRowIdForStream(snapshot.fact.logicalRowId, workStreamId, index)
    return {
      id: `71:${rowId}`,
      lane: 71,
      rowId,
      squadId: snapshot.squadId,
      at: at(snapshot.fact.occurredAt),
      agentId: null,
      agentTypeId: null,
      kind: 'issue',
      ...summary,
      ref: { type: 'issue', url, workStreamId },
      sourceFamily: 'linear-issue',
      sourceGroupId: `${snapshot.sourceId}:${snapshot.squadId}`,
      workStreamId,
      quietEligible: true,
      accessScope: 'workstreams',
      inboxRecipientId: null,
      agentTypeRequiresAgentsRead: false,
    }
  })
}
