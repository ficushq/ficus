import { expect, test } from 'bun:test'
import { asc, inArray, sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { AmtpEnvelope } from '@ficus/shared'
import { db } from '../db'
import { createPostgresConnection, getConnectionString } from '../db/connection'
import { outbox } from '../db/schema'
import { Outbox, OUTBOX_CLAIM_STALE_MS, type OutboxStatus } from './Outbox'

const CLAIMERS = 5
const BATCH_SIZE = 4
const CAPACITY = CLAIMERS * BATCH_SIZE

type TransactionOutcome =
  | { claimer: number; status: 'fulfilled'; rows: Outbox[] }
  | { claimer: number; status: 'rejected'; reason: string }

type ClaimerReadiness =
  | { claimer: number; status: 'ready'; pid: number; applicationName: string }
  | { claimer: number; status: 'failed'; applicationName: string; reason: string }

type ReadyClaimer = Extract<ClaimerReadiness, { status: 'ready' }>

type AdvisoryLockIdentity = {
  database: number
  classid: number
  objid: number
  objsubid: number
}

type AdvisoryWaiter = {
  pid: number
  applicationName: string
  state: string
  waitEventType: string
  waitEvent: string
  mode: string
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort()
}

function difference(left: Iterable<string>, right: Set<string>): string[] {
  return sorted([...left].filter((id) => !right.has(id)))
}

function readyClaimers(readiness: ClaimerReadiness[], expected: number): ReadyClaimer[] {
  const failures = readiness.filter((result) => result.status === 'failed')
  if (failures.length > 0) throw new Error(`outbox claim readiness failed=${JSON.stringify(failures)}`)
  const ready = readiness.filter((result): result is ReadyClaimer => result.status === 'ready')
  if (ready.length !== expected || new Set(ready.map((result) => result.pid)).size !== expected) {
    throw new Error(`outbox claim readiness was not distinct=${JSON.stringify(ready)}`)
  }
  return ready
}

async function waitForClaimerReadiness(
  readiness: Promise<ClaimerReadiness>[],
  expected: number,
  expiresAt: number
): Promise<ReadyClaimer[]> {
  const observations: Array<ClaimerReadiness | undefined> = Array.from({ length: readiness.length })
  const observedReadiness = Promise.all(
    readiness.map((promise, index) =>
      promise.then((result) => {
        observations[index] = result
        return result
      })
    )
  )
  const remainingMs = expiresAt - performance.now()
  if (remainingMs <= 0) {
    throw new Error(
      `outbox claimer readiness deadline exceeded=${JSON.stringify({ expected, observations, pending: observations.map((value, index) => (value ? undefined : index)).filter((index) => index !== undefined) })}`
    )
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      observedReadiness.then((results) => ({ status: 'ready' as const, results })),
      new Promise<{ status: 'expired' }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: 'expired' }), remainingMs)
      }),
    ])
    if (outcome.status === 'expired') {
      throw new Error(
        `outbox claimer readiness deadline exceeded=${JSON.stringify({ expected, observations, pending: observations.map((value, index) => (value ? undefined : index)).filter((index) => index !== undefined) })}`
      )
    }
    return readyClaimers(outcome.results, expected)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function waitForExactAdvisoryWaiters(
  identity: AdvisoryLockIdentity,
  expected: ReadyClaimer[],
  expiresAt: number
): Promise<AdvisoryWaiter[]> {
  const expectedByPid = new Map(expected.map(({ pid, applicationName }) => [pid, applicationName]))
  let observations: AdvisoryWaiter[] = []

  for (;;) {
    observations = await db.execute<AdvisoryWaiter>(sql`
      SELECT activity.pid::int AS pid,
             activity.application_name AS "applicationName",
             activity.state,
             activity.wait_event_type AS "waitEventType",
             activity.wait_event AS "waitEvent",
             locks.mode
      FROM pg_locks AS locks
      JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
      WHERE locks.locktype = 'advisory'
        AND locks.database = ${identity.database}
        AND locks.classid = ${identity.classid}
        AND locks.objid = ${identity.objid}
        AND locks.objsubid = ${identity.objsubid}
        AND locks.mode = 'ShareLock'
        AND locks.granted = false
      ORDER BY activity.application_name
    `)
    const observedByPid = new Map(observations.map(({ pid, applicationName }) => [pid, applicationName]))
    const exact =
      observedByPid.size === expectedByPid.size &&
      [...expectedByPid].every(([pid, applicationName]) => observedByPid.get(pid) === applicationName)
    if (exact) return observations

    if (performance.now() >= expiresAt) {
      const missing = expected.filter(({ pid, applicationName }) => observedByPid.get(pid) !== applicationName)
      const unexpected = observations.filter(({ pid, applicationName }) => expectedByPid.get(pid) !== applicationName)
      throw new Error(
        `outbox advisory waiter deadline exceeded=${JSON.stringify({ identity, expected, missing, unexpected, observations }, null, 2)}`
      )
    }
    await Bun.sleep(5)
  }
}

function withDiagnostics(assertContract: () => void, diagnostic: unknown): void {
  try {
    assertContract()
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\noutbox claim diagnostics=${JSON.stringify(diagnostic, null, 2)}`,
      { cause: error }
    )
  }
}

function envelope(id: string): AmtpEnvelope {
  return {
    v: 1,
    id,
    ts: Date.now(),
    from: 'amtp://sender-instance/alice',
    to: 'amtp://peer-instance/bob',
    content: 'concurrent claim fixture',
  }
}

test('concurrent claimers return complete non-overlapping batches and preserve excluded rows', async () => {
  // Claims work the GLOBAL pending outbox, so a pending row leaked by any
  // earlier test file lands in one claimer's batch and breaks the
  // complete-batches contract (observed in CI full-suite runs). Files run
  // sequentially — clearing here only removes other files' leftovers.
  await db.delete(outbox)
  const runId = crypto.randomUUID()
  const eligibleIds = new Set<string>(Array.from({ length: CAPACITY }, () => crypto.randomUUID()))
  const excludedIds = new Set<string>(Array.from({ length: 4 }, () => crypto.randomUUID()))
  const ownedIds = [...eligibleIds, ...excludedIds]
  const eligible = [...eligibleIds]
  const excluded = [...excludedIds]
  const values: Array<{
    id: string
    peerInstanceId: string
    toAddress: string
    envelopeJson: AmtpEnvelope
    idempotencyKey: string
    status: OutboxStatus
    nextAttemptAt: Date | SQL
    claimToken?: string
    claimedAt?: Date | SQL
  }> = []

  for (let index = 0; index < eligible.length; index += 1) {
    const id = eligible[index]
    const stale = index % 2 === 1
    values.push({
      id,
      peerInstanceId: 'peer-instance',
      toAddress: 'amtp://peer-instance/bob',
      envelopeJson: envelope(`${runId}:eligible-${index}`),
      idempotencyKey: `${runId}:eligible-${index.toString().padStart(2, '0')}`,
      status: stale ? 'delivering' : 'pending',
      nextAttemptAt: sql`timestamp '2000-01-01 00:00:00' + ${index * 2} * interval '1 millisecond'`,
      ...(stale
        ? {
            claimToken: `stale-${index}`,
            claimedAt: sql`now() - ${OUTBOX_CLAIM_STALE_MS + 60_000} * interval '1 millisecond'`,
          }
        : {}),
    })
  }

  const excludedFixtures: Array<{
    status: OutboxStatus
    nextAttemptAt: SQL
    claimToken?: string
    claimedAt?: SQL
  }> = [
    { status: 'pending', nextAttemptAt: sql`now() + interval '1 hour'` },
    {
      status: 'delivering',
      nextAttemptAt: sql`timestamp '2000-01-01 00:00:00.001'`,
      claimToken: 'fresh-owner',
      claimedAt: sql`now()`,
    },
    { status: 'delivered', nextAttemptAt: sql`timestamp '2000-01-01 00:00:00.003'` },
    { status: 'failed', nextAttemptAt: sql`timestamp '2000-01-01 00:00:00.005'` },
  ]
  excludedFixtures.forEach((fixture, index) => {
    values.push({
      id: excluded[index],
      peerInstanceId: 'peer-instance',
      toAddress: 'amtp://peer-instance/bob',
      envelopeJson: envelope(`${runId}:excluded-${index}`),
      idempotencyKey: `${runId}:excluded-${index}`,
      ...fixture,
    })
  })

  const dialect = new PgDialect()
  const coordinator = createPostgresConnection(getConnectionString(), { max: 1 })
  const clients = Array.from({ length: CLAIMERS }, () => createPostgresConnection(getConnectionString(), { max: 1 }))
  const gateHeld = Promise.withResolvers<AdvisoryLockIdentity>()
  const release = Promise.withResolvers<void>()
  const allowDelayedFifth = Promise.withResolvers<void>()
  const readiness = Array.from({ length: CLAIMERS }, () => Promise.withResolvers<ClaimerReadiness>())
  const readinessReported = Array.from({ length: CLAIMERS }, () => false)
  const reportReadiness = (value: ClaimerReadiness) => {
    if (readinessReported[value.claimer]) return
    readinessReported[value.claimer] = true
    readiness[value.claimer].resolve(value)
  }
  let coordinatorWork: Promise<unknown> | undefined
  let claims: Array<Promise<Outbox[]>> = []
  let claimsSettled: Promise<PromiseSettledResult<Outbox[]>[]> | undefined
  const waiterObservations: { firstFour: AdvisoryWaiter[]; allFive: AdvisoryWaiter[] } = { firstFour: [], allFive: [] }
  let cleanupComplete = false

  try {
    const foreignEligibleBefore = await db.select({ id: outbox.id }).from(outbox).where(sql`(
        (${outbox.status} = 'pending' AND ${outbox.nextAttemptAt} <= now())
        OR (${outbox.status} = 'delivering' AND ${outbox.claimedAt} < now() - ${OUTBOX_CLAIM_STALE_MS} * interval '1 millisecond')
      )`)
    expect(foreignEligibleBefore.map((row) => row.id)).toEqual([])

    await db.insert(outbox).values(values)
    const beforeExcluded = await db.select().from(outbox).where(inArray(outbox.id, excluded)).orderBy(asc(outbox.id))
    const beforeOwned = await db
      .select({
        id: outbox.id,
        eligible: sql<boolean>`(
          (${outbox.status} = 'pending' AND ${outbox.nextAttemptAt} <= now())
          OR (${outbox.status} = 'delivering' AND ${outbox.claimedAt} < now() - ${OUTBOX_CLAIM_STALE_MS} * interval '1 millisecond')
        )`,
      })
      .from(outbox)
      .where(inArray(outbox.id, ownedIds))
      .orderBy(asc(outbox.id))

    expect(eligibleIds.size).toBe(CAPACITY)
    expect(CAPACITY).toBe(CLAIMERS * BATCH_SIZE)
    expect(beforeOwned).toHaveLength(ownedIds.length)
    expect(new Set(beforeOwned.filter((row) => row.eligible).map((row) => row.id))).toEqual(eligibleIds)

    coordinatorWork = coordinator
      .begin(async (tx) => {
        await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [runId])
        const locks = await tx.unsafe<AdvisoryLockIdentity[]>(`
          SELECT database::int AS database,
                 classid::int AS classid,
                 objid::int AS objid,
                 objsubid::int AS objsubid
          FROM pg_locks
          WHERE pid = pg_backend_pid()
            AND locktype = 'advisory'
            AND granted
            AND mode = 'ExclusiveLock'
        `)
        if (locks.length !== 1) {
          throw new Error(`expected one coordinator advisory lock, observed ${JSON.stringify(locks)}`)
        }
        gateHeld.resolve(locks[0])
        await release.promise
      })
      .catch((error) => {
        gateHeld.reject(error)
        throw error
      })
    const lockIdentity = await gateHeld.promise

    claims = clients.map((client, claimer) => {
      const applicationName = `outbox-claim:${runId}:${claimer}`
      return client
        .begin(async (tx) => {
          if (claimer === CLAIMERS - 1) await allowDelayedFifth.promise
          const [{ pid }] = await tx.unsafe<{ pid: number }[]>(
            "SELECT set_config('application_name', $1, true), pg_backend_pid()::int AS pid",
            [applicationName]
          )
          reportReadiness({ claimer, status: 'ready', pid, applicationName })
          await tx.unsafe('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [runId])
          return Outbox.claimBatch(BATCH_SIZE, OUTBOX_CLAIM_STALE_MS, {
            async execute(query) {
              const compiled = dialect.sqlToQuery(query)
              return tx.unsafe(compiled.sql, compiled.params as never[])
            },
          })
        })
        .catch((error) => {
          reportReadiness({ claimer, status: 'failed', applicationName, reason: String(error) })
          throw error
        })
    })
    claimsSettled = Promise.allSettled(claims)

    const expiresAt = performance.now() + 2_000
    const firstFour = await waitForClaimerReadiness(
      readiness.slice(0, CLAIMERS - 1).map((gate) => gate.promise),
      CLAIMERS - 1,
      expiresAt
    )
    waiterObservations.firstFour = await waitForExactAdvisoryWaiters(lockIdentity, firstFour, expiresAt)

    allowDelayedFifth.resolve()
    const allFive = await waitForClaimerReadiness(
      readiness.map((gate) => gate.promise),
      CLAIMERS,
      expiresAt
    )
    waiterObservations.allFive = await waitForExactAdvisoryWaiters(lockIdentity, allFive, expiresAt)

    release.resolve()
    await coordinatorWork
    const settled = await claimsSettled
    const outcomes: TransactionOutcome[] = settled.map((outcome, claimer) =>
      outcome.status === 'fulfilled'
        ? { claimer, status: 'fulfilled', rows: outcome.value }
        : { claimer, status: 'rejected', reason: String(outcome.reason) }
    )
    const completed = outcomes.filter(
      (outcome): outcome is Extract<TransactionOutcome, { status: 'fulfilled' }> => outcome.status === 'fulfilled'
    )
    const returned = completed.flatMap((claim) => claim.rows)
    const returnedIds = returned.map((row) => row.id)
    const returnedIdSet = new Set(returnedIds)
    const frequencies = new Map<string, number>()
    for (const id of returnedIds) frequencies.set(id, (frequencies.get(id) ?? 0) + 1)

    const persistedOwned = await db.select().from(outbox).where(inArray(outbox.id, ownedIds)).orderBy(asc(outbox.id))
    const persistedReturned =
      returnedIds.length === 0
        ? []
        : await db.select().from(outbox).where(inArray(outbox.id, returnedIds)).orderBy(asc(outbox.id))
    const persistedExcluded = persistedOwned.filter((row) => excludedIds.has(row.id))
    const excludedProjection = (rows: typeof persistedExcluded) =>
      rows.map(({ id, status, claimToken, claimedAt }) => ({ id, status, claimToken, claimedAt }))

    const diagnostic = {
      runId,
      capacity: CAPACITY,
      ownedEligibleIds: sorted(eligibleIds),
      ownedExcludedIds: sorted(excludedIds),
      returnedIds: sorted(returnedIds),
      missingIds: difference(eligibleIds, returnedIdSet),
      unexpectedIds: difference(returnedIdSet, eligibleIds),
      duplicateFrequencies: [...frequencies].filter(([, count]) => count !== 1),
      claims: completed.map((claim) => ({
        claimer: claim.claimer,
        ids: claim.rows.map((row) => row.id),
        token: claim.rows[0]?.claimToken,
        status: claim.rows.map((row) => row.status),
        claimedAt: claim.rows.map((row) => row.claimedAt),
      })),
      transactionOutcomes: outcomes,
      batchSizes: completed.map((claim) => claim.rows.length),
      waiterObservations,
      persistedOwned,
      persistedReturned,
      excludedBefore: excludedProjection(beforeExcluded),
      excludedAfter: excludedProjection(persistedExcluded),
    }

    withDiagnostics(() => {
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true)
      expect([...frequencies.entries()].filter(([, count]) => count !== 1)).toEqual([])
      expect(returned.some((row) => excludedIds.has(row.id))).toBe(false)
      expect(returnedIdSet).toEqual(eligibleIds)
      expect(returned).toHaveLength(eligibleIds.size)
      expect(completed.every((claim) => claim.rows.length <= BATCH_SIZE)).toBe(true)

      const owners = completed.filter((claim) => claim.rows.length > 0)
      for (const owner of owners) {
        const tokens = new Set(owner.rows.map((row) => row.claimToken))
        expect(tokens.size).toBe(1)
        expect([...tokens][0]).toBeTruthy()
        expect(owner.rows.every((row) => row.status === 'delivering' && row.claimedAt instanceof Date)).toBe(true)
      }
      expect(new Set(owners.map((owner) => owner.rows[0].claimToken)).size).toBe(owners.length)
      expect(persistedOwned).toHaveLength(ownedIds.length)

      const returnedById = new Map(returned.map((row) => [row.id, row]))
      const persistedEligible = persistedOwned.filter((row) => eligibleIds.has(row.id))
      expect(persistedEligible).toHaveLength(eligibleIds.size)
      for (const row of persistedEligible) {
        const claimed = returnedById.get(row.id)
        expect(claimed).toBeDefined()
        if (!claimed) throw new Error(`persisted eligible row ${row.id} was not returned by a claimant`)
        expect(row.status).toBe('delivering')
        expect(row.claimToken).toBe(claimed.claimToken)
        expect(row.claimedAt).toEqual(claimed.claimedAt)
      }
      expect(excludedProjection(persistedExcluded)).toEqual(excludedProjection(beforeExcluded))
    }, diagnostic)

    const deleted = await db.delete(outbox).where(inArray(outbox.id, ownedIds)).returning({ id: outbox.id })
    withDiagnostics(() => expect(new Set(deleted.map((row) => row.id))).toEqual(new Set(ownedIds)), {
      ...diagnostic,
      cleanupDeletedIds: sorted(deleted.map((row) => row.id)),
    })
    cleanupComplete = true
  } finally {
    allowDelayedFifth.resolve()
    release.resolve()
    for (let claimer = 0; claimer < CLAIMERS; claimer += 1) {
      reportReadiness({
        claimer,
        status: 'failed',
        applicationName: `outbox-claim:${runId}:${claimer}`,
        reason: 'test cleanup began before readiness',
      })
    }
    await Promise.allSettled([
      ...(coordinatorWork ? [coordinatorWork] : []),
      ...(claimsSettled ? [claimsSettled] : claims),
    ])
    await Promise.allSettled([...clients.map((client) => client.end()), coordinator.end()])
    if (!cleanupComplete) await db.delete(outbox).where(inArray(outbox.id, ownedIds))
  }
})

test('readiness deadline drains a transaction held before its handshake', async () => {
  const runId = crypto.randomUUID()
  const applicationName = `outbox-ready-timeout:${runId}`
  const coordinator = createPostgresConnection(getConnectionString(), { max: 1 })
  const client = createPostgresConnection(getConnectionString(), { max: 1 })
  const gateHeld = Promise.withResolvers<AdvisoryLockIdentity>()
  const release = Promise.withResolvers<void>()
  const holdReadiness = Promise.withResolvers<void>()
  const holdEntered = Promise.withResolvers<void>()
  const readiness = Promise.withResolvers<ClaimerReadiness>()
  let readinessReported = false
  const reportReadiness = (value: ClaimerReadiness) => {
    if (readinessReported) return
    readinessReported = true
    readiness.resolve(value)
  }
  let lockIdentity: AdvisoryLockIdentity | undefined
  let coordinatorWork: Promise<unknown> | undefined
  let claimWork: Promise<unknown> | undefined
  let settled: Promise<PromiseSettledResult<unknown>[]> | undefined
  let observedReadiness:
    | Promise<{ status: 'fulfilled'; value: ReadyClaimer[] } | { status: 'rejected'; reason: unknown }>
    | undefined
  let readinessOutcome:
    | { status: 'fulfilled'; value: ReadyClaimer[] }
    | { status: 'rejected'; reason: unknown }
    | { status: 'guard-expired' }
    | undefined
  let outcomes: PromiseSettledResult<unknown>[] = []

  try {
    coordinatorWork = coordinator
      .begin(async (tx) => {
        await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [runId])
        const [identity] = await tx.unsafe<AdvisoryLockIdentity[]>(`
          SELECT database::int AS database,
                 classid::int AS classid,
                 objid::int AS objid,
                 objsubid::int AS objsubid
          FROM pg_locks
          WHERE pid = pg_backend_pid()
            AND locktype = 'advisory'
            AND granted
            AND mode = 'ExclusiveLock'
        `)
        if (!identity) throw new Error('coordinator advisory lock identity was not found')
        lockIdentity = identity
        gateHeld.resolve(identity)
        await release.promise
      })
      .catch((error) => {
        gateHeld.reject(error)
        throw error
      })
    await gateHeld.promise

    claimWork = client
      .begin(async (tx) => {
        holdEntered.resolve()
        await holdReadiness.promise
        const [{ pid }] = await tx.unsafe<{ pid: number }[]>(
          "SELECT set_config('application_name', $1, true), pg_backend_pid()::int AS pid",
          [applicationName]
        )
        reportReadiness({ claimer: 0, status: 'ready', pid, applicationName })
        await tx.unsafe('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [runId])
      })
      .catch((error) => {
        reportReadiness({ claimer: 0, status: 'failed', applicationName, reason: String(error) })
        throw error
      })
    settled = Promise.allSettled([coordinatorWork, claimWork])
    await holdEntered.promise

    const readinessAttempt = waitForClaimerReadiness([readiness.promise], 1, performance.now() + 50)
    observedReadiness = readinessAttempt.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    )
    let guardTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      readinessOutcome = await Promise.race([
        observedReadiness,
        new Promise<{ status: 'guard-expired' }>((resolveGuard) => {
          guardTimeout = setTimeout(() => resolveGuard({ status: 'guard-expired' }), 250)
        }),
      ])
    } finally {
      if (guardTimeout !== undefined) clearTimeout(guardTimeout)
    }
  } finally {
    holdReadiness.resolve()
    release.resolve()
    reportReadiness({
      claimer: 0,
      status: 'failed',
      applicationName,
      reason: 'test cleanup began before readiness',
    })
    outcomes = settled
      ? await settled
      : await Promise.allSettled([coordinatorWork, claimWork].filter((work) => work !== undefined))
    if (observedReadiness) await observedReadiness
    await Promise.allSettled([client.end(), coordinator.end()])
  }

  expect(outcomes).toHaveLength(2)
  expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true)
  expect(lockIdentity).toBeDefined()
  if (!lockIdentity) throw new Error('coordinator advisory lock identity was not captured')
  const remainingActivity = await db.execute<{ pid: number }>(sql`
    SELECT pid::int AS pid
    FROM pg_stat_activity
    WHERE application_name = ${applicationName}
  `)
  const remainingLocks = await db.execute<{ pid: number }>(sql`
    SELECT pid::int AS pid
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = ${lockIdentity.database}
      AND classid = ${lockIdentity.classid}
      AND objid = ${lockIdentity.objid}
      AND objsubid = ${lockIdentity.objsubid}
  `)
  expect(remainingActivity).toHaveLength(0)
  expect(remainingLocks).toHaveLength(0)
  expect(readinessOutcome?.status).toBe('rejected')
  if (readinessOutcome?.status !== 'rejected') return
  expect(readinessOutcome.reason).toBeInstanceOf(Error)
  if (!(readinessOutcome.reason instanceof Error))
    throw new Error('readiness deadline rejected with a non-error reason')
  expect(readinessOutcome.reason.message).toContain('outbox claimer readiness deadline exceeded')
})
