import { createHash } from 'node:crypto'
import type { IntegrationOutputFact } from '@ficus/shared'
import type { VerifiedIngressEvent } from '../types'

export const DEPENDABOT_OUTPUT = 'dependabot_alert.updated'
export const DEPENDABOT_ACTIONS = [
  'created',
  'reopened',
  'reintroduced',
  'auto_reopened',
  'fixed',
  'dismissed',
  'auto_dismissed',
  'assignees_changed',
]
const states = ['open', 'fixed', 'dismissed', 'auto_dismissed']
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 2000) : '')

/** REST snapshots preserve current state without inventing a native lifecycle action. */
export function normalizeDependabot(event: VerifiedIngressEvent): IntegrationOutputFact[] {
  const payload = event.payload as Record<string, any> | null
  const alert = payload?.alert
  const repository = payload?.repository
  const action = payload?.action
  if (
    !alert ||
    !repository ||
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    typeof repository.full_name !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository.full_name) ||
    !Number.isSafeInteger(alert.number) ||
    alert.number <= 0 ||
    !states.includes(alert.state) ||
    !(DEPENDABOT_ACTIONS.includes(action) || (action === 'observed' && event.metadata?.synthetic === true))
  )
    return []
  const timestamp = alert.updated_at ?? alert.created_at
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return []
  const occurredAt = new Date(timestamp).toISOString()
  const advisoryId = text(alert.security_advisory?.ghsa_id)
  const severity = alert.security_vulnerability?.severity ?? alert.security_advisory?.severity
  const name = text(alert.dependency?.package?.name)
  const ecosystem = text(alert.dependency?.package?.ecosystem)
  if (!advisoryId || !name || !ecosystem || !['low', 'medium', 'high', 'critical'].includes(severity)) return []
  const repo = repository.full_name.toLowerCase()
  const externalId = `${repository.id}:${alert.number}`
  const details = {
    number: alert.number,
    externalId,
    advisoryId,
    package: name,
    ecosystem,
    manifest: text(alert.dependency?.manifest_path),
    affectedRange: text(alert.security_vulnerability?.vulnerable_version_range),
    patchedVersion: text(alert.security_vulnerability?.first_patched_version?.identifier),
    groupKey: hash([repository.id, advisoryId, ecosystem, name]),
  }
  // The canonical URL is constructed, not trusted from untrusted payload fields.
  const url = `https://github.com/${repo}/security/dependabot/${alert.number}`
  return [
    {
      output: DEPENDABOT_OUTPUT,
      version: 1,
      resourceKey: `dependabot:${externalId}`,
      occurredAt,
      // Native action and mutable repo name are intentionally absent: webhook / API observations
      // of the same state collapse. A later reopen has a different updated_at. Assignment updates
      // are represented by the snapshot too, not by transport delivery IDs.
      eventKey: hash([DEPENDABOT_OUTPUT, externalId, occurredAt, alert.state]),
      data: { repository: repo, repositoryId: repository.id, action, state: alert.state, severity, alert: details },
      subject: `Dependabot ${severity}: ${repo} alert ${alert.number} · ${name}`.slice(0, 1000),
      body: [
        `Dependabot alert ${alert.number}: ${severity} (${alert.state}; ${action}).`,
        `${ecosystem} package ${name} in ${details.manifest || '(manifest unavailable)'}`,
        `Advisory: ${advisoryId}. Affected: ${details.affectedRange || 'unknown'}. First patched: ${details.patchedVersion || 'unavailable'}.`,
        `Group: ${details.groupKey} — same package/advisory across manifests; consolidate remediation where appropriate.`,
        url,
        'Discovery is read-only. Fixed or dismissed state is not proof of remediation acceptance, merge approval, or work completion.',
      ].join('\n'),
      url,
      ordering: { key: externalId, position: [Date.parse(occurredAt)] },
    },
  ]
}
