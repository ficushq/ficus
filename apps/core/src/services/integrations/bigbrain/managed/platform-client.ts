/**
 * Private Core → Platform transport for managed shared BigBrain vaults: support (capabilities)
 * and per-vault DNS only. Vault operations run locally through the root helper.
 *
 * Fixed route templates under `/api/managed-bigbrain`, the instance bearer, no redirects, a
 * bounded body and deadline, and strict shared response schemas. Errors carry only an
 * allowlisted contract code; raw Platform bodies, URLs and tokens never cross this boundary.
 */
import { z, type ZodType, type ZodTypeDef } from 'zod'
import {
  MANAGED_BIGBRAIN_ERROR_CODES,
  managedBigbrainCapabilitiesSchema,
  managedBigbrainDnsRecordSchema,
  managedBigbrainDnsRequestFor,
  type ManagedBigbrainCapabilities,
  type ManagedBigbrainDnsRecord,
  type ManagedBigbrainErrorCode,
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
const CONTRACT_CODES: ReadonlySet<string> = new Set(MANAGED_BIGBRAIN_ERROR_CODES)
const RETRYABLE_CODES: ReadonlySet<ManagedBigbrainErrorCode> = new Set([
  'busy',
  'dns_unavailable',
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
  schema: ZodType<T, ZodTypeDef, unknown>,
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
      decoded =
        response.status === 204 && bytes.byteLength === 0
          ? undefined
          : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
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

const VAULT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function dnsPath(vaultId: string): string {
  if (!VAULT.test(vaultId)) refuse('invalid_request')
  return `${PREFIX}/dns/${vaultId}`
}

/** Platform keeps only what it alone can do: the capability report (pinned-SSH probe, binding,
 * epoch, certificate/zone coverage) and the exact per-vault DNS record. Core never sends names,
 * owners or generations, and Platform keeps no vault records. */
export const managedBigbrainPlatform = {
  /** `expectedTenantId`: the tenant this Core already recorded; a different binding is refused. */
  async support(options: CallOptions & { expectedTenantId?: string } = {}): Promise<ManagedBigbrainCapabilities> {
    const value = await call('GET', `${PREFIX}/capabilities`, managedBigbrainCapabilitiesSchema, undefined, options)
    if (options.expectedTenantId !== undefined && value.tenantId !== options.expectedTenantId)
      refuse('identity_mismatch', undefined, false)
    return value
  },
  /** Idempotent: Platform creates or returns the exact owned record for this vault's recorded
   * origin (a tenant-prefixed one is sent as chosen at create; Platform never derives it). A
   * record for another origin is never accepted. */
  async ensureDns(vaultId: string, expectedOrigin: string, options?: CallOptions): Promise<ManagedBigbrainDnsRecord> {
    let body: { origin?: string }
    try {
      // `{}` for bb-<32 hex> (what older Platform builds accept); the origin only when prefixed.
      body = managedBigbrainDnsRequestFor(vaultId, expectedOrigin)
    } catch {
      refuse('invalid_request')
    }
    const record = await call('PUT', dnsPath(vaultId), managedBigbrainDnsRecordSchema, body, options)
    if (record.vaultId !== vaultId || record.origin !== expectedOrigin) refuse('identity_mismatch', undefined, false)
    return record
  },
  /** Removes only the exact owned record; an absent record is already the goal. */
  async deleteDns(vaultId: string, options?: CallOptions): Promise<void> {
    try {
      await call('DELETE', dnsPath(vaultId), z.unknown(), undefined, options)
    } catch (error) {
      if (error instanceof ManagedBigbrainPlatformError && error.code === 'not_found') return
      throw error
    }
  },
}
export type ManagedBigbrainPlatformClient = typeof managedBigbrainPlatform
