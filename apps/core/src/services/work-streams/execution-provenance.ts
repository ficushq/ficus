import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { executions, inbox, messages, workStreams } from '../../db/schema'

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

interface CandidateOrigin {
  messageId: string
  workStreamId: string
}

function recordCandidate(candidates: CandidateOrigin[], messageId: string, workStreamId: unknown): void {
  if (isUuid(workStreamId)) {
    candidates.push({ messageId, workStreamId })
  }
}

/**
 * Classifies watchdog-created executions from exact, server-owned continuation
 * message provenance in a fixed number of set-wise queries.
 */
export async function listTrustedContinuationExecutionIds(
  executor: DbExecutor,
  inputs: Array<{ agentId: string; executionId: string }>
): Promise<Set<string>> {
  if (inputs.length === 0) return new Set()
  const agentIds = [...new Set(inputs.map((input) => input.agentId))]
  const executionIds = new Set(inputs.map((input) => input.executionId))
  const executionMessages = await executor
    .select({ agentId: messages.agentId, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        inArray(messages.agentId, agentIds),
        eq(messages.role, 'human'),
        inArray(sql<string>`${messages.metadata}->>'executionId'`, [...executionIds])
      )
    )

  const candidates: Array<{ agentId: string; executionId: string; workStreamId: string }> = []
  const inboxIds = new Set<string>()
  const messageFacts: Array<{ agentId: string; executionId: string; inboxIds: string[] }> = []
  for (const message of executionMessages) {
    const metadata = message.metadata as Record<string, unknown> | null
    const executionId = metadata?.executionId
    if (typeof executionId !== 'string' || !executionIds.has(executionId)) continue
    if (metadata?.source === 'work-stream-continuation' && isUuid(metadata.workStreamId)) {
      candidates.push({ agentId: message.agentId, executionId, workStreamId: metadata.workStreamId })
    }
    if (metadata?.source !== 'inbox' || !Array.isArray(metadata.inboxMessageIds)) continue
    const validInboxIds = metadata.inboxMessageIds.filter(isUuid)
    validInboxIds.forEach((id) => inboxIds.add(id))
    messageFacts.push({ agentId: message.agentId, executionId, inboxIds: validInboxIds })
  }

  if (inboxIds.size > 0) {
    const inboxRows = await executor
      .select({ id: inbox.id, recipientId: inbox.recipientId, metadata: inbox.metadata })
      .from(inbox)
      .where(and(inArray(inbox.id, [...inboxIds]), eq(inbox.recipientType, 'agent'), eq(inbox.senderType, 'system')))
    const trustedInboxFacts = new Map<string, { recipientId: string; workStreamId: string }>()
    for (const row of inboxRows) {
      const metadata = row.metadata as Record<string, unknown> | null
      if (metadata?.source === 'work-stream-continuation' && isUuid(metadata.workStreamId)) {
        trustedInboxFacts.set(row.id, { recipientId: row.recipientId, workStreamId: metadata.workStreamId })
      }
    }
    for (const fact of messageFacts) {
      for (const inboxId of fact.inboxIds) {
        const inboxFact = trustedInboxFacts.get(inboxId)
        if (inboxFact?.recipientId === fact.agentId) {
          candidates.push({ ...fact, workStreamId: inboxFact.workStreamId })
        }
      }
    }
  }

  const streamIds = [...new Set(candidates.map((candidate) => candidate.workStreamId))]
  if (streamIds.length === 0) return new Set()
  const associatedStreams = await executor
    .select({ id: workStreams.id, assigneeAgentId: workStreams.assigneeAgentId, agentIds: workStreams.agentIds })
    .from(workStreams)
    .where(inArray(workStreams.id, streamIds))
  const associations = new Set<string>()
  for (const stream of associatedStreams) {
    if (stream.assigneeAgentId) associations.add(`${stream.id}:${stream.assigneeAgentId}`)
    for (const agentId of stream.agentIds ?? []) associations.add(`${stream.id}:${agentId}`)
  }
  return new Set(
    candidates
      .filter((candidate) => associations.has(`${candidate.workStreamId}:${candidate.agentId}`))
      .map((candidate) => candidate.executionId)
  )
}

/**
 * Reconstructs work-stream origins only from server-owned delivery markers on
 * human messages bound to the exact agent execution. Copied workStreamId
 * metadata without a canonical source is deliberately ignored.
 */
export async function listTrustedWorkStreamOriginsForExecution(
  executor: DbExecutor,
  input: { agentId: string; executionId: string }
): Promise<Array<{ workStreamId: string; messageIds: string[] }>> {
  const executionMessages = await executor
    .select({ id: messages.id, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, input.agentId),
        eq(messages.role, 'human'),
        sql`${messages.metadata}->>'executionId' = ${input.executionId}`
      )
    )

  // Accepted executions pin their workflow context on the server. This also
  // covers questions after a reply or manager follow-up, without trusting a
  // workStreamId copied into arbitrary message metadata.
  const [execution] = await executor
    .select({ flowContext: executions.flowContext })
    .from(executions)
    .where(and(eq(executions.id, input.executionId), eq(executions.agentId, input.agentId)))
  const candidates: CandidateOrigin[] = []
  if (execution?.flowContext) {
    for (const message of executionMessages) recordCandidate(candidates, message.id, execution.flowContext.workStreamId)
  }
  const inboxIds = new Set<string>()
  for (const message of executionMessages) {
    const metadata = message.metadata as Record<string, unknown> | null
    if (metadata?.source === 'work-stream-continuation') {
      recordCandidate(candidates, message.id, metadata.workStreamId)
    }
    if (metadata?.source !== 'inbox' || !Array.isArray(metadata.inboxMessageIds)) continue
    for (const id of metadata.inboxMessageIds) {
      if (isUuid(id)) inboxIds.add(id)
    }
  }

  if (inboxIds.size > 0) {
    const inboxRows = await executor
      .select({ id: inbox.id, metadata: inbox.metadata })
      .from(inbox)
      .where(
        and(
          inArray(inbox.id, [...inboxIds]),
          eq(inbox.recipientType, 'agent'),
          eq(inbox.recipientId, input.agentId),
          eq(inbox.senderType, 'system')
        )
      )
    const trustedInboxOrigins = new Map<string, string>()
    for (const row of inboxRows) {
      const metadata = row.metadata as Record<string, unknown> | null
      if (
        metadata?.event !== 'assigned' &&
        metadata?.source !== 'work-stream-continuation' &&
        metadata?.source !== 'workflow' &&
        metadata?.source !== 'recovery-decision' &&
        metadata?.source !== 'recovery-retry' &&
        !(metadata?.source === 'workflow-wait-resolution' && typeof metadata.recoveryId === 'string')
      )
        continue
      // A consumed system receipt remains provenance after recovery settles.
      // Live retry/delivery authority is separately fenced by recoveryContinuationIsCurrent.
      if (isUuid(metadata.workStreamId)) {
        trustedInboxOrigins.set(row.id, metadata.workStreamId)
      }
    }
    for (const message of executionMessages) {
      const metadata = message.metadata as Record<string, unknown> | null
      if (metadata?.source !== 'inbox' || !Array.isArray(metadata.inboxMessageIds)) continue
      for (const inboxId of metadata.inboxMessageIds) {
        if (typeof inboxId !== 'string') continue
        const workStreamId = trustedInboxOrigins.get(inboxId)
        if (workStreamId) recordCandidate(candidates, message.id, workStreamId)
      }
    }
  }

  const candidateStreamIds = [...new Set(candidates.map((candidate) => candidate.workStreamId))]
  if (candidateStreamIds.length === 0) return []

  const associatedStreams = await executor
    .select({ id: workStreams.id, assigneeAgentId: workStreams.assigneeAgentId, agentIds: workStreams.agentIds })
    .from(workStreams)
    .where(inArray(workStreams.id, candidateStreamIds))
  const associatedIds = new Set(
    associatedStreams
      .filter((stream) => stream.assigneeAgentId === input.agentId || (stream.agentIds ?? []).includes(input.agentId))
      .map((stream) => stream.id)
  )

  const grouped = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    if (!associatedIds.has(candidate.workStreamId)) continue
    const messageIds = grouped.get(candidate.workStreamId) ?? new Set<string>()
    messageIds.add(candidate.messageId)
    grouped.set(candidate.workStreamId, messageIds)
  }

  return [...grouped]
    .map(([workStreamId, messageIds]) => ({ workStreamId, messageIds: [...messageIds].sort() }))
    .sort((a, b) => a.workStreamId.localeCompare(b.workStreamId))
}
