# Consultant

The **Consultant** is a per-squad, human-facing conversational agent — the counterpart to the squad's [Manager](agent-runners.md#squad-manager). Where the manager is a machine-facing hub (work-stream lifecycle updates, inter-agent messaging, reconciliation), the Consultant is a clean human interface for ideation, research, and kicking off new work.

## Overview

A squad's manager chat is intentionally noisy: it receives every work-stream update and inter-squad message. The Consultant keeps that channel uncluttered by giving humans a disposable conversation space. Each "new chat" creates a fresh Consultant agent. Old sessions stay in history and remain searchable by purpose. Ordinary deletion makes a session dormant and wakeable; the retention lifecycle later finalizes dormant sessions automatically.

**Division of roles:**

| Agent      | Facing  | Role                                                                                     |
| ---------- | ------- | ---------------------------------------------------------------------------------------- |
| Manager    | Machine | Central orchestrator; owns work streams; single point of contact for other agents/squads |
| Consultant | Human   | Conversational interface; ideates, researches, and hands work to the manager             |

## How It Works

### Clone of the manager

The Consultant is a **full clone of the manager** — same tools, model, skills, short-term memory, and RBAC permissions. The only difference is the system prompt (`config/agent-types/consultant.yaml`), which establishes its human-facing role and delegation behavior.

**Runner routing:** `Agent.runnerType` (`apps/core/src/entities/Agent.ts`) routes both `manager` and `consultant` agent types to the `squad-manager` runner:

```
agentTypeId === 'manager' || agentTypeId === 'consultant'  →  'squad-manager'
```

The `SquadManagerRunner` builds the full manager tool set — coding/sandbox tools, web, browser, dispatch, short-term memory, squad memory, ask-human, notify-contact — and applies `agentType.skills` from `consultant.yaml`. See [Agent Runners → squad-manager](agent-runners.md#squad-manager) for details.

**RBAC:** The Consultant resolves to the `default-manager` role (same permissions as the squad manager). Because a Consultant agent has no `ownerUserId` and its token carries no `userId`, the user-RBAC branch is skipped and the agent-type role applies. See [Core API Authentication → Agent identities](core-auth.md#agent-identities).

### Lazy creation via `POST /api/chat`

A Consultant session is created on demand by `POST /api/chat` when the request carries `scope: { type: 'consultant', id: <squadId> }`. The chat route always creates a fresh agent for this scope type — no reuse of an existing idle session. The created agent has:

- `agentTypeId: 'consultant'`
- `squadId` set to the scope's squad id
- `context.scope = { type: 'consultant', id: squadId }`
- `persist: false`
- `ownerUserId` unset (squad identity, not user identity)

Resuming an existing session uses the normal `agentId` path instead.

The `agent` SSE event returned at turn start carries `{ agentId, scope, executionId }`, which clients use to capture the new session id.

### Ephemerality and lifecycle

Consultants are **ephemeral but retained**:

- `persist: false` — terminable without force-protection (unlike the manager, which is force-persisted)
- **Excluded from `Squad.cleanupFlexAgents`** — the periodic flex-cleanup sweep does not reap idle Consultant sessions; they stay until a user explicitly makes them dormant through the existing terminate action (final termination remains retention-driven)
- **Excluded from active-agent counts** — Consultants are filtered out of the active-agent count displayed in the squad detail view, so a pile of old sessions doesn't inflate headcount
- **Mid-conversation safety** — termination defers while an execution is running; a Consultant with an active turn is never reaped mid-turn

Consultants are identified by `agentTypeId: 'consultant'` (used for web agents-view grouping) and also carry `context.scope` from the chat path (used for mobile listing via `listAgents({ scopeType: 'consultant', scopeId: squadId })`).

### Work handoff

For tracked work, the Consultant creates a work stream owned by the squad manager and chooses an explicit workflow. The shared runner's current flow instructions supersede older up-front staffing advice in the base prompt.

```sh
ficus workstream create "<deliverable title>" -q {{squad.id}} -d "<goal + context>" \
  --owner {{manager.id}} --workflow solo
```

Choose the style for the actual task and the user's preferences: Solo does not require architect/reviewer turns, while Engineering provides its declared implementation, review and PR-merge process. A saved preset or inline flow owns routing, participation and completion. Do not also pass `--agents`, `--agent-ids`, `--assign-id` or `--completion-mode`; participants are created lazily when needed. See [Workflows](workflows.md).

For code work, establish the intended repository/worktree context and record its branch/worktree metadata. The create command records that metadata; it does not itself create a Git worktree. Preserve the user's selected checkout and branch policy.

Both `{{squad.id}}` and `{{manager.id}}` are template variables supplied by `SquadManagerRunner`. For a consultant, the manager ID is the squad's manager, not the consultant itself. The owner receives creation/lifecycle notifications and remains responsible for ongoing coordination. The Consultant links the new work stream in its response so the user can follow it.

Manually staffed streams without a workflow remain a legacy path. Their assignment and review conventions should not be presented as requirements for flow-enabled streams.

### Orchestration belongs to the manager

For efforts larger than a single staffed work stream (parallel tracks, multi-phase design→build→review, cross-stream coordination), the Consultant does **not** orchestrate across its ephemeral session — it briefs the manager via an inbox message to `{{manager.id}}` (`ficus inbox send`) describing the goal and the orchestration it envisions, and lets the manager (the standing orchestrator) set it up and run it. It may seed the obvious first work stream(s), but ongoing coordination always rests with the manager. The manager's full orchestration playbook is intentionally **not** copied into the consultant prompt.

### Owner-on-creation notification

When a work stream is created by one agent (the `creatorAgentId`) but owned by another (`ownerAgentId`), the owner is notified at creation time. This powers the Consultant handoff: the manager receives an inbox message ("New work stream you own, started by Consultant: `<title>`") whenever a Consultant creates a work stream on its behalf.

The notification fires when:

- `creatorAgentId` is set (agent-initiated; user-created streams leave it null), and
- `ownerAgentId` is set and `ownerAgentId !== creatorAgentId`

Deduplication avoids double-notifying an owner who is also the assignee and received an assignment notification.

See [Notifications → Work-stream owner notification](notifications.md#work-stream-owner-notification).

## Web surface

The squad's **Chats** tab (`apps/web/src/components/squads/SquadAgentThreads.tsx`) presents consultant conversations. New conversations create a consultant lazily through the chat route; existing conversations resume by agent ID.

The app-wide Assistant also exposes recent consultant conversations and a squad-scoped entrypoint. In a squad preview, the search input filters conversations and work; the Start action uses the entered text to create a consultant conversation inline. Purposes and activity indicators come from current agent data. Full-conversation links open the squad's Chats tab with that agent selected.

Dormant/terminated agents are omitted from the Assistant's ordinary conversation results. A work stream may retain its originating consultant as a read-only “Started here” link for context.

## Mobile surface

Squad screens open directly into the manager chat (current behavior). The conversation screen (`app/(tabs)/squads/[agentId].tsx`) adds two header controls:

- **New chat button** (always visible in the header) — starts a new Consultant session and navigates to it; uses `client.chat.sendChatMessage({ message, scope: { type: 'consultant', id: squadId } })` and captures the `agentId` from the `agent` stream event
- **Conversation list popup** — opens a `DetailSheet` bottom sheet showing the **manager pinned at the top** and **Consultant sessions** below, listed via `client.agents.listAgents({ scopeType: 'consultant', scopeId: squadId })`, named by `metadata.purpose` (fallback: agent name), with a search box filtering by purpose; tapping any row navigates to that conversation

Work-stream cards created by the Consultant are tappable in the mobile conversation and deep-link to the work stream (the existing Action Center deep-link pattern).

See [Mobile App → Consultant chat](mobile-app.md#consultant-chat).

## Project commands

Consultants use `squad_bash` for repository and project commands so they operate in the squad's shared runtime. Read the current work-stream git/worktree metadata before choosing a directory; do not assume a fixed workspace mount. If `squad_bash` is unavailable, delegate project commands to a squad worker with shared-runtime access rather than using a private checkout as a substitute. See [agent runners](agent-runners.md) for the tool and runtime boundaries.

## Key files

| File                                                        | Purpose                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `config/agent-types/consultant.yaml`                        | Agent type definition — manager clone with consultant system prompt |
| `apps/core/src/entities/Agent.ts` (`get runnerType`)        | Routes `consultant` → `squad-manager` runner                        |
| `apps/core/src/routes/agent-types.ts`                       | `PROTECTED_AGENT_TYPES` includes `'consultant'`                     |
| `apps/core/src/services/rbac/permissions.ts`                | `consultant → default-manager` role mapping                         |
| `apps/core/src/entities/Squad.ts` (`cleanupFlexAgents`)     | Excludes `consultant` from flex-cleanup sweep                       |
| `packages/shared/src/schemas.ts`                            | `chatScopeTypeSchema` includes `'consultant'`                       |
| `apps/core/src/routes/chat.ts`                              | `scope.type === 'consultant'` always-create-new branch              |
| `apps/core/src/entities/WorkStream.ts`                      | `creatorAgentId` stored; owner notification on creation             |
| `apps/core/src/services/squad/work-stream-notifications.ts` | `notifyWorkStreamOwnerOfNewStream`                                  |
| `apps/web/src/components/squads/SquadAgentThreads.tsx`      | Auto-collapse, purpose search, new-consultant-chat button           |
| `apps/web/src/components/SquadDetailPage.tsx`               | Excludes `consultant` from active-agent count                       |

## Related docs

- [Agent Runners](agent-runners.md) — the `squad-manager` runner the Consultant uses
- [Core API Authentication](core-auth.md) — agent identities, RBAC role resolution
- [Notifications](notifications.md) — work-stream owner notification on creation
- [Mobile App](mobile-app.md) — consultant chat and conversation list popup

### Reporting delegated outcomes

A consultant can opt into a one-shot terminal update with
`ficus workstream create ... --observe terminal`, or later with
`ficus workstream observe <id>`. Inspect with `ficus workstream observation <id>`
and remove with `ficus workstream unobserve <id>`. This is agent observation,
not USER subscribe/unsubscribe; the manager remains the owner and orchestrator.

Only delivered done or cancellation consumes the watch. Already-terminal streams
reject registration; reopening requires a new watch. Observer updates are context
for reporting to the user or originating Assistant task, not management instructions.
They do not replace Assistant task reporting obligations, wake stopped/deleted
conversations, or justify polling or duplicate orchestration.
