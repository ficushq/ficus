import {
  artifactEntrySchema,
  artifactStatusSchema,
  presentationSchema,
  type ArtifactEntry,
  type ArtifactManifest,
  type ArtifactStatus,
} from '@ficus/shared'
import { readUtf8RegularFileNoFollowBounded } from './artifactFiles'
import { readArtifactManifest, resolveArtifactPath, updateArtifactManifestWithPublish } from './artifactWorkspace'

export const MAX_ARTIFACT_PRESENTATION_BYTES = 1024 * 1024
export const MAX_ARTIFACT_MARKDOWN_BYTES = 2 * 1024 * 1024
export const MAX_ARTIFACT_HTML_BYTES = 5 * 1024 * 1024

type PublishArtifactParams = {
  agentWorkspacePath: string
  artifactId: string
  entry: ArtifactEntry
  title?: string
  summary?: string
  status: ArtifactStatus
  changeSummary?: string
  changeDetails?: string
}

type PublishArtifactSuccess = {
  ok: true
  manifest: ArtifactManifest
}

type PublishArtifactFailure = {
  ok: false
  errors: string[]
}

export type PublishArtifactResult = PublishArtifactSuccess | PublishArtifactFailure

export async function publishArtifact({
  agentWorkspacePath,
  artifactId,
  entry,
  title,
  summary,
  status,
  changeSummary,
  changeDetails,
}: PublishArtifactParams): Promise<PublishArtifactResult> {
  const errors: string[] = []

  const manifest = await readArtifactManifest({ agentWorkspacePath, artifactId })
  if (!manifest) {
    return { ok: false, errors: [`Artifact manifest not found or invalid: ${artifactId}`] }
  }

  const parsedEntry = artifactEntrySchema.safeParse(entry)
  if (!parsedEntry.success) {
    errors.push(
      ...parsedEntry.error.issues.map((issue) =>
        issue.path[0] === 'path'
          ? `Invalid artifact path: ${issue.message}`
          : `Invalid artifact entry: ${issue.path.join('.')}: ${issue.message}`
      )
    )
  }

  const parsedStatus = artifactStatusSchema.safeParse(status)
  if (!parsedStatus.success) {
    errors.push(...parsedStatus.error.issues.map((issue) => `Invalid artifact status: ${issue.message}`))
  }

  if (title !== undefined && title.length === 0) {
    errors.push('Invalid artifact title: title must not be empty')
  }
  if (summary !== undefined && summary.length === 0) {
    errors.push('Invalid artifact summary: summary must not be empty')
  }
  if (changeSummary !== undefined && changeSummary.length === 0) {
    errors.push('Invalid artifact change summary: changeSummary must not be empty')
  }
  if (changeDetails !== undefined && changeDetails.length === 0) {
    errors.push('Invalid artifact change details: changeDetails must not be empty')
  }

  let resolvedPath: string | null = null
  if (parsedEntry.success) {
    try {
      resolvedPath = resolveArtifactPath({ agentWorkspacePath, artifactId, localPath: parsedEntry.data.path })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Invalid artifact path')
    }
  }

  if (parsedEntry.success && resolvedPath) {
    errors.push(...(await validateEntryFile(parsedEntry.data, resolvedPath)))
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  try {
    const now = new Date().toISOString()
    const updated = await updateArtifactManifestWithPublish({
      agentWorkspacePath,
      artifactId,
      publish: {
        at: now,
        entry,
        status,
        changeSummary: changeSummary ?? 'Published artifact update.',
        ...(changeDetails !== undefined ? { changeDetails } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
      },
      mutate: (currentManifest) => {
        const nextTitle = title ?? currentManifest.title
        const nextSummary = summary ?? currentManifest.summary
        return {
          id: currentManifest.id,
          title: nextTitle,
          status,
          ...(nextSummary !== undefined ? { summary: nextSummary } : {}),
          entry,
          createdAt: currentManifest.createdAt,
          updatedAt: now,
          archived: currentManifest.archived,
        }
      },
    })
    return { ok: true, manifest: updated }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : 'Invalid artifact manifest'] }
  }
}

async function validateEntryFile(entry: ArtifactEntry, resolvedPath: string): Promise<string[]> {
  switch (entry.type) {
    case 'presentation':
      return validatePresentation(resolvedPath)
    case 'markdown':
    case 'html':
      return validateExistingRegularFileNoFollow(resolvedPath, entry.type, getArtifactEntryMaxBytes(entry))
    case 'sandbox_app':
      return ['sandbox_app artifacts are not implemented']
  }
}

export function getArtifactEntryMaxBytes(entry: ArtifactEntry): number {
  switch (entry.type) {
    case 'presentation':
      return MAX_ARTIFACT_PRESENTATION_BYTES
    case 'markdown':
      return MAX_ARTIFACT_MARKDOWN_BYTES
    case 'html':
      return MAX_ARTIFACT_HTML_BYTES
    case 'sandbox_app':
      return 0
  }
}

async function validatePresentation(resolvedPath: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readUtf8RegularFileNoFollowBounded(resolvedPath, MAX_ARTIFACT_PRESENTATION_BYTES)
  } catch (error) {
    return [formatFileError(error, 'presentation')]
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (error) {
    return [`Invalid presentation JSON: ${error instanceof Error ? error.message : 'could not parse JSON'}`]
  }

  const parsedPresentation = presentationSchema.safeParse(parsedJson)
  if (!parsedPresentation.success) {
    return parsedPresentation.error.issues.map(
      (issue) => `Invalid presentation: ${issue.path.join('.')}: ${issue.message}`
    )
  }

  return []
}

async function validateExistingRegularFileNoFollow(
  resolvedPath: string,
  label: string,
  maxBytes: number
): Promise<string[]> {
  try {
    await readUtf8RegularFileNoFollowBounded(resolvedPath, maxBytes)
    return []
  } catch (error) {
    return [formatFileError(error, label)]
  }
}

function formatFileError(error: unknown, label: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return `Invalid ${label} artifact: file not found`
  }
  if (error instanceof Error && error.message.startsWith('file size exceeds ')) {
    return `Invalid ${label} artifact: ${error.message}`
  }
  return `Invalid ${label} artifact: ${error instanceof Error ? error.message : 'could not read file'}`
}
