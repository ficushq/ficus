import type { WorkStreamWaitType, InboxRecipientType } from './types'
import type { SquadActivityItem } from './squad-activity'
import type { FarmChatMessage } from './farm-chat'
import type { PresencePerson } from './farm-presence'

/**
 * Minimal event payloads — IDs and basic fields only.
 * Handlers load full entities from DB when they need more info.
 */
export interface MessageEventData {
  messageId: string
  agentId: string
  /** Durable execution that consumed or produced this message, when known. */
  executionId?: string
  /** Opaque live/persisted response group, when known. */
  streamGroupId?: string
}

export interface SquadActivityProjectionEventData {
  squadId: string
  operation: 'upsert' | 'delete'
  item: SquadActivityItem
  quietEligible: boolean
  accessScope: 'agents' | 'workstreams' | 'inbox' | 'workstreams_inbox'
  inboxRecipientId: string | null
  agentTypeRequiresAgentsRead: boolean
}

export type EventMap = {
  // Content-free Action Center reconciliation hint. Clients refetch authoritative data.
  'actions.invalidated': Record<string, never>

  'squadActivity.projected': SquadActivityProjectionEventData
  'squadActivity.accessRevoked': { squadId: string }
  // Message events
  'message.created': MessageEventData
  'message.updated': MessageEventData

  // Agent events
  'agent.created': { agentId: string; squadId: string | null }
  /**
   * A field on the AGENT ROW changed (status, model, termination, ...).
   *
   * Deliberately NOT emitted when a message is persisted: that path leaves the
   * agents row untouched, and clients react to this event by refetching the
   * agent's detail, context, active execution, sandbox status, artifacts and
   * the Action Center — none of which a new message can affect. Use
   * `agent.new-message` for that.
   */
  'agent.updated': { agentId: string; squadId: string | null }
  /**
   * A message was persisted for this agent. The agents row did not change.
   *
   * It exists because the squad roster (`GET /squads/:id/agents`) renders
   * `lastMessageAt` / `lastMessagePreview`, so a chat-list-style panel does
   * need to update — but ONLY that, and only for this one agent. Emitting
   * `agent.updated` here instead made every message refetch the agent's whole
   * query family on web and, on mobile, `agents.all` — every agent's
   * everything.
   *
   * Content-free like every other event here (see the file header): the
   * preview text is message CONTENT, and this topic fans out more widely than
   * the permission to read it.
   */
  'agent.new-message': { agentId: string; squadId: string | null }
  'agent.waiting-input': { agentId: string; squadId: string | null }
  'agent.terminated': { agentId: string; squadId: string | null }
  'agent.deleted': { agentId: string; squadId: string | null; ownerUserId: string | null }
  'agent-question.created': { questionId: string; agentId: string; squadId: string | null }
  'agent-question.answered': { questionId: string; agentId: string; squadId: string | null }
  'agent-question.delivery-failed': { questionId: string; agentId: string; squadId: string | null }
  'agent-question.delivery-retrying': { questionId: string; agentId: string; squadId: string | null }
  'agent-question.dismissed': { questionId: string; agentId: string; squadId: string | null }

  // Artifact events
  'artifact.updated': {
    agentId: string
    squadId: string | null
    artifactId: string
    title: string
    summary?: string
    status: 'working' | 'ready' | 'error'
    updatedAt: string
  }

  // Execution events
  'execution.created': { executionId: string; agentId: string; status: string }
  'execution.queued': { executionId: string; agentId: string; status: string }
  'execution.started': { executionId: string; agentId: string; status: string }
  'execution.updated': { executionId: string; agentId: string; status: string }
  'execution.completed': { executionId: string; agentId: string; status: string }
  /** Additive nullable classification fields; older emit sites omit them. */
  'execution.failed': {
    executionId: string
    agentId: string
    status: string
    failureClass?: string | null
    failureReason?: string | null
  }
  'execution.stopped': { executionId: string; agentId: string; status: string }

  // Sandbox local deployment events
  'sandboxLocalDeployment.updated': { localDeploymentId: string; squadId: string; status: string }

  // Fired after an agent's sandbox(es) are (re-)ensured at the start of a run, so
  // the UI can refetch sandbox status the moment a (re)created box is up rather
  // than waiting for the next poll tick.
  'sandbox.ensured': { agentId: string }

  // Fired whenever a sandbox's observable pod status transitions
  // (pending → starting → running → ... → gone), so the UI can refetch
  // status live instead of polling. Payload is the sandbox ID; the client
  // derives which status query to invalidate from its prefix.
  'sandbox.status': { sandboxId: string }
  'integration.projection-invalidated': { squadId: string; providerKey: string }
  'sandbox.provision-transition': {
    scopeHash: string
    from: 'closed' | 'open' | 'half_open'
    to: 'closed' | 'open' | 'half_open'
    version: number
    reasonCode?: string
    retryAfterMs?: number
  }

  // Monitor events
  'monitor.created': { monitorId: string; agentId: string; squadId: string | null; status: string }
  'monitor.updated': { monitorId: string; agentId: string; squadId: string | null; status: string }
  'monitor.ended': { monitorId: string; agentId: string; squadId: string | null; status: string }

  // Machine / box lifecycle events (VM sandbox runtime). Admin-global surface —
  // IDs only, no secret/token material. `machine.status` fires on an actual
  // status transition; `machine.updated` on any other machine-row change.
  'machine.created': { machineId: string }
  'machine.updated': { machineId: string }
  'machine.status': { machineId: string; status: string }
  'machine.deleted': { machineId: string }
  // `port` is the box's bound port on its machine, so a subscribing process can
  // drop its own stale tunnel forward for that (machineId, port) pair without a
  // DB read (cross-process invalidation; ports are machine-local, not secret).
  'box.status': { sandboxId: string; machineId: string; status: string; port: number }

  // Squad events
  'squad.created': { squadId: string }
  'squad.updated': { squadId: string }
  /** Content-free invalidation; queue details require a separately authorized read. */
  'slots.updated': { squadId: string }
  'squad.archived': { squadId: string }
  'squad.agentSpawned': { squadId: string; agentId: string }

  // Squad relationship events
  'squadRelationship.created': { relationshipId: string; sourceSquadId: string; targetSquadId: string }
  'squadRelationship.deleted': { relationshipId: string }

  // Work Stream events
  //
  // `actorAgentId` — the agent whose action produced the event, when one is
  // known. It exists so a notifier can decline to tell an agent about its own
  // action (see services/squad/work-stream-notifications.ts). It MUST travel in
  // the payload rather than in ambient request context: these events are
  // forwarded to the other process as serialized JSON over local-events HTTP
  // on `app_events` (`apps/core/src/lib/infra/event-emitter.ts`), so anything not in the
  // payload is simply gone by the time the fallback handler runs there.
  // Absent/null means a user, the system, or an unknown caller — notify everyone.
  'workStream.created': { workStreamId: string; squadId: string }
  'workStream.updated': { workStreamId: string; squadId: string }
  'workStream.assigned': { workStreamId: string; squadId: string; agentId: string; actorAgentId?: string | null }
  'workStream.agentAdded': { workStreamId: string; squadId: string; agentId: string }
  'workStream.agentRemoved': { workStreamId: string; squadId: string; agentId: string }
  // Emitted when a manual/system wait opens (the stream needs attention).
  'workStream.blocked': { workStreamId: string; squadId: string; waitId?: string; actorAgentId?: string | null }
  // Emitted when a review wait opens (handoff to review).
  'workStream.review': { workStreamId: string; squadId: string; waitId?: string; actorAgentId?: string | null }
  'workStream.responded': {
    workStreamId: string
    squadId: string
    /** The wait type the response resolved (`manual` = unblocked, `review` = verdict). */
    resolvedWaitType: WorkStreamWaitType
    /** For review waits: `approved` (checkpoint gate passed) vs `sent_back`. */
    reviewResolution?: 'approved' | 'sent_back'
    waitId?: string
    actorAgentId?: string | null
  }
  'workStream.done': { workStreamId: string; squadId: string; agentIds: string[]; actorAgentId?: string | null }
  'workStream.canceled': { workStreamId: string; squadId: string; agentIds: string[]; actorAgentId?: string | null }
  /** A terminal stream re-entered admission (status back to `queued`). */
  'workStream.reopened': {
    workStreamId: string
    squadId: string
    previousStatus: 'done' | 'canceled'
    actorAgentId?: string | null
  }
  'workStream.deleted': { workStreamId: string; squadId: string }
  /** Widget/Live Activity audience changed without a work-stream lifecycle mutation. */
  'liveActivity.interestChanged': { userId: string }

  // Control signal ack events
  /**
   * Ack for a clear-queue control signal. ALWAYS emitted by the worker, including
   * on failure — the API blocks on this ack, so a silent failure would strand it
   * for the full timeout and then report success it cannot vouch for.
   *
   * `owned` distinguishes the worker that held the live SDK session (and so
   * actually emptied the in-memory queue) from one that only deleted DB rows.
   * Without it a non-owning worker's ack looks identical to a real clear, and
   * the queued messages get processed anyway.
   */
  'agent.queue-cleared': {
    agentId: string
    cleared: number
    deleted: number
    owned?: boolean
    ok?: boolean
    code?: string
  }

  // Worker events
  'worker.status': {
    status: 'online' | 'offline'
    activeExecutions?: number
    uptime?: number
  }

  // Schedule events (unified)
  'schedule.created': { scheduleId: string }
  'schedule.updated': { scheduleId: string }
  'schedule.triggered': { scheduleId: string }
  'schedule.webhook_triggered': { scheduleId: string }
  'schedule.deleted': { scheduleId: string; scopeType: string; scopeId: string }
  'schedule.failed': { scheduleId: string; healthEventId: string }
  'schedule.recovered': { scheduleId: string; healthEventId: string }
  'schedule.automatically_disabled': { scheduleId: string; healthEventId: string }

  // Onboarding events. A pure "recompute now" signal — the checklist status
  // is always DERIVED fresh server-side on every read (see
  // apps/core/src/services/onboarding/status.ts's getOnboardingStatus), so
  // this event carries no payload; it just tells a subscribed client to
  // refetch. Admin-global (not squad-scoped) — see ws/topic-scope.ts's
  // eventSquadId, which fails this closed to full-access clients only, same
  // as machine.*/box.status.
  'onboarding.updated': Record<string, never>

  // Inbox events
  'inbox.messageReceived': {
    messageId: string
    recipientType: InboxRecipientType
    recipientId: string
    senderAgentId: string | null
    source?: string
    squadId?: string
    /** Server-derived: a saved Assistant update that is push-eligible (actionable, current, status-changing). */
    assistantPush?: true
  }
  'inbox.messageRead': { messageId: string; recipientType: InboxRecipientType; recipientId: string }
  'inbox.allRead': { recipientType: InboxRecipientType; recipientId: string }

  // Durable Assistant task/update state changed for one saved conversation. Carries identifiers
  // only; the owner refetches activity. Routed through the inbox topic family as
  // `inbox:assistant:<conversationId>` and delivered to the conversation owner alone.
  'assistant.activityChanged': { conversationId: string; recipientId: string }

  // Farm presence (see farm-presence.ts). Sent by the API process itself on the
  // `presence` topic, per recipient (each sees only the focus they may see);
  // never emitted through the event bus, so the WS bridge ignores them.
  'presence.snapshot': { people: PresencePerson[] }
  'presence.updated': { person: PresencePerson }
  'presence.left': { userId: string }

  // Farm chat (see farm-chat.ts). Sent by the farm chat routes on the
  // `farmChat` topic: a public room's messages to everyone, a DM's to its two
  // people; room changes (create, rename, delete) just ask clients to refetch.
  'farmChat.messageCreated': { message: FarmChatMessage }
  'farmChat.roomsChanged': Record<string, never>
}
