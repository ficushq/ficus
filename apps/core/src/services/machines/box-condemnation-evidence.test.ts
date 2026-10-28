import { afterEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { boxCondemnationEvidence, db } from '../../db'
import { persistBoxCondemnationEvidence } from './box-condemnation-evidence'

const sandboxId = 'squad_11111111-1111-1111-1111-111111111111'

async function clearEvidence() {
  await db.delete(boxCondemnationEvidence).where(eq(boxCondemnationEvidence.sandboxId, sandboxId))
}

afterEach(clearEvidence)

describe('persistBoxCondemnationEvidence', () => {
  it('leaves the complete condemnation reason answerable from the DB after the box is gone', async () => {
    await clearEvidence()
    const observedAt = new Date('2026-08-21T16:00:00.000Z')
    await persistBoxCondemnationEvidence({
      sandboxId,
      machineId: '11111111-1111-4111-8111-111111111111',
      classification: 'running_http_dead',
      probes: [
        { observedAt, kind: 'http_status', elapsedMs: 12, status: 503 },
        {
          observedAt: new Date(observedAt.getTime() + 1_000),
          kind: 'reset',
          elapsedMs: 8,
          error: 'connection reset',
        },
      ],
      machineSnapshot: {
        observedAt,
        liveness: 'running',
        containerStates: 'benchmark Up 10 minutes',
        logTail: 'health request starved',
      },
      activeExecution: true,
      graceBudgetMs: 120_000,
      recordedAt: observedAt,
    })

    const [row] = await db
      .select()
      .from(boxCondemnationEvidence)
      .where(eq(boxCondemnationEvidence.sandboxId, sandboxId))

    expect(row).toMatchObject({
      sandboxId,
      generation: 1,
      classification: 'running_http_dead',
      activeExecution: true,
      graceBudgetMs: 120_000,
    })
    expect(row?.probes).toEqual([
      { observedAt: observedAt.toISOString(), kind: 'http_status', elapsedMs: 12, status: 503 },
      {
        observedAt: new Date(observedAt.getTime() + 1_000).toISOString(),
        kind: 'reset',
        elapsedMs: 8,
        error: 'connection reset',
      },
    ])
    expect(row?.machineSnapshot).toEqual({
      observedAt: observedAt.toISOString(),
      liveness: 'running',
      containerStates: 'benchmark Up 10 minutes',
      logTail: 'health request starved',
    })
  })

  it('allocates a monotonic generation for later condemnation episodes', async () => {
    await clearEvidence()
    const base = {
      sandboxId,
      machineId: '11111111-1111-4111-8111-111111111111',
      classification: 'exited' as const,
      probes: [],
      machineSnapshot: { observedAt: new Date(), liveness: 'exited' as const },
      activeExecution: null,
      graceBudgetMs: 0,
      recordedAt: new Date(),
    }
    await persistBoxCondemnationEvidence(base)
    await persistBoxCondemnationEvidence(base)

    const rows = await db
      .select({ generation: boxCondemnationEvidence.generation })
      .from(boxCondemnationEvidence)
      .where(eq(boxCondemnationEvidence.sandboxId, sandboxId))

    expect(rows.map((row) => row.generation).sort()).toEqual([1, 2])
  })
})
