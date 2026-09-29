import type { SessionUsage, MessageMetadata } from '@ficus/shared'
import { AgentRunner } from './base'
import type { AdmissionScope } from '../../services/maintenance/admission-reservation'
import { getSquadWorkerCliHelp } from '../../lib/utils/cli-help'
import { interpolateTemplate, prompt, buildMemorySystemPrompt, buildActiveSchedulesPrompt } from '../../lib/prompts'
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
import { createSquadBashTool } from '../../tools/squad-bash'
import {
  AGENT_PURPOSE_DISPLAY_SECTION_TITLE,
  SET_AGENT_PURPOSE_INSTRUCTIONS,
} from '../../lib/prompts/agent-purpose-prompt'

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
    const [cliHelp, activeSchedules] = await Promise.all([
      getSquadWorkerCliHelp(),
      buildActiveSchedulesPrompt(this.squad.id, this.agent.id, 'worker'),
    ])

    // Build context for template interpolation
    const context: Record<string, string> = {
      'agent.id': this.agent.id,
      'agent.typeName': this.agentType.name,
      'agent.typeId': this.agent.agentTypeId,
      'squad.id': this.squad.id,
      'squad.name': this.squad.name,
      'squad.purpose': this.squad.purpose,
      'squad.defaultAgents': this.squad.defaultAgents.join(', ') || 'none',
      // Injected directly below via .text() so every worker type gets it even if
      // its agent type omits squad-rules.md (which carries the {{workspace}}
      // placeholder); empty here avoids duplication when squad-rules IS included.
      workspace: '',
      // Namespaced shared-workspace root (/workspace/<squadId>) for {{workspaceRoot}}
      // placeholders in agent-type / squad-owned context.
      workspaceRoot: resolveWorkspaceLayout({ squadId: this.squad.id }).workspaceMount,
      teammates: managerSection,
      cliHelp,
      activeSchedules,
      'squad.context': this.squad.context ?? '',
      'manager.id': this.squad.managerAgentId ?? '',
    }

    const typePrompt = await composeAgentTypePrompt(this.agentType)

    const p = prompt()
      .text(typePrompt)
      .text(
        buildWorkspacePrompt({
          squadId: this.squad.id,
          squadName: this.squad.name,
          sandboxId,
          hasSquadBash: true,
          toolNames: workspaceToolNamesForPolicy(this.agentType.toolsAllow, this.agentType.toolsDeny, true),
          mayShareWithSubagents: true,
        })
      )

    if (flow) {
      p.section(
        'Workflow contract',
        `You are participant ${flow.participantId} in work stream ${flow.workStreamId}. Follow your active step and return requests from the inbox; use ficus workstream flow ${flow.workStreamId} to check current state. Submit outcomes with ficus workstream advance --content using single-quoted JSON for short commands, or --stdin with a quoted heredoc for longer JSON/YAML; no temporary file is needed. The command must contain action, expectedVersion, attemptId, outcome, and evidence as a string. Re-read after a version conflict; retry only if your attempt is still running. Never bypass flow gates with assignee/status changes or untracked agents. While paused or blocked by an open wait, end your turn without scheduling a continuation; an answer is not approval. At completion-ready, final delivery review permits code-host feedback triage and tracked rework as described in deliveryInstructions. Parallel agents share the workspace, so coordinate file ownership. After advancing, workStreamStatus=done means delivery is complete: end your turn. Otherwise continue assignments returned to you in the command response without waiting for an inbox notification. Follow deliveryInstructions from the response or run when completion-ready; if only another agent has work, end your turn.`
      )

      if (flow.deliveryInstructions) p.section('Workflow delivery', flow.deliveryInstructions)
    }

    // Type-specific context — additive to global squad context
    const typeContext = this.squad.getTypeContext(this.agent.agentTypeId)
    if (typeContext) {
      p.section('Type-Specific Context', typeContext)
    }

    // Conditionally inject memory system documentation with actual map.md contents
    if (this.squad.isMemoryEnabled) {
      const mapContent = readSquadMemoryFile(this.squad.id, 'map.md')
      p.text(buildMemorySystemPrompt(this.squad.id, mapContent))
    }

    p.section(AGENT_PURPOSE_DISPLAY_SECTION_TITLE, SET_AGENT_PURPOSE_INSTRUCTIONS)

    return interpolateTemplate(p.build(), context)
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
    const notifyContactTool = createNotifyContactTool({ agentId: this.agent.id })
    const subagentLifecycleTools = createSubagentLifecycleTools({ agentId: this.agent.id })
    const monitorTool = createMonitorTool({
      agentId: this.agent.id,
      sandboxId: lightId,
      workspacePath: this.workspacePath,
    })
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
            monitorTool,
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
        createDispatchTool({
          agentId: this.agent.id,
          parentExecutionContext: {
            version: 1,
            squadId: this.squad.id,
            environmentToolNames: effectiveEnvironmentTools.map((tool) => tool.name),
          },
        }),
      ]
      return AgentSession.create(sessionOptions)
    })
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
