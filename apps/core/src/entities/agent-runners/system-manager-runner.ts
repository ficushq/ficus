import { db, messages } from '../../db'
import { eq } from 'drizzle-orm'
import { createAssistantTools } from '../../tools/assistant'
import { linkAssistantSummaries } from '../../services/assistant-conversation-updates'
import { assistantEditorInstructionsByKind } from '@ficus/shared'
import { createPageEditorTools } from '../../tools/page-editor'
import { getAccessibleSquadIds, hasPermission, type Identity } from '../../services/rbac/permissions'
import { findOwningConversation, isAssistantDelegate } from '../../services/assistant-agents'
import type { SessionUsage, MessageMetadata } from '@ficus/shared'
import { AgentRunner } from './base'
import type { AdmissionScope } from '../../services/maintenance/admission-reservation'

import { AgentType } from '../AgentType'
import { resolveAgentTypeChain } from '../../services/model-selection/model-tier-resolution'
import { getSystemManagerCliHelp } from '../../lib/utils/cli-help'
import { Squad } from '../Squad'

import { createNavigateTool } from '../../tools/navigate'
import { createAsyncAskHumanTool } from '../../tools/ask-human-async'
import { createDispatchTool } from '../../tools/dispatch'
import { filterToolsByPolicy } from '../../lib/tools'
import { createSubagentLifecycleTools } from '../../tools/subagents'
import { createWebTools } from '../../tools/web-search'
import { ensureWorkspaceSandbox } from '../../services/sandbox/ensure'
import { AgentSession } from '../AgentSession'
import { createSetAgentPurposeTool } from '../../tools'
import { prompt, interpolateTemplate, buildPlatformUrlsPrompt } from '../../lib/prompts'
import { composeAgentTypePrompt } from '../../services/agent-types/compose-prompt'
import { buildWorkspacePrompt, workspaceToolNamesForPolicy } from '../../lib/prompts/workspace-prompt'
import { buildModelOverridePrompt } from '../../lib/prompts/model-overrides-prompt'
import {
  AGENT_PURPOSE_DISPLAY_SECTION_TITLE,
  SET_AGENT_PURPOSE_INSTRUCTIONS,
} from '../../lib/prompts/agent-purpose-prompt'

export class SystemManagerRunner extends AgentRunner {
  protected async isAssistantDelegate(): Promise<boolean> {
    return isAssistantDelegate(this.agent.id)
  }

  protected async getPageEditorConversation(): Promise<
    | {
        id: string
        kind: import('@ficus/shared').AssistantConversationKind
        editor: import('@ficus/shared').AssistantEditorState | null
      }
    | undefined
  > {
    return findOwningConversation(this.agent.id)
  }

  protected ensureWorkspaceSandbox(args: Parameters<typeof ensureWorkspaceSandbox>[0]): Promise<string> {
    return ensureWorkspaceSandbox(args)
  }

  // ---------------------------------------------------------------------------
  // Prompt builders (static — also used by ai-extract route)
  // ---------------------------------------------------------------------------

  private static async buildSquadsContext(identity?: Identity): Promise<string> {
    if (!identity) return 'Use authenticated CLI requests to discover available squads.'
    const accessible = await getAccessibleSquadIds(identity)
    // List active, non-anonymous squads
    const candidates = await Squad.list({ status: 'active', includeAnonymous: false })
    const visible = candidates.filter((squad) => accessible === 'all' || accessible.includes(squad.id))
    const allowed = await Promise.all(visible.map((squad) => hasPermission(identity, 'squads:read', squad.id)))
    const squads = visible.filter((_, index) => allowed[index])

    if (squads.length === 0) {
      return 'No squads are visible with your current access.'
    }

    const squadLines = await Promise.all(
      squads.map(async (squad) => {
        const agents = await squad.getActiveAgents()
        const agentCount = agents.length
        const managerId = squad.managerAgentId ? squad.managerAgentId.slice(0, 8) : 'none'
        return `- **${squad.name}** (squad: ${squad.id.slice(0, 8)}, manager: ${managerId}) — ${squad.purpose}\n  Status: ${squad.status}, Agents: ${agentCount}`
      })
    )

    return squadLines.join('\n')
  }

  static async buildManagerPrompt(
    identity?: Identity,
    agentTypeId = 'system-manager'
  ): Promise<{ systemPrompt: string; model: string }> {
    const agentType = await AgentType.find(agentTypeId)
    if (!agentType) {
      throw new Error('Manager agent type not found')
    }

    const [cliHelp, squadsContext] =
      agentTypeId === 'assistant'
        ? ['', 'Use list_squads to discover visible squads.']
        : await Promise.all([getSystemManagerCliHelp(), SystemManagerRunner.buildSquadsContext(identity)])

    const typePrompt = await composeAgentTypePrompt(agentType)
    const systemPrompt = interpolateTemplate(
      prompt()
        .text(typePrompt)
        .section('Model Overrides for Spawned Agents', buildModelOverridePrompt())
        .text(buildPlatformUrlsPrompt())
        .build(),
      {
        CLI_HELP: cliHelp,
        SQUADS_CONTEXT: squadsContext,
      }
    )

    return { systemPrompt, model: await resolveAgentTypeChain(agentType) }
  }

  // ---------------------------------------------------------------------------
  // Session setup
  // ---------------------------------------------------------------------------

  protected async createSession(scope: AdmissionScope | null = null): Promise<AgentSession> {
    if (this.agent.agentTypeId === 'assistant') return this.createConversationSession(scope)
    const { sandboxId, skillPaths, extensionPaths } = await this.resolveSessionPaths()
    const workspacePath = await this.withSandboxSetupBatch(() =>
      this.ensureWorkspaceSandbox({
        sandboxId,
        workspaceId: sandboxId,
        admissionScope: scope,
        setupProgress: this.sandboxSetupProgress,
      })
    )

    const editorConversation = await this.getPageEditorConversation()
    // The conversation's kind decides the tool set, not whether a draft has synced yet: a page
    // editor gets only its two editor tools from the first turn, and an app-wide conversation never
    // gains them.
    const pageEditor = editorConversation?.kind === 'page-editor' ? editorConversation : undefined
    // A brand-new page editor's draft may not have synced yet when the agent session is created
    // (the web page syncs eagerly on mount, but nothing guarantees ordering); default to the
    // original page kind rather than fail closed.
    const pageEditorKind = pageEditor?.editor?.kind ?? 'workflow'
    const managerPromptResult = await SystemManagerRunner.buildManagerPrompt(
      {
        type: 'agent',
        agentId: this.agent.id,
        squadId: this.agent.squadId ?? null,
      },
      this.agent.agentTypeId
    )
    const managerModel = await this.agent.getEffectiveModelSpec(managerPromptResult.model)

    const systemPrompt = prompt()
      .text(managerPromptResult.systemPrompt)
      // Solo agent: one private box (its resolved private dir), no shared workspace, no squad_bash.
      .text(
        buildWorkspacePrompt({
          sandboxId,
          toolNames: workspaceToolNamesForPolicy(this.agentType.toolsAllow, this.agentType.toolsDeny),
          mayShareWithSubagents: true,
        })
      )
      .section(AGENT_PURPOSE_DISPLAY_SECTION_TITLE, SET_AGENT_PURPOSE_INSTRUCTIONS)
      .build()

    const { baseTools, sandboxStatusTool, shortTermMemoryTools } = await this.buildSessionToolkit({
      workspacePath,
      sandboxId,
    })
    const navigateTool = createNavigateTool()
    const assistantDelegate = await this.isAssistantDelegate()
    const pageEditorTools = pageEditor ? createPageEditorTools(this.agent.id, pageEditor.id) : []
    const askHumanTool =
      assistantDelegate && this.agent.agentTypeId !== 'assistant-worker'
        ? null
        : createAsyncAskHumanTool(
            {
              agentId: this.agent.id,
              executionId: this.execution.id,
              flushPersistence: () => this.persistence.waitForAll(),
            },
            undefined,
            { allowBlocking: false }
          )
    const webTools = createWebTools()
    const environmentTools = [...baseTools, ...webTools]
    const setAgentPurposeTool = createSetAgentPurposeTool({ agentId: this.agent.id })
    const subagentLifecycleTools = createSubagentLifecycleTools({ agentId: this.agent.id })

    return this.createPiSession(scope, async () => {
      const sessionOptions = await this.buildBaseSessionOptions({
        systemPrompt: pageEditor ? assistantEditorInstructionsByKind[pageEditorKind] : systemPrompt,
        skillPaths: pageEditor ? [] : skillPaths,
        extensionPaths: pageEditor ? [] : extensionPaths,
        sandboxId,
        workspacePath,
        // The system manager resolves its model spec independently of the
        // agent's own effective spec.
        model: managerModel,
        tools: {
          core: pageEditor
            ? pageEditorTools
            : [
                navigateTool,
                ...pageEditorTools,
                ...(askHumanTool ? [askHumanTool] : []),
                ...subagentLifecycleTools,
                ...(sandboxStatusTool ? [sandboxStatusTool] : []),
                setAgentPurposeTool,
                ...shortTermMemoryTools,
              ],
          available: pageEditor ? [] : environmentTools,
        },
      })
      const effectiveEnvironmentTools = filterToolsByPolicy(
        sessionOptions.tools?.available ?? [],
        sessionOptions.tools?.allow,
        sessionOptions.tools?.deny
      )
      if (!pageEditor)
        sessionOptions.tools!.core = [
          ...(sessionOptions.tools?.core ?? []),
          createDispatchTool({
            agentId: this.agent.id,
            parentExecutionContext: {
              version: 1,
              squadId: null,
              environmentToolNames: effectiveEnvironmentTools.map((tool) => tool.name),
            },
          }),
        ]
      return AgentSession.create(sessionOptions)
    })
  }

  /** Conversational inference and tools run in Core; only delegates allocate a sandbox. */
  protected async createConversationSession(scope: AdmissionScope | null): Promise<AgentSession> {
    const conversation = await this.getPageEditorConversation()
    if (!conversation) throw new Error('Assistant conversation binding is missing')
    const identity = { type: 'agent' as const, agentId: this.agent.id, squadId: null }
    const { requireAssistantConversation } = await import('../../services/assistant-task-requests')
    await requireAssistantConversation(identity, conversation.id)
    const configured = await SystemManagerRunner.buildManagerPrompt(identity, 'assistant')
    const pageEditor = conversation.kind === 'page-editor'
    const pageEditorKind = conversation.editor?.kind ?? 'workflow'
    const core = pageEditor
      ? createPageEditorTools(this.agent.id, conversation.id)
      : [
          createNavigateTool(),
          createSetAgentPurposeTool({ agentId: this.agent.id }),
          createAsyncAskHumanTool(
            {
              agentId: this.agent.id,
              executionId: this.execution.id,
              flushPersistence: () => this.persistence.waitForAll(),
            },
            undefined,
            { allowBlocking: false }
          ),
          ...createAssistantTools(this.agent.id, this.execution.id, conversation.id),
        ]
    return this.createPiSession(scope, async () =>
      AgentSession.create(
        await this.buildBaseSessionOptions({
          systemPrompt: pageEditor ? assistantEditorInstructionsByKind[pageEditorKind] : configured.systemPrompt,
          model: await this.agent.getEffectiveModelSpec(configured.model),
          skillPaths: [],
          extensionPaths: [],
          tools: { core, available: [] },
        })
      )
    )
  }

  protected override pushAgentEvent(): void {
    this.buffer.push({
      type: 'agent',
      agentId: this.agent.id,
      scope: { type: 'system-manager' },
      executionId: this.execution.id,
    })
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  protected async onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    if (this.agent.agentTypeId === 'assistant') {
      await this.persistence.waitForAll()
      await linkAssistantSummaries(this.agent.id, this.execution.id)
      const messageId = this.persistence.lastAssistant()?.messageId
      const [saved] = messageId
        ? await db.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, messageId))
        : []
      metadata = {
        ...metadata,
        ...(saved?.metadata as MessageMetadata | undefined),
        executionId: this.execution.id,
        streamGroupId: this.persistence.currentStreamGroupId,
      }
    }
    await this.completeNormally(response, metadata, sessionUsage)
  }

  // Uses base onError — marks failed + idle
}
