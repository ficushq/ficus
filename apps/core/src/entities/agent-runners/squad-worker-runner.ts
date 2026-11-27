import type { SessionUsage, MessageMetadata } from '@ficus/shared'
import { AgentRunner, type AutomaticBigbrainTools } from './base'
import type { AdmissionScope } from '../../services/maintenance/admission-reservation'
import { getCliCommandIndex } from '../../lib/utils/cli-help'
import { resolvePermissions } from '../../services/rbac'
import {
  buildActiveSchedulesPrompt,
  buildSlotPoolsPrompt,
  buildPublicVoicePrompt,
  publicTextIncludeEnabled,
} from '../../lib/prompts'
import { assembleSquadWorkerPrompt } from '../../lib/prompts/squad-agent-prompt'
import { composeAgentTypePrompt } from '../../services/agent-types/compose-prompt'
import { readSquadMemoryFile } from '../../services/memory/paths'
import { createWebTools } from '../../tools/web-search'
import { createBrowserTools } from '../../tools/browser'
import { createSquadTodoTools } from '../../tools/squad-todo'
import { createNotifyContactTool } from '../../tools/notify-contact'
import { createDispatchTool } from '../../tools/dispatch'
import { filterToolsByPolicy } from '../../lib/tools'
import { createSubagentLifecycleTools } from '../../tools/subagents'
import { buildWorkspacePrompt, workspaceToolNamesForPolicy } from '../../lib/prompts/workspace-prompt'
import { resolveWorkspaceLayout } from '../../services/sandbox/workspace-layout'
import { Squad } from '../Squad'
import { ensureSquadSandbox, ensureWorkspaceSandbox } from '../../services/sandbox/ensure'
import { AgentSession } from '../AgentSession'
import { createAsyncAskHumanTool, createMemoryTools, createSetAgentPurposeTool, createMonitorTool } from '../../tools'
import { createSquadBashTool, SQUAD_BASH_TOOL_KEY } from '../../tools/squad-bash'

/**
 * Runner for squad worker agents - agents that belong to a squad but are not the squad manager.
 * These agents work in the shared squad workspace and have squad context.
 */
export class SquadWorkerRunner extends AgentRunner {
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
  // Prompt builders
  // ---------------------------------------------------------------------------

  /**
   * The CLI index without groups and commands this agent's resolved permissions
   * cannot use (for example `workstream create`), so workers route that work to
   * the manager instead of discovering the 403. Falls back to the full index
   * when permissions cannot be resolved; the server enforces every call anyway.
   */
  private async buildWorkerCliHelp(): Promise<string> {
    let permissions: string[] = []
    try {
      permissions = await resolvePermissions(
        { type: 'agent', agentId: this.agent.id, squadId: this.squad.id },
        this.squad.id
      )
    } catch {
      // Fall through to the unfiltered index.
    }
    const options = { omitHostGroups: true }
    return permissions.length > 0 ? getCliCommandIndex(permissions, options) : getCliCommandIndex(undefined, options)
  }

  private async buildSquadWorkerPrompt(): Promise<string> {
    const { flowWorkerContext } = await import('../../services/workflows/execution')
    const flow = await flowWorkerContext(this.agent.id)
    // Keep only the manager in the squad roster. Other worker status changes are
    // volatile and workers receive shared-work-stream collaborators via inbox.
    const manager = (await this.squad.getActiveAgents()).find((a) => a.id === this.squad.managerAgentId)
    const managerSection = manager
      ? `## Squad Manager Agent\n- ${(manager.metadata as any)?.name || manager.agentTypeId} (${manager.agentTypeId}) [${manager.id.slice(0, 8)}] — Manager`
      : ''

    const sandboxId = await this.agent.getSandboxId()
    const [cliHelp, activeSchedules, slotPools, publicVoice, publicTextEnabled] = await Promise.all([
      this.buildWorkerCliHelp(),
      buildActiveSchedulesPrompt(this.squad.id, this.agent.id, 'worker'),
      buildSlotPoolsPrompt(this.squad.id),
      buildPublicVoicePrompt(this.squad),
      publicTextIncludeEnabled(),
    ])

    const typePrompt = await composeAgentTypePrompt(this.agentType)
    return assembleSquadWorkerPrompt({
      agent: { id: this.agent.id, typeId: this.agent.agentTypeId, typeName: this.agentType.name },
      squad: {
        id: this.squad.id,
        name: this.squad.name,
        purpose: this.squad.purpose,
        defaultAgents: this.squad.defaultAgents,
        context: this.squad.context ?? null,
        managerAgentId: this.squad.managerAgentId ?? null,
        // Namespaced shared-workspace root (/workspace/<squadId>) for {{workspaceRoot}}
        // placeholders in agent-type / squad-owned context.
        workspaceRoot: resolveWorkspaceLayout({ squadId: this.squad.id }).workspaceMount,
      },
      typePrompt,
      slotPools,
      publicVoice: { section: publicVoice, publicTextEnabled },
      workspace: buildWorkspacePrompt({
        squadId: this.squad.id,
        squadName: this.squad.name,
        sandboxId,
        hasSquadBash: true,
        toolNames: workspaceToolNamesForPolicy(this.agentType.toolsAllow, this.agentType.toolsDeny, true),
        mayShareWithSubagents: true,
      }),
      teammates: managerSection,
      cliHelp,
      activeSchedules,
      flow: flow
        ? {
            participantId: flow.participantId,
            workStreamId: flow.workStreamId,
            deliveryInstructions: flow.deliveryInstructions,
          }
        : null,
      typeContext: this.squad.getTypeContext(this.agent.agentTypeId) ?? '',
      // Memory documentation, with the actual map.md contents, only when memory is enabled.
      memory: this.squad.isMemoryEnabled ? { map: readSquadMemoryFile(this.squad.id, 'map.md') } : null,
    })
  }

  // ---------------------------------------------------------------------------
  // Session setup
  // ---------------------------------------------------------------------------

  protected async createSession(scope: AdmissionScope | null = null): Promise<AgentSession> {
    // Get squad from agent's squadId
    if (!this.agent.squadId) {
      throw new Error('Squad worker agent has no squadId')
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

    const systemPrompt = await this.buildSquadWorkerPrompt()

    const { ficusToken, baseTools, sandboxStatusTool, shortTermMemoryTools } = await this.buildSessionToolkit({
      workspacePath: this.workspacePath,
      sandboxId: lightId,
      squadId: this.squad.id,
    })
    const squadBashTool = this.createSquadBashTool(this.squad.sandboxId, this.workspacePath, this.squad.id, ficusToken)
    const webTools = createWebTools()
    const browserTools = createBrowserTools(this.agent.id, lightId)
    const environmentTools = [...baseTools, squadBashTool, ...webTools, ...browserTools]
    const askHumanTool = createAsyncAskHumanTool({
      agentId: this.agent.id,
      executionId: this.execution.id,
      flushPersistence: () => this.persistence.waitForAll(),
    })
    const notifyContactTool = createNotifyContactTool({ agentId: this.agent.id, executionId: this.execution.id })
    const subagentLifecycleTools = createSubagentLifecycleTools({ agentId: this.agent.id })
    const todoTools = createSquadTodoTools(this.squad.id, this.agent.id)
    const setAgentPurposeTool = createSetAgentPurposeTool({ agentId: this.agent.id })

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
            askHumanTool,
            notifyContactTool,
            ...subagentLifecycleTools,
            ...(sandboxStatusTool ? [sandboxStatusTool] : []),
            setAgentPurposeTool,
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

  /** Squad workers automatically get the BigBrain read tools; `bigbrain_drop` stays an explicit opt-in. */
  protected override automaticBigbrainTools(): AutomaticBigbrainTools {
    return 'read'
  }

  protected override pushAgentEvent(): void {
    this.buffer.push({
      type: 'agent',
      agentId: this.agent.id,
      scope: { type: 'squad-manager', id: this.squad?.id },
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
