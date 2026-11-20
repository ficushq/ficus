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
  try {
    session = await createLinearSessionOnIssue(resolved.authorization, resource.externalId)
  } catch {
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
    .onConflictDoNothing({ target: linearAgentSessions.id })
  const bound = await db.transaction((tx) => bindLinearSession(tx, session.id, stream.id))
  if (bound) {
    await announceLinearSessionBinding(session.id, stream.id)
    await projectLinearWriteBack(stream.id)
    void drainLinearOutboxSoon()
  }
  return { sessionId: session.id, ...(session.url ? { url: session.url } : {}), created: true }
}
