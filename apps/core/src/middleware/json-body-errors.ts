import type { Context, ErrorHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { createLogger } from '../lib/infra/logger'
import { WorkspaceDotDirConflictError } from '../services/workspace/dot-dir'

export const INVALID_JSON_BODY_MESSAGE = 'Invalid JSON body'

const HONO_MALFORMED_JSON_MESSAGE = 'Malformed JSON in request body'
const log = createLogger('json-body')

/** Identifies invalid values supplied as a JSON request body. */
export class InvalidJsonBodyError extends Error {
  constructor(options?: ErrorOptions) {
    super(INVALID_JSON_BODY_MESSAGE, options)
    this.name = 'InvalidJsonBodyError'
  }
}

/** Identifies syntax failures thrown specifically while parsing a request body. */
export class MalformedJsonBodyError extends InvalidJsonBodyError {
  constructor(cause: SyntaxError) {
    super({ cause })
    this.name = 'MalformedJsonBodyError'
  }
}

/**
 * Lazily classifies request JSON syntax errors without reading the body or
 * changing authentication and authorization ordering.
 */
export const jsonBodyErrorMiddleware = createMiddleware(async (c, next) => {
  const originalJson = c.req.json.bind(c.req) as typeof c.req.json
  c.req.json = (async <T>() => {
    try {
      return await originalJson<T>()
    } catch (error) {
      if (error instanceof SyntaxError) throw new MalformedJsonBodyError(error)
      throw error
    }
  }) as typeof c.req.json
  return next()
})

function isHonoMalformedJson(error: Error): boolean {
  return error instanceof HTTPException && error.status === 400 && error.message === HONO_MALFORMED_JSON_MESSAGE
}

/** Root handler for stable malformed-body responses and existing error semantics. */
export const jsonBodyErrorHandler: ErrorHandler = (error, c) => {
  if (error instanceof InvalidJsonBodyError || isHonoMalformedJson(error)) {
    log.debug('Rejected invalid JSON request body', {
      method: c.req.method,
      path: c.req.path,
    })
    return c.json({ error: INVALID_JSON_BODY_MESSAGE }, 400)
  }
  if (error instanceof HTTPException) return error.getResponse()
  // A workspace settings dir that needs a manual fix: say what to do instead of a bare 500. The
  // message names the workspace by id only; the full path and detail stay in the server log.
  if (error instanceof WorkspaceDotDirConflictError) {
    log.warn(`Refused ${c.req.method} ${c.req.path}: ${error.root}: ${error.detail}`)
    return c.json({ error: error.message, code: error.code }, 409)
  }

  log.error('Unhandled request error', error)
  return c.text('Internal Server Error', 500)
}

type JsonObject = Record<string, unknown>

/**
 * Parse an object body that permits exactly zero bytes as an omitted value.
 * T is caller-supplied compile-time intent; only the root shape is validated here.
 */
export async function parseOptionalJsonObjectBody<T extends JsonObject>(c: Context, fallback: T): Promise<T> {
  const text = await c.req.text()
  if (text.length === 0) return fallback

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new MalformedJsonBodyError(error)
    throw error
  }

  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new InvalidJsonBodyError()
  }
  return value as T
}
