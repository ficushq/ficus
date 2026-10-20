/**
 * Private Core → Platform transport for managed shared BigBrain vaults.
 *
 * Fixed route templates under `/api/managed-bigbrain` (the contract's Platform endpoints), the
 * instance bearer, no redirects, a bounded body and deadline, and strict shared response schemas.
 * Errors carry only an allowlisted contract code; raw Platform bodies, URLs and tokens never cross
 * this boundary. The client never retries on its own: callers repeat the SAME request ID (Platform
 * replays it idempotently) and never mint a new identity or invite to recover from a lost reply.
 */
import type { ZodType } from 'zod'
import {
  MANAGED_BIGBRAIN_ERROR_CODES,
  managedBigbrainCapabilitiesSchema,
  managedBigbrainDeleteVaultSchema,
  managedBigbrainOperationSchema,
  managedBigbrainOwnerInviteResultSchema,
  managedBigbrainOwnerInviteSchema,
  managedBigbrainPutVaultSchema,
  managedBigbrainReadAccessSchema,
  managedBigbrainRetrySchema,
  managedBigbrainVaultListSchema,
  managedBigbrainVaultSummarySchema,
  type ManagedBigbrainCapabilities,
  type ManagedBigbrainDeleteVault,
  type ManagedBigbrainErrorCode,
  type ManagedBigbrainOperation,
  type ManagedBigbrainOwnerInvite,
  type ManagedBigbrainOwnerInviteResult,
  type ManagedBigbrainPutVault,
  type ManagedBigbrainReadAccess,
  type ManagedBigbrainRetry,
  type ManagedBigbrainVaultList,
  type ManagedBigbrainVaultSummary,
} from '@ficus/shared/managed-bigbrain'
import { BrokerUnconfiguredError, requireBrokerConfig } from '../../authorization/authority'
import {
  PlatformRequestError,
  buildPlatformUrl,
  parseSafeCode,
  readBoundedBody,
} from '../../../platform/instance-client'

const PREFIX = '/api/managed-bigbrain'
const DEFAULT_TIMEOUT_MS = 20_000
/** Two summaries or one capability record are a few KiB; anything larger is not a contract reply. */
const MAX_RESPONSE_BYTES = 64 * 1024
const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CONTRACT_CODES: ReadonlySet<string> = new Set(MANAGED_BIGBRAIN_ERROR_CODES)
const RETRYABLE_CODES: ReadonlySet<ManagedBigbrainErrorCode> = new Set([
  'busy',
  'capacity',
  'host_unreachable',
  'maintenance',
  'operation_failed',
  'upstream_unavailable',
])

export class ManagedBigbrainPlatformError extends Error {
  constructor(
    readonly code: ManagedBigbrainErrorCode,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(code)
    this.name = 'ManagedBigbrainPlatformError'
  }
}

type CallOptions = { timeoutMs?: number; signal?: AbortSignal }
type Method = 'GET' | 'PUT' | 'POST' | 'DELETE'

function refuse(code: ManagedBigbrainErrorCode, status?: number, retryable?: boolean): never {
  throw new ManagedBigbrainPlatformError(code, retryable ?? (RETRYABLE_CODES.has(code) || status === 429), status)
}

function vaultPath(vaultId: string, suffix = ''): string {
  if (!VAULT_ID.test(vaultId)) refuse('invalid_request')
  return `${PREFIX}/vaults/${vaultId}${suffix}`
}

function checkedBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) refuse('invalid_request')
  return parsed.data
}

/** HTTP status → contract code when Platform's body carries no allowlisted code. */
function statusCode(status: number): ManagedBigbrainErrorCode {
  if (status === 400) return 'invalid_request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'request_conflict'
  if (status === 429) return 'capacity'
  if (status >= 500) return 'operation_failed'
  return 'invalid_response'
}

async function call<T>(
  method: Method,
  path: string,
  schema: ZodType<T>,
  body: unknown,
  options: CallOptions = {}
): Promise<T> {
  let config: { baseUrl: string; token: string }
  let url: URL
  try {
    config = requireBrokerConfig()
    url = buildPlatformUrl(config.baseUrl, path)
  } catch (error) {
    if (error instanceof BrokerUnconfiguredError) refuse('not_installed', undefined, false)
    throw error
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const abortFromCaller = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      refuse('host_unreachable', undefined, true)
    }
    let bytes: Uint8Array
    try {
      bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES)
    } catch (error) {
      if (controller.signal.aborted) refuse('host_unreachable', response.status, true)
      if (error instanceof PlatformRequestError) refuse('output_limit', response.status, false)
      refuse('host_unreachable', response.status, true)
    }
    if (response.status < 200 || response.status > 299) {
      const platformCode = parseSafeCode(bytes)
      const code =
        platformCode && CONTRACT_CODES.has(platformCode)
          ? (platformCode as ManagedBigbrainErrorCode)
          : statusCode(response.status)
      refuse(code, response.status)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      refuse('invalid_response', response.status, false)
    }
    const parsed = schema.safeParse(decoded)
    if (!parsed.success) refuse('invalid_response', response.status, false)
    return parsed.data
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

/** A reply about a different vault than the one addressed is never applied to local state. */
function sameVault<T extends { vaultId: string }>(vaultId: string, value: T): T {
  if (value.vaultId !== vaultId) refuse('invalid_response', undefined, false)
  return value
}

export const managedBigbrainPlatform = {
  /** `expectedTenantId`: the tenant this Core already recorded; a different binding is refused. */
  async capabilities(options: CallOptions & { expectedTenantId?: string } = {}): Promise<ManagedBigbrainCapabilities> {
    const value = await call('GET', `${PREFIX}/capabilities`, managedBigbrainCapabilitiesSchema, undefined, options)
    if (options.expectedTenantId !== undefined && value.tenantId !== options.expectedTenantId)
      refuse('identity_mismatch', undefined, false)
    return value
  },
  listVaults(options?: CallOptions): Promise<ManagedBigbrainVaultList> {
    return call('GET', `${PREFIX}/vaults`, managedBigbrainVaultListSchema, undefined, options)
  },
  async getVault(vaultId: string, options?: CallOptions): Promise<ManagedBigbrainVaultSummary> {
    const path = vaultPath(vaultId)
    return sameVault(vaultId, await call('GET', path, managedBigbrainVaultSummarySchema, undefined, options))
  },
  async putVault(
    vaultId: string,
    input: ManagedBigbrainPutVault,
    options?: CallOptions
  ): Promise<ManagedBigbrainOperation> {
    const path = vaultPath(vaultId)
    const body = checkedBody(managedBigbrainPutVaultSchema, input)
    return sameVault(vaultId, await call('PUT', path, managedBigbrainOperationSchema, body, options))
  },
  async retryVault(
    vaultId: string,
    input: ManagedBigbrainRetry,
    options?: CallOptions
  ): Promise<ManagedBigbrainOperation> {
    const path = vaultPath(vaultId, '/retry')
    const body = checkedBody(managedBigbrainRetrySchema, input)
    return sameVault(vaultId, await call('POST', path, managedBigbrainOperationSchema, body, options))
  },
  async setReadAccess(
    vaultId: string,
    input: ManagedBigbrainReadAccess,
    options?: CallOptions
  ): Promise<ManagedBigbrainOperation> {
    const path = vaultPath(vaultId, '/read-access')
    const body = checkedBody(managedBigbrainReadAccessSchema, input)
    return sameVault(vaultId, await call('POST', path, managedBigbrainOperationSchema, body, options))
  },
  async deleteVault(
    vaultId: string,
    input: ManagedBigbrainDeleteVault,
    options?: CallOptions
  ): Promise<ManagedBigbrainOperation> {
    const path = vaultPath(vaultId)
    const body = checkedBody(managedBigbrainDeleteVaultSchema, input)
    if (body.confirmedVaultId !== vaultId) refuse('invalid_request')
    return sameVault(vaultId, await call('DELETE', path, managedBigbrainOperationSchema, body, options))
  },
  /** SECRET result: the caller re-verifies the live owner before returning it, and must never log,
   * cache, audit or persist it. */
  async createOwnerInvite(
    vaultId: string,
    input: ManagedBigbrainOwnerInvite,
    options?: CallOptions
  ): Promise<ManagedBigbrainOwnerInviteResult> {
    const path = vaultPath(vaultId, '/owner-invite')
    const body = checkedBody(managedBigbrainOwnerInviteSchema, input)
    const result = await call('POST', path, managedBigbrainOwnerInviteResultSchema, body, options)
    if (!result.inviteUrl.startsWith(`https://bb-${vaultId.replaceAll('-', '')}.`))
      refuse('invalid_response', undefined, false)
    return result
  },
}
export type ManagedBigbrainPlatformClient = typeof managedBigbrainPlatform
