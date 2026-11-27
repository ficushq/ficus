import type { SessionUsage, MessageMetadata, Squad as SquadJson } from '@ficus/shared'
import { AgentRunner, type AutomaticBigbrainTools } from './base'
import type { AdmissionScope } from '../../services/maintenance/admission-reservation'
import { Squad } from '../Squad'
import { isAssistantDelegate } from '../../services/assistant-agents'
import { getCliCommandIndex } from '../../lib/utils/cli-help'
import {
  interpolateTemplate,
  buildActiveSchedulesPrompt,
  buildPlatformUrlsPrompt,
  buildSlotPoolsPrompt,
  buildPublicVoicePrompt,
  publicTextIncludeEnabled,
} from '../../lib/prompts'
import { composeAgentTypePrompt } from '../../services/agent-types/compose-prompt'
import { ensureSquadSandbox, ensureWorkspaceSandbox } from '../../services/sandbox/ensure'
import { createNotifyContactTool } from '../../tools/notify-contact'
import { createDispatchTool } from '../../tools/dispatch'
import { filterToolsByPolicy } from '../../lib/tools'
import { createSubagentLifecycleTools } from '../../tools/subagents'
import { createSquadTodoTools } from '../../tools/squad-todo'
import { AgentSession } from '../AgentSession'
import {
  createChannelRespondTool,
  createChannelSendTool,
  createChannelEditTool,
  createBrowserTools,
  createAsyncAskHumanTool,
  createWebTools,
  createMemoryTools,
  createMonitorTool,
  createSetAgentPurposeTool,
} from '../../tools'
import { createSquadBashTool, SQUAD_BASH_TOOL_KEY } from '../../tools/squad-bash'
import { assembleSquadManagerPrompt } from '../../lib/prompts/squad-agent-prompt'
import { buildWorkspacePrompt, workspaceToolNamesForPolicy } from '../../lib/prompts/workspace-prompt'
import { resolveWorkspaceLayout } from '../../services/sandbox/workspace-layout'
import { readSquadMemoryFile } from '../../services/memory/paths'
import { buildModelOverridePrompt } from '../../lib/prompts/model-overrides-prompt'

export class SquadManagerRunner extends AgentRunner {
  protected async isAssistantDelegate(): Promise<boolean> {
    return isAssistantDelegate(this.agent.id)
  }

  private squad!: Squad
  private workspacePath!: string

  protected ensureSquadSandbox(
    squad: Squad,
    scope: AdmissionScope | null = null,
    setupProgress?: NonNullable<Parameters<typeof ensureSquadSandbox>[1]>['setupProgress']
  ): Promise<string> {
    return ensureSquadSandbox(squad, { admissionScope: scope, setupProgress })
  }

  protected ensureLightSandbox(args: Parameters<typeof ensureWorkspaceSandbox>[0]): Promise<string> {
    return ensureWorkspaceSandbox(args)
  }

  protected createSquadBashTool(
    warmSandboxId: string,
    workspaceHostPath: string,
    squadId: string,
    ficusToken?: string
  ) {
    return createSquadBashTool(warmSandboxId, workspaceHostPath, squadId, ficusToken, this.agent.id, this.execution.id)
  }

  // ---------------------------------------------------------------------------
  // Squad context injection
  // ---------------------------------------------------------------------------

  /**
   * Replace squad placeholder tokens in a prompt string with actual squad values.
   * Supported placeholders: {{squad.id}}, {{squad.name}}, {{squad.purpose}},
   * {{squad.defaultAgents}}
   */
  static injectSquadContext(prompt: string, squad: SquadJson | Squad): string {
    return interpolateTemplate(prompt, {
      'squad.id': squad.id,
      'squad.name': squad.name,
      'squad.purpose': squad.purpose,
      'squad.defaultAgents': squad.defaultAgents.join(', ') || 'none',
      'squad.context': squad.context ?? '',
      // Pools and the public voice need a database read; this synchronous helper omits them.
      'squad.slotPools': '',
      'squad.publicVoice': '',
    })
  }

  // ---------------------------------------------------------------------------
  // Prompt builders
  // ---------------------------------------------------------------------------

  private async buildSquadContext(): Promise<string> {
    const [squadWithRels, schedulesPrompt] = await Promise.all([
      this.squad.withRelationships(),
      buildActiveSchedulesPrompt(this.squad.id, this.agent.id, 'manager'),
    ])

    // Build connected squads section
    const connectedSquads: string[] = []
    if (squadWithRels) {
      if (squadWithRels.relationships.reportsTo.length > 0) {
        connectedSquads.push('**Reports To:**')
        for (const s of squadWithRels.relationships.reportsTo) {
          connectedSquads.push(
            `- ${s.name} [${s.id.slice(0, 8)}] — Manager: ${s.managerAgentId?.slice(0, 8) || 'none'}`
          )
        }
      }
      if (squadWithRels.relationships.collaborates.length > 0) {
        connectedSquads.push('**Collaborates With:**')
        for (const s of squadWithRels.relationships.collaborates) {
          connectedSquads.push(
            `- ${s.name} [${s.id.slice(0, 8)}] — Manager: ${s.managerAgentId?.slice(0, 8) || 'none'}`
          )
        }
      }
      if (squadWithRels.relationships.dependsOn.length > 0) {
        connectedSquads.push('**Depends On:**')
        for (const s of squadWithRels.relationships.dependsOn) {
          connectedSquads.push(
            `- ${s.name} [${s.id.slice(0, 8)}] — Manager: ${s.managerAgentId?.slice(0, 8) || 'none'}`
          )
        }
      }
      if (squadWithRels.relationships.reportedBy.length > 0) {
        connectedSquads.push('**Reported By:**')
        for (const s of squadWithRels.relationships.reportedBy) {
          connectedSquads.push(
            `- ${s.name} [${s.id.slice(0, 8)}] — Manager: ${s.managerAgentId?.slice(0, 8) || 'none'}`
          )
        }
      }
      if (squadWithRels.relationships.dependedOnBy.length > 0) {
        connectedSquads.push('**Depended On By:**')
        for (const s of squadWithRels.relationships.dependedOnBy) {
          connectedSquads.push(
            `- ${s.name} [${s.id.slice(0, 8)}] — Manager: ${s.managerAgentId?.slice(0, 8) || 'none'}`
          )
        }
      }
    }

    const connectedSquadsSection =
      connectedSquads.length > 0 ? `## Connected Squads\n${connectedSquads.join('\n')}` : ''

    return [connectedSquadsSection, schedulesPrompt].filter(Boolean).join('\n\n')
  }

  private async buildSquadManagerPrompt(): Promise<string> {
    const sandboxId = await this.agent.getSandboxId()
    const [cliHelp, squadContext, slotPools, publicVoice, publicTextEnabled] = await Promise.all([
      getCliCommandIndex(undefined, { omitHostGroups: true }),
      this.buildSquadContext(),
      buildSlotPoolsPrompt(this.squad.id),
      buildPublicVoicePrompt(this.squad),
      publicTextIncludeEnabled(),
    ])

    const typePrompt = await composeAgentTypePrompt(this.agentType)
    const isConsultant = this.agent.agentTypeId === 'consultant'
    return assembleSquadManagerPrompt({
      agent: { id: this.agent.id, typeId: this.agent.agentTypeId, typeName: this.agentType.name },
      squad: {
        id: this.squad.id,
        name: this.squad.name,
        purpose: this.squad.purpose,
        defaultAgents: this.squad.defaultAgents,
        context: this.squad.context ?? null,
        // For the manager this is its own id; for a consultant (same runner) it's the manager to hand work off to.
        managerAgentId: this.squad.managerAgentId ?? null,
        workspaceRoot: resolveWorkspaceLayout({ squadId: this.squad.id }).workspaceMount,
      },
      typePrompt,
      slotPools,
      publicVoice: { section: publicVoice, publicTextEnabled },
      workspace: buildWorkspacePrompt({
        agentId: this.agent.id,
        squadId: this.squad.id,
        squadName: this.squad.name,
        sandboxId,
        hasSquadBash: true,
        toolNames: workspaceToolNamesForPolicy(this.agentType.toolsAllow, this.agentType.toolsDeny, true),
        mayShareWithSubagents: true,
      }),
      cliHelp,
      modelOverrides: buildModelOverridePrompt(),
      squadState: squadContext,
      workflow: this.squad.metadata?.workflow,
      workflowSetup: this.squad.metadata?.workflowSetup,
      typeContext: this.squad.getTypeContext('manager') ?? '',
      memory: this.squad.isMemoryEnabled ? { map: readSquadMemoryFile(this.squad.id, 'map.md') } : null,
      isConsultant,
      externalChannel: Boolean(
        this.agent.context && 'channelInstance' in this.agent.context && this.agent.context.channelInstance
      ),
      platformUrls: buildPlatformUrlsPrompt(),
    })
  }

  // ---------------------------------------------------------------------------
  // Session setup
  // ---------------------------------------------------------------------------

  protected async createSession(scope: AdmissionScope | null = null): Promise<AgentSession> {
    // Get squad from agent's squadId
    if (!this.agent.squadId) {
      throw new Error('Squad manager agent has no squadId')
    }

    const squad = await Squad.find(this.agent.squadId)
    if (!squad) {
      await this.handleMissingResource(`Squad ${this.agent.squadId}`)
      throw new Error(`Squad ${this.agent.squadId} not found`)
    }
    this.squad = squad

    const { sandboxId: lightId, skillPaths, extensionPaths } = await this.resolveSessionPaths()

    // Run squad-level provisioning concurrently with the agent's light container —
    // distinct sandbox ids; the light box self-provisions its own dirs; env/files
    // are read at command-exec time after both ensures resolve.
    const workspacePath = await this.withSandboxSetupBatch(async () => {
      await this.ensureSquadSandbox(squad, scope, this.sandboxSetupProgress)
      return this.ensureLightSandbox({
        sandboxId: lightId,
        workspaceId: lightId,
        squadId: squad.id,
        admissionScope: scope,
        setupProgress: this.sandboxSetupProgress,
      })
    })
    this.workspacePath = workspacePath

    const systemPrompt = await this.buildSquadManagerPrompt()

    const { ficusToken, baseTools, sandboxStatusTool, shortTermMemoryTools } = await this.buildSessionToolkit({
      workspacePath: this.workspacePath,
      sandboxId: lightId,
      squadId: this.squad.id,
    })
    const squadBashTool = this.createSquadBashTool(this.squad.sandboxId, this.workspacePath, this.squad.id, ficusToken)
    const webTools = createWebTools()
    const browserTools = createBrowserTools(this.agent.id, lightId)
    const environmentTools = [...baseTools, squadBashTool, ...webTools, ...browserTools]
    // Managers (and consultants) never block on a human answer: they keep coordinating and act
    // on the answer when it arrives. Only work-stream agents open question waits.
    const isChannelConversation = !!(
      this.agent.context &&
      'channelInstance' in this.agent.context &&
      this.agent.context.channelInstance
    )
    const askHumanTool =
      isChannelConversation || (await this.isAssistantDelegate())
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
    const notifyContactTool = createNotifyContactTool({ agentId: this.agent.id })
    const subagentLifecycleTools = createSubagentLifecycleTools({ agentId: this.agent.id })
    const todoTools = createSquadTodoTools(this.squad.id, this.agent.id)
    // The consultant's prompt (consultant.yaml) already tells it to set a purpose, but the
    // tool was never provided — wire it up here. Consultants only; the manager has no purpose.
    const isConsultant = this.agent.agentTypeId === 'consultant'
    const setAgentPurposeTool = isConsultant ? createSetAgentPurposeTool({ agentId: this.agent.id }) : null

    // Only provide memory tools if squad has memory enabled
    const memoryTools = this.squad.isMemoryEnabled ? createMemoryTools(this.squad.id) : []

    return this.createPiSession(scope, async () => {
      const sessionOptions = await this.buildBaseSessionOptions({
        systemPrompt,
        skillPaths,
        extensionPaths,
        sandboxId: lightId,
        workspacePath: this.workspacePath,
        squadId: this.squad.id,
        tools: {
          core: [
            ...(askHumanTool ? [askHumanTool] : []),
            ...(isChannelConversation
              ? [createChannelRespondTool(), createChannelSendTool(this.agent.id), createChannelEditTool(this.agent.id)]
              : []),

            ...(setAgentPurposeTool ? [setAgentPurposeTool] : []),
            notifyContactTool,
            ...subagentLifecycleTools,
            ...(sandboxStatusTool ? [sandboxStatusTool] : []),
            ...todoTools,
            ...shortTermMemoryTools,
            ...memoryTools,
          ],
          available: environmentTools,
        },
      })
      const effectiveEnvironmentTools = filterToolsByPolicy(
        sessionOptions.tools?.available ?? [],
        sessionOptions.tools?.allow,
        sessionOptions.tools?.deny
      )
      sessionOptions.tools!.core = [
        ...(sessionOptions.tools?.core ?? []),
        createMonitorTool({
          agentId: this.agent.id,
          sandboxId: lightId,
          workspacePath: this.workspacePath,
          squadSandboxId: effectiveEnvironmentTools.some((tool) => tool.name === SQUAD_BASH_TOOL_KEY)
            ? this.squad.sandboxId
            : undefined,
        }),
        createDispatchTool({
          agentId: this.agent.id,
          parentExecutionContext: {
            version: 1,
            squadId: this.squad.id,
            environmentToolNames: effectiveEnvironmentTools.map((tool) => tool.name),
            ...(this.agentType.toolSearch ? { toolSearch: this.agentType.toolSearch } : {}),
            executionId: this.execution.id,
          },
        }),
      ]
      return AgentSession.create(sessionOptions)
    })
  }

  /** Managers and consultants automatically get the BigBrain read tools and the local connector's `bigbrain_drop`. */
  protected override automaticBigbrainTools(): AutomaticBigbrainTools {
    return 'read_and_drop'
  }

  protected override pushAgentEvent(): void {
    this.buffer.push({
      type: 'agent',
      agentId: this.agent.id,
      scope: { type: 'system-manager', id: this.squad?.id },
      executionId: this.execution.id,
    })
  }

  // ---------------------------------------------------------------------------
  // Prompt building
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  protected async onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    await this.completeNormally(response, metadata, sessionUsage)
  }
}
