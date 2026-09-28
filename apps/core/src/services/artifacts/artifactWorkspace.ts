import {
  artifactEntrySchema,
  artifactLocalPathSchema,
  artifactManifestSchema,
  artifactQuestionSchema,
  artifactPublishRecordSchema,
  artifactRequestSchema,
  artifactStatusSchema,
  type ArtifactManifest,
  type ArtifactPublishRecord,
  type ArtifactQuestion,
  type ArtifactQuestionPriority,
  type ArtifactQuestionResponseMode,
  type ArtifactReference,
  type ArtifactRequest,
  type ArtifactRequestAction,
} from '@ficus/shared'
import { randomUUID } from 'crypto'
import { existsSync, realpathSync } from 'fs'
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve, sep } from 'path'
import { KeyedSerialQueue } from '../../lib/infra/inflight'

const ARTIFACTS_DIR = 'artifacts'
const MANIFEST_FILE = 'manifest.json'
export const REQUESTS_FILE = 'manifest.requests.jsonl'
export const QUESTIONS_FILE = 'manifest.questions.jsonl'
export const PUBLISHES_FILE = 'manifest.publishes.jsonl'
const MAX_ARTIFACT_ID_LENGTH = 100
const MAX_CREATE_COLLISION_ATTEMPTS = 1000
const manifestMutationQueue = new KeyedSerialQueue()
let manifestWriteFailuresForTests = 0

type CreateArtifactParams = {
  agentWorkspacePath: string
  title: string
  brief: string
  references?: ArtifactReference[]
  displayModeHint?: string
}

type ArtifactWorkspaceParams = {
  agentWorkspacePath: string
  artifactId: string
}

type AppendArtifactAction = Extract<ArtifactRequestAction, 'continue' | 'fork'>

type AppendArtifactRequestParams = ArtifactWorkspaceParams & {
  action: AppendArtifactAction
  brief: string
  references?: ArtifactReference[]
}

type NewArtifactQuestionInput = {
  title?: string
  question: string
  context?: string
  responseMode: ArtifactQuestionResponseMode
  choices?: string[]
  priority?: ArtifactQuestionPriority
}

export type AppendArtifactQuestionsParams = ArtifactWorkspaceParams & {
  questions: NewArtifactQuestionInput[]
}

export type AppendArtifactQuestionsResult = {
  manifest: ArtifactManifest
  questions: ArtifactQuestion[]
}

export type AppendArtifactQuestionResponsesParams = ArtifactWorkspaceParams & {
  brief: string
  references?: ArtifactReference[]
  answers: Array<{ questionId: string; answer: string }>
}

type ResolveArtifactPathParams = ArtifactWorkspaceParams & {
  localPath: string
}

type MutateArtifactManifestParams = ArtifactWorkspaceParams & {
  mutate: (manifest: ArtifactManifest) => ArtifactManifest | Promise<ArtifactManifest>
}

type UpdateArtifactManifestWithPublishParams = ArtifactWorkspaceParams & {
  publish: ArtifactPublishRecord
  mutate: (manifest: ArtifactManifest) => ArtifactManifest | Promise<ArtifactManifest>
}

export type CreatedArtifact = {
  artifactId: string
  artifactPath: string
  manifest: ArtifactManifest
}

export function failNextArtifactManifestWritesForTests(count = 1): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test-only artifact manifest write failure hook')
  manifestWriteFailuresForTests = count
}

export function getArtifactsDirectory(agentWorkspacePath: string): string {
  return join(agentWorkspacePath, ARTIFACTS_DIR)
}

export function getArtifactDirectory(agentWorkspacePath: string, artifactId: string): string {
  assertSafeArtifactId(artifactId)
  return join(getArtifactsDirectory(agentWorkspacePath), artifactId)
}

export async function createArtifactInAgentWorkspace({
  agentWorkspacePath,
  title,
  brief,
  references,
  displayModeHint,
}: CreateArtifactParams): Promise<CreatedArtifact> {
  // The shared manifest schema does not currently have a display mode field.
  // Keep accepting this hint for future callers, but do not persist non-schema data.
  void displayModeHint

  const artifactsPath = getArtifactsDirectory(agentWorkspacePath)
  await mkdir(artifactsPath, { recursive: true })
  await assertArtifactsRootIsRealDirectory(agentWorkspacePath)
  assertArtifactsRootIsInsideWorkspace(agentWorkspacePath)

  const { artifactId, artifactPath } = await createUniqueArtifactDirectory({ agentWorkspacePath, title })

  const now = new Date().toISOString()

  try {
    const createRequest = parseBackendSidecarRecord(artifactRequestSchema, {
      at: now,
      from: 'voice',
      action: 'create',
      brief,
      ...(references ? { references } : {}),
    })
    const manifest: ArtifactManifest = {
      id: artifactId,
      title,
      status: 'working',
      createdAt: now,
      updatedAt: now,
      archived: false,
    }
    await appendArtifactRequests({
      agentWorkspacePath,
      artifactId,
      requests: [createRequest],
    })
    const canonicalManifest = await writeManifestAtomic({ agentWorkspacePath, artifactPath, manifest, strict: true })

    return { artifactId, artifactPath, manifest: canonicalManifest }
  } catch (error) {
    await rm(artifactPath, { recursive: true, force: true })
    throw error
  }
}

export async function readArtifactManifest({
  agentWorkspacePath,
  artifactId,
}: ArtifactWorkspaceParams): Promise<ArtifactManifest | null> {
  const artifactPath = getArtifactDirectory(agentWorkspacePath, artifactId)
  if (!existsSync(artifactPath)) return null
  assertArtifactDirectoryIsInsideArtifactsRoot({ agentWorkspacePath, artifactPath, localPath: MANIFEST_FILE })
  if (!isArtifactLocalPathSafe({ agentWorkspacePath, artifactPath, localPath: MANIFEST_FILE })) return null
  return readCanonicalManifestFromPath(artifactPath, artifactId)
}

export async function listArtifactManifests({
  agentWorkspacePath,
  includeArchived = false,
}: {
  agentWorkspacePath: string
  includeArchived?: boolean
}): Promise<ArtifactManifest[]> {
  const artifactsPath = getArtifactsDirectory(agentWorkspacePath)
  if (!existsSync(artifactsPath)) return []
  await assertArtifactsRootIsRealDirectory(agentWorkspacePath)
  assertArtifactsRootIsInsideWorkspace(agentWorkspacePath)

  const entries = await readdir(artifactsPath, { withFileTypes: true })
  const manifests: ArtifactManifest[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isSafeArtifactId(entry.name)) {
      console.warn(`Ignoring artifact directory with unsafe id: ${entry.name}`)
      continue
    }

    const manifest = await readArtifactManifest({ agentWorkspacePath, artifactId: entry.name })
    if (!manifest) continue
    if (!includeArchived && manifest.archived) continue
    manifests.push(manifest)
  }

  return manifests.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export async function readArtifactRequests(params: ArtifactWorkspaceParams): Promise<ArtifactRequest[]> {
  return readArtifactJsonlSidecar(params, REQUESTS_FILE, artifactRequestSchema, 'request')
}

export async function appendArtifactRequests({
  requests,
  ...params
}: ArtifactWorkspaceParams & { requests: ArtifactRequest[] }): Promise<void> {
  await withArtifactMutationQueue(params, () => appendArtifactRequestsUnqueued({ ...params, requests }))
}

export async function readArtifactQuestions(params: ArtifactWorkspaceParams): Promise<ArtifactQuestion[]> {
  return readArtifactJsonlSidecar(params, QUESTIONS_FILE, artifactQuestionSchema, 'question')
}

export async function writeArtifactQuestions({
  questions,
  ...params
}: ArtifactWorkspaceParams & { questions: ArtifactQuestion[] }): Promise<void> {
  await withArtifactMutationQueue(params, () => writeArtifactQuestionsUnqueued({ ...params, questions }))
}

export async function readArtifactPublishes(params: ArtifactWorkspaceParams): Promise<ArtifactPublishRecord[]> {
  return readArtifactJsonlSidecar(params, PUBLISHES_FILE, artifactPublishRecordSchema, 'publish record')
}

export async function appendArtifactPublishes({
  publishes,
  ...params
}: ArtifactWorkspaceParams & { publishes: ArtifactPublishRecord[] }): Promise<void> {
  await withArtifactMutationQueue(params, () => appendArtifactPublishesUnqueued({ ...params, publishes }))
}

export async function readArtifactHistory(params: ArtifactWorkspaceParams): Promise<{
  requests: ArtifactRequest[]
  questions: ArtifactQuestion[]
  publishes: ArtifactPublishRecord[]
}> {
  const [requests, questions, publishes] = await Promise.all([
    readArtifactRequests(params),
    readArtifactQuestions(params),
    readArtifactPublishes(params),
  ])
  return { requests, questions, publishes }
}

export async function appendArtifactRequest(params: AppendArtifactRequestParams): Promise<ArtifactManifest> {
  assertAppendArtifactAction(params.action)

  return withArtifactManifestMutation(params, async ({ agentWorkspacePath, artifactId, artifactPath, manifest }) => {
    const now = new Date().toISOString()
    const request = parseBackendSidecarRecord(artifactRequestSchema, {
      at: now,
      from: 'voice',
      action: params.action,
      brief: params.brief,
      ...(params.references ? { references: params.references } : {}),
    })
    const updated = copyManifestWithUpdates(manifest, artifactId, {
      status: 'working',
      updatedAt: now,
    })
    const existingRequests = await readArtifactRequests({ agentWorkspacePath, artifactId })
    await appendArtifactRequestsUnqueued({
      agentWorkspacePath,
      artifactId,
      requests: [request],
    })

    try {
      return await writeManifestAtomic({
        agentWorkspacePath,
        artifactPath,
        manifest: updated,
        strict: true,
      })
    } catch (error) {
      await writeArtifactRequestsUnqueued({ agentWorkspacePath, artifactId, requests: existingRequests })
      throw error
    }
  })
}

export async function appendArtifactQuestions(
  params: AppendArtifactQuestionsParams
): Promise<AppendArtifactQuestionsResult> {
  if (params.questions.length === 0) throw new Error('At least one artifact question is required')

  return withArtifactManifestMutation(params, async ({ agentWorkspacePath, artifactId, artifactPath, manifest }) => {
    if (manifest.archived) throw new Error(`Artifact is archived: ${artifactId}`)

    const now = new Date().toISOString()
    const existingQuestions = await readArtifactQuestions({ agentWorkspacePath, artifactId })
    const nextQuestionNumber = getNextArtifactQuestionNumber(existingQuestions)
    const nextQuestions = params.questions.map(
      (question, index): ArtifactQuestion => ({
        id: `q_${nextQuestionNumber + index}`,
        at: now,
        ...(question.title ? { title: question.title } : {}),
        question: question.question,
        ...(question.context ? { context: question.context } : {}),
        responseMode: question.responseMode,
        ...(question.choices ? { choices: question.choices } : {}),
        ...(question.priority ? { priority: question.priority } : {}),
        status: 'open',
      })
    )
    const updated = copyManifestWithUpdates(manifest, artifactId, {
      updatedAt: now,
    })
    await writeArtifactQuestionsUnqueued({
      agentWorkspacePath,
      artifactId,
      questions: [...existingQuestions, ...nextQuestions],
    })

    let updatedManifest: ArtifactManifest
    try {
      updatedManifest = await writeManifestAtomic({
        agentWorkspacePath,
        artifactPath,
        manifest: updated,
        strict: true,
      })
    } catch (error) {
      await writeArtifactQuestionsUnqueued({ agentWorkspacePath, artifactId, questions: existingQuestions })
      throw error
    }

    return { manifest: updatedManifest, questions: nextQuestions }
  })
}

export async function appendArtifactQuestionResponses(
  params: AppendArtifactQuestionResponsesParams
): Promise<ArtifactManifest> {
  if (params.answers.length === 0) throw new Error('At least one artifact question response is required')
  const answeredIds = new Set<string>()
  for (const answer of params.answers) {
    if (answeredIds.has(answer.questionId)) {
      throw new Error(`Duplicate artifact question response: ${answer.questionId}`)
    }
    answeredIds.add(answer.questionId)
  }

  return withArtifactManifestMutation(params, async ({ agentWorkspacePath, artifactId, artifactPath, manifest }) => {
    if (manifest.archived) throw new Error(`Artifact is archived: ${artifactId}`)

    const questions = await readArtifactQuestions({ agentWorkspacePath, artifactId })
    assertUniqueArtifactQuestionIds(questions)
    for (const { questionId } of params.answers) {
      if (!questions.some((question) => question.id === questionId)) {
        throw new Error(`Artifact question not found: ${questionId}`)
      }
    }

    const now = new Date().toISOString()
    const answersByQuestionId = new Map(params.answers.map((answer) => [answer.questionId, answer.answer]))
    const updatedQuestions = questions.map((question): ArtifactQuestion => {
      const answer = answersByQuestionId.get(question.id)
      if (answer === undefined) return question
      return {
        ...question,
        status: 'answered',
        response: { at: now, from: 'voice', answer, brief: params.brief },
      }
    })
    const request = parseBackendSidecarRecord(artifactRequestSchema, {
      at: now,
      from: 'voice',
      action: 'continue',
      brief: params.brief,
      ...(params.references ? { references: params.references } : {}),
    })
    const updated = copyManifestWithUpdates(manifest, artifactId, {
      status: 'working',
      updatedAt: now,
    })
    const existingRequests = await readArtifactRequests({ agentWorkspacePath, artifactId })
    await writeArtifactQuestionsUnqueued({ agentWorkspacePath, artifactId, questions: updatedQuestions })
    await appendArtifactRequestsUnqueued({
      agentWorkspacePath,
      artifactId,
      requests: [request],
    })

    try {
      return await writeManifestAtomic({
        agentWorkspacePath,
        artifactPath,
        manifest: updated,
        strict: true,
      })
    } catch (error) {
      await writeArtifactQuestionsUnqueued({ agentWorkspacePath, artifactId, questions })
      await writeArtifactRequestsUnqueued({ agentWorkspacePath, artifactId, requests: existingRequests })
      throw error
    }
  })
}

export async function archiveArtifact(
  params: ArtifactWorkspaceParams & { brief: string; references?: ArtifactReference[] }
): Promise<ArtifactManifest> {
  return withArtifactManifestMutation(params, async ({ agentWorkspacePath, artifactId, artifactPath, manifest }) => {
    const now = new Date().toISOString()
    const request = parseBackendSidecarRecord(artifactRequestSchema, {
      at: now,
      from: 'voice',
      action: 'archive',
      brief: params.brief,
      ...(params.references ? { references: params.references } : {}),
    })
    const updated = copyManifestWithUpdates(manifest, artifactId, {
      updatedAt: now,
      archived: true,
    })
    const existingRequests = await readArtifactRequests({ agentWorkspacePath, artifactId })
    await appendArtifactRequestsUnqueued({
      agentWorkspacePath,
      artifactId,
      requests: [request],
    })

    try {
      return await writeManifestAtomic({
        agentWorkspacePath,
        artifactPath,
        manifest: updated,
        strict: true,
      })
    } catch (error) {
      await writeArtifactRequestsUnqueued({ agentWorkspacePath, artifactId, requests: existingRequests })
      throw error
    }
  })
}

export async function mutateArtifactManifest({
  agentWorkspacePath,
  artifactId,
  mutate,
}: MutateArtifactManifestParams): Promise<ArtifactManifest> {
  return withArtifactManifestMutation({ agentWorkspacePath, artifactId }, async (context) => {
    const updated = await mutate(context.manifest)
    return writeManifestAtomic({
      agentWorkspacePath: context.agentWorkspacePath,
      artifactPath: context.artifactPath,
      manifest: updated,
      strict: true,
    })
  })
}

export async function updateArtifactManifestWithPublish({
  agentWorkspacePath,
  artifactId,
  publish,
  mutate,
}: UpdateArtifactManifestWithPublishParams): Promise<ArtifactManifest> {
  return withArtifactManifestMutation({ agentWorkspacePath, artifactId }, async (context) => {
    const existingPublishes = await readArtifactPublishes({ agentWorkspacePath, artifactId })
    const updated = await mutate(context.manifest)

    await appendArtifactPublishesUnqueued({
      agentWorkspacePath,
      artifactId,
      publishes: [publish],
    })

    try {
      return await writeManifestAtomic({
        agentWorkspacePath: context.agentWorkspacePath,
        artifactPath: context.artifactPath,
        manifest: updated,
        strict: true,
      })
    } catch (error) {
      await writeArtifactPublishesUnqueued({ agentWorkspacePath, artifactId, publishes: existingPublishes })
      throw error
    }
  })
}

export async function deleteArtifact({ agentWorkspacePath, artifactId }: ArtifactWorkspaceParams): Promise<void> {
  const artifactPath = getArtifactDirectory(agentWorkspacePath, artifactId)
  if (!existsSync(artifactPath)) return
  assertArtifactDirectoryIsInsideArtifactsRoot({ agentWorkspacePath, artifactPath, localPath: artifactId })
  await rm(artifactPath, { recursive: true, force: true })
}

export function resolveArtifactPath({ agentWorkspacePath, artifactId, localPath }: ResolveArtifactPathParams): string {
  const parsed = artifactLocalPathSchema.safeParse(localPath)
  if (!parsed.success) {
    throw new Error(`Invalid artifact path: ${localPath}`)
  }

  const artifactPath = getArtifactDirectory(agentWorkspacePath, artifactId)
  const resolvedArtifactPath = resolve(artifactPath)
  const resolvedLocalPath = resolve(artifactPath, parsed.data)

  if (!isPathInside(resolvedLocalPath, resolvedArtifactPath)) {
    throw new Error(`Invalid artifact path: ${localPath}`)
  }

  assertNoSymlinkEscape({ agentWorkspacePath, artifactPath, localPath: parsed.data })

  return resolvedLocalPath
}

async function readCanonicalManifestFromPath(
  artifactPath: string,
  artifactId: string
): Promise<ArtifactManifest | null> {
  // v1 uses manifest.json as the single file-backed source of truth. This is
  // validation/canonicalization, not tamper-proof integrity: agents can edit files
  // in their workspace. True backend ownership would require file permissions or
  // state outside the agent workspace, which is intentionally out of scope here.
  const publicManifest = await readManifestFile(join(artifactPath, MANIFEST_FILE), artifactId)
  if (!publicManifest) return null
  return publicManifest
}

async function readManifestFile(manifestPath: string, artifactId: string): Promise<ArtifactManifest | null> {
  let raw: string

  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (error) {
    console.warn(`Ignoring malformed artifact manifest at ${manifestPath}: invalid JSON`, error)
    return null
  }

  return canonicalizeManifest(parsedJson, artifactId, manifestPath)
}

function canonicalizeManifest(
  rawManifest: unknown,
  artifactId: string,
  manifestPath = MANIFEST_FILE
): ArtifactManifest | null {
  if (!isRecord(rawManifest)) {
    console.warn(`Ignoring malformed artifact manifest at ${manifestPath}: expected object`)
    return null
  }

  // This normalizes file-backed v1 manifests only. It is not tamper-proof:
  // schema-valid agent edits can still be accepted on read. Backend-controlled
  // operations below reconstruct the manifest and explicitly set fields they own
  // (for example request history appends, archive state, and updatedAt) instead
  // of blindly spreading parsed JSON.
  const now = new Date().toISOString()
  const title = readNonEmptyString(rawManifest.title) ?? artifactId
  const statusResult = artifactStatusSchema.safeParse(rawManifest.status)
  const status = statusResult.success ? statusResult.data : 'working'
  const summary = readNonEmptyString(rawManifest.summary)
  const entryResult = artifactEntrySchema.safeParse(rawManifest.entry)
  const createdAt = readNonEmptyString(rawManifest.createdAt) ?? now
  const updatedAt = readNonEmptyString(rawManifest.updatedAt) ?? createdAt
  const archived = typeof rawManifest.archived === 'boolean' ? rawManifest.archived : false

  const canonicalManifest: ArtifactManifest = {
    id: artifactId,
    title,
    status,
    ...(summary ? { summary } : {}),
    ...(entryResult.success ? { entry: entryResult.data } : {}),
    createdAt,
    updatedAt,
    archived,
  }

  const parsed = artifactManifestSchema.safeParse(canonicalManifest)
  if (!parsed.success) {
    console.warn(`Ignoring malformed artifact manifest at ${manifestPath}:`, parsed.error)
    return null
  }

  return parsed.data
}

function getNextArtifactQuestionNumber(questions: ArtifactQuestion[]): number {
  let maxQuestionNumber = 0
  for (const question of questions) {
    const match = /^q_(\d+)$/.exec(question.id)
    if (!match) continue
    maxQuestionNumber = Math.max(maxQuestionNumber, Number(match[1]))
  }
  return maxQuestionNumber + 1
}

function assertUniqueArtifactQuestionIds(questions: ArtifactQuestion[]): void {
  const seen = new Set<string>()
  for (const question of questions) {
    if (seen.has(question.id)) {
      throw new Error(`Duplicate artifact question id in manifest: ${question.id}`)
    }
    seen.add(question.id)
  }
}

function copyManifestWithUpdates(
  manifest: ArtifactManifest,
  artifactId: string,
  overrides: Partial<ArtifactManifest>
): ArtifactManifest {
  return {
    id: artifactId,
    title: manifest.title,
    status: manifest.status,
    ...(manifest.summary ? { summary: manifest.summary } : {}),
    ...(manifest.entry ? { entry: manifest.entry } : {}),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    archived: manifest.archived,
    ...overrides,
  }
}

type SidecarSchema<T> = {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: unknown }
}

async function readArtifactJsonlSidecar<T>(
  params: ArtifactWorkspaceParams,
  fileName: string,
  schema: SidecarSchema<T>,
  label: string
): Promise<T[]> {
  const { path } = getArtifactSidecarPath(params, fileName)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return []
    throw error
  }

  const records: T[] = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(line)
    } catch (error) {
      console.warn(`Repairing artifact sidecar at ${path}:${index + 1}: dropping invalid JSON line`, error)
      continue
    }
    const parsed = schema.safeParse(parsedJson)
    if (parsed.success) {
      records.push(parsed.data)
    } else {
      console.warn(`Repairing artifact sidecar at ${path}:${index + 1}: dropping invalid ${label}`, parsed.error)
    }
  }

  return records
}

async function appendArtifactRequestsUnqueued({
  requests,
  ...params
}: ArtifactWorkspaceParams & { requests: ArtifactRequest[] }): Promise<void> {
  await appendArtifactJsonlSidecar(params, REQUESTS_FILE, artifactRequestSchema, requests)
}

async function writeArtifactRequestsUnqueued({
  requests,
  ...params
}: ArtifactWorkspaceParams & { requests: ArtifactRequest[] }): Promise<void> {
  await writeArtifactJsonlSidecar(params, REQUESTS_FILE, artifactRequestSchema, requests)
}

async function writeArtifactQuestionsUnqueued({
  questions,
  ...params
}: ArtifactWorkspaceParams & { questions: ArtifactQuestion[] }): Promise<void> {
  await writeArtifactJsonlSidecar(params, QUESTIONS_FILE, artifactQuestionSchema, questions)
}

async function appendArtifactPublishesUnqueued({
  publishes,
  ...params
}: ArtifactWorkspaceParams & { publishes: ArtifactPublishRecord[] }): Promise<void> {
  await appendArtifactJsonlSidecar(params, PUBLISHES_FILE, artifactPublishRecordSchema, publishes)
}

async function writeArtifactPublishesUnqueued({
  publishes,
  ...params
}: ArtifactWorkspaceParams & { publishes: ArtifactPublishRecord[] }): Promise<void> {
  await writeArtifactJsonlSidecar(params, PUBLISHES_FILE, artifactPublishRecordSchema, publishes)
}

async function appendArtifactJsonlSidecar<T>(
  params: ArtifactWorkspaceParams,
  fileName: string,
  schema: SidecarSchema<T>,
  records: T[]
): Promise<void> {
  if (records.length === 0) return
  const { path } = getArtifactSidecarPath(params, fileName)
  const lines = records.map((record) => JSON.stringify(parseBackendSidecarRecord(schema, record))).join('\n')
  await appendFile(path, `${lines}\n`, 'utf8')
}

async function writeArtifactJsonlSidecar<T>(
  params: ArtifactWorkspaceParams,
  fileName: string,
  schema: SidecarSchema<T>,
  records: T[]
): Promise<void> {
  const { path } = getArtifactSidecarPath(params, fileName)
  const value = records.map((record) => JSON.stringify(parseBackendSidecarRecord(schema, record))).join('\n')
  await writeTextAtomic(path, value.length > 0 ? `${value}\n` : '')
}

function parseBackendSidecarRecord<T>(schema: SidecarSchema<T>, record: unknown): T {
  const parsed = schema.safeParse(record)
  if (!parsed.success) throw parsed.error
  return parsed.data
}

function getArtifactSidecarPath(
  params: ArtifactWorkspaceParams,
  fileName: string
): { artifactPath: string; path: string } {
  const artifactPath = getArtifactDirectory(params.agentWorkspacePath, params.artifactId)
  assertArtifactDirectoryIsInsideArtifactsRoot({
    agentWorkspacePath: params.agentWorkspacePath,
    artifactPath,
    localPath: fileName,
  })
  assertNoSymlinkEscape({ agentWorkspacePath: params.agentWorkspacePath, artifactPath, localPath: fileName })
  return { artifactPath, path: join(artifactPath, fileName) }
}

function validateBackendManifest(manifest: ArtifactManifest): ArtifactManifest | null {
  const parsed = artifactManifestSchema.safeParse(manifest)
  if (!parsed.success) {
    throw parsed.error
  }
  return parsed.data
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function assertAppendArtifactAction(action: ArtifactRequestAction): asserts action is AppendArtifactAction {
  if (action !== 'continue' && action !== 'fork') {
    throw new Error(`Invalid append artifact action: ${action}`)
  }
}

function assertNoSymlinkEscape({
  agentWorkspacePath,
  artifactPath,
  localPath,
}: {
  agentWorkspacePath: string
  artifactPath: string
  localPath: string
}): void {
  if (!isArtifactLocalPathSafe({ agentWorkspacePath, artifactPath, localPath })) {
    throw new Error(`Invalid artifact path: ${localPath}`)
  }
}

function isArtifactLocalPathSafe({
  agentWorkspacePath,
  artifactPath,
  localPath,
}: {
  agentWorkspacePath: string
  artifactPath: string
  localPath: string
}): boolean {
  const realArtifactPath = assertArtifactDirectoryIsInsideArtifactsRoot({ agentWorkspacePath, artifactPath, localPath })
  let existingPath = artifactPath

  for (const segment of localPath.split('/')) {
    existingPath = join(existingPath, segment)
    if (!existsSync(existingPath)) break

    const realExistingPath = realpathSync(existingPath)
    if (!isPathInside(realExistingPath, realArtifactPath)) return false
  }

  return true
}

function assertArtifactDirectoryIsInsideArtifactsRoot({
  agentWorkspacePath,
  artifactPath,
  localPath,
}: {
  agentWorkspacePath: string
  artifactPath: string
  localPath: string
}): string {
  const realArtifactsPath = assertArtifactsRootIsInsideWorkspace(agentWorkspacePath)
  const realArtifactPath = realpathSync(artifactPath)
  const expectedArtifactPath = resolve(realArtifactsPath, basename(artifactPath))
  if (realArtifactPath !== expectedArtifactPath) {
    throw new Error(`Invalid artifact path: ${localPath}`)
  }
  return realArtifactPath
}

async function assertArtifactsRootIsRealDirectory(agentWorkspacePath: string): Promise<void> {
  const artifactsPath = getArtifactsDirectory(agentWorkspacePath)
  const stats = await lstat(artifactsPath)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Invalid artifact path: ${ARTIFACTS_DIR}`)
  }
}

function assertArtifactsRootIsInsideWorkspace(agentWorkspacePath: string): string {
  const realWorkspacePath = realpathSync(agentWorkspacePath)
  const artifactsPath = getArtifactsDirectory(agentWorkspacePath)
  const realArtifactsPath = realpathSync(artifactsPath)
  const expectedArtifactsPath = resolve(realWorkspacePath, ARTIFACTS_DIR)
  if (realArtifactsPath !== expectedArtifactsPath) {
    throw new Error(`Invalid artifact path: ${ARTIFACTS_DIR}`)
  }
  return realArtifactsPath
}

function isPathInside(path: string, parentPath: string): boolean {
  return path === parentPath || path.startsWith(`${parentPath}${sep}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// In-process only: this prevents lost updates within one API process. Cross-process
// file locking/durability is intentionally out of scope for the v1 filesystem service.
async function withArtifactManifestMutation<T = ArtifactManifest>(
  { agentWorkspacePath, artifactId }: ArtifactWorkspaceParams,
  mutate: (context: {
    agentWorkspacePath: string
    artifactId: string
    artifactPath: string
    manifest: ArtifactManifest
  }) => Promise<T>
): Promise<T> {
  return withArtifactMutationQueue({ agentWorkspacePath, artifactId }, async () => {
    const artifactPath = getArtifactDirectory(agentWorkspacePath, artifactId)
    const manifest = await readArtifactManifest({ agentWorkspacePath, artifactId })
    if (!manifest) {
      throw new Error(`Artifact manifest not found or invalid: ${artifactId}`)
    }
    return mutate({ agentWorkspacePath, artifactId, artifactPath, manifest })
  })
}

async function withArtifactMutationQueue<T>(
  { agentWorkspacePath, artifactId }: ArtifactWorkspaceParams,
  mutate: () => Promise<T>
): Promise<T> {
  const queueKey = `${realpathSync(agentWorkspacePath)}:${artifactId}`
  return manifestMutationQueue.run(queueKey, mutate)
}

async function writeManifestAtomic({
  agentWorkspacePath,
  artifactPath,
  manifest,
  strict = false,
}: {
  agentWorkspacePath: string
  artifactPath: string
  manifest: ArtifactManifest
  strict?: boolean
}): Promise<ArtifactManifest> {
  // Symlink checks are best-effort hardening for normal workspace use. They do
  // not make this write safe against a malicious concurrent process swapping
  // directories or files between validation and rename (TOCTOU). Stronger
  // protection would require restrictive filesystem permissions or
  // descriptor-based no-follow writes, which are out of scope for this v1
  // file-backed service.
  assertNoSymlinkEscape({ agentWorkspacePath, artifactPath, localPath: MANIFEST_FILE })
  if (manifestWriteFailuresForTests > 0) {
    manifestWriteFailuresForTests -= 1
    throw new Error('Injected artifact manifest write failure')
  }
  const canonicalManifest = strict ? validateBackendManifest(manifest) : canonicalizeManifest(manifest, manifest.id)
  if (!canonicalManifest) {
    throw new Error(`Invalid artifact manifest: ${manifest.id}`)
  }
  await writeJsonAtomic(join(artifactPath, MANIFEST_FILE), canonicalManifest)
  return canonicalManifest
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeTextAtomic(path: string, value: string): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)

  try {
    await writeFile(tempPath, value, 'utf8')
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

async function createUniqueArtifactDirectory({
  agentWorkspacePath,
  title,
}: {
  agentWorkspacePath: string
  title: string
}): Promise<{ artifactId: string; artifactPath: string }> {
  const baseSlug = truncateSlug(slugifyTitle(title), MAX_ARTIFACT_ID_LENGTH)
  let suffix = 1

  while (suffix <= MAX_CREATE_COLLISION_ATTEMPTS) {
    const suffixText = suffix === 1 ? '' : `-${suffix}`
    const artifactId = `${truncateSlug(baseSlug, MAX_ARTIFACT_ID_LENGTH - suffixText.length)}${suffixText}`
    const artifactPath = getArtifactDirectory(agentWorkspacePath, artifactId)

    try {
      await mkdir(artifactPath, { recursive: false })
      return { artifactId, artifactPath }
    } catch (error) {
      if (isFileExistsError(error)) {
        suffix += 1
        continue
      }
      throw error
    }
  }

  throw new Error(`Unable to create a unique artifact directory for title: ${title}`)
}

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'artifact'
}

function truncateSlug(slug: string, maxLength: number): string {
  const truncated = slug.slice(0, maxLength).replace(/-+$/g, '')
  return truncated || 'artifact'
}

function assertSafeArtifactId(artifactId: string): void {
  if (!isSafeArtifactId(artifactId)) {
    throw new Error(`Invalid artifact id: ${artifactId}`)
  }
}

function isSafeArtifactId(artifactId: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(artifactId)
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
