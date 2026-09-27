import { beforeEach, describe, expect, test } from 'bun:test'
import { createArtifactTools } from './artifactTools'
import type { ArtifactRequestInput } from '../../api/artifacts'

let editArtifactFileError: Error | null = null

const calls: {
  list: unknown[]
  context: unknown[]
  files: unknown[]
  readFile: unknown[]
  editFile: unknown[]
  request: ArtifactRequestInput[]
} = {
  list: [],
  context: [],
  files: [],
  readFile: [],
  editFile: [],
  request: [],
}

const artifactDependencies = {
  listArtifacts: async (params?: unknown) => {
    calls.list.push(params)
    return [
      { agentId: 'agent-1', artifactId: 'artifact-1', title: 'Roadmap', status: 'ready', updatedAt: '2026-01-01' },
    ]
  },
  getArtifactContext: async (agentId: string, artifactId: string) => {
    calls.context.push({ agentId, artifactId })
    const historyIds = artifactId === 'large-artifact' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [1, 2, 3, 4, 5]
    return {
      agentId,
      artifactId,
      manifest: {
        id: artifactId,
        title: 'Roadmap',
      },
      history: {
        requests: historyIds.map((n) => ({
          at: `request-${n}`,
          from: 'voice',
          action: 'continue',
          brief: `Request ${n}`,
        })),
        questions: historyIds.map((n) => ({
          id: `q_${n}`,
          at: `question-${n}`,
          question: `Question ${n}`,
          responseMode: 'free_text',
          status: 'open',
        })),
        publishes: historyIds.map((n) => ({
          at: `publish-${n}`,
          entry: { type: 'markdown', path: 'document.md' },
          status: 'ready',
          changeSummary: `Publish ${n}`,
        })),
      },
      content: '# Large artifact body that should not be sent to the voice model',
    }
  },
  listArtifactFiles: async (agentId: string, artifactId: string) => {
    calls.files.push({ agentId, artifactId })
    return { files: [{ path: 'presentation.json', type: 'file', sizeBytes: 100 }] }
  },
  readArtifactFile: async (agentId: string, artifactId: string, path: string, params: unknown) => {
    calls.readFile.push({ agentId, artifactId, path, params })
    return {
      path,
      content: '{ "title": "Roadmap" }',
      unit: 'lines',
      offset: 1,
      limit: 50,
      sizeBytes: 22,
      truncated: false,
    }
  },
  editArtifactFile: async (agentId: string, artifactId: string, input: unknown) => {
    calls.editFile.push({ agentId, artifactId, input })
    if (editArtifactFileError) throw editArtifactFileError
    return { ok: true, changed: true, manifest: { id: artifactId, title: 'Roadmap', status: 'ready', requests: [] } }
  },
  prewarmArtifactBuilder: async () => ({ agentId: 'agent-1', sandboxId: 'sandbox-1', reused: true }),
  requestArtifact: async (input: ArtifactRequestInput) => {
    calls.request.push(input)
    return {
      action: input.action,
      agentId: input.agentId ?? 'new-agent',
      artifactId: input.artifactId ?? 'new-artifact',
      manifest: {
        id: input.artifactId ?? 'new-artifact',
        title: input.title ?? 'Existing artifact',
        status: 'ready',
        requests: [1, 2, 3, 4, 5].map((n) => ({
          at: `request-${n}`,
          from: 'voice',
          action: 'continue',
          brief: `Request ${n}`,
        })),
        publishes: [1, 2, 3, 4, 5].map((n) => ({
          at: `publish-${n}`,
          entry: { type: 'markdown', path: 'document.md' },
          status: 'ready',
          changeSummary: `Publish ${n}`,
        })),
      },
      ...(input.brief.includes('delivery fails')
        ? {
            inboxDeliveryFailed: true,
            message:
              'Artifact request was recorded, but agent notification failed. Do not retry the full request; check artifact status/context or ask to notify/wake the builder separately.',
          }
        : {}),
    }
  },
}

const {
  artifactTools,
  listArtifactsTool,
  getArtifactContextTool,
  listArtifactFilesTool,
  readArtifactFileTool,
  editArtifactFileTool,
  requestArtifactTool,
} = createArtifactTools(artifactDependencies as any)

describe('artifact voice tools', () => {
  beforeEach(() => {
    calls.list = []
    calls.context = []
    calls.files = []
    calls.readFile = []
    calls.editFile = []
    calls.request = []
    editArtifactFileError = null
  })

  test('defines list, context, and request tools with request_artifact voice-only export', () => {
    expect(artifactTools.map((tool) => tool.definition.name)).toEqual([
      'list_artifacts',
      'get_artifact_context',
      'list_artifact_files',
      'read_artifact_file',
      'edit_artifact_file',
      'request_artifact',
    ])

    expect(listArtifactsTool.definition.parameters.required).toEqual([])
    expect(getArtifactContextTool.definition.parameters.required).toEqual(['agentId', 'artifactId'])
    expect(requestArtifactTool.definition.parameters.properties.action.enum).toEqual([
      'create',
      'continue',
      'ask',
      'archive',
      'delete',
      'fork',
    ])
    expect(requestArtifactTool.definition.parameters.properties.title.description).toContain('Required for create')
    expect(requestArtifactTool.definition.parameters.properties.agentId.description).toContain(
      'Required for continue/ask/archive/delete/fork'
    )
    expect(requestArtifactTool.definition.parameters.properties.references.description).toContain(
      'api may use either id or url'
    )
    expect(requestArtifactTool.definition.parameters.properties.references.items.properties.id.description).toContain(
      'api references may alternatively use url'
    )
    expect(requestArtifactTool.definition.parameters.properties.references.items.properties.url.description).toContain(
      'api references may alternatively use id'
    )
    expect(requestArtifactTool.definition.description).toContain('background work acknowledgement')
    expect(requestArtifactTool.definition.description).not.toContain('request receipt')
    expect(requestArtifactTool.definition.parameters.properties.answers.description).toContain('question')
    expect(
      requestArtifactTool.definition.parameters.properties.answers.items.properties.questionId.description
    ).toContain('Question ID')
    expect(requestArtifactTool.definition.parameters.properties.answers.items.properties.answer.description).toContain(
      'Answer'
    )
  })

  test('artifact file tools call scoped file APIs with normalized arguments', async () => {
    await expect(
      listArtifactFilesTool.execute({ agentId: ' agent-1 ', artifactId: ' artifact-1 ' }, {})
    ).resolves.toEqual({
      files: [{ path: 'presentation.json', type: 'file', sizeBytes: 100 }],
    })
    await expect(
      readArtifactFileTool.execute(
        {
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          path: 'presentation.json',
          unit: 'lines',
          offset: 1,
          limit: 50,
        },
        {}
      )
    ).resolves.toMatchObject({ content: '{ "title": "Roadmap" }' })
    await expect(
      editArtifactFileTool.execute(
        {
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          path: 'presentation.json',
          edits: [{ oldText: 'Roadmap', newText: 'Plan' }],
          changeSummary: 'Rename title',
        },
        {}
      )
    ).resolves.toMatchObject({ ok: true, changed: true })

    expect(calls.files).toEqual([{ agentId: 'agent-1', artifactId: 'artifact-1' }])
    expect(calls.readFile).toEqual([
      {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        path: 'presentation.json',
        params: { unit: 'lines', offset: 1, limit: 50 },
      },
    ])
    expect(calls.editFile).toEqual([
      {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        input: {
          path: 'presentation.json',
          oldText: undefined,
          newText: undefined,
          edits: [{ oldText: 'Roadmap', newText: 'Plan' }],
          changeSummary: 'Rename title',
        },
      },
    ])
  })

  test('edit artifact file tool throws API error detail for the voice model', async () => {
    editArtifactFileError = new Error('API error: 400: edit[1] matched more than one location')

    await expect(
      editArtifactFileTool.execute(
        {
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          path: 'presentation.json',
          edits: [{ oldText: 'Roadmap', newText: 'Plan' }],
          changeSummary: 'Rename title',
        },
        {}
      )
    ).rejects.toThrow('API error: 400: edit[1] matched more than one location')
  })

  test('get artifact context returns compact manifest with API-supplied history', async () => {
    expect(getArtifactContextTool.definition.parameters.properties.requestsLimit).toBeUndefined()
    expect(getArtifactContextTool.definition.parameters.properties.questionsLimit).toBeUndefined()
    expect(getArtifactContextTool.definition.parameters.properties.publishesLimit).toBeUndefined()

    await expect(
      getArtifactContextTool.execute(
        {
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          requestsLimit: 1,
          questionsLimit: 2,
          publishesLimit: 0,
        },
        {}
      )
    ).resolves.toMatchObject({
      manifest: {
        id: 'artifact-1',
        title: 'Roadmap',
      },
      history: {
        requests: [
          { brief: 'Request 1' },
          { brief: 'Request 2' },
          { brief: 'Request 3' },
          { brief: 'Request 4' },
          { brief: 'Request 5' },
        ],
        questions: [{ id: 'q_1' }, { id: 'q_2' }, { id: 'q_3' }, { id: 'q_4' }, { id: 'q_5' }],
        publishes: [
          { changeSummary: 'Publish 1' },
          { changeSummary: 'Publish 2' },
          { changeSummary: 'Publish 3' },
          { changeSummary: 'Publish 4' },
          { changeSummary: 'Publish 5' },
        ],
      },
    })
  })

  test('get artifact context caps large history without pagination args or truncation metadata', async () => {
    expect(getArtifactContextTool.definition.parameters.properties.requestsLimit).toBeUndefined()
    expect(getArtifactContextTool.definition.parameters.properties.questionsLimit).toBeUndefined()
    expect(getArtifactContextTool.definition.parameters.properties.publishesLimit).toBeUndefined()

    const result = await getArtifactContextTool.execute({ agentId: 'agent-1', artifactId: 'large-artifact' }, {})

    expect(result).not.toHaveProperty('historyTruncated')
    expect(result).toMatchObject({
      manifest: {
        id: 'large-artifact',
        title: 'Roadmap',
      },
      history: {
        requests: [
          { brief: 'Request 8' },
          { brief: 'Request 9' },
          { brief: 'Request 10' },
          { brief: 'Request 11' },
          { brief: 'Request 12' },
        ],
        questions: [{ id: 'q_8' }, { id: 'q_9' }, { id: 'q_10' }, { id: 'q_11' }, { id: 'q_12' }],
        publishes: [
          { changeSummary: 'Publish 8' },
          { changeSummary: 'Publish 9' },
          { changeSummary: 'Publish 10' },
          { changeSummary: 'Publish 11' },
          { changeSummary: 'Publish 12' },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain('historyTruncated')
  })

  test('direct artifact file tools call API clients and reject metadata file paths', async () => {
    await expect(
      listArtifactFilesTool.execute({ agentId: ' agent-1 ', artifactId: ' artifact-1 ' }, {})
    ).resolves.toEqual({ files: [{ path: 'presentation.json', type: 'file', sizeBytes: 100 }] })
    expect(calls.files).toEqual([{ agentId: 'agent-1', artifactId: 'artifact-1' }])

    await expect(
      readArtifactFileTool.execute({ agentId: 'agent-1', artifactId: 'artifact-1', path: ' notes.md ' }, {})
    ).resolves.toMatchObject({ path: 'notes.md', content: '{ "title": "Roadmap" }' })
    expect(calls.readFile).toEqual([
      {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        path: 'notes.md',
        params: { unit: undefined, offset: undefined, limit: undefined },
      },
    ])

    await expect(
      editArtifactFileTool.execute(
        {
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          path: 'notes.md',
          oldText: 'Roadmap',
          newText: 'Plan',
          changeSummary: 'Rename title',
        },
        {}
      )
    ).resolves.toMatchObject({ ok: true, changed: true })
    expect(calls.editFile).toEqual([
      {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        input: {
          path: 'notes.md',
          oldText: 'Roadmap',
          newText: 'Plan',
          edits: undefined,
          changeSummary: 'Rename title',
        },
      },
    ])

    for (const tool of [readArtifactFileTool, editArtifactFileTool]) {
      for (const path of ['manifest.questions.jsonl', 'manifest-v2.jsonl', 'nested/manifest_requests.jsonl']) {
        await expect(
          tool.execute({ agentId: 'agent-1', artifactId: 'artifact-1', path, content: '' }, {})
        ).resolves.toEqual({ error: 'Artifact metadata files cannot be accessed directly' })
      }
    }
  })

  test('executes discovery and request API clients with normalized arguments', async () => {
    await expect(listArtifactsTool.execute({ query: 'roadmap', includeArchived: true }, {})).resolves.toEqual([
      { agentId: 'agent-1', artifactId: 'artifact-1', title: 'Roadmap', status: 'ready', updatedAt: '2026-01-01' },
    ])
    expect(calls.list).toEqual([{ query: 'roadmap', includeArchived: true }])

    await expect(getArtifactContextTool.execute({ agentId: 'agent-1', artifactId: 'artifact-1' }, {})).resolves.toEqual(
      {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        manifest: {
          id: 'artifact-1',
          title: 'Roadmap',
        },
        history: {
          requests: [
            { at: 'request-1', from: 'voice', action: 'continue', brief: 'Request 1' },
            { at: 'request-2', from: 'voice', action: 'continue', brief: 'Request 2' },
            { at: 'request-3', from: 'voice', action: 'continue', brief: 'Request 3' },
            { at: 'request-4', from: 'voice', action: 'continue', brief: 'Request 4' },
            { at: 'request-5', from: 'voice', action: 'continue', brief: 'Request 5' },
          ],
          questions: [
            { id: 'q_1', at: 'question-1', question: 'Question 1', responseMode: 'free_text', status: 'open' },
            { id: 'q_2', at: 'question-2', question: 'Question 2', responseMode: 'free_text', status: 'open' },
            { id: 'q_3', at: 'question-3', question: 'Question 3', responseMode: 'free_text', status: 'open' },
            { id: 'q_4', at: 'question-4', question: 'Question 4', responseMode: 'free_text', status: 'open' },
            { id: 'q_5', at: 'question-5', question: 'Question 5', responseMode: 'free_text', status: 'open' },
          ],
          publishes: [
            {
              at: 'publish-1',
              entry: { type: 'markdown', path: 'document.md' },
              status: 'ready',
              changeSummary: 'Publish 1',
            },
            {
              at: 'publish-2',
              entry: { type: 'markdown', path: 'document.md' },
              status: 'ready',
              changeSummary: 'Publish 2',
            },
            {
              at: 'publish-3',
              entry: { type: 'markdown', path: 'document.md' },
              status: 'ready',
              changeSummary: 'Publish 3',
            },
            {
              at: 'publish-4',
              entry: { type: 'markdown', path: 'document.md' },
              status: 'ready',
              changeSummary: 'Publish 4',
            },
            {
              at: 'publish-5',
              entry: { type: 'markdown', path: 'document.md' },
              status: 'ready',
              changeSummary: 'Publish 5',
            },
          ],
        },
      }
    )
    expect(calls.context).toEqual([{ agentId: 'agent-1', artifactId: 'artifact-1' }])

    await expect(
      requestArtifactTool.execute(
        {
          action: 'continue',
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          brief: 'Add Q2 milestones',
          references: [{ type: 'url', url: 'https://example.com/spec' }],
        },
        {}
      )
    ).resolves.toEqual({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      title: 'Existing artifact',
      requestReceipt:
        'Background artifact work has started. Tell the user only that Ficus is working on it and will let them know when it is available. Do not mention requests, routing, delivery, queues, builders, agents, tools, or handoffs. Do not say the artifact is ready, updated, refreshed, changed, or complete until a separate artifact update/publication event arrives.',
    })
    expect(calls.request).toEqual([
      {
        action: 'continue',
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        brief: 'Add Q2 milestones',
        references: [{ type: 'url', url: 'https://example.com/spec' }],
      },
    ])
  })

  test('executes informational ask requests with a checking receipt', async () => {
    await expect(
      requestArtifactTool.execute(
        {
          action: 'ask',
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          brief: '  Explain how the score works.  ',
        },
        {}
      )
    ).resolves.toEqual({
      action: 'ask',
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      title: 'Existing artifact',
      requestReceipt:
        'Ficus is checking the artifact details. Tell the user only that you are checking and will let them know. Do not mention requests, routing, delivery, queues, builders, agents, tools, or handoffs. Do not answer until a separate inbox response arrives.',
    })

    expect(calls.request).toEqual([
      {
        action: 'ask',
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        brief: 'Explain how the score works.',
      },
    ])
  })

  test('executes continue requests with trimmed structured answers', async () => {
    await expect(
      requestArtifactTool.execute(
        {
          action: 'continue',
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          brief: '  Answer questions  ',
          answers: [
            { questionId: '  q_1  ', answer: '  Dark theme  ' },
            { questionId: 'q_2', answer: '  Revenue and retention  ' },
          ],
        },
        {}
      )
    ).resolves.toEqual({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      title: 'Existing artifact',
      requestReceipt:
        'Background artifact work has started. Tell the user only that Ficus is working on it and will let them know when it is available. Do not mention requests, routing, delivery, queues, builders, agents, tools, or handoffs. Do not say the artifact is ready, updated, refreshed, changed, or complete until a separate artifact update/publication event arrives.',
    })

    expect(calls.request).toEqual([
      {
        action: 'continue',
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        brief: 'Answer questions',
        answers: [
          { questionId: 'q_1', answer: 'Dark theme' },
          { questionId: 'q_2', answer: 'Revenue and retention' },
        ],
      },
    ])
  })

  test('returns validation errors instead of calling request API with missing required fields', async () => {
    await expect(requestArtifactTool.execute({ action: 'ask', brief: 'How does this work?' }, {})).resolves.toEqual({
      error: 'agentId and artifactId are required for ask requests',
    })
    expect(calls.request).toEqual([])
  })

  test('rejects invalid structured answers before calling request API', async () => {
    for (const answers of [
      [{ questionId: '  ', answer: 'Dark' }],
      [{ questionId: 'q_1', answer: '  ' }],
      [{ questionId: 12, answer: 'Dark' }],
      [{ questionId: 'q_1', answer: null }],
    ]) {
      await expect(
        requestArtifactTool.execute(
          {
            action: 'continue',
            agentId: 'agent-1',
            artifactId: 'artifact-1',
            brief: 'Answer questions',
            answers,
          },
          {}
        )
      ).resolves.toEqual({ error: 'answers must include non-empty questionId and answer' })
    }
    await expect(
      requestArtifactTool.execute(
        {
          action: 'continue',
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          brief: 'Answer questions',
          answers: [
            { questionId: 'q_1', answer: 'Light' },
            { questionId: ' q_1 ', answer: 'Dark' },
          ],
        },
        {}
      )
    ).resolves.toEqual({ error: 'Duplicate artifact question response: q_1' })
    expect(calls.request).toEqual([])
  })

  test('rejects structured answers for non-continue requests before calling request API', async () => {
    await expect(
      requestArtifactTool.execute(
        {
          action: 'create',
          title: 'Dashboard',
          brief: 'Build it',
          answers: [{ questionId: 'q_1', answer: 'Dark' }],
        },
        {}
      )
    ).resolves.toEqual({ error: 'answers are only supported for continue artifact requests' })

    expect(calls.request).toEqual([])
  })

  test('surfaces continue partial-success delivery failures from the request API', async () => {
    await expect(
      requestArtifactTool.execute(
        {
          action: 'continue',
          agentId: 'agent-1',
          artifactId: 'artifact-1',
          brief: 'Append this even when delivery fails',
        },
        {}
      )
    ).resolves.toEqual({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      title: 'Existing artifact',
      inboxDeliveryFailed: true,
      message:
        'Artifact request was recorded, but agent notification failed. Do not retry the full request; check artifact status/context or ask to notify/wake the builder separately.',
      requestReceipt:
        'Background artifact work has started. Tell the user only that Ficus is working on it and will let them know when it is available. Do not mention requests, routing, delivery, queues, builders, agents, tools, or handoffs. Do not say the artifact is ready, updated, refreshed, changed, or complete until a separate artifact update/publication event arrives.',
    })
    expect(calls.request).toEqual([
      {
        action: 'continue',
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        brief: 'Append this even when delivery fails',
      },
    ])
  })

  test('trims string arguments and rejects invalid references before calling request API', async () => {
    await expect(
      requestArtifactTool.execute(
        {
          action: 'create',
          title: '  Launch Dashboard  ',
          brief: '  Build a dashboard  ',
          displayModeHint: '  dashboard  ',
          references: [{ type: 'url', url: 'not a url' }],
        },
        {}
      )
    ).resolves.toEqual({ error: 'references must match the artifact reference schema' })
    expect(calls.request).toEqual([])

    await expect(
      requestArtifactTool.execute(
        {
          action: 'create',
          title: '  Launch Dashboard  ',
          brief: '  Build a dashboard  ',
          displayModeHint: '  dashboard  ',
          references: [{ type: 'url', url: 'https://example.com/spec' }],
        },
        {}
      )
    ).resolves.toEqual({
      action: 'create',
      agentId: 'new-agent',
      artifactId: 'new-artifact',
      title: 'Launch Dashboard',
      requestReceipt:
        'Background artifact work has started. Tell the user only that Ficus is working on it and will let them know when it is available. Do not mention requests, routing, delivery, queues, builders, agents, tools, or handoffs. Do not say the artifact is ready, updated, refreshed, changed, or complete until a separate artifact update/publication event arrives.',
    })
    expect(calls.request[0]).toMatchObject({
      title: 'Launch Dashboard',
      brief: 'Build a dashboard',
      displayModeHint: 'dashboard',
      references: [{ type: 'url', url: 'https://example.com/spec' }],
    })
  })
})
