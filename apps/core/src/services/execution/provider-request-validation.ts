/** Closed-set provider request rejection. Never carries a raw prompt, argument,
 * rejected value, payload or cause into persistence or owner notifications. */
export const REQUEST_VALIDATION_REASON = 'request_validation_tool_name'
export const REQUEST_VALIDATION_MESSAGE =
  'Provider request validation failed: a tool-search function name must contain only letters, digits, underscores, periods or hyphens (request_validation_tool_name).'

export class ProviderRequestValidationError extends Error {
  constructor() {
    super(REQUEST_VALIDATION_MESSAGE)
    this.name = 'ProviderRequestValidationError'
  }
}

// This is the specific Codex validator seen in the incident, not a generic
// HTTP 400 / invalid_string classifier. Pi sometimes preserves only its text.
const TOOL_NAME_REJECTION =
  /^\[ToolSearchOutputFunctionToolNameParam\] \[input\[(\d+)\]\.name\] \[invalid_string\] Invalid 'input\[\1\]\.name': string does not match pattern\./

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** Call only at a provider model-call boundary, never on user tool validation.
 * Prefer the SDK's retained Codex event error over its rewritten outer text.
 * The durable sanitized message is an exact closed-set marker on later reads. */
export function providerRequestValidationError(error: unknown): ProviderRequestValidationError | undefined {
  if (error instanceof ProviderRequestValidationError) return error
  const sdk = record(error)
  if (sdk?.name === 'CodexApiError') {
    const payload = record(sdk.payload)
    const detail = record(payload?.error) ?? record(record(payload?.response)?.error)
    if (typeof detail?.message === 'string' && TOOL_NAME_REJECTION.test(detail.message))
      return new ProviderRequestValidationError()
  }
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
  if (
    text === REQUEST_VALIDATION_MESSAGE ||
    (typeof text === 'string' &&
      TOOL_NAME_REJECTION.test(text.startsWith('Codex error: ') ? text.slice('Codex error: '.length) : text))
  )
    return new ProviderRequestValidationError()
  return undefined
}
