import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const liveness = readFileSync(join(import.meta.dir, 'process-liveness.ts'), 'utf8')
const worker = readFileSync(join(import.meta.dir, '../../worker.ts'), 'utf8')
const reservations = readFileSync(join(import.meta.dir, 'admission-reservation.ts'), 'utf8')

describe('admission process liveness source contract', () => {
  test('uses a dedicated versioned 64-bit session lock and a single fatal close path', () => {
    expect(liveness).toContain("ADMISSION_LIVENESS_LOCK_VERSION = 'ficus:admission-owner:v1:'")
    expect(liveness).toContain('hashtextextended(')
    expect(liveness).toContain('const connection = await client.reserve()')
    expect(liveness).toContain('if (!stopping && !fatalTriggered)')
    expect(liveness).toContain("process.kill(process.pid, 'SIGTERM')")
  })

  test('runtime recovery retains every exact execution and reservation identity predicate', () => {
    const runtimeRecovery = reservations.slice(
      reservations.indexOf('async recoverDeadOwnerRuntimeEffects'),
      reservations.indexOf('async markExpiredOpenEffectsUnknown')
    )
    for (const predicate of [
      'current.runnerClaimToken !== candidate.token',
      'current.runnerClaimGeneration !== candidate.admittedGeneration',
      'eq(executionAdmissionReservations.token, candidate.token)',
      'eq(executionAdmissionReservations.claimEpoch, candidate.claimEpoch)',
      'eq(executionAdmissionReservations.ownerId, candidate.ownerId)',
      'eq(executionAdmissionReservations.ownerIncarnation, candidate.ownerIncarnation)',
      'eq(executionAdmissionReservations.admittedGeneration, candidate.admittedGeneration)',
      'eq(executionAdmissionReservations.admittedHolderRevision, candidate.admittedHolderRevision)',
      "eq(executionAdmissionReservations.state, 'unknown')",
      'eq(executionAdmissionReservations.phase, candidate.phase)',
    ]) {
      expect(runtimeRecovery).toContain(predicate)
    }
  })

  test('acquires liveness before maintenance recovery and releases it last on reverse shutdown', () => {
    expect(worker.indexOf("'admission-process-liveness'")).toBeLessThan(worker.indexOf("'maintenance-controller'"))
    expect(worker.indexOf('await startAdmissionProcessLiveness()')).toBeLessThan(
      worker.indexOf('await maintenanceWorkerController.start()')
    )
  })
})
