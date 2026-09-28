# Distributed Event Emitter

Ficus has an in-process typed event emitter in both the API and worker. The two emitters are joined by the authenticated, best-effort local-events HTTP transport on the `app_events` channel.

## Architecture

```text
Worker process                              API process
┌────────────────────┐                    ┌────────────────────┐
│ eventEmitter       │                    │ eventEmitter       │
│ local subscribers  │◄──── HTTP ───────►│ local subscribers  │
└────────────────────┘   local-events     └────────────────────┘
       dedicated listener                 POST /internal/events
```

The API posts to the worker's dedicated listener (loopback by default). The worker posts to the API's existing `POST /internal/events` route. `FICUS_WORKER_EVENT_BIND`, `FICUS_WORKER_EVENT_URL`, and `FICUS_API_EVENT_URL` support deployments where the processes use separate network namespaces.

## Key files

| File                                       | Purpose                                                |
| ------------------------------------------ | ------------------------------------------------------ |
| `packages/shared/src/events.ts`            | `EventMap`, the event type and payload source of truth |
| `packages/shared/src/ws-topics.ts`         | WebSocket topics and topic-to-event typing             |
| `apps/core/src/lib/infra/event-emitter.ts` | `DistributedEmitter` and the `eventEmitter` singleton  |
| `apps/core/src/lib/infra/local-events.ts`  | Authenticated API↔worker HTTP transport                |
| `apps/core/src/services/ws/bridge.ts`      | Routes events to WebSocket topics                      |
| `apps/core/src/services/ws/manager.ts`     | WebSocket clients and subscriptions                    |

## Event delivery

Each process configures local-events for its role, initializes the emitter with a process ID, and listens on `app_events`. Before initialization, `emit()` dispatches locally only, which keeps isolated tests safe.

Calling `eventEmitter.emit(event, data)`:

1. dispatches to current-process handlers;
2. serializes `{ event, data, source }` and makes one best-effort peer post;
3. logs and swallows forwarding failures.

On receipt, `source` suppresses the sender's self-echo and prevents re-forwarding. Local self-delivery matches the previous PostgreSQL NOTIFY behavior. Peer delivery is at most once: there is no retry, persistence, or acknowledgement. An HTTP 2xx means only that the peer route accepted the post, not that a handler acted on it.

Every post is authenticated. The token resolves in this order:

1. explicit `FICUS_INTERNAL_EVENT_TOKEN`;
2. an HMAC-derived token from `FICUS_ENCRYPTION_KEY`;
3. a random per-process token, which fails closed because the two processes will not agree.

## Local-events channels

| Wire channel                   | Effective direction                            | Payload / use                                                                                                                                | Authority or fallback                                                                                                                                         |
| ------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_events`                   | API ↔ worker                                   | Serialized typed event `{ event, data, source }`; self-echo is ignored by `source`.                                                          | No universal replay. Most events describe durable rows or refetch hints. Execution pickup also has boot pickup, a 5-second poll, and the queue watchdog.      |
| `agent_control`                | API or worker → worker                         | Only `stop`, `abort-tool`, `compact`, `reset`, and `clear-queue`; self-delivery supports worker-originated control. **Not steer/follow-up.** | Action-specific recovery described below; `abort-tool` has no replay.                                                                                         |
| `secret_changed`               | API ↔ worker                                   | Secret key only; the peer rereads the DB.                                                                                                    | Immediate invalidation is the fast path; both caches refresh the DB every 60 seconds.                                                                         |
| `setting_changed`              | API ↔ worker                                   | Selected setting key only, for definitions marked `crossProcess`.                                                                            | Both stores refresh the DB every 60 seconds.                                                                                                                  |
| `device_token_revoked`         | Currently API publishes; API registry consumes | Durable device-token UUID only. The worker route accepts the channel but has no production consumer.                                         | Synchronous same-process revocation, DB admission, and 1-second registry revalidation.                                                                        |
| `instance_maintenance_changed` | API → worker                                   | Durable maintenance generation as a convergence nudge.                                                                                       | DB maintenance state; the worker reconciles at startup and every 5 seconds.                                                                                   |
| `system_restart`               | API → worker                                   | JSON restart request; the worker shuts down gracefully and exits nonzero.                                                                    | Best effort only; no durable replay. The API restarts itself regardless; abandoned-lease recovery protects work if a received restart cannot requeue cleanly. |

`agent_control` recovery is action-specific. Stop persists `stopping`; the runner checks it at settlement, startup completes stale rows, and force-stop is available. Compact and reset persist transitional state with watchdog/startup recovery. Clear-queue deletes pending DB rows on acknowledgement timeout but truthfully reports failure because it cannot prove that the live SDK queue was cleared. `abort-tool` has no replay.

Steer and follow-up use durable pending-message delivery, not `agent_control`. `POST /api/agents/:id/message` transactionally stores a pending human message with `deliveryMode`. `PendingInterventionQueue` drains at runner start and when `message.created` nudges it, then claims the row and invokes `session.pi.steer()` or `session.pi.followUp()`. If a nudge is missed, settlement makes bounded requeue attempts; after the retry budget is exhausted, rows remain pending until another message.

## Forwarding diagnostics

Forwarding counters are process-local and reset on restart:

- API: protected `GET /api/system/diagnostics` → `resources.local_event_forward`
- Worker: `GET /health` → `localEventForward`

Each of the seven fixed channels plus `other` reports attempts, failure counts for `http_rejection`, `network`, and `timeout`, and one `lastFailure` containing only `at`, category, and HTTP status. A 401 commonly indicates a token mismatch; other statuses are peer HTTP rejection. Network and timeout failures have no status.

Diagnostics never retain payloads, tokens, peer URLs, response bodies, or exception text. Counts are since process start and do not aggregate across roles.

## Event and WebSocket types

`EventMap` in `packages/shared/src/events.ts` is the complete event inventory and payload contract. Prefer ID payloads such as `{ agentId }`, `{ executionId, agentId, status }`, and `{ messageId, agentId }`; consumers refetch durable rows as needed.

WebSocket routing is defined in `packages/shared/src/ws-topics.ts`. Current collection topics are `actions`, `agents`, `schedules`, `monitors`, `squads`, `workstreams`, `squadSchedules`, `worker`, `inbox`, `machines`, `onboarding`, and `squadActivity`. Instance topic families are `agents`, `schedules`, `squads`, `workstreams`, `inbox`, `machines`, and `squadActivity`.

The backend bridge in `apps/core/src/services/ws/bridge.ts` maps typed events to topics. Its discriminated unions and exhaustive checks make the compiler flag unmapped events. Frontend subscribers receive the same typed `{ event, data }` entries and typically invalidate hierarchical React Query keys so current state is refetched.

## Adding an event

1. Add its typed payload to `EventMap` in `packages/shared/src/events.ts`.
2. Update topic typing in `packages/shared/src/ws-topics.ts` if browsers consume it.
3. Route it in `apps/core/src/services/ws/bridge.ts`; exhaustive checks guide required cases.
4. Emit it from the owning entity or service.
5. Add frontend invalidation only when existing topic invalidation is insufficient.

Use `onAny(handler)` for process-local subscribers that need every typed event, such as the WebSocket bridge and notification service. Tests that use the singleton should remove listeners during cleanup.
