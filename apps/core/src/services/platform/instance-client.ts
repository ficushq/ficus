import type { ZodType } from 'zod'
import { SAFE_CODE_PATTERN } from '@ficus/shared/oauth-broker'
import { BrokerUnconfiguredError, requireBrokerConfig } from '../integrations/authorization/authority'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 64 * 1024

export class PlatformRequestError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(code)
    this.name = 'PlatformRequestError'
  }
}

export async function platformRequest<T>(input: {
  path: string
  body: unknown
  schema: ZodType<T>
  timeoutMs?: number
  signal?: AbortSignal
  maxResponseBytes?: number
}): Promise<T> {
  if (
    input.maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(input.maxResponseBytes) ||
      input.maxResponseBytes <= 0 ||
      input.maxResponseBytes > 12 * 1024 * 1024)
  )
    throw new PlatformRequestError('invalid_response_limit', false)
  let config: { baseUrl: string; token: string }
  try {
    config = requireBrokerConfig()
  } catch (error) {
    if (error instanceof BrokerUnconfiguredError) throw error
    throw new BrokerUnconfiguredError()
  }

  const url = buildPlatformUrl(config.baseUrl, input.path)
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const abortFromCaller = () => controller.abort()
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input.body),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      throw new PlatformRequestError(timedOut ? 'broker_timeout' : 'broker_unavailable', true)
    }

    if (response.status === 401) {
      await cancelResponseBody(response)
      throw new PlatformRequestError('broker_unauthorized', false, 401)
    }
    if (response.status === 403) {
      await cancelResponseBody(response)
      throw new PlatformRequestError('insufficient_scope', false, 403)
    }

    let bytes: Uint8Array
    try {
      bytes = await readBoundedBody(response, input.maxResponseBytes ?? MAX_RESPONSE_BYTES)
    } catch (error) {
      if (timedOut) throw new PlatformRequestError('broker_timeout', true, response.status)
      if (response.status === 429) throw new PlatformRequestError('rate_limited', true, response.status)
      if (response.status >= 500) throw new PlatformRequestError('broker_unavailable', true, response.status)
      if (error instanceof PlatformRequestError) throw error
      throw new PlatformRequestError('broker_unavailable', true, response.status)
    }
    if (!response.ok) {
      const safeCode = parseSafeCode(bytes)
      if (response.status === 409) {
        const code = safeCode ?? 'broker_conflict'
        throw new PlatformRequestError(code, code === 'operation_in_flight', response.status)
      }
      if (response.status === 429) {
        throw new PlatformRequestError(safeCode ?? 'rate_limited', true, response.status)
      }
      if (response.status >= 500) {
        throw new PlatformRequestError(safeCode ?? 'broker_unavailable', true, response.status)
      }
      throw new PlatformRequestError(safeCode ?? 'invalid_response', false, response.status)
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new PlatformRequestError('invalid_response', false, response.status)
    }
    const parsed = input.schema.safeParse(decoded)
    if (!parsed.success) throw new PlatformRequestError('invalid_response', false, response.status)
    return parsed.data
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abortFromCaller)
  }
}

function buildPlatformUrl(baseUrl: string, path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//')) throw new BrokerUnconfiguredError()
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw new BrokerUnconfiguredError()
  }
  if (base.username || base.password || base.search || base.hash) throw new BrokerUnconfiguredError()
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) throw new BrokerUnconfiguredError()
  return new URL(`${base.toString().replace(/\/+$/, '')}${path}`)
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Body/cancellation failures are untrusted and never replace the fixed classification.
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response)
    throw new PlatformRequestError('invalid_response', false, response.status)
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // Preserve the response-size classification even if upstream cancellation fails.
      }
      throw new PlatformRequestError('invalid_response', false, response.status)
    }
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function parseSafeCode(bytes: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Object.keys(parsed).length === 1 &&
      typeof (parsed as { code?: unknown }).code === 'string' &&
      SAFE_CODE_PATTERN.test((parsed as { code: string }).code)
    ) {
      return (parsed as { code: string }).code
    }
  } catch {
    // Raw platform bodies never cross this boundary.
  }
  return null
}
