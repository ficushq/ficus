import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_MCP_PROTOCOL,
  MANAGED_BIGBRAIN_SHARED_PROTOCOL,
  managedBigbrainCapabilitiesSchema,
  managedBigbrainOriginHasVault,
  managedBigbrainReadHandoffSchema,
  type ManagedBigbrainCapabilities,
  type ManagedBigbrainReadHandoff,
  type ManagedBigbrainState,
} from '@ficus/shared/managed-bigbrain'
import { BigbrainError } from './errors'
import { MANAGED_VAULT_READABLE_STATES } from './managed/readable'

/** The credential-free gateway listens ONLY on this root-prepared Unix socket (no TCP listener);
 * the vault is selected by the receipt origin's Host header, never by a caller-supplied URL. */
export const BIGBRAIN_SHARED_GATEWAY_SOCKET = '/run/ficus-bigbrain/gateway/http.sock'
export const BIGBRAIN_SHARED_RESPONSE_BYTES = 512 * 1024
const text = z.string().trim().min(1).max(1000)
const integer = z.number().int().safe().nonnegative()
export const sharedSearchInput = z
  .object({
    query: text.optional(),
    queries: z.array(text).min(1).max(8).optional(),
    limit: integer.min(1).max(50).optional(),
  })
  .strict()
  .refine((v) => (v.query !== undefined) !== (v.queries !== undefined))
export const sharedReadInput = z
  .object({
    id: z
      .string()
      .max(200)
      .regex(/^(?:ins|ast|ent)_[a-zA-Z0-9_-]+$/),
    start: integer.optional(),
    chars: integer.min(1).max(80000).optional(),
  })
  .strict()
export const sharedRecentInput = z
  .object({ before: integer.min(1).optional(), limit: integer.min(1).max(50).optional() })
  .strict()
const rpcResult = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.string(),
    result: z
      .object({
        content: z
          .array(z.object({ type: z.literal('text'), text: z.string() }).strict())
          .min(1)
          .max(32),
        isError: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
const whoamiSchema = z
  .object({
    vault: z.object({ id: z.string().uuid() }).passthrough(),
    role: z.string(),
    kind: z.string(),
    permissions: z.array(z.string()).max(8),
    credential: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough()
type SharedFetch = (url: string, init: RequestInit) => Promise<Response>
/** Core's synchronized view of one managed vault (from authoritative Platform summaries). */
export interface ManagedReadVault {
  vaultId: string
  upstreamVaultId: string | null
  origin: string | null
  appliedGeneration: number
  state: ManagedBigbrainState
  readAccess: 'pending' | 'active' | 'revoked'
}
export interface BigbrainSharedClientOptions {
  /** Live, available Platform capability report: the current tenant/physical host/epoch. */
  capabilities: ManagedBigbrainCapabilities
  vault: ManagedReadVault
  /** Imported host read handoff. Minted at an earlier or equal host epoch and vault generation:
   * suspend/resume and rename advance those without re-minting; restore changes the host. */
  material: ManagedBigbrainReadHandoff
  /** Mandatory live assignment/provider/policy/material fence. Called before either dispatch and after read. */
  beforeCall: () => Promise<void>
  fetch?: SharedFetch
}

/** Read material is usable only for the live tenant/physical host at the pinned revision, for a
 * ready vault with active read access, and never ahead of what Core has observed (epoch and
 * generation may lag: suspend/resume and rename do not re-mint; restore changes the host). */
export function readMaterialMatches(
  capabilities: ManagedBigbrainCapabilities,
  vault: ManagedReadVault,
  material: Omit<ManagedBigbrainReadHandoff, 'token'>
): boolean {
  return (
    capabilities.available &&
    capabilities.hostState === 'active' &&
    material.tenantId === capabilities.tenantId &&
    material.physicalHostBinding === capabilities.physicalHostBinding &&
    material.hostEpoch <= capabilities.hostEpoch &&
    material.upstreamCommit === capabilities.upstreamCommit &&
    MANAGED_VAULT_READABLE_STATES.includes(vault.state) &&
    vault.readAccess === 'active' &&
    vault.vaultId === material.vaultId &&
    vault.upstreamVaultId === material.upstreamVaultId &&
    material.generation <= vault.appliedGeneration &&
    !!vault.origin &&
    managedBigbrainOriginHasVault(vault.origin, material.vaultId)
  )
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status === 401 || response.status === 403 || response.status === 429 || !response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new BigbrainError(
      response.status === 401
        ? 'invalid_auth'
        : response.status === 403
          ? 'missing_scope'
          : response.status === 429
            ? 'rate_limited'
            : 'unavailable'
    )
  }
  if (
    response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => {})
    throw new BigbrainError('invalid_response')
  }
  const declared = Number(response.headers.get('Content-Length'))
  if (declared > BIGBRAIN_SHARED_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => {})
    throw new BigbrainError('response_too_large')
  }
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (signal.aborted) throw new BigbrainError('cancelled')
    for (;;) {
      const next = await reader.read()
      if (signal.aborted) throw new BigbrainError('cancelled')
      if (next.done) break
      size += next.value.byteLength
      if (size > BIGBRAIN_SHARED_RESPONSE_BYTES) throw new BigbrainError('response_too_large')
      chunks.push(next.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Stateless pinned upstream adapter. It has NO contribution/admin/arbitrary MCP API.
 * Target selection is a root/Platform receipt, never an agent-provided URL or default vault.
 * Member evidence is returned unchanged as data, never interpreted as instructions.
 */
export class BigbrainSharedClient {
  private readonly request: SharedFetch
  private readonly origin: string
  private readonly material: ManagedBigbrainReadHandoff
  private readonly beforeCall: () => Promise<void>

  constructor(options: BigbrainSharedClientOptions) {
    const capabilities = managedBigbrainCapabilitiesSchema.safeParse(options.capabilities)
    const material = managedBigbrainReadHandoffSchema.safeParse(options.material)
    if (!capabilities.success || !material.success || typeof options.beforeCall !== 'function')
      throw new BigbrainError('invalid_configuration')
    if (!readMaterialMatches(capabilities.data, options.vault, material.data))
      throw new BigbrainError('binding_changed')
    this.origin = options.vault.origin!
    this.material = material.data
    this.beforeCall = options.beforeCall
    this.request = options.fetch ?? ((url, init) => fetch(url, { ...init, unix: BIGBRAIN_SHARED_GATEWAY_SOCKET }))
  }

  /** Identity only: the credential authenticates as exactly the read-only agent reader of THIS
   * upstream vault (used for validation; no MCP tool is called). */
  async verify(options?: { signal?: AbortSignal }): Promise<void> {
    await this.read(null, {}, options?.signal)
  }
  overview(options?: { signal?: AbortSignal }): Promise<string> {
    return this.read('overview', {}, options?.signal)
  }
  searchVault(input: z.input<typeof sharedSearchInput>, options?: { signal?: AbortSignal }): Promise<string> {
    const args = sharedSearchInput.safeParse(input)
    if (!args.success) return Promise.reject(new BigbrainError('invalid_configuration'))
    return this.read('search_vault', args.data, options?.signal)
  }
  readRecord(input: z.input<typeof sharedReadInput>, options?: { signal?: AbortSignal }): Promise<string> {
    const args = sharedReadInput.safeParse(input)
    if (!args.success) return Promise.reject(new BigbrainError('invalid_configuration'))
    return this.read('read_record', { start: 0, chars: 20000, ...args.data }, options?.signal)
  }
  recent(input: z.input<typeof sharedRecentInput> = {}, options?: { signal?: AbortSignal }): Promise<string> {
    const args = sharedRecentInput.safeParse(input)
    if (!args.success) return Promise.reject(new BigbrainError('invalid_configuration'))
    return this.read('recent', args.data, options?.signal)
  }

  private async read(
    name: 'overview' | 'search_vault' | 'read_record' | 'recent' | null,
    args: Record<string, unknown>,
    callerSignal?: AbortSignal
  ): Promise<string> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 15000)
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal
    const check = async () => {
      if (signal.aborted) throw new BigbrainError('cancelled')
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort)
          reject(new BigbrainError('cancelled'))
        }
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve()
          .then(() => {
            if (signal.aborted) throw new BigbrainError('cancelled')
            return this.beforeCall()
          })
          .then(
            () => {
              signal.removeEventListener('abort', abort)
              resolve()
            },
            (error) => {
              signal.removeEventListener('abort', abort)
              reject(error)
            }
          )
        if (signal.aborted) abort()
      })
      if (signal.aborted) throw new BigbrainError('cancelled')
    }
    const headers = {
      Authorization: `Bearer ${this.material.token}`,
      Host: new URL(this.origin).hostname,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MANAGED_BIGBRAIN_MCP_PROTOCOL,
    }
    const send = (path: '/v1/whoami' | '/mcp', init: RequestInit) =>
      this.request(`http://localhost${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal,
      })
    try {
      await check()
      const identityResponse = await send('/v1/whoami', { method: 'GET' })
      // REST protocol is deliberately separate: upstream MCP does not add this header.
      if (identityResponse.headers.get('BigBrain-Protocol') !== String(MANAGED_BIGBRAIN_SHARED_PROTOCOL)) {
        await identityResponse.body?.cancel().catch(() => {})
        throw new BigbrainError('invalid_response')
      }
      const identity = whoamiSchema.safeParse(await boundedJson(identityResponse, signal))
      if (!identity.success) throw new BigbrainError('invalid_response')
      const actor = identity.data
      if (actor.vault.id !== this.material.upstreamVaultId || actor.credential.id !== this.material.credentialId)
        throw new BigbrainError('binding_changed')
      if (
        actor.role !== 'member' ||
        actor.kind !== 'agent' ||
        actor.permissions.length !== 1 ||
        actor.permissions[0] !== 'read'
      )
        throw new BigbrainError('invalid_auth')
      await check()
      if (name === null) return ''
      const id = randomUUID()
      const response = await send('/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      })
      const result = rpcResult.safeParse(await boundedJson(response, signal))
      if (!result.success || result.data.id !== id || result.data.result.isError)
        throw new BigbrainError('invalid_response')
      await check()
      return result.data.result.content.map((block) => block.text).join('\n')
    } catch (error) {
      if (timedOut) throw new BigbrainError('timeout')
      if (callerSignal?.aborted) throw new BigbrainError('cancelled')
      if (error instanceof BigbrainError) throw error
      // Never surface fetch/Zod/JSON errors: they may contain auth headers or member content.
      throw new BigbrainError('invalid_response')
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
}
