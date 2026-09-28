import {
  closeCanvasTool,
  createCanvasTool,
  displayAppTool,
  showCanvasTool,
  updateCanvasTool,
  type CanvasToolEnvironment,
} from '../../tools/canvasTools'
import { workspaceInboxMessageAgentTool } from '../../tools/agentMessagingTools'
import { artifactTools } from '../../tools/artifactTools'
import { createVoiceToolRegistry } from '../../tools/registry'
import { getWorkTool } from '../../tools/statusTools'
import { readThreadTool } from '../../tools/threadTools'
import type { VoiceAssistantTool } from '../../tools/types'

export type WorkspaceVoiceEnvironment = CanvasToolEnvironment

const displayArtifactTool: VoiceAssistantTool<WorkspaceVoiceEnvironment> = {
  definition: {
    type: 'function',
    name: 'display_artifact',
    description:
      'Display a specific existing artifact in the voice workspace. Use after list_artifacts when the user asks to show an older, previous, named, or specific artifact. Do not use this merely to answer questions about what an artifact is; answer from list_artifacts or get_artifact_context instead.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Owning artifact builder agent ID from list_artifacts.' },
        artifactId: { type: 'string', description: 'Artifact ID from list_artifacts.' },
      },
      required: ['agentId', 'artifactId'],
    },
  },
  async execute(args, env) {
    const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : ''
    const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
    if (!agentId || !artifactId) return { ok: false, error: 'agentId and artifactId are required' }

    const currentDisplay = env.getWorkspaceState().activeArtifactDisplay
    if (
      currentDisplay?.mode === 'specific' &&
      currentDisplay.agentId === agentId &&
      currentDisplay.artifactId === artifactId
    ) {
      return { ok: false, error: 'That artifact is already displayed.', display: currentDisplay }
    }

    const display = { mode: 'specific' as const, agentId, artifactId }
    env.setWorkspaceState((state) => ({ ...state, activeArtifactDisplay: display }))
    return { ok: true, display }
  },
  summarizeCall(args) {
    return `Display artifact ${String(args.artifactId)}`
  },
  followUp: 'auto',
}

const displayLatestArtifactTool: VoiceAssistantTool<WorkspaceVoiceEnvironment> = {
  definition: {
    type: 'function',
    name: 'display_latest_artifact',
    description:
      'Return the voice workspace artifact display to the latest recently updated non-archived artifact. Use when the user asks to show, switch to, or display the latest/current artifact. Do not use this merely to answer questions like what is the latest artifact; answer from list_artifacts or get_artifact_context instead.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async execute(_args, env) {
    const currentDisplay = env.getWorkspaceState().activeArtifactDisplay
    if (!currentDisplay || currentDisplay.mode === 'latest') {
      return { ok: false, error: 'The latest artifact is already displayed.', display: { mode: 'latest' as const } }
    }

    const display = { mode: 'latest' as const }
    env.setWorkspaceState((state) => ({ ...state, activeArtifactDisplay: display }))
    return { ok: true, display }
  },
  summarizeCall() {
    return 'Display latest artifact'
  },
  followUp: 'auto',
}

const workspaceApiTools = [workspaceInboxMessageAgentTool, getWorkTool, readThreadTool].map(
  // These shared Ficus API tools do not read from the executor env; keep the workspace env route-free.
  (tool) => tool as unknown as VoiceAssistantTool<WorkspaceVoiceEnvironment>
)

export const workspaceTools = createVoiceToolRegistry<WorkspaceVoiceEnvironment>([
  ...workspaceApiTools,
  ...artifactTools,
  displayArtifactTool,
  displayLatestArtifactTool,
  createCanvasTool,
  updateCanvasTool,
  showCanvasTool,
  displayAppTool,
  closeCanvasTool,
])

export const workspaceToolDefinitions = workspaceTools.definitions
