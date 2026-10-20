import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_HOST_REQUEST_BYTES,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  managedBigbrainInstalledHostSchema,
  managedBigbrainHostRequestSchema,
  managedBigbrainHostStateSchema,
  managedBigbrainLimitsSchema,
  managedBigbrainOriginMatchesPolicy,
  parseManagedBigbrainHostRequest,
  type ManagedBigbrainHostRequest,
} from '@ficus/shared/managed-bigbrain'

/** The root-owned installed host record (shared so Core can read it for the helper envelope). */
export const installedHostSchema = managedBigbrainInstalledHostSchema
export type InstalledHost = z.infer<typeof installedHostSchema>

/** Admission is necessary, not sufficient: caller must also hold the root lifecycle lock,
 * verify receipt generations/replay effects and all filesystem/artifact ownership checks.
 * Callers are root processes on this host: hosted Core (per-vault operations, which runs as root
 * by an accepted documented boundary), the local backup tool, and Platform's pinned SSH for
 * tenant lifecycle actions.
 */
export function validateHostAdmission(input: unknown, manifest: unknown): ManagedBigbrainHostRequest {
  const request = managedBigbrainHostRequestSchema.safeParse(input)
  const host = installedHostSchema.safeParse(manifest)
  if (!request.success) throw new Error('invalid_request')
  if (!host.success) throw new Error('not_installed')
  const r = request.data
  const h = host.data
  if (r.tenantId !== h.tenantId || r.physicalHostBinding !== h.physicalHostBinding) throw new Error('identity_mismatch')
  if ('previousHostEpoch' in r) {
    const replay =
      r.hostEpoch === h.hostEpoch &&
      h.effect !== null &&
      h.effect.action === r.action &&
      h.effect.effectId === r.effectId &&
      h.effect.previousHostEpoch === r.previousHostEpoch
    if (!replay && r.previousHostEpoch !== h.hostEpoch) throw new Error('generation_conflict')
  } else if (r.hostEpoch !== h.hostEpoch) throw new Error('generation_conflict')
  if (h.hostState !== 'active' && ['create', 'rename', 'owner-invite', 'read-reconnect', 'restore'].includes(r.action))
    throw new Error('forbidden')
  if (r.action === 'create') {
    if (r.upstreamCommit !== h.upstreamCommit || r.artifactDigest !== h.artifactDigest) throw new Error('pin_mismatch')
    if (!managedBigbrainOriginMatchesPolicy(r.origin, r.vaultId, h.zone)) throw new Error('identity_mismatch')
    for (const key of Object.keys(h.limits) as (keyof typeof h.limits)[]) {
      if (r.limits[key] !== h.limits[key]) throw new Error('resource_limit')
    }
  }
  return r
}

/** Incremental stdin cap and deadline; never collect an unbounded stream before parsing. */
export async function readHostRequest(stream: ReadableStream<Uint8Array>): Promise<ManagedBigbrainHostRequest> {
  return parseManagedBigbrainHostRequest(await readBoundedControlBytes(stream))
}
export async function readBoundedControlBytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void reader.cancel().catch(() => {})
  }, 5000)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MANAGED_BIGBRAIN_HOST_REQUEST_BYTES) throw new Error('invalid_request')
      chunks.push(result.value)
    }
    if (timedOut) throw new Error('invalid_request')
    return Buffer.concat(chunks)
  } catch {
    throw new Error('invalid_request')
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
