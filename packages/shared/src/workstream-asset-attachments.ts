import { z } from 'zod'

/**
 * A stored chat image, chat file or inbox attachment a work stream references by ID, instead of a
 * copy in the workspace. Distinct namespaces: a chat image ID is never read as a chat file ID, and a
 * chat file ID is never read as an inbox attachment ID.
 */
export type WorkStreamAssetSource =
  | { kind: 'image'; imageId: string }
  | { kind: 'agent-file'; attachmentId: string }
  | { kind: 'inbox-attachment'; attachmentId: string }

export const workStreamAssetSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), imageId: z.uuid() }).strict(),
  z.object({ kind: z.literal('agent-file'), attachmentId: z.uuid() }).strict(),
  z.object({ kind: z.literal('inbox-attachment'), attachmentId: z.uuid() }).strict(),
])

/** The longest label a stored input may carry. */
export const WORK_STREAM_ASSET_LABEL_MAX_LENGTH = 120

/**
 * An optional short label for a share, shown instead of its filename. Trimmed; control and format
 * characters (line breaks included) are refused, so a label is always one plain line.
 */
export const workStreamAssetLabelSchema = z
  .string()
  .trim()
  .min(1, 'A label cannot be empty; send null to clear it')
  .max(WORK_STREAM_ASSET_LABEL_MAX_LENGTH, `A label can be at most ${WORK_STREAM_ASSET_LABEL_MAX_LENGTH} characters`)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), 'A label must be a single line of plain text')

/** What a person or agent reads for a share: its label when it has one, otherwise its filename. */
export function workStreamAssetDisplayName(asset: Pick<WorkStreamAssetAttachment, 'filename' | 'label'>): string {
  return asset.label || asset.filename
}

/** One work stream's share of a stored asset: a stream input, or a result of one flow attempt. */
export interface WorkStreamAssetAttachment {
  /** The share's own ID (what list, read and remove take), not the source's. */
  id: string
  workStreamId: string
  /** null for a stream input. */
  attemptId: number | null
  source: WorkStreamAssetSource
  filename: string
  /**
   * An optional short label, set when sharing or later by anyone who can edit the stream; null when
   * there is none. Absent from servers that predate labels.
   */
  label?: string | null
  /** Server-derived from the filename; never the uploader's or sender's declared type. */
  contentType: string
  byteSize: number
  createdAt: string
}

/** A work stream's stored-asset references: its inputs and each attempt's results. */
export interface WorkStreamAssetAttachments {
  inputs: WorkStreamAssetAttachment[]
  attempts: Record<string, WorkStreamAssetAttachment[]>
}

/** The most stored-asset inputs one work stream may hold at a time. */
export const WORK_STREAM_INPUT_ASSET_LIMIT = 10

/** The source ID of a reference, whichever namespace it is in. */
export function workStreamAssetSourceId(source: WorkStreamAssetSource): string {
  return source.kind === 'image' ? source.imageId : source.attachmentId
}

/**
 * The source an agent tool may read with `read_attachment`. Each kind keeps its source's own
 * authorization; none is a filesystem path or URL.
 */
export type ReadAttachmentSource =
  | { kind: 'workstream-asset'; workStreamId: string; attachmentId: string }
  | { kind: 'workflow-attachment'; workStreamId: string; attachmentId: string }
  | { kind: 'inbox-attachment'; attachmentId: string }
  | { kind: 'conversation-image'; imageId: string }
