/**
 * Additive BigBrain configuration variant for managed shared vaults (still adapter version 2).
 *
 * The personal/local `BigbrainConfigSchema` is unchanged and carries no mode discriminator, so
 * dispatch is by THIS strict schema first: a managed row can never parse as a local binding (and
 * so never reach personal `drop`), and a local row can never parse as managed. Code that predates
 * this variant refuses the managed shape instead of routing it as personal.
 */
import { z } from 'zod'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { BigbrainConfigSchema, type BigbrainConfigV2 } from '../local-bindings'

const uuid = z.uuid().regex(/^[0-9a-f-]{36}$/)

export const ManagedSharedConfigSchema = z.strictObject({
  version: z.literal(2),
  mode: z.literal('managed_shared'),
  vaultId: uuid,
  upstreamVaultId: uuid,
  upstreamCommit: z.literal(MANAGED_BIGBRAIN_UPSTREAM_COMMIT),
})
export type ManagedSharedConfig = z.infer<typeof ManagedSharedConfigSchema>
export type BigbrainConfiguration = BigbrainConfigV2 | ManagedSharedConfig

export function isManagedSharedConfig(value: unknown): value is ManagedSharedConfig {
  return ManagedSharedConfigSchema.safeParse(value).success
}

/** Strict variant dispatch: exactly one schema accepts a stored configuration. */
export function parseBigbrainConfiguration(value: unknown): BigbrainConfiguration {
  const managed = ManagedSharedConfigSchema.safeParse(value)
  if (managed.success) return managed.data
  return BigbrainConfigSchema.parse(value)
}

/** Local bindings authenticate with an 8-hex client ID; managed reads with an upstream `sv_`
 * read token. Each is only meaningful for its own variant. */
const LOCAL_CLIENT_ID = /^[a-f0-9]{8}$/
/** Same shape as the host read handoff token (`managedBigbrainReadHandoffSchema`). */
const SHARED_READ_TOKEN = /^sv_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/
export function parseBigbrainCredential(value: unknown): string {
  if (typeof value !== 'string' || !(LOCAL_CLIENT_ID.test(value) || SHARED_READ_TOKEN.test(value)))
    throw new Error('Invalid credential')
  return value
}
export function credentialMatchesConfiguration(configuration: BigbrainConfiguration, credential: string): boolean {
  return isManagedSharedConfig(configuration) ? SHARED_READ_TOKEN.test(credential) : LOCAL_CLIENT_ID.test(credential)
}
