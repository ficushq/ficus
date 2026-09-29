import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { InboxMessage } from '../entities/InboxMessage'
import * as agentHumanRecipient from '../services/inbox/agent-human-recipient'
import { eventEmitter } from '../lib/infra/event-emitter'
import {
  createArtifactInAgentWorkspace,
  readArtifactManifest,
  readArtifactPublishes,
  readArtifactQuestions,
} from '../services/artifacts/artifactWorkspace'
import { createArtifactTools } from './artifacts'

const TEST_AGENT_ID = '00000000-0000-4000-8000-000000000201'
const TEST_SQUAD_ID = '00000000-0000-4000-8000-000000000202'

describe('artifact builder tools', () => {
  let agentWorkspacePath: string
  let eventUnsubscribers: Array<() => void>
  let inboxSendSpy: Mock<typeof InboxMessage.send> | undefined
  let recipientSpy: Mock<typeof agentHumanRecipient.resolveAgentRequestingUserId> | undefined

  // The artifact builder addresses the human who requested the artifact. Stub the resolver so the
  // question tests deterministically target a known user id.
  const TEST_REQUESTING_USER_ID = '00000000-0000-4000-8000-0000000009f1'

  beforeEach(async () => {
    agentWorkspacePath = await mkdtemp(join(tmpdir(), 'ficus-artifact-tools-'))
    eventUnsubscribers = []
    recipientSpy = spyOn(agentHumanRecipient, 'resolveAgentRequestingUserId').mockResolvedValue(TEST_REQUESTING_USER_ID)
  })

  afterEach(async () => {
    inboxSendSpy?.mockRestore()
    inboxSendSpy = undefined
    recipientSpy?.mockRestore()
    recipientSpy = undefined
    for (const unsubscribe of eventUnsubscribers) {
      unsubscribe()
    }
    await rm(agentWorkspacePath, { recursive: true, force: true })
  })

  it('publishes a valid markdown artifact and emits an agent update event', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Quarterly report',
      brief: 'Create the quarterly report',
    })
    await writeFile(join(created.artifactPath, 'report.md'), '# Report\n\nReady.')

    const events: Array<{ event: string; data: unknown }> = []
    eventUnsubscribers.push(eventEmitter.onAny((event, data) => events.push({ event, data })))

    const publishTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: TEST_SQUAD_ID,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_publish')!

    const result = await publishTool.execute(
      'tool-1',
      {
        artifactId: created.artifactId,
        entry: { type: 'markdown', path: 'report.md' },
        title: '  Updated quarterly report  ',
        summary: '  A concise report.  ',
        status: 'ready',
        changeSummary: 'Published the updated quarterly report.',
      },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({ success: true, artifactId: created.artifactId })
    expect(result.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('Published artifact'),
    })
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject({
      title: 'Updated quarterly report',
      summary: 'A concise report.',
      status: 'ready',
      entry: { type: 'markdown', path: 'report.md' },
    })
    await expect(readArtifactPublishes({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual([
      expect.objectContaining({ changeSummary: 'Published the updated quarterly report.' }),
    ])
    expect(events).toContainEqual({ event: 'agent.updated', data: { agentId: TEST_AGENT_ID, squadId: TEST_SQUAD_ID } })
    expect(events).toContainEqual({
      event: 'artifact.updated',
      data: expect.objectContaining({
        agentId: TEST_AGENT_ID,
        squadId: TEST_SQUAD_ID,
        artifactId: created.artifactId,
        title: 'Updated quarterly report',
        summary: 'A concise report.',
        status: 'ready',
      }),
    })
  })

  it('updates artifact status and summary without changing the entry', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Status report',
      brief: 'Create the status report',
    })
    await writeFile(join(created.artifactPath, 'report.md'), '# Report\n\nDraft.')

    const [publishTool, statusTool] = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: TEST_SQUAD_ID,
      agentWorkspacePath,
    })

    await publishTool.execute(
      'tool-1',
      {
        artifactId: created.artifactId,
        entry: { type: 'markdown', path: 'report.md' },
        status: 'working',
        changeSummary: 'Published initial draft report.',
      },
      undefined,
      undefined,
      {} as any
    )

    const result = await statusTool.execute(
      'tool-2',
      { artifactId: created.artifactId, status: 'error', summary: '  Needs more source data.  ' },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({ success: true, artifactId: created.artifactId })
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject({
      status: 'error',
      summary: 'Needs more source data.',
      entry: { type: 'markdown', path: 'report.md' },
    })
  })

  it('includes the structured artifact question tool', () => {
    const tools = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: null,
      agentWorkspacePath,
    })

    expect(tools.some((tool) => tool.name === 'artifact_question')).toBe(true)
  })

  it('appends one free-text artifact question and sends one human inbox message', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Question artifact',
      brief: 'Create artifact after answers',
    })
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({ id: 'message-1' } as any)
    const questionTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: TEST_SQUAD_ID,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_question')!

    const result = await questionTool.execute(
      'tool-1',
      {
        artifactId: created.artifactId,
        questions: [
          {
            title: '  Dataset  ',
            question: '  Which dataset should I use?  ',
            context: '  Needed for the chart.  ',
            responseMode: 'free_text',
            priority: 'high',
          },
        ],
      },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({
      success: true,
      artifactId: created.artifactId,
      questionIds: ['q_1'],
      messageId: 'message-1',
    })
    await expect(
      readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })
    ).resolves.not.toHaveProperty('questions')
    await expect(readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      {
        id: 'q_1',
        title: 'Dataset',
        question: 'Which dataset should I use?',
        context: 'Needed for the chart.',
        responseMode: 'free_text',
        priority: 'high',
        status: 'open',
      },
    ])
    expect(inboxSendSpy).toHaveBeenCalledTimes(1)
    expect(inboxSendSpy).toHaveBeenCalledWith({
      recipientType: 'user',
      recipientId: TEST_REQUESTING_USER_ID,
      senderType: 'agent',
      senderId: TEST_AGENT_ID,
      subject: 'Question for artifact Question artifact',
      content: expect.stringContaining('Which dataset should I use?'),
      metadata: {
        requestType: 'artifact_question',
        artifactId: created.artifactId,
        agentId: TEST_AGENT_ID,
        questions: [
          {
            id: 'q_1',
            title: 'Dataset',
            question: 'Which dataset should I use?',
            context: 'Needed for the chart.',
            responseMode: 'free_text',
            priority: 'high',
          },
        ],
      },
    })
  })

  it('appends a batch of artifact questions and sends one inbox message with question metadata', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Batch artifact',
      brief: 'Create artifact after answers',
    })
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({ id: 'message-1' } as any)
    const questionTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: TEST_SQUAD_ID,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_question')!

    const result = await questionTool.execute(
      'tool-1',
      {
        artifactId: created.artifactId,
        questions: [
          { question: 'Pick a theme?', responseMode: 'single_select', choices: [' Light ', ' Dark '] },
          {
            question: 'Pick metrics?',
            responseMode: 'multi_select',
            choices: ['Revenue', 'Users'],
            priority: 'normal',
          },
        ],
      },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({
      success: true,
      artifactId: created.artifactId,
      questionIds: ['q_1', 'q_2'],
      messageId: 'message-1',
    })
    expect(inboxSendSpy).toHaveBeenCalledTimes(1)
    expect(inboxSendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          requestType: 'artifact_question',
          artifactId: created.artifactId,
          agentId: TEST_AGENT_ID,
          questions: [
            {
              id: 'q_1',
              question: 'Pick a theme?',
              responseMode: 'single_select',
              choices: ['Light', 'Dark'],
            },
            {
              id: 'q_2',
              question: 'Pick metrics?',
              responseMode: 'multi_select',
              choices: ['Revenue', 'Users'],
              priority: 'normal',
            },
          ],
        },
      })
    )
  })

  it('rejects select artifact questions without at least two choices and does not send inbox messages', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Invalid choices',
      brief: 'Create artifact after answers',
    })
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({ id: 'message-1' } as any)
    const questionTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: null,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_question')!

    const result = await questionTool.execute(
      'tool-1',
      {
        artifactId: created.artifactId,
        questions: [
          { question: 'Pick one?', responseMode: 'single_select', choices: ['Only one'] },
          { question: 'Pick many?', responseMode: 'multi_select', choices: ['One', '   '] },
        ],
      },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({
      success: false,
      artifactId: created.artifactId,
      errors: expect.arrayContaining([
        'questions[0].choices must include at least two non-empty choices for single_select',
        'questions[1].choices must include at least two non-empty choices for multi_select',
      ]),
    })
    await expect(readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual([])
    expect(inboxSendSpy).not.toHaveBeenCalled()
  })

  it('returns structured validation errors for malformed artifact question calls', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Malformed question input',
      brief: 'Create artifact after answers',
    })
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({ id: 'message-1' } as any)
    const questionTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: null,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_question')!

    const result = await questionTool.execute(
      'tool-1',
      { artifactId: created.artifactId, questions: 'not-an-array' } as any,
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({
      success: false,
      artifactId: created.artifactId,
      errors: ['questions must be an array'],
    })

    const nullResult = await questionTool.execute('tool-2', null as any, undefined, undefined, {} as any)

    expect(nullResult.details).toMatchObject({
      success: false,
      errors: ['params must be an object'],
    })
    await expect(readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual([])
    expect(inboxSendSpy).not.toHaveBeenCalled()
  })

  it('limits artifact question batch and choice sizes', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Too many questions',
      brief: 'Create artifact after answers',
    })
    const questionTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: null,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_question')!

    const result = await questionTool.execute(
      'tool-1',
      {
        artifactId: created.artifactId,
        questions: Array.from({ length: 11 }, () => ({ question: 'Question?', responseMode: 'free_text' })),
      },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({
      success: false,
      errors: expect.arrayContaining(['questions must include at most 10 questions']),
    })

    const tooManyChoices = await questionTool.execute(
      'tool-2',
      {
        artifactId: created.artifactId,
        questions: [
          {
            question: 'Pick choices?',
            responseMode: 'multi_select',
            choices: Array.from({ length: 21 }, (_, index) => `Choice ${index}`),
          },
        ],
      },
      undefined,
      undefined,
      {} as any
    )

    expect(tooManyChoices.details).toMatchObject({
      success: false,
      errors: expect.arrayContaining(['questions[0].choices must include at most 20 choices']),
    })
    expect((questionTool.parameters as any).properties.questions.maxItems).toBe(10)
    expect((questionTool.parameters as any).properties.questions.items.properties.question.maxLength).toBe(2000)
    expect((questionTool.parameters as any).properties.questions.items.properties.choices.maxItems).toBe(20)
  })

  it('returns partial success when artifact question inbox delivery fails and still emits an update', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Inbox failure',
      brief: 'Create artifact after answers',
    })
    inboxSendSpy = spyOn(InboxMessage, 'send').mockRejectedValue(new Error('inbox unavailable'))
    const events: Array<{ event: string; data: unknown }> = []
    eventUnsubscribers.push(eventEmitter.onAny((event, data) => events.push({ event, data })))
    const questionTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: TEST_SQUAD_ID,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_question')!

    const result = await questionTool.execute(
      'tool-1',
      {
        artifactId: created.artifactId,
        questions: [{ question: 'Which dataset?', responseMode: 'free_text' }],
      },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({
      success: true,
      artifactId: created.artifactId,
      questionIds: ['q_1'],
      inboxDeliveryFailed: true,
      errors: ['inbox unavailable'],
    })
    await expect(
      readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })
    ).resolves.not.toHaveProperty('questions')
    await expect(readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { id: 'q_1', question: 'Which dataset?', status: 'open' },
    ])
    expect(events).toContainEqual({ event: 'agent.updated', data: { agentId: TEST_AGENT_ID, squadId: TEST_SQUAD_ID } })
  })

  it('rejects artifact questions for missing artifacts without sending inbox messages', async () => {
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({ id: 'message-1' } as any)
    const questionTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: null,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_question')!

    const result = await questionTool.execute(
      'tool-1',
      {
        artifactId: 'missing-artifact',
        questions: [{ question: 'What should I use?', responseMode: 'free_text' }],
      },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({
      success: false,
      artifactId: 'missing-artifact',
      errors: ['Artifact manifest not found or invalid: missing-artifact'],
    })
    expect(inboxSendSpy).not.toHaveBeenCalled()
  })

  it('uses non-empty parameter schemas for artifact identifiers and human-visible text', () => {
    const [publishTool, statusTool, questionTool] = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: null,
      agentWorkspacePath,
    })

    expect((publishTool.parameters as any).properties.artifactId).toMatchObject({ minLength: 1 })
    expect((publishTool.parameters as any).properties.entry.properties.path).toMatchObject({ minLength: 1 })
    expect((publishTool.parameters as any).properties.title).toMatchObject({ minLength: 1 })
    expect((publishTool.parameters as any).properties.summary).toMatchObject({ minLength: 1 })
    expect((publishTool.parameters as any).properties.changeSummary).toMatchObject({ minLength: 1 })
    expect((statusTool.parameters as any).properties.artifactId).toMatchObject({ minLength: 1 })
    expect((statusTool.parameters as any).properties.summary).toMatchObject({ minLength: 1 })
    expect((questionTool.parameters as any).properties.artifactId).toMatchObject({ minLength: 1 })
    expect((questionTool.parameters as any).properties.questions.minItems).toBe(1)
  })

  it('returns validation errors without mutating the manifest or emitting an update', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Invalid publish report',
      brief: 'Create an invalid publish report',
    })
    const before = await readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })

    const events: Array<{ event: string; data: unknown }> = []
    eventUnsubscribers.push(eventEmitter.onAny((event, data) => events.push({ event, data })))

    const publishTool = createArtifactTools({
      agentId: TEST_AGENT_ID,
      squadId: null,
      agentWorkspacePath,
    }).find((tool) => tool.name === 'artifact_publish')!

    const result = await publishTool.execute(
      'tool-1',
      {
        artifactId: created.artifactId,
        entry: { type: 'markdown', path: 'missing.md' },
        status: 'ready',
        changeSummary: 'Attempted to publish missing markdown file.',
      },
      undefined,
      undefined,
      {} as any
    )

    expect(result.details).toMatchObject({ success: false, artifactId: created.artifactId })
    expect(result.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('Invalid markdown artifact: file not found'),
    })
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(before)
    expect(events).toEqual([])
  })
})
