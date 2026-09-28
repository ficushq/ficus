import {
  PLATFORM_MAINTENANCE_HEADERS,
  PLATFORM_MAINTENANCE_PROTOCOL_VERSION,
  type PlatformMaintenanceCompatibilityContext,
} from '@ficus/shared'
import { z } from 'zod'

export type LegacyUpgradePolicy = 'observe' | 'enforce' | 'disabled'

type ParsedContext =
  | { valid: true; context: PlatformMaintenanceCompatibilityContext; allAbsent: boolean }
  | { valid: false }

export type PlatformMaintenanceCompatibilityDecision =
  | {
      allowed: true
      context: PlatformMaintenanceCompatibilityContext
      legacyUnknown?: true
    }
  | {
      allowed: false
      reasonCode: 'invalid_context' | 'compatibility_floor' | 'compatibility_disabled'
      context?: PlatformMaintenanceCompatibilityContext
    }

const commitSha = z.string().regex(/^[0-9a-f]{40}$/)
const uuid = z.string().uuid()

export function legacyUpgradePolicy(raw = process.env.FICUS_LEGACY_PLATFORM_MAINTENANCE_UPGRADE): LegacyUpgradePolicy {
  if (raw === undefined || raw === '') return 'observe'
  if (raw === 'observe' || raw === 'enforce' || raw === 'disabled') return raw
  throw new Error(`Invalid FICUS_LEGACY_PLATFORM_MAINTENANCE_UPGRADE value: expected observe, enforce, or disabled`)
}

export function parsePlatformMaintenanceHeaders(get: (name: string) => string | undefined): ParsedContext {
  const raw = {
    protocolVersion: get(PLATFORM_MAINTENANCE_HEADERS.protocol),
    callerVersion: get(PLATFORM_MAINTENANCE_HEADERS.callerVersion),
    instanceId: get(PLATFORM_MAINTENANCE_HEADERS.instanceId),
    correlationId: get(PLATFORM_MAINTENANCE_HEADERS.correlationId),
  }
  const allAbsent = Object.values(raw).every((value) => value === undefined)
  const parsedProtocol = raw.protocolVersion === undefined ? null : Number(raw.protocolVersion)
  if (
    (raw.protocolVersion !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(raw.protocolVersion) || !Number.isSafeInteger(parsedProtocol))) ||
    (raw.callerVersion !== undefined && !commitSha.safeParse(raw.callerVersion).success) ||
    (raw.instanceId !== undefined && !uuid.safeParse(raw.instanceId).success) ||
    (raw.correlationId !== undefined && !uuid.safeParse(raw.correlationId).success)
  ) {
    return { valid: false }
  }
  return {
    valid: true,
    allAbsent,
    context: {
      protocolVersion: parsedProtocol,
      callerVersion: raw.callerVersion ?? null,
      instanceId: raw.instanceId ?? null,
      correlationId: raw.correlationId ?? null,
    },
  }
}

export function decidePlatformMaintenanceCompatibility(
  policy: LegacyUpgradePolicy,
  parsed: ParsedContext
): PlatformMaintenanceCompatibilityDecision {
  if (policy === 'disabled') {
    return parsed.valid && !parsed.allAbsent
      ? { allowed: false, reasonCode: 'compatibility_disabled', context: parsed.context }
      : { allowed: false, reasonCode: 'compatibility_disabled' }
  }
  if (!parsed.valid) return { allowed: false, reasonCode: 'invalid_context' }
  if (parsed.allAbsent) {
    return policy === 'observe'
      ? { allowed: true, context: parsed.context, legacyUnknown: true }
      : { allowed: false, reasonCode: 'compatibility_floor' }
  }
  const { context } = parsed
  if (
    context.protocolVersion !== PLATFORM_MAINTENANCE_PROTOCOL_VERSION ||
    context.callerVersion === null ||
    context.instanceId === null ||
    context.correlationId === null
  ) {
    return { allowed: false, reasonCode: 'compatibility_floor', context }
  }
  return { allowed: true, context }
}
