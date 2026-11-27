import { createHash } from 'node:crypto'

export class InvalidMessageCursorError extends Error {}

export interface MessageCursorContext {
  agentId: string
  role?: string
  search?: string
  before?: string
  after?: string
  /** Search scope; omitted from the digest for the default `text`, so earlier cursors stay valid. */
  scope?: string
}

const DECIMAL = /^-?(0|[1-9]\d*)$/
const HEX_64 = /^[0-9a-f]{64}$/
const POSTGRES_BIGINT_MIN = -(1n << 63n)
const POSTGRES_BIGINT_MAX = (1n << 63n) - 1n
const digest = (context: MessageCursorContext) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        agentId: context.agentId,
        role: context.role ?? null,
        search: context.search ?? null,
        before: context.before ?? null,
        after: context.after ?? null,
        ...(context.scope && context.scope !== 'text' ? { scope: context.scope } : {}),
      })
    )
    .digest('hex')

export function encodeMessageCursor(
  keyset: { createdAt: Date; enqueueOrder: bigint },
  context: MessageCursorContext
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      createdAt: keyset.createdAt.toISOString(),
      enqueueOrder: keyset.enqueueOrder.toString(),
      queryDigest: digest(context),
    })
  ).toString('base64url')
}

export function decodeMessageCursor(
  encoded: string,
  context: MessageCursorContext
): { createdAt: Date; enqueueOrder: bigint } {
  if (!encoded || encoded.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new InvalidMessageCursorError('invalid-cursor')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidMessageCursorError('invalid-cursor')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidMessageCursorError('invalid-cursor')
  const cursor = value as Record<string, unknown>
  if (
    Object.keys(cursor).sort().join(',') !== 'createdAt,enqueueOrder,queryDigest,v' ||
    cursor.v !== 1 ||
    typeof cursor.createdAt !== 'string' ||
    typeof cursor.enqueueOrder !== 'string' ||
    !DECIMAL.test(cursor.enqueueOrder) ||
    typeof cursor.queryDigest !== 'string' ||
    !HEX_64.test(cursor.queryDigest)
  )
    throw new InvalidMessageCursorError('invalid-cursor')
  const createdAt = new Date(cursor.createdAt)
  const enqueueOrder = BigInt(cursor.enqueueOrder)
  if (
    Number.isNaN(createdAt.valueOf()) ||
    createdAt.toISOString() !== cursor.createdAt ||
    cursor.queryDigest !== digest(context) ||
    enqueueOrder < POSTGRES_BIGINT_MIN ||
    enqueueOrder > POSTGRES_BIGINT_MAX
  )
    throw new InvalidMessageCursorError('invalid-cursor')
  return { createdAt, enqueueOrder }
}
