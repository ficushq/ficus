/** Only server-owned reason tokens may reach logs or user-facing diagnostics. */
export function safeDerivationReason(code: string, reason: unknown): string {
  if (reason === undefined) return 'unspecified'
  if (typeof reason !== 'string') return 'unknown'
  const reasons: Record<string, readonly string[]> = {
    derivation_github_unavailable: ['no_token', 'network', 'invalid_body', 'rate_limited'],
    derivation_invalid_output: ['not_json', 'schema', 'unsafe_base', 'private_text_in_base', 'too_long'],
    derivation_model_unavailable: ['timeout', 'empty_output'],
  }
  if (Object.hasOwn(reasons, code) && reasons[code]!.includes(reason)) return reason
  // GitHub reasons include a numeric HTTP status, but never response text.
  if (code === 'derivation_github_unavailable' && reason.length === 8 && /^http_[1-5][0-9]{2}$/.test(reason))
    return reason
  return 'unknown'
}

/** Shared web/CLI wording. Only validated counts and allowlisted reasons are displayed. */
export function formatDerivationError(
  code: string | undefined,
  details?: unknown,
  options: { includeCode?: boolean } = {}
): string | undefined {
  const payload = details as
    { reason?: unknown; counts?: { kept?: unknown; collected?: unknown }; minimum?: unknown } | undefined
  let message: string
  switch (code) {
    case 'derivation_github_unavailable':
      message = 'GitHub is unavailable through this squad’s connection. Check the connection and try again.'
      break
    case 'derivation_login_not_visible':
      message = 'The GitHub login was not found or is not visible to this squad’s GitHub connection.'
      break
    case 'derivation_too_few_samples': {
      const kept = payload?.counts?.kept
      const collected = payload?.counts?.collected
      const minimum = payload?.minimum
      const isCount = (value: unknown): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      message =
        isCount(kept) && isCount(collected) && isCount(minimum)
          ? `Too few samples: kept ${kept} of ${collected} collected; at least ${minimum} are required.`
          : 'Too few usable samples were found to derive a voice.'
      break
    }
    case 'derivation_invalid_output': {
      const reason = safeDerivationReason(code, payload?.reason)
      const explanations: Record<string, string> = {
        not_json: 'the answer was not JSON',
        schema: 'the answer did not match the required draft structure',
        unsafe_base: 'no safe base instructions remained',
        private_text_in_base: 'the base instructions overlapped private sample text',
        too_long: 'the draft exceeded the size limit',
      }
      message = `The model returned an invalid voice draft (${explanations[reason] ?? 'the validation reason is unavailable'}). Nothing was saved; try again.`
      break
    }
    case 'derivation_model_unavailable':
      message = 'The derivation model is unavailable or returned no usable response. Try again later.'
      break
    default:
      return undefined
  }
  return options.includeCode === false ? message : `${code}: ${message}`
}
