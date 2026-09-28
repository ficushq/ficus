import { requireAssistantConversation } from '../assistant-task-requests'
import { z } from 'zod'
import { or, and, eq, isNull, inArray } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import { HTTPException } from 'hono/http-exception'
import {
  isWorkerAgentType,
  applyWorkflowCustomizations,
  applyThemeOperations,
  themeAssistantContract,
  validateThemePresetDocument,
  type WorkflowDefinition,
  type CustomThemeDocument,
  type AssistantEditorPreset,
  assistantEditorProposalSchema,
  assistantEditorSyncSchema,
  workflowDefinitionSchema,
  type AssistantEditorState,
  type AssistantEditorSync,
} from '@ficus/shared'
import {
  assistantConversations,
  assistantConversationAgents,
  assistantEntries,
  assistantTasks,
  agentTypes,
  db,
} from '../../db'
import { canAccessWorkflow, authorizeWorkflow } from '../workflows/access'
import { hasPermission, type Identity } from '../rbac'

/** Reads the workflow-only preset field without narrowing `AssistantEditorSync`
 * at every call site; other kinds have no preset concept (their name lives in
 * the document, e.g. a theme's `document.name`). */
function presetOf(state: AssistantEditorSync | AssistantEditorState): AssistantEditorPreset | undefined {
  return state.kind === 'workflow' ? state.preset : undefined
}

/** Each page kind supplies its own authorization, validation, model-facing
 * contract, and how it turns a proposal's `operations` into a candidate
 * document (before that candidate is run through `validate`). */
const adapters = {
  workflow: {
    async authorize(identity: Identity, target: AssistantEditorSync['target']) {
      if (target.presetId) {
        try {
          await authorizeWorkflow(identity, 'workflows:update', target.presetId)
        } catch {
          throw new HTTPException(404, { message: 'Workflow not found or not accessible' })
        }
      } else if (!(await canAccessWorkflow(identity, 'workflows:create')))
        throw new HTTPException(403, { message: 'Workflow editing is not allowed' })
    },
    async validate(document: unknown) {
      const { integrationOutputRegistry } = await import('../integrations/outputs/registry')
      const result = workflowDefinitionSchema.parse(document)
      for (const subscription of result.subscriptions ?? []) integrationOutputRegistry.validate(subscription)
      const ids = new Set(Object.values(result.participants).map((participant) => participant.agentTypeId))
      const types = await db.select({ id: agentTypes.id, systemOnly: agentTypes.systemOnly }).from(agentTypes)
      if (types.some((type) => ids.has(type.id) && type.systemOnly))
        throw new Error('Choose a worker agent type; system-only types cannot participate in flows.')
      return result
    },
    contract: `WorkflowDefinition: schemaVersion:1, name, participants:{id:{agentTypeId,model?,session:'reuse-within-stream'|'fresh-per-attempt'}}, entry:stepId, steps:[{id,name?,kind:'agent',participant,instructions,output,outcomes:{outcomeId:transition}} or {id,name?,kind:'human-approval',approver?:'reviewers'|'assigned-reviewers',instructions,output,outcomes}]. Human approvals default to assigned-reviewers, restricting decisions to users assigned to the work stream; any one assigned reviewer with review permission can decide. With no assigned reviewers, any human with review permission can decide. Use reviewers (Any reviewer) to allow anyone with workstreams:review permission in the squad regardless of assignment. Transitions: {next:stepId|'finish'}, {parallel:[stepIds],join?:stepId|'finish'}, or {returnTo:stepId,afterRework?:'follow-graph'|'return-to-requester'}. The canvas Start endpoint (selection $start) maps to entry; change entry to reconnect it. Start and Finish are visual endpoints, not entries in steps. All forward paths must reach finish; the first shared forward destination is inferred as the synchronization point and runs once after active branches arrive. Omit join; it is derived from connections. Separate tracks can finish independently and Finish waits for all work. Do not create join-only steps. To keep execution separate, use separate step IDs even when the instructions and agent type are identical. Use returnTo for revision loops, not forward cycles. The connections define mandatory work; there is no required flag or independentFrom metadata. Route every successful path through a mandatory check. returnTo is the correction step. afterRework defaults to follow-graph: run the correction then its ordinary arrows, including intermediate steps and parallel branches. return-to-requester instead brings the corrected result directly back to the step whose outcome requested changes, skipping the correction step's normal forward arrows. Use this only when the user wants targeted rework. There is no configurable resumeAt destination. routing:{mode:'guided'|'flexible'|'adaptive',returnTo:'declared-only'|'earlier-steps',delegation:'disabled'|'allowed'}. Guided requires declared-only and disabled. limits:{maxStepAttempts?:1..100,maxDelegations:0..100,maxParallelAttempts?:1..32,onLimit:'request-owner-input'}. completion:{mode:'deliverable'|'review-approval'|'pr-merge'|'pr-auto-merge'|'direct-merge',followChanges?:boolean,changeEventsTo?:'delivery-owner'|{step:agentStepId}}. Subscriptions: [{id,source:{integration,output,version,connectionId?},match:{outputField:{streamMetadata:'path'} or {value:string|number|boolean}},deliver:{to:{participant:id}|{step:id}|'active'|'delivery-owner',whenInactive:'retain'|'manager'}}]. Use only output names, versions, fields, and field types from integrationOutputs. Match external events to work-stream metadata or literal values. Inactive delivery retains events for later or routes them to the manager. The Code hosting canvas source has one output handle for its entire event bundle. Set completion.changeEventsTo:{step:agentStepId} to target an engineer, reviewer, or other agent step; omitted or delivery-owner uses the automatic finishing owner. Never configure individual GitHub events just to target a step. Preserve custom events such as Linear assignments. For code-host changes use completion.followChanges:true with metadata.codeHost (integration, repository, changeRequest:{number,url?}, connectionId?); this resolves the code-host adapter instead of hard-coding GitHub subscriptions. Preserve subscriptions when present. Each participant owns its agentTypeId, optional model override, and session policy; there is no separate profile entity. Choose only the provided worker types, never system-only roles. Participant agents start lazily. Use the same participant across steps for session reuse; distinct participants for independent reviews. Use short human-readable step names (name, up to 200 characters), such as Audience research. Keep stable step IDs for connections; changing a display name must not rewrite IDs. IDs are lowercase letters/digits/hyphens, start with a letter; finish is reserved. Guided follows declared outcomes only. Flexible permits configured earlier-step returns and ad hoc delegation; adaptive also allows bounded live flow revision. Omit maxStepAttempts by default for unlimited attempts; an explicit cap counts the first attempt plus rework; maxDelegations bounds added helpers (positive when delegation is allowed); omit maxParallelAttempts by default for no workflow concurrency limit (global agent capacity still applies); set it only when a workflow-specific cap is wanted, queuing extra starts. Exhausting attempt or delegation budgets asks the owner. deliverable finishes on the expected result; review-approval requires review; pr-merge waits for merge; pr-auto-merge enables auto-merge after checks; direct-merge merges directly when permitted. Use provider-neutral code-host completion with the stream's codeHost metadata. Never insert credentials into a flow. Preserve settings not requested to change.`,
    applyOperations: (document: unknown, operations: unknown) =>
      applyWorkflowCustomizations(document as WorkflowDefinition, operations),
  },
  theme: {
    // Themes are personal (owner-scoped, self-service, not RBAC-gated — see
    // apps/core/src/routes/theme-presets.ts): the outer chat:send check in
    // lockedEditor is the whole gate. A draft's target.presetId (once saved)
    // is not itself a grant; Save still goes through the normal
    // revision-checked, owner-scoped theme-presets routes.
    async authorize() {},
    async validate(document: unknown): Promise<CustomThemeDocument> {
      const result = validateThemePresetDocument(document)
      if (!result.ok) throw new Error(result.error)
      return result.document
    },
    contract: themeAssistantContract,
    applyOperations: (document: unknown, operations: unknown) =>
      applyThemeOperations(document as CustomThemeDocument, operations),
  },
}

type Actor = { userId: string; identity: Identity } | { agentId: string }
async function lockedEditor(
  id: string,
  actor: Actor,
  action: (state: AssistantEditorState | null, owner: string) => Promise<AssistantEditorState | null>
) {
  if (!z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: 'Editor not found' })
  if ('agentId' in actor)
    await requireAssistantConversation({ type: 'agent', agentId: actor.agentId, squadId: null }, id)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, id),
          'agentId' in actor
            ? or(
                eq(assistantConversations.agentId, actor.agentId),
                inArray(
                  assistantConversations.id,
                  tx
                    .select({ id: assistantConversationAgents.conversationId })
                    .from(assistantConversationAgents)
                    .where(
                      and(
                        eq(assistantConversationAgents.agentId, actor.agentId),
                        isNull(assistantConversationAgents.squadId)
                      )
                    )
                )
              )
            : eq(assistantConversations.ownerUserId, actor.userId)
        )
      )
      .for('update')
    if (!row) throw new HTTPException(404, { message: 'Editor not found' })
    if (row.kind !== 'page-editor') throw new HTTPException(409, { message: 'This conversation is not a page editor' })
    if ('agentId' in actor && row.editor?.expiresAt && Date.parse(row.editor.expiresAt) <= Date.now())
      throw new HTTPException(409, { message: 'The page editor is offline. Ask the user to reopen it.' })
    const identity: Identity = 'agentId' in actor ? { type: 'user', userId: row.ownerUserId } : actor.identity
    if (!(await hasPermission(identity, 'chat:send')))
      throw new HTTPException(403, { message: 'Assistant access is not allowed' })
    if (row.editor) await adapters[row.editor.kind].authorize(identity, row.editor.target)
    const next = await action(row.editor, row.ownerUserId)
    if (!isDeepStrictEqual(row.editor, next))
      await tx.update(assistantConversations).set({ editor: next }).where(eq(assistantConversations.id, id))
    return next
  })
}
export async function syncAssistantEditor(id: string, actor: Extract<Actor, { userId: string }>, value: unknown) {
  const { acknowledgedProposalId, ...input } = assistantEditorSyncSchema.parse(value)
  await adapters[input.kind].authorize(actor.identity, input.target)
  return lockedEditor(id, actor, async (current) => {
    if (current?.closed) throw new HTTPException(409, { message: 'This editor is closed' })
    if (current && (!isDeepStrictEqual(input.target, current.target) || input.kind !== current.kind))
      throw new HTTPException(409, { message: 'Editor target cannot change' })
    if (
      current &&
      (input.revision < current.revision ||
        (input.revision === current.revision &&
          (!isDeepStrictEqual(input.document, current.document) ||
            !isDeepStrictEqual(presetOf(input), presetOf(current)))))
    )
      throw new HTTPException(409, { message: 'Draft revision conflicts; reopen the editor' })
    return {
      ...input,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      ...(current?.proposal &&
      current.proposal.id !== acknowledgedProposalId &&
      input.revision <= current.proposal.baseRevision
        ? { proposal: current.proposal }
        : {}),
    }
  })
}
export async function readAssistantEditor(id: string, actor: Actor) {
  let canReadAgentTypes = false
  const state = await lockedEditor(id, actor, async (state, owner) => {
    canReadAgentTypes = await hasPermission(
      'identity' in actor ? actor.identity : { type: 'user', userId: owner },
      'agent-types:read'
    )
    if (!state || state.closed) throw new HTTPException(404, { message: 'This page editor is no longer open' })
    return 'userId' in actor && (!state.expiresAt || Date.parse(state.expiresAt) < Date.now() + 240_000)
      ? { ...state, expiresAt: new Date(Date.now() + 300_000).toISOString() }
      : state
  })
  const availableAgentTypes = canReadAgentTypes
    ? await db
        .select({
          id: agentTypes.id,
          name: agentTypes.name,
          description: agentTypes.description,
          systemOnly: agentTypes.systemOnly,
          disabled: agentTypes.disabled,
        })
        .from(agentTypes)
    : []
  const { integrationOutputRegistry } = await import('../integrations/outputs/registry')
  return {
    ...state!,
    agentTypes: availableAgentTypes.filter(isWorkerAgentType),
    integrationOutputs: integrationOutputRegistry.catalog(),
    contract: adapters[state!.kind].contract,
  }
}
export async function proposeAssistantEditor(id: string, actor: Actor, value: unknown) {
  const input = assistantEditorProposalSchema.parse(value)
  return lockedEditor(id, actor, async (state) => {
    if (!state || state.closed) throw new HTTPException(404, { message: 'This page editor is no longer open' })
    if (input.baseRevision !== state.revision)
      throw new HTTPException(409, {
        message: `Draft revision mismatch: received ${input.baseRevision}, current revision is ${state.revision}. Use the latest applied edit revision; read again if the draft changed elsewhere.`,
      })
    if (state.proposal?.baseRevision === state.revision)
      throw new HTTPException(409, {
        message: 'The previous edit is still being applied by the page. Read again before editing.',
      })
    if (input.historyAction) {
      const available = input.historyAction === 'undo' ? state.history?.canUndo : state.history?.canRedo
      if (!available)
        throw new HTTPException(409, { message: `Nothing to ${input.historyAction}. Read the current draft again.` })
      return {
        ...state,
        proposal: {
          id: crypto.randomUUID(),
          baseRevision: input.baseRevision,
          summary: input.summary,
          document: state.document,
          historyAction: input.historyAction,
        },
      }
    }
    const statePreset = presetOf(state)
    if (input.preset && !statePreset)
      throw new HTTPException(400, { message: 'Preset details are not editable on this page.' })
    if (input.preset?.id && state.target.presetId && input.preset.id !== state.target.presetId)
      throw new HTTPException(400, { message: 'A saved preset ID cannot change.' })
    const preset = input.preset ? { ...statePreset!, ...input.preset } : statePreset
    let document: unknown
    try {
      const adapter = adapters[state.kind]
      document = await adapter.validate(
        input.operations
          ? adapter.applyOperations(state.document, input.operations)
          : input.documentJson
            ? JSON.parse(input.documentJson)
            : state.document
      )
    } catch (error) {
      throw new HTTPException(400, {
        message: `Edit rejected; no changes applied. Draft remains at revision ${state.revision}. Correct and resubmit the complete edit batch. ${error instanceof Error ? error.message : 'Invalid proposal'}`,
      })
    }
    return {
      ...state,
      proposal: {
        id: crypto.randomUUID(),
        baseRevision: input.baseRevision,
        summary: input.summary,
        document,
        ...(preset ? { preset } : {}),
      },
    }
  })
}
/**
 * Close the page editor capability. A conversation that only ever carried the draft, with no saved
 * turns and no delegated tasks, is deleted outright so opening a builder does not leave a "Design a
 * workflow" row behind in the saved conversation list.
 */
export async function closeAssistantEditor(id: string, actor: Extract<Actor, { userId: string }>) {
  const state = await lockedEditor(id, actor, async (state) => (state ? { ...state, closed: true } : null))
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: assistantConversations.id, agentId: assistantConversations.agentId })
      .from(assistantConversations)
      .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerUserId, actor.userId)))
      .for('update')
    if (!row) return
    const [entry] = await tx
      .select({ id: assistantEntries.id })
      .from(assistantEntries)
      .where(eq(assistantEntries.conversationId, id))
      .limit(1)
    const [task] = await tx
      .select({ id: assistantTasks.id })
      .from(assistantTasks)
      .where(eq(assistantTasks.conversationId, id))
      .limit(1)
    if (!entry && !task && !row.agentId)
      await tx.delete(assistantConversations).where(eq(assistantConversations.id, id))
  })
  return state
}
