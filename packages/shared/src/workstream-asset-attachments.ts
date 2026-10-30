import { z } from 'zod'

/**
 * A stored chat image or chat file a work stream references by ID, instead of a copy in the
 * workspace. Distinct namespaces: a chat image ID is never read as a chat file ID.
 */
export type WorkStreamAssetSource = { kind: 'image'; imageId: string } | { kind: 'agent-file'; attachmentId: string }

export const workStreamAssetSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), imageId: z.uuid() }).strict(),
  z.object({ kind: z.literal('agent-file'), attachmentId: z.uuid() }).strict(),
])

/** One work stream's share of a stored asset: a stream input, or a result of one flow attempt. */
export interface WorkStreamAssetAttachment {
  /** The share's own ID (what list, read and remove take), not the source's. */
  id: string
  workStreamId: string
  /** null for a stream input. */
  attemptId: number | null
  source: WorkStreamAssetSource
  filename: string
  /** Server-derived; never the uploader's declared type for chat files. */
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
