import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  managedBigbrainHostReceiptSchema,
  managedBigbrainHostRequestSchema,
  managedBigbrainOwnerSchema,
  type ManagedBigbrainHostRequest,
} from '@ficus/shared/managed-bigbrain'
import { storageReservationSchema } from './storage'

const uint = z.int().safe().nonnegative()
const vaultActions = ['create', 'rename', 'read-revoke', 'read-reconnect', 'delete'] as const
export const controlReceiptSchema = z
  .strictObject({
    schema: z.literal(1),
    receipt: managedBigbrainHostReceiptSchema,
    phase: z.enum([
      'reserved',
      'storage_ready',
      'initialized',
      'reader_ready',
      'service_started',
      'ready',
      'deleting',
      'deleted',
    ]),
    displayName: z.string().min(1).max(120),
    owner: managedBigbrainOwnerSchema,
    operation: z.strictObject({
      requestId: z.uuid().regex(/^[0-9a-f-]{36}$/),
      action: z.enum(vaultActions),
      inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      expectedGeneration: uint,
    }),
    storage: storageReservationSchema,
    os: z
      .strictObject({
        uid: uint.min(1),
        gid: uint.min(1),
        imageDevice: uint,
        imageInode: uint.min(1),
        mountDevice: z.string().regex(/^7:\d+$/),
      })
      .nullable(),
  })
  .refine(
    (v) =>
      v.receipt.vaultId === v.storage.vaultId &&
      v.receipt.localPort === v.storage.port &&
      v.receipt.displayName === v.displayName &&
      v.operation.expectedGeneration < v.receipt.generation
  )
export type ControlReceipt = z.infer<typeof controlReceiptSchema>
export type VaultMutation = Extract<ManagedBigbrainHostRequest, { action: (typeof vaultActions)[number] }>

function parsedMutation(input: unknown): VaultMutation {
  const parsed = managedBigbrainHostRequestSchema.safeParse(input)
  if (!parsed.success || !vaultActions.includes(parsed.data.action as (typeof vaultActions)[number]))
    throw new Error('invalid_request')
  return parsed.data as VaultMutation
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)])
    )
  return value
}
/** Safe recipe hash, not raw input persistence. Transport epoch is independently admitted
 * against the CURRENT installed host; authorized suspend/resume may advance it during retry.
 * Compatible Core packaging also changes artifactDigest: it is separately checked against
 * the CURRENT installed artifact before this function. Never confuse that transport/install
 * fence with a new creation recipe (which would strand pending creates after upgrades).
 * Physical binding, upstream pin and resource/owner/origin intent remain hashed.
 */
export function hashVaultRequest(input: unknown): string {
  const { hostEpoch: _, ...request } = parsedMutation(input)
  let recipe: unknown = request
  if (request.action === 'create') {
    const { artifactDigest: _digest, ...intent } = request
    recipe = intent
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(recipe)))
    .digest('hex')}`
}

/** Must follow validateHostAdmission under the lifecycle lock. Does not perform effects:
 * replay resumes only the recorded phase; uncertainty is never permission to initialize/mint.
 */
export function admitVaultRequest(input: unknown, existing: ControlReceipt | null): 'create' | 'advance' | 'replay' {
  const request = parsedMutation(input)
  if (existing === null) {
    if (request.action !== 'create') throw new Error('not_found')
    if (request.expectedGeneration !== 0) throw new Error('generation_conflict')
    return 'create'
  }
  const parsed = controlReceiptSchema.safeParse(existing)
  if (!parsed.success) throw new Error('storage_unavailable')
  const current = parsed.data
  const receipt = current.receipt
  if (
    receipt.tenantId !== request.tenantId ||
    receipt.physicalHostBinding !== request.physicalHostBinding ||
    receipt.vaultId !== request.vaultId
  )
    throw new Error('identity_mismatch')
  if (request.hostEpoch < receipt.hostEpoch) throw new Error('generation_conflict')
  if (request.requestId === current.operation.requestId) {
    if (receipt.generation !== request.generation || current.operation.inputHash !== hashVaultRequest(request))
      throw new Error('request_conflict')
    return 'replay'
  }
  if (
    request.expectedGeneration !== receipt.generation ||
    request.generation <= receipt.generation ||
    receipt.state === 'deleted'
  )
    throw new Error('generation_conflict')
  if (request.action === 'create') throw new Error('request_conflict')
  return 'advance'
}
