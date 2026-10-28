import type { Context, MiddlewareHandler } from 'hono'
import { CUSTOM_THEME_MAX_BYTES, FARM_CHAT_MESSAGE_MAX } from '@ficus/shared'
import { readBoundedBody, RequestBodyTooLargeError } from '@ficus/shared/read-bounded-body'
import { copyPeerAddress } from '../lib/client-address'

const MiB = 1024 ** 2
export type RequestBodyPolicy =
  | { kind: 'bounded'; maxBytes: number }
  | { kind: 'stream' | 'route-owned'; reason: string }
const bounded = (maxBytes: number): RequestBodyPolicy => ({ kind: 'bounded', maxBytes })

/** Exact method/segment exceptions; new API mutations inherit a finite default. */
export function requestBodyPolicy(method: string, pathname: string): RequestBodyPolicy {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
    return { kind: 'stream', reason: 'No request body reader' }
  if (/^\/api\/app\/[^/]+(?:\/.*)?$/.test(pathname)) return { kind: 'stream', reason: 'Opaque local-app proxy' }
  if (method === 'POST' && /^\/api\/squads\/[^/]+\/workspace\/upload$/.test(pathname))
    return { kind: 'stream', reason: 'Disk-staged workspace transfer' }
  if (
    method === 'POST' &&
    (/^\/api\/agents\/[^/]+\/(?:files|private\/upload)$/.test(pathname) ||
      /^\/api\/inbox\/[^/]+\/attachments$/.test(pathname) ||
      /^\/api\/workflows\/runs\/[^/]+\/attempts\/[^/]+\/attachments$/.test(pathname) ||
      pathname === '/api/transcribe')
  )
    return { kind: 'route-owned', reason: 'Authenticated domain multipart reader' }
  if (
    pathname.startsWith('/api/webhooks/') ||
    (method === 'POST' && /^\/api\/memory\/[^/]+\/sync\/webhook$/.test(pathname))
  )
    return bounded(26 * MiB)
  if (method === 'POST' && /^\/api\/assistant\/[^/]+\/entries$/.test(pathname)) return bounded(48 * MiB)
  if (method === 'PUT' && /^\/api\/amtp\/agents\/[^/]+\/card$/.test(pathname)) return bounded(16 * 1024)
  if (method === 'POST' && pathname === '/api/amtp/inbox') return bounded(4 * MiB)
  if (
    method === 'POST' &&
    (/^\/api\/(?:images|screenshots\/(?:guess|file))$/.test(pathname) ||
      /^\/api\/squads\/[^/]+\/avatar$/.test(pathname))
  )
    return bounded(16 * MiB)
  if (method === 'POST' && /^\/api\/decisions\/(?:evaluate|try)$/.test(pathname)) return bounded(12 * MiB)
  if (
    (method === 'POST' && /^\/api\/memory\/[^/]+\/(?:write|patch|append|workspace-files)$/.test(pathname)) ||
    (method === 'PATCH' && /^\/api\/artifacts\/[^/]+\/[^/]+\/file$/.test(pathname)) ||
    (method === 'PUT' && /^\/api\/squads\/workspace\/[^/]+\/env$/.test(pathname)) ||
    (method === 'POST' && /^\/api\/skills(?:\/import)?$/.test(pathname)) ||
    (method === 'PUT' && /^\/api\/skills\/[^/]+(?:\/support-file)?$/.test(pathname))
  )
    return bounded(128 * MiB)
  const group = pathname.split('/')[2]
  if (group === 'push' && /^\/api\/push\/server-connection(?:\/|$)/.test(pathname)) return bounded(2048)
  if (group === 'public-url' || group === 'farm-preferences') return bounded(4096)
  if (group === 'farm') return bounded(16 * 1024)
  if (group === 'product-feedback') return bounded(64 * 1024)
  if (group === 'farm-chat') return bounded(FARM_CHAT_MESSAGE_MAX * 4 + 1024)
  if (group === 'user-preferences' || group === 'theme-presets') return bounded(CUSTOM_THEME_MAX_BYTES + 1024)
  if (
    [
      'chat',
      'inbox',
      'agents',
      'assistant',
      'workstreams',
      'workflows',
      'squads',
      'agent-types',
      'model-tiers',
      'squad-presets',
      'shared-prompts',
      'skills',
      'artifacts',
    ].includes(group)
  )
    return bounded(4 * MiB)
  return bounded(MiB)
}

export function createRequestBodyLimits(select = requestBodyPolicy): MiddlewareHandler {
  const applied = new WeakSet<Context>()
  return async (c, next) => {
    if (applied.has(c)) return next()
    applied.add(c)
    const policy = select(c.req.method, c.req.path)
    if (policy.kind !== 'bounded') return next()
    const original = c.req.raw
    let bytes: Uint8Array<ArrayBuffer>
    try {
      bytes = await readBoundedBody(original, policy.maxBytes)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError)
        return c.json({ error: error.message, code: 'REQUEST_BODY_TOO_LARGE', maxBytes: error.maxBytes }, 413)
      throw error
    }
    const replacement = new Request(original.url, {
      method: original.method,
      headers: original.headers,
      body: bytes,
      signal: original.signal,
      redirect: original.redirect,
    })
    copyPeerAddress(original, replacement)
    c.req.raw = replacement
    await next()
  }
}
export const requestBodyLimits = createRequestBodyLimits()
