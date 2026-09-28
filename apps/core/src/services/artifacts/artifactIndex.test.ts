import { mkdtemp, mkdir, rm, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { ArtifactManifest } from '@ficus/shared'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../../entities/agent-runners/constants'
import {
  appendArtifactRequest,
  createArtifactInAgentWorkspace,
  mutateArtifactManifest,
  readArtifactManifest,
} from './artifactWorkspace'
import { listArtifactIndex, type ArtifactIndexAgent } from './artifactIndex'

describe('artifact index service', () => {
  let rootPath: string
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'tau-artifact-index-'))
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    warnSpy.mockRestore()
    await rm(rootPath, { recursive: true, force: true })
  })

  it('scans only agents with artifact-builder specialRole metadata and agent type', async () => {
    const builderWorkspace = await createWorkspace('builder')
    const regularWorkspace = await createWorkspace('regular')
    const wronglyTaggedWorkspace = await createWorkspace('wrongly-tagged')
    const builderArtifact = await createArtifactInAgentWorkspace({
      agentWorkspacePath: builderWorkspace,
      title: 'Builder artifact',
      brief: 'Create the builder artifact',
    })
    await createArtifactInAgentWorkspace({
      agentWorkspacePath: regularWorkspace,
      title: 'Regular artifact',
      brief: 'Create the regular artifact',
    })
    await createArtifactInAgentWorkspace({
      agentWorkspacePath: wronglyTaggedWorkspace,
      title: 'Wrongly tagged artifact',
      brief: 'Create wrongly tagged artifact',
    })

    const results = await listArtifactIndex({
      agents: [
        agentFixture('builder-agent', builderWorkspace, { specialRole: 'artifact-builder' }),
        agentFixture('regular-agent', regularWorkspace, { specialRole: 'worker' }),
        agentFixture('missing-metadata-agent', regularWorkspace),
        agentFixture(
          'wrongly-tagged-agent',
          wronglyTaggedWorkspace,
          { specialRole: 'artifact-builder' },
          'worker-default'
        ),
      ],
    })

    expect(results).toEqual([
      {
        agentId: 'builder-agent',
        artifactId: builderArtifact.artifactId,
        title: 'Builder artifact',
        status: 'working',
        updatedAt: builderArtifact.manifest.updatedAt,
      },
    ])
  })

  it('skips malformed manifests and leaves a warning from manifest listing', async () => {
    const workspace = await createWorkspace('malformed')
    const valid = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Valid artifact',
      brief: 'Create valid artifact',
    })
    await mkdir(join(workspace, 'artifacts', 'broken-artifact'), { recursive: true })
    await writeFile(join(workspace, 'artifacts', 'broken-artifact', 'manifest.json'), '{not json')

    const results = await listArtifactIndex({
      agents: [agentFixture('builder-agent', workspace, { specialRole: 'artifact-builder' })],
    })

    expect(results.map((result) => result.artifactId)).toEqual([valid.artifactId])
    expect(warnSpy).toHaveBeenCalled()
    expect(
      warnSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes('Ignoring malformed artifact manifest'))
    ).toBe(true)
  })

  it('hides archived artifacts by default and can include them on request', async () => {
    const workspace = await createWorkspace('archived')
    const archived = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Archived artifact',
      brief: 'Create archived artifact',
    })
    await mutateArtifactManifest({
      agentWorkspacePath: workspace,
      artifactId: archived.artifactId,
      mutate: (manifest) => ({ ...manifest, archived: true }),
    })
    const agents = [agentFixture('builder-agent', workspace, { specialRole: 'artifact-builder' })]

    await expect(listArtifactIndex({ agents })).resolves.toEqual([])
    await expect(listArtifactIndex({ agents, includeArchived: true })).resolves.toMatchObject([
      { agentId: 'builder-agent', artifactId: archived.artifactId, title: 'Archived artifact' },
    ])
  })

  it('skips one builder agent when workspace resolution fails', async () => {
    const workspace = await createWorkspace('workspace-resolution')
    const valid = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Valid artifact',
      brief: 'Create valid artifact',
    })
    const agents = [
      { id: 'bad-agent', agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, metadata: { specialRole: 'artifact-builder' } },
      agentFixture('builder-agent', workspace, { specialRole: 'artifact-builder' }),
    ]

    const results = await listArtifactIndex({
      agents,
      getAgentWorkspacePath: (agent) => {
        if (agent.id === 'bad-agent') throw new Error('workspace unavailable')
        return workspace
      },
    })

    expect(results.map((result) => result.artifactId)).toEqual([valid.artifactId])
    expect(warnSpy).toHaveBeenCalledWith(
      'Ignoring artifacts for agent bad-agent: failed to resolve workspace',
      expect.any(Error)
    )
  })

  it('resolves a real agent-shaped workspace from getSandboxId when workspacePath is absent', async () => {
    const workspace = await createWorkspace('sandbox-resolver')
    const valid = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Sandbox resolver artifact',
      brief: 'Create sandbox resolver artifact',
    })
    const agents: ArtifactIndexAgent[] = [
      {
        id: 'builder-agent',
        agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID,
        metadata: { specialRole: 'artifact-builder' },
        getSandboxId: () => 'agent_artifact-builder_builder-agent',
      },
    ]
    const resolvedWorkspaceIds: string[] = []

    await expect(
      listArtifactIndex({
        agents,
        getAgentWorkspacePath: async (agent) => {
          const sandboxId = await agent.getSandboxId?.()
          if (!sandboxId) throw new Error('missing sandbox id')
          resolvedWorkspaceIds.push(sandboxId)
          return workspace
        },
      })
    ).resolves.toMatchObject([{ agentId: 'builder-agent', artifactId: valid.artifactId }])
    expect(resolvedWorkspaceIds).toEqual(['agent_artifact-builder_builder-agent'])
  })

  it('resolves artifact-builder agents with squad sandbox IDs to agent-specific workspaces', async () => {
    const firstWorkspace = await createWorkspace('first-builder')
    const secondWorkspace = await createWorkspace('second-builder')
    const firstArtifact = await createArtifactInAgentWorkspace({
      agentWorkspacePath: firstWorkspace,
      title: 'First builder artifact',
      brief: 'Create first builder artifact',
    })
    const secondArtifact = await createArtifactInAgentWorkspace({
      agentWorkspacePath: secondWorkspace,
      title: 'Second builder artifact',
      brief: 'Create second builder artifact',
    })
    const workspaceById = new Map([
      ['agent_artifact-builder-default_first-builder', firstWorkspace],
      ['agent_artifact-builder-default_second-builder', secondWorkspace],
    ])
    const agents: ArtifactIndexAgent[] = [
      {
        id: 'first-builder',
        agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID,
        metadata: { specialRole: 'artifact-builder' },
        getSandboxId: () => 'squad_shared-squad',
      },
      {
        id: 'second-builder',
        agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID,
        metadata: { specialRole: 'artifact-builder' },
        getSandboxId: () => 'squad_shared-squad',
      },
    ]
    const resolvedWorkspaceIds: string[] = []

    await expect(
      listArtifactIndex({
        agents,
        getAgentWorkspacePath: (agent) => {
          const workspaceId = `agent_${agent.agentTypeId ?? ARTIFACT_BUILDER_AGENT_TYPE_ID}_${agent.id}`
          const workspace = workspaceById.get(workspaceId)
          if (!workspace) throw new Error(`unexpected workspace ${workspaceId}`)
          resolvedWorkspaceIds.push(workspaceId)
          return workspace
        },
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'first-builder', artifactId: firstArtifact.artifactId }),
        expect.objectContaining({ agentId: 'second-builder', artifactId: secondArtifact.artifactId }),
      ])
    )
    expect(resolvedWorkspaceIds.sort()).toEqual([
      'agent_artifact-builder-default_first-builder',
      'agent_artifact-builder-default_second-builder',
    ])
  })

  it('searches title, summary, and recent request briefs from the requests sidecar', async () => {
    const workspace = await createWorkspace('search')
    const titleMatch = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Quarterly Roadmap',
      brief: 'Create planning document',
    })
    const summaryMatch = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Operations Notes',
      brief: 'Create operations notes',
    })
    await mutateArtifactManifest({
      agentWorkspacePath: workspace,
      artifactId: summaryMatch.artifactId,
      mutate: (manifest) => ({ ...manifest, summary: 'Summarizes launch readiness' }),
    })
    const requestMatch = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Status Report',
      brief: 'Prepare beta onboarding details',
    })
    const oldRequestOnlyMatch = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Old request only',
      brief: 'ancient-token',
    })
    for (let index = 0; index < 5; index += 1) {
      await appendArtifactRequest({
        agentWorkspacePath: workspace,
        artifactId: oldRequestOnlyMatch.artifactId,
        action: 'continue',
        brief: `Recent unrelated update ${index}`,
      })
    }
    await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Unrelated',
      brief: 'Create unrelated artifact',
    })
    const agents = [agentFixture('builder-agent', workspace, { specialRole: 'artifact-builder' })]
    await expect(
      readArtifactManifest({ agentWorkspacePath: workspace, artifactId: requestMatch.artifactId })
    ).resolves.not.toHaveProperty('requests')

    await expect(listArtifactIndex({ agents, query: 'roadmap' })).resolves.toMatchObject([
      { artifactId: titleMatch.artifactId },
    ])
    await expect(listArtifactIndex({ agents, query: 'launch readiness' })).resolves.toMatchObject([
      { artifactId: summaryMatch.artifactId },
    ])
    await expect(listArtifactIndex({ agents, query: 'beta onboarding' })).resolves.toMatchObject([
      { artifactId: requestMatch.artifactId },
    ])
    await expect(listArtifactIndex({ agents, query: 'ancient-token' })).resolves.toEqual([])
  })

  it('falls back to manifest fields when a request sidecar is malformed during search', async () => {
    const workspace = await createWorkspace('malformed-requests')
    const titleMatch = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Fallback Roadmap',
      brief: 'Create artifact',
    })
    const requestOnly = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Request Only',
      brief: 'special sidecar token',
    })
    await replaceFileWithDirectory(join(workspace, 'artifacts', titleMatch.artifactId, 'manifest.requests.jsonl'))
    await replaceFileWithDirectory(join(workspace, 'artifacts', requestOnly.artifactId, 'manifest.requests.jsonl'))
    const agents = [agentFixture('builder-agent', workspace, { specialRole: 'artifact-builder' })]

    await expect(listArtifactIndex({ agents, query: 'roadmap' })).resolves.toMatchObject([
      { artifactId: titleMatch.artifactId },
    ])
    await expect(listArtifactIndex({ agents, query: 'special sidecar token' })).resolves.toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      `Ignoring request history for artifact ${titleMatch.artifactId}: failed to read requests sidecar`,
      expect.any(Error)
    )
  })

  it('returns composite identity and manifest fields for each result', async () => {
    const workspace = await createWorkspace('shape')
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath: workspace,
      title: 'Published artifact',
      brief: 'Create publishable artifact',
    })
    const entry = { type: 'markdown' as const, path: 'report.md' }
    const manifest = await mutateArtifactManifest({
      agentWorkspacePath: workspace,
      artifactId: created.artifactId,
      mutate: (current): ArtifactManifest => ({
        ...current,
        status: 'ready',
        summary: 'Ready to read',
        entry,
      }),
    })

    const [result] = await listArtifactIndex({
      agents: [agentFixture('builder-agent', workspace, { specialRole: 'artifact-builder' })],
    })

    expect(result).toEqual({
      agentId: 'builder-agent',
      artifactId: created.artifactId,
      title: 'Published artifact',
      summary: 'Ready to read',
      status: 'ready',
      entry,
      updatedAt: manifest.updatedAt,
    })
  })

  async function createWorkspace(name: string): Promise<string> {
    const workspace = join(rootPath, name)
    await mkdir(workspace, { recursive: true })
    return workspace
  }

  async function replaceFileWithDirectory(path: string): Promise<void> {
    await unlink(path)
    await mkdir(path)
  }
})

function agentFixture(
  id: string,
  workspacePath: string,
  metadata?: Record<string, unknown>,
  agentTypeId = ARTIFACT_BUILDER_AGENT_TYPE_ID
): ArtifactIndexAgent & { workspacePath: string } {
  return {
    id,
    agentTypeId,
    metadata: metadata ?? null,
    workspacePath,
    getSandboxId: () => id,
  }
}
