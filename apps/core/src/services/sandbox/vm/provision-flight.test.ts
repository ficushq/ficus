import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { coalesceVmProvision, provisionBackoffMs, VmProvisionFailedError } from './provision-flight'
import { withVmSetupLease } from './setup-state'
import { db } from '../../../db'
import { vmBoxProvisionAttempts as attempts } from '../../../db/schema'
import { eq, sql } from 'drizzle-orm'
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

test('an abandoned running generation fails/backoffs before any retry can run', async () => {
  const id = randomUUID()
  await db.insert(attempts).values({ sandboxId: id })
  let calls = 0
  await expect(
    coalesceVmProvision(
      id,
      async () => {
        calls++
        return ''
      },
      async () => ''
    )
  ).rejects.toBeInstanceOf(VmProvisionFailedError)
  const [row] = await db.select().from(attempts).where(eq(attempts.sandboxId, id))
  expect(row!.failureClass).toBe('abandoned')
  expect(row!.retryAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000)
  await expect(
    coalesceVmProvision(
      id,
      async () => {
        calls++
        return ''
      },
      async () => ''
    )
  ).rejects.toThrow()
  expect(calls).toBe(0)
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

test('a delayed waiter consumes its exact failed generation even after a newer success', async () => {
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
        return ''
      },
      async () => {
        calls++
        return ''
      },
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
    expect(
      await coalesceVmProvision(
        id,
        async () => 'generation two',
        async () => ''
      )
    ).toBe('generation two')
    resume.resolve()
    const result = await follower
    expect(result).toBeInstanceOf(VmProvisionFailedError)
    const [first] = await db.select().from(attempts).where(eq(attempts.sandboxId, id)).orderBy(attempts.id)
    expect((result as VmProvisionFailedError).attemptId).toBe(first!.id)
    expect(calls).toBe(0)
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

test('indexed retention prunes only terminal generations older than the waiter budget, including retired boxes', async () => {
  const expired = randomUUID()
  const recent = randomUUID()
  const running = randomUUID()
  await db.insert(attempts).values([
    { sandboxId: expired, status: 'succeeded', completedAt: new Date(Date.now() - 2 * 60 * 60_000) },
    { sandboxId: recent, status: 'failed', completedAt: new Date() },
    { sandboxId: running, status: 'running', createdAt: new Date(0) },
  ])
  await coalesceVmProvision(
    randomUUID(),
    async () => 'ready',
    async () => ''
  )
  expect(await db.select().from(attempts).where(eq(attempts.sandboxId, expired))).toHaveLength(0)
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
    ).rejects.toBeInstanceOf(VmProvisionFailedError)
    expect(callbacks).toBe(0)
    release.resolve()
    expect(await ownerResult).toBeInstanceOf(Error)
    const [row] = await db.select().from(attempts).where(eq(attempts.sandboxId, id))
    expect(row!.status).toBe('failed')
    expect(row!.failureClass).toBe('abandoned')
  } finally {
    release.resolve()
    await ownerResult
  }
})

for (const [name, code] of [
  ['BoxPortBusyError', 'box_port_busy'],
  ['Error', '53300'],
] as const) {
  test(`shared/backoff failure preserves the safe startup retry classification ${code}`, async () => {
    const id = randomUUID()
    const original = Object.assign(new Error('synthetic private diagnostics'), {
      name,
      ...(code === '53300' ? { code } : {}),
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
