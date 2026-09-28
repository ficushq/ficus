import { Type } from '@sinclair/typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  SYSTEM_RECIPIENT_ID,
  artifactQuestionPrioritySchema,
  artifactQuestionResponseModeSchema,
  artifactStatusSchema,
  type ArtifactEntry,
  type ArtifactManifest,
  type ArtifactQuestion,
  type ArtifactQuestionPriority,
  type ArtifactQuestionResponseMode,
  type ArtifactStatus,
} from '@ficus/shared'
import { InboxMessage } from '../entities/InboxMessage'
import { resolveAgentRequestingUserId } from '../services/inbox/agent-human-recipient'
import { eventEmitter } from '../lib/infra/event-emitter'
import { publishArtifact } from '../services/artifacts/artifactPublish'
import {
  appendArtifactQuestions,
  mutateArtifactManifest,
  readArtifactManifest,
} from '../services/artifacts/artifactWorkspace'

const NonEmptyStringSchema = (description: string) => Type.String({ minLength: 1, description })
const BoundedNonEmptyStringSchema = (description: string, maxLength: number) =>
  Type.String({ minLength: 1, maxLength, description })

const MAX_ARTIFACT_QUESTIONS_PER_TOOL_CALL = 10
const MAX_ARTIFACT_QUESTION_TEXT_LENGTH = 2000
const MAX_ARTIFACT_QUESTION_CHOICE_COUNT = 20
const MAX_ARTIFACT_QUESTION_CHOICE_LENGTH = 500

const ArtifactEntrySchema = Type.Object({
  type: Type.Union([
    Type.Literal('presentation'),
    Type.Literal('markdown'),
    Type.Literal('html'),
    Type.Literal('sandbox_app'),
  ]),
  path: NonEmptyStringSchema('Path to the artifact entry file, relative to the artifact folder'),
})

const ArtifactStatusSchema = Type.Union([Type.Literal('working'), Type.Literal('ready'), Type.Literal('error')])

const ArtifactPublishSchema = Type.Object({
  artifactId: NonEmptyStringSchema('Artifact id / folder name'),
  entry: ArtifactEntrySchema,
  title: Type.Optional(NonEmptyStringSchema('Optional replacement artifact title')),
  summary: Type.Optional(NonEmptyStringSchema('Optional short artifact summary')),
  status: Type.Optional(ArtifactStatusSchema),
  changeSummary: NonEmptyStringSchema('Short audit note explaining why this publish is being made and what changed'),
  changeDetails: Type.Optional(NonEmptyStringSchema('Optional longer detail about the changes in this publish')),
})

const ArtifactStatusToolSchema = Type.Object({
  artifactId: NonEmptyStringSchema('Artifact id / folder name'),
  status: Type.Optional(ArtifactStatusSchema),
  summary: Type.Optional(NonEmptyStringSchema('Optional short artifact summary')),
})

const ArtifactQuestionResponseModeSchema = Type.Union([
  Type.Literal('free_text'),
  Type.Literal('single_select'),
  Type.Literal('multi_select'),
])

const ArtifactQuestionPrioritySchema = Type.Union([Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')])

const ArtifactQuestionInputSchema = Type.Object({
  title: Type.Optional(BoundedNonEmptyStringSchema('Optional short question title', MAX_ARTIFACT_QUESTION_TEXT_LENGTH)),
  question: BoundedNonEmptyStringSchema('Question to ask the user', MAX_ARTIFACT_QUESTION_TEXT_LENGTH),
  context: Type.Optional(BoundedNonEmptyStringSchema('Why this answer is needed', MAX_ARTIFACT_QUESTION_TEXT_LENGTH)),
  responseMode: ArtifactQuestionResponseModeSchema,
  choices: Type.Optional(
    Type.Array(BoundedNonEmptyStringSchema('Answer choice', MAX_ARTIFACT_QUESTION_CHOICE_LENGTH), {
      minItems: 1,
      maxItems: MAX_ARTIFACT_QUESTION_CHOICE_COUNT,
    })
  ),
  priority: Type.Optional(ArtifactQuestionPrioritySchema),
})

const ArtifactQuestionToolSchema = Type.Object({
  artifactId: NonEmptyStringSchema('Artifact id / folder name'),
  questions: Type.Array(ArtifactQuestionInputSchema, { minItems: 1, maxItems: MAX_ARTIFACT_QUESTIONS_PER_TOOL_CALL }),
})

type ArtifactQuestionToolInput = {
  artifactId: string
  questions: Array<{
    title?: string
    question: string
    context?: string
    responseMode: ArtifactQuestionResponseMode
    choices?: string[]
    priority?: ArtifactQuestionPriority
  }>
}

type NormalizedQuestion = ArtifactQuestionToolInput['questions'][number]

export interface ArtifactToolsContext {
  agentId: string
  squadId: string | null
  agentWorkspacePath: string
}

export function createArtifactTools(ctx: ArtifactToolsContext): ToolDefinition[] {
  return [createArtifactPublishTool(ctx), createArtifactStatusTool(ctx), createArtifactQuestionTool(ctx)]
}

function createArtifactPublishTool(ctx: ArtifactToolsContext): ToolDefinition {
  return {
    name: 'artifact_publish',
    label: 'Publish Artifact',
    description:
      'Publish or update an artifact manifest entry after the artifact content file is complete and valid. ' +
      'Use this when the artifact is ready to show to the user.',
    parameters: ArtifactPublishSchema,
    async execute(
      _toolCallId: string,
      params: {
        artifactId: string
        entry: ArtifactEntry
        title?: string
        summary?: string
        status?: ArtifactStatus
        changeSummary: string
        changeDetails?: string
      }
    ): Promise<AgentToolResult<unknown>> {
      try {
        const title = trimOptionalToolString(params.title)
        const summary = trimOptionalToolString(params.summary)
        const changeSummary = params.changeSummary.trim()
        const changeDetails = trimOptionalToolString(params.changeDetails)
        const result = await publishArtifact({
          agentWorkspacePath: ctx.agentWorkspacePath,
          artifactId: params.artifactId,
          entry: params.entry,
          title,
          summary,
          status: params.status ?? 'ready',
          changeSummary,
          changeDetails,
        })

        if (!result.ok) {
          return artifactToolError(`Could not publish artifact: ${result.errors.join('; ')}`, {
            success: false,
            artifactId: params.artifactId,
            errors: result.errors,
          })
        }

        emitArtifactUpdated(ctx, result.manifest)
        return artifactToolSuccess(`Published artifact "${result.manifest.title}" (${result.manifest.id}).`, {
          success: true,
          artifactId: result.manifest.id,
          manifest: result.manifest,
        })
      } catch (error) {
        return artifactToolError(`Could not publish artifact: ${formatError(error)}`, {
          success: false,
          artifactId: params.artifactId,
          errors: [formatError(error)],
        })
      }
    },
  }
}

function createArtifactStatusTool(ctx: ArtifactToolsContext): ToolDefinition {
  return {
    name: 'artifact_status',
    label: 'Artifact Status',
    description:
      'Read the current artifact manifest, or update only its status and/or summary without changing the entry file.',
    parameters: ArtifactStatusToolSchema,
    async execute(
      _toolCallId: string,
      params: { artifactId: string; status?: ArtifactStatus; summary?: string }
    ): Promise<AgentToolResult<unknown>> {
      try {
        const summary = trimOptionalToolString(params.summary)
        const statusErrors = validateStatusParams({ ...params, summary })
        if (statusErrors.length > 0) {
          return artifactToolError(`Could not update artifact status: ${statusErrors.join('; ')}`, {
            success: false,
            artifactId: params.artifactId,
            errors: statusErrors,
          })
        }

        let manifest: ArtifactManifest | null
        if (params.status === undefined && params.summary === undefined) {
          manifest = await readArtifactManifest({
            agentWorkspacePath: ctx.agentWorkspacePath,
            artifactId: params.artifactId,
          })
          if (!manifest) {
            return artifactToolError(`Artifact manifest not found or invalid: ${params.artifactId}`, {
              success: false,
              artifactId: params.artifactId,
              errors: [`Artifact manifest not found or invalid: ${params.artifactId}`],
            })
          }
          return artifactToolSuccess(formatManifestStatus(manifest), {
            success: true,
            artifactId: manifest.id,
            manifest,
          })
        }

        manifest = await mutateArtifactManifest({
          agentWorkspacePath: ctx.agentWorkspacePath,
          artifactId: params.artifactId,
          mutate: (currentManifest) => ({
            ...currentManifest,
            status: params.status ?? currentManifest.status,
            ...(summary !== undefined
              ? { summary }
              : currentManifest.summary
                ? { summary: currentManifest.summary }
                : {}),
            updatedAt: new Date().toISOString(),
          }),
        })

        emitArtifactUpdated(ctx)
        return artifactToolSuccess(formatManifestStatus(manifest), {
          success: true,
          artifactId: manifest.id,
          manifest,
        })
      } catch (error) {
        return artifactToolError(`Could not update artifact status: ${formatError(error)}`, {
          success: false,
          artifactId: params.artifactId,
          errors: [formatError(error)],
        })
      }
    },
  }
}

function createArtifactQuestionTool(ctx: ArtifactToolsContext): ToolDefinition {
  return {
    name: 'artifact_question',
    label: 'Ask Artifact Question',
    description: 'Append one or more structured questions to an artifact manifest and notify the human for answers.',
    parameters: ArtifactQuestionToolSchema,
    async execute(_toolCallId: string, params: ArtifactQuestionToolInput): Promise<AgentToolResult<unknown>> {
      const artifactId = isRecord(params) && typeof params.artifactId === 'string' ? params.artifactId : undefined
      try {
        if (!isRecord(params)) {
          return artifactToolError('Could not ask artifact question: params must be an object', {
            success: false,
            errors: ['params must be an object'],
          })
        }

        const { questions, errors } = normalizeArtifactQuestions(params.questions)
        if (errors.length > 0) {
          return artifactToolError(`Could not ask artifact question: ${errors.join('; ')}`, {
            success: false,
            ...(artifactId ? { artifactId } : {}),
            errors,
          })
        }
        if (!artifactId?.trim()) {
          return artifactToolError('Could not ask artifact question: artifactId must not be empty', {
            success: false,
            errors: ['artifactId must not be empty'],
          })
        }

        const { manifest, questions: addedQuestions } = await appendArtifactQuestions({
          agentWorkspacePath: ctx.agentWorkspacePath,
          artifactId,
          questions,
        })
        const questionIds = addedQuestions.map((question) => question.id)

        try {
          // Address the human who requested this artifact; fall back to the shared system inbox.
          const requestingUserId = await resolveAgentRequestingUserId(ctx.agentId)
          const message = await InboxMessage.send({
            recipientType: requestingUserId ? 'user' : 'system',
            recipientId: requestingUserId ?? SYSTEM_RECIPIENT_ID,
            senderType: 'agent',
            senderId: ctx.agentId,
            subject: `Question for artifact ${manifest.title}`,
            content: formatArtifactQuestionInboxContent(manifest, addedQuestions),
            metadata: {
              requestType: 'artifact_question',
              artifactId: manifest.id,
              agentId: ctx.agentId,
              questions: addedQuestions.map(formatArtifactQuestionMetadata),
            },
          })

          emitArtifactUpdated(ctx)
          return artifactToolSuccess(`Asked ${questionIds.length} question(s) for artifact ${manifest.id}.`, {
            success: true,
            artifactId: manifest.id,
            questionIds,
            manifest,
            messageId: message.id,
          })
        } catch (error) {
          emitArtifactUpdated(ctx)
          return artifactToolSuccess(
            `Asked ${questionIds.length} question(s) for artifact ${manifest.id}, but inbox delivery failed: ${formatError(error)}`,
            {
              success: true,
              artifactId: manifest.id,
              questionIds,
              manifest,
              inboxDeliveryFailed: true,
              errors: [formatError(error)],
            }
          )
        }
      } catch (error) {
        return artifactToolError(`Could not ask artifact question: ${formatError(error)}`, {
          success: false,
          ...(artifactId ? { artifactId } : {}),
          errors: [formatError(error)],
        })
      }
    },
  }
}

function normalizeArtifactQuestions(inputQuestions: unknown): {
  questions: NormalizedQuestion[]
  errors: string[]
} {
  const questions: NormalizedQuestion[] = []
  const errors: string[] = []

  if (!Array.isArray(inputQuestions)) {
    return { questions, errors: ['questions must be an array'] }
  }
  if (inputQuestions.length === 0) {
    errors.push('questions must include at least one question')
  }
  if (inputQuestions.length > MAX_ARTIFACT_QUESTIONS_PER_TOOL_CALL) {
    errors.push(`questions must include at most ${MAX_ARTIFACT_QUESTIONS_PER_TOOL_CALL} questions`)
    return { questions, errors }
  }

  inputQuestions.forEach((rawQuestion, index) => {
    if (!isRecord(rawQuestion)) {
      errors.push(`questions[${index}] must be an object`)
      return
    }

    const title = trimOptionalToolString(typeof rawQuestion.title === 'string' ? rawQuestion.title : undefined)
    const question = typeof rawQuestion.question === 'string' ? rawQuestion.question.trim() : ''
    const context = trimOptionalToolString(typeof rawQuestion.context === 'string' ? rawQuestion.context : undefined)
    const responseMode = rawQuestion.responseMode
    const priority = rawQuestion.priority
    const choices: string[] = []

    if (rawQuestion.title !== undefined && typeof rawQuestion.title !== 'string') {
      errors.push(`questions[${index}].title must be a string`)
    } else if (title !== undefined && title.length === 0) {
      errors.push(`questions[${index}].title must not be empty`)
    } else if (title && title.length > MAX_ARTIFACT_QUESTION_TEXT_LENGTH) {
      errors.push(`questions[${index}].title must be at most ${MAX_ARTIFACT_QUESTION_TEXT_LENGTH} characters`)
    }

    if (!question) {
      errors.push(`questions[${index}].question must not be empty`)
    } else if (question.length > MAX_ARTIFACT_QUESTION_TEXT_LENGTH) {
      errors.push(`questions[${index}].question must be at most ${MAX_ARTIFACT_QUESTION_TEXT_LENGTH} characters`)
    }

    if (rawQuestion.context !== undefined && typeof rawQuestion.context !== 'string') {
      errors.push(`questions[${index}].context must be a string`)
    } else if (context !== undefined && context.length === 0) {
      errors.push(`questions[${index}].context must not be empty`)
    } else if (context && context.length > MAX_ARTIFACT_QUESTION_TEXT_LENGTH) {
      errors.push(`questions[${index}].context must be at most ${MAX_ARTIFACT_QUESTION_TEXT_LENGTH} characters`)
    }

    const parsedResponseMode = artifactQuestionResponseModeSchema.safeParse(responseMode)
    if (!parsedResponseMode.success) {
      errors.push(`questions[${index}].responseMode is invalid`)
    }

    if (priority !== undefined) {
      const parsedPriority = artifactQuestionPrioritySchema.safeParse(priority)
      if (!parsedPriority.success) {
        errors.push(`questions[${index}].priority is invalid`)
      }
    }

    if (rawQuestion.choices !== undefined && !Array.isArray(rawQuestion.choices)) {
      errors.push(`questions[${index}].choices must be an array`)
    } else {
      const rawChoices = Array.isArray(rawQuestion.choices) ? rawQuestion.choices : []
      if (rawChoices.length > MAX_ARTIFACT_QUESTION_CHOICE_COUNT) {
        errors.push(`questions[${index}].choices must include at most ${MAX_ARTIFACT_QUESTION_CHOICE_COUNT} choices`)
        return
      }
      rawChoices.forEach((choice, choiceIndex) => {
        const trimmedChoice = typeof choice === 'string' ? choice.trim() : ''
        if (!trimmedChoice) {
          errors.push(`questions[${index}].choices[${choiceIndex}] must not be empty`)
          return
        }
        if (trimmedChoice.length > MAX_ARTIFACT_QUESTION_CHOICE_LENGTH) {
          errors.push(
            `questions[${index}].choices[${choiceIndex}] must be at most ${MAX_ARTIFACT_QUESTION_CHOICE_LENGTH} characters`
          )
          return
        }
        choices.push(trimmedChoice)
      })
    }

    if ((responseMode === 'single_select' || responseMode === 'multi_select') && choices.length < 2) {
      errors.push(`questions[${index}].choices must include at least two non-empty choices for ${responseMode}`)
    }

    if (parsedResponseMode.success) {
      questions.push({
        ...(title ? { title } : {}),
        question,
        ...(context ? { context } : {}),
        responseMode: parsedResponseMode.data,
        ...(choices.length > 0 ? { choices } : {}),
        ...(priority === 'low' || priority === 'normal' || priority === 'high' ? { priority } : {}),
      })
    }
  })

  return { questions, errors }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatArtifactQuestionInboxContent(manifest: ArtifactManifest, questions: ArtifactQuestion[]): string {
  const lines = [`Artifact: ${manifest.title} (${manifest.id})`, '', 'Questions:']

  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.title ? `${question.title}: ` : ''}${question.question}`)
    if (question.context) lines.push(`   Context: ${question.context}`)
    lines.push(`   Response mode: ${question.responseMode}`)
    if (question.choices && question.choices.length > 0) lines.push(`   Choices: ${question.choices.join(', ')}`)
    if (question.priority) lines.push(`   Priority: ${question.priority}`)
  })

  return lines.join('\n')
}

function formatArtifactQuestionMetadata(question: ArtifactQuestion): Record<string, unknown> {
  return {
    id: question.id,
    ...(question.title ? { title: question.title } : {}),
    question: question.question,
    ...(question.context ? { context: question.context } : {}),
    responseMode: question.responseMode,
    ...(question.choices ? { choices: question.choices } : {}),
    ...(question.priority ? { priority: question.priority } : {}),
  }
}

function validateStatusParams(params: { status?: ArtifactStatus; summary?: string }): string[] {
  const errors: string[] = []
  if (params.status !== undefined) {
    const parsedStatus = artifactStatusSchema.safeParse(params.status)
    if (!parsedStatus.success) {
      errors.push(...parsedStatus.error.issues.map((issue) => `Invalid artifact status: ${issue.message}`))
    }
  }
  if (params.summary !== undefined && params.summary.length === 0) {
    errors.push('Invalid artifact summary: summary must not be empty')
  }
  return errors
}

function trimOptionalToolString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim()
}

function emitArtifactUpdated(
  ctx: ArtifactToolsContext,
  manifest?: { id: string; title: string; summary?: string; status: ArtifactStatus; updatedAt: string }
): void {
  eventEmitter.emit('agent.updated', { agentId: ctx.agentId, squadId: ctx.squadId })
  if (manifest) {
    eventEmitter.emit('artifact.updated', {
      agentId: ctx.agentId,
      squadId: ctx.squadId,
      artifactId: manifest.id,
      title: manifest.title,
      ...(manifest.summary ? { summary: manifest.summary } : {}),
      status: manifest.status,
      updatedAt: manifest.updatedAt,
    })
  }
}

function formatManifestStatus(manifest: ArtifactManifest): string {
  const summary = manifest.summary ? ` Summary: ${manifest.summary}` : ''
  const entry = manifest.entry ? ` Entry: ${manifest.entry.type} at ${manifest.entry.path}.` : ''
  return `Artifact "${manifest.title}" (${manifest.id}) is ${manifest.status}.${summary}${entry}`
}

function artifactToolSuccess(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text }], details }
}

function artifactToolError(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], details }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
