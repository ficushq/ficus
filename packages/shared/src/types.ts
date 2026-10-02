export * from './grants'
// Schema field definition for task type schemas
export interface SchemaFieldDef {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
}

export type TaskTypeSchema = Record<string, SchemaFieldDef>

// Image content for chat messages (matches Pi SDK format)
export interface ImageContent {
  type: 'image'
  data: string // base64-encoded image data
  mimeType: string // image/png, image/jpeg, image/gif, image/webp
}

// Question types for ask_human tool
export type QuestionType = 'text' | 'select' | 'multi-select'

export interface QuestionOption {
  value: string
  label?: string
}

export interface QuestionItem {
  id: string
  type: QuestionType
  question: string
  /**
   * Background the human needs to answer without the agent's conversation: what the agent is
   * working on, what it found, and what each answer would lead to. Questions are usually answered
   * out of band (Feed, notifications, phone).
   */
  context?: string
  /** Choices for select/multi-select; suggestions the human can pick and edit for text. */
  options?: QuestionOption[]
  default?: string | string[]
  optional?: boolean
}

export interface QuestionData {
  questions: QuestionItem[]
}

// Task statuses
export type TaskStatus = 'pending' | 'in-progress' | 'blocked' | 'review' | 'completed' | 'failed'

// Chat scope types
export type ChatScopeType =
  | 'system-manager'
  | 'task'
  | 'squad-manager'
  | 'squad-worker'
  | 'consultant'
  | 'artifact-builder'

// Message roles
export type MessageRole = 'human' | 'assistant'

// Agent instance statuses (unified). This tuple is the one canonical inventory.
export const AGENT_STATUSES = [
  'idle',
  'active',
  'waiting-input',
  'compacting',
  'resetting',
  'dormant',
  'terminated',
] as const

export type AgentStatus = (typeof AGENT_STATUSES)[number]

type AgentLifecycleClassification = { live: boolean; addressable: boolean }

const AGENT_LIFECYCLE_CLASSIFICATION = {
  idle: { live: true, addressable: true },
  active: { live: true, addressable: true },
  'waiting-input': { live: true, addressable: true },
  compacting: { live: true, addressable: true },
  resetting: { live: true, addressable: true },
  dormant: { live: false, addressable: true },
  terminated: { live: false, addressable: false },
} as const satisfies Record<AgentStatus, AgentLifecycleClassification>

export const LIVE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set(
  AGENT_STATUSES.filter((status) => AGENT_LIFECYCLE_CLASSIFICATION[status].live)
)

/** Status is the sole source of truth for whether an agent may execute work. */
export function isLiveAgentStatus(status: AgentStatus): boolean {
  return AGENT_LIFECYCLE_CLASSIFICATION[status].live
}

export const ADDRESSABLE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set(
  AGENT_STATUSES.filter((status) => AGENT_LIFECYCLE_CLASSIFICATION[status].addressable)
)

/** Dormant agents remain addressable so eligible correspondence can wake them. */
export function isAddressableAgentStatus(status: AgentStatus): boolean {
  return AGENT_LIFECYCLE_CLASSIFICATION[status].addressable
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

// Execution statuses (unified)
export type ExecutionStatus =
  | 'queued'
  | 'waiting-maintenance'
  | 'waiting-sandbox'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed'

// Message metadata (tool calls captured from Pi SDK)
export interface MessageToolCall {
  toolCallId: string
  toolName: string
  args: string
  result: string
  isError: boolean
}

// Ordered content block types for interleaved thinking/tool calls/text
export type ContentBlock =
  | { type: 'thinking'; id: string; content: string; durationMs?: number }
  | { type: 'text'; id: string; content: string }
  | { type: 'tool_use'; id: string; toolCall: MessageToolCall }

export type DeliveryMode = 'steer' | 'follow-up'

export type MonitorMessageKind = 'lines' | 'exited' | 'canceled' | 'timed-out' | 'overload' | 'failed'

export interface MessageMetadata {
  /** Original task updates consumed in this exact response group. */
  assistantUpdateIds?: string[]
  assistantTaskIds?: string[]
  /** Append-only delegated conversation context; never direct human authorization. */
  assistantContext?: string
  /** Client-provided navigation context, separate from visible message content. */
  pagePath?: string
  /** Server-owned direct-chat provenance; request bodies must not set these fields. */
  executionId?: string
  externalExport?: 'disabled' | 'enabled'
  content?: ContentBlock[]
  imageIds?: string[] // Array of image UUIDs attached to the message
  deliveryMode?: DeliveryMode // How the message was delivered (steer or follow-up)
  /** Explicitly permits this delivery to wake a dormant agent. */
  wakeEligible?: boolean
  // The human user who sent this message (web chat / CLI). Surfaced to the agent so it knows who it's
  // talking to in a shared multi-user setting.
  sender?: { userId: string; name: string }
  source?: 'inbox' | 'monitor' | string
  sandboxId?: string
  recoveryEpisodeId?: string
  recoveryNotificationKind?: 'recovered' | 'still_unavailable'
  monitor?: {
    id: string
    label: string
    kind: MonitorMessageKind
    lineCount?: number
    exitCode?: number | null
    failureKind?: string | null
  }
  /** Stable key used to deduplicate a persisted system row against its live system_message event. */
  systemMessageKey?: string
  inboxDeliveryMode?: DeliveryMode
  inboxMessageIds?: string[]
  inboxMessageSummaries?: Array<{
    id: string
    senderType: InboxMessageSenderType
    senderId: string | null
    subject: string | null
    preview: string
    senderDisplay?: string
    deferredUntil?: 'next-turn'
    workStreamId?: string
    squadId?: string
  }>
  strandedPendingRetryCount?: number
  isSystem?: boolean // True for system messages (e.g., compaction status)
  streamGroupId?: string // Groups persisted message fragments for one live execution/turn in the UI
  /** Optimistic-send idempotency key echoed back on the persisted human row. */
  clientId?: string
  /** ISO timestamp of when the agent run consumed this human message (stopped being pending). */
  consumedAt?: string
}

export type StreamEvent =
  | {
      type: 'execution_snapshot'
      executionId: string
      status: ExecutionStatus
      executionVersion: number
    }
  | {
      type: 'agent'
      agentId: string
      scope?: ChatScope
      executionId?: string
      executionStatus?: ExecutionStatus
    }
  | { type: 'thinking'; text: string; streamGroupId?: string }
  | { type: 'thinking_end'; durationMs: number; streamGroupId?: string }
  | { type: 'text'; text: string; streamGroupId?: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: string; streamGroupId?: string }
  | { type: 'tool_args_delta'; toolCallId: string; delta: string; streamGroupId?: string }
  | { type: 'tool_update'; toolCallId: string; result: string; streamGroupId?: string }
  | { type: 'tool_end'; toolCallId: string; result: string; isError: boolean; streamGroupId?: string }
  // System messages shown separately from assistant responses. transientId marks client-only notices
  // that can be removed later by a matching system_message_clear event or replaced by a matching
  // persisted system row.
  | { type: 'system_message'; text: string; transientId?: string }
  | { type: 'system_message_clear'; transientId: string }
  // Transient turn-phase marker on the same stream: 'waiting_sandbox' fires only while backend-
  // reported blocking sandbox setup/reconciliation outlasts a short debounce; 'sandbox_ready'
  // follows successful completion of that contiguous setup batch. Lets the UI show a distinct "waiting for the sandbox" state
  // instead of the generic thinking indicator. Older clients ignore the type; newer clients ignore
  // unknown phase values.
  | {
      type: 'execution_phase'
      phase: 'waiting_sandbox' | 'sandbox_ready' | 'sandbox_recovery_wait' | 'maintenance_queue'
    }
  // Compaction events (for programmatic use; text shown via system_message)
  | { type: 'compaction_start'; reason: 'auto' | 'manual' }
  | { type: 'compaction_end'; success: boolean; aborted: boolean; error?: string }
  // Flush the agent response and reset the collector -- when interrupted
  | { type: 'flush_agent' }
  | {
      type: 'done'
      response: string
      usage?: SessionUsage
      metadata?: MessageMetadata
      messageId?: string
      /** Stream group this terminal event finalizes (the runner's currentStreamGroupId). */
      streamGroupId?: string
      /** All persisted row ids for this turn (M1 + M2 for tool turns). Enables race-free swap. */
      messageIds?: string[]
    }
  | { type: 'error'; message: string }

// Core interfaces
export interface Task {
  id: string
  typeId: string
  status: TaskStatus
  currentStepIndex: number
  title: string
  description: string
  metadata: Record<string, unknown>
  parentTaskId: string | null
  squadId: string | null
  rewindCount: number
  createdAt: Date
  updatedAt: Date
}

export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/**
 * A snapshot of an agent session's usage.
 *
 * `stats` is CUMULATIVE for the whole session, not for one execution: pi's
 * session stats are reloaded from the persisted session file, so each capture
 * reports the running total since the session began. Storing it on an
 * execution row is therefore a snapshot at that execution's end, and summing
 * `stats` across executions overcounts enormously (observed live: a stream
 * reporting 185.3B tokens whose true usage was ~1.6B).
 *
 * `delta` is what THIS execution alone consumed, measured against a baseline
 * captured after the session was opened for it. Sum `delta` across executions;
 * take the last `stats` for an agent total.
 */
export interface SessionUsage {
  stats: {
    userMessages: number
    assistantMessages: number
    totalMessages: number
    tokens: UsageTokens
    cost: number
  }
  context: {
    tokens: number
    contextWindow: number
    percent: number
  } | null
  /** This execution's own consumption. Absent on rows written before deltas existed. */
  delta?: {
    tokens: UsageTokens
    cost: number
  }
}

export interface Message {
  /** Chat presentation: an intervention waiting for consumption; derived on API reads. */
  queued?: boolean
  id: string
  agentId: string
  role: MessageRole
  content: string
  metadata: MessageMetadata | null
  pending: boolean
  injectedAt?: Date | null
  createdAt: Date
}

export interface Artifact {
  id: string
  agentId: string
  taskId: string
  stepIndex: number
  name: string
  contentType: string
  content: string
  createdAt: Date
}

// Agent context types
export interface WorkflowAgentContext {
  taskId: string
  stepIndex: number
}

export interface ManagerAgentContext {
  scope: { type: string; id?: string }
}

export type AgentContext = WorkflowAgentContext | ManagerAgentContext | Record<string, unknown>

// Unified agent instance
export interface AgentMetadata {
  name?: string
  description?: string
  /** Short dynamic display summary set by the agent, 3-6 words preferred. */
  purpose?: string
  [key: string]: unknown
}

export interface Agent {
  id: string
  agentTypeId: string
  squadId: string | null
  parentAgentId: string | null
  status: AgentStatus
  persist: boolean
  modelOverride: string | null
  /** The configured model priority list (agent type default + override). May be a comma-separated list. */
  configuredModel?: string
  /** The actually-selected single model spec in use (after fallback). May differ from configuredModel when a priority list is configured. */
  selectedModel?: string
  /** Whether the selected/effective model accepts image input according to the Pi registry. */
  selectedModelSupportsImages?: boolean
  metadata: AgentMetadata | null
  context: AgentContext
  questionData: QuestionData | null
  sessionUsage: SessionUsage | null
  dormantAt: Date | null
  terminatedAt: Date | null
  lastMessageAt: Date | null
  lastHumanMessageAt: Date | null
  /** First ~280 chars of the most recent message, for a conversation preview. */
  lastMessagePreview: string | null
  createdAt: Date
  updatedAt: Date
  /** Federation handle published to peers (the `<handle>` in amtp://<instanceId>/<handle>), or null. */
  amtpHandle: string | null
  /** SPKI public PEM of the agent's constant identity key, or null while key-pending. */
  identityPublicKey: string | null
  /** Whether the agent's federation mailbox is open to inbound remote mail. */
  inboundOpen: boolean
}

// Unified execution (single wake-up cycle)
export interface Execution {
  id: string
  agentId: string
  status: ExecutionStatus
  message: string | null
  imageIds: string[] | null
  wakeEligible: boolean
  usage: SessionUsage | null
  error: string | null
  /** Structural failure class; only set on terminal `failed` rows. Nullable for older rows. */
  failureClass: ExecutionFailureClass | null
  /** Bounded machine-readable reason code for `failureClass`. Nullable for older rows. */
  failureReason: string | null
  startedAt: Date
  runStartedAt: Date | null
  endedAt: Date | null
}

/** Stored failure-class values (schema enum `execution_failure_class`). */
export const EXECUTION_FAILURE_CLASSES = [
  'provider_transport',
  'provider_model',
  'platform_pre_tool_refusal',
  'execution_failure',
] as const
export type ExecutionFailureClass = (typeof EXECUTION_FAILURE_CLASSES)[number]

// API types
export type OperationsRecommendationStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved'
export const OPERATIONS_RECOMMENDATION_TRANSITIONS: Readonly<
  Record<OperationsRecommendationStatus, readonly OperationsRecommendationStatus[]>
> = {
  open: ['acknowledged', 'dismissed', 'resolved'],
  acknowledged: ['open', 'dismissed', 'resolved'],
  dismissed: ['open'],
  resolved: ['open'],
}
export type OperationsRecommendationConfidence = 'low' | 'medium' | 'high'
export type OperationsSignalType =
  | 'missing_command'
  | 'ad_hoc_install'
  | 'permission_failure'
  | 'runtime_unavailable'
  | 'repeated_tool_failure'
  | 'workaround_discussion'

export type OperationsRemediation =
  | { type: 'add_sandbox_package'; package: string }
  | { type: 'update_sandbox_runtime'; runtime: string }
  | { type: 'review_sandbox_permission'; tool: string }
  | { type: 'improve_agent_tooling'; tool: string }
  | { type: 'update_agent_guidance'; topic: string }

export interface OperationsBaseline {
  sampleSize: number
  avgDurationMs: number
  avgTokens: number
  failedToolCalls: number
  estimatedAvoidableRetries: number
}

export interface OperationsRecommendationSummary {
  id: string
  squadId: string
  policy: 'recommendation-only'
  status: OperationsRecommendationStatus
  confidence: OperationsRecommendationConfidence
  title: string
  summary: string
  proposedRemediation: OperationsRemediation
  recurrence: { occurrences: number; executions: number; agents: number }
  baseline: OperationsBaseline
  comparison: null
  firstSeenAt: Date
  lastSeenAt: Date
  resolvedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface OperationsRecommendationEvidence {
  id: string
  executionId: string | null
  messageId: string | null
  signalTypes: OperationsSignalType[]
  occurrenceCount: number
  summary: string
  failedToolCalls: number
  estimatedAvoidableRetries: number
  observedAt: Date
}

export interface OperationsRecommendationEvent {
  id: string
  action: 'created' | 'evidence_added' | 'status_changed'
  actor: string
  fromStatus: OperationsRecommendationStatus | null
  toStatus: OperationsRecommendationStatus | null
  createdAt: Date
}

export interface OperationsRecommendationDetail extends OperationsRecommendationSummary {
  evidence: OperationsRecommendationEvidence[]
  events: OperationsRecommendationEvent[]
}

export interface CreateTaskInput {
  typeId: string
  title: string
  description: string
  metadata?: Record<string, unknown>
  parentTaskId?: string
  squadId?: string
  autoStart?: boolean
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface CreateMessageInput {
  role: MessageRole
  content: string
  metadata?: MessageMetadata
  pending?: boolean
}

// Checkpoint type for workflow steps (true = pause for review after step completes)
export type Checkpoint = boolean

// Task type definition
export interface TaskType {
  id: string
  name: string
  description: string | null
  systemPrompt: string
  schema: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

// Workflow step definition
export interface TaskTypeStep {
  id: string
  taskTypeId: string
  stepIndex: number
  agentTypeId: string
  checkpoint: Checkpoint
}

// Task type with steps (for API responses)
export interface TaskTypeWithSteps extends TaskType {
  steps: TaskTypeStep[]
}

export const INTEGRATION_CAPABILITIES = [
  'agent_tools',
  'conversation_export',
  'webhook_ingress',
  'messaging',
  'memory_source',
  'notification_sink',
] as const

export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number]

export interface AgentTypeIntegrationPolicyV1 {
  version: 1
  allow: Record<string, IntegrationCapability[]>
}

// Agent type definition
export interface AgentType {
  /** Reserved for a Ficus-managed role, not a work-flow participant. */
  systemOnly?: boolean
  id: string
  model: string
  tier?: string | null
  name: string
  description: string | null
  systemPrompt: string
  /** Ordered ids of shared prompts composed after systemPrompt at runtime. */
  includes: string[]
  /** systemPrompt + enabled includes, exactly as agents receive it (read-only, API detail only). */
  resolvedSystemPrompt?: string
  skills: string[] | null
  extensions: string[] | null
  toolsAllow: string[] | null
  toolsDeny: string[] | null
  integrationCapabilities?: AgentTypeIntegrationPolicyV1 | null
  earlyMarginTokens: number | null
  inFlightMarginTokens: number | null
  yamlFieldOverrides: string[]
  hasTemplate?: boolean
  disabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface SharedPrompt {
  id: string
  name: string
  description: string | null
  content: string
  yamlFieldOverrides: string[]
  hasTemplate?: boolean
  disabled: boolean
  createdAt: Date
  updatedAt: Date
}

// Checkpoint info for UI display
export interface CheckpointInfo {
  taskId: string
  stepIndex: number
  totalSteps: number
  checkpoint: Checkpoint
  agentTypeId: string
  agentTypeName?: string
}

// Input types for checkpoint actions
export interface ApproveCheckpointInput {
  comment?: string
}

export interface RejectCheckpointInput {
  reason: string
}

// Frequency for scheduled tasks
export type Frequency = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

// Overlap policy for scheduled tasks
export type OverlapPolicy = 'skip' | 'queue' | 'cancel'

// Task template for creating tasks from schedules
export interface TaskTemplate {
  typeId: string
  title: string
  description?: string
  metadata?: Record<string, unknown>
}

// Scheduled task
export interface ScheduledTask {
  id: string
  name: string
  enabled: boolean
  frequency: Frequency
  cronExpression: string | null
  time: string | null // HH:MM format
  dayOfWeek: number | null // 0-6
  dayOfMonth: number | null // 1-31
  timezone: string
  overlapPolicy: OverlapPolicy
  taskTemplate: TaskTemplate
  lastTriggeredAt: Date | null
  nextTriggerAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// Input types
export interface CreateScheduledTaskInput {
  name: string
  enabled?: boolean
  frequency: Frequency
  cronExpression?: string
  time?: string
  dayOfWeek?: number
  dayOfMonth?: number
  timezone?: string
  overlapPolicy?: OverlapPolicy
  taskTemplate: TaskTemplate
}

export interface UpdateScheduledTaskInput {
  name?: string
  enabled?: boolean
  frequency?: Frequency
  cronExpression?: string
  time?: string
  dayOfWeek?: number
  dayOfMonth?: number
  timezone?: string
  overlapPolicy?: OverlapPolicy
  taskTemplate?: TaskTemplate
}

// Chat types
export interface ChatScope {
  type: ChatScopeType
  id?: string
}

export interface ChatRequest {
  message: string
  agentId?: string
  scope?: ChatScope
  imageIds?: string[] // Optional pre-uploaded image IDs
}

export interface PushSubscription {
  id: string
  endpoint: string
  userAgent: string | null
  createdAt: Date
}

// Pending Action types for Action Center
export type PendingActionType =
  | 'squad-question'
  | 'agent-question'
  | 'agent-error'
  | 'workstream-review'
  | 'workstream-blocked'
  | 'assistant-needs-input'
  | 'workstream-delivery'

// An async agent question (status stays open; the agent keeps working). Visible in the conversation
// view (pending, near the input) and the context tab (answered history) to anyone with canonical
// agents:read on the agent; routed to the Action Center/push only as an attention item for direct
// recipients and authorized watchers. `audienceResolution` keeps its physical name for wire
// compatibility and records legacy-compatible attention-routing resolution state.
export type AgentQuestionStatus = 'open' | 'answered' | 'dismissed'

export type AgentQuestionAnswerDeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed'

export interface AgentQuestionAnswerDelivery {
  status: AgentQuestionAnswerDeliveryStatus
  generation: number
  attemptCount: number
  nextAttemptAt: string | null
  lastError: string | null
  deliveredAt: string | null
  canRetry: boolean
}

export interface AgentQuestion {
  id: string
  agentId: string
  squadId: string | null
  ownerUserId: string | null
  executionId?: string | null
  audienceResolution?: 'pending' | 'resolved' | 'unroutable' | 'legacy-unresolved' | null
  questionData: QuestionData
  status: AgentQuestionStatus
  answer: string | null
  answeredByUserId: string | null
  createdAt: string
  answeredAt: string | null
  dismissedAt?: string | null
  dismissalReason?: string | null
  dismissedByUserId?: string | null
  dismissedByAgentId?: string | null
  answerDelivery?: AgentQuestionAnswerDelivery
}

export interface QuestionActionData {
  agentId: string
  agentTypeId: string
  questionData: QuestionData
}

export interface CheckpointActionData {
  stepIndex: number
  totalSteps: number
  agentTypeId: string
}

export interface BlockedActionData {
  stepIndex: number
  agentTypeId: string
}

export interface FailedActionData {
  stepIndex: number
  reason?: string
}

export interface SquadQuestionActionData {
  agentId: string
  agentName: string | null
  agentTypeId: string
  squadId: string
  squadName: string
  questionData: QuestionData
}

export interface WorkStreamActionData {
  workStreamNumber?: number
  workStreamId: string
  workStreamTitle: string
  squadId: string
  squadName: string
  /** The open review/manual wait this action resolves (POST /workstreams/:id/waits/:waitId/resolve). */
  waitId: string
  wait: WorkStreamWait
  focus: {
    kind: 'workstream-wait'
    workStreamId: string
    waitId: string
  }
  assigneeAgentId: string | null
  assigneeName: string | null
  completionMode: WorkStreamCompletionMode
  prompt: WorkStreamPrompt
}

export interface AgentQuestionActionData {
  questionId: string
  agentId: string
  agentName: string | null
  agentTypeId: string
  squadId: string | null
  squadName: string | null
  ownerUserId: string | null
  questionData: QuestionData
  answerDelivery?: AgentQuestionAnswerDelivery
}

// An agent halted by a provider/rate-limit error (status waiting-input with an exhaustion question).
// These can be resumed individually or in bulk ("Continue all") once the provider recovers.
export interface AgentErrorActionData {
  agentId: string
  agentName: string | null
  agentTypeId: string
  squadId: string | null
  squadName: string | null
  ownerUserId: string | null
  reason: string
}

// A task delegated from a saved Assistant conversation whose delegate reported `needs-input`:
// work is blocked on the owner's answer, which is given inside that conversation.
export interface AssistantTaskActionData {
  conversationId: string
  conversationTitle: string
  taskId: string
  taskLabel: string
  ownerUserId: string
  agentId: string | null
  squadId: string | null
  squadName: string | null
  /** The latest update on the task, usually the question itself. */
  question: string
  updateMessageId: string | null
  updateCreatedAt: string | null
}

/**
 * A code-host delivery gate a person must act on outside Ficus: the pull request
 * needs a human review or merge. It has no wait; the provider settles it, so the
 * action carries no response controls. Clients that do not recognize the type ignore it.
 */
export interface WorkStreamDeliveryActionData {
  workStreamId: string
  workStreamNumber?: number
  workStreamTitle: string
  squadId: string
  squadName: string
  /** The server-classified human delivery gate (`WorkStream.delivery.kind`). */
  deliveryKind: 'review' | 'merge'
  /** Designated delivery pull requests, primary first. */
  pullRequests: Array<{ repository: string; number: number; url?: string }>
  focus: { kind: 'workstream'; workStreamId: string }
}

export type PendingActionData =
  | SquadQuestionActionData
  | AgentQuestionActionData
  | AgentErrorActionData
  | WorkStreamActionData
  | AssistantTaskActionData
  | WorkStreamDeliveryActionData

export interface PendingAction {
  id: string
  type: PendingActionType
  priority: number
  createdAt: string
  canRespond: boolean
  // Squad actions
  squadId?: string
  squadName?: string
  data: PendingActionData
}

// Squad Preset definitions
export interface SquadPreset {
  workflows?: import('./schemas').SquadPresetWorkflows | null
  id: string
  name: string
  description: string | null
  purpose: string | null
  defaultAgents: string[]
  managerInstructions: string | null
  yamlFieldOverrides: string[]
  hasTemplate?: boolean
  disabled: boolean
  createdAt: Date
  updatedAt: Date
}

// Squad presets
export type SquadStatus = 'active' | 'paused' | 'archived'

export type SandboxStatus = 'none' | 'initializing' | 'ready' | 'failed'

/** Physical runtime states returned by managed sandbox status endpoints. */
export type SandboxRuntimeState =
  | 'not_found'
  | 'pending'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'terminating'
  | 'unknown'

export type LocalDeploymentVisibility = 'private' | 'public'
export type LocalDeploymentMode = 'managed' | 'attached'
export type LocalDeploymentStatus = 'starting' | 'running' | 'restarting' | 'unhealthy' | 'crashed' | 'stopped'
export type LocalDeploymentRestartPolicy = 'always' | 'never'

export interface LocalDeployment {
  id: string
  squadId: string
  sandboxId: string
  name: string
  port: number
  targetHost: string
  urlPathOrHost: string
  visibility: LocalDeploymentVisibility
  mode: LocalDeploymentMode
  status: LocalDeploymentStatus
  keepSandboxAlive: boolean
  command?: string | null
  cwd?: string | null
  /** Absolute sandbox-side path of the log file Ficus tails for attached deployments. Null for managed (launcher owns logging) and for attached deployments registered without one. */
  logPath?: string | null
  envSecretRefs?: string[] | null
  processId?: string | null
  restartPolicy: LocalDeploymentRestartPolicy
  restartCount: number
  createdByAgentId?: string | null
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  expiresAt?: string | null
}

export interface CreateLocalDeploymentInput {
  name: string
  /**
   * OMIT THIS. Ficus assigns a free port and passes it to the app as `$PORT`,
   * which is the only way it can guarantee the port is actually free.
   *
   * A VM machine runs every squad's box as a user on ONE host, sharing one
   * loopback — unlike docker/k8s, where each sandbox has its own network
   * namespace and two squads may both use 3000 harmlessly. Supplying a port
   * there is a claim on a machine-wide resource, so an explicit port is
   * rejected when another live deployment already holds it.
   */
  port?: number
  visibility?: LocalDeploymentVisibility
  mode?: LocalDeploymentMode
  command?: string
  cwd?: string
  /**
   * ATTACHED ONLY. Path of a log file the app already writes, so the panel can
   * stream it. May be relative to the squad workspace; must resolve inside it
   * (`..` escapes and absolute paths outside are rejected). Rejected for
   * managed deployments.
   */
  logPath?: string | null
  envSecretRefs?: string[]
  restartPolicy?: LocalDeploymentRestartPolicy
}

export interface LocalDeploymentLogs {
  localDeploymentId: string
  lines: string[]
}

export type DeploymentAppType = 'static' | 'spa' | 'next' | 'api' | 'container' | 'db' | 'worker' | 'unknown'
export type DeploymentProviderId =
  | 'vercel'
  | 'github-pages'
  | 'railway'
  | 'supabase'
  | 'digitalocean'
  | 'cloudflare'
  | 'netlify'
export type DeploymentProviderAuth = 'api_token' | 'oauth_device' | 'browser_login'
export type DeploymentProviderBillingRisk = 'project_create' | 'always_on' | 'managed_db' | 'public_egress'

/** A squad-owned declarative toolchain realized in its managed sandboxes. */
export interface SandboxToolchainConfig {
  packages: string[]
  setupScript?: string
}

export type SandboxToolchainStatus = 'pending' | 'installing' | 'running_setup' | 'ready' | 'failed'

export interface Squad {
  /** Effective workflow after squad and preset defaults are resolved. */
  defaultWorkflow?: import('./workflows').WorkflowSource
  id: string
  name: string
  purpose: string
  status: SquadStatus
  squadPresetId: string | null
  defaultAgents: string[]
  managerAgentId: string | null
  context: string | null
  typeContext: Record<string, string> | null
  isAnonymous: boolean
  globalCollaborationEnabled: boolean
  order: number
  metadata: Record<string, unknown>
  sandboxStatus: SandboxStatus
  /**
   * Max simultaneously-admitted work streams (status `active`).
   * null = unlimited (today's behavior). Queued streams wait for a slot.
   */
  maxConcurrentWorkStreams: number | null
  /**
   * Auto-park grace: an `active` stream with an open wait older than this
   * many minutes is parked (→ `queued`) by the admission maintenance pass.
   * null → default 30; 0 = park immediately. Negative values are rejected.
   */
  blockedGraceMinutes: number | null
  /** host runtime: absolute directory this squad works in; null = default. Ignored by other runtimes. */
  hostWorkspacePath: string | null
  /** Avatar image id (in the images table) + a freshly-signed URL to display it (null if none). */
  avatarImageId: string | null
  avatarUrl: string | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export interface CreateSquadInput {
  name: string
  purpose: string
  squadPresetId?: string
  defaultAgents?: string[]
  context?: string
  typeContext?: Record<string, string>
  metadata?: Record<string, unknown>
  globalCollaborationEnabled?: boolean
  /** host runtime: absolute directory this squad works in. */
  hostWorkspacePath?: string
}

export interface UpdateSquadInput {
  name?: string
  purpose?: string
  status?: SquadStatus
  defaultAgents?: string[]
  context?: string | null
  typeContext?: Record<string, string | null> | null
  metadata?: Record<string, unknown>
  globalCollaborationEnabled?: boolean
  /** Max simultaneously-admitted work streams; null = unlimited. Lowering never evicts admitted streams. */
  maxConcurrentWorkStreams?: number | null
  /** Auto-park grace minutes for active streams with open waits; null → default 30; 0 = immediate. */
  blockedGraceMinutes?: number | null
  /**
   * vm runtime: pin the squad's box to a specific machine (`null` unpins →
   * placement default). Ignored by k8s/docker runtimes.
   */
  machineId?: string | null
  /** host runtime: absolute directory this squad works in; null = default. Ignored by other runtimes. */
  hostWorkspacePath?: string | null
}

// Squad Relationship types
export type SquadRelationshipType = 'reports_to' | 'collaborates' | 'depends_on'

export interface SquadRelationship {
  id: string
  sourceSquadId: string
  targetSquadId: string
  relationshipType: SquadRelationshipType
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface CreateSquadRelationshipInput {
  sourceSquadId: string
  targetSquadId: string
  relationshipType: SquadRelationshipType
  metadata?: Record<string, unknown>
}

// Communication-safe identity for a related squad. Relationship visibility must
// not expose the foreign squad's context, metadata, configuration, or runtime state.
export interface SquadRelationshipSummary {
  id: string
  name: string
  purpose: string
  managerAgentId: string | null
}

// Squad with all relationship directions resolved
export interface SquadRelationships {
  reportsTo: SquadRelationshipSummary[] // Squads this squad reports to
  collaborates: SquadRelationshipSummary[] // Peer squads (bidirectional)
  dependsOn: SquadRelationshipSummary[] // Squads this squad depends on
  reportedBy: SquadRelationshipSummary[] // Squads that report to this one (inverse of reportsTo)
  dependedOnBy: SquadRelationshipSummary[] // Squads that depend on this one (inverse of dependsOn)
}

export interface SquadWithRelationships extends Squad {
  relationships: SquadRelationships
}

// Work Stream types
//
// Stored status is deliberately small: `queued` (not admitted, holds no slot,
// sandboxes stopped), `active` (admitted, holds a slot), and the two terminal
// states. Everything richer — blocked / in review / waiting on a question —
// is a typed OPEN WAIT record (`WorkStreamWait`) plus a display state DERIVED
// in serializers (`WorkStreamDerivedState`), never stored.
export type WorkStreamStatus = 'queued' | 'active' | 'done' | 'canceled'

export const WORK_STREAM_STATUSES = ['queued', 'active', 'done', 'canceled'] as const

/**
 * Legacy (pre-consolidation) status vocabulary, accepted in FILTERS and
 * status writes for one release with a deprecation note:
 * `pending` → `queued`, `in_progress`/`blocked`/`review` → `active`.
 */
export const LEGACY_WORK_STREAM_STATUS_MAP: Record<string, WorkStreamStatus> = {
  pending: 'queued',
  in_progress: 'active',
  blocked: 'active',
  review: 'active',
}

/** Map one status value from the legacy vocabulary (pass-through for current values). */
export function mapLegacyWorkStreamStatus(status: string): WorkStreamStatus | undefined {
  if ((WORK_STREAM_STATUSES as readonly string[]).includes(status)) return status as WorkStreamStatus
  return LEGACY_WORK_STREAM_STATUS_MAP[status]
}

/**
 * Statuses that hold a concurrency slot under a squad's
 * maxConcurrentWorkStreams cap: exactly `active`. `queued` (the parked/
 * waiting state) and the terminal statuses hold nothing. This is also exactly
 * the set the sandbox keepalive/warmup layer treats as "live" — queued
 * streams' agents get no running sandboxes.
 */
export const WORK_STREAM_ADMITTED_STATUSES: WorkStreamStatus[] = ['active']

// --- Typed waits ---

export type WorkStreamWaitType = 'dependency' | 'question' | 'review' | 'manual'

/**
 * Typed resolution recorded when a wait closes:
 * `satisfied` (dependency done), `answered` (question), `approved` /
 * `sent_back` (review verdicts), `cleared` (manual clear / edge removed /
 * stream reached a terminal status with the wait still open).
 */
export type WorkStreamWaitResolution = 'satisfied' | 'answered' | 'approved' | 'sent_back' | 'cleared'

export type WorkStreamWaitCreatedBy = 'system' | 'agent' | 'manager' | 'operator'

/**
 * Who must act to clear a manual wait: `human` (the user/operator) or `owner`
 * (the stream's owning agent; the squad manager when it has none). Only `human`
 * manual waits ask for human attention; every actor blocks scheduling and flow
 * progress identically.
 */
export const WORK_STREAM_WAIT_ACTORS = ['human', 'owner'] as const
export type WorkStreamWaitActor = (typeof WORK_STREAM_WAIT_ACTORS)[number]

/** One audited correction of a manual wait's actor (append-only, oldest first). */
export interface WorkStreamWaitActorChange {
  from: WorkStreamWaitActor
  to: WorkStreamWaitActor
  changedAt: string
  changedByAgentId: string | null
  changedByUserId: string | null
  note: string | null
}

/** Normalize a possibly missing or unknown actor: anything unrecognized is human (older payloads). */
export function workStreamWaitActor(wait: { actor?: string | null }): WorkStreamWaitActor {
  return wait.actor === 'owner' ? 'owner' : 'human'
}

export interface WorkStreamWait {
  /** Missing/null means whole-stream; an ID pins the wait to one flow attempt. */
  flowAttemptId?: number | null
  /** A specialized decision UI owns resolution instead of generic unblock. */
  resolutionHandler?: 'workflow'
  id: string
  workStreamId: string
  type: WorkStreamWaitType
  /**
   * Manual waits only: who must act. Omitted on other wait types and by older
   * servers; consumers treat a missing or unknown actor as `human`.
   */
  actor?: WorkStreamWaitActor
  /** Manual waits only, when the actor was corrected after opening: the audit trail. */
  actorChanges?: WorkStreamWaitActorChange[]
  /** The dependency stream id or agent-question id; null for manual waits. */
  referenceId: string | null
  message: string | null
  createdBy: WorkStreamWaitCreatedBy
  createdByAgentId: string | null
  createdByUserId: string | null
  /**
   * Review waits only (default true): approving this wait completes the
   * stream in the same transaction. False = mid-work checkpoint review —
   * approval resolves the wait and the stream continues.
   */
  completesOnApproval: boolean
  openedAt: string
  closedAt: string | null
  resolution: WorkStreamWaitResolution | null
  resolutionNote: string | null
}

/**
 * Display state derived from executions + open waits (computed in
 * serializers, never stored). Open waits win over a running execution, by
 * type precedence review > question > dependency > manual; `in_progress`
 * requires a RUNNING execution for one of the stream's agents; `idle` is
 * active with no execution and no wait. Resource-wait context is a separate
 * presentation fact; ordinary idle is neutral.
 */
export type WorkStreamDerivedState =
  | 'paused'
  | 'in_progress'
  | 'in_review'
  | 'waiting_on_answer'
  | 'waiting_on_dependency'
  | 'blocked'
  | 'idle'
  /**
   * The newest terminal execution of an assigned agent FAILED for a reason
   * that needs operator attention (platform admission refusal, or an
   * unclassified/provider failure) — the stream is NOT ordinary `idle`.
   * Cleared deterministically by any newer terminal outcome.
   */
  | 'execution_failed'
  | 'queued'
  | 'done'
  | 'canceled'

/**
 * Detail carried next to derivedState 'execution_failed': the execution the
 * display state was derived from, with its stored structural classification
 * (nullable for legacy rows written before classification existed).
 */
export interface WorkStreamTerminalFailure {
  executionId: string
  failureClass: ExecutionFailureClass | null
  failureReason: string | null
  endedAt: Date
}

export const WORK_STREAM_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const
export type WorkStreamPriority = (typeof WORK_STREAM_PRIORITIES)[number]
export type WorkStreamPromptType = 'text' | 'select' | 'multi_select'
export const WORK_STREAM_COMPLETION_MODES = [
  'pr-merge',
  'pr-auto-merge',
  'review-approval',
  'direct-merge',
  'deliverable',
] as const
export type WorkStreamCompletionMode = (typeof WORK_STREAM_COMPLETION_MODES)[number]

export type WorkStreamSourceLinkKind =
  | 'memory_document'
  | 'agent_thread'
  | 'slack_thread'
  | 'github_issue'
  | 'linear_issue'
  | 'channel_message'
  | 'url'

export interface WorkStreamSourceLink {
  kind: WorkStreamSourceLinkKind
  /** Memory source squad — required for indexed-memory kinds. */
  sourceSquadId?: string
  /** Adapter-defined source identifier (e.g. 'C0123:1715800000.123' for slack_thread). */
  sourceId?: string
  /** Memory path for memory_document kind. */
  path?: string
  /** Free-text title shown in UI/handoff. */
  title?: string
  /** External URL (Slack permalink, GitHub URL, Linear URL, arbitrary). */
  url?: string
  /** Short context snippet to render alongside the link. */
  snippet?: string
  /** When the link was attached. ISO8601. */
  addedAt: string
}

/** Reserved metadata key. */
export interface WorkStreamMetadataReserved {
  sources?: WorkStreamSourceLink[]
  /** Follow-up work or improvements discovered while completing the stream. */
  nextSteps?: string
  completion?: { mode?: WorkStreamCompletionMode; completedAt?: string }
}

export interface WorkStreamPrompt {
  type: WorkStreamPromptType
  message: string
  options?: string[]
  files?: string[]
}

/** Summary of an agent spawned during work stream creation. */
export interface WorkStreamAgentSummary {
  id: string
  agentTypeId: string
  name?: string | null
  status?: string
}

export interface WorkStreamPause {
  id: string
  pausedAt: string
  reason: string | null
  parkAt: string | null
  agentIds: string[]
}

/** Immutable, server-observed receipt for a platform-created linked worktree. */
export interface WorktreeOwnership {
  workspace: string
  repository: string
  commonDirectory: string
  gitDirectory: string
  worktree: string
  directoryIdentity: string
  branch: string
  /** Exact starting OID and source, when provisioning created a new branch. */
  baseCommit?: string
  baseSource?: 'remote' | 'local'
}

export interface WorktreeCleanupInspection {
  workStreamId: string
  autoCleanupWorktree: boolean
  owned: WorktreeOwnership | null
  current: Partial<Record<'repository' | 'worktree' | 'branch', string>>
  bindingsMatch: boolean | null
  cleanup: WorktreeCleanupSummary | null
  /** Snapshot only; retain rechecks under lifecycle locks. */
  recovery: 'retain' | 'retained' | 'in-flight' | 'reclaimed'
}

export interface WorktreeCleanupSummary {
  status: 'pending' | 'deferred' | 'skipped' | 'removing' | 'succeeded' | 'error'
  reason: string | null
  attempts: number
  nextAttemptAt: string
  updatedAt: string
  operationId: string | null
}

export interface WorkStream {
  delivery?: import('./status-presentation').WorkStreamDeliveryPresentation
  /** Durable platform cleanup state, when an intent exists. */
  worktreeCleanup?: WorktreeCleanupSummary | null
  /** Effective retention setting. Older servers omit this field (retain). */
  autoCleanupWorktree?: boolean
  /** Immutable instance-wide reference. Optional only for older server compatibility. */
  number?: number
  pause?: WorkStreamPause | null
  id: string
  squadId: string
  title: string
  description: string
  status: WorkStreamStatus
  /** Stored (advisory) priority. Effective priority is always computed — see effectivePriority. */
  priority: WorkStreamPriority
  /**
   * Computed priority after blocker boosting (max of stored priority and every
   * open dependent's effective priority). Populated by list/detail endpoints.
   */
  effectivePriority?: WorkStreamPriority
  /** Title of the dependent stream that produced the boost, when effectivePriority differs from priority. */
  effectivePriorityVia?: string
  /**
   * 1-based position among the squad's ELIGIBLE queued streams (all deps done),
   * in admission order. Populated for eligible `queued` streams by list/detail
   * endpoints; dep-blocked queued streams get `waitingOnDependencies` instead.
   */
  queuePosition?: number
  /** Queued but ineligible: at least one dependsOn entry is not done. Never auto-admitted in this state. */
  waitingOnDependencies?: boolean
  assigneeAgentId: string | null
  ownerAgentId: string | null
  /** The agent that created this work stream (provenance). Null for user-created streams. */
  creatorAgentId: string | null
  /** The human user who requested this work stream (provenance). Null for agent-created streams. */
  requestingUserId: string | null
  assignedReviewerIds?: string[]
  /** Resolved display name of the requesting user; populated by the detail endpoint, not stored. */
  requestingUserName?: string | null
  agentIds: string[] | null
  dependsOn: string[]
  /** Work streams in this squad that depend on this stream. Computed server-side; never stored. */
  dependedOnBy: string[]
  /** Display state derived from executions + open waits. Populated by list/detail endpoints. */
  /** Server-owned, current-flow resource wait context; no pool or participant details. */
  hasActiveSlotWait?: boolean
  derivedState?: WorkStreamDerivedState
  /** Open (unresolved) wait records, newest first. Populated by list/detail endpoints. */
  openWaits?: WorkStreamWait[]
  /** Count of CLOSED review waits (= completed review rounds). Populated by the detail endpoint. */
  reviewRounds?: number
  /** Full review-wait history (open + closed), newest first. Populated by the detail endpoint. */
  reviewHistory?: WorkStreamWait[]
  /** Full wait audit trail — EVERY wait of every type (open + closed), newest first. Populated by the detail endpoint. */
  waitHistory?: WorkStreamWait[]
  handoffMessage: string | null
  files: string[]
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  /** Immutable terminal transition instant; updatedAt fallback for legacy terminal rows. */
  completedAt?: Date
  /** Aggregated agent execution runtime. Populated by list/detail endpoints. */
  runtime?: WorkStreamRuntime
  /** @deprecated Historical creation response. New streams start participants lazily through flows. */
  spawnedAgents?: WorkStreamAgentSummary[]
  // Derived fields (resolved from metadata)
  completionMode: WorkStreamCompletionMode // always resolved — defaults to 'pr-merge'
  branch?: string
  worktree?: string
  baseBranch?: string
}

export interface WorkStreamRuntime {
  totalMs: number
  activeCount: number
  computedAt: string // ISO timestamp
}

export interface CreateWorkStreamInput {
  /** One-shot terminal observation for the server-authenticated creating agent. */
  observe?: 'terminal'
  /** Automatically reclaim an owned worktree after delivery and associated execution settlement. Defaults true for new streams. */
  autoCleanupWorktree?: boolean
  assignedReviewerIds?: string[]
  /** Omission inherits the effective squad default. Every new stream has a flow. */
  workflow?: import('./workflows').WorkflowSource
  squadId: string
  title: string
  description?: string
  /** @deprecated Rejected at creation. Define participants in workflow instead. */
  assigneeAgentId?: string
  /** @deprecated Rejected at creation. Define steps in workflow instead. */
  assigneeAgentIndex?: number
  ownerAgentId?: string | null
  /** The agent creating this stream. Set server-side from the caller's identity; not client-supplied. */
  creatorAgentId?: string | null
  /** The human user who requested this work stream. Set server-side from the caller's identity. */
  requestingUserId?: string | null
  /** @deprecated Rejected at creation. Retained only to diagnose old clients. */
  agentIds?: string[]
  /** @deprecated Rejected at creation. Define participants in workflow instead. */
  agents?: string[]
  /** @deprecated Rejected at creation. Set participant model overrides in workflow. */
  agentModelOverrides?: Record<string, string>
  handoffMessage?: string | null
  dependsOn?: string[]
  /** Advisory scheduling priority. Defaults to 'normal'. */
  priority?: WorkStreamPriority
  metadata?: Record<string, unknown>
  /** Create from an observed integration event: tracks its resource and reuses the stream already handling it. */
  integrationEventId?: string
  // Typed fields — translated to metadata at the entity boundary
  /** @deprecated Rejected at creation. Configure workflow completion instead. */
  completionMode?: WorkStreamCompletionMode
  /** Repository path in the squad workspace. Provision a worktree before dispatch. */
  repository?: string
  /** Remote to detect code-host identity/base from; defaults to origin. */
  gitRemote?: string
  /** New branches fetch the remote base by default; local requires an explicit baseBranch. */
  baseSource?: 'remote' | 'local'
  branch?: string
  worktree?: string
  baseBranch?: string
}

export interface UpdateWorkStreamInput {
  /** Disable before finish to retain the worktree. Does not cancel an already dispatched removal. */
  autoCleanupWorktree?: boolean
  assignedReviewerIds?: string[]
  title?: string
  description?: string
  status?: WorkStreamStatus
  /** Advisory scheduling priority. Priority edits alone never transition a stream. */
  priority?: WorkStreamPriority
  assigneeAgentId?: string | null
  ownerAgentId?: string | null
  agentIds?: string[] | null
  dependsOn?: string[]
  handoffMessage?: string | null
  files?: string[]
  metadata?: Record<string, unknown>
  /** Follow-up notes translated to metadata.nextSteps at the entity boundary. */
  nextSteps?: string
  // Typed fields — translated to metadata at the entity boundary
  completionMode?: WorkStreamCompletionMode
  /** Repository path in the squad workspace. Provision a worktree before dispatch. */
  repository?: string
  /** Remote to detect code-host identity/base from; defaults to origin. */
  gitRemote?: string
  /** New branches fetch the remote base by default; local requires an explicit baseBranch. */
  baseSource?: 'remote' | 'local'
  branch?: string
  worktree?: string
  baseBranch?: string
}

/** Resolutions a caller may apply to an open wait (system resolutions like `satisfied`/`answered` excluded). */
export type WorkStreamWaitCallerResolution = 'approved' | 'sent_back' | 'cleared'

/** Body of POST /api/workstreams/:id/waits/:waitId/resolve. */
export interface ResolveWorkStreamWaitInput {
  resolution: WorkStreamWaitCallerResolution
  note?: string
}

// Work stream metrics (aggregated from executions)
export interface WorkStreamMetrics {
  // Token counts across all executions
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  // Cost in USD (from Pi SDK's built-in pricing)
  cost: number
  // Execution counts
  executions: {
    total: number
    completed: number
    failed: number
  }
  // Time metrics
  duration: {
    totalMs: number // Sum of all execution durations
    firstStartedAt: string | null
    lastEndedAt: string | null
  }
  // Breakdown by agent (for UI drill-down)
  byAgent: Record<
    string,
    {
      tokens: number
      cost: number
      executions: number
    }
  >
}

// Schedule types (unified)
export type ScheduleScopeType = 'squad' | 'agent'
export type ScheduleHealthStatus = 'never_run' | 'healthy' | 'failing' | 'automatically_disabled'
export type ScheduleFailureClass = 'permanent' | 'transient'
export type ScheduleHealthEventKind = 'failed' | 'recovered' | 'automatically_disabled'

export interface ScheduleScope {
  type: ScheduleScopeType
  id: string
}

export interface ScheduleConfig {
  interval?: string // "15m", "2h", etc.
  cron?: string // Cron expression
  runAt?: string // ISO date string for one-shot
  skipIfUnresolved?: boolean
  expiresAt?: string // ISO-8601 datetime with timezone
}

// Action target for inbox_message
export type ScheduleActionTarget = { type: 'agent'; agentId: string } | { type: 'squad_manager' }

// Schedule actions
export interface ScheduleInboxMessageAction {
  type: 'inbox_message'
  target: ScheduleActionTarget
  subject?: string
  content: string
}

export interface ScheduleSpawnAgentAction {
  type: 'spawn_agent'
  agentTypeId: string
  prompt: string
  workStream?: {
    title: string
    description?: string
    completionMode?: WorkStreamCompletionMode
  }
}

export interface ScheduleCreateWorkStreamAction {
  type: 'create_work_stream'
  workflow?: import('./workflows').WorkflowSource
  title: string
  description?: string
  // Auto-spawn flow
  agentTypes?: string[]
  assigneeAgentIndex?: number // 0-indexed
  // Existing agents flow
  agentIds?: string[]
  assigneeAgentId?: string
  handoffMessage?: string
  completionMode?: WorkStreamCompletionMode
}

export type ScheduleAction = ScheduleInboxMessageAction | ScheduleSpawnAgentAction | ScheduleCreateWorkStreamAction

// Schedule entity
export interface Schedule {
  id: string
  scopeType: ScheduleScopeType
  scopeId: string
  name: string
  enabled: boolean
  schedule: ScheduleConfig
  action: ScheduleAction
  metadata: Record<string, unknown>
  triggerCount: number
  lastTriggeredAt: Date | null
  lastSkippedAt: Date | null
  skipCount: number
  lastWebhookTriggerAt: Date | null
  nextTriggerAt: Date | null
  webhookEnabled: boolean
  healthStatus: ScheduleHealthStatus
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  lastRecoveredAt: Date | null
  failureCount: number
  consecutiveFailureCount: number
  lastErrorCode: string | null
  lastErrorSummary: string | null
  automaticallyDisabledAt: Date | null
  automaticDisableReason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateScheduleInput {
  scopeType: ScheduleScopeType
  scopeId: string
  name: string
  enabled?: boolean
  schedule: ScheduleConfig
  action: ScheduleAction
  metadata?: Record<string, unknown>
  /** If true, creates a webhook-only schedule (no time-based trigger) */
  webhookOnly?: boolean
}

export interface UpdateScheduleInput {
  name?: string
  enabled?: boolean
  schedule?: ScheduleConfig
  action?: ScheduleAction
  metadata?: Record<string, unknown>
}

// Webhook-related types
export interface WebhookEnableResult {
  webhookEnabled: boolean
  token: string // Plain token, only returned once
  webhookUrl: string
}

export interface WebhookTriggerResult {
  triggered: boolean
  scheduleId: string
  scheduleName: string
  agentId?: string // For spawn_agent actions
  workStreamId?: string // For create_work_stream or spawn_agent with work stream
}

export interface WebhookTriggerRequest {
  context?: Record<string, unknown>
}

// Inbox Message types
export type InboxMessageSenderType = 'system' | 'agent' | 'user' | 'voice_assistant' | 'remote'
export type InboxRecipientType = 'agent' | 'user' | 'voice_assistant' | 'system'

/** Reserved recipientId for the shared, permissioned system/announcements inbox. */
export const SYSTEM_RECIPIENT_ID = 'system'

/**
 * URL/CLI shorthands that resolve, server-side, to the authenticated user's own id.
 * 'user' is kept for backward compatibility with the previous singleton human inbox.
 */
export const SELF_RECIPIENT_SHORTHANDS = ['me', 'user'] as const
export function isSelfRecipientShorthand(id: string): boolean {
  return (SELF_RECIPIENT_SHORTHANDS as readonly string[]).includes(id)
}

/**
 * The voice "workspace" assistant is a per-user identity (both sender and receiver):
 * `workspace:<userId>`. There is no bare legacy 'workspace' identity — the prefix is
 * internal and only used to build/parse the per-user id.
 */
const WORKSPACE_VOICE_PREFIX = 'workspace'
/** Per-user voice workspace recipient id, e.g. `workspace:<userId>`. */
export function workspaceVoiceRecipientId(userId: string): string {
  return `${WORKSPACE_VOICE_PREFIX}:${userId}`
}
/** True for any per-user `workspace:<userId>` voice recipient/sender id. */
export function isWorkspaceVoiceRecipient(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(`${WORKSPACE_VOICE_PREFIX}:`)
}
/** Extract `<userId>` from `workspace:<userId>`, or null for a non-match. */
export function parseWorkspaceVoiceUserId(id: string | null | undefined): string | null {
  if (typeof id !== 'string') return null
  const prefix = `${WORKSPACE_VOICE_PREFIX}:`
  return id.startsWith(prefix) ? id.slice(prefix.length) : null
}

export interface InboxAttachment {
  id: string
  messageId: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
  createdAt: Date
}

export interface InboxMessage {
  id: string
  recipientType: InboxRecipientType
  recipientId: string
  senderType: InboxMessageSenderType
  senderId: string | null
  subject: string | null
  content: string
  metadata: Record<string, unknown>
  readAt: Date | null
  deliveredAt: Date | null
  deliveryMode: DeliveryMode
  createdAt: Date
  /** Loaded if the sender is an agent */
  senderAgent?: Agent | null
  /** Loaded if the recipient is an agent */
  recipientAgent?: Agent | null
  /** Attachments linked to this message (empty when none). */
  attachments?: InboxAttachment[]
}

// ── RBAC Types ───────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string
  email: string
  displayName: string | null
  createdAt: string
  updatedAt: string
}

export interface UserInfo {
  id: string
  email: string
  displayName: string | null
  disabledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RoleInfo {
  id: string
  name: string
  slug: string
  permissions: string[]
  isSystem: boolean
  readOnly: boolean
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export interface CredentialInfo {
  id: string
  credentialId: string
  displayName: string | null
  createdAt: string
}

export interface RoleAssignment {
  id: string
  roleId: string
  roleName: string
  roleSlug: string
  scope: 'system' | 'squad_default' | 'squad'
  squadId: string | null
  createdAt: string
}

export interface SessionInfo {
  id: string
  userAgent: string | null
  ipAddress: string | null
  createdAt: string
  expiresAt: string
}

export interface AuthStatus {
  authEnabled: boolean
  mode: 'password' | 'passkey'
  hasUsers: boolean
  hasAdminUser: boolean
  /** The /demo reviewer access page is served on this instance (FICUS_DEMO_REVIEWER_ACCESS). */
  demoReviewerAccess?: boolean
}

export interface AuthSettings {
  allowedDomains: string[]
  requireInvite: boolean
}

// ── Federation Types ──────────────────────────────────────────────────────────

export interface InstanceIdentityResponse {
  instanceId: string
  publicKeyPem: string
}

export interface PeerResponse {
  id: string
  localAlias: string
  instanceId: string
  baseUrl: string
  publicKeyPem: string
  status: string
  createdAt: Date
}

// AmtpEnvelope + AmtpAttachmentRef (the envelope's attachment reference) live in
// amtp-protocol; re-exported here so existing `@ficus/shared` importers keep working.
export type { AmtpEnvelope, AmtpAttachmentRef } from 'amtp-protocol/envelope'

// AmtpAgentCard + AmtpSignedAgentCard(SansSig) live in amtp-protocol (browser-safe: zod + ./jcs
// only); re-exported here so existing `@ficus/shared` importers keep working. Import from the
// `/card` submodule, NOT the barrel `amtp-protocol`, so the browser bundle never pulls in
// ./crypto (node:crypto).
export type { AmtpAgentCard, AmtpSignedAgentCard, AmtpSignedAgentCardSansSig } from 'amtp-protocol/card'

export interface OperationsRecommendationPage {
  items: OperationsRecommendationSummary[]
  nextCursor: string | null
}

/** Worker choice policy shared by UI pickers and flow validation. */
export function isWorkerAgentType(type: { systemOnly?: boolean; disabled?: boolean }): boolean {
  return !type.systemOnly && !type.disabled
}
