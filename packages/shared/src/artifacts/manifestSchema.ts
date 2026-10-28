import { z } from 'zod'

export const artifactEntryTypeSchema = z.enum(['presentation', 'markdown', 'html', 'sandbox_app'])

export const artifactLocalPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/'), 'Path must be relative')
  .refine((path) => !/^[A-Za-z]:/.test(path), 'Path must not use a Windows drive prefix')
  .refine((path) => !path.includes('\\'), 'Path must use forward slashes')
  .refine(
    (path) => path.split('/').every((segment) => segment.length > 0 && segment !== '..'),
    'Path must not contain empty or parent directory segments'
  )

export const artifactEntrySchema = z.strictObject({
  type: artifactEntryTypeSchema,
  path: artifactLocalPathSchema,
})

export const artifactStatusSchema = z.enum(['working', 'ready', 'error'])

export const artifactRequestActionSchema = z.enum(['create', 'continue', 'ask', 'fork', 'archive', 'delete'])

export const artifactPublishRecordSchema = z.strictObject({
  at: z.string().min(1),
  entry: artifactEntrySchema,
  status: artifactStatusSchema,
  changeSummary: z.string().min(1),
  changeDetails: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
})

export const artifactReferenceTypeSchema = z.enum(['agent', 'thread', 'workstream', 'url', 'file', 'api', 'artifact'])

const artifactReferenceNoteSchema = z.string().min(1).optional()

export const agentArtifactReferenceSchema = z.strictObject({
  type: z.literal('agent'),
  id: z.string().min(1),
  note: artifactReferenceNoteSchema,
})

export const threadArtifactReferenceSchema = z.strictObject({
  type: z.literal('thread'),
  id: z.string().min(1),
  note: artifactReferenceNoteSchema,
})

export const workstreamArtifactReferenceSchema = z.strictObject({
  type: z.literal('workstream'),
  id: z.string().min(1),
  note: artifactReferenceNoteSchema,
})

export const urlArtifactReferenceSchema = z.strictObject({
  type: z.literal('url'),
  url: z.string().min(1).url(),
  note: artifactReferenceNoteSchema,
})

export const fileArtifactReferenceSchema = z.strictObject({
  type: z.literal('file'),
  path: artifactLocalPathSchema,
  note: artifactReferenceNoteSchema,
})

const apiArtifactReferenceWithIdSchema = z.strictObject({
  type: z.literal('api'),
  id: z.string().min(1),
  url: z.string().min(1).url().optional(),
  note: artifactReferenceNoteSchema,
})

const apiArtifactReferenceWithUrlSchema = z.strictObject({
  type: z.literal('api'),
  id: z.string().min(1).optional(),
  url: z.string().min(1).url(),
  note: artifactReferenceNoteSchema,
})

export const apiArtifactReferenceSchema = z.union([apiArtifactReferenceWithIdSchema, apiArtifactReferenceWithUrlSchema])

export const artifactArtifactReferenceSchema = z.strictObject({
  type: z.literal('artifact'),
  id: z.string().min(1),
  note: artifactReferenceNoteSchema,
})

export const artifactReferenceSchema = z.union([
  agentArtifactReferenceSchema,
  threadArtifactReferenceSchema,
  workstreamArtifactReferenceSchema,
  urlArtifactReferenceSchema,
  fileArtifactReferenceSchema,
  apiArtifactReferenceSchema,
  artifactArtifactReferenceSchema,
])

export const artifactRequestSchema = z.strictObject({
  at: z.string().min(1),
  from: z.literal('voice'),
  action: artifactRequestActionSchema,
  brief: z.string().min(1),
  references: z.array(artifactReferenceSchema).optional(),
})

export const artifactQuestionResponseModeSchema = z.enum(['free_text', 'single_select', 'multi_select'])
export const artifactQuestionPrioritySchema = z.enum(['low', 'normal', 'high'])
export const artifactQuestionStatusSchema = z.enum(['open', 'answered'])

export const artifactQuestionResponseSchema = z.strictObject({
  at: z.string().min(1),
  from: z.literal('voice'),
  answer: z.string().min(1),
  brief: z.string().min(1),
})

export const artifactQuestionSchema = z.strictObject({
  id: z.string().min(1),
  at: z.string().min(1),
  title: z.string().min(1).optional(),
  question: z.string().min(1),
  context: z.string().min(1).optional(),
  responseMode: artifactQuestionResponseModeSchema,
  choices: z.array(z.string().min(1)).optional(),
  priority: artifactQuestionPrioritySchema.optional(),
  status: artifactQuestionStatusSchema,
  response: artifactQuestionResponseSchema.optional(),
})

export const artifactManifestSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  status: artifactStatusSchema,
  summary: z.string().min(1).optional(),
  entry: artifactEntrySchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  archived: z.boolean(),
})

export type ArtifactEntryType = z.infer<typeof artifactEntryTypeSchema>
export type ArtifactLocalPath = z.infer<typeof artifactLocalPathSchema>
export type ArtifactEntry = z.infer<typeof artifactEntrySchema>
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>
export type ArtifactRequestAction = z.infer<typeof artifactRequestActionSchema>
export type ArtifactReferenceType = z.infer<typeof artifactReferenceTypeSchema>
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>
export type ArtifactPublishRecord = z.infer<typeof artifactPublishRecordSchema>
export type ArtifactRequest = z.infer<typeof artifactRequestSchema>
export type ArtifactQuestionResponseMode = z.infer<typeof artifactQuestionResponseModeSchema>
export type ArtifactQuestionPriority = z.infer<typeof artifactQuestionPrioritySchema>
export type ArtifactQuestionStatus = z.infer<typeof artifactQuestionStatusSchema>
export type ArtifactQuestionResponse = z.infer<typeof artifactQuestionResponseSchema>
export type ArtifactQuestion = z.infer<typeof artifactQuestionSchema>
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>
