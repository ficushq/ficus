import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  coalesceVmProvision,
  currentVmProvisionAttemptId,
  provisionBackoffMs,
  VmProvisionFailedError,
  VmProvisionLifecycle,
  VmPostProvisionSetupError,
} from './provision-flight'
import { withVmSetupLease } from './setup-state'
import { db } from '../../../db'
import { vmBoxProvisionAttempts as attempts } from '../../../db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { MachineNotReadyError } from '../../machines/queries'
import { startupRetryCode } from '../../execution/startup-retry'

for (const failure of [false, true]) {
  test(`concurrent physical ensures share one ${failure ? 'failed' : 'successful'} provision result`, async () => {
    const id = `flight-${randomUUID()}`
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const contended = Promise.withResolvers<void>()
    let provisions = 0
    let joins = 0
    const run = async () => {
      provisions++
      entered.resolve()
      await release.promise
      if (failure) throw new Error('synthetic provision failure')
      return 'ready'
    }
    const join = async () => {
      joins++
      return 'ready'
    }
    const owner = coalesceVmProvision(id, run, join)
    const pending: Promise<unknown>[] = [owner]
    try {
      await entered.promise
      const follower = coalesceVmProvision(id, run, join, {
        wait: {
          sleep: async () => {
            contended.resolve()
            await release.promise
          },
        },
      })
      pending.push(follower)
      await contended.promise
      expect(provisions).toBe(1)
    } finally {
      release.resolve()
      const settled = await Promise.allSettled(pending)
      expect(settled.map((r) => r.status)).toEqual([
        failure ? 'rejected' : 'fulfilled',
        failure ? 'rejected' : 'fulfilled',
      ])
    }
    expect(provisions).toBe(1)
    expect(joins).toBe(failure ? 0 : 1)
  })
}

test('failed physical ensure backs off rather than immediately provisioning again', async () => {
  const id = `flight-${randomUUID()}`
  let provisions = 0
  const run = async () => {
    provisions++
    throw new Error('synthetic failure')
  }
  await expect(coalesceVmProvision(id, run, async () => '')).rejects.toThrow()
  await expect(coalesceVmProvision(id, run, async () => '')).rejects.toThrow()
  expect(provisions).toBe(1)
})

test('different sandbox provisions progress while another box owns the lease', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const owner = coalesceVmProvision(
    randomUUID(),
    async () => {
      entered.resolve()
      await release.promise
      return 'a'
    },
    async () => 'joined'
  )
  try {
    await entered.promise
    expect(
      await coalesceVmProvision(
        randomUUID(),
        async () => 'b',
        async () => 'joined'
      )
    ).toBe('b')
  } finally {
    release.resolve()
    await owner
  }
})

test('backoff increases after expiry, caps at 15 minutes, and success resets the count', async () => {
  const id = randomUUID()
  let calls = 0
  const fail = async () => {
    calls++
    throw new Error('synthetic secret stderr MUST NOT persist')
  }
  await expect(coalesceVmProvision(id, fail, async () => '')).rejects.toThrow()
  await db
    .update(attempts)
    .set({ retryAt: new Date(0) })
    .where(eq(attempts.sandboxId, id))
  await expect(coalesceVmProvision(id, fail, async () => '')).rejects.toThrow()
  const rows = await db.select().from(attempts).where(eq(attempts.sandboxId, id)).orderBy(attempts.id)
  expect(rows.map((r) => r.failureCount)).toEqual([1, 2])
  expect(rows[1]!.retryAt!.getTime() - rows[1]!.completedAt!.getTime()).toBeGreaterThanOrEqual(59_990)
  expect(JSON.stringify(rows)).not.toContain('secret stderr')
  expect(provisionBackoffMs(100)).toBe(15 * 60_000)
  await db
    .update(attempts)
    .set({ retryAt: new Date(0) })
    .where(eq(attempts.sandboxId, id))
  await coalesceVmProvision(
    id,
    async () => 'ready',
    async () => ''
  )
  await expect(coalesceVmProvision(id, fail, async () => '')).rejects.toThrow()
  const latest = (await db.select().from(attempts).where(eq(attempts.sandboxId, id)).orderBy(attempts.id)).at(-1)!
  expect(latest.failureCount).toBe(1)
  expect(calls).toBe(3)
})

for (const interruption of ['abort', 'timeout'] as const) {
  test(`${interruption} while waiting never provisions or cancels the owner`, async () => {
    const id = randomUUID()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const abort = new AbortController()
    let now = 0
    let calls = 0
    const owner = coalesceVmProvision(
      id,
      async () => {
        calls++
        entered.resolve()
        await release.promise
        return 'ready'
      },
      async () => ''
    )
    try {
      await entered.promise
      await expect(
        coalesceVmProvision(
          id,
          async () => {
            calls++
            return ''
          },
          async () => '',
          {
            wait: {
              now: () => now,
              signal: abort.signal,
              sleep: async () => {
                if (interruption === 'abort') abort.abort(new Error('synthetic cancel'))
                else now += 16 * 60_000
              },
            },
          }
        )
      ).rejects.toThrow(interruption === 'abort' ? 'synthetic cancel' : 'timed out')
      expect(calls).toBe(1)
    } finally {
      release.resolve()
      expect(await owner).toBe('ready')
    }
  })
}

test('an abandoned running generation immediately re-provisions under the acquired lease', async () => {
  const id = randomUUID()
  await db.insert(attempts).values({ sandboxId: id, failureCount: 8 })
  let calls = 0
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const run = async () => {
    calls++
    entered.resolve()
    await release.promise
    return 'recovered'
  }
  const owner = coalesceVmProvision(id, run, async () => 'recovered')
  let follower: Promise<string> | undefined
  try {
    await entered.promise
    const [row] = await db.select().from(attempts).where(eq(attempts.sandboxId, id)).orderBy(attempts.id)
    expect(row!.failureClass).toBe('abandoned')
    expect(row!.retryAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(row!.failureCount).toBe(0)
    follower = coalesceVmProvision(id, run, async () => 'recovered', {
      wait: {
        sleep: async () => {
          waiting.resolve()
          await release.promise
        },
      },
    })
    await waiting.promise
    release.resolve()
    expect(await Promise.all([owner, follower])).toEqual(['recovered', 'recovered'])
    expect(calls).toBe(1)
  } finally {
    release.resolve()
    await Promise.allSettled([owner, ...(follower ? [follower] : [])])
  }
})

test('nested provisioning refuses before a dedicated slot or same-box lock can deadlock', async () => {
  const id = randomUUID()
  await expect(
    coalesceVmProvision(
      id,
      () =>
        coalesceVmProvision(
          id,
          async () => '',
          async () => ''
        ),
      async () => ''
    )
  ).rejects.toThrow('Nested VM provisioning')
  expect(
    await coalesceVmProvision(
      randomUUID(),
      async () => 'unrelated',
      async () => ''
    )
  ).toBe('unrelated')
})

test('a bind/reaper placement race retains the existing safe immediate re-placement', async () => {
  const id = randomUUID()
  await expect(
    coalesceVmProvision(
      id,
      async () => {
        throw new MachineNotReadyError('synthetic reaper')
      },
      async () => ''
    )
  ).rejects.toBeInstanceOf(MachineNotReadyError)
  expect(
    await coalesceVmProvision(
      id,
      async () => 'new machine',
      async () => ''
    )
  ).toBe('new machine')
})

for (const newerSuccess of [true, false])
  test(`a delayed failed follower uses latest state (newer success: ${newerSuccess})`, async () => {
    const id = randomUUID()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const snapshotted = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const owner = coalesceVmProvision(
      id,
      async () => {
        entered.resolve()
        await release.promise
        throw new Error('generation one')
      },
      async () => ''
    )
    const ownerResult = owner.catch((e) => e)
    let calls = 0
    let follower: Promise<unknown> | undefined
    try {
      await entered.promise
      follower = coalesceVmProvision(
        id,
        async () => {
          calls++
          return 'recovered'
        },
        async () => 'joined latest success',
        {
          withLease: async (fn) => {
            snapshotted.resolve()
            await resume.promise
            return withVmSetupLease(id, fn)
          },
        }
      ).catch((e) => e)
      await snapshotted.promise
      release.resolve()
      await ownerResult
      await db
        .update(attempts)
        .set({ retryAt: new Date(0) })
        .where(eq(attempts.sandboxId, id))
      if (newerSuccess)
        expect(
          await coalesceVmProvision(
            id,
            async () => 'generation two',
            async () => ''
          )
        ).toBe('generation two')
      if (newerSuccess)
        await db
          .update(attempts)
          .set({ retryAt: new Date(Date.now() + 60_000) })
          .where(and(eq(attempts.sandboxId, id), eq(attempts.status, 'failed')))
      resume.resolve()
      const result = await follower
      expect(result).toBe(newerSuccess ? 'joined latest success' : 'recovered')
      expect(calls).toBe(newerSuccess ? 0 : 1)
    } finally {
      release.resolve()
      resume.resolve()
      await ownerResult
      await follower
    }
  })

test('an owner fenced after session loss cannot overwrite an already shared abandoned result', async () => {
  const id = randomUUID()
  const owner = coalesceVmProvision(
    id,
    async () => {
      // Model the next authoritative lease owner observing a lost session while
      // this caller is still unwinding its remote operation.
      await db
        .update(attempts)
        .set({
          status: 'failed',
          failureClass: 'abandoned',
          retryAt: new Date(Date.now() + 30_000),
          completedAt: new Date(),
        })
        .where(eq(attempts.sandboxId, id))
      return 'late success'
    },
    async () => ''
  )
  await expect(owner).rejects.toThrow('ownership')
  const [row] = await db.select().from(attempts).where(eq(attempts.sandboxId, id))
  expect(row!.status).toBe('failed')
  expect(row!.failureClass).toBe('abandoned')
})

test('indexed retention prunes only the leased box terminal generations older than the waiter budget', async () => {
  const expired = randomUUID()
  const recent = randomUUID()
  const running = randomUUID()
  await db.insert(attempts).values([
    { sandboxId: expired, status: 'succeeded', completedAt: new Date(Date.now() - 2 * 60 * 60_000) },
    { sandboxId: recent, status: 'failed', completedAt: new Date() },
    { sandboxId: running, status: 'running', createdAt: new Date(0) },
  ])
  await coalesceVmProvision(
    expired,
    async () => 'ready',
    async () => ''
  )
  const retained = await db.select().from(attempts).where(eq(attempts.sandboxId, expired))
  expect(retained).toHaveLength(1)
  expect(retained[0]!.status).toBe('succeeded')
  expect(retained[0]!.completedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000)
  expect(await db.select().from(attempts).where(eq(attempts.sandboxId, recent))).toHaveLength(1)
  expect(await db.select().from(attempts).where(eq(attempts.sandboxId, running))).toHaveLength(1)
})

test('loss of the owned direct DB session shares abandonment and fences the late owner result', async () => {
  const id = randomUUID()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const owner = coalesceVmProvision(
    id,
    async () => {
      entered.resolve()
      await release.promise
      return 'late owner'
    },
    async () => ''
  )
  const ownerResult = owner.catch((error) => error)
  try {
    await entered.promise
    const [original] = await db.select().from(attempts).where(eq(attempts.sandboxId, id))
    const key = `vm-box-setup:${id}`
    const locks = await db.execute(sql`
      SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
      AND objid = (hashtextextended(${key}, 0) & 4294967295)::oid
      AND objsubid = 1`)
    expect(locks).toHaveLength(1)
    // Only this test's synthetic, dedicated backend in the project-scoped DB.
    await db.execute(sql`SELECT pg_terminate_backend(${Number(locks[0]!.pid)})`)
    let callbacks = 0
    await expect(
      coalesceVmProvision(
        id,
        async () => {
          callbacks++
          return ''
        },
        async () => ''
      )
    ).resolves.toBe('')
    expect(callbacks).toBe(1)
    release.resolve()
    expect(await ownerResult).toBeInstanceOf(Error)
    // The successor also has a row; an unordered sandbox-wide SELECT can
    // return its successful generation instead of the crashed owner's row.
    const [row] = await db.select().from(attempts).where(eq(attempts.id, original!.id))
    expect(row!.status).toBe('failed')
    expect(row!.failureClass).toBe('abandoned')
  } finally {
    release.resolve()
    await ownerResult
  }
})

for (const [name, code] of [
  ['BoxPortBusyError', 'box_port_busy'],
  ['BoxLockTimeoutError', 'box_lock_timeout'],
  ['BoxStopUnverifiedError', 'box_stop_unverified'],
  ['MachineUnavailableError', 'machine_unreachable'],
  ['MachineNotReadyError', 'machine_bootstrapping'],
  ['MachineNotReadyError', 'machine_registered'],
  ['Error', '53300'],
] as const) {
  test(`shared/backoff failure preserves the safe startup retry classification ${code}`, async () => {
    const id = randomUUID()
    const original = Object.assign(new Error('synthetic private diagnostics'), {
      name,
      ...(code === '53300' ? { code } : {}),
      ...(code.startsWith('machine_') ? { machineStatus: code.slice(8) } : {}),
    })
    await expect(
      coalesceVmProvision(
        id,
        async () => {
          throw original
        },
        async () => ''
      )
    ).rejects.toBe(original)
    const shared = await coalesceVmProvision(
      id,
      async () => 'must not run',
      async () => ''
    ).catch((e) => e)
    expect(shared).toBeInstanceOf(VmProvisionFailedError)
    expect(startupRetryCode(shared)).toBe(code)
    expect(JSON.stringify(shared)).not.toContain('private diagnostics')
  })
}

test('clean shutdown interrupts only owned generations and the replacement immediately provisions', async () => {
  const lifecycle = new VmProvisionLifecycle()
  const id = randomUUID()
  const otherId = randomUUID()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const owner = coalesceVmProvision(
    id,
    async () => {
      entered.resolve()
      await release.promise
      return 'late result'
    },
    async () => '',
    { lifecycle }
  ).catch((error) => error)
  try {
    await entered.promise
    await db.insert(attempts).values({ sandboxId: otherId })
    const now = Date.now()
    await lifecycle.interrupt()
    const [own] = await db.select().from(attempts).where(eq(attempts.sandboxId, id))
    const [other] = await db.select().from(attempts).where(eq(attempts.sandboxId, otherId))
    expect(own!.status).toBe('failed')
    expect(own!.failureClass).toBe('interrupted')
    expect(own!.retryAt!.getTime()).toBeGreaterThanOrEqual(now)
    expect(own!.retryAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(own!.failureCount).toBe(0)
    expect(other!.status).toBe('running')
    release.resolve()
    expect(await owner).toBeInstanceOf(Error)
    expect(
      await coalesceVmProvision(
        id,
        async () => 'replacement',
        async () => 'stale'
      )
    ).toBe('replacement')
    await expect(
      coalesceVmProvision(
        randomUUID(),
        async () => 'must not start',
        async () => '',
        { lifecycle }
      )
    ).rejects.toThrow('interrupted')
  } finally {
    release.resolve()
    await owner
  }
})

test('shutdown waits for a generation insert crossing its ownership snapshot', async () => {
  const lifecycle = new VmProvisionLifecycle()
  const id = randomUUID()
  const release = Promise.withResolvers<void>()
  const creation = lifecycle
    .registerCreation(async () => {
      await release.promise
      const [row] = await db.insert(attempts).values({ sandboxId: id }).returning()
      return row!
    })
    .catch((error) => error)
  let stopped = false
  const shutdown = lifecycle.interrupt().then(() => {
    stopped = true
  })
  try {
    await Bun.sleep(10)
    expect(stopped).toBe(false)
    release.resolve()
    await shutdown
    expect(await creation).toBeInstanceOf(Error)
    const [row] = await db.select().from(attempts).where(eq(attempts.sandboxId, id))
    expect(row!.failureClass).toBe('interrupted')
    expect(row!.retryAt!.getTime()).toBeLessThanOrEqual(Date.now())
  } finally {
    release.resolve()
    await Promise.all([creation, shutdown])
  }
})

test('setup failure preserves retry semantics without inherited physical cooldown', async () => {
  const id = randomUUID()
  await db
    .insert(attempts)
    .values({ sandboxId: id, status: 'failed', failureClass: 'provision', failureCount: 8, retryAt: new Date(0) })
  const failure = new VmPostProvisionSetupError(new Error('synthetic asset failure'))
  const error = await coalesceVmProvision(
    id,
    async () => {
      throw failure
    },
    async () => ''
  ).catch((error) => error)
  expect(startupRetryCode(error)).toBe('sandbox_readiness_pending')
  const rows = await db.select().from(attempts).where(eq(attempts.sandboxId, id)).orderBy(attempts.id)
  const row = rows.at(-1)!
  expect(row.failureClass).toBe('retry:sandbox_readiness_pending')
  expect(row.failureCount).toBe(0)
  expect(row.retryAt!.getTime()).toBeLessThanOrEqual(Date.now())
  expect(
    await coalesceVmProvision(
      id,
      async () => 'recovered',
      async () => 'stale'
    )
  ).toBe('recovered')
})

test('interrupted replay before expiry is retryable rather than a cause-less terminal error', async () => {
  const id = randomUUID()
  await db
    .insert(attempts)
    .values({ sandboxId: id, status: 'failed', failureClass: 'interrupted', retryAt: new Date(Date.now() + 1000) })
  const failure = await coalesceVmProvision(
    id,
    async () => 'must not run',
    async () => ''
  ).catch((error) => error)
  expect(startupRetryCode(failure)).toBe('sandbox_readiness_pending')
})

test('stop-proof contention cannot inherit a cooldown longer than its startup schedule', async () => {
  const id = randomUUID()
  await db
    .insert(attempts)
    .values({ sandboxId: id, status: 'failed', failureClass: 'provision', failureCount: 8, retryAt: new Date(0) })
  const error = new Error('stop proof is still pending')
  error.name = 'BoxStopUnverifiedError'
  await expect(
    coalesceVmProvision(
      id,
      async () => {
        throw error
      },
      async () => ''
    )
  ).rejects.toBe(error)
  const rows = await db.select().from(attempts).where(eq(attempts.sandboxId, id)).orderBy(attempts.id)
  const row = rows.at(-1)!
  expect(row.failureCount).toBe(1)
  expect(row.retryAt!.getTime() - row.completedAt!.getTime()).toBeLessThanOrEqual(30_000)
})

test('current physical generation identity is scoped to the owner callback only', async () => {
  expect(currentVmProvisionAttemptId()).toBeUndefined()
  const id = `identity-${randomUUID()}`
  await coalesceVmProvision(
    id,
    async () => {
      const generation = currentVmProvisionAttemptId()
      expect(typeof generation).toBe('number')
      const [row] = await db.select().from(attempts).where(eq(attempts.id, generation!))
      expect(row).toMatchObject({ sandboxId: id, status: 'running' })
    },
    async () => {
      throw new Error('unexpected follower')
    },
    { withLease: (fn) => fn() }
  )
  expect(currentVmProvisionAttemptId()).toBeUndefined()
})
