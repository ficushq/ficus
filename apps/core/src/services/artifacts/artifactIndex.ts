import type { ArtifactEntry, ArtifactManifest, ArtifactStatus } from '@ficus/shared'
import { Agent, agentWorkspaceSandboxId } from '../../entities/Agent'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../../entities/agent-runners/constants'
import { getAgentWorkspaceStoragePath } from '../sandbox/ensure'
import { listArtifactManifests, readArtifactRequests } from './artifactWorkspace'

const ARTIFACT_BUILDER_SPECIAL_ROLE = 'artifact-builder'
const RECENT_REQUESTS_TO_SEARCH = 5

export type ArtifactIndexAgent = {
  id: string
  agentTypeId?: string
  metadata?: Record<string, unknown> | null
  workspacePath?: string
  getSandboxId?: () => Promise<string> | string
  getAgentWorkspaceSandboxId?: () => string
}

export type ArtifactIndexResult = {
  agentId: string
  artifactId: string
  title: string
  summary?: string
  status: ArtifactStatus
  entry?: ArtifactEntry
  updatedAt: string
}

export type ListArtifactIndexParams = {
  agents?: ArtifactIndexAgent[]
  includeArchived?: boolean
  query?: string
  getAgentWorkspacePath?: (agent: ArtifactIndexAgent) => string | Promise<string>
}

export async function listArtifactIndex({
  agents,
  includeArchived = false,
  query,
  getAgentWorkspacePath = defaultGetAgentWorkspacePath,
}: ListArtifactIndexParams = {}): Promise<ArtifactIndexResult[]> {
  const candidateAgents = agents ?? (await Agent.list())
  const normalizedQuery = normalizeSearchText(query)
  const results: ArtifactIndexResult[] = []

  for (const agent of candidateAgents) {
    if (!isArtifactBuilderAgent(agent)) continue

    let agentWorkspacePath: string
    try {
      agentWorkspacePath = await getAgentWorkspacePath(agent)
    } catch (error) {
      console.warn(`Ignoring artifacts for agent ${agent.id}: failed to resolve workspace`, error)
      continue
    }

    let manifests: ArtifactManifest[]
    try {
      manifests = await listArtifactManifests({ agentWorkspacePath, includeArchived })
    } catch (error) {
      console.warn(`Ignoring artifacts for agent ${agent.id}: failed to list manifests`, error)
      continue
    }

    for (const manifest of manifests) {
      if (normalizedQuery) {
        let requests: Awaited<ReturnType<typeof readArtifactRequests>> = []
        try {
          requests = await readArtifactRequests({ agentWorkspacePath, artifactId: manifest.id })
        } catch (error) {
          console.warn(`Ignoring request history for artifact ${manifest.id}: failed to read requests sidecar`, error)
        }
        if (!manifestMatchesQuery(manifest, requests, normalizedQuery)) continue
      }
      results.push(toIndexResult(agent.id, manifest))
    }
  }

  return results.sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.agentId.localeCompare(b.agentId) ||
      a.artifactId.localeCompare(b.artifactId)
  )
}

function isArtifactBuilderAgent(agent: ArtifactIndexAgent): boolean {
  return (
    agent.agentTypeId === ARTIFACT_BUILDER_AGENT_TYPE_ID &&
    agent.metadata?.specialRole === ARTIFACT_BUILDER_SPECIAL_ROLE
  )
}

async function defaultGetAgentWorkspacePath(agent: ArtifactIndexAgent): Promise<string> {
  if (agent.workspacePath) return agent.workspacePath

  const sandboxId = await getArtifactBuilderWorkspaceSandboxId(agent)
  if (!sandboxId) {
    throw new Error(`Cannot resolve workspace for agent ${agent.id}: workspacePath and getSandboxId are unavailable`)
  }

  return getAgentWorkspaceStoragePath(sandboxId)
}

async function getArtifactBuilderWorkspaceSandboxId(agent: ArtifactIndexAgent): Promise<string | undefined> {
  const ownSandboxId = agent.getAgentWorkspaceSandboxId?.()
  if (ownSandboxId) return ownSandboxId

  const sandboxId = await agent.getSandboxId?.()
  if (sandboxId && !sandboxId.startsWith('squad_')) return sandboxId

  return agentWorkspaceSandboxId(agent.id)
}

function toIndexResult(agentId: string, manifest: ArtifactManifest): ArtifactIndexResult {
  return {
    agentId,
    artifactId: manifest.id,
    title: manifest.title,
    ...(manifest.summary !== undefined ? { summary: manifest.summary } : {}),
    status: manifest.status,
    ...(manifest.entry ? { entry: manifest.entry } : {}),
    updatedAt: manifest.updatedAt,
  }
}

function manifestMatchesQuery(
  manifest: ArtifactManifest,
  requests: Awaited<ReturnType<typeof readArtifactRequests>>,
  normalizedQuery: string
): boolean {
  const fields = [
    manifest.title,
    manifest.summary,
    ...requests.slice(-RECENT_REQUESTS_TO_SEARCH).map((request) => request.brief),
  ]

  return fields.some((field) => normalizeSearchText(field).includes(normalizedQuery))
}

function normalizeSearchText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}
