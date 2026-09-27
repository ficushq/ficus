# Agent Runners

An **agent runner** is the per-execution object that wires an agent type to a Pi SDK session, streams events, persists messages and usage, and finalizes the execution when the turn settles. Six concrete runners cover the system's distinct execution contexts.

This doc is the runner-by-runner companion to [`agents-and-executions.md`](agents-and-executions.md). Read that first if you don't have the agent/execution model in your head yet.

## The Six Runners

| Runner             | Used by agent type                         | Sandbox kind            | Key responsibilities                                                         |
| ------------------ | ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------- |
| `system-manager`   | `system-manager`                           | Per-user shared sandbox | Cross-squad operations within the owning user’s access; UI navigation        |
| `squad-manager`    | `manager` or `consultant` (with `squadId`) | Private + shared squad  | Orchestrates one squad: work streams, agents, schedules, memory, todos       |
| `squad-worker`     | other squad agent types                    | Private + shared squad  | Architect/engineer/reviewer/etc.; teammate-aware; role-specific instructions |
| `artifact-builder` | `artifact-builder-default`                 | Workspace sandbox       | Artifact generation runs with `artifact_*` tools                             |
| `subagent`         | any agent with `parentAgentId`             | Parent's light sandbox  | Narrow delegated work in the parent’s sandbox with scoped authority          |

## How a Runner Is Selected

`Agent.runnerType` (`apps/core/src/entities/Agent.ts`) resolves the runner from `parentAgentId`, `agentTypeId`, and `squadId`:

```
if parentAgentId is set                     → 'subagent'
else if agentTypeId == 'system-manager'     → 'system-manager'
else if agentTypeId == 'artifact-builder-default' → 'artifact-builder'
else if squadId is set:
    if agentTypeId in ['manager', 'consultant'] → 'squad-manager'
    else                                    → 'squad-worker'
else                                        → throws (unexpected)
```

The worker calls `createRunner(agent, execution)` (`agent-runners/index.ts`) which instantiates the matching subclass.

## Base Lifecycle

All runners extend `AgentRunner` (`agent-runners/base.ts`). The base class implements `run()` as a template method:

```
run()
 ├─ createBuffer + StreamEventCollector  (streaming infra)
 ├─ createSession()                       ── abstract: subclass builds Pi SDK session
 ├─ registerSession()                     (so steer/stop can find it)
 ├─ pushAgentEvent()                      (optionally overridden for scope info)
 ├─ session.pi.subscribe(event => ...)    (shared event handling)
 └─ sendPrompt()                          ── derived from buildPrompt() — abstract
```

The subscribed event handler covers:

- **`message_update`** — on first assistant output, confirms pending human messages and marks images "used"
- **`session_message_persisted`** — persists assistant/user/toolResult messages and session usage to the DB
- **`auto_retry_end` / `compaction_start` / `compaction_end`** — resets the stream collector across SDK-managed retries/compaction; checks transitional stop state if compaction aborted
- **`agent_settled`** — final settlement: awaits all pending message persists, then calls `handleAgentEnd()`, which calls the subclass's `onComplete()` (or `onError()` on failure)

### Abstract methods subclasses implement

| Method            | What it does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| `createSession()` | Build the Pi SDK session: system prompt, tools, sandbox, skills, extensions, model |
| `buildPrompt()`   | Build the initial prompt text (and optional images) for this execution             |
| `onComplete()`    | Handle a successful turn — persist response, mark execution complete               |

Subclasses can also override:

- `pushAgentEvent()` — to add scope info to the initial stream event
- `onError()` — for runner-specific cleanup on failure

## Shared Concerns Handled by Every Runner

These all live in `base.ts` or shared services, and every subclass uses them:

- **Skills:** `resolveSkillPaths()` merges agent-type skills with squad-scoped extras (`squad.metadata.agentTypeSkills.<agentTypeId>`), de-duplicates, and materializes them into the sandbox.
- **Extensions:** `resolveExtensionPaths()` resolves any agent-type `extensions:` (paths under `config/agent/extensions/`), including `pi.extensions` entry points from `package.json`.
- **Short-term memory:** small private recovery notes are saved immediately and can be read with `short_term_memory_read` at any time. They never enter the system prompt. After a successful manual or automatic compaction (including a consumed background bake), the latest note is frozen in session metadata and presented as ordinary context immediately after the summary. A genuinely empty conversation gets one initial snapshot; reopening existing history does not refresh it. Empty notes produce no context text. Read failures do not fail compaction. Snapshots are context-only, so later compactions do not repeatedly summarize injected snapshots. Use this as a last resort for essential private state that cannot be recovered from history, work stream results, or existing files—not progress logs, task lists, or duplicate evidence. Write/edit results acknowledge the change without echoing the note.
- **Sandbox:** Agents use a light/private sandbox; squad runners also access the retained shared squad workspace through `squad_bash`. User Assistant agents with the same owning user share their light sandbox, and subagents inherit their live root parent’s sandbox. The `ficus` CLI is available in both private and squad environments.
- **Template interpolation:** `interpolateTemplate()` resolves `{{agent.id}}`, `{{squad.id}}`, `{{squad.purpose}}`, `{{agent.typeName}}`, etc. in system prompts before they reach the SDK.
- **Streaming:** One `StreamBuffer` per execution, mapped to the agent ID via `registerSession`. The same buffer powers the SSE endpoint and WebSocket bridge.
- **Interventions:** `PendingInterventionQueue` drains at runner start and on `message.created`, claims durable pending-message rows, and calls Pi steer/follow-up according to `deliveryMode`. If the `app_events` nudge is missed, settlement makes bounded requeue attempts; exhausted rows remain pending until another message.
- **Control signals:** only `stop`, `abort-tool`, `compact`, `reset`, and `clear-queue` use authenticated HTTP `agent_control` and call into the active session.

## Per-Runner Details

### `system-manager`

Used by the **User Assistant**, an account-owned agent that operates outside any squad. Its internal agent type and runner ID remain `system-manager`. It can list, create, configure, and route between squads within the owning user’s permissions; there can be multiple Assistant conversations for a user.

- **Prompt context:** active, non-anonymous squads visible to the authenticated identity with `squads:read` (name, ID, manager, agent count, status, purpose). Without an identity, the prompt directs the agent to authenticated CLI discovery.
- **Sandbox:** all User Assistant agents owned by one user share the light sandbox and `/private` storage identified by `system_manager_<ownerUserId>`. Different owners resolve different sandboxes. `Agent.getSandboxId()` falls back to `agent_<agentId>` if the owning user is unset; host runtime still has no filesystem isolation.
- **Extra tools:** `navigate` (UI navigation), `set_agent_purpose`, web tools, short-term memory.
- **Notes:** `buildManagerPrompt()` is also called by the `ai-extract` route to reuse the system manager's grounding.

→ Source: `system-manager-runner.ts`

### `squad-manager`

Used by `manager` and `consultant` agents when they belong to a squad. Each retains its own agent-type prompt; consultants use this runner for squad context and planning tools. Manager orchestration guidance is documented in [`config/agent-types/manager.yaml`](../../config/agent-types/manager.yaml).

- **Prompt context:** squad agents (with `[MANAGER]` tag and statuses), all work streams (with assignee + deps), connected squads (`reports_to` / `collaborates` / `depends_on` and their inverses), active schedules.
- **Sandbox:** the agent’s own light/private sandbox plus the retained squad sandbox for shared project commands through `squad_bash`.
- **Memory:** if `squad.isMemoryEnabled`, injects memory system prompt + `map.md` contents and registers `memory_*` tools.
- **Extra tools:** `squad-todo` (orchestration checklist), `notify_contact`, `ask_human`, browser, web, short-term memory, plus the coding tool set (bash, read, write, edit, etc.) and `squad_bash`.
- **Workflow instructions:** the selected style owns participants, routing, and completion. Preset manager instructions are copied to the squad’s own `typeContext.manager` at creation; the runner never reads the preset. Consultants also receive purpose-setting guidance.

→ Source: `squad-manager-runner.ts`

### `squad-worker`

Used by squad agents routed here after the special runner cases (`architect`, `engineer`, `reviewer`, `general`, custom types). Each has a light/private sandbox and access to the same shared squad workspace as the manager through `squad_bash`; consultants route to `squad-manager`.

- **Prompt context:** teammate roster (excluding self), active schedules, agent purpose instructions.
- **Worker expertise:** comes from the agent type’s `systemPrompt`, squad-owned agent context, and active workflow instructions. Squad presets do not define worker instructions.
- **Memory:** same conditional memory injection as the squad manager.
- **Extra tools:** `set_agent_purpose`, `notify_contact`, `ask_human`, web, browser, short-term memory, coding tools, `squad_bash`, squad-todo.

> **Two bash tools (squad agents).** `bash` runs in the agent's own light private runtime. `squad_bash` runs in the retained warm squad box — the shared runtime that also hosts local deployments. Agents use `squad_bash` by default for every repository/project command (including inspection, git, dependencies, Docker/Compose, tests, diagnostics, servers, and deployments) so processes and tool state are reusable. Private `bash` is only for personal scratch, private temporary artifacts, or sensitive material that must not enter shared state/logs. Runtime paths are dynamically resolved; do not assume a literal workspace mount. The warm box cannot access another agent's private store.
>
> Completion-critical work stays in one foreground Bash invocation with a timeout up to 3,600 seconds. Detached/background processes and hand-launched tmux are unsupported across VM idle exit. Persistent apps use `ficus deploy local start` for Ficus-managed supervision; that supervision does not make arbitrary one-shot detached work durable.

→ Source: `squad-worker-runner.ts`

### External channel consultants

Channel conversations use `consultant` agents and the squad-manager runner. The
channel context enables `channel_respond`, `channel_send`, and `channel_edit` and
omits `ask_human`; clarification questions go back to the originating channel.
Incoming messages pass channel policy and sender authorization before an agent
is allocated. Consultants stay in their routed squad and use the manager for
cross-squad coordination. See [channels](channels.md).

### `subagent`

Used for ephemeral children dispatched by another agent. A child starts with fresh conversation state and narrow assignment instructions; it does not copy the parent's prompt, conversation, `Agent.context`, token, secrets, paths, or short-term memory.

- **Prompt context:** child role/platform rules first, workspace guidance derived from a versioned server snapshot second, explicitly non-overriding assignment context third, then parent communication. Its own recovery memory follows the shared compaction-snapshot behavior above. Task instructions remain a separate user message.
- **Sandbox:** intentionally shares the parent's light/private box. Squad-backed children also see the authorized shared squad workspace; no-squad children remain private-only.
- **Tools:** general environment tools are bounded first by what the parent runner actually exposed and then by the child type policy. When that intersection includes `squad_bash`, the child receives a child-attributed tool targeting the existing warm squad box. Child lifecycle tools remain separate.
- **Authority:** child tokens retain the child's agent ID for authorship, while RBAC follows the live root parent's role, agent-type scopes, grants, owning user, and squad boundary. Missing parents, cycles, and squad mismatches fail closed; parent plaintext tokens are never reused.

→ Source: `subagent-runner.ts`

### `artifact-builder`

Used by agents of type `artifact-builder-default` (constant in `agent-runners/constants.ts`). Generates artifacts (renderable outputs) on demand.

- **Prompt:** minimal — just the agent type's system prompt with `{{agent.id}}`-style placeholders interpolated and workspace guidance. Recovery memory follows the shared compaction-snapshot behavior above.
- **Workspace path:** per-agent storage path (`getAgentWorkspaceStoragePath(sandboxId)`).
- **Tools:** `createArtifactTools(...)` (write/manage artifacts), short-term memory, coding tools.
- **Tool policy:** like every runner, its available tools are centrally narrowed by the agent type's `toolsAllow` / `toolsDeny` in `buildBaseSessionOptions()`.

→ Source: `artifact-builder-runner.ts`

## Key Files

| File                                                              | Purpose                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/core/src/entities/agent-runners/base.ts`                    | `AgentRunner` template method + shared event handling   |
| `apps/core/src/entities/agent-runners/index.ts`                   | `createRunner()` factory                                |
| `apps/core/src/entities/agent-runners/system-manager-runner.ts`   | User Assistant runner                                   |
| `apps/core/src/entities/agent-runners/squad-manager-runner.ts`    | Squad manager runner                                    |
| `apps/core/src/entities/agent-runners/squad-worker-runner.ts`     | Squad worker runner                                     |
| `apps/core/src/entities/agent-runners/artifact-builder-runner.ts` | Artifact builder runner                                 |
| `apps/core/src/entities/agent-runners/subagent-runner.ts`         | Ephemeral subagent runner                               |
| `apps/core/src/entities/agent-runners/constants.ts`               | Agent-type → runner-type constants                      |
| `apps/core/src/entities/Agent.ts` (`get runnerType`)              | Runner resolution from agent type + squad               |
| `apps/core/src/services/worker/`                                  | Worker that polls executions and calls `createRunner`   |
| `apps/core/src/services/execution/session-state.ts`               | `registerSession` / `isSessionActive` / `removeSession` |

## Adding a New Runner

If you need a new execution context (e.g. a new platform-level agent kind):

1. Add the runner type to `AgentRunnerType` in `base.ts`.
2. Implement a subclass extending `AgentRunner` with `createSession()`, `buildPrompt()`, `onComplete()`.
3. Decide how it's selected: either a new dedicated `agentTypeId` (extend `Agent.runnerType`) or piggyback on existing types.
4. Wire it into the `createRunner` switch in `agent-runners/index.ts`.
5. If it has a constant agent-type ID, add it to `constants.ts`.
6. Add the YAML agent type under `config/agent-types/`.

Keep context-specific tool wiring, sandbox setup, and prompt building inside the subclass — the base class is intentionally agnostic.
