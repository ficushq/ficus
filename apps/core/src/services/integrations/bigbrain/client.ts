import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { BigbrainError } from './errors'
import { BigbrainBindings, type BigbrainConfigV2 } from './local-bindings'
import { BigbrainStdioTransport } from './stdio-transport'

export const BIGBRAIN_OPERATIONS = ['load_memory', 'search_vault', 'read_note', 'drop'] as const
export type BigbrainOperation = (typeof BIGBRAIN_OPERATIONS)[number]
const text = z.string().trim().min(1).max(1000)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const sourceIdentifier = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (s) =>
      !s.startsWith('/') &&
      !/^[a-z]:/i.test(s) &&
      !s.includes('\\') &&
      [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      s.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
  )
export const searchInput = z
  .object({
    query: text.optional(),
    queries: z.array(text).min(1).max(8).optional(),
    n: z.number().int().min(1).max(50).optional(),
    source: z.string().min(1).max(128).optional(),
    after: day.optional(),
    before: day.optional(),
    type: z.enum(['reference', 'entity']).optional(),
  })
  .strict()
  .refine((s) => (s.query !== undefined) !== (s.queries !== undefined))
export const readInput = z
  .object({
    path: sourceIdentifier,
    start: z.number().int().nonnegative().safe().optional(),
    chars: z.number().int().min(1).max(80000).optional(),
    q: text.optional(),
    slack: z.number().int().min(0).max(20).optional(),
    after: day.optional(),
    before: day.optional(),
    n: z.number().int().min(1).max(1000).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    toc: z.boolean().optional(),
    attachment: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (s) =>
          /^blob:[a-f0-9]{64}$/.test(s) ||
          (!s.includes('/') &&
            !s.includes('\\') &&
            !s.includes(':') &&
            s !== '.' &&
            s !== '..' &&
            [...s].every((c) => c.charCodeAt(0) >= 32))
      )
      .optional(),
  })
  .strict()
export const dropInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z
      .string()
      .min(1)
      .refine((s) => !!s.trim() && Buffer.byteLength(s) <= 128 * 1024),
    kind: z.enum(['note', 'idea', 'finding', 'research', 'request']).optional(),
  })
  .strict()
const hit = z
  .object({
    path: sourceIdentifier,
    title: z.string().optional(),
    snippet: z.string().optional(),
    score: z.number().finite().optional(),
  })
  .passthrough()
const searchResult = z
  .object({
    hits: z.array(hit).max(50),
    only_agent_records: z.boolean().optional(),
    applied_filters: z.record(z.string(), z.unknown()).optional(),
    relaxation: z.unknown().optional(),
  })
  .passthrough()
const integer = z.number().int().nonnegative().safe()
const noteResult = z
  .object({
    path: sourceIdentifier,
    markdown: z.string(),
    markdown_length: integer.optional(),
    start: integer.optional(),
    end: integer.optional(),
    truncated: z.boolean().optional(),
    links: z.array(z.object({ name: z.string(), path: sourceIdentifier.nullable() }).passthrough()).optional(),
  })
  .passthrough()
  .refine((s) => {
    const fields = [s.markdown_length, s.start, s.end]
    return (
      fields.every((f) => f === undefined) ||
      (fields.every((f) => f !== undefined) && s.start! <= s.end! && s.end! <= s.markdown_length!)
    )
  })
const dropResult = z.union([
  z.object({ queued: z.literal(true), id: z.string().min(1).max(256) }).passthrough(),
  z
    .object({ id: z.string().min(1).max(256), path: sourceIdentifier, ref_path: sourceIdentifier.optional() })
    .passthrough()
    .refine((s) => !('queued' in s)),
])
export interface BigbrainCallOptions {
  signal?: AbortSignal
  beforeCall?: () => Promise<void>
}
export interface BigbrainClientOptions {
  configuration?: BigbrainConfigV2
  clientId?: string
  bindings?: BigbrainBindings
  transport?: () => Promise<Transport>
  startupMs?: number
  readMs?: number
  writeMs?: number
}
/** Fixed MCP capability adapter. No upstream instructions, prompts, resources or arbitrary tools are exposed. */
export class BigbrainClient {
  constructor(readonly options: BigbrainClientOptions) {}
  loadMemory(options: BigbrainCallOptions = {}): Promise<string> {
    return this.#call('load_memory', {}, z.string(), options)
  }
  async searchVault(input: z.input<typeof searchInput>, options: BigbrainCallOptions = {}) {
    return this.#call('search_vault', parseInput(searchInput, input), searchResult, options)
  }
  async readNote(input: z.input<typeof readInput>, options: BigbrainCallOptions = {}) {
    const args = parseInput(readInput, input)
    return this.#call(
      'read_note',
      args,
      noteResult.refine((s) => s.path === args.path),
      options
    )
  }
  async drop(input: z.input<typeof dropInput>, options: BigbrainCallOptions = {}) {
    return this.#call('drop', parseInput(dropInput, input), dropResult, options)
  }
  async validate(options: BigbrainCallOptions = {}): Promise<string[]> {
    await this.#session(false, options, async (client, signal) => {
      const listed = await client.listTools({}, { signal })
      const names = new Set(listed.tools.map((t) => t.name))
      if (!BIGBRAIN_OPERATIONS.every((name) => names.has(name))) throw new BigbrainError('invalid_response')
      await options.beforeCall?.()
      this.#result(
        'search_vault',
        await client.callTool(
          { name: 'search_vault', arguments: { query: '__ficus_connection_validation__', n: 1 } },
          undefined,
          { signal }
        ),
        searchResult
      )
    })
    return BIGBRAIN_OPERATIONS.map((name) => `mcp:${name}`)
  }
  async #call<T>(
    name: BigbrainOperation,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
    options: BigbrainCallOptions
  ): Promise<T> {
    return this.#session(name === 'drop', options, async (client, signal) => {
      await options.beforeCall?.()
      return this.#result(name, await client.callTool({ name, arguments: args }, undefined, { signal }), schema)
    })
  }
  #result<T>(name: BigbrainOperation, value: unknown, schema: z.ZodType<T>): T {
    if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new BigbrainError('response_too_large')
    const result = z
      .object({
        content: z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()).min(1),
        isError: z.boolean().optional(),
      })
      .safeParse(value)
    if (!result.success) throw new BigbrainError('invalid_response')
    const content = result.data.content.map((c) => c.text).join('\n')
    if (result.data.isError) {
      // Only recognized authentication responses invalidate material. Never surface provider text.
      if (
        /^This BigBrain (?:connection|credential) expired|^Authenticate a current client connection|^Client connection was revoked|^Client credential is unavailable/i.test(
          content
        )
      )
        throw new BigbrainError('invalid_auth')
      throw new BigbrainError('unavailable')
    }
    try {
      const parsed: unknown = name === 'load_memory' ? content : JSON.parse(content)
      validateResponsePaths(parsed)
      return schema.parse(parsed)
    } catch {
      throw new BigbrainError('invalid_response')
    }
  }
  async #session<T>(
    write: boolean,
    options: BigbrainCallOptions,
    run: (client: Client, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    let timedOut = false
    let dispatched = false
    const timer = setTimeout(
      () => {
        timedOut = true
        abort()
      },
      (write ? (this.options.writeMs ?? 30000) : (this.options.readMs ?? 15000)) - 1000
    )
    const client = new Client({ name: 'ficus-bigbrain', version: '1' })
    let transport: Transport | undefined
    let transportFailure: BigbrainError | undefined
    client.onerror = (error) => {
      if (error instanceof BigbrainError) transportFailure = error
    }
    try {
      if (controller.signal.aborted) throw new BigbrainError('cancelled')
      await options.beforeCall?.()
      if (this.options.transport) transport = await this.options.transport()
      else {
        if (!this.options.configuration) throw new BigbrainError('invalid_configuration')
        const binding = await (this.options.bindings ?? new BigbrainBindings()).resolvePinned(
          this.options.configuration
        )
        if (binding.clientId !== this.options.clientId) throw new BigbrainError('binding_changed')
        transport = new BigbrainStdioTransport({
          ...binding.configuration,
          clientId: binding.clientId,
          tokenStorePath: binding.tokenStorePath,
        })
      }
      await client.connect(transport, { signal: controller.signal, timeout: this.options.startupMs ?? 5000 })
      const beforeCall = options.beforeCall
      // The final live gate is inside run, immediately preceding dispatch.
      await beforeCall?.()
      dispatched = true
      return await run(client, controller.signal)
    } catch (error) {
      if (transportFailure) throw transportFailure
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
        throw new BigbrainError(write && dispatched ? 'outcome_unknown' : 'timeout')
      if (timedOut || options.signal?.aborted)
        throw new BigbrainError(write && dispatched ? 'outcome_unknown' : timedOut ? 'timeout' : 'cancelled')
      if (error instanceof BigbrainError) throw error
      throw new BigbrainError('unavailable')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      await client.close().catch(() => {})
      await transport?.close().catch(() => {})
    }
  }
}
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new BigbrainError('invalid_configuration')
  return result.data
}

/** Provenance stays data, but any path-shaped references must remain safe opaque vault IDs. */
function validateResponsePaths(value: unknown, depth = 0): void {
  if (depth > 64) throw new BigbrainError('invalid_response')
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const entry of value) validateResponsePaths(entry, depth + 1)
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      ['path', 'ref_path', 'source_path'].includes(key) &&
      entry !== null &&
      !sourceIdentifier.safeParse(entry).success
    )
      throw new BigbrainError('invalid_response')
    validateResponsePaths(entry, depth + 1)
  }
}
