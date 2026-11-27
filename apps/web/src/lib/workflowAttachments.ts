import {
  workflowAttachmentContentType,
  workStreamAssetDisplayName,
  type WorkflowAttemptAttachment,
  type WorkStreamAssetAttachment,
} from '@ficus/shared'

/** Text larger than this is offered as a download instead of rendered inline. */
export const INLINE_TEXT_LIMIT = 1024 * 1024

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const TEXT_TYPES = new Set(['application/json', 'application/yaml'])

export type AttachmentPreviewMode = 'text' | 'image' | 'pdf' | 'download'

/**
 * How a handoff file reads inline, decided from its name alone (the same rule Core stores its type by),
 * so a file that a browser could execute (HTML, SVG) is never rendered. PDFs are drawn to canvases
 * from their bytes, never handed to the browser's own viewer.
 */
export function attachmentPreviewMode(
  attachment: Pick<WorkflowAttemptAttachment, 'filename' | 'byteSize'>
): AttachmentPreviewMode {
  const type = workflowAttachmentContentType(attachment.filename)
  if (INLINE_IMAGE_TYPES.has(type)) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('text/') || TEXT_TYPES.has(type))
    return attachment.byteSize <= INLINE_TEXT_LIMIT ? 'text' : 'download'
  return 'download'
}

/**
 * One document a review or a stream shows: a handoff file (uploaded with --attach, which has the
 * path it was attached from) or a stored chat image, chat file or inbox attachment shared by ID
 * (which has no path, and is never given one).
 */
export interface ReviewDocument {
  id: string
  filename: string
  /** A stored share's optional label, shown instead of the filename; null otherwise. */
  label: string | null
  byteSize: number
  attemptId: number | null
  /** What the row says under the name: the handoff file's path, or where a stored asset came from. */
  detail: string
  stored: boolean
}

export function handoffDocument(file: WorkflowAttemptAttachment): ReviewDocument {
  return {
    id: file.id,
    filename: file.filename,
    label: null,
    byteSize: file.byteSize,
    attemptId: file.attemptId,
    detail: file.path,
    stored: false,
  }
}

/**
 * Where an attachment comes from, as the muted line under its name. Shared wording with the mobile
 * work stream page, so both say the same thing about the same file.
 */
export const ATTACHMENT_SOURCE_LABELS = {
  stored: 'From chat',
  inbox: 'From inbox',
  workspace: 'Workspace file',
  handoff: 'From handoff',
} as const

/** What a document is called on screen: a stored share's label when it has one, else its filename. */
export function attachmentTitle(document: Pick<ReviewDocument, 'filename' | 'label'>): string {
  return workStreamAssetDisplayName(document)
}

/**
 * Where a stored reference came from, for review tabs and the viewer: `ATTACHMENT_SOURCE_LABELS.inbox`
 * for an inbox attachment, otherwise the chat image or chat file wording, with `scope` (for example
 * "Work stream input") in front when given. A labelled share keeps its filename in view before it.
 */
export function storedAssetDetail(asset: WorkStreamAssetAttachment, scope?: string): string {
  const origin =
    asset.source.kind === 'inbox-attachment'
      ? ATTACHMENT_SOURCE_LABELS.inbox
      : `${scope ? 'stored' : 'Stored'} chat ${asset.source.kind === 'image' ? 'image' : 'file'}, shared by ID`
  const named = asset.label ? `${asset.filename} · ${origin}` : origin
  if (!scope) return named
  return asset.source.kind === 'inbox-attachment' ? `${scope} · ${named}` : `${scope}: ${named}`
}

export function storedDocument(asset: WorkStreamAssetAttachment): ReviewDocument {
  return {
    id: asset.id,
    filename: asset.filename,
    label: asset.label || null,
    byteSize: asset.byteSize,
    attemptId: asset.attemptId,
    detail: storedAssetDetail(asset),
    stored: true,
  }
}

/**
 * Each attempt's own documents in attempt order (its uploaded files, then its stored references),
 * followed by the work stream's stored inputs, which every review can read.
 */
export function reviewDocuments(
  run: {
    attachments?: Record<string, WorkflowAttemptAttachment[]>
    assetAttachments?: Record<string, WorkStreamAssetAttachment[]>
  },
  attemptIds: number[],
  inputs: WorkStreamAssetAttachment[] = []
): ReviewDocument[] {
  return [
    ...attemptIds.flatMap((id) => [
      ...(run.attachments?.[String(id)] ?? []).map(handoffDocument),
      ...(run.assetAttachments?.[String(id)] ?? []).map(storedDocument),
    ]),
    ...inputs.map((asset) => ({
      ...storedDocument(asset),
      detail: storedAssetDetail(asset, 'Work stream input'),
    })),
  ]
}

/**
 * How a stored input appears in the Attachments list: its label as the title when it has one (the
 * filename then moves to the secondary line), and where it came from. Servers that predate labels omit
 * the field, which reads as no label.
 */
export function storedInputPresentation(asset: Pick<WorkStreamAssetAttachment, 'filename' | 'source' | 'label'>): {
  title: string
  detail: string
} {
  const title = asset.label?.trim() || null
  const source =
    asset.source.kind === 'inbox-attachment' ? ATTACHMENT_SOURCE_LABELS.inbox : ATTACHMENT_SOURCE_LABELS.stored
  return title ? { title, detail: `${asset.filename} · ${source}` } : { title: asset.filename, detail: source }
}

/** What the viewer says when a workspace file is not there: it is a live path, not a stored copy. */
export const WORKSPACE_FILE_MISSING =
  'This file could not be read. It may have been moved or deleted from the squad workspace.'
/** A refusal is about access, not the file. The mobile viewer uses the same words. */
export const WORKSPACE_FILE_FORBIDDEN = 'You don’t have access to this squad’s workspace.'
/** The server failed to read it (or answered oddly): nothing says the file is gone. */
export const WORKSPACE_FILE_SERVER_ERROR = 'This file could not be loaded right now. Try again in a moment.'
/** No answer came back at all: offline, connection lost or timed out. */
export const WORKSPACE_FILE_NETWORK_ERROR = 'This file could not be loaded. Check your connection and try again.'

/**
 * Why a workspace file could not be loaded, in words the viewer shows: a refusal (403), a path that
 * is not a readable file (400, 404, 410: moved, deleted or a folder), a server failure (any other
 * answer) or no answer at all. `retry` is whether trying again could help.
 */
export function workspaceFileLoadError(error: unknown): { message: string; retry: boolean } {
  const status =
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined
  if (status === undefined) return { message: WORKSPACE_FILE_NETWORK_ERROR, retry: true }
  if (status === 403) return { message: WORKSPACE_FILE_FORBIDDEN, retry: false }
  if ([400, 404, 410].includes(status)) return { message: WORKSPACE_FILE_MISSING, retry: false }
  return { message: WORKSPACE_FILE_SERVER_ERROR, retry: true }
}
