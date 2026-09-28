import { artifactReferenceSchema as sharedArtifactReferenceSchema } from '@ficus/shared'
import {
  editArtifactFile,
  getArtifactContext,
  listArtifactFiles,
  listArtifacts,
  readArtifactFile,
  requestArtifact,
  type ArtifactContext,
  type ArtifactRequestInput,
} from '../../api/artifacts'
import type { VoiceAssistantTool } from './types'

const VOICE_ARTIFACT_HISTORY_LIMIT = 5

const voiceArtifactAnswersParameterSchema = {
  type: 'array',
  description:
    'Optional structured answers when continuing an artifact that has open questions. Each answer targets one question ID from the artifact manifest.',
  items: {
    type: 'object',
    properties: {
      questionId: { type: 'string', description: 'Question ID from the artifact manifest, such as q_1.' },
      answer: { type: 'string', description: 'Answer text to record for this question.' },
    },
    required: ['questionId', 'answer'],
  },
} as const

const voiceArtifactReferencesParameterSchema = {
  type: 'array',
  description:
    'Optional references for the artifact builder. Required fields by type: agent/thread/workstream/artifact requires id; api may use either id or url; url requires url; file requires path. note is optional for all types.',
  items: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['agent', 'thread', 'workstream', 'url', 'file', 'api', 'artifact'],
        description: 'Reference type. Determines whether id, url, or path is required.',
      },
      id: {
        type: 'string',
        description:
          'Required for agent, thread, workstream, and artifact references; api references may alternatively use url.',
      },
      url: { type: 'string', description: 'Required for url references; api references may alternatively use id.' },
      path: { type: 'string', description: 'Required for file references.' },
      note: { type: 'string', description: 'Optional note explaining why this reference matters.' },
    },
    required: ['type'],
  },
} as const

export type ArtifactToolDependencies = {
  listArtifacts: typeof listArtifacts
  getArtifactContext: typeof getArtifactContext
  listArtifactFiles: typeof listArtifactFiles
  readArtifactFile: typeof readArtifactFile
  editArtifactFile: typeof editArtifactFile
  requestArtifact: typeof requestArtifact
}

export function createArtifactTools(deps: ArtifactToolDependencies) {
  const listArtifactsTool: VoiceAssistantTool = {
    definition: {
      type: 'function',
      name: 'list_artifacts',
      description:
        'List visual/app/canvas artifacts that artifact builder agents have created. Use before deciding whether to continue an existing artifact.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional search text for titles, summaries, and recent request briefs.',
          },
          includeArchived: {
            type: 'boolean',
            description: 'Whether to include archived artifacts. Defaults to false.',
          },
        },
        required: [],
      },
    },
    async execute(args) {
      return deps.listArtifacts({
        query: typeof args.query === 'string' ? args.query.trim() || undefined : undefined,
        includeArchived: args.includeArchived === true,
      })
    },
    summarizeCall(args) {
      return args.query ? `Searching artifacts for ${String(args.query)}` : 'Listing artifacts'
    },
  }

  const getArtifactContextTool: VoiceAssistantTool = {
    definition: {
      type: 'function',
      name: 'get_artifact_context',
      description: 'Get the manifest and backend context for a selected artifact before requesting changes.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Owning artifact builder agent ID.' },
          artifactId: { type: 'string', description: 'Artifact ID in the owning builder workspace.' },
        },
        required: ['agentId', 'artifactId'],
      },
    },
    async execute(args) {
      const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : ''
      const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
      if (!agentId || !artifactId) {
        return { error: 'agentId and artifactId are required' }
      }
      const { content: _content, ...context } = await deps.getArtifactContext(agentId, artifactId)
      return capVoiceArtifactHistory(context)
    },
    summarizeCall(args) {
      return `Getting artifact ${String(args.artifactId)} context`
    },
  }

  const listArtifactFilesTool: VoiceAssistantTool = {
    definition: {
      type: 'function',
      name: 'list_artifact_files',
      description:
        'List files inside a specific artifact directory before reading or directly editing artifact files. Use with agentId and artifactId from the current display, list_artifacts, or get_artifact_context.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Owning artifact builder agent ID.' },
          artifactId: { type: 'string', description: 'Artifact ID in the owning builder workspace.' },
        },
        required: ['agentId', 'artifactId'],
      },
    },
    async execute(args) {
      const ids = readArtifactIds(args)
      if ('error' in ids) return ids
      return deps.listArtifactFiles(ids.agentId, ids.artifactId)
    },
    summarizeCall(args) {
      return `Listing files for artifact ${String(args.artifactId)}`
    },
  }

  const readArtifactFileTool: VoiceAssistantTool = {
    definition: {
      type: 'function',
      name: 'read_artifact_file',
      description:
        'Read a bounded line or byte range from a file inside a specific artifact directory. Use this before edit_artifact_file. Defaults to line reads with offset 1 and limit 200.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Owning artifact builder agent ID.' },
          artifactId: { type: 'string', description: 'Artifact ID in the owning builder workspace.' },
          path: {
            type: 'string',
            description: 'Relative path inside the artifact directory, such as presentation.json.',
          },
          unit: { type: 'string', enum: ['lines', 'bytes'], description: 'Read unit. Defaults to lines.' },
          offset: { type: 'number', description: '1-based line offset for lines, 0-based byte offset for bytes.' },
          limit: { type: 'number', description: 'Maximum lines or bytes to read. Server-enforced caps apply.' },
        },
        required: ['agentId', 'artifactId', 'path'],
      },
    },
    async execute(args) {
      const ids = readArtifactIds(args)
      if ('error' in ids) return ids
      const path = typeof args.path === 'string' ? args.path.trim() : ''
      if (!path) return { error: 'path is required' }
      if (isArtifactMetadataFile(path)) return { error: 'Artifact metadata files cannot be accessed directly' }
      return deps.readArtifactFile(ids.agentId, ids.artifactId, path, {
        unit: args.unit === 'bytes' ? 'bytes' : args.unit === 'lines' ? 'lines' : undefined,
        offset: typeof args.offset === 'number' ? args.offset : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      })
    },
    summarizeCall(args) {
      return `Reading artifact file ${String(args.path)}`
    },
  }

  const editArtifactFileTool: VoiceAssistantTool = {
    definition: {
      type: 'function',
      name: 'edit_artifact_file',
      description:
        'Directly edit a file inside an artifact directory using one exact, unique text replacement. Use for small low-risk changes after reading the file. Preserve valid JSON/HTML/Markdown as appropriate. If oldText is not found or not unique, read a narrower range and retry.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Owning artifact builder agent ID.' },
          artifactId: { type: 'string', description: 'Artifact ID in the owning builder workspace.' },
          path: { type: 'string', description: 'Relative path inside the artifact directory.' },
          oldText: {
            type: 'string',
            description:
              'Exact text currently in the file. Must match exactly and uniquely. Use either oldText/newText for one edit or edits[] for multiple edits.',
          },
          newText: { type: 'string', description: 'Replacement text for single-edit mode.' },
          edits: {
            type: 'array',
            description:
              'Optional batch of exact unique text replacements to apply atomically in order. Use for multiple small edits to the same file.',
            items: {
              type: 'object',
              properties: {
                oldText: {
                  type: 'string',
                  description: 'Exact text currently in the file. Must match exactly and uniquely.',
                },
                newText: { type: 'string', description: 'Replacement text.' },
              },
              required: ['oldText', 'newText'],
            },
          },
          changeSummary: { type: 'string', description: 'Short user-facing summary of the direct artifact edit.' },
        },
        required: ['agentId', 'artifactId', 'path', 'changeSummary'],
      },
    },
    async execute(args) {
      const ids = readArtifactIds(args)
      if ('error' in ids) return ids
      const path = typeof args.path === 'string' ? args.path.trim() : ''
      const oldText = typeof args.oldText === 'string' ? args.oldText : undefined
      const newText = typeof args.newText === 'string' ? args.newText : undefined
      const edits = Array.isArray(args.edits)
        ? args.edits.map((edit) => ({
            oldText: typeof edit === 'object' && edit && 'oldText' in edit ? String(edit.oldText) : '',
            newText: typeof edit === 'object' && edit && 'newText' in edit ? String(edit.newText) : '',
          }))
        : undefined
      const changeSummary = typeof args.changeSummary === 'string' ? args.changeSummary.trim() : ''
      if (!path) return { error: 'path is required' }
      if (isArtifactMetadataFile(path)) return { error: 'Artifact metadata files cannot be accessed directly' }
      if (!oldText && !edits?.length) return { error: 'oldText or edits is required' }
      if (!changeSummary) return { error: 'changeSummary is required' }
      return deps.editArtifactFile(ids.agentId, ids.artifactId, { path, oldText, newText, edits, changeSummary })
    },
    summarizeCall(args) {
      return `Editing artifact file ${String(args.path)}`
    },
    followUp: 'auto',
  }

  const requestArtifactTool: VoiceAssistantTool = {
    definition: {
      type: 'function',
      name: 'request_artifact',
      description:
        'Voice-only tool to create, continue, ask about, archive, delete, or fork a visual/app/canvas artifact through Ficus background work. Use action "ask" for informational questions about an existing artifact that require the artifact builder\'s knowledge but should not change the artifact. A successful result is only a background work acknowledgement; it does not mean Ficus has performed, published, answered, or displayed the requested work yet. Tell the user Ficus is working on it or checking without mentioning requests, routing, delivery, queues, builders, agents, tools, or handoffs. Wait for a later inbox/artifact confirmation before saying the answer or artifact is ready.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'continue', 'ask', 'archive', 'delete', 'fork'],
            description:
              'Request action. Use create for new artifacts, continue for changes to an existing artifact, and ask for informational questions that should not modify the artifact.',
          },
          title: {
            type: 'string',
            description: 'Required for create. Short title for the new artifact.',
          },
          agentId: {
            type: 'string',
            description: 'Required for continue/ask/archive/delete/fork. Internal owner ID from list_artifacts.',
          },
          artifactId: {
            type: 'string',
            description: 'Required for continue/ask/archive/delete/fork. Existing artifact ID.',
          },
          brief: {
            type: 'string',
            description:
              'Required self-contained brief for Ficus background work. Include goal, expected UX/output, data/context, constraints, and acceptance criteria.',
          },
          references: voiceArtifactReferencesParameterSchema,
          answers: voiceArtifactAnswersParameterSchema,
          displayModeHint: {
            type: 'string',
            description: 'Optional hint such as dashboard, presentation, canvas, markdown, HTML app, or sandbox app.',
          },
        },
        required: ['action', 'brief'],
      },
    },
    async execute(args) {
      const input = normalizeArtifactRequestInput(args)
      if ('error' in input) return input
      const result = await deps.requestArtifact(input)
      if (
        input.action === 'create' ||
        input.action === 'continue' ||
        input.action === 'ask' ||
        input.action === 'fork'
      ) {
        return {
          action: result.action,
          agentId: result.agentId,
          artifactId: result.artifactId,
          ...(result.manifest?.title ? { title: result.manifest.title } : {}),
          ...(result.inboxDeliveryFailed ? { inboxDeliveryFailed: true, message: result.message } : {}),
          requestReceipt:
            input.action === 'ask'
              ? 'Ficus is checking the artifact details. Tell the user only that you are checking and will let them know. Do not mention requests, routing, delivery, queues, builders, agents, tools, or handoffs. Do not answer until a separate inbox response arrives.'
              : 'Background artifact work has started. Tell the user only that Ficus is working on it and will let them know when it is available. Do not mention requests, routing, delivery, queues, builders, agents, tools, or handoffs. Do not say the artifact is ready, updated, refreshed, changed, or complete until a separate artifact update/publication event arrives.',
        }
      }
      return result
    },
    summarizeCall(args) {
      return `${String(args.action)} artifact${args.title ? `: ${String(args.title)}` : ''}`
    },
    followUp: 'auto',
  }

  const artifactTools = [
    listArtifactsTool,
    getArtifactContextTool,
    listArtifactFilesTool,
    readArtifactFileTool,
    editArtifactFileTool,
    requestArtifactTool,
  ]

  return {
    artifactTools,
    listArtifactsTool,
    getArtifactContextTool,
    listArtifactFilesTool,
    readArtifactFileTool,
    editArtifactFileTool,
    requestArtifactTool,
  }
}

export const {
  artifactTools,
  listArtifactsTool,
  getArtifactContextTool,
  listArtifactFilesTool,
  readArtifactFileTool,
  editArtifactFileTool,
  requestArtifactTool,
} = createArtifactTools({
  listArtifacts,
  getArtifactContext,
  listArtifactFiles,
  readArtifactFile,
  editArtifactFile,
  requestArtifact,
})

function readArtifactIds(args: Record<string, unknown>): { agentId: string; artifactId: string } | { error: string } {
  const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : ''
  const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
  if (!agentId || !artifactId) return { error: 'agentId and artifactId are required' }
  return { agentId, artifactId }
}

function isArtifactMetadataFile(path: string): boolean {
  const basename = path
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1)
  return basename === 'manifest.json' || (basename !== undefined && /^manifest.*\.jsonl$/.test(basename))
}

function capVoiceArtifactHistory(context: Omit<ArtifactContext, 'content'>): Omit<ArtifactContext, 'content'> {
  return {
    ...context,
    history: {
      requests: tail(context.history.requests, VOICE_ARTIFACT_HISTORY_LIMIT),
      questions: tail(context.history.questions, VOICE_ARTIFACT_HISTORY_LIMIT),
      publishes: tail(context.history.publishes, VOICE_ARTIFACT_HISTORY_LIMIT),
    },
  }
}

function tail<T>(items: T[], limit: number): T[] {
  return items.slice(-limit)
}

function normalizeArtifactRequestInput(args: Record<string, unknown>): ArtifactRequestInput | { error: string } {
  const action = args.action
  if (!isArtifactAction(action))
    return { error: 'action must be one of create, continue, ask, archive, delete, or fork' }
  const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
  if (!brief) return { error: 'brief is required' }

  const input: ArtifactRequestInput = {
    action,
    brief,
  }

  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : ''
  const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
  const displayModeHint = typeof args.displayModeHint === 'string' ? args.displayModeHint.trim() : ''

  if (title) input.title = title
  if (agentId) input.agentId = agentId
  if (artifactId) input.artifactId = artifactId
  if (displayModeHint) input.displayModeHint = displayModeHint
  if (Array.isArray(args.references)) {
    const references = []
    for (const reference of args.references) {
      const parsed = sharedArtifactReferenceSchema.safeParse(reference)
      if (!parsed.success) return { error: 'references must match the artifact reference schema' }
      references.push(parsed.data)
    }
    input.references = references
  }

  if (args.answers !== undefined) {
    if (action !== 'continue') return { error: 'answers are only supported for continue artifact requests' }
    if (!Array.isArray(args.answers)) return { error: 'answers must include non-empty questionId and answer' }
    const answers = []
    const questionIds = new Set<string>()
    for (const answer of args.answers) {
      if (!answer || typeof answer !== 'object')
        return { error: 'answers must include non-empty questionId and answer' }
      const record = answer as Record<string, unknown>
      const questionId = typeof record.questionId === 'string' ? record.questionId.trim() : ''
      const answerText = typeof record.answer === 'string' ? record.answer.trim() : ''
      if (!questionId || !answerText) return { error: 'answers must include non-empty questionId and answer' }
      if (questionIds.has(questionId)) return { error: `Duplicate artifact question response: ${questionId}` }
      questionIds.add(questionId)
      answers.push({ questionId, answer: answerText })
    }
    input.answers = answers
  }

  if (action === 'create' && !input.title) return { error: 'title is required for create requests' }
  if (action !== 'create' && (!input.agentId || !input.artifactId)) {
    return { error: `agentId and artifactId are required for ${action} requests` }
  }

  return input
}

function isArtifactAction(value: unknown): value is ArtifactRequestInput['action'] {
  return (
    value === 'create' ||
    value === 'continue' ||
    value === 'ask' ||
    value === 'archive' ||
    value === 'delete' ||
    value === 'fork'
  )
}
