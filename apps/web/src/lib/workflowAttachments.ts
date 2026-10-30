import {
  workflowAttachmentContentType,
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
 * path it was attached from) or a stored chat image or file shared by ID (which has no path, and is
 * never given one).
 */
export interface ReviewDocument {
  id: string
  filename: string
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
    byteSize: file.byteSize,
    attemptId: file.attemptId,
    detail: file.path,
    stored: false,
  }
}

export function storedDocument(asset: WorkStreamAssetAttachment): ReviewDocument {
  return {
    id: asset.id,
    filename: asset.filename,
    byteSize: asset.byteSize,
    attemptId: asset.attemptId,
    detail: asset.source.kind === 'image' ? 'Stored chat image, shared by ID' : 'Stored chat file, shared by ID',
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
      detail: `Work stream input: stored chat ${asset.source.kind === 'image' ? 'image' : 'file'}, shared by ID`,
    })),
  ]
}
