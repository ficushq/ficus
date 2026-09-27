# Ficus developer wiki

Ficus runs autonomous teams of AI agents ("squads") that work on goals together. Squads consist of a manager and worker agents that coordinate via **work streams** (units of deliverable work), exchange **inbox messages**, run on **schedules**, and integrate with external systems (GitHub, Linear, Discord, Slack). Humans monitor and intervene via a web UI, the `ficus` CLI, or chat.

This wiki orients contributors (human or agent) to the current system. Start here, then follow links into subsystem explanations and operating guides. The separate [user guides](../../apps/docs/README.md) explain how to use Ficus.

Keep current implementation guidance in `docs/wiki/`. One-off plans, designs, specifications and delivery tracking belong in history, including work still underway. Record unresolved proposals and acceptance gaps in the backlog, with source evidence and a check that would establish completion. Promote verified behavior into the wiki as code changes; historical checkboxes and test counts are not current acceptance evidence.

For setup, see [`docs/wiki/setup.md`](setup.md). For project conventions (Bun, monorepo layout, React Query, style), see [`AGENTS.md`](../../AGENTS.md).

## Monorepo Map

| Path                    | Purpose                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/core/`            | API server + background worker (Hono + Bun). DB schema, entities, services, tools, routes.                          |
| `apps/web/`             | Frontend (Vite + React + Tailwind + React Query).                                                                   |
| `apps/cli/`             | `ficus` CLI (Commander.js). Mirrors the REST API and is installed in sandboxes.                                     |
| `packages/shared/`      | Shared TypeScript types between core, web, cli.                                                                     |
| `packages/client-core/` | Transport-agnostic API client (resources, SSE/WS, query keys) shared by web + mobile.                               |
| `packages/k8s-sandbox/` | The sandbox server, used by both the `k8s` runtime (in pods) and the `vm` runtime (in boxes).                       |
| `config/`               | YAML configs synced into the DB on startup (agent types, squad presets, skills, channels, notifications, webhooks). |
| `apps/docs/`            | Curated user documentation site (Astro Starlight), separate from repository reference material.                     |
| `docs/wiki/`            | Maintained developer explanations and operating guidance (this directory).                                          |
| `docs/backlog/`         | Deferred work, proposals and unresolved acceptance questions.                                                       |
| `docs/history/`         | One-off plans, designs, specifications and delivery records.                                                        |
| `scripts/`              | Build, test, and operational scripts.                                                                               |
| `external/`             | External vendor code and references.                                                                                |
| `docker/`, `k8s/`       | Deployment manifests.                                                                                               |

## Core Primitives

Three primitives define the system. Understand these first.

### 1. Agents and Executions

An **agent** is a persistent instance of an agent type. It owns a conversation (messages) and an on-disk Pi SDK session. An **execution** is a transient wake-up cycle — one unit of work the worker picks up, runs, and finalizes.

| Primitive | Stored statuses                                                                                             | Interpretation                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent     | `idle`, `active`, `waiting-input`, `compacting`, `resetting`, `dormant`, `terminated`                       | The first five are live. A dormant agent remains addressable so eligible correspondence can wake it; a terminated agent is not addressable. |
| Execution | `queued`, `waiting-maintenance`, `waiting-sandbox`, `running`, `stopping`, `stopped`, `completed`, `failed` | Waiting states retain work for later pickup; stopped, completed and failed are terminal execution outcomes.                                 |

The canonical inventory and live/addressable predicates are in [shared types](../../packages/shared/src/types.ts). Worker pickup claims executions atomically. Steer/follow-up use durable pending interventions plus an `app_events` nudge; authenticated HTTP `agent_control` carries only stop, abort-tool, compact, reset, and clear-queue hints.

→ Deep dive: [`agents-and-executions.md`](agents-and-executions.md)

### 2. Squads

A **squad** is a team of agents working toward a shared purpose. Squads have:

- a **type** (currently `engineering`, defined in `config/squad-presets/`)
- **default agents** (persistent, e.g. the manager) and **flex agents** (spawned per work stream)
- **relationships** with other squads: `reports_to`, `collaborates`, `depends_on`
- **metadata** that routes external events (GitHub repos/labels, Linear teams)

**Squad presets and agent types** are YAML files in `config/`, synced to the
database on startup:

- **Squad presets**: `config/squad-presets/*.yaml` — squad templates with default agents, instructions, and schedules
- **Agent types**: `config/agent-types/*.yaml` — system prompts, model selection, and tool permissions

→ User-facing overview: [`cli/squad-system-overview.md`](cli/squad-system-overview.md)
→ CLI reference: [`cli/squad-commands.md`](cli/squad-commands.md)

### 3. Work Streams

A **work stream** is one deliverable. Its selected workflow controls the flow steps and participants; legacy streams without a flow use assignment-based orchestration. Keep design, implementation and review phases on the same deliverable rather than creating a new stream for each phase.

Stored status is `queued | active | done | canceled`. An `active` stream holds a squad concurrency slot; `queued` and terminal streams do not. Dependency, question, review and manual waits are separate typed records. Display states such as blocked or in review are derived from those waits, not additional stored lifecycle statuses. Legacy status spellings are compatibility inputs, not the current data model.

Work streams have instance-wide [numeric references](work-streams.md) for public labels, links, and lookups.

Work streams carry bound agents (`agentIds`), dependencies (`dependsOn`), files, typed waits, flow state and metadata such as PR information, GitHub issue IDs and branch/worktree paths. See [shared work-stream types](../../packages/shared/src/types.ts) and the [status/delivery presentation contract](work-stream-status-presentation.md) when changing lifecycle or UI state.

→ CLI reference: [`cli/workstream-commands.md`](cli/workstream-commands.md)
→ Recovery behavior: [`agents-and-executions.md#work-stream-continuation-recovery`](agents-and-executions.md#work-stream-continuation-recovery)

## Mental Model: How Work Gets Done

```text
User request through the Assistant or a squad conversation
    ↓
Consultant or manager creates a work stream with an explicit workflow
    ↓
The flow starts the participants needed for the active step
    ↓
Work, questions, and any required reviews follow the selected flow
    ↓
The flow's completion policy verifies the result and marks the stream done
```

Key invariants:

- **One deliverable per work stream.** Design, implementation and review can be phases of the same stream.
- **The selected workflow defines the process.** Solo uses one worker; reviewed styles add the participants and gates their definitions require. Engineering's PR-merge policy is not a universal requirement for every deliverable.
- **The manager owns ongoing coordination.** A consultant can start work and hand ownership to the squad manager while keeping the user conversation separate.
- **Flow participants are created lazily.** Do not pre-spawn future-step agents or mix legacy assignment/completion flags into flow creation.

See [Workflows, flows, and squads](workflows.md) and the shipped definitions in `config/workflows/`. Legacy streams without a flow still use assignment-based orchestration and squad-preset workflow instructions; those instructions do not override an explicit workflow.

## Agent Runners

Six concrete runners under `apps/core/src/entities/agent-runners/` extend the base `AgentRunner` lifecycle (session creation, event subscription, prompt dispatch, turn hooks):

| Runner             | Used by                                                 |
| ------------------ | ------------------------------------------------------- |
| `system-manager`   | User Assistant (user-scoped cross-squad operations)     |
| `squad-manager`    | Per-squad manager and consultant                        |
| `squad-worker`     | Per-squad workers (architect, engineer, reviewer, etc.) |
| `artifact-builder` | Artifact generation runs                                |
| `subagent`         | Ephemeral delegated child work                          |

Each subclass handles its context-specific setup, prompt building, and completion. Shared infrastructure (streaming buffer, session state, turn hooks, skill materialization) lives in `apps/core/src/services/`.

→ Deep dive: [`agent-runners.md`](agent-runners.md)

## Configuration as Code

YAML files in `config/` define the available building blocks and are synced into the DB by `services/config-sync/` on startup.

| Directory                    | What it defines                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `config/agent-types/`        | Agent type templates: system prompt, tools, model, skills, extensions                            |
| `config/agent-types/shared/` | Shared prompt fragments (e.g. `rules`) included by `includes:` in agent types                    |
| `config/squad-presets/`      | Squad preset templates: manager context, workflow recommendations, initial members and schedules |
| `config/skills/`             | Reusable skill bundles (`SKILL.md` + support files) materialized into sandboxes                  |
| `config/channels/`           | Channel provider templates (Discord, Slack, Telegram)                                            |
| `config/notifications/`      | Notification routing templates                                                                   |
| `config/webhooks/`           | Inbound webhook handlers (GitHub, Linear)                                                        |

Template-based entries can be customized in the UI but not deleted — only disabled.

## Where to Look Next

### By concern

| If you're working on...                                   | Read                                                                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installing ficus on this machine                          | [Local setup](setup.md#local-setup)                                                                                                                                   |
| Developing ficus itself (scripts, tests, k3d, signing)    | [`development.md`](development.md)                                                                                                                                    |
| `.env`, environment variables, API auth                   | [`configuration.md`](configuration.md)                                                                                                                                |
| Agent execution, the worker loop                          | [`agents-and-executions.md`](agents-and-executions.md)                                                                                                                |
| Squad/work stream concepts and CLI                        | [`cli/squad-system-overview.md`](cli/squad-system-overview.md), [CLI index](cli/README.md), [workflows](workflows.md)                                                 |
| Database schema or migrations                             | [`database.md`](database.md)                                                                                                                                          |
| Cross-process events, WebSocket bridge                    | [`event-emitter.md`](event-emitter.md)                                                                                                                                |
| External chat integrations (Discord etc.)                 | [`channels.md`](channels.md)                                                                                                                                          |
| Inbound webhooks (GitHub, Linear)                         | [`webhooks.md`](webhooks.md)                                                                                                                                          |
| Cross-instance agent messaging (AMTP/federation)          | [`amtp.md`](amtp.md)                                                                                                                                                  |
| AMTP wire protocol (normative spec + vectors)             | [docs/SPEC.md in ficushq/amtp](https://github.com/ficushq/amtp/blob/main/docs/SPEC.md)                                                                                |
| Federating any agent with the standalone `amtp` node      | [quickstart](https://github.com/ficushq/amtp/blob/main/docs/quickstart.md), [SKILL.md](https://github.com/ficushq/amtp/blob/main/node/SKILL.md)                       |
| Outbound notifications (push, email)                      | [`notifications.md`](notifications.md), [`outbound-notifications.md`](outbound-notifications.md)                                                                      |
| Memory system (Obsidian-style vault)                      | [`memory/README.md`](memory/README.md)                                                                                                                                |
| Choosing / configuring a sandbox runtime                  | [`sandbox-runtimes.md`](sandbox-runtimes.md), [`hosting.md`](hosting.md)                                                                                              |
| Running agents on the host (no sandbox), browser          | [`host-runtime.md`](host-runtime.md)                                                                                                                                  |
| Sandbox runtime internals                                 | [VM runtime](machines/runtime.md), [Kubernetes architecture](k8s/architecture.md), [`sandbox-watcher.md`](sandbox-watcher.md), [`docker-images.md`](docker-images.md) |
| VM/browser invariants, maintenance and update safety      | [Runtime contracts](runtime-contracts.md)                                                                                                                             |
| Authorization, identity and integration trust boundaries  | [Security boundaries](security-boundaries.md)                                                                                                                         |
| Integration delivery, federation and hosted app transport | [Integration contracts](integration-contracts.md)                                                                                                                     |
| Secrets and provider auth                                 | [`secret-store.md`](secret-store.md), [`provider-auth.md`](provider-auth.md), [`core-auth.md`](core-auth.md)                                                          |
| Config sync from YAML → DB                                | [`config-sync.md`](config-sync.md)                                                                                                                                    |
| Voice features                                            | [`voice-assistants.md`](voice-assistants.md)                                                                                                                          |
| Assistant tasks, updates, and catch-up                    | [`assistant-tasks.md`](assistant-tasks.md)                                                                                                                            |
| Action Center UI                                          | [`action-center.md`](action-center.md)                                                                                                                                |
| Tool rendering in the UI                                  | [`tool-renderers.md`](tool-renderers.md)                                                                                                                              |
| Settings UI                                               | [`settings-ui.md`](settings-ui.md)                                                                                                                                    |
| In-app Consultant (human-facing squad interface)          | [`consultant.md`](consultant.md)                                                                                                                                      |
| Mobile app (iOS) + device pairing                         | [`mobile-app.md`](mobile-app.md)                                                                                                                                      |
| App-store reviewer access on a demo instance              | [`demo-access.md`](demo-access.md)                                                                                                                                    |
| App deployments                                           | [`deployments.md`](deployments.md)                                                                                                                                    |
| CI/CD                                                     | [`ci-cd.md`](ci-cd.md)                                                                                                                                                |

### By collection

- [Web themes](theme/README.md) — built-in palettes, semantic colors, renderer integration, custom themes and account sync.

- [CLI](cli/README.md) — command reference for squads, work streams and other resources.
- [Memory](memory/README.md) — memory architecture, sync, files and agent threads.
- [Kubernetes architecture](k8s/architecture.md) and [deployment](k8s/deployment.md) — cluster runtime and operating guidance.
- Backlog — open questions and deferred work, including runtime, security and integration follow-ups.
- History — original plans, design decisions and delivery snapshots. Consult these for rationale after checking current wiki guidance and code.
- [Documentation map](../README.md) — collection policy and the boundary between repository material and curated user guides.

## Tech Stack at a Glance

- **Runtime:** Bun (no npm/yarn). Always use `bun` for install, test, build, scripts.
- **Backend:** Hono on Bun, Drizzle ORM, PostgreSQL (with `pgvector` for memory search).
- **Worker:** Same Bun process model, polls the `executions` table, drains durable interventions, and receives authenticated local-events control hints.
- **Agent execution:** Pi SDK (`@earendil-works/pi-coding-agent`), with file-based sessions under `<HOME_DIR>/sessions/<agentId>/`.
- **Frontend:** Vite + React + TanStack Query + Tailwind. Centralized query options in `queryOptions.ts`.
- **CLI:** Commander.js, distributed as a self-executable script.
- **Tests:** Bun's test runner, isolated Postgres-in-Docker per worktree (auto-allocated port, schema pushed before run).

See [`AGENTS.md`](../../AGENTS.md) for the full conventions list, including DB migration workflow, React Query patterns, `useStableRef`, and icon conventions.

## Glossary

- **Squad** — Team of agents with a shared purpose.
- **Squad preset** — Template (YAML) defining default agents and orchestration instructions.
- **Agent type** — Template (YAML) defining system prompt, tools, model, skills for an agent role.
- **Agent** — Persistent instance of an agent type. Owns a Pi SDK session.
- **Execution** — One wake-up cycle of an agent (one turn of work).
- **Work stream** — One deliverable assigned to a squad, progressed by its workflow flow or legacy assignment-based orchestration.
- **Default agent** — Persistent squad member (e.g. the manager). Protected from unspawn.
- **Flex agent** — Per-work-stream agent. Auto-cleaned when work stream completes.
- **Handoff** — Transfer of responsibility for work. Legacy streams use reassignment; flow streams follow their selected workflow's transition rules.
- **Steer** — Interrupt a running agent with a message (`ficus inbox send ... --steer`).
- **Follow-up** — Queue a message for after the current turn (`--follow-up`).
- **Inbox** — Per-agent message queue; also used for system notifications and human messages.
- **Skill** — Reusable agent guidance bundle materialized into the sandbox (`config/skills/`).
- **Worktree** — Per-work-stream git worktree, isolating branches so parallel work doesn't conflict.
- **Sandbox** — Where an agent's work executes: a Docker container, a K8s pod, a VM box, or (on the `host` runtime) the core's own machine. The ficus CLI is available inside. See [`sandbox-runtimes.md`](sandbox-runtimes.md).

## License

Ficus is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See the [LICENSE](../../LICENSE) file at the repo root.
