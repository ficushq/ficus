import { createHash } from 'crypto'

/**
 * Per-tool-call idempotency keys.
 *
 * A tool that creates something durable (a question, subagents, an inbox
 * message, a flow transition) derives its key from the agent, the execution and
 * the provider's tool call ID. The same call executed again (a transport
 * redelivery or a rerun of the same call) gets the same key and so finds the
 * record the first execution made. A new call made by the model always has a
 * new tool call ID and so a new key: these keys never merge two calls.
 *
 * Commands run through `bash` and `squad_bash` see the key of the tool call
 * that started them in `FICUS_TOOL_CALL_KEY`. The `ficus` CLI derives one key
 * per command from it with `cliCommandIdempotencyKey`: the command name and its
 * full payload are part of the key, so one bash call that sends several
 * different messages still sends each of them, while running the same command
 * with the same payload again inside that bash call is the same request.
 */

/** Environment variable that carries the current tool call's key into bash commands. */
export const TOOL_CALL_KEY_ENV = 'FICUS_TOOL_CALL_KEY'

/** A UUID-shaped (version 5 layout) digest of the JSON encoding of `parts`. */
export function stableUuidFromParts(parts: readonly unknown[]): string {
  const bytes = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Stable across a re-execution of the same tool call; distinct across agents, executions and calls. */
export function toolCallIdempotencyKey(agentId: string, executionId: string, toolCallId: string): string {
  return stableUuidFromParts([agentId, executionId, toolCallId])
}

/** JSON with object keys sorted at every level, so key order never changes a digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) sorted[key] = sortKeys(entry)
    }
    return sorted
  }
  return value
}

const TOOL_CALL_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The current tool call's key from the environment, or undefined outside an agent tool call. */
export function currentToolCallKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[TOOL_CALL_KEY_ENV]?.trim()
  return value && TOOL_CALL_KEY_PATTERN.test(value) ? value.toLowerCase() : undefined
}

/**
 * The default idempotency key (a UUID) for one CLI command run inside an agent tool call, or
 * undefined outside one. `command` names the operation (for example `inbox send`), and `payload`
 * must hold everything that makes the request what it is: the target and the full body.
 */
export function cliCommandIdempotencyKey(
  command: string,
  payload: unknown,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const toolCallKey = currentToolCallKey(env)
  if (!toolCallKey) return undefined
  return stableUuidFromParts(['ficus-cli', command, toolCallKey, canonicalJson(payload)])
}
