import type { SessionUsage, MessageMetadata, Squad as SquadJson } from '@ficus/shared'
import { AgentRunner } from './base'
import type { AdmissionScope } from '../../services/maintenance/admission-reservation'
import { Squad } from '../Squad'
import { isAssistantDelegate } from '../../services/assistant-agents'
import { getSquadManagerCliHelp } from '../../lib/utils/cli-help'
import { prompt, interpolateTemplate, buildActiveSchedulesPrompt, buildPlatformUrlsPrompt } from '../../lib/prompts'
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
import { createSquadBashTool } from '../../tools/squad-bash'
import {
  AGENT_PURPOSE_DISPLAY_SECTION_TITLE,
  SET_AGENT_PURPOSE_INSTRUCTIONS,
} from '../../lib/prompts/agent-purpose-prompt'
import { buildMemorySystemPrompt } from '../../lib/prompts'
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
    const [cliHelp, squadContext] = await Promise.all([getSquadManagerCliHelp(), this.buildSquadContext()])

    const typePrompt = await composeAgentTypePrompt(this.agentType)

    const p = prompt()
      .text(typePrompt)
      .text(
        buildWorkspacePrompt({
          agentId: this.agent.id,
          squadId: this.squad.id,
          squadName: this.squad.name,
          sandboxId,
          hasSquadBash: true,
          toolNames: workspaceToolNamesForPolicy(this.agentType.toolsAllow, this.agentType.toolsDeny, true),
          mayShareWithSubagents: true,
        })
      )
      .section('Model Overrides for Spawned Agents', buildModelOverridePrompt())
      .section('Current Squad State', squadContext)

    // Add manager instructions from squad preset if present
    p.section(
      'Declarative workflows',
      `For new work, select a workflow with ficus workstream create --workflow ID or --flow-content with single-quoted JSON for a short source; use --flow-stdin with a quoted heredoc for longer JSON/YAML. Files remain optional via --flow for saved definitions; do not create temporary files just to pass a payload. Use ficus workflow list to inspect available presets. A squad default applies when no source is supplied. The effective squad default is: ${JSON.stringify(this.squad.metadata?.workflow ?? null)}. A workflow owns participants, models, routing, and completion: do not also pass --agents, --agent-ids, --assign-id, or --completion-mode. Never pre-spawn agents for future steps or queued streams. Solo performs the deliverable in one session with no mandatory architect/reviewer turns. You may provide an ad hoc inline flow without publishing it. Guided flows follow declared paths; flexible flows allow bounded rework and tracked specialist delegation; adaptive flows support authorized future-step revisions. Preserve required checks unless explicitly authorized to change policy. Read ficus workstream flow before intervening; use versioned advance commands for revisions. The flow routes ordinary handoffs automatically and preserves return obligations. Do not substitute a bare assignee or status update. Squad presets only seed creation-time settings; this squad owns its context and work preferences.`
    )
    p.section(
      'Workflow setup',
      `Current selection guidance: ${JSON.stringify(this.squad.metadata?.workflowSetup ?? null)}. Consult setup-workflows during the first user-led setup conversation or when the user asks to change how this squad works. Use existing preferences; do not repeat completed onboarding or start agents to configure flows. Selection guidance is advice, not an automatic classifier: choose the appropriate explicit source when creating work.`
    )

    // Type-specific context (manager) — additive to global context
    const managerTypeContext = this.squad.getTypeContext('manager')
    if (managerTypeContext) {
      p.section('Type-Specific Context', managerTypeContext)
    }

    // Conditionally inject memory system documentation with actual map.md contents
    if (this.squad.isMemoryEnabled) {
      const mapContent = readSquadMemoryFile(this.squad.id, 'map.md')
      p.text(buildMemorySystemPrompt(this.squad.id, mapContent))
    }

    // Consultants set a dynamic display purpose like squad workers do — reuse the same shared
    // guidance/constant so the wording stays in one place. The manager keeps a static identity.
    if (this.agent.agentTypeId === 'consultant') {
      p.section(AGENT_PURPOSE_DISPLAY_SECTION_TITLE, SET_AGENT_PURPOSE_INSTRUCTIONS)
    }

    // Platform URLs (web UI, API, webhook endpoints)
    if (this.agent.context && 'channelInstance' in this.agent.context && this.agent.context.channelInstance) {
      p.section(
        'External channel conversation',
        [
          'You are a consultant speaking through an external channel. Incoming requests have passed the channel’s linked-user or trusted-channel access policy. Reply in the originating channel; users are responsible for choosing an appropriate audience.',
          'Use channel_respond once/early for each inbound inbox message. It replaces the thinking placeholder and marks the message read. Ask clarification questions there, not through ask_human.',
          'Use channel_send for later progress and final results. Use channel_edit only for Ficus-sent message IDs returned by these tools.',
          'For work requested here, create a work stream owned by you so its lifecycle updates return to this conversation. Coordinate operational decisions with the squad manager, and relay progress back through channel_send.',
        ].join('\n')
      )
    }
    p.text(buildPlatformUrlsPrompt())

    // Interpolate all {{...}} placeholders in the system prompt.
    //
    // The manager systemPrompt includes the shared `squad-rules.md` (via
    // manager.yaml), which carries the same placeholders the squad *worker*
    // runner resolves ({{workspace}}, {{teammates}}, {{activeSchedules}},
    // {{cliHelp}}) plus the agent/squad identity tokens. The manager supplies
    // the equivalent of workspace, teammates, and active schedules through its
    // own richer dedicated sections above (## Workspace, ## Current Squad State
    // which embeds the active-schedules block), so those placeholders resolve
    // to empty here to avoid duplication. The CLI reference ({{cliHelp}}) is
    // only emitted via this placeholder for the manager, so it carries the
    // real value. Identity tokens (agent.*, squad.*) resolve to their values.
    return interpolateTemplate(p.build(), {
      'agent.id': this.agent.id,
      'agent.typeName': this.agentType.name,
      'agent.typeId': this.agent.agentTypeId,
      'squad.id': this.squad.id,
      'squad.name': this.squad.name,
      'squad.purpose': this.squad.purpose,
      'squad.defaultAgents': this.squad.defaultAgents.join(', ') || 'none',
      'squad.context': this.squad.context ?? '',
      // The squad's manager agent id. For the manager this is its own id; for a
      // consultant (same runner) it's the manager to hand work off to.
      'manager.id': this.squad.managerAgentId ?? '',
      // Provided via dedicated sections above; empty avoids duplication.
      workspace: '',
      teammates: '',
      activeSchedules: '',
      // Namespaced shared-workspace root (/workspace/<squadId>) for {{workspaceRoot}}
      // placeholders in agent-type / squad-preset instructions.
      workspaceRoot: resolveWorkspaceLayout({ squadId: this.squad.id }).workspaceMount,
      // The manager's CLI reference is emitted only through this placeholder.
      cliHelp,
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
    const monitorTool = createMonitorTool({
      agentId: this.agent.id,
      sandboxId: lightId,
      workspacePath: this.workspacePath,
    })
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
            monitorTool,
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
