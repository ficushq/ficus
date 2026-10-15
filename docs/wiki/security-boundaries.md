# Security boundaries

This page preserves the security rationale behind RBAC v2 and the Bigbrain integration, reconciled with repository code on 2026-09-08. It describes inspected implementation, not a completed penetration test or proof that every historical acceptance criterion passes. Deferred proposals and verification gaps are in Security follow-ups.

## Identity and permission authority

The current RBAC identity union contains `user`, `agent`, `legacy`, and `system`. User permissions come from role assignments. Agent permissions resolve through the live parent chain to its root authority; cycles, missing or inactive ancestors, and cross-squad parent chains deny authority. User-owned roots resolve through the owner's roles. Other agents receive role and extra-scope permissions only after the squad-access check. Extra scopes must never bypass that check.

System API tokens carry explicit permissions applied globally. The bootstrap `legacy` identity resolves to `*`; it is deliberately privileged. The token resolver accepts the configured bootstrap password only while no admin has a passkey, and compares password hashes with `timingSafeEqual`. Session authentication rejects disabled users, and user-owned agent tokens reject missing or disabled owners. Device tokens resolve to their owning user while retaining device provenance in the authentication context.

Sources: `apps/core/src/services/rbac/permissions.ts` (`Identity`, `resolveAgentAuthority`, `resolveAgentPermissions`, `resolvePermissions`); `apps/core/src/services/auth/resolve-token.ts` (`resolveTokenContext`). The existing AMTP identity implementation is a separate boundary; it does not add a DID or external-agent variant to this RBAC union.

Permission matching is directional. `secrets:read` grants a qualified request such as `secrets:read:integration`; that qualified permission does not grant bare `secrets:read`. A resource name alone, such as `secrets`, is not a wildcard. Explicit `*` and resource wildcards are supported. The shared matcher in `packages/shared/src/permissions.ts` is the authority for backend and frontend semantics.

## Request and live-event enforcement

Protected API handlers must perform an authorization check or explicitly mark a public route. `apps/core/src/middleware/authz-sentinel.ts` checks after the handler completes and replaces unguarded successful responses with a 500. It preserves handler-produced 4xx responses. Because the sentinel runs after the handler, it is a response backstop: write authorization still belongs before side effects. `apps/core/src/middleware/route-coverage.test.ts` is the route coverage check, not a substitute for per-resource authorization.

WebSocket authentication accepts a single-use ticket first, then a token or session cookie. Terminal handshakes additionally check `terminal:access` against the resolved squad; an agent's own box (`agent_<id>`) uses the private-area rule below, and other unresolved squad scope uses the unscoped permission check. Do not describe that fallback as universally “admin only”: system token scopes and other resolver behavior determine the result. Browser handshakes also check allowed origins. See `apps/core/src/index.ts` (`authenticateWsRequest`, `authorizeTerminalRequest`, and the WebSocket routes).

The event manager checks subscriptions and delivery. Current resource scope can require an owner, explicit permission, squad access, or inbox recipient; unavailable resources deny. Global events are intentionally broadly delivered to subscribers, while unrelated null-scope events fail closed for clients without all-squad access. Collection subscription alone is not permission to receive every event. Accessible-squad results are cached and `invalidateAccessCache` clears them; resource-specific checks still matter. See `apps/core/src/services/ws/manager.ts` and `apps/core/src/services/ws/topic-scope.ts`.

An agent's private area (its own box's private dir, holding its identity key and files saved for it alone) is reachable from the Workspace tab only by people: user sessions or the bootstrap `legacy` session, never agents or system tokens. Files need `agents:private-access` in the agent's squad (Admin and Operator by default), or ownership for a squad-less agent; a terminal in the agent's box also needs `terminal:access`. The agent, its squad and `agent_<id>` are resolved from the agent row; only top-level agents with a box of their own qualify. Every miss answers the same 403. Paths are confined below the private root by descriptor-relative `O_NOFOLLOW` walks (`@ficus/shared/confined-fs`), in Core for docker/host and through the box server's `/confined/*` routes for vm/k8s. Dot-prefixed paths and the root `identity.pem` are hidden and refused, not shown read-only, and `chat-attachments/` is read-only. A dormant agent's box is never started from here. Agent-box shells close when the agent is terminated, deleted or goes dormant. See `apps/core/src/services/agent-private/`, `apps/core/src/routes/agent-private.ts` and `apps/core/src/services/sandbox/terminal-access.ts`.

Signed image URLs gate image bytes. Current responses use `private, max-age=<seconds until signature expiry>, immutable`, permitting bounded browser caching while excluding shared caches. This supersedes the old plan's proposed universal `private, no-store`; preserve the privacy boundary without reinstating an obsolete cache choice. See `apps/core/src/routes/images.ts` and `apps/core/src/middleware/identity.ts`.

Expired sessions, passkey challenges, email verifications, and expired or consumed WebSocket tickets are removed by the auth cleanup service. Startup/shutdown wires its scheduler. See `apps/core/src/services/auth/cleanup.ts`, `cleanup-scheduler.ts`, and `apps/core/src/index.ts`.

## Bigbrain capability and credential boundaries

Bigbrain is registered as an implemented integration plugin. The older decision's “implementation held” header is historical. Its narrow-capability and privacy rationale remains useful, but the registry now includes other providers and connections are assigned to squads; “Bigbrain only” and “squad-owned connection” are not descriptions of the whole current integration architecture.

The runner requires both a version-1 integration policy allowing Bigbrain `agent_tools` and a matching tool allow entry before constructing its dynamic tools. Individual calls recheck squad identity, capability, assigned enabled connection, supported versions, authenticated/healthy state, matching material and validated revisions, unexpired validation, and provider scope before loading credentials and calling the provider. The four tools are search, note retrieval, memory retrieval, and Markdown inbox drop. Reads require `vault:read`; drop requires `inbox:write`.

Sources: `apps/core/src/entities/agent-runners/base.ts` (`allowsBigbrainIntegrationTools`, `resolveIntegrationTools`); `apps/core/src/services/integrations/runtime-gate.ts`; `apps/core/src/services/integrations/bigbrain/tools.ts`; `apps/core/src/services/integrations/bigbrain/plugin.ts`.

Connection validation has a 15-minute freshness window and records results against a material revision. Runtime authentication failures disable the matching revision so stale failures cannot disable a replacement credential. Safe connection views project selected fields; audit records describe actions and outcomes without copying conversation bodies. The client uses fixed `/v1` operations, bounded responses, timeouts, validated response shapes, and sanitized error codes. See `apps/core/src/services/integrations/connection-service.ts`, `db-connection-repository.ts`, `audit.ts`, and `bigbrain/client.ts`.

## Conversation export is separately consented

Export has its own `conversation_export` capability and requires `inbox:write`. Consent is prospective: enabling it records the current maximum enqueue order, policy/projection versions, connection, agent, and consenting user. Squad-less agents and subagents are ineligible. Existing history is not backfilled by this consent mechanism.

On completion, the projector selects messages attributed to that execution. It requires a completed root-agent execution and active consent; message projection rejects the whole selected execution group for pending or pre-consent messages, mismatched agent/execution/user provenance, deleted or redacted metadata, disabled export, images, attachments, or an incomplete user/assistant pair. Human messages must be server-attributed `user_chat` from the consenting user. NDJSON serialization emits only role and text; transport metadata uses synthetic session/cwd values rather than local paths.

Sources: `apps/core/src/services/integrations/export/consent-service.ts`, `completion-projector.ts`, `projection.ts`; `apps/core/src/services/integrations/bigbrain/export.ts`.

The outbox encrypts stable payloads before persistence, limits batches to 100 records and 256 KiB, and delivers through ordered leased work with bounded retries. Current consent, assignment, eligibility, versions, policy, connection health/auth/revision/freshness, and scope are checked before decryption and checked again in delivery before provider I/O. Successful delivery advances the cursor and scrubs the stored ciphertext and IV. Revoking consent prevents subsequent gated delivery; it does not delete already delivered provider data.

Sources: `apps/core/src/services/integrations/export/outbox.ts`, `worker.ts`, `delivery-context.ts`, `db-outbox-repository.ts`; runtime wiring in `apps/core/src/services/integrations/runtime.ts`.

These controls do not prove arbitrary conversation text contains no sensitive information. `redactConversationText` uses specific credential patterns and an optional known-secret list; the completion projector currently does not pass that list. Ordinary prose containing paths, environment details, or sensitive material outside those patterns can remain. The broader historical requirement to reject every uncertain content-safety case therefore remains a reconciliation item, not a guarantee of this page.

## Historical rationale and verification pointers

The preserved sources are `docs/history/plans/2026-06-17-rbac-v2-design.md`, `docs/history/plans/2026-06-17-rbac-v2-plan-3-deferred-security.md`, `docs/history/decisions/2026-08-14-integrations-bigbrain.md`, and `docs/history/plans/2026-08-14-integrations-bigbrain.md`. Historical “deferred security” titles do not imply their entire implementation remains unfinished.

Useful regression sources include `apps/core/src/services/auth/resolve-token.test.ts`, `apps/core/src/services/ws/manager.test.ts`, `apps/core/src/services/integrations/runtime-gate.test.ts`, `apps/core/src/entities/agent-runners/base.integration-tools.test.ts`, and the tests alongside the export projector, consent service, worker, and outbox repository. They identify intended boundaries; their presence is not a current passing-test result.
