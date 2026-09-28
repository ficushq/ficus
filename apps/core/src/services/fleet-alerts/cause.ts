import type { ProviderHealthKind, ProviderHealthRecord } from '@ficus/shared/provider-health'

export interface SanitizedProviderCause {
  kind: ProviderHealthKind
  summary: string
  remediation?: string
}

const SUMMARIES: Record<ProviderHealthKind, string> = {
  'rate-limit': 'Provider rate limit is preventing requests.',
  'plan-credit': 'Provider plan credits are unavailable.',
  capacity: 'Provider capacity is unavailable.',
  error: 'Provider requests are failing.',
  'invalid-credential': 'Provider credentials are invalid.',
  'expired-oauth': 'Provider OAuth credentials expired or were revoked.',
  network: 'Provider network requests are failing.',
}
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/

/** Project a provider-health record onto an allowlisted, credential-safe persistence shape. */
export function sanitizeProviderRecord(
  record: Pick<ProviderHealthRecord, 'provider' | 'kind'>
): SanitizedProviderCause {
  const remediation =
    (record.kind === 'expired-oauth' || record.kind === 'invalid-credential') && SAFE_PROVIDER_ID.test(record.provider)
      ? `Run \`ficus pa login ${record.provider}\` to authenticate again.`
      : undefined
  return { kind: record.kind, summary: SUMMARIES[record.kind], ...(remediation ? { remediation } : {}) }
}
