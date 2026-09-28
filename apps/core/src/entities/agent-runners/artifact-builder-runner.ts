import type { SessionUsage, MessageMetadata } from '@ficus/shared'
import { AgentRunner } from './base'
import type { AdmissionScope } from '../../services/maintenance/admission-reservation'
import { ensureWorkspaceSandbox, getAgentWorkspaceStoragePath } from '../../services/sandbox/ensure'
import { AgentSession } from '../AgentSession'
import { createArtifactTools } from '../../tools'
import { interpolateTemplate } from '../../lib/prompts'
import { composeAgentTypePrompt } from '../../services/agent-types/compose-prompt'
import { buildWorkspacePrompt } from '../../lib/prompts/workspace-prompt'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID, ARTIFACT_BUILDER_RUNNER_TYPE } from './constants'

export { ARTIFACT_BUILDER_AGENT_TYPE_ID } from './constants'

export function isArtifactBuilderAgentTypeId(agentTypeId: string): boolean {
  return agentTypeId === ARTIFACT_BUILDER_AGENT_TYPE_ID
}

export class ArtifactBuilderRunner extends AgentRunner {
  private workspacePath!: string

  protected ensureWorkspaceSandbox(args: Parameters<typeof ensureWorkspaceSandbox>[0]): Promise<string> {
    return ensureWorkspaceSandbox(args)
  }

  protected getAgentWorkspaceStoragePath(sandboxId: string): string {
    return getAgentWorkspaceStoragePath(sandboxId)
  }

  protected async createSession(scope: AdmissionScope | null = null): Promise<AgentSession> {
    const { sandboxId, skillPaths, extensionPaths } = await this.resolveSessionPaths()

    this.workspacePath = await this.withSandboxSetupBatch(() =>
      this.ensureWorkspaceSandbox({
        sandboxId,
        workspaceId: sandboxId,
        ...(scope ? { admissionScope: scope } : {}),
        setupProgress: this.sandboxSetupProgress,
      })
    )

    const typePrompt = await composeAgentTypePrompt(this.agentType)
    const systemPrompt = `${interpolateTemplate(typePrompt, {
      'agent.id': this.agent.id,
      'agent.typeName': this.agentType.name,
      'agent.typeId': this.agent.agentTypeId,
    })}\n\n${buildWorkspacePrompt({ sandboxId })}`
    const artifactWorkspacePath = this.getAgentWorkspaceStoragePath(sandboxId)

    // No squadId: artifact builders are always created squad-less (both
    // creation paths in artifactVoiceRequests pass squadId: null), and the
    // ensure above provisions a solo /private box with no squad mounts —
    // so neither the coding tools nor sandbox_status see a squad workspace.
    // If squad-scoped artifact builders ever exist, the ensure must gain
    // squad context first, then squadId flows through here too.
    const { baseTools, sandboxStatusTool, shortTermMemoryTools } = await this.buildSessionToolkit({
      workspacePath: this.workspacePath,
      sandboxId,
    })
    const artifactTools = createArtifactTools({
      agentId: this.agent.id,
      squadId: this.agent.squadId,
      agentWorkspacePath: artifactWorkspacePath,
    })

    return this.createPiSession(scope, async () =>
      AgentSession.create(
        await this.buildBaseSessionOptions({
          systemPrompt,
          skillPaths,
          extensionPaths,
          sandboxId,
          workspacePath: this.workspacePath,
          tools: {
            core: [...shortTermMemoryTools, ...(sandboxStatusTool ? [sandboxStatusTool] : [])],
            available: [...baseTools, ...artifactTools],
          },
        })
      )
    )
  }

  protected override pushAgentEvent(): void {
    this.buffer.push({
      type: 'agent',
      agentId: this.agent.id,
      scope: { type: ARTIFACT_BUILDER_RUNNER_TYPE },
      executionId: this.execution.id,
    })
  }

  protected async onComplete(
    response: string,
    metadata: MessageMetadata | undefined,
    sessionUsage: SessionUsage
  ): Promise<void> {
    await this.completeNormally(response, metadata, sessionUsage)
  }
}
