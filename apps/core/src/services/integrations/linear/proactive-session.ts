import { and, eq } from 'drizzle-orm'
import { trackedResourceLabel, type ResolvedTrackedResource, type TrackedResource } from '@ficus/shared'
import { db, linearAgentSessions, workStreams } from '../../../db'
import { TrackedResourceError } from '../../work-streams/tracked-resource-error'
import { isLinearAppConfiguration, parseLinearConfiguration } from './plugin'
import { resolveLinearConnection } from './resolve-connection'
import { announceLinearSessionBinding, bindLinearSession } from './session-binding'
import { projectLinearWriteBack } from './session-projector'
import { drainLinearOutboxSoon } from './write-back-runtime'
import { createLinearSessionOnIssue } from './write-api'
import { isLinearInsufficientScope, markLinearScopeMissing } from './scope-health'

/** Issues with a `--linear-session` request in flight in this process, by connection. */
const pendingProactiveSessions = new Set<string>()
const proactiveSessionKey = (connectionId: string, issueId: string) => `${connectionId}:${issueId}`

/**
 * Whether a `created` session event is Ficus's own `--linear-session` session. Those are bound by the
 * request that opened them and never go through the event rules (a `start-workstream` rule on
 * `agent_session.created` would otherwise start a second stream). While the request is still in
 * flight, this waits up to five seconds for its row.
 */
export async function isProactiveLinearSession(input: { connectionId: string; sessionId: string; issueId?: string }) {
  const deadline = Date.now() + 5_000
  for (;;) {
    const [row] = await db
      .select({ trigger: linearAgentSessions.trigger })
      .from(linearAgentSessions)
      .where(eq(linearAgentSessions.id, input.sessionId))
    if (row?.trigger === 'proactive') return true
    const pending =
      !!input.issueId && pendingProactiveSessions.has(proactiveSessionKey(input.connectionId, input.issueId))
    if (!pending || Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * `ficus workstream track <ws> --issue KEY-123 --linear-session` (6.8): opens a Linear agent session
 * on a tracked issue with `agentSessionCreateOnIssue` and binds it to the stream, so a stream that was
 * not started from Linear gets the full progress experience. Needs the squad's Linear connection to
 * be the Ficus app; an API-key connection has no agent sessions.
 */
export async function openLinearSessionForStream(
  workStreamId: string,
  resource: TrackedResource | ResolvedTrackedResource
): Promise<{ sessionId: string; url?: string; created: boolean }> {
  if (resource.integration !== 'linear' || resource.kind !== 'issue' || !resource.externalId)
    throw new TrackedResourceError('--linear-session needs a Linear issue', 400)
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, workStreamId))
  if (!stream) throw new TrackedResourceError('Work stream not found', 404)
  const resolved = await resolveLinearConnection(stream.squadId)
  if (!resolved) throw new TrackedResourceError('Linear connection needs revalidation before opening a session', 400)
  if (resource.connectionId && resource.connectionId !== resolved.connection.id)
    throw new TrackedResourceError('The issue is tracked under another Linear connection', 400)
  let configuration
  try {
    configuration = parseLinearConfiguration(resolved.connection.configuration)
  } catch {
    configuration = undefined
  }
  if (!configuration || !isLinearAppConfiguration(configuration))
    throw new TrackedResourceError(
      'Linear agent sessions need the Ficus Linear app connection; this squad connects to Linear with an API key',
      400
    )
  const [existing] = await db
    .select()
    .from(linearAgentSessions)
    .where(
      and(
        eq(linearAgentSessions.workStreamId, stream.id),
        eq(linearAgentSessions.issueId, resource.externalId),
        eq(linearAgentSessions.primary, true)
      )
    )
    .limit(1)
  if (existing) return { sessionId: existing.id, ...(existing.url ? { url: existing.url } : {}), created: false }

  let session: { id: string; url?: string }
  // The `created` webhook for this session may arrive before the row below exists; ingress waits
  // for it while the issue is marked here, so the session never goes through the rules.
  const pendingKey = proactiveSessionKey(resolved.connection.id, resource.externalId)
  pendingProactiveSessions.add(pendingKey)
  try {
    session = await createLinearSessionOnIssue(resolved.authorization, resource.externalId)
  } catch (error) {
    pendingProactiveSessions.delete(pendingKey)
    if (isLinearInsufficientScope(error)) {
      await markLinearScopeMissing(resolved.connection.id)
      throw new TrackedResourceError(
        'The Ficus Linear app lacks the permissions to open agent sessions; a Linear workspace admin must reconnect it in Settings, Integrations, Linear',
        409
      )
    }
    // Provider text is never relayed; the stream keeps tracking the issue either way.
    throw new TrackedResourceError('Linear did not open an agent session on this issue', 409)
  }
  await db
    .insert(linearAgentSessions)
    .values({
      id: session.id,
      connectionId: resolved.connection.id,
      organizationId: configuration.organizationId,
      issueId: resource.externalId,
      issueIdentifier: resource.repository && resource.number ? trackedResourceLabel(resource).slice(0, 100) : null,
      url: session.url ?? null,
      trigger: 'proactive',
      // Ficus opened this session for a stream: the binding announcement is its acknowledgment, and the
      // `created` webhook that follows gets no "checking how to handle this" disposition.
      ackState: 'sent',
      dispositionState: 'sent',
    })
    .onConflictDoUpdate({
      // A webhook that won the race recorded it first; it is still Ficus's own proactive session.
      target: linearAgentSessions.id,
      set: { trigger: 'proactive', ackState: 'sent', dispositionState: 'sent', updatedAt: new Date() },
    })
  pendingProactiveSessions.delete(pendingKey)
  const bound = await db.transaction((tx) => bindLinearSession(tx, session.id, stream.id))
  if (!bound) throw new TrackedResourceError('The new Linear agent session is already bound to another stream', 409)
  await announceLinearSessionBinding(session.id, stream.id)
  await projectLinearWriteBack(stream.id)
  void drainLinearOutboxSoon()
  return { sessionId: session.id, ...(session.url ? { url: session.url } : {}), created: true }
}
