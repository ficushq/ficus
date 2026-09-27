import type {
  ArtifactManifest,
  ArtifactPublishRecord,
  ArtifactQuestion,
  ArtifactReference,
  ArtifactRequest,
  ArtifactRequestAction,
  Presentation,
} from '@ficus/shared'
import { Buffer } from 'node:buffer'
import { lstat, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Agent, agentWorkspaceSandboxId, type CreateAgentInput } from '../../entities/Agent'
import { InboxMessage, type SendInboxMessageInput } from '../../entities/InboxMessage'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../../entities/agent-runners/constants'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { getAgentWorkspaceStoragePath } from '../sandbox/ensure'
import { readUtf8RegularFileNoFollowBounded } from './artifactFiles'
import { listArtifactIndex, type ArtifactIndexAgent, type ArtifactIndexResult } from './artifactIndex'
import { getArtifactEntryMaxBytes, publishArtifact } from './artifactPublish'
import {
  appendArtifactQuestionResponses,
  appendArtifactRequest,
  archiveArtifact,
  createArtifactInAgentWorkspace,
  deleteArtifact,
  getArtifactDirectory,
  readArtifactHistory,
  readArtifactManifest,
  resolveArtifactPath,
} from './artifactWorkspace'

const ARTIFACT_BUILDER_SPECIAL_ROLE = 'artifact-builder'

type VoiceArtifactAgent = ArtifactIndexAgent & {
  id: string
  agentTypeId: string
  metadata?: Record<string, unknown> | null
  workspacePath?: string
  squadId?: string | null
  context?: unknown
}

export type ListVoiceArtifactsParams = {
  includeArchived?: boolean
  query?: string
}

export type ArtifactHistoryResult = {
  requests: ArtifactRequest[]
  questions: ArtifactQuestion[]
  publishes: ArtifactPublishRecord[]
}

export type ArtifactContextResult = {
  agentId: string
  artifactId: string
  artifactPath: string
  manifest: ArtifactManifest
  history: ArtifactHistoryResult
  content?: unknown
}

export type VoiceArtifactQuestionAnswerInput = {
  questionId: string
  answer: string
}

export type VoiceArtifactRequestInput = {
  action: ArtifactRequestAction
  title?: string
  agentId?: string
  artifactId?: string
  brief: string
  references?: ArtifactReference[]
  displayModeHint?: string
  answers?: VoiceArtifactQuestionAnswerInput[]
}

export type VoiceArtifactRequestResult = {
  action: ArtifactRequestAction
  agentId: string
  artifactId: string
  artifactPath?: string
  manifest?: ArtifactManifest
  deleted?: boolean
  inboxDeliveryFailed?: boolean
  message?: string
}

export type ArtifactPrewarmResult = {
  agentId: string
  sandboxId: string
  reused: boolean
}

export type ArtifactFileListItem = {
  path: string
  type: 'file' | 'directory'
  sizeBytes?: number
}

export type ArtifactFileReadInput = {
  agentId: string
  artifactId: string
  path: string
  unit?: 'lines' | 'bytes'
  offset?: number
  limit?: number
}

export type ArtifactFileReadResult = {
  path: string
  content: string
  unit: 'lines' | 'bytes'
  offset: number
  limit: number
  sizeBytes: number
  totalLines?: number
  truncated: boolean
  nextOffset?: number
  entryPath?: string
  artifactType?: string
}

export type ArtifactFileTextEdit = {
  oldText: string
  newText: string
}

export type ArtifactFileEditInput = {
  agentId: string
  artifactId: string
  path: string
  oldText?: string
  newText?: string
  edits?: ArtifactFileTextEdit[]
  changeSummary: string
}

export type ArtifactFileEditResult = {
  ok: true
  changed: boolean
  editsApplied: number
  manifest: ArtifactManifest
}

type CreateAgentFn = (input: CreateAgentInput) => Promise<VoiceArtifactAgent>
type FindAgentFn = (id: string) => Promise<VoiceArtifactAgent | null>
type ListAgentsFn = () => Promise<VoiceArtifactAgent[]>
type GetAgentWorkspacePathFn = (agent: ArtifactIndexAgent) => string | Promise<string>
type SendInboxMessageFn = (message: SendInboxMessageInput) => Promise<unknown>

export type ArtifactVoiceRequestServiceDeps = {
  createAgent?: CreateAgentFn
  findAgent?: FindAgentFn
  listAgents?: ListAgentsFn
  getAgentWorkspacePath?: GetAgentWorkspacePathFn
  sendInboxMessage?: SendInboxMessageFn
}

export function createArtifactVoiceRequestService(deps: ArtifactVoiceRequestServiceDeps = {}) {
  const createAgent = deps.createAgent ?? defaultCreateAgent
  const findAgent = deps.findAgent ?? defaultFindAgent
  const listAgents = deps.listAgents ?? defaultListAgents
  const getAgentWorkspacePath = deps.getAgentWorkspacePath ?? defaultGetAgentWorkspacePath
  const sendInboxMessage = deps.sendInboxMessage ?? defaultSendInboxMessage
  const autoPrewarmNext = !deps.createAgent && !deps.listAgents && !deps.getAgentWorkspacePath

  async function listArtifacts(params: ListVoiceArtifactsParams = {}): Promise<ArtifactIndexResult[]> {
    return listArtifactIndex({
      agents: await listAgents(),
      includeArchived: params.includeArchived,
      query: params.query,
      getAgentWorkspacePath,
    })
  }

  async function getArtifactContext(agentId: string, artifactId: string): Promise<ArtifactContextResult> {
    const { agent, agentWorkspacePath, manifest } = await resolveExistingArtifact(
      agentId,
      artifactId,
      findAgent,
      getAgentWorkspacePath
    )

    const history = await readArtifactHistory({ agentWorkspacePath, artifactId: manifest.id })
    const context: ArtifactContextResult = {
      agentId: agent.id,
      artifactId: manifest.id,
      artifactPath: getArtifactDirectory(agentWorkspacePath, manifest.id),
      manifest,
      history,
    }

    if (manifest.entry) {
      try {
        context.content = await readArtifactEntryContent({ agentWorkspacePath, manifest })
      } catch (error) {
        console.warn(`Could not read artifact content for ${manifest.id}`, error)
      }
    }

    return context
  }

  async function listArtifactFiles(agentId: string, artifactId: string): Promise<{ files: ArtifactFileListItem[] }> {
    const { agentWorkspacePath, manifest } = await resolveExistingArtifact(
      agentId,
      artifactId,
      findAgent,
      getAgentWorkspacePath
    )
    const artifactPath = getArtifactDirectory(agentWorkspacePath, manifest.id)
    const files: ArtifactFileListItem[] = []

    async function visit(relativeDir: string): Promise<void> {
      const dir = relativeDir
        ? resolveArtifactPath({ agentWorkspacePath, artifactId: manifest.id, localPath: relativeDir })
        : artifactPath
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const localPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
        const resolved = resolveArtifactPath({ agentWorkspacePath, artifactId: manifest.id, localPath })
        const stats = await lstat(resolved)
        if (stats.isDirectory()) {
          files.push({ path: localPath, type: 'directory' })
          await visit(localPath)
        } else if (stats.isFile()) {
          files.push({ path: localPath, type: 'file', sizeBytes: stats.size })
        }
      }
    }

    await visit('')
    return {
      files: files.filter((file) => !isArtifactMetadataFile(file.path)).sort((a, b) => a.path.localeCompare(b.path)),
    }
  }

  async function readArtifactFile(input: ArtifactFileReadInput): Promise<ArtifactFileReadResult> {
    const { agentWorkspacePath, manifest } = await resolveExistingArtifact(
      input.agentId,
      input.artifactId,
      findAgent,
      getAgentWorkspacePath
    )
    const path = normalizeArtifactFilePath(input.path)
    rejectArtifactMetadataFile(path)
    const resolvedPath = resolveArtifactPath({ agentWorkspacePath, artifactId: manifest.id, localPath: path })
    const raw = await readUtf8RegularFileNoFollowBounded(resolvedPath, getArtifactFileMaxReadBytes())
    const sizeBytes = Buffer.byteLength(raw, 'utf8')
    const unit = input.unit === 'bytes' ? 'bytes' : 'lines'
    const limit = normalizeReadLimit(input.limit, unit)
    const offset = normalizeReadOffset(input.offset, unit)

    if (unit === 'bytes') {
      const content = raw.slice(offset, offset + limit)
      const nextOffset = offset + content.length < raw.length ? offset + content.length : undefined
      return buildReadResult({
        input,
        manifest,
        path,
        content,
        unit,
        offset,
        limit,
        sizeBytes,
        truncated: nextOffset !== undefined,
        nextOffset,
      })
    }

    const lines = raw.split('\n')
    const totalLines = raw.endsWith('\n') ? lines.length - 1 : lines.length
    const start = Math.max(offset - 1, 0)
    const selected = lines.slice(start, start + limit)
    const nextOffset = start + selected.length < totalLines ? offset + selected.length : undefined
    return buildReadResult({
      input,
      manifest,
      path,
      content: selected.join('\n'),
      unit,
      offset,
      limit,
      sizeBytes,
      totalLines,
      truncated: nextOffset !== undefined,
      nextOffset,
    })
  }

  async function editArtifactFile(input: ArtifactFileEditInput): Promise<ArtifactFileEditResult> {
    const { agent, agentWorkspacePath, manifest } = await resolveExistingArtifact(
      input.agentId,
      input.artifactId,
      findAgent,
      getAgentWorkspacePath
    )
    const path = normalizeArtifactFilePath(input.path)
    rejectArtifactMetadataFile(path)
    const edits = normalizeArtifactFileTextEdits(input)
    if (!input.changeSummary.trim()) throw new Error('changeSummary is required')
    const resolvedPath = resolveArtifactPath({ agentWorkspacePath, artifactId: manifest.id, localPath: path })
    const current = await readUtf8RegularFileNoFollowBounded(resolvedPath, getArtifactFileMaxReadBytes())
    const next = applyExactTextEdits(current, edits)
    if (next === current) return { ok: true, changed: false, editsApplied: 0, manifest }
    assertDirectEditSize(next)
    await writeFile(resolvedPath, next, 'utf8')

    const publish = manifest.entry
      ? await publishArtifact({
          agentWorkspacePath,
          artifactId: manifest.id,
          entry: manifest.entry,
          status: 'ready',
          changeSummary: input.changeSummary.trim(),
        })
      : { ok: false as const, errors: ['Artifact has no published entry'] }
    if (!publish.ok) throw new Error(publish.errors.join('; '))
    emitArtifactUpdated(agent)
    return { ok: true, changed: true, editsApplied: edits.length, manifest: publish.manifest }
  }

  function warmArtifactBuilderSandbox(agent: VoiceArtifactAgent): void {
    void Promise.resolve(getAgentWorkspacePath(agent)).catch((error: unknown) => {
      console.warn(`Failed to warm artifact builder sandbox for agent ${agent.id}`, error)
    })
  }

  async function prewarmArtifactBuilder(): Promise<ArtifactPrewarmResult> {
    const existing = (await listAgents()).find(isAvailablePrewarmedArtifactBuilder)
    if (existing) {
      const sandboxId = await getArtifactBuilderWorkspaceSandboxId(existing)
      warmArtifactBuilderSandbox(existing)
      return { agentId: existing.id, sandboxId, reused: true }
    }

    const agent = await createAgent({
      agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID,
      name: 'Artifact Builder (warm)',
      squadId: null,
      metadata: {
        specialRole: ARTIFACT_BUILDER_SPECIAL_ROLE,
        prewarm: true,
      },
      context: {
        artifactBuilderPrewarm: { claimedAt: null },
      },
      persist: true,
    })
    const sandboxId = await getArtifactBuilderWorkspaceSandboxId(agent)
    warmArtifactBuilderSandbox(agent)
    return { agentId: agent.id, sandboxId, reused: false }
  }

  async function claimPrewarmedArtifactBuilder(name: string): Promise<VoiceArtifactAgent> {
    const existing = (await listAgents()).find(isAvailablePrewarmedArtifactBuilder)
    if (!existing) {
      return createAgent({
        agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID,
        name,
        squadId: null,
        metadata: {
          specialRole: ARTIFACT_BUILDER_SPECIAL_ROLE,
        },
        persist: true,
      })
    }

    const claimContext = {
      ...(existing.context ?? {}),
      artifactBuilderPrewarm: { claimedAt: new Date().toISOString() },
    }

    if ('update' in existing && typeof existing.update === 'function') {
      await existing.update({ name, context: claimContext })
      existing.context = claimContext
      existing.metadata = { ...(existing.metadata ?? {}), name }
      return existing
    }

    const agent = await Agent.mustFind(existing.id)
    await agent.update({ name, context: claimContext })
    return agent
  }

  async function requestArtifact(rawInput: VoiceArtifactRequestInput): Promise<VoiceArtifactRequestResult> {
    const input = normalizeVoiceArtifactRequestInput(rawInput)
    switch (input.action) {
      case 'create':
        return createRequestedArtifact(input)
      case 'continue':
        return continueRequestedArtifact(input)
      case 'ask':
        return askRequestedArtifact(input)
      case 'archive':
        return archiveRequestedArtifact(input)
      case 'delete':
        return deleteRequestedArtifact(input)
      case 'fork':
        throw new Error('Forking artifacts is not implemented')
      default:
        throw new Error(`Unsupported artifact request action: ${String(input.action)}`)
    }
  }

  async function createRequestedArtifact(input: VoiceArtifactRequestInput): Promise<VoiceArtifactRequestResult> {
    if (!input.title) throw new Error('title is required for create requests')
    if (!input.brief) throw new Error('brief is required')

    const agent = await claimPrewarmedArtifactBuilder(`Artifact: ${input.title}`)
    const agentWorkspacePath = await getAgentWorkspacePath(agent)
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: input.title,
      brief: input.brief,
      references: input.references,
      displayModeHint: input.displayModeHint,
    })

    const skeletonPublish = await publishInitialArtifactSkeleton({
      agentWorkspacePath,
      artifactId: created.artifactId,
      artifactPath: created.artifactPath,
      title: created.manifest.title,
      brief: input.brief,
      displayModeHint: input.displayModeHint,
    })
    const manifest = skeletonPublish.ok ? skeletonPublish.manifest : created.manifest
    if (!skeletonPublish.ok) {
      console.warn(`Failed to publish initial artifact skeleton for ${created.artifactId}:`, skeletonPublish.errors)
    }

    const result: VoiceArtifactRequestResult = {
      action: 'create',
      agentId: agent.id,
      artifactId: created.artifactId,
      artifactPath: created.artifactPath,
      manifest,
    }

    emitArtifactUpdated(agent)

    try {
      await sendArtifactInboxMessage({
        sendInboxMessage,
        agentId: agent.id,
        action: 'create',
        artifactId: created.artifactId,
        artifactPath: getWorkspaceRelativeArtifactPath(created.artifactId),
        title: created.manifest.title,
        brief: input.brief,
        displayModeHint: input.displayModeHint,
        skeletonPublished: skeletonPublish.ok,
      })
    } catch (error) {
      console.error(`Failed to deliver artifact create inbox message for ${created.artifactId}`, error)
      result.inboxDeliveryFailed = true
      result.message =
        'Artifact was created and recorded, but agent notification failed. Do not retry the full request; check the artifacts list/status or ask to notify/wake the builder separately.'
    }

    if (autoPrewarmNext) {
      void prewarmArtifactBuilder().catch((error) => {
        console.warn('Failed to prewarm next artifact builder', error)
      })
    }

    return result
  }

  async function continueRequestedArtifact(input: VoiceArtifactRequestInput): Promise<VoiceArtifactRequestResult> {
    const { agent, agentWorkspacePath, artifactId } = await resolveExistingArtifactInput(
      input,
      findAgent,
      getAgentWorkspacePath
    )
    const manifest = input.answers?.length
      ? await appendArtifactQuestionResponses({
          agentWorkspacePath,
          artifactId,
          brief: input.brief,
          references: input.references,
          answers: input.answers,
        })
      : await appendArtifactRequest({
          agentWorkspacePath,
          artifactId,
          action: 'continue',
          brief: input.brief,
          references: input.references,
        })
    const artifactPath = getArtifactDirectory(agentWorkspacePath, manifest.id)

    const result: VoiceArtifactRequestResult = {
      action: 'continue',
      agentId: agent.id,
      artifactId: manifest.id,
      artifactPath,
      manifest,
    }

    emitArtifactUpdated(agent)

    try {
      await sendArtifactInboxMessage({
        sendInboxMessage,
        agentId: agent.id,
        action: 'continue',
        artifactId: manifest.id,
        artifactPath: getWorkspaceRelativeArtifactPath(manifest.id),
        title: manifest.title,
        brief: input.brief,
        answers: input.answers,
      })
    } catch (error) {
      console.error(`Failed to deliver artifact continue inbox message for ${manifest.id}`, error)
      result.inboxDeliveryFailed = true
      result.message =
        'Artifact request was recorded, but agent notification failed. Do not retry the full request; check artifact status/context or ask to notify/wake the builder separately.'
    }

    return result
  }

  async function askRequestedArtifact(input: VoiceArtifactRequestInput): Promise<VoiceArtifactRequestResult> {
    const { agent, agentWorkspacePath, artifactId } = await resolveExistingArtifactInput(
      input,
      findAgent,
      getAgentWorkspacePath
    )
    const manifest = await readArtifactManifest({ agentWorkspacePath, artifactId })
    if (!manifest) throw new Error(`Artifact not found: ${artifactId}`)
    const result: VoiceArtifactRequestResult = {
      action: 'ask',
      agentId: agent.id,
      artifactId: manifest.id,
      artifactPath: getArtifactDirectory(agentWorkspacePath, manifest.id),
      manifest,
    }

    try {
      await sendArtifactInfoRequestInboxMessage({
        sendInboxMessage,
        agentId: agent.id,
        artifactId: manifest.id,
        artifactPath: getWorkspaceRelativeArtifactPath(manifest.id),
        title: manifest.title,
        brief: input.brief,
        references: input.references,
      })
    } catch (error) {
      console.error(`Failed to deliver artifact info request for ${manifest.id}`, error)
      result.inboxDeliveryFailed = true
      result.message =
        'Artifact question was recorded for background handling, but agent notification failed. Ask again later or inspect the artifact context.'
    }

    return result
  }

  async function archiveRequestedArtifact(input: VoiceArtifactRequestInput): Promise<VoiceArtifactRequestResult> {
    const { agent, agentWorkspacePath, artifactId } = await resolveExistingArtifactInput(
      input,
      findAgent,
      getAgentWorkspacePath
    )
    const manifest = await archiveArtifact({
      agentWorkspacePath,
      artifactId,
      brief: input.brief,
      references: input.references,
    })
    emitArtifactUpdated(agent)
    return {
      action: 'archive',
      agentId: agent.id,
      artifactId: manifest.id,
      artifactPath: getArtifactDirectory(agentWorkspacePath, manifest.id),
      manifest,
    }
  }

  async function deleteRequestedArtifact(input: VoiceArtifactRequestInput): Promise<VoiceArtifactRequestResult> {
    const { agent, agentWorkspacePath, artifactId } = await resolveExistingArtifactInput(
      input,
      findAgent,
      getAgentWorkspacePath
    )
    const manifest = await readArtifactManifest({ agentWorkspacePath, artifactId })
    if (!manifest) throw new Error(`Artifact not found: ${artifactId}`)
    await deleteArtifact({ agentWorkspacePath, artifactId: manifest.id })
    emitArtifactUpdated(agent)
    return { action: 'delete', agentId: agent.id, artifactId: manifest.id, deleted: true }
  }

  return {
    listArtifacts,
    getArtifactContext,
    listArtifactFiles,
    readArtifactFile,
    editArtifactFile,
    requestArtifact,
    prewarmArtifactBuilder,
  }
}

export const artifactVoiceRequestService = createArtifactVoiceRequestService()

export function isArtifactMetadataFile(path: string): boolean {
  const basename = path
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1)
  return basename === 'manifest.json' || (basename !== undefined && /^manifest.*\.jsonl$/.test(basename))
}

function rejectArtifactMetadataFile(path: string): void {
  if (isArtifactMetadataFile(path)) {
    throw new Error('Artifact metadata files cannot be accessed directly')
  }
}

async function resolveExistingArtifact(
  agentId: string,
  artifactId: string,
  findAgent: FindAgentFn,
  getAgentWorkspacePath: GetAgentWorkspacePathFn
): Promise<{ agent: VoiceArtifactAgent; agentWorkspacePath: string; manifest: ArtifactManifest }> {
  const agent = await mustFindArtifactAgent(agentId, findAgent)
  const agentWorkspacePath = await getAgentWorkspacePath(agent)
  const manifest = await readArtifactManifest({ agentWorkspacePath, artifactId })
  if (!manifest) throw new Error(`Artifact not found: ${artifactId}`)
  return { agent, agentWorkspacePath, manifest }
}

function assertDirectEditSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_ARTIFACT_FILE_READ_BYTES) {
    throw new Error(`Artifact file content exceeds ${MAX_ARTIFACT_FILE_READ_BYTES} bytes`)
  }
}

const MAX_ARTIFACT_FILE_READ_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_FILE_READ_LINES = 500
const MAX_ARTIFACT_FILE_READ_BYTE_SLICE = 64 * 1024

function getArtifactFileMaxReadBytes(): number {
  return MAX_ARTIFACT_FILE_READ_BYTES
}

function normalizeArtifactFilePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) throw new Error('path is required')
  return trimmed
}

function normalizeReadLimit(value: unknown, unit: 'lines' | 'bytes'): number {
  const fallback = unit === 'bytes' ? MAX_ARTIFACT_FILE_READ_BYTE_SLICE : 200
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const max = unit === 'bytes' ? MAX_ARTIFACT_FILE_READ_BYTE_SLICE : MAX_ARTIFACT_FILE_READ_LINES
  return Math.max(1, Math.min(Math.floor(value), max))
}

function normalizeReadOffset(value: unknown, unit: 'lines' | 'bytes'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return unit === 'bytes' ? 0 : 1
  return Math.max(unit === 'bytes' ? 0 : 1, Math.floor(value))
}

function normalizeArtifactFileTextEdits(input: ArtifactFileEditInput): ArtifactFileTextEdit[] {
  const edits =
    input.edits ?? (input.oldText !== undefined ? [{ oldText: input.oldText, newText: input.newText ?? '' }] : [])
  if (edits.length === 0) throw new Error('at least one edit is required')
  if (edits.length > 20) throw new Error('at most 20 edits are supported')
  return edits.map((edit) => {
    if (!edit.oldText) throw new Error('oldText is required')
    return { oldText: edit.oldText, newText: edit.newText }
  })
}

function applyExactTextEdits(content: string, edits: ArtifactFileTextEdit[]): string {
  let next = content
  for (const [index, edit] of edits.entries()) {
    const label = `edit[${index}]`
    const firstIndex = next.indexOf(edit.oldText)
    if (firstIndex === -1) throw new Error(`${label} oldText not found exactly`)
    if (next.indexOf(edit.oldText, firstIndex + edit.oldText.length) !== -1) {
      throw new Error(`${label} matched more than one location; provide a narrower exact block`)
    }
    next = next.slice(0, firstIndex) + edit.newText + next.slice(firstIndex + edit.oldText.length)
  }
  return next
}

function buildReadResult(args: {
  input: ArtifactFileReadInput
  manifest: ArtifactManifest
  path: string
  content: string
  unit: 'lines' | 'bytes'
  offset: number
  limit: number
  sizeBytes: number
  totalLines?: number
  truncated: boolean
  nextOffset?: number
}): ArtifactFileReadResult {
  return {
    path: args.path,
    content: args.content,
    unit: args.unit,
    offset: args.offset,
    limit: args.limit,
    sizeBytes: args.sizeBytes,
    ...(args.totalLines !== undefined ? { totalLines: args.totalLines } : {}),
    truncated: args.truncated,
    ...(args.nextOffset !== undefined ? { nextOffset: args.nextOffset } : {}),
    ...(args.manifest.entry?.path ? { entryPath: args.manifest.entry.path } : {}),
    ...(args.manifest.entry?.type ? { artifactType: args.manifest.entry.type } : {}),
  }
}

async function readArtifactEntryContent({
  agentWorkspacePath,
  manifest,
}: {
  agentWorkspacePath: string
  manifest: ArtifactManifest
}): Promise<unknown> {
  if (!manifest.entry) return undefined
  if (manifest.entry.type === 'sandbox_app') return undefined

  const resolvedPath = resolveArtifactPath({
    agentWorkspacePath,
    artifactId: manifest.id,
    localPath: manifest.entry.path,
  })
  const raw = await readUtf8RegularFileNoFollowBounded(resolvedPath, getArtifactEntryMaxBytes(manifest.entry))
  return manifest.entry.type === 'presentation' ? JSON.parse(raw) : raw
}

function normalizeVoiceArtifactRequestInput(input: VoiceArtifactRequestInput): VoiceArtifactRequestInput {
  const normalizedAnswers = normalizeArtifactQuestionAnswers(input.answers)
  if (normalizedAnswers && input.action !== 'continue') {
    throw new Error('answers are only supported for continue artifact requests')
  }

  return {
    ...input,
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId.trim() } : {}),
    ...(input.artifactId !== undefined ? { artifactId: input.artifactId.trim() } : {}),
    brief: input.brief.trim(),
    ...(input.displayModeHint !== undefined ? { displayModeHint: input.displayModeHint.trim() } : {}),
    ...(normalizedAnswers ? { answers: normalizedAnswers } : {}),
  }
}

function normalizeArtifactQuestionAnswers(
  answers: VoiceArtifactRequestInput['answers']
): VoiceArtifactQuestionAnswerInput[] | undefined {
  if (answers === undefined) return undefined
  if (!Array.isArray(answers)) throw new Error('answers must include non-empty questionId and answer')

  const normalizedAnswers = answers.map((answer) => {
    if (!answer || typeof answer !== 'object') throw new Error('answers must include non-empty questionId and answer')
    const record = answer as Record<string, unknown>
    return {
      questionId: typeof record.questionId === 'string' ? record.questionId.trim() : '',
      answer: typeof record.answer === 'string' ? record.answer.trim() : '',
    }
  })
  const questionIds = new Set<string>()
  for (const answer of normalizedAnswers) {
    if (!answer.questionId || !answer.answer) throw new Error('answers must include non-empty questionId and answer')
    if (questionIds.has(answer.questionId))
      throw new Error(`Duplicate artifact question response: ${answer.questionId}`)
    questionIds.add(answer.questionId)
  }
  return normalizedAnswers
}

async function resolveExistingArtifactInput(
  input: VoiceArtifactRequestInput,
  findAgent: FindAgentFn,
  getAgentWorkspacePath: GetAgentWorkspacePathFn
): Promise<{ agent: VoiceArtifactAgent; agentWorkspacePath: string; artifactId: string }> {
  if (!input.agentId || !input.artifactId) {
    throw new Error(`agentId and artifactId are required for ${input.action} requests`)
  }
  if (!input.brief) throw new Error('brief is required')

  const agent = await mustFindArtifactAgent(input.agentId, findAgent)
  const agentWorkspacePath = await getAgentWorkspacePath(agent)
  return { agent, agentWorkspacePath, artifactId: input.artifactId }
}

async function mustFindArtifactAgent(agentId: string, findAgent: FindAgentFn): Promise<VoiceArtifactAgent> {
  const agent = await findAgent(agentId)
  if (!agent) throw new Error(`Artifact agent not found: ${agentId}`)
  if (
    agent.agentTypeId !== ARTIFACT_BUILDER_AGENT_TYPE_ID ||
    agent.metadata?.specialRole !== ARTIFACT_BUILDER_SPECIAL_ROLE
  ) {
    throw new Error(`Agent is not an artifact builder: ${agentId}`)
  }
  return agent
}

async function sendArtifactInfoRequestInboxMessage({
  sendInboxMessage,
  agentId,
  artifactId,
  artifactPath,
  title,
  brief,
  references,
}: {
  sendInboxMessage: SendInboxMessageFn
  agentId: string
  artifactId: string
  artifactPath: string
  title: string
  brief: string
  references?: ArtifactReference[]
}): Promise<void> {
  await sendInboxMessage({
    recipientType: 'agent',
    recipientId: agentId,
    senderType: 'system',
    wakeEligible: true,
    subject: `Question about artifact: ${title}`,
    content: buildArtifactInfoRequestMessage({ artifactId, artifactPath, title, brief, references }),
    metadata: {
      kind: 'artifact-info-request',
      action: 'ask',
      artifactId,
      artifactPath,
    },
  })
}

async function sendArtifactInboxMessage({
  sendInboxMessage,
  agentId,
  action,
  artifactId,
  artifactPath,
  title,
  brief,
  displayModeHint,
  answers,
  skeletonPublished,
}: {
  sendInboxMessage: SendInboxMessageFn
  agentId: string
  action: ArtifactRequestAction
  artifactId: string
  artifactPath: string
  title: string
  brief: string
  displayModeHint?: string
  answers?: VoiceArtifactQuestionAnswerInput[]
  skeletonPublished?: boolean
}): Promise<void> {
  await sendInboxMessage({
    recipientType: 'agent',
    recipientId: agentId,
    senderType: 'system',
    wakeEligible: true,
    subject: `${action === 'create' ? 'Create' : 'Update'} artifact: ${title}`,
    content: buildArtifactRequestMessage({
      action,
      artifactId,
      artifactPath,
      title,
      brief,
      displayModeHint,
      answers,
      skeletonPublished,
    }),
    metadata: {
      kind: 'artifact-request',
      action,
      artifactId,
      artifactPath,
    },
  })
}

function getWorkspaceRelativeArtifactPath(artifactId: string): string {
  return `artifacts/${artifactId}`
}

async function publishInitialArtifactSkeleton({
  agentWorkspacePath,
  artifactId,
  artifactPath,
  title,
  brief,
  displayModeHint,
}: {
  agentWorkspacePath: string
  artifactId: string
  artifactPath: string
  title: string
  brief: string
  displayModeHint?: string
}) {
  const presentation: Presentation = {
    schemaVersion: 1,
    title,
    sections: [
      {
        id: 'request',
        title: 'Request',
        blocks: [
          {
            type: 'callout',
            tone: 'info',
            title: displayModeHint ? `Starting ${displayModeHint}` : 'Starting point',
            content: brief,
          },
        ],
      },
      {
        id: 'next',
        title: 'Coming next',
        blocks: [
          {
            type: 'table',
            columns: [
              { key: 'area', label: 'Area' },
              { key: 'status', label: 'Status' },
            ],
            rows: [
              { area: 'Structure', status: 'Drafting' },
              { area: 'Details', status: 'Preparing' },
              { area: 'Visual polish', status: 'Preparing' },
            ],
          },
        ],
      },
    ],
  }

  await writeFile(join(artifactPath, 'presentation.json'), `${JSON.stringify(presentation, null, 2)}\n`, 'utf8')
  return publishArtifact({
    agentWorkspacePath,
    artifactId,
    entry: { type: 'presentation', path: 'presentation.json' },
    summary: 'Initial skeleton visible while the artifact is being built.',
    status: 'working',
    changeSummary: 'Created the initial visible artifact skeleton.',
    changeDetails:
      'Backend generated a starter presentation so the voice workspace can render immediately while the builder refines it.',
  })
}

function buildArtifactInfoRequestMessage({
  artifactId,
  artifactPath,
  title,
  brief,
  references,
}: {
  artifactId: string
  artifactPath: string
  title: string
  brief: string
  references?: ArtifactReference[]
}): string {
  return [
    'Informational artifact question',
    `Artifact ID: ${artifactId}`,
    `Title: ${title}`,
    `Path: ${artifactPath}`,
    '',
    'Question:',
    brief,
    ...(references?.length
      ? ['', 'References:', ...references.map((reference) => `- ${JSON.stringify(reference)}`)]
      : []),
    '',
    'Instructions:',
    '- Answer the question using your knowledge of this artifact and its files.',
    '- Inspect artifact files as needed, but do not edit artifact files and do not publish an artifact update.',
    '- Reply to the workspace voice assistant through inbox: ficus inbox send workspace "<message>" --recipient-type voice_assistant. Use a concise, voice-friendly summary.',
    '- Do not ask an artifact_question unless you truly need clarification before answering.',
  ].join('\n')
}

function buildArtifactRequestMessage({
  action,
  artifactId,
  artifactPath,
  title,
  brief,
  displayModeHint,
  answers,
  skeletonPublished,
}: {
  action: ArtifactRequestAction
  artifactId: string
  artifactPath: string
  title: string
  brief: string
  displayModeHint?: string
  answers?: VoiceArtifactQuestionAnswerInput[]
  skeletonPublished?: boolean
}): string {
  const createInstructions = [
    '- Work only in the artifact folder above. Do not edit manifest.json.',
    '- Start from this message; inspect artifact files only when they help you build faster.',
    '- Publish an initial valid version quickly so the UI can render early.',
    '- Use placeholders or loading states for sections that are still being built.',
    '- Do not add progress-update sentences to the artifact content itself.',
  ]
  const continueInstructions = [
    '- Work only in the artifact folder above. Do not edit manifest.json.',
    '- You already have the artifact context in this chat; inspect artifact files only when they help you make the change faster.',
    '- Inspect current artifact files only as needed to make the requested change.',
    '- Publish an incremental update as soon as the changed content is valid.',
    '- Use placeholders or loading states for sections that are still being built.',
    '- Do not add progress-update sentences to the artifact content itself.',
  ]

  return [
    `Artifact request (${action})`,
    `Artifact ID: ${artifactId}`,
    `Title: ${title}`,
    `Path: ${artifactPath}`,
    displayModeHint ? `Display mode hint: ${displayModeHint}` : undefined,
    '',
    'Request:',
    brief,
    ...(skeletonPublished
      ? ['', 'A starter skeleton is already visible in the workspace. Replace and refine it incrementally.']
      : []),
    ...(answers?.length
      ? ['', 'Answered questions:', ...answers.map((answer) => `- ${answer.questionId}: ${answer.answer}`)]
      : []),
    '',
    'Instructions:',
    ...(action === 'create' ? createInstructions : continueInstructions),
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')
}

async function defaultCreateAgent(input: CreateAgentInput): Promise<VoiceArtifactAgent> {
  return Agent.create(input)
}

async function defaultFindAgent(id: string): Promise<VoiceArtifactAgent | null> {
  return Agent.find(id)
}

async function defaultListAgents(): Promise<VoiceArtifactAgent[]> {
  return Agent.list()
}

async function getArtifactBuilderWorkspaceSandboxId(agent: ArtifactIndexAgent): Promise<string> {
  const sandboxId = agent.getAgentWorkspaceSandboxId?.() ?? (await agent.getSandboxId?.())
  return sandboxId ?? agentWorkspaceSandboxId(agent.id)
}

function isAvailablePrewarmedArtifactBuilder(agent: VoiceArtifactAgent): boolean {
  if (agent.agentTypeId !== ARTIFACT_BUILDER_AGENT_TYPE_ID) return false
  if (agent.metadata?.specialRole !== ARTIFACT_BUILDER_SPECIAL_ROLE) return false
  if (agent.metadata?.prewarm !== true) return false
  const context = agent.context as { artifactBuilderPrewarm?: { claimedAt?: string | null } } | null
  return !context?.artifactBuilderPrewarm?.claimedAt
}

async function defaultGetAgentWorkspacePath(agent: ArtifactIndexAgent): Promise<string> {
  if (agent.workspacePath) return agent.workspacePath
  const sandboxId = await getArtifactBuilderWorkspaceSandboxId(agent)
  return getAgentWorkspaceStoragePath(sandboxId)
}

async function defaultSendInboxMessage(message: SendInboxMessageInput): Promise<unknown> {
  return InboxMessage.send(message)
}

function emitArtifactUpdated(agent: VoiceArtifactAgent): void {
  eventEmitter.emit('agent.updated', { agentId: agent.id, squadId: agent.squadId ?? null })
}
