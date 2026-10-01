import { DrizzleQueryError } from 'drizzle-orm/errors'

export const DATABASE_QUERY_FAILED = 'Database query failed'

/** Inspect data properties only: arbitrary caught values may contain unsafe getters. */
function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function errorChain(error: unknown): object[] {
  const nodes: object[] = []
  const seen = new Set<object>()
  let current = error
  while (current !== null && typeof current === 'object' && nodes.length < 8 && !seen.has(current)) {
    seen.add(current)
    nodes.push(current)
    current = ownData(current, 'cause')
  }
  return nodes
}

/** Preserve SQLSTATE handling through Drizzle wrappers without returning SQL, values or driver details. */
export function getPostgresError(error: unknown): { code: string; constraint?: string } | undefined {
  for (const node of errorChain(error)) {
    const code = ownData(node, 'code')
    if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) continue
    const constraint = ownData(node, 'constraint_name')
    return { code, ...(typeof constraint === 'string' ? { constraint } : {}) }
  }
  return undefined
}

/** Match driver/transport codes through the same bounded chain; no error payload escapes. */
export function hasErrorCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return errorChain(error).some((node) => {
    const code = ownData(node, 'code')
    return typeof code === 'string' && codes.has(code)
  })
}

export function isDatabaseQueryError(error: unknown): boolean {
  return errorChain(error).some((node) => node instanceof DrizzleQueryError)
}

/** Keep existing domain messages; query errors contain SQL and parameters and must never be returned verbatim. */
export function publicErrorMessage(error: Error): string {
  return isDatabaseQueryError(error) ? DATABASE_QUERY_FAILED : error.message
}
