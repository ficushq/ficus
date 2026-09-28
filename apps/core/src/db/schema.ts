import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  unique,
  uniqueIndex,
  boolean,
  vector,
  index,
  primaryKey,
  foreignKey,
  check,
  bigint,
  pgSequence,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import type {
  ThemePreference,
  CustomThemeDocument,
  FarmSettings,
  FarmChatRoomKind,
  AmtpEnvelope,
  AmtpSignedAgentCard,
  Attention,
  ProviderHealthKind,
  SquadActivityKind,
  SquadActivityRef,
  WorkflowDefinition,
  ResolvedWorkflow,
  WorkflowRun,
  WorkflowCommand,
  IntegrationOutputFact,
  IntegrationSubscription,
} from '@ficus/shared'
import type { GitHubIssueDispatchFact } from '../services/squad-activity/github-issue-fact'
import type { GitHubPrDispatchFact } from '../services/squad-activity/github-pr-fact'
import type { SandboxProvisionErrorCode } from '../services/sandbox/k8s/provision-errors'
import type { ProvisionFailureCode } from '../services/sandbox/k8s/provision-failure'

// Enums
export const messageEnqueueOrderSequence = pgSequence('message_enqueue_order_seq', {
  startWith: 1,
  minValue: 1,
})

export const messageRoleEnum = pgEnum('message_role', ['human', 'assistant'])

export const slotWaiterEnqueueSequence = pgSequence('slot_waiter_enqueue_seq', {
  startWith: 1,
  minValue: 1,
})
export const slotClaimStatusEnum = pgEnum('slot_claim_status', ['active', 'released', 'expired'])
export const slotWaiterStatusEnum = pgEnum('slot_waiter_status', ['queued', 'granted', 'canceled'])
export const slotNotificationKindEnum = pgEnum('slot_notification_kind', ['granted', 'expired'])
export const slotNotificationStatusEnum = pgEnum('slot_notification_status', ['pending', 'delivering', 'delivered'])

export const imageStatusEnum = pgEnum('image_status', [
  'pending', // Uploaded, waiting to be used
  'used', // Successfully sent to Pi SDK
  'failed', // Failed to process
])

export const agentFileAttachmentStatusEnum = pgEnum('agent_file_attachment_status', ['uploading', 'pending', 'used'])

export const agentStatusEnum = pgEnum('agent_status', [
  'idle',
  'active',
  'waiting-input',
  'compacting',
  'resetting',
  'dormant',
  'terminated',
])

export const chatSendReceiptStateEnum = pgEnum('chat_send_receipt_state', ['pending', 'accepted'])

export const executionStatusEnum = pgEnum('execution_status', [
  'queued',
  'waiting-maintenance',
  'waiting-sandbox',
  'running',
  'stopping',
  'stopped',
  'completed',
  'failed',
])

/**
 * Structural classification of a terminal execution failure, written by the
 * fenced terminal transaction (`Execution.transitionTo`) at the failure site
 * and read by derived state / continuation / notifications. Never parsed back
 * out of the free-form `error` prose.
 */
export const executionFailureClassEnum = pgEnum('execution_failure_class', [
  // Retryable transport sentinel at the model-call boundary.
  'provider_transport',
  // Other model-call failure.
  'provider_model',
  // Admission/sandbox/session infrastructure refused before any agent output.
  'platform_pre_tool_refusal',
  // Post-tool, setup-unclassified, or legacy (pre-classification) failure.
  'execution_failure',
])

export const squadStatusEnum = pgEnum('squad_status', ['active', 'paused', 'archived'])

export const sandboxStatusEnum = pgEnum('sandbox_status', ['none', 'initializing', 'ready', 'failed'])

export const localDeploymentVisibilityEnum = pgEnum('local_deployment_visibility', ['private', 'public'])
export const localDeploymentModeEnum = pgEnum('local_deployment_mode', ['managed', 'attached'])
export const localDeploymentStatusEnum = pgEnum('local_deployment_status', [
  'starting',
  'running',
  'restarting',
  'unhealthy',
  'crashed',
  'stopped',
])
export const localDeploymentRestartPolicyEnum = pgEnum('local_deployment_restart_policy', ['always', 'never'])

export const appDeploymentEnvironmentEnum = pgEnum('app_deployment_environment', ['preview', 'staging', 'production'])
export const appDeploymentStatusEnum = pgEnum('app_deployment_status', [
  'planned',
  'deploying',
  'ready',
  'failed',
  'rolled_back',
  'destroyed',
])
export const appDeploymentCostRiskEnum = pgEnum('app_deployment_cost_risk', ['none', 'low', 'metered', 'paid_required'])

export const squadRelationshipTypeEnum = pgEnum('squad_relationship_type', ['reports_to', 'collaborates', 'depends_on'])

export const workStreamStatusEnum = pgEnum('work_stream_status', [
  // Waiting for an admission slot under the squad's maxConcurrentWorkStreams
  // cap (also the "parked" state). Holds no slot; its agents' sandboxes are
  // gated off. Non-terminal: admission promotes it to 'active'.
  'queued',
  // Admitted; holds a slot. Everything richer (blocked / in review / waiting
  // on an answer) is a typed OPEN WAIT record in work_stream_waits plus a
  // display state derived in serializers — never stored here.
  'active',
  'done',
  'canceled',
])

export const workStreamWaitTypeEnum = pgEnum('work_stream_wait_type', ['dependency', 'question', 'review', 'manual'])

export const workStreamWaitCreatedByEnum = pgEnum('work_stream_wait_created_by', [
  'system',
  'agent',
  'manager',
  'operator',
])

// Advisory scheduling priority; admission order uses the COMPUTED effective
// priority (blocker boosting), stored priority is the base.
export const workStreamPriorityEnum = pgEnum('work_stream_priority', ['critical', 'high', 'normal', 'low'])

export const inboxMessageSenderTypeEnum = pgEnum('inbox_message_sender_type', [
  'system',
  'agent',
  'user',
  'voice_assistant',
  'remote',
])

export const inboxRecipientTypeEnum = pgEnum('inbox_recipient_type', ['agent', 'user', 'voice_assistant', 'system'])

export const deliveryModeEnum = pgEnum('delivery_mode', ['steer', 'follow-up'])

export const scheduleScopeTypeEnum = pgEnum('schedule_scope_type', ['squad', 'agent'])
export const scheduleFailureClassEnum = pgEnum('schedule_failure_class', ['permanent', 'transient'])
export const scheduleHealthEventKindEnum = pgEnum('schedule_health_event_kind', [
  'failed',
  'recovered',
  'automatically_disabled',
])
export const scheduleAttemptSourceEnum = pgEnum('schedule_attempt_source', ['scheduled', 'manual', 'webhook'])
export const scheduleHealthNotificationKindEnum = pgEnum('schedule_health_notification_kind', [
  'failure',
  'permanent_failure',
  'disabled',
  'recovery',
])
export const scheduleHealthNotificationStatusEnum = pgEnum('schedule_health_notification_status', [
  'pending',
  'delivering',
  'delivered',
])

export const monitorStatusEnum = pgEnum('monitor_status', [
  'starting',
  'running',
  'canceling',
  'exited',
  'canceled',
  'timed-out',
  'failed',
  'overload',
])

export const squadActivityAccessScopeEnum = pgEnum('squad_activity_access_scope', [
  'agents',
  'workstreams',
  'inbox',
  'workstreams_inbox',
])

export const operationsRecommendationStatusEnum = pgEnum('operations_recommendation_status', [
  'open',
  'acknowledged',
  'dismissed',
  'resolved',
])

export const integrationAuthStateEnum = pgEnum('integration_auth_state', [
  'pending',
  'authenticated',
  'invalid',
  'reauthorization_required',
])
export const integrationProjectionStatusEnum = pgEnum('integration_projection_status', [
  'pending',
  'installing',
  'ready',
  'degraded',
])
export const integrationHealthStateEnum = pgEnum('integration_health_state', [
  'unknown',
  'healthy',
  'degraded',
  'unreachable',
])
export const integrationExportBatchStateEnum = pgEnum('integration_export_batch_state', [
  'pending',
  'processing',
  'retry_wait',
  'delivered',
  'dead_letter',
  'canceled',
])

// Tables
export const skills = pgTable('skills', {
  id: varchar('id', { length: 100 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  content: text('content').notNull(),
  supportFiles: jsonb('support_files').notNull().default({}),
  yamlTemplate: jsonb('yaml_template'),
  yamlFieldOverrides: jsonb('yaml_field_overrides').notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  requiredPermission: text('required_permission'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

/**
 * Shared prompt blocks appended to agent type prompts at runtime. Synced from
 * config/agent-types/shared/*.md with the same template/override model as
 * skills, so admins can edit a block once for every type that includes it.
 */
export const sharedPrompts = pgTable('shared_prompts', {
  id: varchar('id', { length: 100 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  content: text('content').notNull(),
  yamlTemplate: jsonb('yaml_template'),
  yamlFieldOverrides: jsonb('yaml_field_overrides').notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const modelTiers = pgTable('model_tiers', {
  slug: varchar('slug', { length: 100 }).primaryKey(),
  label: varchar('label', { length: 200 }).notNull(),
  description: text('description'),
  chain: text('chain').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  yamlTemplate: jsonb('yaml_template'),
  yamlFieldOverrides: jsonb('yaml_field_overrides').notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const agentTypes = pgTable('agent_types', {
  systemOnly: boolean('system_only').notNull().default(false),
  id: varchar('id', { length: 100 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  model: varchar('model', { length: 500 }).notNull(),
  tier: varchar('tier', { length: 100 }),
  systemPrompt: text('system_prompt').notNull(),
  /** Ordered shared_prompts ids composed after systemPrompt at runtime. */
  includes: text('includes').array().notNull().default([]),
  skills: text('skills').array(),
  extensions: text('extensions').array(),
  toolsAllow: text('tools_allow').array(),
  toolsDeny: text('tools_deny').array(),
  extraScopes: text('extra_scopes').array(),
  integrationCapabilities: jsonb('integration_capabilities'),
  earlyMarginTokens: integer('early_margin_tokens'),
  inFlightMarginTokens: integer('in_flight_margin_tokens'),
  yamlTemplate: jsonb('yaml_template'),
  yamlFieldOverrides: jsonb('yaml_field_overrides').notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentTypeId: varchar('agent_type_id', { length: 100 }).notNull(),
    squadId: uuid('squad_id').references((): AnyPgColumn => squads.id, { onDelete: 'set null' }),
    // Owning user for private agents (system-managers). NULL for shared squad agents.
    // Cascade-delete: a user's private system-managers are removed with the user.
    ownerUserId: uuid('owner_user_id').references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    parentAgentId: uuid('parent_agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'cascade' }),
    status: agentStatusEnum('status').notNull().default('idle'),
    persist: boolean('persist').notNull().default(false),
    modelOverride: varchar('model_override', { length: 500 }),
    /**
     * The actually-selected single model spec (after priority-list fallback).
     * Set at session creation and updated on runtime failover. `null` = not
     * yet selected. Distinct from `modelOverride` (the user/manager-set input)
     * and the agent type's default model.
     */
    selectedModel: varchar('selected_model', { length: 500 }),
    metadata: jsonb('metadata'),
    context: jsonb('context').notNull().default({}),
    questionData: jsonb('question_data'),
    sessionUsage: jsonb('session_usage'),
    dormantAt: timestamp('dormant_at'),
    terminatedAt: timestamp('terminated_at'),
    // Set when a terminate is requested while the agent is mid-execution; the
    // execution-completion listener performs the actual terminate once it goes idle.
    pendingDormancyAt: timestamp('pending_dormancy_at'),
    // Federation: the globally-addressable handle this agent publishes to peers
    // (the `<handle>` in amtp://<instanceId>/<handle>). Nullable + unique. The
    // per-agent public key is threaded for Slice 5 agentSig verification and is
    // opaque/unverified in Slice 3.
    amtpHandle: varchar('amtp_handle', { length: 200 }).unique(),
    // SPKI public PEM of the agent's constant Ed25519 identity (private key on disk
    // at /private/.tau/identity.pem). Renamed from federation_public_key in Slice 5.
    identityPublicKey: text('identity_public_key'),
    // Receive gate (D3): registering a handle is addressable; inbound also requires
    // the agent be open (self) or an operator allow-rule. Default-CLOSED.
    inboundOpen: boolean('inbound_open').notNull().default(false),
    // The agent's published signed AMTP card (spec §4.6), stored verbatim as
    // authored+signed in-sandbox. Cleared on unregister and on identity re-key
    // (the signature no longer verifies). NULL = no card published.
    cardJson: jsonb('card_json').$type<AmtpSignedAgentCard>(),
    // VM sandbox runtime (machines): the machine this agent's box is pinned to,
    // when explicitly placed. NULL = unpinned (placement picks the shared
    // machine at ensure time). Set-null on machine removal so a de-registered
    // machine never dangles a reference; the box row itself cascades separately.
    machineId: uuid('machine_id').references((): AnyPgColumn => machines.id, { onDelete: 'set null' }),
    // Denormalized conversation summary, maintained by refreshAgentActivity()
    // (services/agents/activity-summary.ts) on every write that can change it.
    //
    // These were three CORRELATED SUBQUERIES over `messages` in
    // agentSelectColumns, evaluated once per agent row on every agent select.
    // Measured on a live tenant: 5.5 BILLION tuples read from a 2,474-row
    // agents table, ~163ms per call at 96 rows, and roughly 18.6 hours of
    // cumulative database time — while the box itself sat 85% idle.
    //
    // They cannot be indexed away: the sort expression casts
    // metadata->>'consumedAt' to timestamptz and date_truncs a timestamptz,
    // both STABLE, so Postgres rejects an index on it ("functions in index
    // expression must be marked IMMUTABLE" — verified, not assumed). Reads
    // outnumber writes here by orders of magnitude, so the work moves to the
    // write side.
    lastMessageAt: timestamp('last_message_at'),
    lastHumanMessageAt: timestamp('last_human_message_at'),
    lastMessagePreview: text('last_message_preview'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_agents_parent_agent_id').on(table.parentAgentId),
    index('idx_agents_squad_id').on(table.squadId),
    index('idx_agents_top_level_squad_status_created')
      .on(table.squadId, table.status, table.createdAt, table.id)
      .where(sql`${table.parentAgentId} IS NULL`)
      .concurrently(),
  ]
)

export const executions = pgTable(
  'executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: executionStatusEnum('status').notNull().default('queued'),
    maintenanceGeneration: integer('maintenance_generation'),
    maintenanceQueuedAt: timestamp('maintenance_queued_at', { withTimezone: true }),
    runnerClaimToken: uuid('runner_claim_token'),
    runnerClaimGeneration: integer('runner_claim_generation'),
    executionVersion: integer('execution_version').notNull().default(0),
    startupRetryCount: integer('startup_retry_count').notNull().default(0),
    startupRetryAt: timestamp('startup_retry_at', { withTimezone: true }),
    message: text('message'),
    imageIds: uuid('image_ids').array(),
    wakeEligible: boolean('wake_eligible').notNull().default(true),
    usage: jsonb('usage'),
    flowContext: jsonb('flow_context').$type<{ workStreamId: string; attemptId: number; stepId: string }>(),
    error: text('error'),
    /** Structural failure classification; only ever written together with status='failed'. */
    failureClass: executionFailureClassEnum('failure_class'),
    /** Bounded machine-readable reason code (<=64 chars) for the failure class. */
    failureReason: varchar('failure_reason', { length: 64 }),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    runStartedAt: timestamp('run_started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at'),
  },
  (table) => [
    index('idx_executions_status_started_at').on(table.status, table.startedAt),
    // Covers runtime totals without fetching execution history from the heap.
    index('idx_executions_agent_runtime')
      .on(table.agentId, table.status, table.startedAt, table.endedAt)
      .concurrently(),
    index('idx_executions_waiting_maintenance_fifo')
      .on(table.startedAt, table.id)
      .where(sql`${table.status} = 'waiting-maintenance'`)
      .concurrently(),
  ]
)

/**
 * Append-only ledger of stored-secret detections at tool boundaries.
 *
 * One row per (tool call, secret key): the pre-call wrapper writes `denied`
 * before `tool.execute` ever runs, and the inbound output wrapper writes
 * `already_executed` when a stored value appears in content the original tool
 * already returned. Deliberately content-free: only identity columns, the
 * Secret Store key name, and the outcome. Never a value, substring, hash,
 * equality probe, payload, or tool-call id.
 *
 * Deliberately no foreign keys: cascade would erase retained audit history on
 * entity deletion, set-null would violate required identity, and restrict
 * would let retention block deletion.
 */
export const storedSecretToolAudits = pgTable(
  'stored_secret_tool_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    secretKey: text('secret_key').notNull(),
    outcome: varchar('outcome', { length: 24 }).notNull().$type<'denied' | 'already_executed'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_stored_secret_tool_audits_execution_created').on(table.executionId, table.createdAt),
    check('stored_secret_tool_audits_outcome_valid', sql`${table.outcome} IN ('denied', 'already_executed')`),
  ]
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata'),
    // Stored by Postgres so repair indexes can return IDs without reading message JSON.
    activityExecutionId: text('activity_execution_id').generatedAlwaysAs(sql`metadata->>'executionId'`),
    pending: boolean('pending').notNull().default(false),
    injectedAt: timestamp('injected_at'),
    // Nullable only while startup performs the bounded legacy backfill.
    enqueueOrder: bigint('enqueue_order', { mode: 'bigint' }).default(
      sql`nextval('message_enqueue_order_seq'::regclass)`
    ),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_messages_enqueue_order_unique').on(table.enqueueOrder).concurrently(),
    index('idx_messages_agent_id_created_at').on(table.agentId, table.createdAt),
    index('idx_messages_agent_id_role_created_at').on(table.agentId, table.role, table.createdAt),
    index('idx_messages_pending_uninjected')
      .on(table.agentId, table.createdAt)
      .where(sql`${table.pending} = true AND ${table.injectedAt} IS NULL`),
    index('idx_messages_pending_uninjected_fifo')
      .on(table.agentId, table.createdAt, table.enqueueOrder)
      .concurrently()
      .where(sql`${table.pending} = true AND ${table.injectedAt} IS NULL`),
    // "Most recent attributed chat message for an agent" (work-stream auto-attribution). Partial so it
    // holds only real user chat messages — excludes assistant turns and unattributed human rows like
    // inbox deliveries (no metadata.sender) — so the lookup is one index hit even on long-running agents.
    uniqueIndex('idx_messages_agent_client_id_unique')
      .on(table.agentId, sql`(${table.metadata}->>'clientId')`)
      .where(sql`${table.role} = 'human' AND (${table.metadata}->>'clientId') IS NOT NULL`)
      .concurrently(),
    index('idx_messages_agent_chat_sender')
      .on(table.agentId, table.createdAt)
      .where(sql`${table.role} = 'human' AND (${table.metadata}->'sender'->>'userId') IS NOT NULL`),
    // A sparse execution must not scan the agent's entire assistant transcript to satisfy LIMIT 20.
    index('idx_messages_agent_execution')
      .on(table.agentId, sql`(${table.metadata}->>'executionId')`, table.createdAt, table.id)
      .concurrently()
      .where(sql`${table.role} = 'assistant' AND (${table.metadata}->>'executionId') IS NOT NULL`),
    index('idx_messages_chat_source_page')
      .on(table.activityExecutionId, table.createdAt)
      .where(sql`${table.role} = 'assistant' AND ${table.metadata} ? 'executionId'`)
      .concurrently(),
    index('idx_messages_agent_stream_group')
      .on(table.agentId, sql`(${table.metadata}->>'streamGroupId')`)
      .where(sql`${table.role} = 'assistant' AND (${table.metadata}->>'streamGroupId') IS NOT NULL`),
    index('idx_messages_agent_stream_group_pattern')
      .using('btree', table.agentId, sql`(${table.metadata}->>'streamGroupId') text_pattern_ops`)
      .concurrently()
      .where(sql`${table.role} = 'assistant' AND (${table.metadata}->>'streamGroupId') IS NOT NULL`),
    index('idx_messages_agent_inbox_consumed')
      .on(table.agentId, sql`(${table.metadata}->>'consumedAt')`)
      .where(sql`${table.metadata}->>'source' = 'inbox' AND (${table.metadata}->>'consumedAt') IS NOT NULL`),
    uniqueIndex('idx_messages_agent_sandbox_recovery_unique')
      .on(
        table.agentId,
        sql`(${table.metadata}->>'sandboxId')`,
        sql`(${table.metadata}->>'recoveryEpisodeId')`,
        sql`(${table.metadata}->>'recoveryNotificationKind')`
      )
      .concurrently()
      .where(sql`${table.role} = 'human' AND ${table.metadata}->>'source' = 'sandbox-recovery'`),
  ]
)

export const sandboxRecoveryEpisodes = pgTable(
  'sandbox_recovery_episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sandboxId: varchar('sandbox_id', { length: 255 }).notNull(),
    generation: integer('generation').notNull(),
    reason: text('reason'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    endedAt: timestamp('ended_at'),
    outcome: varchar('outcome', { length: 16 }).$type<'recovered' | 'gave_up'>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_sandbox_recovery_episode_generation_unique').on(table.sandboxId, table.generation),
    uniqueIndex('idx_sandbox_recovery_episode_open_unique')
      .on(table.sandboxId)
      .where(sql`${table.endedAt} IS NULL`),
  ]
)

export const sandboxRecoverySubscriptions = pgTable(
  'sandbox_recovery_subscriptions',
  {
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => sandboxRecoveryEpisodes.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 })
      .$type<'watching' | 'pending' | 'delivering' | 'delivered'>()
      .notNull()
      .default('watching'),
    notificationKind: varchar('notification_kind', { length: 32 }).$type<'recovered' | 'still_unavailable'>(),
    content: text('content'),
    recordOnly: boolean('record_only').notNull().default(false),
    crashCharged: boolean('crash_charged').notNull().default(false),
    claimToken: uuid('claim_token'),
    claimedAt: timestamp('claimed_at'),
    notificationClientId: varchar('notification_client_id', { length: 128 }),
    deliveryMessageId: uuid('delivery_message_id').references(() => messages.id, { onDelete: 'set null' }),
    deliveryExecutionId: uuid('delivery_execution_id').references(() => executions.id, { onDelete: 'set null' }),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.episodeId, table.agentId] }),
    index('idx_sandbox_recovery_subscriptions_agent_state').on(table.agentId, table.status),
    index('idx_sandbox_recovery_subscriptions_due').on(table.status, table.claimedAt),
    uniqueIndex('idx_sandbox_recovery_subscriptions_notification_unique')
      .on(table.agentId, table.episodeId, table.notificationKind)
      .where(sql`${table.notificationKind} IS NOT NULL`),
  ]
)

export const chatSendReceipts = pgTable(
  'chat_send_receipts',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    clientId: varchar('client_id', { length: 128 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    state: chatSendReceiptStateEnum('state').notNull().default('pending'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'restrict' }),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'restrict' }),
    disposition: varchar('disposition', { length: 24 }).$type<'turn' | 'intervention'>(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.clientId] })]
)

export const desktopNotifications = pgTable(
  'desktop_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    eventType: text('event_type').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    url: text('url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_desktop_notifications_event').on(table.userId, table.eventKey),
    index('idx_desktop_notifications_recent').on(table.userId, table.createdAt),
  ]
)

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idx_push_subscriptions_endpoint_unique').on(table.endpoint)]
)

// Durable, provider-neutral cursors for integration event polling.
export const integrationEventPollingCursors = pgTable(
  'integration_event_polling_cursors',
  {
    providerKey: varchar('provider_key', { length: 100 }).notNull(),
    resourceKey: text('resource_key').notNull(),
    cursor: jsonb('cursor').$type<Record<string, unknown>>(),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.providerKey, table.resourceKey] }),
    index('idx_integration_event_polling_due').on(table.nextPollAt, table.leaseUntil),
  ]
)

// Durable, provider-neutral once-per-logical-event claims for synthetic polling dispatch.
export const integrationEventPollingDispatches = pgTable(
  'integration_event_polling_dispatches',
  {
    providerKey: varchar('provider_key', { length: 100 }).notNull(),
    eventKey: text('event_key').notNull(),
    activityId: uuid('activity_id'),
    // Squads whose polling watch observed this shared provider event. This durable
    // routing provenance prevents repair from attributing by repo/PR coordinates alone.
    activitySquadIds: uuid('activity_squad_ids')
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    eventFact: jsonb('event_fact').$type<GitHubPrDispatchFact | GitHubIssueDispatchFact>(),
    eventOccurredAt: timestamp('event_occurred_at', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.providerKey, table.eventKey] }),
    index('idx_integration_event_polling_dispatch_lease').on(table.completedAt, table.leaseUntil),
    uniqueIndex('idx_integration_dispatch_activity_id')
      .on(table.activityId)
      .where(sql`${table.activityId} IS NOT NULL`)
      .concurrently(),
    index('idx_integration_dispatch_activity_scan')
      .on(table.providerKey, table.eventOccurredAt, table.activityId)
      .where(
        sql`${table.completedAt} IS NOT NULL AND ${table.eventFact} IS NOT NULL AND ${table.activityId} IS NOT NULL`
      )
      .concurrently(),
  ]
)

export const squadActivity = pgTable(
  'squad_activity',
  {
    squadId: uuid('squad_id').notNull(),
    lane: integer('lane').notNull(),
    rowId: uuid('row_id').notNull(),
    sourceFamily: varchar('source_family', { length: 32 }).notNull(),
    sourceGroupId: text('source_group_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    agentId: uuid('agent_id'),
    workStreamId: uuid('work_stream_id'),
    agentTypeId: varchar('agent_type_id', { length: 100 }),
    agentTypeRequiresAgentsRead: boolean('agent_type_requires_agents_read').notNull().default(false),
    kind: varchar('kind', { length: 32 }).$type<SquadActivityKind>().notNull(),
    summary: varchar('summary', { length: 512 }).notNull(),
    preview: jsonb('preview').$type<import('@ficus/shared').ActivityPreviewSpan[]>().notNull().default([]),
    ref: jsonb('ref').$type<SquadActivityRef>().notNull(),
    quietEligible: boolean('quiet_eligible').notNull(),
    accessScope: squadActivityAccessScopeEnum('access_scope').notNull(),
    inboxRecipientId: uuid('inbox_recipient_id'),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.squadId, table.lane, table.rowId] }),
    check('squad_activity_lane_check', sql`${table.lane} IN (10,20,21,22,30,31,40,41,50,60,61,70,71)`),
    check(
      'squad_activity_lane_kind_check',
      sql`(${table.lane}=10 AND ${table.kind}='message') OR (${table.lane}=20 AND ${table.kind}='message') OR (${table.lane}=21 AND ${table.kind}='message') OR (${table.lane}=22 AND ${table.kind}='subagent') OR (${table.lane}=30 AND ${table.kind}='workstream') OR (${table.lane}=31 AND ${table.kind}='workstream') OR (${table.lane}=40 AND ${table.kind}='wait') OR (${table.lane}=41 AND ${table.kind}='wait') OR (${table.lane}=50 AND ${table.kind}='handoff') OR (${table.lane}=60 AND ${table.kind}='execution') OR (${table.lane}=61 AND ${table.kind}='execution') OR (${table.lane}=70 AND ${table.kind}='pr') OR (${table.lane}=71 AND ${table.kind}='issue')`
    ),
    check(
      'squad_activity_lane_scope_check',
      sql`(${table.lane}=10 AND ${table.accessScope}='agents') OR (${table.lane}=20 AND ${table.accessScope}='inbox') OR (${table.lane}=21 AND ${table.accessScope}='inbox') OR (${table.lane}=22 AND ${table.accessScope}='inbox') OR (${table.lane}=30 AND ${table.accessScope}='workstreams') OR (${table.lane}=31 AND ${table.accessScope}='workstreams_inbox') OR (${table.lane}=40 AND ${table.accessScope}='workstreams') OR (${table.lane}=41 AND ${table.accessScope}='workstreams') OR (${table.lane}=50 AND ${table.accessScope}='workstreams_inbox') OR (${table.lane}=60 AND ${table.accessScope}='agents') OR (${table.lane}=61 AND ${table.accessScope}='agents') OR (${table.lane}=70 AND ${table.accessScope}='workstreams') OR (${table.lane}=71 AND ${table.accessScope}='workstreams')`
    ),
    check(
      'squad_activity_recipient_check',
      sql`(${table.inboxRecipientId} IS NOT NULL) = (${table.accessScope} IN ('inbox','workstreams_inbox'))`
    ),

    index('idx_squad_activity_source_group').on(table.sourceFamily, table.sourceGroupId),
    index('idx_squad_activity_source_window').on(table.sourceFamily, table.at, table.sourceGroupId),
    index('idx_squad_activity_work_stream').on(table.workStreamId),
    index('idx_squad_activity_feed').on(table.squadId, table.at.desc(), table.lane.desc(), table.rowId.desc()),
    index('idx_squad_activity_kind').on(
      table.squadId,
      table.kind,
      table.at.desc(),
      table.lane.desc(),
      table.rowId.desc()
    ),
    index('idx_squad_activity_agent')
      .on(table.squadId, table.agentId, table.at.desc(), table.lane.desc(), table.rowId.desc())
      .where(sql`${table.agentId} IS NOT NULL`),
    index('idx_squad_activity_inbox')
      .on(table.squadId, table.inboxRecipientId, table.at.desc(), table.lane.desc(), table.rowId.desc())
      .where(sql`${table.inboxRecipientId} IS NOT NULL`),
    index('idx_squad_activity_prune').on(table.at, table.squadId, table.lane, table.rowId),
  ]
)

export const squadActivityMaintenanceLeases = pgTable('squad_activity_maintenance_leases', {
  task: varchar('task', { length: 64 }).primaryKey(),
  leaseToken: uuid('lease_token').notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Convergence-sweep watermarks (task='repair'). The row outlives any single
   * lease — release deletes it, so the watermark write re-inserts it as an
   * already-expired lease — and both columns stay null until a sweep with zero
   * errors advances them.
   */
  lastIncrementalScanTo: timestamp('last_incremental_scan_to', { withTimezone: true }),
  lastFullScanTo: timestamp('last_full_scan_to', { withTimezone: true }),
})

// Webhook events for audit/debugging
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 50 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull(),
    headers: jsonb('headers').notNull(),
    signature: text('signature'),
    verified: boolean('verified').notNull().default(false),
    activitySquadIds: uuid('activity_squad_ids')
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    processedAt: timestamp('processed_at'),
    error: text('error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_webhook_events_verified_repo_delivery')
      .on(table.provider, sql`lower(${table.payload}->'repository'->>'full_name')`, table.createdAt.desc())
      .where(sql`${table.verified} = true AND (${table.payload}->'repository'->>'full_name') IS NOT NULL`)
      .concurrently(),
    index('idx_webhook_events_verified_created_id')
      .on(table.provider, table.createdAt, table.id)
      .where(sql`${table.verified} = true`)
      .concurrently(),
  ]
)

// Images table for chat attachments and squad avatars
export const images = pgTable('images', {
  id: uuid('id').primaryKey().defaultRandom(),

  // File info
  filename: varchar('filename', { length: 255 }).notNull(), // UUID.ext on disk
  mimeType: varchar('mime_type', { length: 100 }).notNull(),
  size: integer('size').notNull(), // bytes

  // Origin tracking (nullable - set based on context: an agent conversation, or a squad
  // avatar, etc.). Non-agent images (e.g. squad avatars) carry a squadId instead so they're
  // still scoped + cleaned up with their squad.
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  squadId: uuid('squad_id').references((): AnyPgColumn => squads.id, { onDelete: 'cascade' }),
  uploadedByUserId: uuid('uploaded_by_user_id').references((): AnyPgColumn => users.id, {
    onDelete: 'set null',
  }),

  // Status tracking
  status: imageStatusEnum('status').notNull().default('pending'),
  usedAt: timestamp('used_at'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const agentFileAttachments = pgTable(
  'agent_file_attachments',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sandboxId: text('sandbox_id').notNull(),
    uploadedByType: varchar('uploaded_by_type', { length: 32 }).notNull(),
    uploadedById: varchar('uploaded_by_id', { length: 200 }).notNull(),
    originalName: varchar('original_name', { length: 500 }).notNull(),
    storedName: varchar('stored_name', { length: 255 }).notNull(),
    privatePath: text('private_path').notNull(),
    contentType: varchar('content_type', { length: 255 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    status: agentFileAttachmentStatusEnum('status').notNull().default('pending'),
    uploadAttemptId: uuid('upload_attempt_id'),
    usedAt: timestamp('used_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('idx_agent_file_attachments_agent').on(table.agentId)]
)

export const messageAgentFileAttachments = pgTable(
  'message_agent_file_attachments',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => agentFileAttachments.id),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.attachmentId] })]
)

// Squad Presets table
export const squadPresets = pgTable('squad_presets', {
  workflows: jsonb('workflows').$type<import('@ficus/shared').SquadPresetWorkflows>(),
  id: varchar('id', { length: 100 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  purpose: text('purpose'),
  defaultAgents: text('default_agents').array().notNull().default([]),
  managerInstructions: text('manager_instructions'),
  scheduleTemplates: jsonb('schedule_templates').notNull().default([]),
  yamlTemplate: jsonb('yaml_template'),
  yamlFieldOverrides: jsonb('yaml_field_overrides').notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Workflow catalog. Inline stream definitions do not create catalog entries.
export const workflows = pgTable('workflows', {
  scope: jsonb('scope').$type<import('@ficus/shared').WorkflowScope>().notNull().default({ kind: 'instance' }),
  id: varchar('id', { length: 100 }).primaryKey(),
  description: text('description'),
  definition: jsonb('definition').$type<WorkflowDefinition>().notNull(),
  yamlTemplate: jsonb('yaml_template'),
  yamlFieldOverrides: jsonb('yaml_field_overrides').$type<string[]>().notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Squads table
export const squads = pgTable('squads', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  purpose: text('purpose').notNull(),
  status: squadStatusEnum('status').notNull().default('active'),
  // Creation provenance only: deleting a preset must not erase this ID or affect the squad.
  squadPresetId: varchar('squad_preset_id', { length: 100 }),
  defaultAgents: text('default_agents').array().notNull().default([]),
  managerAgentId: uuid('manager_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  context: text('context'),
  typeContext: jsonb('type_context').$type<Record<string, string>>(),
  isAnonymous: boolean('is_anonymous').notNull().default(false),
  globalCollaborationEnabled: boolean('global_collaboration_enabled').notNull().default(false),
  order: integer('order').notNull().default(0),
  metadata: jsonb('metadata').notNull().default({}),
  // Max simultaneously-admitted work streams (status 'active').
  // NULL = unlimited (legacy behavior); excess creations land in 'queued'.
  maxConcurrentWorkStreams: integer('max_concurrent_work_streams'),
  // Auto-park grace: an active stream with an open wait older than this many
  // minutes is parked (-> queued) by the admission maintenance pass.
  // NULL -> default 30; 0 = park immediately. Negative rejected at the API.
  blockedGraceMinutes: integer('blocked_grace_minutes'),
  sandboxStatus: sandboxStatusEnum('sandbox_status').notNull().default('none'),
  avatarImageId: uuid('avatar_image_id').references((): AnyPgColumn => images.id, { onDelete: 'set null' }),
  // VM sandbox runtime (machines): the machine this squad's box is pinned to,
  // when explicitly placed. NULL = unpinned (placement picks the shared machine
  // at ensure time). Set-null on machine removal so a de-registered machine
  // never dangles a reference; the box row itself cascades separately.
  machineId: uuid('machine_id').references((): AnyPgColumn => machines.id, { onDelete: 'set null' }),
  // Host sandbox runtime only: absolute directory on the core's machine this
  // squad's workspace lives in (NULL = <HOME_DIR>/workspaces/squads/<id>).
  // Stored on any runtime, honoured only by FICUS_SANDBOX_RUNTIME=host. Ficus never
  // deletes this directory.
  hostWorkspacePath: text('host_workspace_path'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  archivedAt: timestamp('archived_at'),
})

export const sandboxToolchainProvisions = pgTable(
  'sandbox_toolchain_provisions',
  {
    sandboxId: varchar('sandbox_id', { length: 255 }).primaryKey(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    desiredFingerprint: varchar('desired_fingerprint', { length: 64 }).notNull(),
    appliedFingerprint: varchar('applied_fingerprint', { length: 64 }),
    status: varchar('status', { length: 32 })
      .$type<'pending' | 'installing' | 'running_setup' | 'ready' | 'failed'>()
      .notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    exitCode: integer('exit_code'),
    startedAt: timestamp('started_at'),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (table) => ({
    squadIdx: index('sandbox_toolchain_provisions_squad_idx').on(table.squadId),
    terminalCleanupIdx: index('sandbox_toolchain_provisions_terminal_cleanup_idx')
      .on(table.completedAt, table.sandboxId)
      .where(sql`${table.status} in ('ready', 'failed')`),
    orphanCleanupIdx: index('sandbox_toolchain_provisions_orphan_cleanup_idx').on(table.updatedAt, table.sandboxId),
  })
)

export const sandboxToolchainActivations = pgTable(
  'sandbox_toolchain_activations',
  {
    sandboxId: varchar('sandbox_id', { length: 255 }).primaryKey(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    appliedFingerprint: varchar('applied_fingerprint', { length: 64 }),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    squadIdx: index('sandbox_toolchain_activations_squad_idx').on(table.squadId),
    updatedIdx: index('sandbox_toolchain_activations_updated_idx').on(table.updatedAt, table.sandboxId),
  })
)

export const squadSecretExposures = pgTable(
  'squad_secret_exposures',
  {
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    secretKey: varchar('secret_key', { length: 255 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: unique().on(table.squadId, table.secretKey),
    squadIdx: index('squad_secret_exposures_squad_idx').on(table.squadId),
    secretKeyIdx: index('squad_secret_exposures_secret_key_idx').on(table.secretKey),
  })
)

export const globalSecretExposures = pgTable(
  'global_secret_exposures',
  {
    secretKey: varchar('secret_key', { length: 255 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: unique().on(table.secretKey),
    secretKeyIdx: index('global_secret_exposures_secret_key_idx').on(table.secretKey),
  })
)

export const localDeployments = pgTable(
  'local_deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    sandboxId: varchar('sandbox_id', { length: 255 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    port: integer('port').notNull(),
    /**
     * The scope within which this deployment's port must be unique:
     * `machine:<machineId>` on the VM runtime (all boxes share one loopback),
     * `sandbox:<sandboxId>` on docker/k8s (each sandbox has its own namespace).
     * Backfilled to the sandbox form for pre-existing rows, which preserves the
     * legality of every deployment that exists today.
     */
    portScope: text('port_scope').notNull().default(''),
    targetHost: varchar('target_host', { length: 255 }).notNull(),
    browserAccessToken: varchar('browser_access_token', { length: 255 }),
    visibility: localDeploymentVisibilityEnum('visibility').notNull().default('private'),
    mode: localDeploymentModeEnum('mode').notNull().default('managed'),
    status: localDeploymentStatusEnum('status').notNull().default('starting'),
    keepSandboxAlive: boolean('keep_sandbox_alive').notNull().default(true),
    command: text('command'),
    cwd: text('cwd'),
    /** Attached deployments only: absolute sandbox-side log file Ficus tails. */
    logPath: text('log_path'),
    envSecretRefs: text('env_secret_refs').array(),
    processId: varchar('process_id', { length: 255 }),
    restartPolicy: localDeploymentRestartPolicyEnum('restart_policy').notNull().default('always'),
    restartCount: integer('restart_count').notNull().default(0),
    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    archivedAt: timestamp('archived_at'),
    expiresAt: timestamp('expires_at'),
  },
  (table) => [
    index('local_deployments_squad_idx').on(table.squadId),
    index('local_deployments_status_idx').on(table.status),
    // A port is unique within its NETWORK SCOPE, not globally. Docker and k8s
    // give each sandbox its own namespace, so two squads both using 3000 is
    // legitimate and works today — a global rule would break every existing
    // instance. A VM machine runs every box as a user on ONE host sharing one
    // loopback, so there the scope is the machine: two live deployments on one
    // port collide, and a tokenized URL could reach the wrong squad's app.
    //
    // `portScope` carries that scope (`machine:<id>` or `sandbox:<id>`), so the
    // invariant is expressed once, in the runtime's own terms. The service
    // checks before inserting; this index is what makes two CONCURRENT creates
    // race to one answer instead of both succeeding. Archived rows are excluded:
    // they hold nothing and their ports are reusable.
    uniqueIndex('local_deployments_live_port_scope_uniq')
      .on(table.portScope, table.port)
      .where(sql`archived_at is null`),
  ]
)

export const appDeployments = pgTable(
  'app_deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull().default('deployment'),
    provider: varchar('provider', { length: 100 }).notNull(),
    externalProjectId: text('external_project_id'),
    url: text('url'),
    providerProjectUrl: text('provider_project_url'),
    environment: appDeploymentEnvironmentEnum('environment').notNull().default('preview'),
    status: appDeploymentStatusEnum('status').notNull().default('planned'),
    costRisk: appDeploymentCostRiskEnum('cost_risk').notNull().default('none'),
    logsCommand: text('logs_command'),
    rollbackCommand: text('rollback_command'),
    metadata: jsonb('metadata').notNull().default({}),
    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('app_deployments_squad_idx').on(table.squadId),
    index('app_deployments_provider_idx').on(table.provider),
  ]
)

// Squad relationships table
export const squadRelationships = pgTable(
  'squad_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceSquadId: uuid('source_squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    targetSquadId: uuid('target_squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    relationshipType: squadRelationshipTypeEnum('relationship_type').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // Only one relationship of each type between the same pair of squads
    unique().on(table.sourceSquadId, table.targetSquadId, table.relationshipType),
  ]
)

export const squadMemoryGrants = pgTable(
  'squad_memory_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceSquadId: uuid('source_squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    granteeSquadId: uuid('grantee_squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    policy: jsonb('policy').notNull().default({}),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_squad_memory_grants_grantee').on(table.granteeSquadId),
    index('idx_squad_memory_grants_source').on(table.sourceSquadId),
  ]
)

export const memoryAccessAudit = pgTable(
  'memory_access_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callerSquadId: uuid('caller_squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    sourceSquadId: uuid('source_squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    callerAgentId: uuid('caller_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourcePath: text('resource_path'),
    resultCount: integer('result_count'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_memory_access_audit_caller').on(table.callerSquadId, table.createdAt),
    index('idx_memory_access_audit_source').on(table.sourceSquadId, table.createdAt),
  ]
)

export const workStreamNumberSequence = pgSequence('work_stream_number_seq', { maxValue: 2147483647 })

// Work Streams table
export const workStreams = pgTable(
  'work_streams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: integer('number')
      .notNull()
      .default(sql`nextval('work_stream_number_seq')`)
      .unique(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description').notNull().default(''),
    status: workStreamStatusEnum('status').notNull().default('active'),
    // Existing rows retain their worktree. New creation opts in explicitly.
    autoCleanupWorktree: boolean('auto_cleanup_worktree').notNull().default(false),
    pause: jsonb('pause').$type<import('@ficus/shared').WorkStreamPause>(),
    priority: workStreamPriorityEnum('priority').notNull().default('normal'),
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    ownerAgentId: uuid('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // The agent that created this work stream (provenance). Null for user-created streams.
    creatorAgentId: uuid('creator_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // The human user who requested this work stream (provenance). Immutable; not reassigned on
    // agent hand-off. Lets agents address the requester's personal inbox.
    requestingUserId: uuid('requesting_user_id').references(() => users.id, { onDelete: 'set null' }),
    agentIds: uuid('agent_ids').array(),
    assignedReviewerIds: uuid('assigned_reviewer_ids').array().notNull().default([]),
    dependsOn: uuid('depends_on').array().notNull().default([]),
    handoffMessage: text('handoff_message'),
    files: jsonb('files').notNull().default([]),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_work_streams_squad_created_at').on(table.squadId, table.createdAt),
    index('idx_work_streams_status_updated_at').on(table.status, table.updatedAt),
  ]
)

/** Server-owned creation provenance. Never derived from editable work-stream metadata. */
export const workStreamWorktrees = pgTable(
  'work_stream_worktrees',
  {
    workStreamId: uuid('work_stream_id')
      .primaryKey()
      .references(() => workStreams.id, { onDelete: 'cascade' }),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    ownership: jsonb('ownership')
      .$type<import('../services/work-streams/repository-setup').WorktreeOwnership>()
      .notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idx_owned_worktree_path').on(table.squadId, sql`(${table.ownership}->>'worktree')`)]
)

/** Durable done-transition outbox; a removing operation is never released merely by lease expiry. */
export const worktreeCleanupJobs = pgTable(
  'worktree_cleanup_jobs',
  {
    workStreamId: uuid('work_stream_id')
      .primaryKey()
      .references(() => workStreams.id, { onDelete: 'cascade' }),
    status: text('status')
      .$type<'pending' | 'deferred' | 'skipped' | 'removing' | 'succeeded' | 'error'>()
      .notNull()
      .default('pending'),
    // Invalidates snapshots from an earlier delivery or retention decision.
    generation: uuid('generation').notNull().defaultRandom(),
    reason: text('reason'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
    deliveredHead: text('delivered_head'),
    deliveryMetadata: jsonb('delivery_metadata').$type<Record<string, unknown>>(),
    operationId: uuid('operation_id'),
    removalInput:
      jsonb('removal_input').$type<import('../services/work-streams/worktree-cleanup-runtime').WorktreeRemovalInput>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [index('idx_worktree_cleanup_due').on(table.status, table.nextAttemptAt)]
)

// Prepared flows are not dispatched until execution integration activates them.
export const workStreamFlowRuns = pgTable('work_stream_flow_runs', {
  activated: boolean('activated').notNull().default(false),
  participantSnapshots: jsonb('participant_snapshots')
    .$type<Record<string, typeof agentTypes.$inferSelect>>()
    .notNull()
    .default({}),
  attemptAgents: jsonb('attempt_agents').$type<Record<string, string>>().notNull().default({}),
  workStreamId: uuid('work_stream_id')
    .primaryKey()
    .references(() => workStreams.id, { onDelete: 'cascade' }),
  createRequestId: uuid('create_request_id').notNull(),
  createRequestHash: varchar('create_request_hash', { length: 64 }).notNull(),
  source: jsonb('source').$type<ResolvedWorkflow>().notNull(),
  state: jsonb('state').$type<WorkflowRun>().notNull(),
  version: integer('version').notNull().default(0),
  // Immutable provenance only; this text confers no execution authority.
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const workflowBindings = pgTable(
  'workflow_bindings',
  {
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    workStreamId: uuid('work_stream_id')
      .notNull()
      .references(() => workStreams.id, { onDelete: 'cascade' }),
    participantId: text('participant_id').notNull(),
    bindingKey: text('binding_key').notNull(),
    agentSnapshot: jsonb('agent_snapshot').$type<typeof agentTypes.$inferSelect>().notNull(),
  },
  (table) => [uniqueIndex('idx_workflow_binding_key').on(table.workStreamId, table.bindingKey)]
)

export const integrationOutputEvents = pgTable(
  'integration_output_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integration: text('integration').notNull(),
    sourceKey: text('source_key').notNull(),
    eventKey: text('event_key').notNull(),
    authority: jsonb('authority')
      .$type<import('../services/integrations/outputs/types').IntegrationOutputAuthority>()
      .notNull(),
    fact: jsonb('fact').$type<IntegrationOutputFact>().notNull(),
    triggerSquadIds: jsonb('trigger_squad_ids').$type<string[]>().notNull().default([]),
    lastErrorCode: text('last_error_code'),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('integration_output_event_identity').on(table.integration, table.sourceKey, table.eventKey)]
)

export const integrationOutputDeliveries = pgTable(
  'integration_output_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => integrationOutputEvents.id, { onDelete: 'cascade' }),
    workStreamId: uuid('work_stream_id')
      .notNull()
      .references(() => workStreamFlowRuns.workStreamId, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id').notNull(),
    subscription: jsonb('subscription').$type<IntegrationSubscription>().notNull(),
    status: text('status').$type<'pending' | 'queued' | 'delivered' | 'superseded'>().notNull().default('pending'),
    targets: jsonb('targets')
      .$type<Array<{ agentId: string; attemptId?: number; version?: number; inboxId: string }>>()
      .notNull()
      .default([]),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('integration_output_subscription_delivery').on(table.eventId, table.workStreamId, table.subscriptionId),
    index('integration_output_delivery_stream').on(table.workStreamId, table.status),
  ]
)

export const integrationOutputTriggerRuns = pgTable(
  'integration_output_trigger_runs',
  {
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    triggerId: text('trigger_id').notNull(),
    sourceKey: text('source_key').notNull(),
    resourceKey: text('resource_key').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => integrationOutputEvents.id, { onDelete: 'cascade' }),
    workStreamId: uuid('work_stream_id').references(() => workStreams.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.squadId, table.triggerId, table.sourceKey, table.resourceKey] })]
)

export const workStreamFlowTransitions = pgTable(
  'work_stream_flow_transitions',
  {
    workStreamId: uuid('work_stream_id')
      .notNull()
      .references(() => workStreamFlowRuns.workStreamId, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    command: jsonb('command').$type<WorkflowCommand>().notNull(),
    version: integer('version').notNull(),
    stateStatus: text('state_status').$type<WorkflowRun['status']>().notNull(),
    activeAttemptId: integer('active_attempt_id'),
    actorKey: text('actor_key').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workStreamId, table.requestId] }),
    uniqueIndex('idx_work_stream_flow_transition_version').on(table.workStreamId, table.version),
  ]
)

export const workStreamOrderSnapshots = pgTable(
  'work_stream_order_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerKey: text('owner_key').notNull(),
    requestFingerprint: varchar('request_fingerprint', { length: 64 }).notNull(),
    cursorSecret: varchar('cursor_secret', { length: 64 }).notNull(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    nonTerminalCount: integer('non_terminal_count').notNull(),
    terminalTotalCount: integer('terminal_total_count').notNull().default(0),
  },
  (table) => [index('idx_ws_order_snapshots_expires').on(table.expiresAt)]
)

export const workStreamOrderSnapshotItems = pgTable(
  'work_stream_order_snapshot_items',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => workStreamOrderSnapshots.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    workStreamId: uuid('work_stream_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.ordinal] }),
    uniqueIndex('idx_ws_order_snapshot_items_stream').on(table.snapshotId, table.workStreamId),
  ]
)

// Typed, timestamped, open/closed facts about why a work stream cannot
// proceed. `dependsOn` REMAINS the authoritative dependency edge list (graph
// UI, cycle checks); dependency waits are its open/closed projection.
export const workStreamWaits = pgTable(
  'work_stream_waits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workStreamId: uuid('work_stream_id')
      .notNull()
      .references(() => workStreams.id, { onDelete: 'cascade' }),
    type: workStreamWaitTypeEnum('type').notNull(),
    // The dependency stream id or agent_question id; NULL for manual waits.
    // No FK: a dependency may be deleted and question rows live elsewhere.
    referenceId: uuid('reference_id'),
    // Flow-owned decisions must use versioned flow transitions, not generic unblock.
    resolutionHandler: text('resolution_handler').$type<'workflow'>(),
    // Null blocks the stream; otherwise blocks only this durable flow attempt.
    flowAttemptId: integer('flow_attempt_id'),
    message: text('message'),
    createdBy: workStreamWaitCreatedByEnum('created_by').notNull().default('system'),
    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Review waits only: approving a flagged wait completes the stream in the
    // same transaction (the ONE bridge between waits and status). Unflagged
    // review waits are mid-work checkpoints — approval resolves the wait and
    // the stream continues.
    completesOnApproval: boolean('completes_on_approval').notNull().default(true),
    // timestamptz on purpose (unlike the codebase's naive-timestamp default):
    // the auto-park grace comparison runs in SQL against clock_timestamp()
    // (frozen-clock rule: never trust now() after a lock wait).
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    // 'satisfied' | 'answered' | 'approved' | 'sent_back' | 'cleared'
    resolution: text('resolution'),
    resolutionNote: text('resolution_note'),
  },
  (table) => [
    // At most ONE open review wait per stream; other types may have several.
    uniqueIndex('idx_work_stream_waits_one_open_review')
      .on(table.workStreamId)
      .where(sql`${table.type} = 'review' AND ${table.closedAt} IS NULL`),
    // Admissibility reads: open waits by stream.
    index('idx_work_stream_waits_open')
      .on(table.workStreamId)
      .where(sql`${table.closedAt} IS NULL`),
    // Wait closes by reference (dependency completion, question answered).
    index('idx_work_stream_waits_reference').on(table.referenceId),
  ]
)

export type WorkStreamContinuationStatus = 'idle' | 'pending' | 'delivered' | 'exhausted'

export const workStreamContinuations = pgTable(
  'work_stream_continuations',
  {
    workStreamId: uuid('work_stream_id')
      .primaryKey()
      .references(() => workStreams.id, { onDelete: 'cascade' }),
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull().default(1),
    cycleStartedAt: timestamp('cycle_started_at').notNull().defaultNow(),
    // Exclusive progress watermark paired with cycleStartedAt. Intentionally
    // not a foreign key: deleting old executions must not reopen consumed work.
    progressExecutionId: uuid('progress_execution_id'),
    status: varchar('status', { length: 20 }).$type<WorkStreamContinuationStatus>().notNull().default('idle'),
    triggerExecutionId: uuid('trigger_execution_id').references(() => executions.id, { onDelete: 'set null' }),
    normalAttemptCount: integer('normal_attempt_count').notNull().default(0),
    transportAttemptCount: integer('attempt_count').notNull().default(0),
    deliveryAttemptCount: integer('delivery_attempt_count').notNull().default(0),
    clientId: text('client_id'),
    nextAttemptAt: timestamp('next_attempt_at'),
    claimedAt: timestamp('claimed_at'),
    claimToken: uuid('claim_token'),
    deliveryPrompt: text('delivery_prompt'),
    deliveryMessageId: uuid('delivery_message_id').references(() => messages.id, { onDelete: 'set null' }),
    deliveryExecutionId: uuid('delivery_execution_id').references(() => executions.id, { onDelete: 'set null' }),
    lastDeliveredAt: timestamp('last_delivered_at'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [index('idx_work_stream_continuations_due').on(table.status, table.nextAttemptAt)]
)

// Unified Schedules table - supports squad-scoped and agent-scoped schedules
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scopeType: scheduleScopeTypeEnum('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    schedule: jsonb('schedule').notNull(),
    action: jsonb('action').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    triggerCount: integer('trigger_count').notNull().default(0),
    lastTriggeredAt: timestamp('last_triggered_at'),
    lastSkippedAt: timestamp('last_skipped_at'),
    skipCount: integer('skip_count').notNull().default(0),
    lastWebhookTriggerAt: timestamp('last_webhook_trigger_at'),
    nextTriggerAt: timestamp('next_trigger_at'),
    webhookEnabled: boolean('webhook_enabled').notNull().default(false),
    webhookTokenHash: varchar('webhook_token_hash', { length: 64 }), // SHA-256 hash
    lastSuccessAt: timestamp('last_success_at'),
    lastFailureAt: timestamp('last_failure_at'),
    lastRecoveredAt: timestamp('last_recovered_at'),
    failureCount: integer('failure_count').notNull().default(0),
    consecutiveFailureCount: integer('consecutive_failure_count').notNull().default(0),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    lastErrorSummary: varchar('last_error_summary', { length: 500 }),
    automaticallyDisabledAt: timestamp('automatically_disabled_at'),
    automaticDisableReason: varchar('automatic_disable_reason', { length: 500 }),
    openFailureIncidentId: uuid('open_failure_incident_id'),
    activeAttemptId: uuid('active_attempt_id'),
    activeAttemptSource: scheduleAttemptSourceEnum('active_attempt_source'),
    activeAttemptStartedAt: timestamp('active_attempt_started_at'),
    activeAttemptLeaseUntil: timestamp('active_attempt_lease_until'),
    systemKey: varchar('system_key', { length: 200 }).unique(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // `Schedule.listDue()` runs every 30s and is a two-arm OR; Postgres can only
    // reach it with a BitmapOr, and a BitmapOr needs BOTH arms indexable, so
    // these two indexes are a pair — drop either and the whole query falls back
    // to a sequential scan of `schedules`.
    index('idx_schedules_next_trigger_due')
      .on(table.nextTriggerAt)
      .where(sql`${table.enabled} = true AND ${table.nextTriggerAt} IS NOT NULL`),
    // Deliberately NOT partial and deliberately not on the timestamptz value.
    // `(text)::timestamptz` is STABLE, not IMMUTABLE (it reads TimeZone), so
    // Postgres refuses it in both an index expression and an index predicate —
    // the exact `listDue` predicate is unindexable. Indexing the raw jsonb text
    // is immutable and still turns the expiry arm into a bitmap scan over just
    // the schedules that carry an `expiresAt`, with the timestamptz comparison
    // rechecked on the heap. Keeping it non-partial matters: a partial index's
    // expression statistics are collected over the indexed subset only, so
    // `IS NOT NULL` there estimates ~100% of the table and the planner picks the
    // seq scan anyway (measured on a 50k-row table: 418 buffers vs 6).
    index('idx_schedules_schedule_expires_at').on(sql`(${table.schedule}->>'expiresAt')`),
  ]
)

export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sandboxId: varchar('sandbox_id', { length: 200 }).notNull(),
    label: varchar('label', { length: 200 }).notNull(),
    description: text('description'),
    command: text('command').notNull(),
    cwd: varchar('cwd', { length: 500 }),
    status: monitorStatusEnum('status').notNull().default('starting'),
    processId: varchar('process_id', { length: 200 }).notNull(),
    timeoutMs: integer('timeout_ms').notNull(),
    maxBatchLines: integer('max_batch_lines').notNull(),
    maxBatchBytes: integer('max_batch_bytes').notNull(),
    batchDebounceMs: integer('batch_debounce_ms').notNull(),
    exitCode: integer('exit_code'),
    lastBatchAt: timestamp('last_batch_at'),
    linesEmitted: integer('lines_emitted').notNull().default(0),
    bytesEmitted: integer('bytes_emitted').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    failureReason: text('failure_reason'),
    failureKind: varchar('failure_kind', { length: 50 }),
  },
  (table) => [index('idx_monitors_agent_status').on(table.agentId, table.status)]
)

// Unified Inbox table - supports both agent and human recipients
export const inbox = pgTable(
  'inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientType: inboxRecipientTypeEnum('recipient_type').notNull(),
    recipientId: varchar('recipient_id', { length: 200 }).notNull(),
    senderType: inboxMessageSenderTypeEnum('sender_type').notNull(),
    senderId: varchar('sender_id', { length: 200 }),
    subject: varchar('subject', { length: 500 }),
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp('read_at'),
    deliveredAt: timestamp('delivered_at'),
    deliveryMode: deliveryModeEnum('delivery_mode').notNull().default('steer'),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).unique(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_inbox_work_stream_id')
      .on(sql`(${table.metadata}->>'workStreamId')`, table.id)
      .where(sql`(${table.metadata}->>'workStreamId') IS NOT NULL`)
      .concurrently(),
    index('idx_inbox_delivery_pending').on(table.recipientType, table.recipientId, table.readAt, table.deliveredAt),
    index('idx_inbox_recipient_pagination').on(table.recipientType, table.recipientId, table.createdAt, table.id),
    index('idx_inbox_system_pagination').on(table.recipientType, table.createdAt, table.id),
  ]
)

export const scheduleHealthEvents = pgTable(
  'schedule_health_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    attemptId: uuid('attempt_id'),
    incidentId: uuid('incident_id').notNull(),
    kind: scheduleHealthEventKindEnum('kind').notNull(),
    occurredAt: timestamp('occurred_at').notNull(),
    failureClass: scheduleFailureClassEnum('failure_class'),
    errorCode: varchar('error_code', { length: 64 }),
    errorSummary: varchar('error_summary', { length: 500 }),
    consecutiveFailureCount: integer('consecutive_failure_count'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_schedule_health_events_schedule_occurred').on(table.scheduleId, table.occurredAt),
    index('idx_schedule_health_events_schedule_attempt').on(table.scheduleId, table.attemptId),
  ]
)

export const scheduleHealthNotifications = pgTable(
  'schedule_health_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => scheduleHealthEvents.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    kind: scheduleHealthNotificationKindEnum('kind').notNull(),
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'set null' }),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    status: scheduleHealthNotificationStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
    claimToken: uuid('claim_token'),
    claimedAt: timestamp('claimed_at'),
    inboxMessageId: uuid('inbox_message_id').references(() => inbox.id, { onDelete: 'set null' }),
    deliveredAt: timestamp('delivered_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.incidentId, table.kind),
    unique().on(table.idempotencyKey),
    index('idx_schedule_health_notifications_due').on(table.status, table.nextAttemptAt),
  ]
)

export type FleetIncidentKind = 'provider_unhealthy' | 'squad_dead_fleet' | 'sandbox_degraded' | 'sandbox_overloaded'

export const fleetIncidents = pgTable(
  'fleet_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: varchar('kind', { length: 40 }).$type<FleetIncidentKind>().notNull(),
    scopeKey: varchar('scope_key', { length: 255 }).notNull(),
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 100 }),
    accountId: varchar('account_id', { length: 100 }),
    healthKind: varchar('health_kind', { length: 40 }).$type<ProviderHealthKind>(),
    providerRetryAt: timestamp('provider_retry_at', { withTimezone: true }),
    providerLastSuccessAt: timestamp('provider_last_success_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    alertAfter: timestamp('alert_after', { withTimezone: true }).notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    causeCode: varchar('cause_code', { length: 80 }).notNull(),
    causeSummary: text('cause_summary').notNull(),
    remediation: text('remediation'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_fleet_incidents_one_open_scope')
      .on(table.kind, table.scopeKey)
      .where(sql`${table.resolvedAt} IS NULL`),
    index('idx_fleet_incidents_alert_due').on(table.resolvedAt, table.alertAfter),
  ]
)

export const fleetIncidentNotifications = pgTable(
  'fleet_incident_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => fleetIncidents.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).$type<'alert' | 'recovery'>().notNull(),
    audience: varchar('audience', { length: 20 }).$type<'manager' | 'human'>().notNull().default('human'),
    status: varchar('status', { length: 20 })
      .$type<'pending' | 'delivering' | 'delivered' | 'canceled' | 'skipped' | 'undeliverable'>()
      .notNull()
      .default('pending'),
    recipientId: varchar('recipient_id', { length: 200 }).default('system'),
    idempotencyKey: text('idempotency_key'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    claimToken: uuid('claim_token'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    inboxMessageId: uuid('inbox_message_id').references(() => inbox.id, { onDelete: 'set null' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.incidentId, table.kind, table.audience),
    unique().on(table.idempotencyKey),
    index('idx_fleet_incident_notifications_due').on(table.status, table.nextAttemptAt, table.claimedAt),
  ]
)

export const inboxAttachments = pgTable(
  'inbox_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => inbox.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 500 }).notNull(),
    contentType: varchar('content_type', { length: 255 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('idx_inbox_attachments_message').on(table.messageId)]
)

// Per-reader read state for the shared system inbox. A single shared system message
// (recipientType='system', recipientId='system') has many readers, so its inbox.readAt is
// unused; each reader's read state lives here.
export const systemInboxReads = pgTable(
  'system_inbox_reads',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => inbox.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    index('idx_system_inbox_reads_user_message').on(table.userId, table.messageId),
  ]
)

/** Account choice; absent row means this user has not synced a theme. */
export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: jsonb('theme').$type<ThemePreference>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// The farm UI's durable per-account state: one validated settings document
// (@ficus/shared farm-preferences.ts), so a new setting needs no migration.
// Kept apart from user_preferences so the web theme's row and migrations stay its own.
export const farmPreferences = pgTable('farm_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<FarmSettings>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// The farm's chat (packages/shared farm-chat.ts): one general room, public rooms
// managed with chat:manage-rooms, and DMs between two people (dm_user_a is the
// lower user id). Messages are pruned after 30 days (services/farm-chat/retention.ts).
export const farmChatRooms = pgTable(
  'farm_chat_rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<FarmChatRoomKind>().notNull(),
    /** Empty for a DM, which is named for the other person. */
    name: text('name').notNull().default(''),
    description: text('description'),
    dmUserA: uuid('dm_user_a').references(() => users.id, { onDelete: 'cascade' }),
    dmUserB: uuid('dm_user_b').references(() => users.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('farm_chat_rooms_kind_valid', sql`${table.kind} IN ('general', 'room', 'dm')`),
    check(
      'farm_chat_rooms_dm_shape',
      sql`(${table.kind} = 'dm') = (${table.dmUserA} IS NOT NULL AND ${table.dmUserB} IS NOT NULL AND ${table.dmUserA} < ${table.dmUserB})`
    ),
    uniqueIndex('farm_chat_rooms_one_general')
      .on(table.kind)
      .where(sql`${table.kind} = 'general'`),
    uniqueIndex('farm_chat_rooms_dm_pair')
      .on(table.dmUserA, table.dmUserB)
      .where(sql`${table.kind} = 'dm'`),
    uniqueIndex('farm_chat_rooms_room_name')
      .on(sql`lower(${table.name})`)
      .where(sql`${table.kind} = 'room'`),
  ]
)

export const farmChatMessages = pgTable(
  'farm_chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => farmChatRooms.id, { onDelete: 'cascade' }),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('farm_chat_messages_room_created').on(table.roomId, table.createdAt),
    index('farm_chat_messages_created').on(table.createdAt),
  ]
)

/** How far each person has read each room, for unread counts. */
export const farmChatReads = pgTable(
  'farm_chat_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => farmChatRooms.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roomId] })]
)

// Phase 1: every user's private library of saved theme presets (a v2 light/dark
// document each). 'instance' visibility is reserved for Phase 2 sharing; Phase 1
// never writes it and every route here is owner-only. `revision` is an
// optimistic-concurrency counter bumped on every update (see services/theme-presets.ts).
export const themePresetVisibilityEnum = pgEnum('theme_preset_visibility', ['private', 'instance'])
export const themePresets = pgTable(
  'theme_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    document: jsonb('document').$type<CustomThemeDocument>().notNull(),
    visibility: themePresetVisibilityEnum('visibility').notNull().default('private'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_theme_presets_owner').on(table.ownerUserId)]
)

// Per-user notification preferences. Notification delivery (push) is per-user; this lets each user
// control their own push without affecting the shared/system notification rules.
export const userNotificationPreferences = pgTable('user_notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  pushEnabled: boolean('push_enabled').notNull().default(true),
  showPreviews: boolean('show_previews').notNull().default(true),
  // Event types the user has muted (no push), e.g. ['inbox.messageReceived'].
  mutedEvents: jsonb('muted_events').notNull().default([]),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Work-stream subscriptions ("watchers"). A row records a user's ATTENTION for one stream:
// `decisions` (questions, review and manual waits) and `progress` (feed presence, completion)
// each at mute/show/notify. A stream row overrides the squad row; with no row at either level the
// user gets DEFAULT_ATTENTION (show/show) — visible, never interrupting. The requesting user is
// auto-subscribed on creation at WATCH_ATTENTION.
export const workStreamSubscriptions = pgTable(
  'work_stream_subscriptions',
  {
    workStreamId: uuid('work_stream_id')
      .notNull()
      .references(() => workStreams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Literal, not the imported WATCH_ATTENTION constant: drizzle-kit reads this file to emit SQL,
    // so the default must be inspectable here. It is WATCH_ATTENTION by definition.
    attention: jsonb('attention').$type<Attention>().notNull().default({ decisions: 'notify', progress: 'notify' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workStreamId, table.userId] })]
)

// Async agent questions. Managers/consultants/system-managers ask structured questions without
// halting (status stays open; the agent keeps working). Chat/history visibility follows canonical
// agents:read on the agent; Action Center/push attention routes to durable direct recipients plus
// compatible owners and authorized watchers. Answering delivers the answer to the agent as an inbox
// message (which wakes it). squadId/ownerUserId are denormalized per-user scoping snapshots, not
// read ACLs. The audience_* columns keep their physical names for compatibility; they record
// legacy-compatible attention-routing resolution state. audience_alerted_at recorded the (removed)
// unroutable-audience system-inbox notice stamp; it is retained physically to avoid migration churn
// but is no longer written or read.
export const agentQuestions = pgTable(
  'agent_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'set null' }),
    questionData: jsonb('question_data').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('open'),
    answer: text('answer'),
    answeredByUserId: uuid('answered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    audienceResolution: varchar('audience_resolution', { length: 32 }).$type<
      'pending' | 'resolved' | 'unroutable' | 'legacy-unresolved'
    >(),
    audienceResolvedAt: timestamp('audience_resolved_at', { withTimezone: true }),
    audienceAlertedAt: timestamp('audience_alerted_at', { withTimezone: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    answeredAt: timestamp('answered_at'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissalReason: varchar('dismissal_reason', { length: 256 }),
    dismissedByUserId: uuid('dismissed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    dismissedByAgentId: uuid('dismissed_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    answerDeliveryStatus: varchar('answer_delivery_status', { length: 16 }).$type<
      'pending' | 'delivering' | 'delivered' | 'failed'
    >(),
    answerDeliveryGeneration: integer('answer_delivery_generation').notNull().default(1),
    answerDeliveryAttemptCount: integer('answer_delivery_attempt_count').notNull().default(0),
    answerDeliveryNextAttemptAt: timestamp('answer_delivery_next_attempt_at', { withTimezone: true }),
    answerDeliveryClaimToken: uuid('answer_delivery_claim_token'),
    answerDeliveryClaimedAt: timestamp('answer_delivery_claimed_at', { withTimezone: true }),
    answerDeliveryLastError: text('answer_delivery_last_error'),
    answerDeliveryInboxMessageId: uuid('answer_delivery_inbox_message_id').references(() => inbox.id, {
      onDelete: 'set null',
    }),
    answerDeliveryMessageId: uuid('answer_delivery_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    answerDeliveryExecutionId: uuid('answer_delivery_execution_id').references(() => executions.id, {
      onDelete: 'set null',
    }),
    answerDeliveredAt: timestamp('answer_delivered_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_agent_questions_agent_status').on(table.agentId, table.status),
    index('idx_agent_questions_answer_delivery_due')
      .on(table.answerDeliveryNextAttemptAt)
      .where(sql`${table.answerDeliveryStatus} IN ('pending', 'delivering')`),
  ]
)

export const agentQuestionRecipients = pgTable(
  'agent_question_recipients',
  {
    questionId: uuid('question_id')
      .notNull()
      .references(() => agentQuestions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: varchar('reason', { length: 32 })
      .$type<'execution-participant' | 'workstream-requester' | 'legacy-repair'>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.questionId, table.userId] }),
    index('idx_agent_question_recipients_user_question').on(table.userId, table.questionId),
  ]
)

// Acknowledges one failed delivery generation for one user; does not modify the answer or waits.
export const agentQuestionDeliveryAcknowledgements = pgTable(
  'agent_question_delivery_acknowledgements',
  {
    questionId: uuid('question_id')
      .notNull()
      .references(() => agentQuestions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.questionId, table.userId] })]
)

export const agentQuestionWorkStreamOrigins = pgTable(
  'agent_question_work_stream_origins',
  {
    questionId: uuid('question_id')
      .notNull()
      .references(() => agentQuestions.id, { onDelete: 'cascade' }),
    workStreamId: uuid('work_stream_id')
      .notNull()
      .references(() => workStreams.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.questionId, table.workStreamId] }),
    index('idx_agent_question_origins_stream_question').on(table.workStreamId, table.questionId),
  ]
)

// Squad-level subscriptions ("watch the whole squad"). A row records a user's ATTENTION for every
// stream in the squad (current and future) and for the squad's own items (manager questions,
// halted agents): `decisions` and `progress`, each at mute/show/notify. A per-stream row overrides
// this one; with no row anywhere the user gets DEFAULT_ATTENTION (show/show). `actions:read` and
// `workstreams:read` still gate everything — attention only narrows what permission already allows.
export const squadSubscriptions = pgTable(
  'squad_subscriptions',
  {
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Literal, not the imported WATCH_ATTENTION constant: drizzle-kit reads this file to emit SQL,
    // so the default must be inspectable here. It is WATCH_ATTENTION by definition.
    attention: jsonb('attention').$type<Attention>().notNull().default({ decisions: 'notify', progress: 'notify' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.squadId, table.userId] })]
)

// Memory System Tables
// --------------------
// Squad-shared, Obsidian-compatible memory system for retrieval and indexing

// Squad Source Configs - per-squad ingestion policies for memory source adapters
export const squadSourceConfigs = pgTable(
  'squad_source_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    policy: jsonb('policy').notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [unique().on(table.squadId, table.sourceType)]
)

// Memory Documents - logical documents from memory files or agent threads
export const memoryDocuments = pgTable(
  'memory_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(), // 'memory_file' | 'agent_thread'
    sourceId: text('source_id').notNull(), // file path OR thread id
    title: text('title'),
    path: text('path'),
    frontmatter: jsonb('frontmatter').notNull().default({}),
    sensitivity: text('sensitivity').notNull().default('internal'),
    contentHash: text('content_hash').notNull(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.squadId, table.sourceType, table.sourceId),
    // Index for source_type filtering (squad-scoped)
    index('idx_memory_documents_source_type').on(table.squadId, table.sourceType),
    // Index for path filtering with LIKE prefix queries
    index('idx_memory_documents_path').on(table.squadId, table.path),
    index('idx_memory_documents_sensitivity').on(table.squadId, table.sensitivity),
  ]
)

// Memory Chunks - chunked searchable content with embeddings
export const memoryChunks = pgTable(
  'memory_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => memoryDocuments.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    metadata: jsonb('metadata').notNull().default({}),
    sensitivity: text('sensitivity').notNull().default('internal'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.documentId, table.chunkIndex),
    // IVFFlat index for vector similarity search
    index('idx_memory_chunks_embedding').using('ivfflat', table.embedding.op('vector_cosine_ops')),
    index('idx_memory_chunks_sensitivity').on(table.squadId, table.sensitivity),
  ]
)

// Memory Links - backlink graph from wikilinks
export const memoryLinks = pgTable('memory_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  squadId: uuid('squad_id')
    .notNull()
    .references(() => squads.id, { onDelete: 'cascade' }),
  sourceDocumentId: uuid('source_document_id')
    .notNull()
    .references(() => memoryDocuments.id, { onDelete: 'cascade' }),
  targetRaw: text('target_raw').notNull(), // raw wikilink text e.g. "[[Page#Heading]]"
  targetDocumentId: uuid('target_document_id').references(() => memoryDocuments.id, { onDelete: 'set null' }),
  targetHeading: text('target_heading'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const secrets = pgTable('secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 255 }).notNull().unique(),
  encryptedValue: text('encrypted_value').notNull(),
  iv: text('iv').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  updatedBy: varchar('updated_by', { length: 100 }),
})

// Instance Identity - singleton row holding this instance's Ed25519 keypair
export const instanceIdentity = pgTable('instance_identity', {
  id: varchar('id', { length: 20 }).primaryKey(), // always 'singleton'
  instanceId: varchar('instance_id', { length: 64 }).notNull().unique(),
  publicKeyPem: text('public_key_pem').notNull(),
  privateKeyPem: text('private_key_pem').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// Federation Peers - known remote Ficus instances this instance can route to
export const peers = pgTable('peers', {
  id: uuid('id').primaryKey().defaultRandom(),
  localAlias: varchar('local_alias', { length: 200 }).notNull().unique(),
  instanceId: varchar('instance_id', { length: 64 }).notNull().unique(),
  baseUrl: text('base_url').notNull(),
  publicKeyPem: text('public_key_pem').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// Federation Outbox - outbound message queue drained by the delivery worker
export const amtpOutboxStatusEnum = pgEnum('amtp_outbox_status', ['pending', 'delivering', 'delivered', 'failed'])

export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    peerInstanceId: varchar('peer_instance_id', { length: 64 }).notNull(),
    toAddress: text('to_address').notNull(),
    envelopeJson: jsonb('envelope_json').$type<AmtpEnvelope>().notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull().unique(),
    status: amtpOutboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    claimToken: varchar('claim_token', { length: 64 }),
    claimedAt: timestamp('claimed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('outbox_status_next_attempt_idx').on(table.status, table.nextAttemptAt)]
)

// Federation Received - replay/dedup ledger for inbound federation envelopes, keyed per sending peer
export const amtpReceived = pgTable(
  'amtp_received',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    peerInstanceId: varchar('peer_instance_id', { length: 64 }).notNull(),
    envelopeId: varchar('envelope_id', { length: 200 }).notNull(),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
  },
  (table) => [unique().on(table.peerInstanceId, table.envelopeId)]
)

// Federation allow-rules - the ONLY policy gate for remote (cross-instance) senders.
// Default-deny: a remote message is accepted only if a matching rule exists.
export const amtpAllowRules = pgTable(
  'amtp_allow_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetAgentId: uuid('target_agent_id')
      .notNull()
      .references((): AnyPgColumn => agents.id, { onDelete: 'cascade' }),
    peerInstanceId: varchar('peer_instance_id', { length: 64 }).notNull(),
    // Slice 3: 'any' | 'handle'  ('squad' | 'agentKey' deferred)
    principalKind: varchar('principal_kind', { length: 20 }).notNull(),
    principalValue: varchar('principal_value', { length: 200 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('idx_amtp_allow_rules_target_peer').on(table.targetAgentId, table.peerInstanceId)]
)

// Federation Known Keys - TOFU pin of each remote agent's published identity key.
// First contact with handle@peer pins the fetched public key; later mail must match.
export const amtpKnownKeys = pgTable(
  'amtp_known_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    peerInstanceId: varchar('peer_instance_id', { length: 64 }).notNull(),
    handle: varchar('handle', { length: 200 }).notNull(),
    publicKey: text('public_key').notNull(),
    firstSeenAt: timestamp('first_seen_at').notNull().defaultNow(),
  },
  (table) => [unique().on(table.peerInstanceId, table.handle)]
)

// Settings - non-secret application settings (plain key-value, no encryption)
export const settings = pgTable('settings', {
  key: varchar('key', { length: 255 }).primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  updatedBy: varchar('updated_by', { length: 100 }),
})

// Durable cross-process Kubernetes provisioning circuit and fenced operation leases.
export const k8sProvisionControls = pgTable('k8s_provision_controls', {
  scope: varchar('scope', { length: 64 }).primaryKey(),
  state: varchar('state', { length: 16 }).notNull().default('closed'),
  failures: jsonb('failures').notNull().default([]),
  reasonCode: varchar('reason_code', { length: 64 }),
  retryAt: timestamp('retry_at', { withTimezone: true }),
  probeAttemptId: uuid('probe_attempt_id'),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const k8sProvisionAttempts = pgTable(
  'k8s_provision_attempts',
  {
    scope: varchar('scope', { length: 64 }).notNull(),
    sandboxKey: varchar('sandbox_key', { length: 255 }).notNull(),
    operationKind: varchar('operation_kind', { length: 16 }).notNull(),
    desiredSpecHash: varchar('desired_spec_hash', { length: 64 }).notNull(),
    attemptId: uuid('attempt_id').notNull(),
    ownerId: varchar('owner_id', { length: 255 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    podName: varchar('pod_name', { length: 253 }),
    resultSpecHash: varchar('result_spec_hash', { length: 64 }),
    failureCode: varchar('failure_code', { length: 64 }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.sandboxKey] }),
    index('idx_k8s_provision_attempts_live').on(table.scope, table.status, table.leaseExpiresAt),
  ]
)

export const sandboxProvisionRecoveries = pgTable(
  'sandbox_provision_recoveries',
  {
    executionId: uuid('execution_id')
      .primaryKey()
      .references(() => executions.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    workStreamId: uuid('work_stream_id').references(() => workStreams.id, { onDelete: 'set null' }),
    scope: varchar('scope', { length: 64 }).notNull(),
    sandboxKey: varchar('sandbox_key', { length: 200 }).notNull(),
    circuitVersion: integer('circuit_version'),
    refusalId: uuid('refusal_id').notNull(),
    generation: integer('generation').notNull().default(1),
    status: varchar('status', { length: 20 })
      .$type<'waiting' | 'leased' | 'resumed' | 'cancelled' | 'exhausted'>()
      .notNull()
      .default('waiting'),
    errorCode: varchar('error_code', { length: 64 }).$type<SandboxProvisionErrorCode>().notNull(),
    reasonCode: varchar('reason_code', { length: 64 }).$type<ProvisionFailureCode>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    leaseOwner: varchar('lease_owner', { length: 200 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    claimKind: varchar('claim_kind', { length: 20 }).$type<'ordinary' | 'half_open_probe'>(),
    lastErrorCode: varchar('last_error_code', { length: 80 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_sandbox_provision_recoveries_due').on(table.status, table.nextAttemptAt),
    index('idx_sandbox_provision_recoveries_scope_due').on(table.scope, table.status, table.nextAttemptAt),
  ]
)

// Channel Instances - external platform connections (Discord, Slack, Telegram, etc.)
// Each external conversation is handled by a consultant in its routed squad.
export const channelInstances = pgTable('channel_instances', {
  id: varchar('id', { length: 100 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(), // 'discord' | 'slack' | 'telegram'

  // Provider-specific configuration (guildId for Discord, teamId for Slack, botId for Telegram, etc.)
  providerConfig: jsonb('provider_config').notNull().default({}),

  // Only these exact provider channel IDs bypass linked-user authorization.
  trustedChannelIds: jsonb('trusted_channel_ids').$type<string[]>().notNull().default([]),
  allowedChannelIds: jsonb('allowed_channel_ids').$type<string[]>().notNull().default([]),
  deniedChannelIds: jsonb('denied_channel_ids').$type<string[]>().notNull().default([]),
  allowPrivateChats: boolean('allow_private_chats').notNull().default(true),

  // Multi-squad config
  channelSquadMap: jsonb('channel_squad_map').default({}), // channel_id → squad_id
  defaultSquadId: uuid('default_squad_id').references(() => squads.id, { onDelete: 'set null' }),

  yamlTemplate: jsonb('yaml_template'),
  yamlFieldOverrides: jsonb('yaml_field_overrides').notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const notificationConfig = pgTable('notification_config', {
  id: varchar('id', { length: 50 }).primaryKey(),
  rules: jsonb('rules').notNull().default([]),
  channels: jsonb('channels').notNull().default({}),
  yamlTemplate: jsonb('yaml_template'),
  yamlFieldOverrides: jsonb('yaml_field_overrides').notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// ── RBAC Tables ──────────────────────────────────────────────────────────────

export const subjectTypeEnum = pgEnum('subject_type', ['user', 'channel'])
export const roleAssignmentScopeEnum = pgEnum('role_assignment_scope', ['system', 'squad_default', 'squad'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  lastFeedVisitAt: timestamp('last_feed_visit_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// An external sender is linked within a configured provider instance, never by display name.
export const channelIdentityLinks = pgTable(
  'channel_identity_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    instanceId: varchar('instance_id', { length: 100 })
      .notNull()
      .references(() => channelInstances.id, { onDelete: 'cascade' }),
    identityScope: text('identity_scope').notNull(),
    externalUserId: text('external_user_id').notNull(),
    externalUserName: text('external_user_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('channel_identity_sender_unique').on(table.instanceId, table.externalUserId)]
)

// Private bot chats retain independent consultant histories for each linked user and squad.
export const channelDirectChats = pgTable(
  'channel_direct_chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => channelIdentityLinks.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    threadId: text('thread_id').notNull().default(''),
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'set null' }),
  },
  (table) => [unique('channel_direct_chat_identity_unique').on(table.linkId, table.channelId, table.threadId)]
)

export const channelDirectAgents = pgTable(
  'channel_direct_agents',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => channelDirectChats.id, { onDelete: 'cascade' }),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
  },
  (table) => [unique('channel_direct_agent_scope_unique').on(table.chatId, table.squadId)]
)

// The user starts in Ficus, proves control in the provider, then confirms the sender in Ficus.
export const channelLinkChallenges = pgTable('channel_link_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  instanceId: varchar('instance_id', { length: 100 }).references(() => channelInstances.id, { onDelete: 'cascade' }),
  identityScope: text('identity_scope'),
  externalUserId: text('external_user_id'),
  externalUserName: text('external_user_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const userCredentials = pgTable('user_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: jsonb('transports'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

/**
 * Which kind of subject a role may be granted to. Roles carry no subject marker
 * otherwise — `role_assignments.subject_type` is always 'user' in practice, and
 * agents never get assignments at all (their permissions are derived from their
 * agent type in services/rbac/permissions.ts). Without this every human role
 * picker offers `default-worker` / `default-manager` / `default-manager`,
 * which are meaningless on a person.
 *
 * Deliberately a plain text column, not a pg enum: enums are painful to extend
 * on a live database and this is presentation/validation metadata, not a
 * referential constraint.
 */
export type RoleAppliesTo = 'user' | 'agent' | 'both'

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
  permissions: jsonb('permissions').notNull().$type<string[]>(),
  // Custom (API-created) roles default to 'user': every assignment path in core
  // writes subject_type 'user', so a hand-made role is only ever reachable by a
  // person. Agent roles are declared in config/roles/defaults.yaml, never at runtime.
  appliesTo: text('applies_to').notNull().default('user').$type<RoleAppliesTo>(),
  isSystem: boolean('is_system').notNull().default(false),
  readOnly: boolean('read_only').notNull().default(false),
  updatedBy: text('updated_by').notNull().default('yaml'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectType: subjectTypeEnum('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    scope: roleAssignmentScopeEnum('scope').notNull(),
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_role_assignment_no_squad')
      .on(table.subjectType, table.subjectId, table.roleId, table.scope)
      .where(sql`${table.squadId} IS NULL`),
    uniqueIndex('uq_role_assignment_with_squad')
      .on(table.subjectType, table.subjectId, table.roleId, table.scope, table.squadId)
      .where(sql`${table.squadId} IS NOT NULL`),
    index('idx_role_assignments_subject').on(table.subjectType, table.subjectId),
  ]
)

export const agentTokens = pgTable('agent_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  // Nullable: squad-less agents (system-managers) get a token scoped via userId, not a squad.
  squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
})

export const agentExtraScopes = pgTable(
  'agent_extra_scopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_agent_scope').on(table.agentId, table.permission),
    index('idx_agent_scopes_agent').on(table.agentId),
  ]
)

// System API tokens: user-less bearer tokens with explicit permission scopes, for automation
// (e.g. webhook scripts). Long-lived + revocable. `kind` distinguishes auto-provisioned webhook
// tokens (hidden from the management UI by default) from manually-created ones.
export const systemTokens = pgTable('system_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scopes: jsonb('scopes').notNull().$type<string[]>().default([]),
  kind: varchar('kind', { length: 20 }).notNull().default('manual'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
})

// Long-lived per-device bearer tokens for paired clients (resolve to the owning user's identity).
export const deviceTokens = pgTable('device_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  name: varchar('name', { length: 200 }).notNull(), // e.g. "iPhone 15"
  platform: varchar('platform', { length: 20 }).notNull(), // 'ios' | 'android' | 'cli' | 'desktop'
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
})

// Short-lived browser-approved grants used to bootstrap an unauthenticated CLI or Ficus Desktop instance.
export const deviceAuthorizations = pgTable(
  'device_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceCodeHash: text('device_code_hash').notNull().unique(),
    verificationCodeHash: text('verification_code_hash').notNull().unique(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    platform: varchar('platform', { length: 20 }).notNull().default('cli'),
    expiresAt: timestamp('expires_at').notNull(),
    approvedAt: timestamp('approved_at'),
    consumedAt: timestamp('consumed_at'),
    lastPolledAt: timestamp('last_polled_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('idx_device_authorizations_expires').on(table.expiresAt)]
)

// Short-lived, single-use QR pairing codes minted by an authenticated web session.
export const pairingCodes = pgTable('pairing_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeHash: text('code_hash').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  claimedAt: timestamp('claimed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// APNs/FCM device registrations linked to a paired device token (for direct push delivery).
export const apnsDevices = pgTable('apns_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Optional link to the paired device (cascades on row deletion, not soft revoke); fan-out is by userId.
  deviceTokenId: uuid('device_token_id').references(() => deviceTokens.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  apnsToken: text('apns_token').notNull().unique(),
  // Subscriber-approved destination capability for the optional cloud relay.
  relayBindingToken: text('relay_binding_token'),
  platform: varchar('platform', { length: 20 }).notNull(), // 'ios' | 'android'
  environment: varchar('environment', { length: 20 }).notNull().default('production'), // 'production' | 'sandbox'
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
})

/**
 * APNs tokens for Live Activities — deliberately separate from `apns_devices`.
 *
 * A Live Activity's token is NOT the device token: iOS mints a distinct token per activity
 * (`kind='update'`, carrying `activityId`), plus an optional per-app push-to-start token
 * (`kind='start'`, no activityId). They also require a different APNs topic
 * (`<bundleId>.push-type.liveactivity`) and push type, so mixing them into apns_devices would
 * make every fan-out query have to re-separate them.
 *
 * Update tokens are short-lived by design — iOS ends an activity after ~8h (or on dismissal or
 * reboot) and the token dies with it — so rows here are expected to churn and APNs 410 responses
 * are routine cleanup, not an error condition.
 */
export const liveActivityTokens = pgTable('live_activity_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  apnsToken: text('apns_token').notNull().unique(),
  // 'start' = push-to-start token (one per app install); 'update' = one activity's token.
  kind: varchar('kind', { length: 20 }).notNull(),
  // Null for 'start' tokens, which are not bound to a specific activity.
  activityId: text('activity_id'),
  environment: varchar('environment', { length: 20 }).notNull().default('production'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
})

export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  challengeKey: text('challenge_key').notNull().unique(),
  challenge: text('challenge').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

/**
 * What an issued email challenge is FOR. 'register' rows are redeemable by the
 * 6-digit code through the normal registration form; 'recovery' rows are
 * token-only (see services/auth/email.ts `verifyEmailCode`) so a recovery code
 * can never be walked through the plain registration path, which would add a
 * passkey without revoking the lost one.
 */
export type EmailVerificationPurpose = 'register' | 'recovery'

export const emailVerifications = pgTable('email_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  code: text('code').notNull(),
  // sha256 of the deep-link token, when one was issued alongside the code. The
  // token and the code are two presentations of the SAME row, so the existing
  // atomic `used_at` consume makes both single-use with no new race surface.
  tokenHash: text('token_hash').unique(),
  purpose: text('purpose').notNull().default('register').$type<EmailVerificationPurpose>(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const authSettings = pgTable('auth_settings', {
  id: varchar('id', { length: 50 }).primaryKey().default('default'),
  allowedDomains: jsonb('allowed_domains').notNull().$type<string[]>().default([]),
  requireInvite: boolean('require_invite').notNull().default(true),
  defaultSignupRoleId: uuid('default_signup_role_id').references(() => roles.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Single-use, short-lived tickets minted from a user session so the long-lived
// session bearer never travels in a WebSocket URL query string.
export const wsTickets = pgTable('ws_tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  deviceTokenId: uuid('device_token_id').references(() => deviceTokens.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// Machines: provider VMs / BYO SSH boxes that host VM-based sandboxes. Each
// machine is reached over SSH; the concrete boxes (per-sandbox unix users) live
// in `machine_boxes`.
export interface MachineCapabilities {
  arch?: string
  cpus?: number
  memMb?: number
  diskGb?: number
  docker?: 'rootless' | 'rootful' | 'none'
  kernel?: string
  // Whether the host's sshd permits TCP forwarding (probed at bootstrap via a
  // decision ladder: `sshd -T`, then an empirical loopback forward self-test,
  // then the config files + OpenSSH's compiled-in default of yes). A machine
  // with `no` cannot host tunnel-reached boxes and must fail loudly at ensure.
  // `unknown` is a genuinely rare last-ditch value: every ladder step was
  // indeterminate AND the sshd config exists but is unreadable even via sudo.
  forwarding?: 'yes' | 'no' | 'unknown'
  // Whether the shared per-machine browser is usable (browser-tools-in-sandbox
  // spec §4.1): `available` once verify_browser confirms Chromium's sandbox is ON
  // and the tau-browser service is live; `unavailable` when the sandbox cannot be
  // enabled on this host. An unavailable browser NEVER fails bootstrap — the
  // machine still comes up, only browsing is off (the sandbox is never downgraded
  // to --no-sandbox). Surfaced to the control plane / machines UI so a
  // misconfigured host is visible. Absent on a machine bootstrapped before this
  // field existed.
  browser?: 'available' | 'unavailable'
  // A fixed reason token when `browser === 'unavailable'`. Install/setup:
  // playwright_install_failed / chromium_download_failed / user_setup_failed /
  // setup_failed / install_failed. Runtime: apparmor_parser_missing /
  // apparmor_load_failed / sandbox_check_failed / service_start_failed /
  // service_inactive. Absent when the browser is available. (A browser failure —
  // install, setup, verify, or service — NEVER fails machine bootstrap; it only
  // sets browser=unavailable with one of these tokens.)
  browserReason?: string
}

export const machines = pgTable('machines', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  provider: text('provider').notNull(), // 'ssh' | 'exe' (text, validated in code)
  providerRef: text('provider_ref'),
  sshHost: text('ssh_host').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  sshUser: text('ssh_user').notNull(),
  sshKeyId: text('ssh_key_id').notNull(), // secret-store key
  sshPublicKey: text('ssh_public_key').notNull(),
  status: text('status').notNull().default('registered'),
  // 'registered' | 'bootstrapping' | 'ready' | 'unreachable' | 'parked' | 'reaping' | 'terminated'
  // 'reaping' is the empty-machine reaper's claim marker: flipped from 'ready'
  // under the machines-row lock (with an in-transaction zero-box re-check)
  // immediately before provider.terminate, so no bind can land on a machine
  // whose VM is being destroyed (bindMachineBox rejects any non-'ready' status).
  // Restored to 'ready' on a failed terminate; the row is deleted on success.
  capabilities: jsonb('capabilities').$type<MachineCapabilities>().notNull().default({}),
  scope: text('scope').notNull().default('shared'), // 'shared' | 'dedicated'
  // Placement role of the machine (slice-5 placement policy + B2 packer).
  // Distinct from `scope` (eligibility): `purpose` records WHY a machine exists so
  // placement can reuse it deterministically.
  //  - 'shared'   : a multi-box host in the packed pool (the default): BYO machines
  //                 and every packer-provisioned exe VM.
  //  - 'dedicated': an exe VM provisioned for a single box (`dedicated` request).
  //  - 'squad'    : LEGACY (pre-packer squad-per-VM); invisible to the packer,
  //                 drains once its boxes stop. `squadId` set.
  //  - 'commons'  : LEGACY (pre-packer tenant commons VM); same drain path.
  purpose: text('purpose').notNull().default('shared'),
  // True ONLY for VMs tau created on its own (placement's defaultProvisionMachine
  // — the packer + dedicated auto-provision paths). What tau provisioned
  // unattended it may also reclaim unattended: the empty-machine reaper
  // terminates ONLY auto-provisioned machines. User-registered machines — BYO
  // SSH *and* operator-provisioned exe VMs via POST /api/machines, which are
  // otherwise row-identical to packer VMs (provider='exe', shared account key,
  // empty public key) — keep the false default and are never auto-terminated.
  // Legacy pre-packer squad/commons VMs are backfilled true by migration (they
  // were auto-provisioned by the old placement) so they too are reaped once
  // their boxes' owners terminate and the rows drain.
  autoProvisioned: boolean('auto_provisioned').notNull().default(false),
  // When the machine lost its LAST box: stamped by deleteMachineBox in the same
  // transaction that deleted the final machine_boxes row, cleared (null) by
  // bindMachineBox whenever a box binds. Null while the machine hosts ≥1 box —
  // and on a machine that has NEVER lost a box, so a freshly provisioned VM is
  // exempt from reaping until it has hosted and drained. The empty-machine
  // reaper terminates a ready, auto-provisioned, non-dedicated machine once
  // now - empty_since exceeds FICUS_MACHINE_IDLE_GRACE_MS (re-verifying zero
  // boxes at terminate time).
  emptySince: timestamp('empty_since', { withTimezone: true }),
  // The squad a legacy 'squad'-purpose machine belongs to; null for every other
  // purpose (the packer never sets it). Not an FK: a machine can outlive/pre-date
  // a squad row and placement only ever equality-matched it.
  squadId: text('squad_id'),
  // Opt-in machine-level nftables egress lockdown (bootstrap.sh --egress-lockdown).
  // When true, bootstrapMachine hardens the whole VM's egress to the deny-list in
  // k8s/network-policy.yaml (allow DNS + public internet + the core CIDRs; drop
  // RFC1918 / link-local / cloud-metadata, v4 and v6). Default off preserves the
  // slice-1/2 behavior for existing machines.
  egressPolicy: boolean('egress_policy').notNull().default(false),
  bootstrapVersion: text('bootstrap_version'),
  // The last bootstrap failure's stderr tail (the same message bootstrapMachine
  // logs and throws), stamped alongside status='unreachable' so operators and
  // platform provisioning — which only ever polled the row — can see WHY a
  // bootstrap failed, not just that it did. Cleared (null) on the next
  // SUCCESSFUL bootstrap so a recovered machine doesn't keep showing a stale
  // error. Null on a machine that has never failed a bootstrap.
  lastError: text('last_error'),
  // Per-artifact content-hash versions last pushed to this machine, keyed by
  // MachineArtifact name (e.g. 'server', 'cli'). Written ONLY via
  // stampArtifactVersion's in-DB jsonb merge so concurrent/sequential stamps of
  // different artifacts never clobber each other (an in-memory spread would).
  artifactVersions: jsonb('artifact_versions').$type<Record<string, string>>().notNull().default({}),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const machineBoxes = pgTable(
  'machine_boxes',
  {
    sandboxId: text('sandbox_id').primaryKey(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    unixUser: text('unix_user').notNull(),
    port: integer('port').notNull(),
    status: text('status').notNull().default('ensuring'), // 'ensuring' | 'ready' | 'stopped' | 'stop_unverified' | 'orphaned'
    // Per-box executor auth token (EXECUTOR_AUTH_TOKEN). Generated once at the
    // box's first (re-)provision and pushed into its 0600 server.env; the
    // server 401s requests without it, closing cross-box takeover between
    // co-located unix users on a shared machine. Stored here so BOTH core
    // processes (api + worker) can present it (SandboxClient bearer header) —
    // it gates only box-local access on the machine, and is never exposed over
    // the API (routes strip it). Null for rows predating the column: such
    // legacy boxes skip the healthy fast-path once and re-provision, which
    // mints + delivers their token.
    authToken: text('auth_token'),
    // vm-manager's PROVISIONING marker (vm/manager.ts's
    // `computeProvisioningMarker(computeSpecHash(opts), env)`) for what was
    // ACTUALLY provisioned onto this box's machine the last time a full
    // provision (box-provision.sh + server.env push) succeeded. Despite the
    // field name this is NOT the bare reconcilable spec hash (role +
    // bundle/provision-script version + squad membership —
    // `computeSpecHash`, used for recreateSandbox's drift detection and
    // baked into FICUS_BOX_SPEC_HASH): it additionally folds in a HASH of the
    // caller env (never the raw secret values), because the resume fast
    // path this drives skips the server.env push a full provision does — a
    // rotated GITHUB_TOKEN/callback secret/API URL must also bust the fast
    // path, or a resumed box would run on stale credentials. Stamped
    // alongside the 'ready' upsert at the end of a full (re)provision; never
    // touched by the healthy fast-path (an already-'ready' box's on-machine
    // provisioning is unconditionally trusted, same as before this column
    // existed). The resume fast-path (a PARKED box) compares this against
    // the caller's freshly computed marker: a match means box-provision.sh
    // need not re-run (only a restart + tunnel + health check is needed); a
    // mismatch (or null — a legacy row, or a box whose prior provision never
    // completed) forces the full path, so a spec OR env change (e.g.
    // recreateSandbox's stop-then-reensure after drift detection, or a
    // secret rotation) is never silently skipped. Null for rows predating
    // this column.
    provisionedSpecHash: text('provisioned_spec_hash'),
    // Bare reconcilable sandbox spec mirrored from FICUS_BOX_SPEC_HASH. Unlike
    // provisionedSpecHash this excludes environment/secret hashes, so drift
    // checks can compare it directly after a Core restart.
    reconcilableSpecHash: text('reconcilable_spec_hash'),
    // Coarse cross-process activity heartbeat (throttled write on exec/shell
    // touch; seeded when a box goes ready). The idle reaper runs in the WORKER
    // but activity can happen in the API process (e.g. a live terminal), so the
    // reaper reads max(process-local activity, this row): without it a worker
    // reap parks a box mid-terminal, and a box only ever used from the api is
    // never reaped. Null for rows predating the column.
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    // Liveness watermark: the last time the lifecycle tick's per-machine
    // `ss -ltnH` sweep saw this box's port LISTENING. Under socket activation
    // (spec D2) a box's `.socket` unit holds its port whether or not a server
    // process exists, so this is the only evidence of a box being reachable
    // that does not require an HTTP probe — and a probe WAKES an idle server.
    // The tick stamps it (worker-side, once per pass); the status path (which
    // the UI polls every few seconds from the API process) reads it and skips
    // its probe entirely while the stamp is fresh. Null for rows predating the
    // column, and for any box the tick has not yet swept — both fall through to
    // the pre-socket probing behavior.
    lastListeningAt: timestamp('last_listening_at', { withTimezone: true }),
    // Migration fence: true while a manual rebalance is moving this box to
    // another machine. Set via fenceBoxForMigration's set-then-recheck (under
    // the box row's FOR UPDATE lock, backing off if a turn is already active)
    // and cleared by clearBoxMigrating when the move finishes or fails. The
    // execution pickup path refuses to start a turn on a fenced box, so no
    // agent turn can begin once migration is underway.
    migrating: boolean('migrating').notNull().default(false),
    migrationOwner: text('migration_owner'),
    // Per-asset content-hash stamps for the per-sandbox files file-sync pushes
    // into this box (skills / squad-env / identity / memory / squad-ssh), keyed
    // by asset name → sha256. syncBoxFiles skips re-pushing an asset whose hash
    // already matches, mirroring machines.artifact_versions. Written ONLY via
    // stampBoxSyncedHash's in-DB jsonb merge (an in-memory spread would clobber
    // a sibling asset's just-written stamp) and reset to '{}' by
    // clearBoxSyncedHashes whenever a box is (re)provisioned, so a rebuilt box is
    // never skip-starved of its assets.
    syncedHashes: jsonb('synced_hashes').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // A port is bound to at most one box per machine. Backstop for the serialized
  // MAX(port)+1 allocation in bindMachineBox — concurrent binds cannot double-bind.
  (table) => [unique().on(table.machineId, table.port)]
)

export const vmBoxSetupStates = pgTable(
  'vm_box_setup_states',
  {
    sandboxId: text('sandbox_id')
      .primaryKey()
      .references(() => machineBoxes.sandboxId, { onDelete: 'cascade' }),
    desiredFingerprint: varchar('desired_fingerprint', { length: 64 }).notNull(),
    readiness: varchar('readiness', { length: 24 }).notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    pendingInvocationId: text('pending_invocation_id'),
    pendingInvocationKind: varchar('pending_invocation_kind', { length: 40 }),
    lastFailureClass: varchar('last_failure_class', { length: 64 }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_vm_box_setup_states_due').on(table.readiness, table.nextAttemptAt)]
)

export const boxCondemnationEvidence = pgTable(
  'box_condemnation_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sandboxId: text('sandbox_id').notNull(),
    generation: integer('generation').notNull(),
    machineId: uuid('machine_id').notNull(),
    classification: text('classification').notNull(),
    probes: jsonb('probes').notNull(),
    machineSnapshot: jsonb('machine_snapshot').notNull(),
    activeExecution: boolean('active_execution'),
    graceBudgetMs: integer('grace_budget_ms').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_box_condemnation_evidence_generation_unique').on(table.sandboxId, table.generation),
    index('idx_box_condemnation_evidence_recorded').on(table.sandboxId, table.recordedAt),
  ]
)

// Remote hosts: team-owned SSH targets (staging servers, build machines, a
// Mac with Xcode, ...) that squads reach out to. Unlike `machines`, tau never
// bootstraps a remote host, never creates users on it, and never installs
// anything on it — agents adapt to whatever the host runs. Each host gets a
// tau-minted ed25519 keypair (same mechanism as BYO machines): the private
// key lives in the secret store, the public key is shown to a human who
// installs it in the target's authorized_keys.
export const remoteHosts = pgTable('remote_hosts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(), // ssh alias; ^[a-z0-9][a-z0-9-]{0,62}$
  description: text('description'),
  sshHost: text('ssh_host').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  sshUser: text('ssh_user').notNull(),
  sshKeyId: text('ssh_key_id').notNull(), // secret handle `remote-host-ssh:<id>`
  sshPublicKey: text('ssh_public_key').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Grants a whole squad SSH access to a remote host. A grant gives every agent
// in that squad access; per-agent grants are out of scope (see design doc).
export const remoteHostGrants = pgTable(
  'remote_host_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostId: uuid('host_id')
      .notNull()
      .references(() => remoteHosts.id, { onDelete: 'cascade' }),
    squadId: text('squad_id').notNull(), // plain text, matching machines.squadId idiom
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.hostId, t.squadId)]
)

// Singleton source of truth and serialization lock for whole-instance maintenance.
export const instanceMaintenanceState = pgTable(
  'instance_maintenance_state',
  {
    id: varchar('id', { length: 20 }).primaryKey(),
    adminHold: boolean('admin_hold').notNull().default(false),
    adminReason: text('admin_reason'),
    adminHeldAt: timestamp('admin_held_at', { withTimezone: true }),
    adminHeldBy: text('admin_held_by'),
    platformLeaseId: uuid('platform_lease_id'),
    platformLeaseOwnerTokenId: uuid('platform_lease_owner_token_id'),
    platformLeaseHolder: varchar('platform_lease_holder', { length: 200 }),
    platformLeaseAcquiredAt: timestamp('platform_lease_acquired_at', { withTimezone: true }),
    platformLeaseExpiresAt: timestamp('platform_lease_expires_at', { withTimezone: true }),
    generation: integer('generation').notNull().default(0),
    holderRevision: bigint('holder_revision', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    quiescedGeneration: integer('quiesced_generation').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('instance_maintenance_singleton', sql`${t.id} = 'global'`),
    check('instance_maintenance_generation_order', sql`${t.quiescedGeneration} <= ${t.generation}`),
    check(
      'instance_maintenance_lease_coherent',
      sql`(${t.platformLeaseId} IS NULL AND ${t.platformLeaseOwnerTokenId} IS NULL AND ${t.platformLeaseHolder} IS NULL AND ${t.platformLeaseAcquiredAt} IS NULL AND ${t.platformLeaseExpiresAt} IS NULL) OR (${t.platformLeaseId} IS NOT NULL AND ${t.platformLeaseOwnerTokenId} IS NOT NULL AND ${t.platformLeaseHolder} IS NOT NULL AND ${t.platformLeaseAcquiredAt} IS NOT NULL AND ${t.platformLeaseExpiresAt} IS NOT NULL)`
    ),
  ]
)

export const executionAdmissionReservations = pgTable(
  'execution_admission_reservations',
  {
    executionId: uuid('execution_id')
      .primaryKey()
      .references(() => executions.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    maintenanceStateId: varchar('maintenance_state_id', { length: 32 }).notNull().default('global'),
    token: uuid('token').unique(),
    claimEpoch: bigint('claim_epoch', { mode: 'bigint' }),
    ownerId: varchar('owner_id', { length: 200 }),
    ownerIncarnation: uuid('owner_incarnation'),
    admittedGeneration: integer('admitted_generation'),
    admittedHolderRevision: bigint('admitted_holder_revision', { mode: 'bigint' }),
    state: varchar('state', { length: 32 }).notNull(),
    phase: varchar('phase', { length: 48 }).notNull().default('none'),
    phaseSequence: integer('phase_sequence').notNull().default(0),
    operationId: varchar('operation_id', { length: 255 }),
    resourceKey: varchar('resource_key', { length: 255 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    revokeGeneration: integer('revoke_generation'),
    revokeHolderRevision: bigint('revoke_holder_revision', { mode: 'bigint' }),
    revokeAdminHold: boolean('revoke_admin_hold'),
    revokeLeaseId: uuid('revoke_lease_id'),
    revokeLeaseOwnerTokenId: uuid('revoke_lease_owner_token_id'),
    revokeRequestedAt: timestamp('revoke_requested_at', { withTimezone: true }),
    recoveryOwnerId: varchar('recovery_owner_id', { length: 200 }),
    recoveryOwnerIncarnation: uuid('recovery_owner_incarnation'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_execution_admission_reservations_state_expiry').on(table.state, table.leaseExpiresAt),
    index('idx_execution_admission_reservations_owner').on(table.ownerId, table.ownerIncarnation, table.state),
    uniqueIndex('idx_execution_admission_reservations_agent_current')
      .on(table.agentId)
      .where(sql`${table.agentId} IS NOT NULL AND ${table.state} NOT IN ('released', 'revoked')`),
    check(
      'execution_admission_reservation_epoch_positive',
      sql`${table.claimEpoch} IS NULL OR ${table.claimEpoch} > 0`
    ),
    check(
      'execution_admission_reservation_queue_owner_coherent',
      sql`((${table.token} IS NULL AND ${table.claimEpoch} IS NULL AND ${table.ownerId} IS NULL AND ${table.ownerIncarnation} IS NULL AND ${table.admittedGeneration} IS NULL AND ${table.admittedHolderRevision} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.lastHeartbeatAt} IS NULL) OR (${table.token} IS NOT NULL AND ${table.claimEpoch} IS NOT NULL AND ${table.ownerId} IS NOT NULL AND ${table.ownerIncarnation} IS NOT NULL AND ${table.admittedGeneration} IS NOT NULL AND ${table.admittedHolderRevision} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.lastHeartbeatAt} IS NOT NULL)) AND (${table.state} NOT IN ('queued', 'waiting-maintenance') OR ${table.token} IS NULL)`
    ),
    check(
      'execution_admission_reservation_nonqueue_owner_required',
      sql`${table.state} IN ('queued', 'waiting-maintenance', 'released', 'revoked') OR ${table.ownerId} IS NOT NULL`
    ),
  ]
)

export const instanceMaintenanceAudit = pgTable(
  'instance_maintenance_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    generation: integer('generation').notNull(),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    leaseId: uuid('lease_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    adminHold: boolean('admin_hold').notNull(),
    effective: boolean('effective').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_instance_maintenance_audit_created_at').on(t.createdAt)]
)

// Cache of a generated `devbox.lock` per comfort-set content hash (see
// devbox-seed.ts's computeDevboxSeedHash). `devbox install` resolves every
// `@latest` package against Jetify's Nixhub API over the network UNLESS a
// devbox.lock entry already resolves it — seeding a cached lock into a new
// box's devbox dir before install skips that resolve entirely. Keyed by the
// hash of the PRISTINE role devbox.json (never a user-customized one) so a
// changed comfort set naturally misses the cache; first successful writer
// wins (see DevboxLockCache.storeIfAbsent).
export const devboxLockCache = pgTable('devbox_lock_cache', {
  seedHash: text('seed_hash').primaryKey(),
  lockContent: text('lock_content').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const operationsExecutionAnalyses = pgTable('operations_execution_analyses', {
  executionId: uuid('execution_id')
    .primaryKey()
    .references(() => executions.id, { onDelete: 'cascade' }),
  squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'set null' }),
  algorithmVersion: varchar('algorithm_version', { length: 64 }).notNull(),
  redactionVersion: varchar('redaction_version', { length: 64 }).notNull(),
  result: varchar('result', { length: 16 }).notNull().$type<'analyzed' | 'skipped'>(),
  skipReason: varchar('skip_reason', { length: 80 }),
  signalCount: integer('signal_count').notNull().default(0),
  toolCallCount: integer('tool_call_count').notNull().default(0),
  failedToolCallCount: integer('failed_tool_call_count').notNull().default(0),
  estimatedAvoidableRetries: integer('estimated_avoidable_retries').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  tokenCount: integer('token_count').notNull().default(0),
  analyzedAt: timestamp('analyzed_at').notNull().defaultNow(),
})

export const operationsRecommendations = pgTable(
  'operations_recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    policy: varchar('policy', { length: 32 }).notNull().default('recommendation-only'),
    remediationType: varchar('remediation_type', { length: 64 }).notNull(),
    target: varchar('target', { length: 255 }).notNull(),
    proposedRemediation: jsonb('proposed_remediation').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    status: operationsRecommendationStatusEnum('status').notNull().default('open'),
    confidence: varchar('confidence', { length: 16 }).notNull().default('low'),
    recurrenceCount: integer('recurrence_count').notNull().default(0),
    executionCount: integer('execution_count').notNull().default(0),
    affectedAgentCount: integer('affected_agent_count').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    resolvedAt: timestamp('resolved_at'),
    baseline: jsonb('baseline').notNull(),
    algorithmVersion: varchar('algorithm_version', { length: 64 }).notNull(),
    redactionVersion: varchar('redaction_version', { length: 64 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('operations_recommendations_squad_fingerprint_unique').on(t.squadId, t.fingerprint),
    index('idx_operations_recommendations_squad_status_last_seen').on(t.squadId, t.status, t.lastSeenAt),
  ]
)

export const operationsRecommendationEvidence = pgTable(
  'operations_recommendation_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => operationsRecommendations.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    signalTypes: jsonb('signal_types').notNull(),
    occurrenceCount: integer('occurrence_count').notNull(),
    summary: text('summary').notNull(),
    failedToolCallCount: integer('failed_tool_call_count').notNull().default(0),
    estimatedAvoidableRetries: integer('estimated_avoidable_retries').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),
    observedAt: timestamp('observed_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('operations_recommendation_evidence_recommendation_execution_unique').on(t.recommendationId, t.executionId),
    index('idx_operations_recommendation_evidence_observed').on(t.recommendationId, t.observedAt),
  ]
)

export const operationsRecommendationEvents = pgTable(
  'operations_recommendation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => operationsRecommendations.id, { onDelete: 'cascade' }),
    action: varchar('action', { length: 32 }).notNull().$type<'created' | 'evidence_added' | 'status_changed'>(),
    actor: varchar('actor', { length: 255 }).notNull(),
    fromStatus: operationsRecommendationStatusEnum('from_status'),
    toStatus: operationsRecommendationStatusEnum('to_status'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_operations_recommendation_events_recommendation_created').on(t.recommendationId, t.createdAt)]
)

/** Durable roster and proof for a whole-machine evacuation. */
export const machineEvacuations = pgTable(
  'machine_evacuations',
  {
    id: uuid('id').primaryKey(),
    // Historical receipt identity must survive source/target machine deletion.
    sourceMachineId: uuid('source_machine_id').notNull(),
    targetMachineId: uuid('target_machine_id').notNull(),
    sourceGeneration: integer('source_generation'),
    targetGeneration: integer('target_generation'),
    rosterDigest: varchar('roster_digest', { length: 64 }).notNull(),
    manifestDigest: varchar('manifest_digest', { length: 64 }),
    state: varchar('state', { length: 32 }).notNull().default('inventoried'),
    fencingToken: uuid('fencing_token').notNull(),
    files: integer('files').notNull().default(0),
    bytes: text('bytes').notNull().default('0'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_machine_evacuations_source_state').on(table.sourceMachineId, table.state)]
)

export const machineEvacuationBoxes = pgTable(
  'machine_evacuation_boxes',
  {
    evacuationId: uuid('evacuation_id')
      .notNull()
      .references(() => machineEvacuations.id, { onDelete: 'cascade' }),
    sandboxId: text('sandbox_id').notNull(),
    unixUser: text('unix_user').notNull(),
    manifestDigest: varchar('manifest_digest', { length: 64 }),
    files: integer('files').notNull().default(0),
    bytes: text('bytes').notNull().default('0'),
    verified: boolean('verified').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.evacuationId, table.sandboxId] }),
    index('idx_machine_evacuation_boxes_evacuation').on(table.evacuationId),
  ]
)

/** Durable, content-free audit record for an explicitly forced squad-box migration. */
export const forcedBoxMigrationAudits = pgTable(
  'forced_box_migration_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id').notNull(),
    actorType: varchar('actor_type', { length: 16 }).notNull(),
    actorId: varchar('actor_id', { length: 255 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    sandboxId: varchar('sandbox_id', { length: 255 }).notNull(),
    squadId: uuid('squad_id').notNull(),
    sourceMachineId: uuid('source_machine_id').notNull(),
    targetMachineId: uuid('target_machine_id').notNull(),
    activeExecutionCount: integer('active_execution_count').notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    result: jsonb('result'),
    failureCode: varchar('failure_code', { length: 64 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('forced_box_migration_audits_request_unique').on(table.requestId),
    index('idx_forced_box_migration_audits_sandbox_started').on(table.sandboxId, table.startedAt),
  ]
)

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Legacy import provenance only. New connections are global and leave this null.
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'set null' }),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    adapterVersion: integer('adapter_version').notNull(),
    clientAuthority: varchar('client_authority', { length: 32 }).notNull().default('local'),
    authorizationFlowId: uuid('authorization_flow_id'),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    configuration: jsonb('configuration').notNull(),
    credentialRef: varchar('credential_ref', { length: 255 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    authState: integrationAuthStateEnum('auth_state').notNull().default('pending'),
    healthState: integrationHealthStateEnum('health_state').notNull().default('unknown'),
    grantedScopes: text('granted_scopes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    materialRevision: uuid('material_revision').notNull().defaultRandom(),
    validatedRevision: uuid('validated_revision'),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    validationExpiresAt: timestamp('validation_expires_at', { withTimezone: true }),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    lastHealthyAt: timestamp('last_healthy_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    nextValidationAt: timestamp('next_validation_at', { withTimezone: true }),
    validationFailureCount: integer('validation_failure_count').notNull().default(0),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_integration_connections_id_provider').on(table.id, table.providerKey),
    uniqueIndex('uq_integration_connections_authorization_flow')
      .on(table.authorizationFlowId)
      .where(sql`${table.authorizationFlowId} is not null`),
    uniqueIndex('uq_integration_connections_provider_display_name').on(table.providerKey, table.displayName),
    index('idx_integration_connections_revalidation')
      .on(table.nextValidationAt)
      .where(sql`${table.enabled} = true`),
    check(
      'integration_connections_client_authority_check',
      sql`${table.clientAuthority} in ('local', 'platform_broker')`
    ),
  ]
)

export const integrationOauthStates = pgTable(
  'integration_oauth_states',
  {
    stateHash: varchar('state_hash', { length: 64 }).primaryKey(),
    localFlowId: uuid('local_flow_id'),
    authority: varchar('authority', { length: 32 }).notNull().default('local'),
    completionHandleHash: varchar('completion_handle_hash', { length: 64 }),
    recoveryExpiresAt: timestamp('recovery_expires_at', { withTimezone: true }),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    intent: varchar('intent', { length: 16 }).notNull(),
    connectionId: uuid('connection_id').references(() => integrationConnections.id, { onDelete: 'cascade' }),
    expectedMaterialRevision: uuid('expected_material_revision'),
    redirectUri: varchar('redirect_uri', { length: 2048 }).notNull(),
    returnTo: varchar('return_to', { length: 1024 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_integration_oauth_states_expiry').on(table.expiresAt),
    uniqueIndex('uq_integration_oauth_states_local_flow')
      .on(table.localFlowId)
      .where(sql`${table.localFlowId} is not null`),
    check('integration_oauth_states_hash_format', sql`${table.stateHash} ~ '^[0-9a-f]{64}$'`),
    check('integration_oauth_states_authority_check', sql`${table.authority} in ('local', 'platform_broker')`),
    check(
      'integration_oauth_states_completion_claim_pair',
      sql`(${table.completionHandleHash} IS NULL) = (${table.recoveryExpiresAt} IS NULL)`
    ),
    check(
      'integration_oauth_states_completion_hash_format',
      sql`${table.completionHandleHash} IS NULL OR ${table.completionHandleHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'integration_oauth_states_authority_flow_check',
      sql`(${table.authority} = 'local' AND ${table.localFlowId} IS NULL) OR (${table.authority} = 'platform_broker' AND ${table.localFlowId} IS NOT NULL)`
    ),
    check(
      'integration_oauth_states_intent_context',
      sql`(${table.intent} = 'connect' AND ${table.connectionId} IS NULL AND ${table.expectedMaterialRevision} IS NULL) OR (${table.intent} = 'reconnect' AND ${table.connectionId} IS NOT NULL AND ${table.expectedMaterialRevision} IS NOT NULL)`
    ),
  ]
)

export const integrationAuthorizationFlowReceipts = pgTable(
  'integration_authorization_flow_receipts',
  {
    localFlowId: uuid('local_flow_id').primaryKey(),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    authority: varchar('authority', { length: 32 }).notNull(),
    intent: varchar('intent', { length: 16 }).notNull(),
    initiatingUserId: uuid('initiating_user_id').notNull(),
    returnTo: varchar('return_to', { length: 1024 }).notNull(),
    completionHandleHash: varchar('completion_handle_hash', { length: 64 }).notNull(),
    adapterVersion: integer('adapter_version'),
    sourceConnectionId: uuid('source_connection_id'),
    sourceMaterialRevision: uuid('source_material_revision'),
    artifactCredentialRef: varchar('artifact_credential_ref', { length: 255 }).notNull().unique(),
    stagingStartedAt: timestamp('staging_started_at', { withTimezone: true }),
    installKind: varchar('install_kind', { length: 32 }),
    installedConnectionId: uuid('installed_connection_id'),
    installedMaterialRevision: uuid('installed_material_revision'),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    terminalCode: varchar('terminal_code', { length: 64 }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    revocationRequiredAt: timestamp('revocation_required_at', { withTimezone: true }),
    revocationSettledAt: timestamp('revocation_settled_at', { withTimezone: true }),
    cleanupRequiredAt: timestamp('cleanup_required_at', { withTimezone: true }),
    cleanupSettledAt: timestamp('cleanup_settled_at', { withTimezone: true }),
    recoveryExpiresAt: timestamp('recovery_expires_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_integration_auth_receipts_recovery')
      .on(table.recoveryExpiresAt, table.localFlowId)
      .where(sql`${table.installedAt} IS NULL AND ${table.terminalAt} IS NULL`),
    index('idx_integration_auth_receipts_revocation')
      .on(table.revocationRequiredAt, table.localFlowId)
      .where(sql`${table.revocationRequiredAt} IS NOT NULL AND ${table.revocationSettledAt} IS NULL`),
    index('idx_integration_auth_receipts_cleanup')
      .on(table.cleanupRequiredAt, table.localFlowId)
      .where(sql`${table.cleanupRequiredAt} IS NOT NULL AND ${table.cleanupSettledAt} IS NULL`),
    index('idx_integration_auth_receipts_retention').on(table.retainUntil, table.localFlowId),
    check('integration_auth_receipts_authority_check', sql`${table.authority} in ('local', 'platform_broker')`),
    check(
      'integration_auth_receipts_artifact_ref_binding',
      sql`${table.artifactCredentialRef} = '__integration-credential:authorization-flow:' || ${table.localFlowId}::text || ':bearer'`
    ),
    check('integration_auth_receipts_intent_check', sql`${table.intent} in ('connect', 'reconnect')`),
    check('integration_auth_receipts_handle_hash_format', sql`${table.completionHandleHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'integration_auth_receipts_adapter_version_positive',
      sql`${table.adapterVersion} IS NULL OR ${table.adapterVersion} > 0`
    ),
    check(
      'integration_auth_receipts_intent_context',
      sql`(${table.intent} = 'connect' AND ${table.sourceConnectionId} IS NULL AND ${table.sourceMaterialRevision} IS NULL) OR (${table.intent} = 'reconnect' AND ${table.sourceConnectionId} IS NOT NULL AND ${table.sourceMaterialRevision} IS NOT NULL)`
    ),
    check(
      'integration_auth_receipts_terminal_pair',
      sql`(${table.terminalCode} IS NULL) = (${table.terminalAt} IS NULL)`
    ),
    check(
      'integration_auth_receipts_terminal_code_format',
      sql`${table.terminalCode} IS NULL OR ${table.terminalCode} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`
    ),
    check(
      'integration_auth_receipts_install_kind_check',
      sql`${table.installKind} IS NULL OR ${table.installKind} in ('connect', 'reconnect_same', 'reconnect_distinct')`
    ),
    check(
      'integration_auth_receipts_staging_tuple',
      sql`(${table.stagingStartedAt} IS NULL) = (${table.adapterVersion} IS NULL)`
    ),
    check(
      'integration_auth_receipts_install_tuple',
      sql`(${table.installKind} IS NULL AND ${table.installedConnectionId} IS NULL AND ${table.installedMaterialRevision} IS NULL AND ${table.installedAt} IS NULL) OR (${table.installKind} IS NOT NULL AND ${table.installedConnectionId} IS NOT NULL AND ${table.installedMaterialRevision} IS NOT NULL AND ${table.installedAt} IS NOT NULL AND ${table.stagingStartedAt} IS NOT NULL AND ${table.adapterVersion} IS NOT NULL)`
    ),
    check(
      'integration_auth_receipts_install_intent',
      sql`${table.installKind} IS NULL OR (${table.intent} = 'connect' AND ${table.installKind} = 'connect') OR (${table.intent} = 'reconnect' AND ${table.installKind} in ('reconnect_same', 'reconnect_distinct'))`
    ),
    check(
      'integration_auth_receipts_install_terminal_exclusive',
      sql`${table.terminalAt} IS NULL OR ${table.installedAt} IS NULL`
    ),
    check(
      'integration_auth_receipts_revocation_settlement',
      sql`${table.revocationSettledAt} IS NULL OR (${table.revocationRequiredAt} IS NOT NULL AND ${table.revocationSettledAt} >= ${table.revocationRequiredAt})`
    ),
    check(
      'integration_auth_receipts_cleanup_settlement',
      sql`${table.cleanupSettledAt} IS NULL OR (${table.cleanupRequiredAt} IS NOT NULL AND ${table.cleanupSettledAt} >= ${table.cleanupRequiredAt})`
    ),
    check(
      'integration_auth_receipts_obligation_disposition',
      sql`(${table.revocationRequiredAt} IS NULL AND ${table.cleanupRequiredAt} IS NULL) OR ${table.terminalAt} IS NOT NULL OR ${table.installedAt} IS NOT NULL`
    ),
    check('integration_auth_receipts_retention_window', sql`${table.retainUntil} >= ${table.recoveryExpiresAt}`),
  ]
)

export const integrationDeviceAuthorizations = pgTable(
  'integration_device_authorizations',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => integrationAuthorizationFlowReceipts.localFlowId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientBinding: jsonb('client_binding').notNull(),
    userCode: varchar('user_code', { length: 64 }).notNull(),
    verificationUri: varchar('verification_uri', { length: 2048 }).notNull(),
    encryptedDeviceCode: text('encrypted_device_code'),
    deviceCodeIv: text('device_code_iv'),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    intervalSeconds: integer('interval_seconds').notNull(),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_integration_device_authorizations_expiry').on(table.expiresAt),
    index('idx_integration_device_authorizations_user').on(table.userId),
    check('integration_device_authorizations_status', sql`${table.status} in ('pending', 'authorized')`),
    check('integration_device_authorizations_interval', sql`${table.intervalSeconds} between 1 and 3600`),
    check(
      'integration_device_authorizations_secret',
      sql`(${table.status} = 'pending' AND ${table.encryptedDeviceCode} IS NOT NULL AND ${table.deviceCodeIv} IS NOT NULL) OR (${table.status} = 'authorized' AND ${table.encryptedDeviceCode} IS NULL AND ${table.deviceCodeIv} IS NULL)`
    ),
  ]
)

export const integrationConnectionAssignments = pgTable(
  'integration_connection_assignments',
  {
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    connectionId: uuid('connection_id').notNull(),
    isDefault: boolean('is_default').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.squadId, table.providerKey, table.connectionId] }),
    uniqueIndex('uq_integration_assignments_default')
      .on(table.squadId, table.providerKey)
      .where(sql`${table.isDefault} = true`),
    foreignKey({
      columns: [table.connectionId, table.providerKey],
      foreignColumns: [integrationConnections.id, integrationConnections.providerKey],
      name: 'integration_connection_assignments_connection_provider_fk',
    }).onDelete('cascade'),
    index('idx_integration_connection_assignments_connection').on(table.connectionId, table.squadId),
  ]
)

export const integrationProjectionStates = pgTable(
  'integration_projection_states',
  {
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    generation: bigint('generation', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    status: integrationProjectionStatusEnum('status').notNull().default('pending'),
    desiredFingerprint: varchar('desired_fingerprint', { length: 64 }),
    appliedFingerprint: varchar('applied_fingerprint', { length: 64 }),
    desiredCredentialRevision: bigint('desired_credential_revision', { mode: 'bigint' }),
    appliedCredentialRevision: bigint('applied_credential_revision', { mode: 'bigint' }),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.squadId, table.providerKey] }),
    index('idx_integration_projection_states_due').on(table.nextAttemptAt, table.leaseExpiresAt),
    check('integration_projection_states_generation_positive', sql`${table.generation} > 0`),
    check(
      'integration_projection_states_lease_pair',
      sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`
    ),
  ]
)

export const integrationCredentialCleanupJobs = pgTable(
  'integration_credential_cleanup_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    credentialRef: varchar('credential_ref', { length: 255 })
      .notNull()
      .unique()
      .references(() => secrets.key, { onDelete: 'restrict' }),
    authorizationFlowId: uuid('authorization_flow_id').references(
      () => integrationAuthorizationFlowReceipts.localFlowId,
      { onDelete: 'restrict' }
    ),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_integration_credential_cleanup_due').on(table.nextAttemptAt, table.leaseExpiresAt),
    index('idx_integration_credential_cleanup_flow').on(table.authorizationFlowId),
    check(
      'integration_credential_cleanup_lease_pair',
      sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`
    ),
  ]
)

export const integrationRevocationJobs = pgTable(
  'integration_revocation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    adapterVersion: integer('adapter_version').notNull(),
    clientAuthority: varchar('client_authority', { length: 32 }).notNull().default('local'),
    authorizationFlowId: uuid('authorization_flow_id').references(
      () => integrationAuthorizationFlowReceipts.localFlowId,
      { onDelete: 'restrict' }
    ),
    credentialRef: varchar('credential_ref', { length: 255 })
      .notNull()
      .unique('integration_revocation_jobs_credential_ref_unique')
      .references(() => secrets.key, { onDelete: 'restrict' }),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_integration_revocation_jobs_due')
      .on(table.nextAttemptAt, table.leaseExpiresAt)
      .where(sql`${table.terminalAt} IS NULL`),
    index('idx_integration_revocation_jobs_flow').on(table.authorizationFlowId),
    check(
      'integration_revocation_jobs_lease_pair',
      sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`
    ),
    check(
      'integration_revocation_jobs_client_authority_check',
      sql`${table.clientAuthority} in ('local', 'platform_broker')`
    ),
  ]
)

export const integrationExportConsents = pgTable(
  'integration_export_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    consentedByUserId: uuid('consented_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    policyVersion: integer('policy_version').notNull().default(1),
    projectionVersion: integer('projection_version').notNull().default(1),
    adoptedEnqueueOrder: bigint('adopted_enqueue_order', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_integration_export_consents_active_agent')
      .on(table.agentId)
      .where(sql`${table.revokedAt} IS NULL`),
    index('idx_integration_export_consents_connection').on(table.connectionId),
  ]
)

export const integrationExportCursors = pgTable('integration_export_cursors', {
  id: uuid('id').primaryKey().defaultRandom(),
  consentId: uuid('consent_id')
    .notNull()
    .unique()
    .references(() => integrationExportConsents.id, { onDelete: 'cascade' }),
  lastDeliveredEnqueueOrder: bigint('last_delivered_enqueue_order', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const integrationExportBatches = pgTable(
  'integration_export_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cursorId: uuid('cursor_id')
      .notNull()
      .references(() => integrationExportCursors.id, { onDelete: 'cascade' }),
    idempotencyKey: uuid('idempotency_key').notNull().defaultRandom(),
    firstEnqueueOrder: bigint('first_enqueue_order', { mode: 'bigint' }).notNull(),
    lastEnqueueOrder: bigint('last_enqueue_order', { mode: 'bigint' }).notNull(),
    recordCount: integer('record_count').notNull(),
    byteCount: integer('byte_count').notNull(),
    encryptedPayload: text('encrypted_payload'),
    payloadIv: text('payload_iv'),
    state: integrationExportBatchStateEnum('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_integration_export_batches_idempotency').on(table.idempotencyKey),
    unique('uq_integration_export_batches_cursor_first_order').on(table.cursorId, table.firstEnqueueOrder),
    index('idx_integration_export_batches_due').on(table.nextAttemptAt, table.state),
  ]
)

export const slotPools = pgTable(
  'slot_pools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    squadId: uuid('squad_id')
      .notNull()
      .references(() => squads.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    capacity: integer('capacity').notNull().default(1),
    claimTimeoutMs: integer('claim_timeout_ms').notNull().default(3_600_000),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    unregisteredAt: timestamp('unregistered_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_slot_pools_active_key_unique')
      .on(table.squadId, table.key)
      .where(sql`${table.unregisteredAt} IS NULL`),
    check('slot_pools_key_format', sql`${table.key} ~ '^[a-z][a-z0-9._-]{0,63}$'`),
    check('slot_pools_capacity_positive', sql`${table.capacity} >= 1`),
    check(
      'slot_pools_claim_timeout_bounds',
      sql`${table.claimTimeoutMs} >= 60000 AND ${table.claimTimeoutMs} <= 86400000`
    ),
  ]
)

export const slotClaims = pgTable(
  'slot_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => slotPools.id, { onDelete: 'restrict' }),
    ownerAgentId: uuid('owner_agent_id').notNull(),
    status: slotClaimStatusEnum('status').notNull().default('active'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    terminalReason: varchar('terminal_reason', { length: 64 }),
  },
  (table) => [
    uniqueIndex('idx_slot_claims_active_owner_unique')
      .on(table.poolId, table.ownerAgentId)
      .where(sql`${table.status} = 'active'`),
    index('idx_slot_claims_due').on(table.poolId, table.status, table.expiresAt),
  ]
)

export const slotWaiters = pgTable(
  'slot_waiters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => slotPools.id, { onDelete: 'restrict' }),
    ownerAgentId: uuid('owner_agent_id').notNull(),
    enqueueSequence: bigint('enqueue_sequence', { mode: 'bigint' })
      .notNull()
      .default(sql`nextval('slot_waiter_enqueue_seq'::regclass)`),
    status: slotWaiterStatusEnum('status').notNull().default('queued'),
    resultingClaimId: uuid('resulting_claim_id').references(() => slotClaims.id, { onDelete: 'restrict' }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    terminalReason: varchar('terminal_reason', { length: 64 }),
  },
  (table) => [
    uniqueIndex('idx_slot_waiters_queued_owner_unique')
      .on(table.poolId, table.ownerAgentId)
      .where(sql`${table.status} = 'queued'`),
    index('idx_slot_waiters_fifo').on(table.poolId, table.enqueueSequence, table.id),
  ]
)

export const slotNotifications = pgTable(
  'slot_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => slotPools.id, { onDelete: 'restrict' }),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => slotClaims.id, { onDelete: 'restrict' }),
    recipientAgentId: uuid('recipient_agent_id').notNull(),
    kind: slotNotificationKindEnum('kind').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull().unique(),
    status: slotNotificationStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimToken: uuid('claim_token'),
    inboxId: uuid('inbox_id').references(() => inbox.id, { onDelete: 'set null' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_slot_notifications_due').on(table.status, table.nextAttemptAt, table.claimedAt),
    check('slot_notifications_delivery_claim_pair', sql`(${table.claimedAt} IS NULL) = (${table.claimToken} IS NULL)`),
  ]
)

export const integrationAuditEvents = pgTable(
  'integration_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id').references(() => integrationConnections.id, { onDelete: 'set null' }),
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    capability: varchar('capability', { length: 64 }),
    action: varchar('action', { length: 64 }).notNull(),
    outcome: varchar('outcome', { length: 32 }).notNull(),
    requestId: uuid('request_id'),
    idempotencyKey: uuid('idempotency_key'),
    recordCount: integer('record_count'),
    byteCount: integer('byte_count'),
    code: varchar('code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_integration_audit_events_squad_created').on(table.squadId, table.createdAt)]
)

/** Saved Assistant history is independent of a live Realtime connection or delegated agent. */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which assistant this is: the app-wide Assistant, or a page editor bound to one draft. */
    kind: varchar('kind', { length: 20 })
      .$type<import('@ficus/shared').AssistantConversationKind>()
      .notNull()
      .default('assistant'),
    title: text('title').notNull().default('New conversation'),
    editor: jsonb('editor').$type<import('@ficus/shared').AssistantEditorState>(),
    /** Durable conversation agent. NULL until the owner first opens the agent-backed conversation. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    inboxConsumerId: uuid('inbox_consumer_id'),
    inboxConsumerExpiresAt: timestamp('inbox_consumer_expires_at', { withTimezone: true }),
    /** Last allocated assistant_updates.sequence; incremented under the conversation row lock. */
    nextUpdateSequence: integer('next_update_sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_assistant_conversations_owner_updated').on(table.ownerUserId, table.updatedAt),
    uniqueIndex('uq_assistant_conversations_agent').on(table.agentId),
  ]
)

export const assistantConversationAgents = pgTable(
  'assistant_conversation_agents',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    // NULL = the conversation's general helper (system-manager); otherwise the owned consultant for that squad.
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.agentId] }),
    uniqueIndex('uq_assistant_conversation_agents_general')
      .on(table.conversationId)
      .where(sql`${table.squadId} IS NULL`),
    uniqueIndex('uq_assistant_conversation_agents_squad')
      .on(table.conversationId, table.squadId)
      .where(sql`${table.squadId} IS NOT NULL`),
    index('idx_assistant_conversation_agents_agent').on(table.agentId),
  ]
)

export const assistantEntries = pgTable(
  'assistant_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    clientId: varchar('client_id', { length: 160 }).notNull(),
    position: integer('position').notNull(),
    entry: jsonb('entry').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('assistant_entries_client_key').on(table.conversationId, table.clientId),
    unique('assistant_entries_position').on(table.conversationId, table.position),
  ]
)

/**
 * One delegated Assistant request chain. The ID is the first outgoing inbox request; the current
 * request advances when the user answers. Conversation deletion owns this lifecycle; agents and
 * individual inbox rows never cascade into it.
 */
export const assistantTasks = pgTable(
  'assistant_tasks',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    currentRequestId: uuid('current_request_id').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    kind: varchar('kind', { length: 20 }).$type<import('@ficus/shared').AssistantMessageTargetKind>().notNull(),
    squadId: uuid('squad_id').references(() => squads.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    status: varchar('status', { length: 20 }).$type<import('@ficus/shared').AssistantTaskStatus>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_assistant_tasks_conversation_updated').on(table.conversationId, table.updatedAt, table.id)]
)

/** Durable tracking state for one inbox update delivered to a saved Assistant mailbox. The inbox row owns the body. */
export const assistantUpdates = pgTable(
  'assistant_updates',
  {
    messageId: uuid('message_id')
      .primaryKey()
      .references(() => inbox.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => assistantTasks.id, { onDelete: 'set null' }),
    requestId: uuid('request_id'),
    sequence: integer('sequence').notNull(),
    reportedStatus: varchar('reported_status', { length: 20 }).$type<import('@ficus/shared').AssistantTaskStatus>(),
    /** Durable inbox delivery to the conversational agent; separate from confirmed consumption. */
    forwardedMessageId: uuid('forwarded_message_id'),
    /** Assistant response that summarized the confirmed update. */
    summarizedMessageId: uuid('summarized_message_id'),
    /** Realtime presented or deliberately interrupted this update. Never implies the human saw it. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** The human acknowledged this update (visible render or explicit mark-read). */
    seenAt: timestamp('seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('assistant_updates_sequence').on(table.conversationId, table.sequence),
    index('idx_assistant_updates_unseen')
      .on(table.conversationId, table.sequence)
      .where(sql`${table.seenAt} IS NULL`),
    index('idx_assistant_updates_unprocessed')
      .on(table.conversationId, table.sequence)
      .where(sql`${table.processedAt} IS NULL`),
  ]
)

// Latest scan, cross-process lease, and durable capacity-alert outbox.
export const storageMonitor = pgTable('storage_monitor', {
  id: text('id').primaryKey(),
  snapshot: jsonb('snapshot').$type<import('@ficus/shared').StorageSnapshot>(),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  leaseId: uuid('lease_id'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  error: text('error'),
  levels: jsonb('levels').$type<Record<string, import('@ficus/shared').StorageWarning>>().notNull().default({}),
  pendingAlerts: jsonb('pending_alerts')
    .$type<Array<{ id: string; warning: import('@ficus/shared').StorageWarning }>>()
    .notNull()
    .default([]),
})
