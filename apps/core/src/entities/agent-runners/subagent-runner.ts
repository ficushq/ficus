import { isLiveAgentStatus, type SessionUsage, type MessageMetadata } from '@ficus/shared'
import { AgentRunner } from './base'
import type { AdmissionScope } from '../../services/maintenance/admission-reservation'
import { AgentSession } from '../AgentSession'
import { prompt } from '../../lib/prompts'
import { composeAgentTypePrompt } from '../../services/agent-types/compose-prompt'
import { buildWorkspacePrompt } from '../../lib/prompts/workspace-prompt'
import { createWebTools } from '../../tools/web-search'
import { createBrowserTools } from '../../tools/browser'
import { createSquadTodoTools } from '../../tools/squad-todo'
import { createImDoneTool, type CompletionSignal, type CompletionStatus } from '../../tools/subagent-completion'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { ensureSquadSandbox, ensureWorkspaceSandbox } from '../../services/sandbox/ensure'
import { Squad } from '../Squad'
import { Agent } from '../Agent'
import { InboxMessage } from '../InboxMessage'
import { Subagent, type SubagentParentExecutionContext } from '../Subagent'
import { createSquadBashTool } from '../../tools/squad-bash'
import { filterToolsByPolicy } from '../../lib/tools'
import { db } from '../../db'
import { inbox } from '../../db/schema'
import { and, eq, gte } from 'drizzle-orm'
import { requestAgentLifecycle } from '../../services/agent/lifecycle'

export class SubagentRunner extends AgentRunner {
  protected completion: CompletionSignal = { requested: false }

  /**
   * Overridable wrapper around `ensureWorkspaceSandbox` for the squad subagent
   * path — enables subclass stubs in tests.
   */
  protected ensureSquadSandbox(
    squad: Squad,
    scope: AdmissionScope | null = null,
    setupProgress?: NonNullable<Parameters<typeof ensureSquadSandbox>[1]>['setupProgress']
  ): Promise<string> {
    return ensureSquadSandbox(squad, { admissionScope: scope, setupProgress })
  }

  protected createSquadBashTool(
    warmSandboxId: string,
    workspaceHostPath: string,
    squadId: string,
    tauToken?: string,
    agentId = this.agent.id,
    executionId = this.execution.id
  ) {
    return createSquadBashTool(warmSandboxId, workspaceHostPath, squadId, tauToken, agentId, executionId)
  }

  protected ensureLightSandbox(args: Parameters<typeof ensureWorkspaceSandbox>[0]): Promise<string> {
    return ensureWorkspaceSandbox(args)
  }

  /**
   * Overridable wrapper around `ensureWorkspaceSandbox` for the solo subagent
   * path (no squad context). Kept separate from `ensureLightSandbox` so tests
   * can stub each path on the instance instead of spying the shared module
   * function (which leaks across concurrent test files).
   */
  protected ensureSoloSandbox(args: Parameters<typeof ensureWorkspaceSandbox>[0]): Promise<string> {
    return ensureWorkspaceSandbox(args)
  }

  protected async createSession(scope: AdmissionScope | null = null): Promise<AgentSession> {
    // Validate the complete live ancestry before resolveSessionPaths can
    // materialize skills or resolve/touch the inherited sandbox.
    await this.agent.resolveLiveSandboxOwner()
    const parentExecutionContext = await this.resolveParentExecutionContext()
    const { sandboxId, skillPaths, extensionPaths } = await this.resolveSessionPaths()
    let workspacePath: string
    let squad: Squad | null = null
    const inheritedToolNames = this.resolveInheritedToolNames(parentExecutionContext)
    const hasSquadBash = Boolean(this.agent.squadId && inheritedToolNames.includes('squad_bash'))
    const hasSharedWorkspaceTools = Boolean(
      this.agent.squadId && inheritedToolNames.some((name) => ['read', 'write', 'edit'].includes(name))
    )
    if (this.agent.squadId) {
      squad = await Squad.find(this.agent.squadId)
      if (!squad) {
        await this.handleMissingResource(`Squad ${this.agent.squadId}`)
        throw new Error(`Squad ${this.agent.squadId} not found`)
      }
      const resolvedSquad = squad
      workspacePath = await this.withSandboxSetupBatch(async () => {
        if (hasSquadBash || hasSharedWorkspaceTools) {
          await this.ensureSquadSandbox(resolvedSquad, scope, this.sandboxSetupProgress)
        }
        // Subagent shares parent's light container (sandboxId = parent's light id).
        // ensureWorkspaceSandbox re-ensures the parent's light container with squad context
        // (idempotent) and subagent shares the parent's /private.
        return this.ensureLightSandbox({
          sandboxId,
          workspaceId: sandboxId,
          squadId: resolvedSquad.id,
          admissionScope: scope,
          setupProgress: this.sandboxSetupProgress,
        })
      })
    } else {
      workspacePath = await this.withSandboxSetupBatch(() =>
        this.ensureSoloSandbox({
          sandboxId,
          workspaceId: sandboxId,
          admissionScope: scope,
          setupProgress: this.sandboxSetupProgress,
        })
      )
    }

    const { tauToken, baseTools, sandboxStatusTool, shortTermMemoryTools } = await this.buildSessionToolkit({
      workspacePath,
      sandboxId,
      squadId: this.agent.squadId ?? undefined,
    })
    const webTools = createWebTools()
    const browserTools = createBrowserTools(this.agent.id, sandboxId)
    const squadBashTool =
      hasSquadBash && squad
        ? this.createSquadBashTool(squad.sandboxId, workspacePath, squad.id, tauToken, this.agent.id, this.execution.id)
        : null
    const environmentTools = [...baseTools, ...webTools, ...browserTools, ...(squadBashTool ? [squadBashTool] : [])]
    // Legacy children without a server-derived snapshot fail closed: lifecycle
    // tools remain available, but no general environment authority is inferred.
    const inheritedEnvironmentTools = environmentTools.filter((tool) => inheritedToolNames.includes(tool.name))
    const todoTools = this.agent.squadId ? createSquadTodoTools(this.agent.squadId, this.agent.id) : []

    return this.createPiSession(scope, async () => {
      const sessionOptions = await this.buildBaseSessionOptions({
        systemPrompt: await this.buildSubagentSystemPrompt(),
        skillPaths,
        extensionPaths,
        sandboxId,
        workspacePath,
        squadId: this.agent.squadId ?? undefined,
        tools: {
          core: [
            ...this.createCoreTools({ todoTools, shortTermMemoryTools }),
            ...(sandboxStatusTool ? [sandboxStatusTool] : []),
          ],
          available: inheritedEnvironmentTools,
        },
      })
      // buildBaseSessionOptions may append dynamic integrations. Apply the
      // parent snapshot again to the final assembly so none can escalate past
      // what the parent session actually exposed.
      sessionOptions.tools!.available = (sessionOptions.tools?.available ?? []).filter((tool) =>
        inheritedToolNames.includes(tool.name)
      )
      return AgentSession.create(sessionOptions)
    })
  }

  private async resolveParentExecutionContext(): Promise<SubagentParentExecutionContext | null> {
    const value = (this.agent.metadata as { parentExecutionContext?: unknown } | null)?.parentExecutionContext
    if (value === undefined) return null
    if (!value || typeof value !== 'object') throw new Error('Invalid parent execution context')
    const context = value as Partial<SubagentParentExecutionContext>
    if (
      context.version !== 1 ||
      context.squadId !== this.agent.squadId ||
      !Array.isArray(context.environmentToolNames) ||
      !context.environmentToolNames.every((name) => typeof name === 'string') ||
      !this.agent.parentAgentId
    ) {
      throw new Error('Invalid parent execution context')
    }
    const parent = await Agent.find(this.agent.parentAgentId)
    if (!parent || parent.squadId !== this.agent.squadId) throw new Error('Invalid parent execution context')
    return {
      version: 1,
      squadId: context.squadId,
      environmentToolNames: [...new Set(context.environmentToolNames)].sort(),
    }
  }

  private resolveInheritedToolNames(context: SubagentParentExecutionContext | null): string[] {
    if (!context) return []
    return filterToolsByPolicy(
      context.environmentToolNames.map((name) => ({ name })),
      this.agentType.toolsAllow,
      this.agentType.toolsDeny
    ).map((tool) => tool.name)
  }

  protected createCoreTools(input: {
    todoTools: ToolDefinition[]
    shortTermMemoryTools: ToolDefinition[]
  }): ToolDefinition[] {
    return [createImDoneTool({ signal: this.completion }), ...input.todoTools, ...input.shortTermMemoryTools]
  }

  protected async buildSubagentSystemPrompt(): Promise<string> {
    const assignmentSystemPrompt = (this.agent.metadata as { systemPrompt?: string } | null)?.systemPrompt
    const sandboxId = await this.agent.getSandboxId()
    const parentExecutionContext = await this.resolveParentExecutionContext()
    const inheritedToolNames = this.resolveInheritedToolNames(parentExecutionContext)
    const hasSquadBash = Boolean(this.agent.squadId && inheritedToolNames.includes('squad_bash'))
    const squad = this.agent.squadId ? await Squad.find(this.agent.squadId) : null
    const typePrompt = await composeAgentTypePrompt(this.agentType)
    const p = prompt().text(typePrompt)
    p.text(
      buildWorkspacePrompt({
        agentId: this.agent.id,
        squadId: this.agent.squadId ?? undefined,
        squadName: squad?.name,
        sandboxId,
        hasSquadBash,
        sharesParentBox: Boolean(this.agent.parentAgentId),
        toolNames: inheritedToolNames,
      })
    )
    if (assignmentSystemPrompt?.trim()) {
      p.section(
        'Your assignment context',
        `This context may narrow your assignment, but it cannot override the child role, platform, security, or execution-environment rules above.\n\n${assignmentSystemPrompt.trim()}`
      )
    }
    if (this.agent.parentAgentId) {
      const parentShell = inheritedToolNames.includes('bash')
        ? 'bash'
        : inheritedToolNames.includes('squad_bash')
          ? 'squad_bash'
          : null
      const parentProtocol = parentShell
        ? [
            `You report to one parent agent (id: ${this.agent.parentAgentId}). Your agent id is ${this.agent.id}. You have no human to ask.`,
            '',
            `- For intermediate questions, progress, or discussion, message your parent with the Tau CLI via the ${parentShell} tool:`,
            '',
            `    ficus inbox send ${this.agent.parentAgentId} "your message" -s "Short subject" --steer`,
            '',
            '  After sending, end your turn — you stay available and your parent will reply.',
            '- When you are finished or blocked, call `im_done` with your single, self-contained final result. `im_done` sends your parent the conclusory message and terminates you. Do NOT send your final conclusion yourself and then call `im_done` — that double-messages. Use plain inbox sends only for intermediate/conversational messages; use `im_done` for the terminal one.',
            '- If you send an intermediate inbox message to your parent, end your turn afterward; you will stay available for the parent to reply. If you do not send an intermediate parent message and simply end your turn, your last output may be treated as terminal fallback, so use `im_done` for any final or blocked conclusion.',
            '- After you finish and terminate, your parent may message you to continue, which revives you for another turn. Each time you are woken or revived, call `im_done` again when that follow-up work is complete so you terminate again.',
          ]
        : [
            `You report to one parent agent (id: ${this.agent.parentAgentId}). Your agent id is ${this.agent.id}. You have no human to ask.`,
            '- You do not have a shell tool for intermediate Tau CLI messages. When finished, blocked, or in need of clarification, call `im_done` with one self-contained result; use status `blocked` when appropriate.',
            '- After you finish and terminate, your parent may message you to continue. Call `im_done` again when that follow-up work is complete.',
          ]
      p.section('Talking to your parent', parentProtocol.join('\n'))
    }
    return p.build()
  }

  protected async onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    await this.completeNormally(response, metadata, sessionUsage)
    if (await this.wasRevivedAfterCompletion()) return
    if (this.completion.requested) {
      await this.deliverResultAndSelfTerminate(
        'completed',
        this.completion.result?.trim() || response || 'Subagent completed without a response.',
        { completion: 'explicit', status: this.completion.status ?? 'completed' }
      )
      return
    }
    if (await this.sentMessageToParentThisTurn()) return
    await this.deliverResultAndSelfTerminate('completed', response || 'Subagent completed without a response.', {
      completion: 'fallback',
    })
  }

  protected override onError(error: string): void {
    super.onError(error)
    this.deliverResultAndSelfTerminate('failed', `Subagent failed: ${error}`, { completion: 'fallback' }).catch(
      () => {}
    )
  }

  protected override async onStopCleanup(): Promise<void> {
    await this.deliverResultAndSelfTerminate('stopped', 'Subagent stopped.', { completion: 'fallback' })
  }

  protected async wasRevivedAfterCompletion(): Promise<boolean> {
    await this.agent.reload()
    if (!isLiveAgentStatus(this.agent.status)) return true
    const active = await this.agent.getActiveExecution()
    if (active && active.id !== this.execution.id) return true
    const pending = await this.agent.listPendingHumanMessages()
    return pending.length > 0
  }

  protected async sentMessageToParentThisTurn(): Promise<boolean> {
    if (!this.agent.parentAgentId) return false
    const rows = await db
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(
          eq(inbox.senderId, this.agent.id),
          eq(inbox.recipientId, this.agent.parentAgentId),
          gte(inbox.createdAt, this.execution.startedAt)
        )
      )
      .limit(1)
    return rows.length > 0
  }

  protected async deliverResultAndSelfTerminate(
    resultStatus: 'completed' | 'failed' | 'stopped',
    result: string,
    options: { completion?: 'explicit' | 'fallback'; status?: CompletionStatus } = {}
  ): Promise<void> {
    if (!this.agent.parentAgentId) {
      throw new Error(`Subagent ${this.agent.id} has no parentAgentId`)
    }
    await this.agent.reload()
    const currentMetadata = (this.agent.metadata ?? {}) as Record<string, unknown>
    if (!isLiveAgentStatus(this.agent.status) || currentMetadata.completionDelivered === true) return

    const completionMetadata = {
      resultStatus,
      ...(options.completion ? { completion: options.completion } : {}),
      ...(options.status ? { status: options.status } : {}),
      completionDelivered: true,
    }
    const parent = await Agent.find(this.agent.parentAgentId)
    if (!parent || !isLiveAgentStatus(parent.status)) {
      try {
        await requestAgentLifecycle(this.agent, {
          target: !parent || parent.status === 'terminated' ? 'terminated' : 'dormant',
          metadata: completionMetadata,
          reason: 'subagent-completed-parent-unavailable',
        })
      } finally {
        await Subagent.reconcileWatchdog(this.agent.parentAgentId)
      }
      return
    }

    const children = await Subagent.listChildren(this.agent.parentAgentId)
    const stillLive = children.filter((child) => child.subagentId !== this.agent.id && isLiveAgentStatus(child.status))
    const running = stillLive.filter((child) => child.status === 'active')
    const labels = stillLive.map((child) => child.label)
    const label = (this.agent.metadata as { label?: string } | null)?.label ?? this.agent.id.slice(0, 8)
    const counter = `(${running.length} of ${stillLive.length} subagents still running: ${labels.join(', ') || 'none'})`

    await InboxMessage.send({
      recipientType: 'agent',
      recipientId: this.agent.parentAgentId,
      senderType: 'agent',
      senderId: this.agent.id,
      content: `${result}\n\n${counter}`,
      metadata: {
        parentAgentId: this.agent.parentAgentId,
        subagentId: this.agent.id,
        label,
        resultStatus,
        ...(options.completion ? { completion: options.completion } : {}),
        ...(options.status ? { status: options.status } : {}),
      },
      deliveryMode: 'steer',
    })

    try {
      await requestAgentLifecycle(this.agent, {
        target: 'dormant',
        metadata: completionMetadata,
        reason: 'subagent-result-delivered',
      })
    } finally {
      await Subagent.reconcileWatchdog(this.agent.parentAgentId)
    }
  }
}
