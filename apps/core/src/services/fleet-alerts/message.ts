import { providerLabel, type InboxPushPresentation } from '@ficus/shared'
import type { ProviderHealthKind } from '@ficus/shared/provider-health'
import { SANDBOX_OVERLOAD_STALE_MS } from './audience-policy'
import type { FleetIncidentNotificationClaim } from './store'

/** Display names resolved at delivery time, so a rename is reflected and no raw ID reaches a reader. */
export interface FleetIncidentNames {
  squadName?: string
  /** The agent whose sandbox degraded, for agent-scoped sandboxes. */
  agentName?: string
}

export interface FleetIncidentMessage {
  subject: string
  content: string
  push: InboxPushPresentation
}

const PROVIDER_PROBLEMS: Record<ProviderHealthKind, { short: string; sentence: (label: string) => string }> = {
  'rate-limit': { short: 'rate limited', sentence: (label) => `${label} is rate limiting requests.` },
  'plan-credit': { short: 'out of plan credits', sentence: (label) => `${label} plan credits are unavailable.` },
  capacity: { short: 'out of capacity', sentence: (label) => `${label} has no capacity available.` },
  error: { short: 'requests failing', sentence: (label) => `Requests to ${label} are failing.` },
  'invalid-credential': { short: 'credentials invalid', sentence: (label) => `${label} credentials are invalid.` },
  'expired-oauth': { short: 'sign-in expired', sentence: (label) => `${label} sign-in expired or was revoked.` },
  network: { short: 'network errors', sentence: (label) => `Network requests to ${label} are failing.` },
}

const SANDBOX_REASONS: Record<string, string> = {
  devbox_unavailable: 'devbox unavailable',
  bashrc_unavailable: 'shell profile unavailable',
  git_credentials_unavailable: 'Git credentials unavailable',
  transport_recovery_failed: 'connection recovery failed',
  callback_transport_degraded: 'callback connection degraded',
  command_outcome_ambiguous: 'command results uncertain',
}

const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/

/** 45m, 3h 10m, 2d 19h: minutes stop being readable within a few hours. */
export function formatFleetDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

function providerProblem(code: string, provider: string | undefined) {
  const problem = PROVIDER_PROBLEMS[code as ProviderHealthKind]
  if (!problem || !provider || !SAFE_PROVIDER_ID.test(provider)) return undefined
  const label = providerLabel(provider)
  return { label, problem: problem.short, short: `${label} ${problem.short}`, sentence: problem.sentence(label) }
}

function sandboxReasons(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const phrases = [...new Set(value.filter((reason) => typeof reason === 'string' && SANDBOX_REASONS[reason]))].map(
    (reason) => SANDBOX_REASONS[reason as string]!
  )
  return phrases.length ? phrases.join(', ') : undefined
}

function validDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : 'unknown'
}

/** "the sandbox for reviewer in squad Ficus Core", from names resolved at delivery time. */
function sandboxScope(claim: FleetIncidentNotificationClaim, names: FleetIncidentNames): string {
  if (names.agentName)
    return `the sandbox for ${names.agentName}${names.squadName ? ` in squad ${names.squadName}` : ''}`
  if (names.squadName) return `the sandbox for squad ${names.squadName}`
  return `sandbox ${shortId(claim.scopeKey.split('_').pop())}`
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Load figures from allowlisted overload details, phrased for a reader. */
function overloadReading(details: Record<string, unknown>) {
  const load = Array.isArray(details.load) ? details.load[0] : undefined
  const { cpus, peakLoad, memAvailableMb } = details
  if (!finiteNumber(load) || !finiteNumber(cpus) || cpus < 1) return undefined
  const free = finiteNumber(memAvailableMb)
    ? memAvailableMb < 1024
      ? `${Math.round(memAvailableMb)} MB free`
      : `${(memAvailableMb / 1024).toFixed(1)} GB free`
    : 'free memory unknown'
  return {
    load: load.toFixed(1),
    cpus: cpus === 1 ? '1 CPU' : `${cpus} CPUs`,
    free,
    ...(finiteNumber(peakLoad) && peakLoad > load ? { peak: peakLoad.toFixed(1) } : {}),
  }
}

/**
 * Render a fleet incident for its reader from allowlisted incident facts and resolved names.
 * Free-form details are never echoed; unknown causes fall back to the sanitized stored summary.
 */
export function renderFleetIncidentMessage(
  claim: FleetIncidentNotificationClaim,
  names: FleetIncidentNames,
  now: Date
): FleetIncidentMessage {
  const details = (claim.details ?? {}) as Record<string, unknown>
  const alert = claim.phase === 'alert'
  const lasted = formatFleetDuration((claim.incidentResolvedAt ?? now).getTime() - claim.incidentStartedAt.getTime())
  const squad = `squad ${names.squadName ?? shortId(claim.squadId)}`

  let subject: string
  let headline: string
  let cause = claim.causeSummary
  let remediation = claim.remediation
  const facts: string[] = []

  if (claim.incidentKind === 'provider_unhealthy') {
    const problem = providerProblem(claim.causeCode, claim.provider)
    const label = problem?.label ?? (claim.provider ? providerLabel(claim.provider) : 'A model provider')
    cause = problem?.sentence ?? cause
    subject = alert ? `${label}: ${problem?.problem ?? 'unavailable'}` : `${label} recovered`
    headline = alert
      ? `Agents that use ${label} can’t run until this clears.`
      : `${label} is working again after ${lasted}.`
    if (alert) facts.push(`Started: ${lasted} ago`)
  } else if (claim.incidentKind === 'squad_dead_fleet') {
    const provider =
      details.providerRouteBlocked === true
        ? providerProblem(claim.causeCode, typeof details.provider === 'string' ? details.provider : undefined)
        : undefined
    const reasons = sandboxReasons(details.sandboxReasons)
    let short: string | undefined
    if (provider) {
      short = provider.short
      cause = provider.sentence
    } else if (PROVIDER_PROBLEMS[claim.causeCode as ProviderHealthKind]) {
      // Older rows carried global incident attribution without routing proof.
      cause = 'No agent run has started; a current provider cause has not been established.'
      remediation = undefined
    } else if (claim.causeCode === 'sandbox-setup-degraded') {
      short = 'sandbox degraded'
      if (reasons) cause = `The squad’s sandbox setup is degraded: ${reasons}.`
    } else if (claim.causeCode === 'demand-not-served') {
      cause = 'No agent run has started, and no provider or sandbox problem explains it.'
    }
    subject = capitalize(alert ? `${squad} stalled${short ? `: ${short}` : ''}` : `${squad} is running again`)
    headline = alert
      ? `Work in ${squad} has been stalled for ${lasted}.`
      : `Work in ${squad} is running again after being stalled for ${lasted}.`
    const count = typeof details.demandCount === 'number' ? details.demandCount : undefined
    const oldest = validDate(details.oldestDemandAt)
    if (alert && count)
      facts.push(
        `Waiting: ${count === 1 ? '1 work item' : `${count} work items`}` +
          (oldest ? `, the oldest for ${formatFleetDuration(now.getTime() - oldest.getTime())}` : '')
      )
  } else if (claim.incidentKind === 'sandbox_overloaded') {
    const title = capitalize(sandboxScope(claim, names))
    const reading = overloadReading(details)
    const resolvedBy = details.resolvedBy === 'unobserved' ? 'unobserved' : 'load'
    if (alert) {
      subject = `${title} is overloaded`
      headline = reading
        ? `${title} is overloaded: load ${reading.load} on ${reading.cpus} for ${lasted} (${reading.free}). Agents’ tool calls and toolchain checks time out while it lasts.`
        : `${title} has been overloaded for ${lasted}. Agents’ tool calls and toolchain checks time out while it lasts.`
      if (reading?.peak) facts.push(`Peak load: ${reading.peak}`)
    } else if (resolvedBy === 'unobserved') {
      subject = `${title}: overload alert closed`
      headline = `${title} has had no load reading for ${formatFleetDuration(SANDBOX_OVERLOAD_STALE_MS)} (no agent is running in it, or it isn’t answering), so its overload alert is closed after ${lasted}.`
    } else {
      subject = `${title} recovered`
      headline = `${title} is no longer overloaded after ${lasted}${reading ? `: load ${reading.load} on ${reading.cpus}` : ''}.`
    }
  } else {
    const title = capitalize(sandboxScope(claim, names))
    const reasons = sandboxReasons(details.reasons)
    if (reasons) cause = `VM sandbox setup is degraded: ${reasons}.`
    subject = alert ? `${title} is degraded` : `${title} recovered`
    headline = alert ? `${title} hasn’t finished setup.` : `${title} is healthy again after ${lasted}.`
    if (alert) facts.push(`Started: ${lasted} ago`)
  }

  const lines = alert
    ? [`Cause: ${cause}`, ...facts, ...(remediation ? [`Fix: ${remediation}`] : [])]
    : [`Earlier cause: ${cause}`]
  return {
    subject,
    content: `${headline}\n\n${lines.join('\n')}`,
    push: {
      title: subject.slice(0, 120),
      body: headline.slice(0, 300),
      ...(names.squadName ? { subtitle: names.squadName.slice(0, 80) } : {}),
      // A recovery replaces its alert on the device instead of stacking a second notification.
      collapseKey: `fleet:${claim.incidentId}`,
      threadKey: 'fleet',
      interruptionLevel: alert ? 'active' : 'passive',
    },
  }
}
