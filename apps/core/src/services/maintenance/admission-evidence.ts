import { createHash } from 'node:crypto'
import type { AdmissionLease } from './admission-reservation'
import type { MaintenanceSnapshot } from './types'

export type MaintenanceBlocker = Readonly<
  { kind: 'admin'; idHash: string | null } | { kind: 'platform-lease'; idHash: string | null }
>
export type AdmissionPauseSubject = Readonly<{
  kind: 'admission-lease'
  ownerIdHash: string
  ownerIncarnationHash: string
  executionIdHash: string
}>
export type RunnerPauseOrigin =
  'write-phase-begin' | 'write-phase-finish-settlement' | 'write-phase-finish-running' | 'scope-abort-effective-change'
export type MaintenancePauseEvidence =
  | Readonly<{
      origin: 'authoritative-refresh'
      generation: number
      blockers: readonly MaintenanceBlocker[]
      subject: null
    }>
  | Readonly<{ origin: RunnerPauseOrigin; generation: number; blockers: null; subject: AdmissionPauseSubject }>

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12)
const optionalHash = (value: string | null) => (value === null ? null : hash(value))

export function authoritativePauseEvidence(snapshot: MaintenanceSnapshot): MaintenancePauseEvidence {
  const blockers: MaintenanceBlocker[] = []
  if (snapshot.adminHold.active)
    blockers.push(Object.freeze({ kind: 'admin', idHash: optionalHash(snapshot.adminHold.heldBy) }))
  if (snapshot.platformLease.active)
    blockers.push(Object.freeze({ kind: 'platform-lease', idHash: optionalHash(snapshot.platformLease.leaseId) }))
  if (snapshot.effective && blockers.length === 0) throw new Error('Maintenance pause evidence has no active blockers')
  return Object.freeze({
    origin: 'authoritative-refresh' as const,
    generation: snapshot.generation,
    blockers: Object.freeze(blockers),
    subject: null,
  })
}

export function admissionLeasePauseEvidence(
  lease: AdmissionLease,
  origin: RunnerPauseOrigin
): MaintenancePauseEvidence {
  return Object.freeze({
    origin,
    generation: lease.generation,
    blockers: null,
    subject: Object.freeze({
      kind: 'admission-lease' as const,
      ownerIdHash: hash(lease.ownerId),
      ownerIncarnationHash: hash(lease.ownerIncarnation),
      executionIdHash: hash(lease.executionId),
    }),
  })
}

function defensiveCopy(evidence: MaintenancePauseEvidence): MaintenancePauseEvidence {
  if (evidence.origin === 'authoritative-refresh') {
    return Object.freeze({
      origin: evidence.origin,
      generation: evidence.generation,
      blockers: Object.freeze(evidence.blockers.map((blocker) => Object.freeze({ ...blocker }))),
      subject: null,
    })
  }
  return Object.freeze({
    origin: evidence.origin,
    generation: evidence.generation,
    blockers: null,
    subject: Object.freeze({ ...evidence.subject }),
  })
}

export class MaintenanceAdmissionPaused extends Error {
  declare readonly evidence: MaintenancePauseEvidence
  declare readonly generation: number
  constructor(evidence: MaintenancePauseEvidence) {
    super('Execution is queued until maintenance completes')
    this.name = 'MaintenanceAdmissionPaused'
    const frozen = defensiveCopy(evidence)
    Object.defineProperties(this, {
      evidence: { value: frozen, enumerable: true, writable: false, configurable: false },
      generation: { value: frozen.generation, enumerable: true, writable: false, configurable: false },
    })
  }
}
