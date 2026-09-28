# Voice Assistants and Artifacts

Ficus supports multiple realtime voice assistants built on a shared OpenAI Realtime runtime. Voice assistants are mounted by code where they belong; users do not choose from a global assistant picker.

Voice is treated as a conversational router/operator. It is good at spoken interaction, short context gathering, choosing tools, and presenting results. It should not do complex long-running work directly. Durable visual work is routed to specialized artifact-builder agents.

## High-Level Architecture

```txt
Browser voice UI
  └─ useRealtimeVoiceAssistant(controller)
       ├─ RealtimeTransport over WebRTC
       ├─ assistant controller
       ├─ assistant tool registry
       └─ assistant-specific React state

Core artifact API
  └─ request_artifact / list / context
       ├─ artifact-builder agent lifecycle
       ├─ file-backed artifact workspace
       ├─ backend-owned manifest updates
       └─ builder inbox delivery

Artifact builder agent
  └─ writes files in artifacts/<artifact-id>/
       ├─ artifact_publish
       ├─ artifact_status
       └─ artifact_question
```

Important rule: the voice assistant routes and monitors; artifact builders build. In user-facing speech, the workspace voice assistant should still speak as Ficus — one capable workspace platform — rather than exposing artifact builders, squads, inboxes, or tool routing unless the user asks how the system works.

## Realtime Voice Runtime

The reusable runtime lives in:

```txt
apps/web/src/voice/useRealtimeVoiceAssistant.ts
apps/web/src/voice/realtimeTransport.ts
apps/web/src/voice/types.ts
```

`useRealtimeVoiceAssistant(controller)` owns shared session mechanics:

- WebRTC connection through `RealtimeTransport`
- microphone enable/disable and user mute state
- transcript history
- voice status state
- output interruption and reconnect cleanup
- rate-limit retry handling
- OpenAI Realtime event handling
- function-call dedupe and tool result sending
- local microphone input-level metering for UI intensity

The runtime does not know about squads, routes, inboxes, artifacts, or canvases. Those live in assistant controllers and tools.

### Voice statuses

`VoiceStatus` currently supports:

- `idle` — not connected
- `connecting` — preparing session/WebRTC
- `listening` — mic is on and waiting for user speech
- `user-speaking` — server VAD detected active user speech
- `processing` — model/tool work is active
- `speaking` — assistant output audio is playing
- `error` — unrecoverable or currently visible error

The split between `listening` and `user-speaking` lets the UI distinguish “hot mic waiting” from “actively hearing the user.”

### Runtime return shape

```ts
interface UseRealtimeVoiceAssistantReturn<TState> {
  status: VoiceStatus
  history: VoiceTranscriptEntry[]
  error: string | null
  state: TState
  connect(): Promise<void>
  disconnect(): void
  restartFresh(): Promise<void>
  interrupt(): void
  toggle(): void
  toggleMicMuted(): void
  submitUserSpeech(): void
  isConnected: boolean
  isMicMuted: boolean
  inputLevel: number
  rateLimitRetry: VoiceRateLimitRetryStatus | null
}
```

`inputLevel` is computed from the existing microphone stream with a Web Audio `AnalyserNode`. Do not call `getUserMedia` a second time just for visualization.

### Mic and interruption behavior

- During assistant speech, Ficus disables the mic so the speaker does not feed back into the realtime session.
- The workspace orb supports click-to-barge-in while `speaking`: it cancels output, stops playback, re-enables the mic, and returns to `listening`.
- During `listening`, clicking the orb toggles user mic pause/resume.
- During `user-speaking`, clicking the orb commits the current input audio buffer and requests a response immediately.

The mic enabled state composes system and user control. System output can temporarily disable the mic, but it should not override a user's paused mic preference.

## Assistant Controllers

Controllers implement assistant-specific behavior:

```ts
interface VoiceAssistantController<TState, TEnv> {
  id: string
  initialState: TState | (() => TState)
  useEnvironment(): TEnv
  prepareSession(args: { env: TEnv; signal: AbortSignal }): Promise<PreparedVoiceAssistantSession<TState>>
  executeTool(args: {
    name: string
    toolArgs: Record<string, unknown>
    env: TEnv
    runtime: VoiceAssistantRuntime<TState>
  }): Promise<VoiceAssistantToolExecutionResult>
  summarizeToolCall?(name: string, args: Record<string, unknown>): string
  onConnected?(runtime: VoiceAssistantRuntime<TState>, env: TEnv): void
  onDisconnected?(env: TEnv): void
  onServerEvent?(event: RealtimeServerEvent, runtime: VoiceAssistantRuntime<TState>, env: TEnv): void
  onOutputAudioStopped?(runtime: VoiceAssistantRuntime<TState>, env: TEnv): void
  onInterrupt?(runtime: VoiceAssistantRuntime<TState>, env: TEnv): void
  useEffects?(runtime: VoiceAssistantRuntime<TState>, env: TEnv, status: VoiceStatus): void
}
```

`useEnvironment()` is where controllers read React/router/websocket dependencies. `prepareSession()` builds OpenAI Realtime session config. `executeTool()` delegates function calls to the assistant's tool registry.

`useEffects()` may call React hooks, but the generic runtime captures the first `useEffects` function to preserve hook order. If a component needs to switch controllers, remount the hook, for example with `key={controller.id}`.

Controllers receive capability-based runtime methods:

```ts
interface VoiceAssistantRuntime<TState> {
  getState(): TState
  setState(state: TState | ((current: TState) => TState)): void
  updateInstructions(instructions: string): void
  sendUserText(text: string): void
  requestResponse(): void
  setMicEnabled(enabled: boolean): void
  isResponseActive(): boolean
  markResponseActive(active: boolean): void
}
```

Use these methods instead of reaching into `RealtimeTransport` or React state directly.

## Existing Assistants

### Site operator assistant

Files:

```txt
apps/web/src/voice/assistants/siteOperator/
  siteOperatorAssistant.ts
  siteOperatorInstructions.ts
  siteOperatorTools.ts
  siteOperatorTypes.ts
```

Used by the unified app-wide Assistant (`UnifiedAssistant.tsx`, `AssistantCommandCenter.tsx`, and `AssistantConversationView.tsx`), opened from navigation or Cmd/Ctrl+K. The site operator uses shared text/live-voice conversation history; it is not a separate voice-only entrypoint.

Purpose:

- general text and spoken interaction with the Ficus web UI
- search and navigate pages, squads, work and conversations
- inspect work and route messages to the relevant manager
- delegate deeper tasks as background tasks on helpers the conversation owns — a general system-manager helper for instance-wide and personal work, plus one consultant per squad (named “Assistant task”) for squad-owned work — and receive their updates in the active conversation
- read and message normal agent threads
- read inbox updates
- answer status questions
- announce new human inbox messages

The site operator has router, visible-agent, chat-drawer, and inbox dependencies. These stay inside the site operator controller; they are not part of the generic runtime.

### Workspace assistant

Files:

```txt
apps/web/src/voice/assistants/workspace/
  workspaceAssistant.ts
  workspaceInstructions.ts
  workspaceTools.ts
  workspaceTypes.ts
```

Mounted by `VoiceWorkspacePage` at `/voice`.

Purpose:

- immersive full-screen voice workspace
- present Ficus as one cohesive system while internal agents/tools do the implementation work
- request, continue, list, archive, delete, and display persistent artifacts
- choose displayed artifact: latest updated artifact or a specific older artifact
- ask artifact-builder questions aloud and route answers back through artifact continue requests
- manage lightweight session-local canvases/apps for quick non-durable placeholders

The workspace assistant intentionally has no site route/page/chat-drawer dependencies. When it delegates artifact or squad work, it should frame that as “I’m working on it” / “I’ll let you know when it’s ready,” not “I asked an artifact builder,” unless the user explicitly asks about internals.

## Voice Tool Library

Reusable voice tools live under:

```txt
apps/web/src/voice/tools/
  types.ts
  registry.ts
  agentMessagingTools.ts
  statusTools.ts
  navigationTool.ts
  chatDrawerTool.ts
  inboxTools.ts
  threadTools.ts
  agentControlTools.ts
  artifactTools.ts
  canvasTools.ts
```

Each tool is a `VoiceAssistantTool`:

```ts
interface VoiceAssistantTool<TEnv = unknown> {
  definition: RealtimeFunctionTool
  execute(args: Record<string, unknown>, env: TEnv): Promise<unknown>
  summarizeCall?(args: Record<string, unknown>): string
  followUp?: 'auto' | 'never' | boolean | ((result: unknown) => boolean)
}
```

Assistants compose only the tools they need. For example, the site operator includes navigation and chat drawer tools; the workspace assistant does not.

### Workspace artifact tools

- `list_artifacts` — discover non-archived artifact manifests from artifact-builder agents, with optional archived/query filters.
- `get_artifact_context` — fetch manifest and latest published entry content for display.
- `request_artifact` — voice-only create/continue/archive/delete API. `fork` is reserved and currently returns not implemented.
- `display_artifact` — set `/voice` to a specific artifact by `{ agentId, artifactId }`.
- `display_latest_artifact` — return `/voice` display selection to latest updated artifact.

`request_artifact` is the only supported path for artifact creation and iteration from voice. Do not use `message_agent` for artifact builders.

A successful `request_artifact` call means the request was recorded and queued/delivered. It does not prove that the builder has finished or published the final artifact.

## Artifact System

Artifact builder agents are specialized, visible, non-squad agents. They use:

- `agentTypeId: artifact-builder-default`
- `metadata.specialRole: 'artifact-builder'`

They work in their own agent workspace, under:

```txt
artifacts/<artifact-id>/
  manifest.json
  presentation.json | document.md | app.html | other support files
```

The artifact source of truth is workspace files, not a DB artifact table. Backend services scan artifact-builder workspaces and read manifests when listing artifacts.

### Manifest ownership

`manifest.json` is backend-owned. Artifact builders should not edit it directly. Backend operations create, normalize, and update it through:

- `request_artifact`
- `artifact_publish`
- `artifact_status`
- `artifact_question`
- archive/delete helpers

The manifest records:

- stable artifact ID
- title and summary
- status (`working`, `ready`, `error`)
- published entry
- request history
- artifact questions and answers
- created/updated timestamps
- archived flag

### Published entry types

The published `manifest.entry` chooses what the UI renders:

- `presentation` — structured dashboards/explanations rendered by the web app. Supports markdown, metrics, tables, callouts, timelines, Vega-Lite charts, and sandboxed HTML blocks. Prefer native blocks first; presentation HTML blocks auto-size in `/voice` and support optional `height`, `minHeight`, and `maxHeight` metadata for fixed/clamped widgets. HTML blocks may include `iframeAccessibilityTitle` for the sandboxed iframe title; visible card text must live inside `content`.
- `markdown` — sanitized Markdown rendering.
- `html` — static HTML rendered in a sandboxed iframe with scripts allowed but no same-origin privileges.
- `sandbox_app` — reserved in shared schemas, but publish/runtime support is not implemented.

Artifact builders may change entry type on any successful `artifact_publish`. For example, a backend-created presentation skeleton can later be replaced with `html` or `markdown` if that better fits the artifact.

`artifact_publish` validates the referenced file before changing the manifest. Failed publishes leave the last valid user-facing entry in place.

## Artifact Creation Flow

1. Workspace voice calls `request_artifact({ action: 'create', title, brief, ... })`.
2. Core claims a warm artifact-builder if available, otherwise creates one.
3. Core creates `artifacts/<artifact-id>/manifest.json`.
4. Core writes and publishes a minimal valid `presentation.json` skeleton immediately.
5. Core emits artifact update events so `/voice` can render right away.
6. Core sends one inbox message to the artifact builder with the artifact path, request brief, and note that a starter skeleton is already visible.
7. The artifact builder replaces/refines content and calls `artifact_publish` incrementally.
8. Each publish updates the manifest and emits an artifact update so the UI refreshes.

Skeletons are intentionally neutral and polished. They should not contain progress-update prose like “I am working on this.” They provide immediate visual structure while the builder works.

## Artifact Continue and Question Flow

### Continue requests

When the user asks to change or extend an existing artifact, workspace voice should call:

```ts
request_artifact({
  action: 'continue',
  agentId,
  artifactId,
  brief,
  answers?,
})
```

Continue requests append request history, mark previously ready artifacts back to `working`, emit updates, and send one inbox message to the owning artifact builder. The message is intentionally lightweight; the builder already has chat context and can inspect artifact files when useful.

### Builder questions

Artifact builders ask clarifying questions with `artifact_question`.

The tool:

1. validates the artifact belongs to the builder,
2. appends a question batch to the manifest,
3. sends one human inbox notification with structured metadata,
4. emits artifact/agent updates.

Active workspace voice sessions listen for these notifications, ask the question(s) aloud, and route answers back through `request_artifact({ action: 'continue', answers: [...] })`.

Answers are only valid on `continue` requests. The manifest keeps an audit trail of questions, answers, corrections, and the corresponding continue requests.

## Workspace Artifact Display

`/voice` is an immersive stage with no normal app shell/header/footer/nav/chat drawer. It renders the active artifact full-screen and overlays only the minimal voice orb/error UI.

Display selection lives in workspace voice state:

```ts
type WorkspaceArtifactDisplay = { mode: 'latest' } | { mode: 'specific'; agentId: string; artifactId: string }
```

Default mode is `latest`, choosing the non-archived artifact with greatest `updatedAt`. Voice can switch to a specific older artifact with `display_artifact`, and return to latest with `display_latest_artifact`.

Artifact freshness uses both websocket invalidation and polling:

- `artifact_publish` / request mutations emit `agent.updated`
- web websocket invalidation refreshes artifact queries
- `/voice` also polls artifact list/context every 5 seconds as a fallback

## Artifact Rendering Safety

Rendering components:

```txt
apps/web/src/components/artifacts/ArtifactRenderer.tsx
apps/web/src/components/artifacts/PresentationRenderer.tsx
```

Safety behavior:

- Markdown is rendered through the shared renderer path and should not execute arbitrary scripts.
- HTML entries and presentation HTML blocks render in sandboxed iframes.
- Iframes allow scripts but not same-origin privileges.
- Presentation HTML blocks report content height through a narrow `postMessage` bridge so the parent can auto-size the iframe; fixed `height` metadata disables auto-sizing, while `minHeight`/`maxHeight` clamp it.
- Network access is not restricted by iframe CSP, but remote CORS may still block requests from `Origin: null`.
- Presentation artifacts in `/voice` use `presentationChrome="none"` so the artifact appears as the full-screen stage without extra title/section card chrome.

## Artifact Builder Agent Prompt

Default config:

```txt
config/agent-types/artifact-builder-default.yaml
```

Key behavior:

- work only inside the assigned artifact folder
- do not edit `manifest.json`
- prefer `presentation.json` for dashboards/reports/visual summaries
- prefer native presentation blocks; use explicit `{ type: "html", content }` presentation blocks only for custom visual layout that native blocks cannot express
- use optional HTML sizing metadata only for intentionally fixed-size or clamped widgets
- publish an initial valid version quickly
- use placeholders/loading states for unfinished sections
- continue republishing incremental improvements
- avoid progress-update sentences inside artifact content
- use `artifact_question` when required information is missing

Available builder tools include:

- `read`, `write`, `edit`, `bash`
- `artifact_publish`
- `artifact_status`
- `artifact_question`

## Prewarm Behavior

Core keeps one warm artifact-builder sandbox available for fast first artifact creation. Prewarm behavior:

- `/api/artifacts/prewarm` creates or reuses a warm artifact-builder agent.
- A warm builder has `metadata.prewarm: true` and `context.artifactBuilderPrewarm.claimedAt: null`.
- Creation claims an available warm builder by setting `claimedAt` and renaming/updating context.
- After a create request, core starts prewarming the next builder in the background.
- Prewarm is non-blocking; it should not delay user-facing request responses.

## Important Files

Core:

```txt
apps/core/src/services/artifacts/artifactWorkspace.ts
apps/core/src/services/artifacts/artifactPublish.ts
apps/core/src/services/artifacts/artifactIndex.ts
apps/core/src/services/artifacts/artifactVoiceRequests.ts
apps/core/src/tools/artifacts.ts
apps/core/src/routes/artifacts.ts
apps/core/src/entities/agent-runners/artifact-builder-runner.ts
config/agent-types/artifact-builder-default.yaml
packages/shared/src/artifacts/manifestSchema.ts
packages/shared/src/artifacts/presentationSchema.ts
```

Web:

```txt
apps/web/src/api/artifacts.ts
apps/web/src/components/VoiceWorkspacePage.tsx
apps/web/src/components/artifacts/ArtifactRenderer.tsx
apps/web/src/components/artifacts/PresentationRenderer.tsx
apps/web/src/voice/useRealtimeVoiceAssistant.ts
apps/web/src/voice/realtimeTransport.ts
apps/web/src/voice/assistants/workspace/workspaceAssistant.ts
apps/web/src/voice/assistants/workspace/workspaceInstructions.ts
apps/web/src/voice/assistants/workspace/workspaceTools.ts
apps/web/src/voice/tools/artifactTools.ts
```

## Testing

Common focused verification:

```bash
bun test apps/web/src/voice
bun test apps/web/src/components/VoiceWorkspacePage.test.tsx
bun test apps/core/src/services/artifacts
bun test apps/core/src/tools/artifacts.test.ts
bun test packages/shared/src/artifacts
bun typecheck
bun run build
```

Important coverage:

- voice runtime status transitions and mic state
- realtime transport input buffer commit and input-level calculation
- workspace orb states and artifact display selection
- assistant tool registries and instructions
- artifact create skeleton publication
- artifact continue/archive/delete mutations
- artifact prewarm/claim flow
- artifact publish validation and manifest updates
- artifact question/answer manifest audit trail
- artifact renderer safety behavior

## Design Notes

- Voice remains non-DB and non-durable except for the artifacts/requests it routes through backend APIs.
- Artifact builders are persisted agents for observability, but artifacts are file-backed.
- Backend owns manifest updates; builders own content files.
- Artifact iteration and question answers go through `request_artifact(continue)`, not `message_agent`.
- Artifact request success is request receipt, not builder completion.
- Durable visual outputs should use persistent artifacts; session-local canvases are convenience only.
- Keep spoken responses short and action-oriented.

## Assistants embedded in editors

`PageEditorAssistant` embeds the existing durable conversation UI in a page. It accepts a typed draft envelope and reports validated proposals to the host page. Realtime text and voice share the conversation; when Realtime is not configured, typed messages use a lazily created user assistant. The user can also select that fallback explicitly when a Realtime connection is unavailable. The host supplies its page kind's title, help copy, and model-facing `instructions`/`tools` as props (`assistantEditorInstructionsByKind[kind]` / `assistantEditorToolDefinitionsByKind[kind]` from `@ficus/shared`), so `PageEditorAssistant` itself stays kind-agnostic.

The page does not send executable callbacks to the agent runner. The shared `assistant-editors` contract describes two tools, `read` and `edit`. Both the Realtime adapter (via the page's bridge) and the system-manager runner (`createPageEditorTools`) call the same server service, bound to the conversation and never exposed to the model directly. Each editor kind supplies authorization, document validation, a model-facing contract string, and how it turns a proposal's `operations` into a candidate document (`adapters[kind].applyOperations`) in `apps/core/src/services/assistant-editors/index.ts`. Workflows (`kind: 'workflow'`) and themes (`kind: 'theme'`) are the two adapters today; the sync/proposal envelope is a discriminated union on `kind` (`assistantEditorSyncSchema` in `packages/shared/src/assistant-editors.ts`), and each kind's own operation set (`workflowCustomizationSchema`, `themeOperationSchema`) merges into one wider operations union so the same `edit` tool and HTTP route serve every kind without per-kind routes.

Adding another page kind needs: a sync-schema branch (its own `target`/`document`/`selection` shape, discriminated on `kind`) and an operation set (ideally a pure `applyXOperations(doc, ops)` function, mirroring `applyWorkflowCustomizations`/`applyThemeOperations`) in `packages/shared`; a server adapter (`authorize`, `validate`, `contract`, `applyOperations`) in `apps/core/src/services/assistant-editors/index.ts`; per-kind instructions and tool definitions (added to `assistantEditorInstructionsByKind`/`assistantEditorToolDefinitionsByKind`, and selected in `SystemManagerRunner` by `conversation.editor.kind`); and a web host that renders `PageEditorAssistant` with that kind's `draft`/`onProposal`/`title`/`subtitle`/`conversationTitle`/`instructions`/`tools`.

Drafts are attached to an owned Assistant conversation, bound to an immutable target. The backend runner is bound to that exact conversation ID and has only the two editor tools, without shell, dispatch, navigation, or catalog mutation tools. Every call checks the owner's current `chat:send`, plus whatever else that kind's adapter requires (workflows additionally check the target workflow's create/update permission; themes are personal, so `chat:send` is the whole gate). Another agent owned by the same user cannot access the draft. Page presence renews a five-minute lease; closing the page closes the capability, and an offline page eventually expires it.

The page synchronizes a monotonically increasing draft revision before sending a request or executing a Realtime tool. Proposals name the revision they read; stale proposals are rejected. A proposal never changes a saved document/preset directly — it is validated (kind-specific: `workflowDefinitionSchema` / `validateThemePresetDocument`) and staged, then the open page applies it. **There is no Apply button**: a valid proposal applies automatically to the open draft as soon as the page picks it up, and repaints/rechecks the same way a manual edit would. Manual edits, applied proposals, and undo/redo all advance the revision and share one undo/redo history — an `edit` call with `historyAction: 'undo'`/`'redo'` uses the exact same history as the page's own Undo/Redo buttons. Publication (Save) is a separate, explicit user action through the normal resource API and its permission and revision checks; the assistant cannot save or publish on its own.

Brainstorming is ordinary conversation. The assistant must not treat a discussion as a request to edit. It can explain alternatives and then propose changes when asked. Realtime can delegate a larger design to the underlying user assistant, which uses the same tools and returns proposals to the same page. Saved conversation entries remain available after closing, but they do not reopen or replay the editor's capability.
