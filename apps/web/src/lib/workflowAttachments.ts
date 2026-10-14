import { workflowAttachmentContentType, type WorkflowAttemptAttachment } from '@ficus/shared'

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
