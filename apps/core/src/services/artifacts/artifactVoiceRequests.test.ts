import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ArtifactManifest } from '@ficus/shared'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { readUtf8RegularFileNoFollowBounded } from './artifactFiles'
import { MAX_ARTIFACT_MARKDOWN_BYTES } from './artifactPublish'
import { createArtifactVoiceRequestService, type ArtifactVoiceRequestServiceDeps } from './artifactVoiceRequests'
import {
  appendArtifactQuestions,
  mutateArtifactManifest,
  readArtifactManifest,
  readArtifactPublishes,
  readArtifactQuestions,
  readArtifactRequests,
} from './artifactWorkspace'

describe('artifact voice request service', () => {
  let workspacePath: string
  let sentMessages: Array<{
    recipientId: string
    subject?: string
    content: string
    metadata?: Record<string, unknown>
  }>
  let agents: Array<{
    id: string
    agentTypeId: string
    metadata: Record<string, unknown>
    workspacePath: string
    context?: Record<string, any>
  }>
  let localListAgentsCalls: number

  function createIsolatedService(overrides: ArtifactVoiceRequestServiceDeps = {}) {
    return createArtifactVoiceRequestService({
      listAgents: async () => {
        localListAgentsCalls += 1
        return agents
      },
      ...overrides,
    })
  }

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'ficus-artifact-voice-'))
    sentMessages = []
    agents = []
    localListAgentsCalls = 0
  })

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  test('create makes an artifact builder agent, creates a manifest, and sends a self-contained inbox request', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })

    const result = await service.requestArtifact({
      action: 'create',
      title: 'Launch Dashboard',
      brief: 'Build a dashboard showing launch blockers and next actions.',
      displayModeHint: 'dashboard',
    })

    expect(agents).toHaveLength(1)
    expect(agents[0].agentTypeId).toBe('artifact-builder-default')
    expect(agents[0].metadata.specialRole).toBe('artifact-builder')
    expect(result.agentId).toBe('agent-1')
    expect(result.artifactId).toBe('launch-dashboard')
    expect(result.manifest!.title).toBe('Launch Dashboard')
    expect(result.manifest!.entry).toEqual({ type: 'presentation', path: 'presentation.json' })
    expect(result.manifest!.status).toBe('working')
    expect(result.manifest!.summary).toBe('Initial skeleton visible while the artifact is being built.')
    const context = await service.getArtifactContext(result.agentId, result.artifactId)
    expect(context.content).toMatchObject({
      schemaVersion: 1,
      title: 'Launch Dashboard',
      sections: expect.arrayContaining([
        expect.objectContaining({ id: 'request', title: 'Request' }),
        expect.objectContaining({ id: 'next', title: 'Coming next' }),
      ]),
    })
    expect(result.manifest).not.toHaveProperty('requests')
    await expect(
      readArtifactRequests({ agentWorkspacePath: workspacePath, artifactId: result.artifactId })
    ).resolves.toMatchObject([
      { action: 'create', brief: 'Build a dashboard showing launch blockers and next actions.', from: 'voice' },
    ])
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].recipientId).toBe('agent-1')
    expect(sentMessages[0].subject).toContain('Launch Dashboard')
    expect(sentMessages[0].content).toContain('Build a dashboard showing launch blockers')
    expect(sentMessages[0].content).toContain('A starter skeleton is already visible')
    expect(sentMessages[0].content).toContain('Publish an initial valid version quickly')
    expect(sentMessages[0].content).toContain('Use placeholders or loading states')
    expect(sentMessages[0].content).toContain('Do not add progress-update sentences')
    expect(sentMessages[0].content).not.toContain('Read manifest.json for context')
    expect(sentMessages[0].content).not.toContain('do not read manifest.json')
    expect(sentMessages[0].content).toContain('Path: artifacts/launch-dashboard')
    expect(sentMessages[0].content).not.toContain(workspacePath)
    expect(sentMessages[0].metadata).toMatchObject({
      artifactId: 'launch-dashboard',
      action: 'create',
      artifactPath: 'artifacts/launch-dashboard',
    })
  })

  test('lists, reads, and exact-edits files inside an artifact workspace', async () => {
    const updatedEvents: unknown[] = []
    const unsubscribe = eventEmitter.on('agent.updated', (event) => updatedEvents.push(event))
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    try {
      const created = await service.requestArtifact({ action: 'create', title: 'Launch Dashboard', brief: 'Initial' })
      await writeFile(join(workspacePath, 'artifacts', created.artifactId, 'notes.md'), 'line 1\nline 2\nline 3\n')

      const listed = await service.listArtifactFiles('agent-1', created.artifactId)
      expect(listed.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'presentation.json', type: 'file' }),
          expect.objectContaining({ path: 'notes.md', type: 'file' }),
        ])
      )
      expect(listed.files.map((file) => file.path)).not.toContain('manifest.json')

      await expect(
        service.readArtifactFile({
          agentId: 'agent-1',
          artifactId: created.artifactId,
          path: 'notes.md',
          offset: 2,
          limit: 1,
        })
      ).resolves.toMatchObject({
        content: 'line 2',
        offset: 2,
        limit: 1,
        totalLines: 3,
        truncated: true,
        nextOffset: 3,
      })

      await expect(
        service.editArtifactFile({
          agentId: 'agent-1',
          artifactId: created.artifactId,
          path: 'presentation.json',
          edits: [
            { oldText: 'Launch Dashboard', newText: 'Launch Plan' },
            { oldText: 'Coming next', newText: 'Next steps' },
          ],
          changeSummary: 'Rename launch dashboard labels.',
        })
      ).resolves.toMatchObject({
        ok: true,
        changed: true,
        editsApplied: 2,
        manifest: { title: 'Launch Dashboard', status: 'ready' },
      })

      const updated = await service.readArtifactFile({
        agentId: 'agent-1',
        artifactId: created.artifactId,
        path: 'presentation.json',
        limit: 20,
      })
      expect(updated.content).toContain('Launch Plan')
      expect(updated.content).toContain('Next steps')
      expect(updatedEvents.length).toBeGreaterThan(0)

      await expect(
        service.editArtifactFile({
          agentId: 'agent-1',
          artifactId: created.artifactId,
          path: 'presentation.json',
          edits: [
            { oldText: 'Launch Plan', newText: 'Launch Roadmap' },
            { oldText: 'title', newText: 'heading' },
          ],
          changeSummary: 'Attempt ambiguous title rename.',
        })
      ).rejects.toThrow('edit[1] matched more than one location')
    } finally {
      unsubscribe()
    }
  })

  test('prewarms in the background and claims an artifact builder for create requests', async () => {
    const ensureCalls: string[] = []
    let warmResolved = false
    let resolveWarm: (() => void) | undefined
    const warmPromise = new Promise<void>((resolve) => {
      resolveWarm = () => {
        warmResolved = true
        resolve()
      }
    })
    const service = createIsolatedService({
      createAgent: async (input) => {
        const id = `agent-${agents.length + 1}`
        const sandboxId = `agent_${input.agentTypeId}_${id}`
        const agent = {
          id,
          agentTypeId: input.agentTypeId,
          metadata: input.metadata ?? {},
          context: input.context ?? {},
          workspacePath,
          getSandboxId: () => sandboxId,
          getAgentWorkspaceSandboxId: () => sandboxId,
          update: async (updates: any) => Object.assign(agent, { context: updates.context ?? agent.context }),
        } as any
        agents.push(agent)
        return agent
      },
      listAgents: async () => agents as any,
      getAgentWorkspacePath: async (agent) => {
        ensureCalls.push(agent.id)
        if (ensureCalls.length === 1) await warmPromise
        return workspacePath
      },
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })

    const prewarm = await service.prewarmArtifactBuilder()
    expect(prewarm).toMatchObject({ agentId: 'agent-1', reused: false })
    expect(ensureCalls).toEqual(['agent-1'])
    expect(warmResolved).toBe(false)
    resolveWarm?.()

    const created = await service.requestArtifact({
      action: 'create',
      title: 'Warm Artifact',
      brief: 'Use warm builder',
    })

    expect(created.agentId).toBe('agent-1')
    expect(agents).toHaveLength(1)
    expect(agents[0].context?.artifactBuilderPrewarm.claimedAt).toBeTruthy()
  })

  test('ask sends an informational prompt to the artifact agent without changing artifact status', async () => {
    const updatedEvents: unknown[] = []
    const unsubscribe = eventEmitter.on('agent.updated', (event) => updatedEvents.push(event))
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    try {
      const created = await service.requestArtifact({ action: 'create', title: 'Launch Dashboard', brief: 'Initial' })
      await mutateArtifactManifest({
        agentWorkspacePath: workspacePath,
        artifactId: created.artifactId,
        mutate: (manifest) => ({ ...manifest, status: 'ready', summary: 'Ready dashboard.' }),
      })
      sentMessages = []
      updatedEvents.length = 0

      const result = await service.requestArtifact({
        action: 'ask',
        agentId: 'agent-1',
        artifactId: created.artifactId,
        brief: 'Explain how the launch risk score is calculated.',
      })

      expect(result.action).toBe('ask')
      expect(result.manifest!.status).toBe('ready')
      await expect(
        readArtifactRequests({ agentWorkspacePath: workspacePath, artifactId: result.artifactId })
      ).resolves.toHaveLength(1)
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].recipientId).toBe('agent-1')
      expect(sentMessages[0].subject).toBe('Question about artifact: Launch Dashboard')
      expect(sentMessages[0].content).toContain('Informational artifact question')
      expect(sentMessages[0].content).toContain('Explain how the launch risk score is calculated.')
      expect(sentMessages[0].content).toContain(
        'Reply to the workspace voice assistant through inbox: ficus inbox send workspace "<message>" --recipient-type voice_assistant.'
      )
      expect(sentMessages[0].content).toContain('do not edit artifact files')
      expect(sentMessages[0].metadata).toMatchObject({
        kind: 'artifact-info-request',
        action: 'ask',
        artifactId: created.artifactId,
      })
      expect(updatedEvents).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  test('continue appends request history and wakes the owning artifact agent', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const created = await service.requestArtifact({
      action: 'create',
      title: 'Launch Dashboard',
      brief: 'Initial brief',
    })
    sentMessages = []

    const continued = await service.requestArtifact({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: created.artifactId,
      brief: 'Add a risk summary section.',
    })

    const continuedRequests = await readArtifactRequests({
      agentWorkspacePath: workspacePath,
      artifactId: continued.artifactId,
    })
    expect(continued.manifest).not.toHaveProperty('requests')
    expect(continuedRequests.map((request) => request.action)).toEqual(['create', 'continue'])
    expect(continuedRequests[1].brief).toBe('Add a risk summary section.')
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].recipientId).toBe('agent-1')
    expect(sentMessages[0].content).toContain('Add a risk summary section.')
    expect(sentMessages[0].content).toContain('Path: artifacts/launch-dashboard')
    expect(sentMessages[0].content).toContain('You already have the artifact context in this chat')
    expect(sentMessages[0].content).not.toContain('reread manifest.json')
    expect(sentMessages[0].content).toContain('Publish an incremental update as soon as the changed content is valid')
    expect(sentMessages[0].content).not.toContain(workspacePath)
    expect(sentMessages[0].content).not.toContain(JSON.stringify(continued.manifest))
  })

  test('continue marks a previously ready artifact as working until the builder publishes again', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Launch Dashboard', brief: 'Initial' })
    await mutateArtifactManifest({
      agentWorkspacePath: workspacePath,
      artifactId: created.artifactId,
      mutate: (manifest) => ({ ...manifest, status: 'ready', summary: 'Initial dashboard is ready.' }),
    })

    const continued = await service.requestArtifact({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: created.artifactId,
      brief: 'Add a risk summary section.',
    })

    expect(continued.manifest!.status).toBe('working')
    expect(continued.manifest!.summary).toBe('Initial dashboard is ready.')
  })

  test('continue with answers updates separate question responses and sends one inbox message', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Launch Dashboard', brief: 'Initial' })
    await appendArtifactQuestions({
      agentWorkspacePath: workspacePath,
      artifactId: created.artifactId,
      questions: [
        { question: 'Theme?', responseMode: 'single_select', choices: ['Light', 'Dark'] },
        { question: 'Metrics?', responseMode: 'free_text' },
      ],
    })
    sentMessages = []

    const continued = await service.requestArtifact({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: created.artifactId,
      brief: 'Use these answers.',
      answers: [
        { questionId: 'q_1', answer: 'Dark' },
        { questionId: 'q_2', answer: 'Revenue and retention' },
      ],
    })

    expect(continued.manifest).not.toHaveProperty('questions')
    await expect(
      readArtifactQuestions({ agentWorkspacePath: workspacePath, artifactId: continued.artifactId })
    ).resolves.toMatchObject([
      { id: 'q_1', status: 'answered', response: { from: 'voice', answer: 'Dark', brief: 'Use these answers.' } },
      {
        id: 'q_2',
        status: 'answered',
        response: { from: 'voice', answer: 'Revenue and retention', brief: 'Use these answers.' },
      },
    ])
    await expect(
      readArtifactRequests({ agentWorkspacePath: workspacePath, artifactId: continued.artifactId })
    ).resolves.toMatchObject([{ brief: 'Initial' }, { brief: 'Use these answers.' }])
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].content).toContain('Use these answers.')
    expect(sentMessages[0].content).toContain('Answered questions:')
    expect(sentMessages[0].content).toContain('- q_1: Dark')
    expect(sentMessages[0].content).toContain('- q_2: Revenue and retention')
  })

  test('continue with answers can correct an already answered question', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Launch Dashboard', brief: 'Initial' })
    await appendArtifactQuestions({
      agentWorkspacePath: workspacePath,
      artifactId: created.artifactId,
      questions: [{ question: 'Theme?', responseMode: 'single_select', choices: ['Light', 'Dark'] }],
    })
    await service.requestArtifact({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: created.artifactId,
      brief: 'Use first answer.',
      answers: [{ questionId: 'q_1', answer: 'Light' }],
    })
    sentMessages = []

    const corrected = await service.requestArtifact({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: created.artifactId,
      brief: 'Correct the answer.',
      answers: [{ questionId: 'q_1', answer: 'Dark' }],
    })

    const correctedQuestions = await readArtifactQuestions({
      agentWorkspacePath: workspacePath,
      artifactId: corrected.artifactId,
    })
    expect(corrected.manifest).not.toHaveProperty('questions')
    expect(correctedQuestions[0]).toMatchObject({
      id: 'q_1',
      status: 'answered',
      response: { from: 'voice', answer: 'Dark', brief: 'Correct the answer.' },
    })
    await expect(
      readArtifactRequests({ agentWorkspacePath: workspacePath, artifactId: corrected.artifactId })
    ).resolves.toMatchObject([{ brief: 'Initial' }, { brief: 'Use first answer.' }, { brief: 'Correct the answer.' }])
    expect(sentMessages).toHaveLength(1)
  })

  test('continue with invalid answer question id rejects before sending inbox', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Launch Dashboard', brief: 'Initial' })
    const withQuestions = await appendArtifactQuestions({
      agentWorkspacePath: workspacePath,
      artifactId: created.artifactId,
      questions: [{ question: 'Theme?', responseMode: 'free_text' }],
    })
    sentMessages = []

    await expect(
      service.requestArtifact({
        action: 'continue',
        agentId: 'agent-1',
        artifactId: created.artifactId,
        brief: 'Use answers.',
        answers: [{ questionId: 'q_missing', answer: 'Dark' }],
      })
    ).rejects.toThrow('Artifact question not found: q_missing')

    expect(sentMessages).toHaveLength(0)
    await expect(service.getArtifactContext('agent-1', created.artifactId)).resolves.toMatchObject({
      manifest: withQuestions.manifest,
    })
  })

  test('rejects answers for non-continue actions before creating or notifying', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })

    await expect(
      service.requestArtifact({
        action: 'create',
        title: 'Launch Dashboard',
        brief: 'Initial',
        answers: [{ questionId: 'q_1', answer: 'Dark' }],
      })
    ).rejects.toThrow('answers are only supported for continue artifact requests')

    expect(agents).toHaveLength(0)
    expect(sentMessages).toHaveLength(0)
  })

  test('rejects malformed structured answers before mutating or notifying', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Launch Dashboard', brief: 'Initial' })
    sentMessages = []

    await expect(
      service.requestArtifact({
        action: 'continue',
        agentId: 'agent-1',
        artifactId: created.artifactId,
        brief: 'Use answers.',
        answers: [{ questionId: 123, answer: 'Dark' } as any],
      })
    ).rejects.toThrow('answers must include non-empty questionId and answer')

    expect(sentMessages).toHaveLength(0)
    const context = await service.getArtifactContext('agent-1', created.artifactId)
    expect(context.manifest).not.toHaveProperty('requests')
    expect(context.history).toMatchObject({
      requests: [{ at: expect.any(String), from: 'voice', action: 'create', brief: 'Initial' }],
      questions: [],
      publishes: expect.any(Array),
    })
  })

  test('continue without answers still appends normal request and does not alter questions', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Launch Dashboard', brief: 'Initial' })
    await appendArtifactQuestions({
      agentWorkspacePath: workspacePath,
      artifactId: created.artifactId,
      questions: [{ question: 'Theme?', responseMode: 'free_text' }],
    })
    const questionsBeforeContinue = await readArtifactQuestions({
      agentWorkspacePath: workspacePath,
      artifactId: created.artifactId,
    })
    sentMessages = []

    const continued = await service.requestArtifact({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: created.artifactId,
      brief: 'Add a risk summary section.',
    })

    await expect(
      readArtifactRequests({ agentWorkspacePath: workspacePath, artifactId: continued.artifactId })
    ).resolves.toMatchObject([{ brief: 'Initial' }, { brief: 'Add a risk summary section.' }])
    await expect(
      readArtifactQuestions({ agentWorkspacePath: workspacePath, artifactId: continued.artifactId })
    ).resolves.toEqual(questionsBeforeContinue)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0].content).not.toContain('Answered questions:')
  })

  test('continue returns the updated manifest once when inbox delivery fails', async () => {
    const originalConsoleError = console.error
    console.error = mock(() => {}) as typeof console.error
    let shouldFailInboxDelivery = false
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
        if (shouldFailInboxDelivery) throw new Error('inbox unavailable')
      },
    })
    try {
      const created = await service.requestArtifact({
        action: 'create',
        title: 'Launch Dashboard',
        brief: 'Initial brief',
      })
      sentMessages = []
      shouldFailInboxDelivery = true

      const continued = await service.requestArtifact({
        action: 'continue',
        agentId: 'agent-1',
        artifactId: created.artifactId,
        brief: 'Add a risk summary section.',
      })

      expect(continued).toMatchObject({
        action: 'continue',
        agentId: 'agent-1',
        artifactId: created.artifactId,
        inboxDeliveryFailed: true,
        message:
          'Artifact request was recorded, but agent notification failed. Do not retry the full request; check artifact status/context or ask to notify/wake the builder separately.',
      })
      await expect(
        readArtifactRequests({ agentWorkspacePath: workspacePath, artifactId: continued.artifactId })
      ).resolves.toMatchObject([{ brief: 'Initial brief' }, { brief: 'Add a risk summary section.' }])
      const context = await service.getArtifactContext('agent-1', created.artifactId)
      expect(context.manifest).not.toHaveProperty('requests')
      expect(context.history.requests).toMatchObject([
        { action: 'create', brief: 'Initial brief' },
        { action: 'continue', brief: 'Add a risk summary section.' },
      ])
      expect(sentMessages).toHaveLength(1)
    } finally {
      console.error = originalConsoleError
    }
  })

  test('direct file APIs hide and reject artifact metadata files', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async () => {},
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Files', brief: 'Initial' })
    await writeFile(join(created.artifactPath!, 'notes.md'), 'Visible notes')
    await writeFile(join(created.artifactPath!, 'manifest-v2.jsonl'), 'hidden')
    await mkdir(join(created.artifactPath!, 'nested'))
    await writeFile(join(created.artifactPath!, 'nested', 'manifest_requests.jsonl'), 'hidden')

    const files = await service.listArtifactFiles('agent-1', created.artifactId)
    expect(files.files.map((file) => file.path).sort()).toEqual(['nested', 'notes.md', 'presentation.json'])

    for (const path of [
      'manifest.json',
      'manifest.requests.jsonl',
      'manifest.questions.jsonl',
      'manifest.publishes.jsonl',
      'manifest-v2.jsonl',
      'nested/manifest_requests.jsonl',
    ]) {
      await expect(
        service.readArtifactFile({ agentId: 'agent-1', artifactId: created.artifactId, path })
      ).rejects.toThrow('Artifact metadata files cannot be accessed directly')
      await expect(
        service.editArtifactFile({
          agentId: 'agent-1',
          artifactId: created.artifactId,
          path,
          oldText: 'Visible',
          newText: 'Hidden',
          changeSummary: 'Tamper metadata.',
        })
      ).rejects.toThrow('Artifact metadata files cannot be accessed directly')
    }

    await service.editArtifactFile({
      agentId: 'agent-1',
      artifactId: created.artifactId,
      path: 'notes.md',
      oldText: 'Visible',
      newText: 'Updated',
      changeSummary: 'Update visible notes.',
    })
    await expect(readFile(join(created.artifactPath!, 'notes.md'), 'utf8')).resolves.toBe('Updated notes')
  })

  test('direct edit of published entry republishes manifest, publish history, and emits update', async () => {
    const updatedEvents: unknown[] = []
    const unsubscribe = eventEmitter.on('agent.updated', (event) => updatedEvents.push(event))
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async () => {},
    })

    try {
      const created = await service.requestArtifact({ action: 'create', title: 'Files', brief: 'Initial' })
      const before = await readArtifactManifest({ agentWorkspacePath: workspacePath, artifactId: created.artifactId })
      updatedEvents.length = 0
      await Bun.sleep(2)

      const nextPresentation = JSON.stringify({
        schemaVersion: 1,
        title: 'Files',
        sections: [{ id: 'updated', title: 'Updated', blocks: [{ type: 'callout', content: 'New content' }] }],
      })
      await service.editArtifactFile({
        agentId: 'agent-1',
        artifactId: created.artifactId,
        path: 'presentation.json',
        oldText: await readFile(join(created.artifactPath!, 'presentation.json'), 'utf8'),
        newText: nextPresentation,
        changeSummary: 'Update presentation directly.',
      })

      const after = await readArtifactManifest({ agentWorkspacePath: workspacePath, artifactId: created.artifactId })
      expect(after!.updatedAt > before!.updatedAt).toBe(true)
      await expect(
        readArtifactPublishes({ agentWorkspacePath: workspacePath, artifactId: created.artifactId })
      ).resolves.toHaveLength(2)
      expect(updatedEvents).toEqual([{ agentId: 'agent-1', squadId: null }])
    } finally {
      unsubscribe()
    }
  })

  test('bounded content reader rejects files larger than the byte limit', async () => {
    const contentPath = join(workspacePath, 'oversized.md')
    await writeFile(contentPath, 'x'.repeat(12))

    await expect(readUtf8RegularFileNoFollowBounded(contentPath, 11)).rejects.toThrow('file size exceeds 11 bytes')
  })

  test('bounded content reader rejects non-regular files before reading', async () => {
    const contentPath = join(workspacePath, 'directory-entry')
    await mkdir(contentPath)

    await expect(readUtf8RegularFileNoFollowBounded(contentPath, 1024)).rejects.toThrow('not a regular file')
  })

  test('bounded content reader rejects symlinks instead of following them', async () => {
    const outsidePath = join(workspacePath, '..', 'outside-secret.md')
    const contentPath = join(workspacePath, 'linked-secret.md')

    try {
      await writeFile(outsidePath, 'secret outside workspace')
      await symlink(outsidePath, contentPath)

      await expect(readUtf8RegularFileNoFollowBounded(contentPath, 1024)).rejects.toThrow()
    } finally {
      await rm(outsidePath, { force: true })
    }
  })

  test('context skips symlinked published content instead of reading outside the artifact', async () => {
    const originalWarn = console.warn
    console.warn = mock(() => {}) as typeof console.warn
    const outsidePath = join(workspacePath, '..', 'outside-report.md')
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async () => {},
    })

    try {
      const created = await service.requestArtifact({ action: 'create', title: 'Linked Report', brief: 'Initial' })
      await writeFile(outsidePath, 'secret outside workspace')
      await symlink(outsidePath, join(created.artifactPath!, 'report.md'))
      await mutateArtifactManifest({
        agentWorkspacePath: workspacePath,
        artifactId: created.artifactId,
        mutate: (manifest) => ({
          ...manifest,
          status: 'ready',
          entry: { type: 'markdown', path: 'report.md' },
          updatedAt: new Date().toISOString(),
        }),
      })

      const context = await service.getArtifactContext('agent-1', created.artifactId)
      expect(context.manifest.entry).toEqual({ type: 'markdown', path: 'report.md' })
      expect(context.content).toBeUndefined()
    } finally {
      console.warn = originalWarn
      await rm(outsidePath, { force: true })
    }
  })

  test('context skips published content that grew past the artifact size limit after publish', async () => {
    const originalWarn = console.warn
    console.warn = mock(() => {}) as typeof console.warn
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async () => {},
    })

    try {
      const created = await service.requestArtifact({ action: 'create', title: 'Huge Report', brief: 'Initial' })
      await writeFile(join(created.artifactPath!, 'huge.md'), 'x'.repeat(MAX_ARTIFACT_MARKDOWN_BYTES + 1))
      await mutateArtifactManifest({
        agentWorkspacePath: workspacePath,
        artifactId: created.artifactId,
        mutate: (manifest) => ({
          ...manifest,
          status: 'ready',
          entry: { type: 'markdown', path: 'huge.md' },
          updatedAt: new Date().toISOString(),
        }),
      })

      const context = await service.getArtifactContext('agent-1', created.artifactId)
      expect(context.manifest.entry).toEqual({ type: 'markdown', path: 'huge.md' })
      expect(context.content).toBeUndefined()
    } finally {
      console.warn = originalWarn
    }
  })

  test('create, continue, archive, and delete emit agent updates so artifact queries invalidate', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const events: Array<{ agentId: string; squadId?: string | null }> = []
    const unsubscribe = eventEmitter.on('agent.updated', (event) => events.push(event))

    try {
      const created = await service.requestArtifact({ action: 'create', title: 'Spec', brief: 'Initial' })
      expect(events).toEqual([{ agentId: 'agent-1', squadId: null }])
      events.length = 0

      await service.requestArtifact({
        action: 'continue',
        agentId: 'agent-1',
        artifactId: created.artifactId,
        brief: 'Continue it',
      })
      await service.requestArtifact({
        action: 'archive',
        agentId: 'agent-1',
        artifactId: created.artifactId,
        brief: 'Archive it',
      })
      await service.requestArtifact({
        action: 'delete',
        agentId: 'agent-1',
        artifactId: created.artifactId,
        brief: 'Delete it',
      })

      expect(events).toEqual([
        { agentId: 'agent-1', squadId: null },
        { agentId: 'agent-1', squadId: null },
        { agentId: 'agent-1', squadId: null },
      ])
    } finally {
      unsubscribe()
    }
  })

  test('archive and delete mutate artifact state without creating new agents', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => agents,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async (message) => {
        sentMessages.push(message)
      },
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Spec', brief: 'Initial' })

    const archived = await service.requestArtifact({
      action: 'archive',
      agentId: 'agent-1',
      artifactId: created.artifactId,
      brief: 'No longer needed',
    })
    expect(archived.manifest!.archived).toBe(true)

    const deleted = await service.requestArtifact({
      action: 'delete',
      agentId: 'agent-1',
      artifactId: created.artifactId,
      brief: 'Remove it',
    })
    expect(deleted.deleted).toBe(true)
    await expect(service.getArtifactContext('agent-1', created.artifactId)).rejects.toThrow('Artifact not found')
    expect(agents).toHaveLength(1)
  })

  test('delete rejects missing artifacts instead of reporting success', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async () => {},
    })
    await service.requestArtifact({ action: 'create', title: 'Spec', brief: 'Initial' })

    await expect(
      service.requestArtifact({
        action: 'delete',
        agentId: 'agent-1',
        artifactId: 'missing-artifact',
        brief: 'Remove typo',
      })
    ).rejects.toThrow('Artifact not found: missing-artifact')
  })

  test('list and context discover artifacts from artifact builder workspaces only', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = {
          id: `agent-${agents.length + 1}`,
          agentTypeId: input.agentTypeId,
          metadata: input.metadata ?? {},
          workspacePath,
        }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      listAgents: async () => [...agents, { id: 'regular-agent', agentTypeId: 'worker', metadata: {}, workspacePath }],
      getAgentWorkspacePath: async (agent) => agent.workspacePath!,
      sendInboxMessage: async () => {},
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Roadmap', brief: 'Initial' })

    await expect(service.listArtifacts({ query: 'road' })).resolves.toMatchObject([
      { agentId: 'agent-1', artifactId: 'roadmap', title: 'Roadmap', status: 'working' },
    ])
    await expect(service.getArtifactContext(created.agentId, created.artifactId)).resolves.toMatchObject({
      agentId: 'agent-1',
      artifactId: 'roadmap',
      manifest: { title: 'Roadmap' } as Partial<ArtifactManifest>,
    })
  })

  test('context includes published artifact content for the web renderer', async () => {
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async () => {},
    })
    const created = await service.requestArtifact({ action: 'create', title: 'Report', brief: 'Initial' })
    await writeFile(join(created.artifactPath!, 'report.md'), '# Report\n\nReady.')
    await mutateArtifactManifest({
      agentWorkspacePath: workspacePath,
      artifactId: created.artifactId,
      mutate: (manifest) => ({
        ...manifest,
        status: 'ready',
        entry: { type: 'markdown', path: 'report.md' },
        updatedAt: new Date().toISOString(),
      }),
    })

    await expect(service.getArtifactContext('agent-1', created.artifactId)).resolves.toMatchObject({
      manifest: { entry: { type: 'markdown', path: 'report.md' } } as Partial<ArtifactManifest>,
      content: '# Report\n\nReady.',
    })
  })

  test('context still returns manifest when published content cannot be read', async () => {
    const originalWarn = console.warn
    const warn = mock((..._data: Parameters<typeof console.warn>) => {})
    console.warn = warn
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async () => {},
    })

    try {
      const created = await service.requestArtifact({ action: 'create', title: 'Missing Report', brief: 'Initial' })
      expect(localListAgentsCalls).toBe(1)
      await mutateArtifactManifest({
        agentWorkspacePath: workspacePath,
        artifactId: created.artifactId,
        mutate: (manifest) => ({
          ...manifest,
          status: 'ready',
          entry: { type: 'markdown', path: 'missing.md' },
          updatedAt: new Date().toISOString(),
        }),
      })

      const context = await service.getArtifactContext('agent-1', created.artifactId)
      expect(context.manifest.entry).toEqual({ type: 'markdown', path: 'missing.md' })
      expect(context.content).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toBe(`Could not read artifact content for ${created.artifactId}`)
    } finally {
      console.warn = originalWarn
    }
  })

  test('rejects specially-tagged agents with the wrong agent type', async () => {
    agents.push({
      id: 'regular-agent',
      agentTypeId: 'worker',
      metadata: { specialRole: 'artifact-builder' },
      workspacePath,
    })
    const service = createIsolatedService({
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      getAgentWorkspacePath: async () => workspacePath,
    })

    await expect(service.getArtifactContext('regular-agent', 'artifact-1')).rejects.toThrow(
      'Agent is not an artifact builder'
    )
  })

  test('create returns the created placeholder when inbox delivery fails', async () => {
    const originalConsoleError = console.error
    console.error = mock(() => {}) as typeof console.error
    const service = createIsolatedService({
      createAgent: async (input) => {
        const agent = { id: 'agent-1', agentTypeId: input.agentTypeId, metadata: input.metadata ?? {}, workspacePath }
        agents.push(agent)
        return agent
      },
      findAgent: async (id) => agents.find((agent) => agent.id === id) ?? null,
      getAgentWorkspacePath: async () => workspacePath,
      sendInboxMessage: async () => {
        throw new Error('inbox unavailable')
      },
    })

    const result = await service.requestArtifact({
      action: 'create',
      title: 'Delivery Failure',
      brief: 'Create an artifact even if the wake-up message fails.',
    })

    expect(result).toMatchObject({
      action: 'create',
      agentId: 'agent-1',
      artifactId: 'delivery-failure',
      inboxDeliveryFailed: true,
      message:
        'Artifact was created and recorded, but agent notification failed. Do not retry the full request; check the artifacts list/status or ask to notify/wake the builder separately.',
    })
    await expect(service.getArtifactContext('agent-1', 'delivery-failure')).resolves.toMatchObject({
      manifest: { title: 'Delivery Failure' } as Partial<ArtifactManifest>,
    })
    console.error = originalConsoleError
  })

  test('fork returns not implemented', async () => {
    const service = createIsolatedService()

    await expect(
      service.requestArtifact({ action: 'fork', agentId: 'agent-1', artifactId: 'artifact-1', brief: 'Fork it' })
    ).rejects.toThrow('Forking artifacts is not implemented')
  })
})
