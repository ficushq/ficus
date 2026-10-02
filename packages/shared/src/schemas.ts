import { z } from 'zod'
import { workflowSourceSchema, workflowEventTriggerSchema } from './workflows'
import { squadEventRulesSchema } from './squad-event-rules'
import { AGENT_STATUSES, WORK_STREAM_COMPLETION_MODES, WORK_STREAM_PRIORITIES, WORK_STREAM_WAIT_ACTORS } from './types'
import { IMAGE_ATTACHMENT_MIME_TYPES, MAX_IMAGE_ATTACHMENTS_PER_MESSAGE } from './image-attachments'
import { reportableAssistantTaskStatusSchema } from './assistant-activity'

export const chatScopeTypeSchema = z.enum(['system-manager', 'heartbeat', 'consultant'])

export const agentStatusSchema = z.enum(AGENT_STATUSES)

export const executionStatusSchema = z.enum([
  'queued',
  'waiting-maintenance',
  'waiting-sandbox',
  'running',
  'stopping',
  'stopped',
  'completed',
  'failed',
])

export const spawnSquadAgentSchema = z.object({
  agentTypeId: z.string().min(1),
  workStreamId: z.string().min(1).max(36).optional(),
  model: z.string().trim().min(1).optional(),
})

export const chatScopeSchema = z.object({
  type: chatScopeTypeSchema,
  id: z.string().uuid().optional(),
})

export const imageContentSchema = z.object({
  type: z.literal('image'),
  data: z.string(), // base64
  mimeType: z.enum(IMAGE_ATTACHMENT_MIME_TYPES),
})

export const chatPagePathSchema = z
  .string()
  .max(2048)
  .regex(/^\/[^\r\n?#]*$/)

export const chatRequestSchema = z
  .object({
    message: z.string(),
    pagePath: chatPagePathSchema.optional(),
    agentId: z.string().uuid().optional(),
    scope: chatScopeSchema.optional(),
    imageIds: z.array(z.string().uuid()).max(MAX_IMAGE_ATTACHMENTS_PER_MESSAGE).optional(),
    deliveryMode: z.enum(['steer', 'follow-up']).optional(),
    clientId: z.string().max(128).optional(),
  })
  .refine((value) => value.message.trim().length > 0 || Boolean(value.imageIds?.length), {
    message: 'Message content or an image attachment is required',
  })

// Squad schemas
export const squadStatusSchema = z.enum(['active', 'paused', 'archived'])

export const squadGithubIdentitySchema = z
  .object({
    githubTokenSecretKey: z.string().trim().min(1).max(255).optional(),
    gitUserName: z.string().trim().min(1).max(200).optional(),
    gitUserEmail: z.string().trim().email().max(320).optional(),
  })
  .strict()

const MAX_TOOLCHAIN_PACKAGES = 64
const MAX_TOOLCHAIN_PACKAGE_BYTES = 255
const MAX_TOOLCHAIN_PACKAGE_TEXT_BYTES = 8 * 1024
const MAX_TOOLCHAIN_SETUP_BYTES = 64 * 1024
const shellMetacharacter = /["'`$;&|<>()[\]{}\\*!?]/

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

const packageSpecSchema = z
  .string()
  .refine((value) => value === value.trim() && value.length > 0, 'Package specs must not be empty or padded')
  .refine((value) => !/\s|\p{Cc}/u.test(value), 'Package specs must not contain whitespace or control characters')
  .refine((value) => !shellMetacharacter.test(value), 'Package specs must not contain shell metacharacters')
  .refine((value) => utf8Bytes(value) <= MAX_TOOLCHAIN_PACKAGE_BYTES, 'Package spec is too long')

export const squadToolchainSchema = z
  .object({
    packages: z.array(packageSpecSchema).max(MAX_TOOLCHAIN_PACKAGES),
    setupScript: z
      .string()
      .refine((value) => !value.includes('\0'), 'Setup script must not contain NUL')
      .refine((value) => utf8Bytes(value) <= MAX_TOOLCHAIN_SETUP_BYTES, 'Setup script is too long')
      .optional(),
  })
  .strict()
  .superRefine((toolchain, ctx) => {
    if (new Set(toolchain.packages).size !== toolchain.packages.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['packages'], message: 'Package specs must be unique' })
    }
    if (utf8Bytes(toolchain.packages.join('')) > MAX_TOOLCHAIN_PACKAGE_TEXT_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['packages'], message: 'Package specs are too long' })
    }
  })

export const squadWorkflowSetupSchema = z
  .object({
    guidance: z.string().trim().max(16000),
    choices: z
      .array(z.object({ when: z.string().trim().min(1).max(2000), source: workflowSourceSchema }).strict())
      .max(32),
    completedAt: z.string().datetime().optional(),
  })
  .strict()

/** A squad preset recommends a library of flows; it never starts their participants. */
export const squadPresetWorkflowsSchema = z
  .object({
    default: workflowSourceSchema,
    guidance: z.string().trim().max(16000).default(''),
    choices: squadWorkflowSetupSchema.shape.choices.default([]),
  })
  .strict()
export type SquadPresetWorkflows = z.infer<typeof squadPresetWorkflowsSchema>

export const squadMetadataSchema = z.record(z.unknown()).superRefine((metadata, ctx) => {
  if (metadata.integrationRules !== undefined) {
    const result = squadEventRulesSchema.safeParse(metadata.integrationRules)
    if (!result.success)
      for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ['integrationRules', ...issue.path] })
  }
  if (metadata.integrationTriggers !== undefined && metadata.integrationTriggers !== null) {
    const result = z
      .array(workflowEventTriggerSchema)
      .max(32)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'Duplicate trigger ID')
      .safeParse(metadata.integrationTriggers)
    if (!result.success)
      for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ['integrationTriggers', ...issue.path] })
  }
  if (metadata.workflowSetup !== undefined && metadata.workflowSetup !== null) {
    const setup = squadWorkflowSetupSchema.safeParse(metadata.workflowSetup)
    if (!setup.success)
      for (const issue of setup.error.issues) ctx.addIssue({ ...issue, path: ['workflowSetup', ...issue.path] })
  }
  if (metadata.workflow !== undefined && metadata.workflow !== null) {
    const result = workflowSourceSchema.safeParse(metadata.workflow)
    if (!result.success)
      for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ['workflow', ...issue.path] })
  }
  const schemas: Array<[string, z.ZodTypeAny]> = [
    ['githubIdentity', squadGithubIdentitySchema],
    ['sandbox.toolchain', squadToolchainSchema.nullable()],
  ]

  for (const [key, schema] of schemas) {
    const path = key.split('.')
    const value = path.reduce<unknown>((current, segment) => {
      return current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined
    }, metadata)
    if (value === undefined) continue

    const result = schema.safeParse(value)
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: [...path, ...issue.path] })
      }
    }
  }
})

/** Host runtime squad workspace override: absolute, no `..` segments. */
export const hostWorkspacePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/') && p !== '/' && !p.includes('\0') && !p.split('/').includes('..'), {
    message: 'hostWorkspacePath must be an absolute path (not "/") without ".." segments or NUL bytes',
  })

export const createSquadSchema = z.object({
  name: z.string().min(1).max(200),
  purpose: z.string().default(''),
  squadPresetId: z.string().optional(),
  defaultAgents: z.array(z.string()).optional(),
  context: z.string().optional(),
  typeContext: z.record(z.string(), z.string()).optional(),
  metadata: squadMetadataSchema.optional().default({}),
  globalCollaborationEnabled: z.boolean().optional(),
  hostWorkspacePath: hostWorkspacePathSchema.optional(),
})

export const updateSquadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  purpose: z.string().optional(),
  status: squadStatusSchema.optional(),
  defaultAgents: z.array(z.string()).optional(),
  context: z.string().nullable().optional(),
  typeContext: z.record(z.string(), z.string().nullable()).nullable().optional(),
  order: z.number().int().min(0).optional(),
  metadata: squadMetadataSchema.optional(),
  globalCollaborationEnabled: z.boolean().optional(),
  // Concurrency cap for admitted work streams; null = unlimited. Lowering never evicts.
  maxConcurrentWorkStreams: z.number().int().min(1).nullable().optional(),
  // Auto-park grace minutes for active streams with open waits; null → default 30; 0 = immediate.
  blockedGraceMinutes: z.number().int().min(0).nullable().optional(),
  // vm runtime: pin the squad's box to a machine (null unpins). Ignored by k8s/docker.
  machineId: z.string().uuid().nullable().optional(),
  // host runtime: absolute directory this squad works in (null = default storage path).
  hostWorkspacePath: hostWorkspacePathSchema.nullable().optional(),
})

export const reorderSquadsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
})

// Squad relationship schemas
export const squadRelationshipTypeSchema = z.enum(['reports_to', 'collaborates', 'depends_on'])

export const createSquadRelationshipSchema = z.object({
  sourceSquadId: z.string().uuid(),
  targetSquadId: z.string().uuid(),
  relationshipType: squadRelationshipTypeSchema,
  metadata: z.record(z.unknown()).optional().default({}),
})

// Work Stream schemas
export const workStreamStatusSchema = z.enum(['queued', 'active', 'done', 'canceled'])

/**
 * Status WRITE input: accepts the current vocabulary plus the legacy aliases
 * `pending` → `queued` and `in_progress` → `active` for one release.
 * `blocked` and `review` are no longer statuses — they are typed waits with
 * their own verbs — so writes of those values are rejected with a pointer.
 */
export const workStreamStatusWriteSchema = z
  .enum(['queued', 'active', 'done', 'canceled', 'pending', 'in_progress', 'blocked', 'review'])
  .superRefine((value, ctx) => {
    if (value === 'blocked') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'blocked' is no longer a status — request input instead (ficus ws request-input / POST /:id/request-input)",
      })
    }
    if (value === 'review') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'review' is no longer a status — request review instead (ficus ws request-review / POST /:id/request-review)",
      })
    }
  })
  .transform((value): z.infer<typeof workStreamStatusSchema> => {
    if (value === 'pending') return 'queued'
    if (value === 'in_progress') return 'active'
    return value as z.infer<typeof workStreamStatusSchema>
  })

export const workStreamWaitTypeSchema = z.enum(['dependency', 'question', 'review', 'manual'])
export const workStreamWaitResolutionSchema = z.enum(['satisfied', 'answered', 'approved', 'sent_back', 'cleared'])
export const workStreamPrioritySchema = z.enum(WORK_STREAM_PRIORITIES)
export const workStreamPromptTypeSchema = z.enum(['text', 'select', 'multi_select'])
export const workStreamCompletionModeSchema = z.enum(WORK_STREAM_COMPLETION_MODES)
export const workStreamSourceLinkKindSchema = z.enum([
  'memory_document',
  'agent_thread',
  'slack_thread',
  'github_issue',
  'linear_issue',
  'channel_message',
  'url',
])
export const workStreamSourceLinkSchema = z.object({
  kind: workStreamSourceLinkKindSchema,
  sourceSquadId: z.string().optional(),
  sourceId: z.string().optional(),
  path: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  addedAt: z.string().optional(),
})

export const workStreamPromptSchema = z.object({
  type: workStreamPromptTypeSchema,
  message: z.string().min(1),
  options: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
})

export const createWorkStreamSchema = z
  .object({
    observe: z.literal('terminal').optional(),
    workflow: workflowSourceSchema.optional(),
    autoCleanupWorktree: z.boolean().optional(),
    squadId: z.string().min(1),
    title: z.string().min(1).max(500),
    description: z.string().optional().default(''),
    assigneeAgentId: z.string().optional(),
    /** Legacy input retained for a clear rejection from the creation boundary. */
    assigneeAgentIndex: z.number().int().min(0).optional(),
    ownerAgentId: z.string().nullable().optional(),
    agentIds: z.array(z.string()).optional(),
    assignedReviewerIds: z.array(z.string().uuid()).max(64).optional(),
    /** Legacy input retained for a clear rejection from the creation boundary. */
    agents: z.array(z.string().min(1)).optional(),
    /** Legacy input; participant models now belong to the flow. */
    agentModelOverrides: z.record(z.string(), z.string()).optional(),
    handoffMessage: z.string().nullable().optional(),
    /** Attribute the request to a specific user (agent creators only; ignored for direct user creates). */
    requestingUserId: z.string().uuid().nullable().optional(),
    dependsOn: z.array(z.string()).optional().default([]),
    priority: workStreamPrioritySchema.optional(),
    metadata: z.record(z.unknown()).optional().default({}),
    /** Create from an observed integration event: tracks its resource and reuses the stream that already handles it. */
    integrationEventId: z.string().uuid().optional(),
    completionMode: workStreamCompletionModeSchema.optional(),
    repository: z.string().min(1).optional(),
    gitRemote: z.string().min(1).optional(),
    baseSource: z.enum(['remote', 'local']).optional(),
    branch: z.string().min(1).optional(),
    worktree: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
  })
  .refine((data) => !(data.assigneeAgentId !== undefined && data.assigneeAgentIndex !== undefined), {
    message: 'Cannot specify both assigneeAgentId and assigneeAgentIndex',
    path: ['assigneeAgentIndex'],
  })

export const updateWorkStreamSchema = z.object({
  autoCleanupWorktree: z.boolean().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  status: workStreamStatusWriteSchema.optional(),
  priority: workStreamPrioritySchema.optional(),
  assigneeAgentId: z.string().nullable().optional(),
  ownerAgentId: z.string().nullable().optional(),
  agentIds: z.array(z.string()).nullable().optional(),
  assignedReviewerIds: z.array(z.string().uuid()).max(64).optional(),
  dependsOn: z.array(z.string()).optional(),
  handoffMessage: z.string().nullable().optional(),
  files: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  nextSteps: z.string().min(1).optional(),
  completionMode: workStreamCompletionModeSchema.optional(),
  repository: z.string().min(1).optional(),
  gitRemote: z.string().min(1).optional(),
  baseSource: z.enum(['remote', 'local']).optional(),
  branch: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
})

export const parkWorkStreamSchema = z.object({
  preemptRunning: z.boolean().optional(),
})

// Wait verbs

/** Resolutions a caller may apply via POST /:id/waits/:waitId/resolve. */
export const workStreamWaitCallerResolutionSchema = z.enum(['approved', 'sent_back', 'cleared'])

/**
 * Typed wait resolution (replaces the legacy free-text respond verb).
 * Validity per wait type is enforced by the entity: review → approved |
 * sent_back (note required); manual → cleared; question/dependency → never
 * via this schema's endpoint.
 */
export const resolveWorkStreamWaitSchema = z
  .object({
    resolution: workStreamWaitCallerResolutionSchema,
    /** Resolution note; required for sent_back, optional for cleared. */
    note: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.resolution === 'sent_back' && (!value.note || value.note.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: "resolution 'sent_back' requires a non-empty note",
      })
    }
  })

export const requestReviewWorkStreamSchema = z.object({
  /** What to review; stored on the review wait. */
  message: z.string().min(1),
  /**
   * Default true: approving the review completes the stream in one
   * transaction. False (CLI --no-complete) = mid-work checkpoint review —
   * approval resolves the wait only and the stream continues.
   */
  completesOnApproval: z.boolean().optional(),
})

export const approveWorkStreamSchema = z.object({
  /** Optional approval note (spec §4b): recorded as the approved review wait's resolutionNote and delivered with the outcome notification. */
  note: z.string().min(1).optional(),
})

export const sendBackWorkStreamSchema = z.object({
  /** Required send-back feedback; stored as the review wait's resolutionNote. */
  note: z.string().min(1),
})

export const requestInputWorkStreamSchema = z.object({
  scope: z.enum(['stream', 'attempt']).optional(),
  flowAttemptId: z.number().int().positive().optional(),
  /** What input/action is needed, and from whom; stored on the manual wait. */
  message: z.string().min(1),
  /** Who must act: human (default) or owner (the stream's owning agent). */
  actor: z.enum(WORK_STREAM_WAIT_ACTORS).optional(),
})

/** Correct who must act on one open manual wait. */
export const setWorkStreamWaitActorSchema = z.object({
  actor: z.enum(WORK_STREAM_WAIT_ACTORS),
  note: z.string().min(1).optional(),
})

export const unblockWorkStreamSchema = z.object({
  note: z.string().min(1).optional(),
})

export const setQuestionBlockingSchema = z.object({
  blocking: z.boolean(),
})

// Squad schedule schemas
export const squadScheduleSpawnAgentActionSchema = z
  .object({
    type: z.literal('spawn_agent'),
    agentTypeId: z.string().min(1),
    prompt: z.string().min(1),
    workStream: z
      .object({
        title: z.string().min(1).max(500),
        description: z.string().optional(),
        completionMode: workStreamCompletionModeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const squadScheduleInboxMessageActionSchema = z
  .object({
    type: z.literal('inbox_message'),
    targetAgentId: z.string().min(1),
    subject: z.string().optional(),
    content: z.string().min(1),
  })
  .strict()

export const squadScheduleCreateWorkStreamActionSchema = z
  .object({
    type: z.literal('create_work_stream'),
    workflow: workflowSourceSchema.optional(),
    title: z.string().min(1).max(500),
    description: z.string().optional(),
    assigneeAgentId: z.string().optional(),
    completionMode: workStreamCompletionModeSchema.optional(),
  })
  .strict()

export const squadScheduleActionSchema = z.discriminatedUnion('type', [
  squadScheduleSpawnAgentActionSchema,
  squadScheduleInboxMessageActionSchema,
  squadScheduleCreateWorkStreamActionSchema,
])

export const squadScheduleConfigSchema = z
  .object({
    interval: z.string().optional(),
    cron: z.string().optional(),
    runAt: z.string().optional(),
    skipIfUnresolved: z.boolean().optional(),
  })
  .superRefine((schedule, ctx) => {
    const timingCount =
      Number(Boolean(schedule.interval)) + Number(Boolean(schedule.cron)) + Number(Boolean(schedule.runAt))

    if (timingCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Schedule must set exactly one of: interval, cron, runAt',
      })
    }
  })

export const createSquadScheduleSchema = z.object({
  squadId: z.string().min(1),
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional().default(true),
  schedule: squadScheduleConfigSchema,
  action: squadScheduleActionSchema,
})

export const updateSquadScheduleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  schedule: squadScheduleConfigSchema.optional(),
  action: squadScheduleActionSchema.optional(),
})

// Federation schemas
export const createPeerSchema = z.object({
  localAlias: z.string().min(1).max(200),
  instanceId: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  publicKeyPem: z.string().min(1),
})

export const updatePeerSchema = z.object({
  localAlias: z.string().min(1).max(200).optional(),
  baseUrl: z.string().url().optional(),
  publicKeyPem: z.string().min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
})

// Slice 5: claim a federation handle for an agent. Any client-supplied key is ignored
// (server uses the C1-recorded identityPublicKey); unknown keys are stripped by zod.
// Handle charset: must start with a letter or digit; only letters, digits, hyphen, underscore
// allowed thereafter. This ensures round-trip safety through parseAmtpAddress
// (which rejects handles containing '/' or whitespace).
export const registerAgentSchema = z.object({
  handle: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .max(200),
})

export const createAmtpAllowRuleSchema = z.object({
  peerInstanceId: z.string().min(1).max(64),
  principalKind: z.enum(['any', 'handle']),
  principalValue: z.string().min(1).max(200).optional(),
})

// The envelope schema + its attachment-ref schema live in amtp-protocol; re-exported here so
// existing `@ficus/shared` importers keep working.
export { amtpAttachmentRefSchema, amtpEnvelopeSchema } from 'amtp-protocol/envelope'

// The agent card schemas live in amtp-protocol (browser-safe: zod + ./jcs only); re-exported
// here so existing `@ficus/shared` importers keep working. Import from the `/card` submodule, NOT
// the barrel `amtp-protocol`, so the browser bundle never pulls in ./crypto (node:crypto).
export { amtpAgentCardSchema, amtpSignedAgentCardSchema } from 'amtp-protocol/card'

// Inbox message schemas
export const inboxMessageSenderTypeSchema = z.enum(['system', 'agent', 'user', 'voice_assistant', 'remote'])
export const inboxRecipientTypeSchema = z.enum(['agent', 'user', 'voice_assistant', 'system'])

export const sendInboxMessageSchema = z.object({
  recipientType: inboxRecipientTypeSchema.optional().default('agent'),
  recipientId: z.string().min(1),
  // The sender is derived server-side from the authenticated identity; callers cannot author as
  // anyone else. A user may set this to send as their own voice assistant instead of themselves.
  asVoiceAssistant: z.boolean().optional(),
  // Author as "system" (automation, e.g. webhooks). Requires the inbox:system permission.
  asSystem: z.boolean().optional(),
  subject: z.string().optional(),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  deliveryMode: z.enum(['steer', 'follow-up']).optional().default('steer'),
  // Federation: id of a local inbox message being replied to. When it is a remote-origin row
  // (metadata.remote present), the outbound send defaults its destination to that row's
  // fromAddress and threads the original envelope id.
  inReplyTo: z.string().optional(),
  // Structured lifecycle report for a reply to a saved Assistant mailbox (`assistant:<uuid>`).
  // Only the agent that received the request may report, and only on local sends.
  assistantTaskStatus: reportableAssistantTaskStatusSchema.optional(),
  attachmentIds: z.array(z.string().min(1)).optional(),
  // Federation signed-send (Slice 5). agentKey/agentSig authorize authorship; the client
  // envelope id becomes the idempotency/dedup key; inReplyToEnvelopeId is the WIRE reply
  // target (distinct from inReplyTo, which is a LOCAL inbox-message id).
  agentKey: z.string().min(1).optional(),
  agentSig: z.string().min(1).optional(),
  id: z.string().uuid().optional(),
  inReplyToEnvelopeId: z.string().min(1).optional(),
})
