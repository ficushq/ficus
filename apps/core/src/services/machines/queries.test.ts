import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../db/schema'
import {
  agents,
  db,
  executions,
  forcedBoxMigrationAudits,
  instanceMaintenanceState,
  machineBoxes,
  squads,
} from '../../db'
import type postgres from 'postgres'
import { sandboxActivity } from './box-migrate'
import { stopBox } from './box-manager'
import {
  cancelInterruptedForceMigrationAudits,
  findForceMigrationAudit,
  finishForceMigrationAuditInTransaction,
  requireForceMigrationSettlement,
  startForceMigrationAudit,
} from './force-migration-audit'
import { createPostgresConnection, getConnectionString } from '../../db/connection'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import {
  areBoxesMigratingLocked,
  bindMachineBox,
  BoxBindConflictError,
  claimMachineForBootstrap,
  claimMachineForReaping,
  clearAllMigratingFences,
  clearBoxMigrating,
  deleteMachine,
  deleteMachineBox,
  externalizeUnverifiedBoxStop,
  failMachineBootstrapClaim,
  fenceBoxForMigration,
  getMachine,
  getMachineByName,
  getMachineBox,
  hasUnverifiedStopRemnant,
  insertMachine,
  isBoxMigrating,
  isBoxMigratingLocked,
  listMachineBoxes,
  listMachines,
  machineExistsWithProvider,
  MachineNotReadyError,
  originalSandboxIdFromUnverifiedStopRemnant,
  peekNextBoxPort,
  queryReadySharedMachineLoads,
  recoverMigrationFencesOnce,
  restoreMachineFromReaping,
  clearBoxSyncedHashes,
  stampArtifactVersion,
  stampBoxSyncedHash,
  stampMachineEmptySinceIfDrained,
  updateMachine,
  unverifiedStopRemnantId,
  upsertMachineBox,
  UNVERIFIED_STOP_REMNANT_PREFIX,
} from './queries'

const prefix = `mtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function machineValues(name: string) {
  return {
    name: `${prefix}-${name}`,
    provider: 'ssh',
    sshHost: '10.0.0.1',
    sshUser: 'tau',
    sshKeyId: 'secret-key-1',
    sshPublicKey: 'ssh-ed25519 AAAA test',
  }
}

/** Bind-target shape: bindMachineBox rejects any non-'ready' machine, so tests
 *  that bind must insert a ready one (insertMachine's default is 'registered'). */
function readyMachineValues(name: string) {
  return { ...machineValues(name), status: 'ready' }
}

async function cleanup() {
  // machine_boxes cascade off machines, so deleting machines is enough, but be
  // explicit in case a test left boxes on machines it did not create here.
  const all = await listMachines()
  for (const m of all) {
    if (m.name.startsWith(prefix)) await deleteMachine(m.id)
  }
}

beforeEach(cleanup)
afterEach(cleanup)

// A genuinely SEPARATE Postgres connection (not another handle on `db`'s
// pool taken while a `db.transaction` holds one), for asserting from the
// outside that a row lock is really held: `FOR UPDATE NOWAIT` on a locked row
// fails fast with SQLSTATE 55P03 instead of blocking.
const secondConnection = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
// A THIRD connection, needed only by the lock-acquisition-ORDER test below:
// there the second connection is busy holding an open transaction, so the
// outside observer has to be someone else again.
const thirdConnection = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
beforeAll(async () => {
  releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(async () => {
  try {
    await releaseMaintenanceIsolation?.()
  } finally {
    await secondConnection.end()
    await thirdConnection.end()
  }
})

/**
 * From the second connection, try to take the box row's `FOR UPDATE` lock with
 * NOWAIT. Returns `'locked'` when the lock was acquired (i.e. nobody held it —
 * autocommit releases it at statement end) or the SQLSTATE code of the failure
 * (`'55P03'` = lock held elsewhere).
 */
async function tryLockBoxRowFromSecondConnection(sandboxId: string): Promise<string> {
  try {
    await secondConnection`SELECT migrating FROM machine_boxes WHERE sandbox_id = ${sandboxId} FOR UPDATE NOWAIT`
    return 'locked'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}

/**
 * The order `LockRows` would take these box rows in with NO `ORDER BY` — i.e.
 * the heap order a seq scan emits. Both index paths are disabled for the
 * transaction so the plan is the seq scan whether or not the planner would
 * have chosen it, which is what makes the ordering property observable at all
 * (an Index Scan on the pkey is already sorted and hides it).
 */
async function emissionOrderUnderForcedSeqScan(sandboxIds: string[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_indexscan = off`)
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`)
    // areBoxesMigratingLocked's own query with the ORDER BY removed — i.e.
    // exactly what the mutation under test would run.
    const rows = await tx
      .select({ sandboxId: machineBoxes.sandboxId })
      .from(machineBoxes)
      .where(inArray(machineBoxes.sandboxId, sandboxIds))
      .for('update')
    return rows.map((row) => row.sandboxId)
  })
}

/** Same probe, from the third connection. */
async function tryLockBoxRowFromThirdConnection(sandboxId: string): Promise<string> {
  try {
    await thirdConnection`SELECT migrating FROM machine_boxes WHERE sandbox_id = ${sandboxId} FOR UPDATE NOWAIT`
    return 'locked'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}

describe('unverified stop externalization', () => {
  it('defers a fresh marker, refuses a ready machine, then atomically detaches an aged non-ready box', async () => {
    const machine = await insertMachine({ ...machineValues('unverified-stop'), status: 'ready' })
    await upsertMachineBox({
      sandboxId: 'agent_unverified',
      machineId: machine.id,
      unixUser: 'box_unverified',
      port: 50100,
      status: 'stop_unverified',
    })

    expect(await externalizeUnverifiedBoxStop('agent_unverified')).toEqual({ kind: 'machine-ready' })
    await updateMachine(machine.id, { status: 'unreachable' })
    expect(await stopBox('agent_unverified')).toEqual({ kind: 'unverified' })
    expect(await externalizeUnverifiedBoxStop('agent_unverified')).toEqual({ kind: 'deferred' })
    await db
      .update(machineBoxes)
      .set({ updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(machineBoxes.sandboxId, 'agent_unverified'))

    // Repeated one-minute dormancy attempts must not refresh the original
    // stop intent's age or prevent the five-minute externalization bound.
    expect(await stopBox('agent_unverified')).toEqual({ kind: 'unverified' })
    expect(await stopBox('agent_unverified')).toEqual({ kind: 'unverified' })

    const result = await externalizeUnverifiedBoxStop('agent_unverified')
    expect(result).toMatchObject({ kind: 'externalized', machineId: machine.id, port: 50100 })
    expect(await getMachineBox('agent_unverified')).toBeNull()
    const remnants = await listMachineBoxes(machine.id)
    expect(remnants).toHaveLength(1)
    expect(remnants[0]).toMatchObject({
      sandboxId: expect.stringContaining(UNVERIFIED_STOP_REMNANT_PREFIX),
      unixUser: 'box_unverified',
      port: 50100,
      status: 'orphaned',
    })
    expect(await hasUnverifiedStopRemnant(machine.id, 'box_unverified')).toBe(true)
    expect(result.kind === 'externalized' && originalSandboxIdFromUnverifiedStopRemnant(result.remnantId)).toBe(
      'agent_unverified'
    )
    expect(
      originalSandboxIdFromUnverifiedStopRemnant(
        unverifiedStopRemnantId('agent.with.dot', '00000000-0000-4000-8000-000000000001')
      )
    ).toBe('agent.with.dot')
  })
})

describe('machine bootstrap claim', () => {
  it('admits exactly one of many concurrent claims', async () => {
    const machine = await insertMachine({ ...machineValues('boot-claim-race'), status: 'ready' })
    const results = await Promise.all(Array.from({ length: 8 }, () => claimMachineForBootstrap(machine.id)))
    expect(results.filter((row) => row !== null)).toHaveLength(1)
    expect((await getMachine(machine.id))?.status).toBe('bootstrapping')
  })

  it('claims only from the allowed statuses', async () => {
    const machine = await insertMachine({ ...machineValues('boot-claim-from'), status: 'unreachable' })
    expect(await claimMachineForBootstrap(machine.id, ['ready'])).toBeNull()
    expect((await getMachine(machine.id))?.status).toBe('unreachable')
    expect((await claimMachineForBootstrap(machine.id))?.status).toBe('bootstrapping')
  })

  it('settles a stranded claim but never clobbers an outcome the run recorded', async () => {
    const stranded = await insertMachine({ ...machineValues('boot-claim-stranded'), status: 'bootstrapping' })
    await failMachineBootstrapClaim(stranded.id, 'boom')
    expect(await getMachine(stranded.id)).toMatchObject({ status: 'unreachable', lastError: 'boom' })

    const settled = await insertMachine({ ...machineValues('boot-claim-settled'), status: 'ready' })
    await failMachineBootstrapClaim(settled.id, 'late failure')
    expect(await getMachine(settled.id)).toMatchObject({ status: 'ready', lastError: null })
  })
})

describe('machine queries', () => {
  it('round-trips insert / get / getByName / list / update / delete', async () => {
    const inserted = await insertMachine(machineValues('a'))
    expect(inserted.id).toBeString()
    expect(inserted.name).toBe(`${prefix}-a`)
    // Defaults applied.
    expect(inserted.provider).toBe('ssh')
    expect(inserted.sshPort).toBe(22)
    expect(inserted.status).toBe('registered')
    expect(inserted.scope).toBe('shared')
    expect(inserted.capabilities).toEqual({})
    expect(inserted.createdAt).toBeInstanceOf(Date)

    const byId = await getMachine(inserted.id)
    expect(byId?.id).toBe(inserted.id)

    const byName = await getMachineByName(`${prefix}-a`)
    expect(byName?.id).toBe(inserted.id)

    const list = await listMachines()
    expect(list.some((m) => m.id === inserted.id)).toBe(true)

    const updated = await updateMachine(inserted.id, {
      status: 'ready',
      capabilities: { arch: 'arm64', cpus: 4, docker: 'rootless' },
    })
    expect(updated?.status).toBe('ready')
    expect(updated?.capabilities).toEqual({ arch: 'arm64', cpus: 4, docker: 'rootless' })

    await deleteMachine(inserted.id)
    expect(await getMachine(inserted.id)).toBeNull()
  })

  it('getMachine / getMachineByName return null when absent', async () => {
    expect(await getMachine('00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(await getMachineByName(`${prefix}-nope`)).toBeNull()
  })

  it('updateMachine returns null for a missing machine', async () => {
    expect(await updateMachine('00000000-0000-0000-0000-000000000000', { status: 'ready' })).toBeNull()
  })

  it('surfaces a unique name violation as SQLSTATE 23505 (placement dedupe adopts on this)', async () => {
    await insertMachine(machineValues('dup'))
    // The concurrent-provision dedupe (placement.provisionCapped) recognises the
    // race-loser by this exact driver shape — code 23505 on machines_name_unique —
    // then adopts the winner's row. Pin the shape so a driver bump can't silently
    // turn adopt back into a hard failure.
    const err = await insertMachine(machineValues('dup')).then(
      () => null,
      (e: unknown) => e as { code?: string; constraint_name?: string }
    )
    expect(err).not.toBeNull()
    expect(err?.code).toBe('23505')
    expect(err?.constraint_name).toBe('machines_name_unique')
  })
})

describe('machineExistsWithProvider', () => {
  // NOTE: relies on the shared test DB having no pre-existing 'exe'-provider
  // machine row left behind by another test file/run (the query is
  // deliberately global/unscoped — see machineExistsWithProvider's own
  // comment). If this ever flakes false-true with no test-authored cause,
  // check for an exe machine row leaked by a different test before
  // suspecting this function.
  it('is false when no machine of that provider is registered', async () => {
    expect(await machineExistsWithProvider('exe')).toBe(false)
  })

  it('is true once a machine of that provider exists, and stays scoped to that provider', async () => {
    await insertMachine({ ...machineValues('exe-a'), provider: 'exe' })
    expect(await machineExistsWithProvider('exe')).toBe(true)
    expect(await machineExistsWithProvider('ssh')).toBe(false)
  })
})

describe('machine box queries', () => {
  it('binds sequential ports from 50100 and increments per sandbox', async () => {
    const machine = await insertMachine(readyMachineValues('ports'))

    const first = await bindMachineBox({ sandboxId: `${prefix}-sb1`, machineId: machine.id, unixUser: 'box1' })
    expect(first.port).toBe(50100)

    const second = await bindMachineBox({ sandboxId: `${prefix}-sb2`, machineId: machine.id, unixUser: 'box2' })
    expect(second.port).toBe(50101)
  })

  it('rebinding the same sandbox to the same machine keeps its port', async () => {
    const machine = await insertMachine(readyMachineValues('rebind-same'))
    const sandboxId = `${prefix}-rb`

    const first = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    expect(first.port).toBe(50100)

    // Add another box so MAX(port)+1 would compute 50102 if we re-allocated.
    await bindMachineBox({ sandboxId: `${prefix}-rb-other`, machineId: machine.id, unixUser: 'other' })

    const rebound = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box-renamed' })
    expect(rebound.port).toBe(50100) // kept, not re-allocated
    expect(rebound.unixUser).toBe('box-renamed') // unix_user refreshed
  })

  it('rebinding a sandbox to a different machine allocates on the new machine', async () => {
    const machineA = await insertMachine(readyMachineValues('rebind-a'))
    const machineB = await insertMachine(readyMachineValues('rebind-b'))
    const sandboxId = `${prefix}-move`

    const onA = await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })
    expect(onA.port).toBe(50100)

    // Seed machineB with an existing box so MAX(port)+1 there is 50101.
    await bindMachineBox({ sandboxId: `${prefix}-b-seed`, machineId: machineB.id, unixUser: 'seed' })

    const onB = await bindMachineBox({ sandboxId, machineId: machineB.id, unixUser: 'box' })
    expect(onB.machineId).toBe(machineB.id)
    expect(onB.port).toBe(50101) // freshly allocated on machineB
  })

  // Cross-machine rebind must reset the per-asset drift stamps ATOMICALLY, under
  // the bind's row lock. The migrate primitive installs the TARGET box (clearing
  // stamps) while the row still points at the SOURCE, then repoints at the final
  // bind; a concurrent ensure racing in that window can push+stamp assets against
  // the SOURCE (whose row the machine guard still matches), and the bare repoint
  // would carry those stamps onto the TARGET — whose box holds none of the assets
  // → next ensure skip-starves it. Wiping stamps as part of the repoint closes
  // that window: a stamp landing BEFORE the bind commits is erased by it; one
  // attempted AFTER is rejected by stampBoxSyncedHash's machine guard.
  it('rebinding to a DIFFERENT machine resets synced_hashes to {} even when stamps existed', async () => {
    const machineA = await insertMachine(readyMachineValues('rebind-reset-a'))
    const machineB = await insertMachine(readyMachineValues('rebind-reset-b'))
    const sandboxId = `${prefix}-rebind-reset`

    await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })
    await stampBoxSyncedHash(machineA.id, sandboxId, 'skills', 'h1')
    await stampBoxSyncedHash(machineA.id, sandboxId, 'identity', 'h2')
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({ skills: 'h1', identity: 'h2' })

    const onB = await bindMachineBox({ sandboxId, machineId: machineB.id, unixUser: 'box' })
    expect(onB.machineId).toBe(machineB.id)
    expect(onB.syncedHashes).toEqual({})
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({})
  })

  it('rebinding to the SAME machine PRESERVES existing stamps (only cross-machine wipes)', async () => {
    const machine = await insertMachine(readyMachineValues('rebind-keep'))
    const sandboxId = `${prefix}-rebind-keep`

    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    await stampBoxSyncedHash(machine.id, sandboxId, 'skills', 'h1')
    await stampBoxSyncedHash(machine.id, sandboxId, 'identity', 'h2')

    const rebound = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box-renamed' })
    expect(rebound.machineId).toBe(machine.id)
    expect(rebound.syncedHashes).toEqual({ skills: 'h1', identity: 'h2' })
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({ skills: 'h1', identity: 'h2' })
  })

  // The exact migrate-window race shape: a stamp lands under the SOURCE machineId
  // (the machine guard passes — the row still points there), THEN the migrate's
  // final bind repoints to the TARGET. The repoint must swallow that racing stamp.
  it('a stamp racing in under the SOURCE machine before the repoint is wiped by the cross-machine bind', async () => {
    const source = await insertMachine(readyMachineValues('race-source'))
    const target = await insertMachine(readyMachineValues('race-target'))
    const sandboxId = `${prefix}-race`

    const onSource = await bindMachineBox({ sandboxId, machineId: source.id, unixUser: 'box' })
    // Concurrent ensure fast-paths the SOURCE box and stamps all assets there.
    await stampBoxSyncedHash(source.id, sandboxId, 'skills', 'raced')
    await stampBoxSyncedHash(source.id, sandboxId, 'env', 'raced')
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({ skills: 'raced', env: 'raced' })

    // Migrate's final repoint (conditional CAS) to the target machine.
    const onTarget = await bindMachineBox({
      sandboxId,
      machineId: target.id,
      unixUser: 'box',
      port: 50107,
      authToken: onSource.authToken!,
      expected: { fromMachineId: source.id, port: onSource.port, authToken: onSource.authToken },
    })
    expect(onTarget.machineId).toBe(target.id)
    expect(onTarget.syncedHashes).toEqual({})
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({})
  })

  // `onBound` exists so a caller can commit its own row in the SAME transaction
  // as the repoint — the forced-migration audit rides it, which is what makes
  // "the box moved but the audit still says 'started'" unrepresentable. Both
  // halves matter: the callback must see the repointed row through `tx`, and a
  // failing callback must take the repoint down with it.
  it('runs onBound inside the bind transaction, and a throwing onBound rolls the bind back', async () => {
    const machineA = await insertMachine(readyMachineValues('onbound-a'))
    const machineB = await insertMachine(readyMachineValues('onbound-b'))
    const sandboxId = `${prefix}-onbound`
    await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })

    let seen: { rowMachineId?: string; boxMachineId?: string } | undefined
    const bound = await bindMachineBox({
      sandboxId,
      machineId: machineB.id,
      unixUser: 'box',
      onBound: async (tx, box) => {
        const [row] = await tx.select().from(machineBoxes).where(eq(machineBoxes.sandboxId, sandboxId))
        seen = { rowMachineId: row?.machineId, boxMachineId: box.machineId }
      },
    })
    expect(bound.machineId).toBe(machineB.id)
    expect(seen).toEqual({ rowMachineId: machineB.id, boxMachineId: machineB.id })

    await expect(
      bindMachineBox({
        sandboxId,
        machineId: machineA.id,
        unixUser: 'box',
        onBound: async () => {
          throw new Error('audit settlement failed')
        },
      })
    ).rejects.toThrow('audit settlement failed')
    // The repoint back to machineA never committed.
    expect((await getMachineBox(sandboxId))?.machineId).toBe(machineB.id)
  })

  it('binds an EXPLICIT port + candidate token (migrate repoint) instead of allocating', async () => {
    const machineA = await insertMachine(readyMachineValues('explicit-a'))
    const machineB = await insertMachine(readyMachineValues('explicit-b'))
    const sandboxId = `${prefix}-explicit`

    const onA = await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })
    expect(onA.port).toBe(50100)
    expect(onA.authToken).toBeTruthy()

    // Repoint to machineB at the port the migrate pre-provisioned there. The
    // explicit port wins over the MAX(port)+1 allocation; the persisted token
    // survives (COALESCE — the candidate never overwrites an existing token).
    const onB = await bindMachineBox({
      sandboxId,
      machineId: machineB.id,
      unixUser: 'box',
      port: 50107,
      authToken: 'candidate-token-should-lose',
    })
    expect(onB.machineId).toBe(machineB.id)
    expect(onB.port).toBe(50107)
    expect(onB.authToken).toBe(onA.authToken)
  })

  // Conditional (compare-and-swap) bind: the migrate repoint passes `expected`
  // — the pre-state the row must still hold — so a concurrent ensure/bind that
  // mutated the row in the provision window makes the repoint THROW and roll
  // back instead of committing a row that disagrees with the box the migrate
  // just provisioned (which would repoint onto a box about to be torn down, or
  // carry a token the new unit rejects — data loss / permanent 401 either way).
  it('conditional bind (expected pre-state matches): repoints exactly like an unconditional bind', async () => {
    const machineA = await insertMachine(readyMachineValues('cas-ok-a'))
    const machineB = await insertMachine(readyMachineValues('cas-ok-b'))
    const sandboxId = `${prefix}-cas-ok`

    const onA = await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })

    const onB = await bindMachineBox({
      sandboxId,
      machineId: machineB.id,
      unixUser: 'box',
      port: 50107,
      authToken: onA.authToken!,
      expected: { fromMachineId: machineA.id, port: onA.port, authToken: onA.authToken },
    })
    expect(onB.machineId).toBe(machineB.id)
    expect(onB.port).toBe(50107)
    expect(onB.authToken).toBe(onA.authToken)
  })

  it('conditional bind: throws BoxBindConflictError and rolls back when the row moved to another machine', async () => {
    const machineA = await insertMachine(readyMachineValues('cas-m-a'))
    const machineB = await insertMachine(readyMachineValues('cas-m-b'))
    const machineC = await insertMachine(readyMachineValues('cas-m-c'))
    const sandboxId = `${prefix}-cas-m`

    const onA = await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })
    // A concurrent path repointed the row onto machineC after the migrate
    // snapshotted machineA as the source.
    const onC = await bindMachineBox({ sandboxId, machineId: machineC.id, unixUser: 'box' })

    await expect(
      bindMachineBox({
        sandboxId,
        machineId: machineB.id,
        unixUser: 'box',
        port: 50107,
        authToken: onA.authToken!,
        expected: { fromMachineId: machineA.id, port: onA.port, authToken: onA.authToken },
      })
    ).rejects.toThrow(BoxBindConflictError)

    // Rolled back: the row still points wherever it pointed before (machineC).
    const row = await getMachineBox(sandboxId)
    expect(row?.machineId).toBe(machineC.id)
    expect(row?.port).toBe(onC.port)
    expect(row?.authToken).toBe(onA.authToken)
  })

  it('conditional bind: throws and rolls back when the row token drifted (concurrent ensure minted one)', async () => {
    const machineA = await insertMachine(readyMachineValues('cas-t-a'))
    const machineB = await insertMachine(readyMachineValues('cas-t-b'))
    const sandboxId = `${prefix}-cas-t`

    const onA = await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })
    // Simulate a concurrent full ensure having persisted a DIFFERENT token.
    await db.update(machineBoxes).set({ authToken: 'tok-concurrent' }).where(eq(machineBoxes.sandboxId, sandboxId))

    await expect(
      bindMachineBox({
        sandboxId,
        machineId: machineB.id,
        unixUser: 'box',
        port: 50107,
        authToken: onA.authToken!,
        expected: { fromMachineId: machineA.id, port: onA.port, authToken: onA.authToken },
      })
    ).rejects.toThrow(BoxBindConflictError)

    const row = await getMachineBox(sandboxId)
    expect(row?.machineId).toBe(machineA.id) // untouched
    expect(row?.authToken).toBe('tok-concurrent')
  })

  it('conditional bind: throws and rolls back when the row port drifted', async () => {
    const machineA = await insertMachine(readyMachineValues('cas-p-a'))
    const machineB = await insertMachine(readyMachineValues('cas-p-b'))
    const sandboxId = `${prefix}-cas-p`

    const onA = await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })
    await db.update(machineBoxes).set({ port: 50990 }).where(eq(machineBoxes.sandboxId, sandboxId))

    await expect(
      bindMachineBox({
        sandboxId,
        machineId: machineB.id,
        unixUser: 'box',
        port: 50107,
        authToken: onA.authToken!,
        expected: { fromMachineId: machineA.id, port: onA.port, authToken: onA.authToken },
      })
    ).rejects.toThrow(BoxBindConflictError)

    const row = await getMachineBox(sandboxId)
    expect(row?.machineId).toBe(machineA.id)
    expect(row?.port).toBe(50990)
  })

  it('conditional bind: throws when the row is absent (concurrent removeBox) and creates NOTHING', async () => {
    const machineB = await insertMachine(readyMachineValues('cas-gone-b'))
    const sandboxId = `${prefix}-cas-gone`

    await expect(
      bindMachineBox({
        sandboxId,
        machineId: machineB.id,
        unixUser: 'box',
        port: 50107,
        authToken: 'tok-x',
        expected: { fromMachineId: '00000000-0000-0000-0000-000000000000', port: 50100, authToken: 'tok-x' },
      })
    ).rejects.toThrow(BoxBindConflictError)

    // An unconditional bind would have INSERTED a fresh row; the conditional
    // bind must not resurrect a box a concurrent remove just deleted.
    expect(await getMachineBox(sandboxId)).toBeNull()
  })

  it('conditional bind: a null expected token matches a legacy token-less row (candidate token lands)', async () => {
    const machineA = await insertMachine(readyMachineValues('cas-null-a'))
    const machineB = await insertMachine(readyMachineValues('cas-null-b'))
    const sandboxId = `${prefix}-cas-null`

    // Legacy row: seeded via upsert (no token minted).
    await upsertMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box', port: 50100 })

    const onB = await bindMachineBox({
      sandboxId,
      machineId: machineB.id,
      unixUser: 'box',
      port: 50107,
      authToken: 'tok-minted-by-migrate',
      expected: { fromMachineId: machineA.id, port: 50100, authToken: null },
    })
    expect(onB.machineId).toBe(machineB.id)
    expect(onB.port).toBe(50107)
    expect(onB.authToken).toBe('tok-minted-by-migrate')
  })

  it('uses the candidate token on a FRESH bind (legacy token-less migrate)', async () => {
    const machine = await insertMachine(readyMachineValues('candidate'))

    const box = await bindMachineBox({
      sandboxId: `${prefix}-cand`,
      machineId: machine.id,
      unixUser: 'box',
      authToken: 'tok-carried',
    })
    expect(box.authToken).toBe('tok-carried')
  })

  it('peekNextBoxPort mirrors the bind allocation without reserving', async () => {
    const machine = await insertMachine(readyMachineValues('peek'))

    expect(await peekNextBoxPort(machine.id)).toBe(50100)
    await bindMachineBox({ sandboxId: `${prefix}-peek1`, machineId: machine.id, unixUser: 'box' })
    expect(await peekNextBoxPort(machine.id)).toBe(50101)
  })

  it('throws when the machine does not exist', async () => {
    await expect(
      bindMachineBox({
        sandboxId: `${prefix}-nomachine`,
        machineId: '00000000-0000-0000-0000-000000000000',
        unixUser: 'box',
      })
    ).rejects.toThrow('machine not found')
  })

  it('serializes 5 concurrent binds on one machine into 5 distinct ports', async () => {
    const machine = await insertMachine(readyMachineValues('concurrent'))

    const boxes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        bindMachineBox({ sandboxId: `${prefix}-conc-${i}`, machineId: machine.id, unixUser: `box${i}` })
      )
    )

    const ports = boxes.map((b) => b.port).sort((a, b) => a - b)
    expect(new Set(ports).size).toBe(5) // all distinct
    expect(ports).toEqual([50100, 50101, 50102, 50103, 50104])
  })

  it('rejects a direct insert that violates (machine_id, port) uniqueness', async () => {
    const machine = await insertMachine(machineValues('unique'))
    await upsertMachineBox({ sandboxId: `${prefix}-uq1`, machineId: machine.id, unixUser: 'box', port: 50100 })

    await expect(
      (async () =>
        db
          .insert(machineBoxes)
          .values({ sandboxId: `${prefix}-uq2`, machineId: machine.id, unixUser: 'box2', port: 50100 }))()
    ).rejects.toThrow()
  })

  it('upserts / gets / lists / deletes boxes and updates on conflict', async () => {
    const machine = await insertMachine(machineValues('boxes'))
    const sandboxId = `${prefix}-sb-up`

    const created = await upsertMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box', port: 50100 })
    expect(created.sandboxId).toBe(sandboxId)
    expect(created.status).toBe('ensuring')
    expect(created.updatedAt).toBeInstanceOf(Date)

    // Upsert on same primary key updates in place.
    const updated = await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: 'box',
      port: 50100,
      status: 'ready',
    })
    expect(updated.status).toBe('ready')

    const got = await getMachineBox(sandboxId)
    expect(got?.status).toBe('ready')

    await upsertMachineBox({ sandboxId: `${prefix}-sb-up2`, machineId: machine.id, unixUser: 'box2', port: 50101 })
    const boxes = await listMachineBoxes(machine.id)
    expect(boxes.length).toBe(2)

    await deleteMachineBox(sandboxId)
    expect(await getMachineBox(sandboxId)).toBeNull()
    expect((await listMachineBoxes(machine.id)).length).toBe(1)
  })

  it('preserves the persisted auth token across token-less upserts (status flips, activity seeds)', async () => {
    const machine = await insertMachine(readyMachineValues('token'))
    const sandboxId = `${prefix}-sb-tok`

    // First provision persists the minted token.
    const created = await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: 'box',
      port: 50100,
      authToken: 'tok-1',
    })
    expect(created.authToken).toBe('tok-1')

    // A token-less upsert (e.g. stopBox's status flip) must NOT null it out.
    const stopped = await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: 'box',
      port: 50100,
      status: 'stopped',
    })
    expect(stopped.status).toBe('stopped')
    expect(stopped.authToken).toBe('tok-1')

    // bindMachineBox mints a candidate token but the COALESCE keeps the
    // persisted one — a pre-existing token is never overwritten.
    const rebound = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    expect(rebound.authToken).toBe('tok-1')
  })

  it('preserves the persisted provisionedSpecHash across upserts that omit it (status flips, activity seeds)', async () => {
    const machine = await insertMachine(readyMachineValues('spechash'))
    const sandboxId = `${prefix}-sb-spechash`

    // A full provision stamps the marker alongside the 'ready' upsert.
    const ready = await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: 'box',
      port: 50100,
      status: 'ready',
      provisionedSpecHash: 'marker-1',
    })
    expect(ready.provisionedSpecHash).toBe('marker-1')

    // Parking (stopBox's status flip) carries no provisionedSpecHash — must
    // NOT null it out, or the very next resume would always miss the fast
    // path (the whole point of the marker surviving a park/resume cycle).
    const stopped = await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: 'box',
      port: 50100,
      status: 'stopped',
    })
    expect(stopped.status).toBe('stopped')
    expect(stopped.provisionedSpecHash).toBe('marker-1')

    // The resume fast path's own 'ready' stamp also omits it (unchanged from
    // the prior full provision) — still preserved.
    const resumed = await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: 'box',
      port: 50100,
      status: 'ready',
    })
    expect(resumed.provisionedSpecHash).toBe('marker-1')

    // A NEW full (re)provision explicitly overwrites it with the fresh marker.
    const reprovisioned = await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: 'box',
      port: 50100,
      status: 'ready',
      provisionedSpecHash: 'marker-2',
    })
    expect(reprovisioned.provisionedSpecHash).toBe('marker-2')
  })

  it('mints the auth token atomically in the bind — first writer wins, every bind returns the persisted token', async () => {
    const machine = await insertMachine(readyMachineValues('token-mint'))
    const sandboxId = `${prefix}-sb-mint`

    // A brand-new bind mints a 32-byte hex token right in the bind upsert.
    const first = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    expect(first.authToken).toMatch(/^[0-9a-f]{64}$/)

    // A second bind (e.g. a concurrent full ensure from the other core process)
    // generates a DIFFERENT candidate, but COALESCE keeps the first persisted
    // token — both callers observe the same value and push identical
    // server.envs, so the row can never disagree with the enforcing server.
    const second = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    expect(second.authToken).toBe(first.authToken)

    // The row holds exactly that one token.
    const row = await getMachineBox(sandboxId)
    expect(row?.authToken).toBe(first.authToken)
  })

  it('keeps one token across concurrent binds of the same brand-new sandbox', async () => {
    const machine = await insertMachine(readyMachineValues('token-race'))
    const sandboxId = `${prefix}-sb-race`

    // The two-concurrent-full-ensures shape (api + worker on a null-token box).
    // Same machine → the machine row lock serializes them; the sandbox_id
    // conflict is the row-level backstop. Either way: ONE token, both see it.
    const [a, b] = await Promise.all([
      bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' }),
      bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' }),
    ])
    expect(a.authToken).toMatch(/^[0-9a-f]{64}$/)
    expect(b.authToken).toBe(a.authToken)
    expect((await getMachineBox(sandboxId))?.authToken).toBe(a.authToken)
  })

  it('queryReadySharedMachineLoads aggregates box sandboxIds per ready shared machine', async () => {
    // Ready+shared with two boxes, ready+shared with none, and three excluded
    // rows (not ready / dedicated scope / squad purpose).
    const loaded = await insertMachine({ ...machineValues('loads-a'), status: 'ready' })
    await upsertMachineBox({ sandboxId: `${prefix}-la-1`, machineId: loaded.id, unixUser: 'b1', port: 50100 })
    await upsertMachineBox({ sandboxId: `${prefix}-la-2`, machineId: loaded.id, unixUser: 'b2', port: 50101 })
    const empty = await insertMachine({ ...machineValues('loads-b'), status: 'ready' })
    await insertMachine({ ...machineValues('loads-registered'), status: 'registered' })
    await insertMachine({ ...machineValues('loads-dedicated'), status: 'ready', scope: 'dedicated' })
    await insertMachine({ ...machineValues('loads-squad'), status: 'ready', purpose: 'squad', squadId: 'sq-1' })

    const rows = (await queryReadySharedMachineLoads()).filter((r) => r.machine.name.startsWith(prefix))
    expect(rows.map((r) => r.machine.id).sort()).toEqual([loaded.id, empty.id].sort())

    const byId = new Map(rows.map((r) => [r.machine.id, r.boxSandboxIds]))
    expect(byId.get(loaded.id)?.sort()).toEqual([`${prefix}-la-1`, `${prefix}-la-2`])
    expect(byId.get(empty.id)).toEqual([])
  })

  it('maintains empty_since: stamped on LAST-box delete, cleared on bind (the reaper clock)', async () => {
    const machine = await insertMachine(readyMachineValues('empty-since'))
    // Fresh machine: never drained → null (a just-provisioned VM is reap-exempt).
    expect(machine.emptySince).toBeNull()

    await bindMachineBox({ sandboxId: `${prefix}-es1`, machineId: machine.id, unixUser: 'b1' })
    expect((await getMachine(machine.id))?.emptySince).toBeNull()
    await bindMachineBox({ sandboxId: `${prefix}-es2`, machineId: machine.id, unixUser: 'b2' })

    // Deleting a box while another remains does NOT start the idle clock.
    await deleteMachineBox(`${prefix}-es1`)
    expect((await getMachine(machine.id))?.emptySince).toBeNull()

    // Deleting the LAST box stamps it.
    const before = Date.now()
    await deleteMachineBox(`${prefix}-es2`)
    const stamped = (await getMachine(machine.id))?.emptySince
    expect(stamped).toBeInstanceOf(Date)
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(before - 1_000) // clock slack

    // A box binding onto the drained machine clears the marker — this is what
    // saves an empty-but-within-grace machine a placement just packed onto.
    await bindMachineBox({ sandboxId: `${prefix}-es3`, machineId: machine.id, unixUser: 'b3' })
    expect((await getMachine(machine.id))?.emptySince).toBeNull()
  })

  it('deleteMachineBox no-ops for an absent box (no empty_since stamp)', async () => {
    const machine = await insertMachine(machineValues('empty-noop'))
    await deleteMachineBox(`${prefix}-does-not-exist`)
    expect((await getMachine(machine.id))?.emptySince).toBeNull()
  })

  it('cascades box deletion when the machine is deleted', async () => {
    const machine = await insertMachine(machineValues('cascade'))
    await upsertMachineBox({ sandboxId: `${prefix}-casc`, machineId: machine.id, unixUser: 'box', port: 50100 })
    expect(await getMachineBox(`${prefix}-casc`)).not.toBeNull()

    await deleteMachine(machine.id)

    const [row] = await db
      .select()
      .from(machineBoxes)
      .where(eq(machineBoxes.sandboxId, `${prefix}-casc`))
    expect(row).toBeUndefined()
  })

  it('deleteMachineBox after a rebind removes the row from the NEW machine and stamps it', async () => {
    // Repoint then delete: the machine-id-qualified delete must target the row
    // where it lives NOW (machineB), not where it was first bound (machineA).
    const machineA = await insertMachine(readyMachineValues('del-repoint-a'))
    const machineB = await insertMachine(readyMachineValues('del-repoint-b'))
    const sandboxId = `${prefix}-del-repoint`

    await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })
    await bindMachineBox({ sandboxId, machineId: machineB.id, unixUser: 'box' })
    await deleteMachineBox(sandboxId)

    expect(await getMachineBox(sandboxId)).toBeNull()
    // machineB lost its last box → stamped; machineA (drained by the repoint,
    // not by this delete) is the reaper stamp pass's job, not deleteMachineBox's.
    expect((await getMachine(machineB.id))?.emptySince).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// Empty-machine reaper primitives: bind rejection, claim, restore, stamp
// ---------------------------------------------------------------------------

describe('machine box spec hash persistence', () => {
  it('round-trips both provision hashes and preserves the reconcilable hash on status-only upsert', async () => {
    const machine = await insertMachine(readyMachineValues('spec-hash-persistence'))
    const sandboxId = `${prefix}-spec-hash-persistence`
    const bound = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })

    await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: bound.unixUser,
      port: bound.port,
      status: 'ready',
      provisionedSpecHash: 'environment-sensitive-marker',
      reconcilableSpecHash: 'bare-reconcilable-hash',
    })
    expect(await getMachineBox(sandboxId)).toMatchObject({
      provisionedSpecHash: 'environment-sensitive-marker',
      reconcilableSpecHash: 'bare-reconcilable-hash',
    })

    await upsertMachineBox({
      sandboxId,
      machineId: machine.id,
      unixUser: bound.unixUser,
      port: bound.port,
      status: 'stopped',
    })
    expect(await getMachineBox(sandboxId)).toMatchObject({
      status: 'stopped',
      provisionedSpecHash: 'environment-sensitive-marker',
      reconcilableSpecHash: 'bare-reconcilable-hash',
    })
  })
})

describe('reaping claim primitives', () => {
  const eligibleAlways = () => true

  it('bindMachineBox rejects a reaping machine with MachineNotReadyError (no row, marker untouched)', async () => {
    const machine = await insertMachine({
      ...readyMachineValues('bind-reaping'),
      status: 'reaping',
      emptySince: new Date(Date.now() - 60_000),
    })
    await expect(
      bindMachineBox({ sandboxId: `${prefix}-br`, machineId: machine.id, unixUser: 'box' })
    ).rejects.toBeInstanceOf(MachineNotReadyError)
    // The rejected bind must not have inserted a row or cleared the idle marker.
    expect(await getMachineBox(`${prefix}-br`)).toBeNull()
    expect((await getMachine(machine.id))?.emptySince).toBeInstanceOf(Date)
  })

  it('bindMachineBox rejects any non-ready machine (registered/unreachable)', async () => {
    const registered = await insertMachine(machineValues('bind-registered'))
    await expect(
      bindMachineBox({ sandboxId: `${prefix}-breg`, machineId: registered.id, unixUser: 'box' })
    ).rejects.toBeInstanceOf(MachineNotReadyError)

    const unreachable = await insertMachine({ ...machineValues('bind-unreachable'), status: 'unreachable' })
    await expect(
      bindMachineBox({ sandboxId: `${prefix}-bun`, machineId: unreachable.id, unixUser: 'box' })
    ).rejects.toBeInstanceOf(MachineNotReadyError)
  })

  it('claims an empty ready machine (status flips to reaping)', async () => {
    const machine = await insertMachine(readyMachineValues('claim-ok'))
    expect(await claimMachineForReaping(machine.id, eligibleAlways)).toBe(true)
    expect((await getMachine(machine.id))?.status).toBe('reaping')
  })

  it('refuses the claim when the machine hosts a box (a bind landed first)', async () => {
    const machine = await insertMachine(readyMachineValues('claim-boxed'))
    await bindMachineBox({ sandboxId: `${prefix}-cb`, machineId: machine.id, unixUser: 'box' })
    expect(await claimMachineForReaping(machine.id, eligibleAlways)).toBe(false)
    expect((await getMachine(machine.id))?.status).toBe('ready')
  })

  it('refuses the claim when the in-txn eligibility re-check rejects the locked row', async () => {
    const machine = await insertMachine(readyMachineValues('claim-inelig'))
    expect(await claimMachineForReaping(machine.id, () => false)).toBe(false)
    expect((await getMachine(machine.id))?.status).toBe('ready')
  })

  it('refuses the claim for a missing machine', async () => {
    expect(await claimMachineForReaping('00000000-0000-0000-0000-000000000000', eligibleAlways)).toBe(false)
  })

  it('claim after bind loses; bind after claim rejects — no interleaving terminates a live box', async () => {
    // Order 1: bind commits first → the claim's in-txn count sees the box.
    const first = await insertMachine(readyMachineValues('race-bind-first'))
    await bindMachineBox({ sandboxId: `${prefix}-r1`, machineId: first.id, unixUser: 'box' })
    expect(await claimMachineForReaping(first.id, eligibleAlways)).toBe(false)

    // Order 2: claim commits first → the bind sees 'reaping' and throws.
    const second = await insertMachine(readyMachineValues('race-claim-first'))
    expect(await claimMachineForReaping(second.id, eligibleAlways)).toBe(true)
    await expect(
      bindMachineBox({ sandboxId: `${prefix}-r2`, machineId: second.id, unixUser: 'box' })
    ).rejects.toBeInstanceOf(MachineNotReadyError)
  })

  it('a genuinely concurrent bind and claim never BOTH succeed', async () => {
    // Fire both at once repeatedly; whatever the interleaving, the invariant is
    // XOR: a claimed (terminable) machine has no box, a boxed machine is unclaimed.
    for (let i = 0; i < 5; i++) {
      const machine = await insertMachine(readyMachineValues(`race-conc-${i}`))
      const [claimRes, bindRes] = await Promise.allSettled([
        claimMachineForReaping(machine.id, eligibleAlways),
        bindMachineBox({ sandboxId: `${prefix}-rc-${i}`, machineId: machine.id, unixUser: 'box' }),
      ])
      const claimed = claimRes.status === 'fulfilled' && claimRes.value === true
      const bound = bindRes.status === 'fulfilled'
      expect(claimed !== bound).toBe(true) // exactly one wins
      const boxes = await listMachineBoxes(machine.id)
      if (claimed) {
        expect(boxes.length).toBe(0) // never terminate-with-live-box
        expect((await getMachine(machine.id))?.status).toBe('reaping')
      } else {
        expect(boxes.length).toBe(1)
        expect((await getMachine(machine.id))?.status).toBe('ready')
      }
    }
  })

  it('restoreMachineFromReaping restores only from reaping', async () => {
    const machine = await insertMachine(readyMachineValues('restore'))
    await claimMachineForReaping(machine.id, eligibleAlways)
    await restoreMachineFromReaping(machine.id)
    expect((await getMachine(machine.id))?.status).toBe('ready')

    // Conditional: never clobbers a status someone else set meanwhile.
    await updateMachine(machine.id, { status: 'parked' })
    await restoreMachineFromReaping(machine.id)
    expect((await getMachine(machine.id))?.status).toBe('parked')
  })

  it('stampMachineEmptySinceIfDrained stamps only a ready, unmarked, zero-box machine', async () => {
    const at = new Date('2026-01-01T00:00:00Z')

    // Drained + unmarked + ready → stamped.
    const drained = await insertMachine(readyMachineValues('stamp-ok'))
    expect(await stampMachineEmptySinceIfDrained(drained.id, at)).toBe(true)
    expect((await getMachine(drained.id))?.emptySince?.getTime()).toBe(at.getTime())

    // Already marked → left alone (never resets an older clock).
    expect(await stampMachineEmptySinceIfDrained(drained.id, new Date())).toBe(false)
    expect((await getMachine(drained.id))?.emptySince?.getTime()).toBe(at.getTime())

    // Hosting a box → not stamped.
    const boxed = await insertMachine(readyMachineValues('stamp-boxed'))
    await bindMachineBox({ sandboxId: `${prefix}-st`, machineId: boxed.id, unixUser: 'box' })
    expect(await stampMachineEmptySinceIfDrained(boxed.id, at)).toBe(false)
    expect((await getMachine(boxed.id))?.emptySince).toBeNull()

    // Not ready → not stamped (bootstrapping/parked machines keep a null clock).
    const parked = await insertMachine({ ...machineValues('stamp-parked'), status: 'parked' })
    expect(await stampMachineEmptySinceIfDrained(parked.id, at)).toBe(false)
    expect((await getMachine(parked.id))?.emptySince).toBeNull()

    // Missing machine → false.
    expect(await stampMachineEmptySinceIfDrained('00000000-0000-0000-0000-000000000000', at)).toBe(false)
  })

  it('a repoint drain leaves the old machine unmarked (the leak the reaper stamp pass repairs)', async () => {
    // Documents Finding 2a's precondition: bindMachineBox's onConflictDoUpdate
    // repoints the row off machineA with no deleteMachineBox, so machineA ends
    // zero-box with empty_since null — invisible to the grace clock until the
    // reaper's stamp pass starts it.
    const machineA = await insertMachine(readyMachineValues('repoint-old'))
    const machineB = await insertMachine(readyMachineValues('repoint-new'))
    const sandboxId = `${prefix}-rp`

    await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })
    await bindMachineBox({ sandboxId, machineId: machineB.id, unixUser: 'box' })

    expect((await listMachineBoxes(machineA.id)).length).toBe(0)
    expect((await getMachine(machineA.id))?.emptySince).toBeNull()

    // The stamp pass primitive converts that leak into a ticking clock.
    expect(await stampMachineEmptySinceIfDrained(machineA.id, new Date())).toBe(true)
    expect((await getMachine(machineA.id))?.emptySince).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// Migration fence primitives: fence (set-then-recheck), clear, read
// ---------------------------------------------------------------------------

describe('forced audit recovery races', () => {
  async function setupRace(label: string) {
    const squadId = crypto.randomUUID()
    const sandboxId = `squad_${squadId}`
    const requestId = crypto.randomUUID()
    const source = await insertMachine(readyMachineValues(`${label}-source`))
    const target = await insertMachine(readyMachineValues(`${label}-target`))
    await db.insert(squads).values({ id: squadId, name: `${prefix}-${label}`, purpose: 'test' })
    await bindMachineBox({ sandboxId, machineId: source.id, unixUser: `box_${label}` })
    const audit = await startForceMigrationAudit({
      requestId,
      actor: { type: 'user', id: crypto.randomUUID() },
      reason: 'recovery race',
      sandboxId,
      squadId,
      sourceMachineId: source.id,
      targetMachineId: target.id,
      activeExecutionCount: 0,
    })
    return { audit, requestId, sandboxId, source, squadId, target }
  }

  it('rolls back the box repoint when recovery settles cancellation first', async () => {
    const race = await setupRace('recovery-wins')
    expect(await cancelInterruptedForceMigrationAudits()).toBeGreaterThanOrEqual(1)
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(machineBoxes)
          .set({ machineId: race.target.id })
          .where(eq(machineBoxes.sandboxId, race.sandboxId))
        requireForceMigrationSettlement(
          await finishForceMigrationAuditInTransaction(tx, race.audit.id, { moved: true })
        )
      })
    ).rejects.toThrow('settlement conflict')
    expect((await getMachineBox(race.sandboxId))!.machineId).toBe(race.source.id)
    const [stored] = await db
      .select()
      .from(forcedBoxMigrationAudits)
      .where(eq(forcedBoxMigrationAudits.id, race.audit.id))
    expect(stored).toMatchObject({
      outcome: 'canceled',
      failureCode: 'api-restart',
      result: { moved: false, reason: 'failed' },
    })
  })

  it('preserves committed success when recovery waits behind its terminal lock', async () => {
    const race = await setupRace('success-wins')
    let locked!: () => void
    let release!: () => void
    const lockedPromise = new Promise<void>((resolve) => (locked = resolve))
    const releasePromise = new Promise<void>((resolve) => (release = resolve))
    const success = db.transaction(async (tx) => {
      await tx.update(machineBoxes).set({ machineId: race.target.id }).where(eq(machineBoxes.sandboxId, race.sandboxId))
      requireForceMigrationSettlement(await finishForceMigrationAuditInTransaction(tx, race.audit.id, { moved: true }))
      locked()
      await releasePromise
    })
    await lockedPromise
    const recovery = cancelInterruptedForceMigrationAudits()
    release()
    await success
    expect(await recovery).toBe(0)
    expect((await getMachineBox(race.sandboxId))!.machineId).toBe(race.target.id)
    const [stored] = await db
      .select()
      .from(forcedBoxMigrationAudits)
      .where(eq(forcedBoxMigrationAudits.id, race.audit.id))
    expect(stored).toMatchObject({ outcome: 'succeeded', result: { moved: true } })
    await db.delete(squads).where(eq(squads.id, race.squadId))
  })
})

describe('box migrating fence', () => {
  it('uses one max-one pool connection for the fence activity and forced audit', async () => {
    const client = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
    const tinyDb = drizzle(client, { schema })
    const squadId = crypto.randomUUID()
    const sandboxId = `squad_${squadId}`
    const requestId = crypto.randomUUID()
    const machine = await insertMachine(readyMachineValues('single-connection'))
    await db.insert(squads).values({ id: squadId, name: `${prefix}-single-connection`, purpose: 'test' })
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box_single_connection' })
    try {
      const claimed = await fenceBoxForMigration(
        sandboxId,
        async (id, tx) => {
          const activity = await sandboxActivity(id, tx!)
          await startForceMigrationAudit(
            {
              requestId,
              actor: { type: 'user', id: crypto.randomUUID() },
              reason: 'single connection regression',
              sandboxId: id,
              squadId,
              sourceMachineId: machine.id,
              targetMachineId: crypto.randomUUID(),
              activeExecutionCount: activity.activeExecutionCount!,
            },
            tx!
          )
          return true
        },
        tinyDb
      )
      expect(claimed).toBe(false)
      expect(
        (await tinyDb.select().from(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.requestId, requestId)))
          .length
      ).toBe(1)
    } finally {
      await db.delete(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.requestId, requestId))
      await db.delete(squads).where(eq(squads.id, squadId))
      await client.end()
    }
  }, 5_000)

  // The max-one-pool test above cannot tell a probe that used `tx` from one
  // that reached for the global pool (a second pool has spare connections and
  // the audit table takes no conflicting lock). Uncommitted-row visibility can:
  // rows written on the fence transaction are visible ONLY to statements that
  // share it, and they vanish when it rolls back.
  it('runs the fence activity probe and the forced audit ON the fence transaction', async () => {
    const squadId = crypto.randomUUID()
    const sandboxId = `squad_${squadId}`
    const requestId = crypto.randomUUID()
    const agentId = crypto.randomUUID()
    const machine = await insertMachine(readyMachineValues('same-transaction'))
    await db.insert(squads).values({ id: squadId, name: `${prefix}-same-transaction`, purpose: 'test' })
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box_same_transaction' })
    const rollback = new Error('roll the fence transaction back')
    let observed: number | undefined
    try {
      await expect(
        fenceBoxForMigration(sandboxId, async (id, tx) => {
          // Written on the fence txn, never committed.
          await tx!.insert(agents).values({ id: agentId, agentTypeId: 'engineer', squadId })
          await tx!.insert(executions).values({ agentId, status: 'running' })
          observed = (await sandboxActivity(id, tx!)).activeExecutionCount
          await startForceMigrationAudit(
            {
              requestId,
              actor: { type: 'user', id: crypto.randomUUID() },
              reason: 'same transaction regression',
              sandboxId: id,
              squadId,
              sourceMachineId: machine.id,
              targetMachineId: crypto.randomUUID(),
              activeExecutionCount: observed!,
            },
            tx!
          )
          throw rollback
        })
      ).rejects.toBe(rollback)
      // Off-transaction, this execution does not exist yet — so a count of 1
      // proves the activity query ran on the fence's own connection.
      expect(observed).toBe(1)
      // Same for the audit: it rolled back with the fence rather than
      // surviving on a second connection as a phantom `started` record.
      expect(await findForceMigrationAudit(requestId)).toBeNull()
      expect(await db.select().from(executions).where(eq(executions.agentId, agentId))).toEqual([])
    } finally {
      await db.delete(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.requestId, requestId))
      await db.delete(agents).where(eq(agents.id, agentId))
      await db.delete(squads).where(eq(squads.id, squadId))
    }
  }, 10_000)

  it('fenceBoxForMigration fences an idle box (returns true, row migrating=true)', async () => {
    const machine = await insertMachine(readyMachineValues('fence-ok'))
    const sandboxId = `${prefix}-fence-ok`
    const box = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    // New boxes are born unfenced.
    expect(box.migrating).toBe(false)
    expect(await isBoxMigrating(sandboxId)).toBe(false)

    expect(await fenceBoxForMigration(sandboxId, async () => false)).toBe(true)
    expect((await getMachineBox(sandboxId))?.migrating).toBe(true)
    expect(await isBoxMigrating(sandboxId)).toBe(true)
  })

  it('owner-scoped fences are adoptable and cannot be cleared by another owner', async () => {
    const machine = await insertMachine(readyMachineValues('fence-owner'))
    const sandboxId = `${prefix}-fence-owner`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })

    await db
      .insert(instanceMaintenanceState)
      .values({
        id: 'global',
        platformLeaseId: '00000000-0000-4000-8000-000000000101',
        platformLeaseOwnerTokenId: '00000000-0000-4000-8000-000000000201',
        platformLeaseHolder: 'test',
        platformLeaseAcquiredAt: new Date(),
        platformLeaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .onConflictDoUpdate({
        target: instanceMaintenanceState.id,
        set: {
          platformLeaseId: '00000000-0000-4000-8000-000000000101',
          platformLeaseOwnerTokenId: '00000000-0000-4000-8000-000000000201',
          platformLeaseHolder: 'test',
          platformLeaseAcquiredAt: new Date(),
          platformLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      })
    expect(await fenceBoxForMigration(sandboxId, async () => false, db, '00000000-0000-4000-8000-000000000101')).toBe(
      true
    )
    await db
      .insert(instanceMaintenanceState)
      .values({
        id: 'global',
        platformLeaseId: '00000000-0000-4000-8000-000000000101',
        platformLeaseOwnerTokenId: '00000000-0000-4000-8000-000000000201',
        platformLeaseHolder: 'test',
        platformLeaseAcquiredAt: new Date(),
        platformLeaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .onConflictDoUpdate({
        target: instanceMaintenanceState.id,
        set: {
          platformLeaseId: '00000000-0000-4000-8000-000000000101',
          platformLeaseOwnerTokenId: '00000000-0000-4000-8000-000000000201',
          platformLeaseHolder: 'test',
          platformLeaseAcquiredAt: new Date(),
          platformLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      })
    expect(await fenceBoxForMigration(sandboxId, async () => false, db, '00000000-0000-4000-8000-000000000101')).toBe(
      true
    )
    expect(await fenceBoxForMigration(sandboxId, async () => false, db, '00000000-0000-4000-8000-000000000102')).toBe(
      false
    )
    await clearBoxMigrating(sandboxId, '00000000-0000-4000-8000-000000000102')
    expect(await isBoxMigrating(sandboxId)).toBe(true)
    await clearBoxMigrating(sandboxId, '00000000-0000-4000-8000-000000000101')
    expect(await isBoxMigrating(sandboxId)).toBe(false)
  })

  it('fenceBoxForMigration backs off an active box (returns false, fence cleared)', async () => {
    const machine = await insertMachine(readyMachineValues('fence-active'))
    const sandboxId = `${prefix}-fence-active`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })

    // Set-then-recheck: the fence is SET before the activity check runs, so a
    // pickup racing this call either observes the fence via its locked read
    // (isBoxMigratingLocked, which waits on this txn's row lock) or commits its
    // execution first (which this recheck then observes). Active → back off.
    let sawFenceDuringCheck = false
    expect(
      await fenceBoxForMigration(sandboxId, async (id) => {
        expect(id).toBe(sandboxId)
        // The fence must already be visible (set BEFORE the recheck) within
        // the transaction; read through the txn-external isBoxMigrating is
        // not possible here, so assert via the callback ordering contract:
        sawFenceDuringCheck = true
        return true
      })
    ).toBe(false)
    expect(sawFenceDuringCheck).toBe(true)
    expect((await getMachineBox(sandboxId))?.migrating).toBe(false)
    expect(await isBoxMigrating(sandboxId)).toBe(false)
  })

  it('clearBoxMigrating lifts the fence', async () => {
    const machine = await insertMachine(readyMachineValues('fence-clear'))
    const sandboxId = `${prefix}-fence-clear`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })

    expect(await fenceBoxForMigration(sandboxId, async () => false)).toBe(true)
    expect(await isBoxMigrating(sandboxId)).toBe(true)

    await clearBoxMigrating(sandboxId)
    expect(await isBoxMigrating(sandboxId)).toBe(false)
    expect((await getMachineBox(sandboxId))?.migrating).toBe(false)
  })

  it('fenceBoxForMigration returns false for an absent box; isBoxMigrating false; clear no-ops', async () => {
    const sandboxId = `${prefix}-fence-none`
    expect(await fenceBoxForMigration(sandboxId, async () => false)).toBe(false)
    expect(await isBoxMigrating(sandboxId)).toBe(false)
    await clearBoxMigrating(sandboxId) // no throw
  })

  it('clearAllMigratingFences clears every set fence, returns the count, and is idempotent', async () => {
    const machine = await insertMachine(readyMachineValues('fence-boot'))
    const a = `${prefix}-fence-boot-a`
    const b = `${prefix}-fence-boot-b`
    const c = `${prefix}-fence-boot-c`
    await bindMachineBox({ sandboxId: a, machineId: machine.id, unixUser: 'box_a' })
    await bindMachineBox({ sandboxId: b, machineId: machine.id, unixUser: 'box_b' })
    await bindMachineBox({ sandboxId: c, machineId: machine.id, unixUser: 'box_c' })
    expect(await fenceBoxForMigration(a, async () => false)).toBe(true)
    expect(await fenceBoxForMigration(b, async () => false)).toBe(true)

    // The API-boot catch-all: both stale fences cleared, count reported.
    expect(await clearAllMigratingFences()).toBe(2)
    expect((await getMachineBox(a))?.migrating).toBe(false)
    expect((await getMachineBox(b))?.migrating).toBe(false)
    expect((await getMachineBox(c))?.migrating).toBe(false)

    // Idempotent / harmless when nothing is fenced (0 cleared, no rows touched).
    expect(await clearAllMigratingFences()).toBe(0)
  })

  it('boot recovery preserves crash-adoptable owner fences', async () => {
    const machine = await insertMachine(readyMachineValues('fence-owned-boot'))
    const sandboxId = `${prefix}-fence-owned-boot`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    await db
      .insert(instanceMaintenanceState)
      .values({
        id: 'global',
        platformLeaseId: '00000000-0000-4000-8000-000000000101',
        platformLeaseOwnerTokenId: '00000000-0000-4000-8000-000000000201',
        platformLeaseHolder: 'test',
        platformLeaseAcquiredAt: new Date(),
        platformLeaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .onConflictDoUpdate({
        target: instanceMaintenanceState.id,
        set: {
          platformLeaseId: '00000000-0000-4000-8000-000000000101',
          platformLeaseOwnerTokenId: '00000000-0000-4000-8000-000000000201',
          platformLeaseHolder: 'test',
          platformLeaseAcquiredAt: new Date(),
          platformLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      })
    expect(await fenceBoxForMigration(sandboxId, async () => false, db, '00000000-0000-4000-8000-000000000101')).toBe(
      true
    )
    expect(await clearAllMigratingFences()).toBe(0)
    expect((await getMachineBox(sandboxId))?.migrating).toBe(true)
    await clearBoxMigrating(sandboxId, '00000000-0000-4000-8000-000000000101')
  })

  it('a current successor lease adopts a stale owner fence after lease replacement', async () => {
    const machine = await insertMachine(readyMachineValues('fence-successor'))
    const sandboxId = `${prefix}-fence-successor`
    const oldLease = '00000000-0000-4000-8000-000000000111'
    const successorLease = '00000000-0000-4000-8000-000000000112'
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    const setLease = async (leaseId: string) =>
      db
        .insert(instanceMaintenanceState)
        .values({
          id: 'global',
          platformLeaseId: leaseId,
          platformLeaseOwnerTokenId: '00000000-0000-4000-8000-000000000211',
          platformLeaseHolder: 'test',
          platformLeaseAcquiredAt: new Date(),
          platformLeaseExpiresAt: new Date(Date.now() + 60_000),
        })
        .onConflictDoUpdate({
          target: instanceMaintenanceState.id,
          set: {
            platformLeaseId: leaseId,
            platformLeaseOwnerTokenId: '00000000-0000-4000-8000-000000000211',
            platformLeaseHolder: 'test',
            platformLeaseAcquiredAt: new Date(),
            platformLeaseExpiresAt: new Date(Date.now() + 60_000),
          },
        })
    await setLease(oldLease)
    expect(await fenceBoxForMigration(sandboxId, async () => false, db, oldLease)).toBe(true)
    await setLease(successorLease)
    expect(await fenceBoxForMigration(sandboxId, async () => false, db, successorLease)).toBe(true)
    expect((await getMachineBox(sandboxId))?.migrationOwner).toBe(successorLease)
    await clearBoxMigrating(sandboxId, successorLease)
  })

  it('recoverMigrationFencesOnce is memoized: a fence claimed after recovery is LIVE and never cleared by later calls', async () => {
    // The clear-all behavior itself is pinned above; this pins the ONCE-ness —
    // the property that makes awaiting the barrier on every migrate/rebalance
    // request safe. (No first-caller assumption: another test in this process
    // may already have consumed the one recovery, which is exactly the point.)
    const machine = await insertMachine(readyMachineValues('fence-once'))
    const b = `${prefix}-fence-once-b`
    await bindMachineBox({ sandboxId: b, machineId: machine.id, unixUser: 'box_b' })

    // Perform (or join) the single process-wide recovery.
    const first = await recoverMigrationFencesOnce()

    // A fence claimed AFTER recovery is a LIVE in-process migrate — repeat
    // calls (the routes await the barrier on every request) must NOT clear it.
    expect(await fenceBoxForMigration(b, async () => false)).toBe(true)
    expect(await recoverMigrationFencesOnce()).toBe(first) // memoized, not re-run
    expect((await getMachineBox(b))?.migrating).toBe(true)
  })

  it('fenceBoxForMigration is an exclusive claim: fencing an already-fenced box loses without disturbing it', async () => {
    const machine = await insertMachine(readyMachineValues('fence-excl'))
    const sandboxId = `${prefix}-fence-excl`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })

    // First migration claims the fence.
    expect(await fenceBoxForMigration(sandboxId, async () => false)).toBe(true)

    // A second migration of the same box must LOSE (false) — not "re-win" and
    // proceed into a double tar/restore. It loses on the already-true check
    // BEFORE the set, so its activity probe never even runs, and the holder's
    // fence is left exactly as it was.
    let probed = false
    expect(
      await fenceBoxForMigration(sandboxId, async () => {
        probed = true
        return false
      })
    ).toBe(false)
    expect(probed).toBe(false)
    expect(await isBoxMigrating(sandboxId)).toBe(true) // holder's fence undisturbed

    // Once the holder lifts the fence, a fresh claim succeeds again.
    await clearBoxMigrating(sandboxId)
    expect(await fenceBoxForMigration(sandboxId, async () => false)).toBe(true)
  })

  it('fenceBoxForMigration HOLDS the box row lock across the set→recheck window', async () => {
    const machine = await insertMachine(readyMachineValues('fence-lock'))
    const sandboxId = `${prefix}-fence-lock`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })

    // Pin the lock-held ordering (not merely that the callback ran): while the
    // recheck callback executes, a second connection's FOR UPDATE NOWAIT on the
    // box row must fail 55P03. This breaks if .for('update') is dropped from
    // the fence's select or the recheck is moved outside the transaction.
    let codeDuringRecheck: string | undefined
    expect(
      await fenceBoxForMigration(sandboxId, async () => {
        codeDuringRecheck = await tryLockBoxRowFromSecondConnection(sandboxId)
        return false
      })
    ).toBe(true)
    expect(codeDuringRecheck).toBe('55P03')

    // After commit the lock is free again.
    expect(await tryLockBoxRowFromSecondConnection(sandboxId)).toBe('locked')
  })

  it('areBoxesMigratingLocked de-duplicates reversed input and acquires every row lock', async () => {
    const machine = await insertMachine(readyMachineValues('fence-multi-locked'))
    const a = `${prefix}-fence-multi-a`
    const b = `${prefix}-fence-multi-b`
    await bindMachineBox({ sandboxId: a, machineId: machine.id, unixUser: 'box-a' })
    await bindMachineBox({ sandboxId: b, machineId: machine.id, unixUser: 'box-b' })
    expect(await fenceBoxForMigration(b, async () => false)).toBe(true)

    await db.transaction(async (tx) => {
      // Deliberately reverse lexical order and duplicate b. The query must
      // acquire a before b regardless of caller order, and hold both locks.
      expect(await areBoxesMigratingLocked(tx, [b, a, b, `${prefix}-absent`])).toBe(true)
      expect(await tryLockBoxRowFromSecondConnection(a)).toBe('55P03')
      expect(await tryLockBoxRowFromSecondConnection(b)).toBe('55P03')
    })
    expect(await tryLockBoxRowFromSecondConnection(a)).toBe('locked')
    expect(await tryLockBoxRowFromSecondConnection(b)).toBe('locked')

    await clearBoxMigrating(b)
    await db.transaction(async (tx) => {
      expect(await areBoxesMigratingLocked(tx, [b, a])).toBe(false)
      expect(await areBoxesMigratingLocked(tx, [])).toBe(false)
    })
  })

  it('areBoxesMigratingLocked acquires row locks in sandbox_id order, not scan order', async () => {
    // The deadlock-avoidance property: two claim transactions whose box sets
    // overlap must take the shared rows in the SAME order, or a pickup and a
    // fence (or two pickups) can deadlock. Sorting the id LIST is not enough —
    // `inArray` is a set predicate, so what actually fixes the LOCK order is
    // the query's `.orderBy(sandbox_id)`: `LockRows` locks rows in the order
    // its child node emits them.
    //
    // The fixture has to be adversarial about the plan. On a small table the
    // planner picks an Index Scan on the pkey, whose output is ALREADY sorted —
    // so against ordinary data the ORDER BY is invisible and a naive test
    // passes with it deleted (measured). Turning both index paths off forces
    // the seq scan, whose emission order is HEAP order.
    //
    // Heap order is not something a test can dictate: this suite shares one
    // database with every other core test file, so free space from earlier
    // deletes decides where a tuple lands, and an UPDATE (the fence below)
    // rewrites its row's tuple somewhere else again. So the fixture is BUILT
    // AND VERIFIED under the exact plan the experiment uses, retrying with
    // fresh ids until heap order and sorted order genuinely disagree — and
    // failing loudly rather than quietly becoming non-discriminating.
    const machine = await insertMachine(readyMachineValues('fence-lock-order'))
    let heapFirst = ''
    let sortsFirst = ''
    let emitted: string[] = []
    for (let attempt = 0; attempt < 12; attempt++) {
      heapFirst = `${prefix}-fence-order-${attempt}-z` // wanted: earlier in the heap
      sortsFirst = `${prefix}-fence-order-${attempt}-a` // wanted: sorts first, heap-LAST
      await bindMachineBox({ sandboxId: heapFirst, machineId: machine.id, unixUser: `box-z-${attempt}` })
      await bindMachineBox({ sandboxId: sortsFirst, machineId: machine.id, unixUser: `box-a-${attempt}` })
      // Fence the SORTS-FIRST row: only one row migrating makes the final
      // `true` prove the read saw BOTH rows, not just the one it blocked on.
      // It also rewrites that row's tuple, which is part of what the emission
      // order below has to be measured after, not assumed before.
      expect(await fenceBoxForMigration(sortsFirst, async () => false)).toBe(true)
      emitted = await emissionOrderUnderForcedSeqScan([heapFirst, sortsFirst])
      if (emitted[0] === heapFirst && emitted[1] === sortsFirst) break
      await clearBoxMigrating(sortsFirst)
    }
    // Premise, not decoration: without this the experiment below would still
    // pass with `.orderBy` deleted, because both orders would agree.
    expect(emitted).toEqual([heapFirst, sortsFirst])

    // The second connection pins the HEAP-first row and holds it open.
    let releaseHolder!: () => void
    const holderMayCommit = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    let signalHeld!: () => void
    const holderReady = new Promise<void>((resolve) => {
      signalHeld = resolve
    })
    const holderTxn = secondConnection.begin(async (tx) => {
      // postgres.js typings gap: TransactionSql extends Omit<Sql, ...>, and
      // Omit drops the tagged-template call signatures — cast back to the
      // callable shape (the runtime object is the same tagged-template function).
      const txSql = tx as unknown as postgres.Sql
      await txSql`SELECT migrating FROM machine_boxes WHERE sandbox_id = ${heapFirst} FOR UPDATE`
      signalHeld()
      await holderMayCommit
    })

    try {
      await holderReady

      // areBoxesMigratingLocked now blocks on `...-z`. Locking in sorted order
      // means it has ALREADY taken `...-a` before blocking; locking in scan
      // (heap) order means it blocked first and holds nothing.
      let fenceSettled = false
      const fenceRead = db
        .transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL enable_indexscan = off`)
          await tx.execute(sql`SET LOCAL enable_bitmapscan = off`)
          return areBoxesMigratingLocked(tx, [sortsFirst, heapFirst])
        })
        .then((result) => {
          fenceSettled = true
          return result
        })

      // Poll rather than sleep-and-hope: the sorted-order lock lands in
      // milliseconds, while a scan-order implementation never lands it at all
      // (the probe keeps succeeding until the budget is spent, then the
      // assertion below fails). The budget is generous for a slow CI runner and
      // sits well inside this test's own timeout, so a genuine failure reports
      // as the assertion below rather than as a test timeout.
      let sortsFirstRowState = 'locked'
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        sortsFirstRowState = await tryLockBoxRowFromThirdConnection(sortsFirst)
        if (sortsFirstRowState === '55P03') break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(sortsFirstRowState).toBe('55P03')
      // ...and it is genuinely still blocked on the row the holder owns, so
      // the lock above was taken BEFORE that block, not after it cleared.
      expect(fenceSettled).toBe(false)

      releaseHolder()
      await holderTxn
      expect(await fenceRead).toBe(true)
    } finally {
      releaseHolder()
      await holderTxn.catch(() => {})
      await clearBoxMigrating(sortsFirst)
    }
  }, 30_000)

  it('isBoxMigratingLocked reads the fence under the box row lock, held through the caller txn', async () => {
    const machine = await insertMachine(readyMachineValues('fence-locked-read'))
    const sandboxId = `${prefix}-fence-locked-read`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    expect(await fenceBoxForMigration(sandboxId, async () => false)).toBe(true)

    // The consumer shape: a claim transaction takes the locked read and holds
    // the lock through its own commit.
    await db.transaction(async (tx) => {
      expect(await isBoxMigratingLocked(tx, sandboxId)).toBe(true)
      // The lock is genuinely HELD by the caller's transaction: a second
      // connection cannot take it (55P03), so a racing fence would block here
      // until this transaction commits.
      expect(await tryLockBoxRowFromSecondConnection(sandboxId)).toBe('55P03')
    })
    // Released on commit.
    expect(await tryLockBoxRowFromSecondConnection(sandboxId)).toBe('locked')

    await clearBoxMigrating(sandboxId)
    await db.transaction(async (tx) => {
      expect(await isBoxMigratingLocked(tx, sandboxId)).toBe(false)
    })
  })

  it('isBoxMigratingLocked returns false for an absent box row', async () => {
    await db.transaction(async (tx) => {
      expect(await isBoxMigratingLocked(tx, `${prefix}-fence-locked-none`)).toBe(false)
    })
  })
})

describe('stampArtifactVersion', () => {
  it('stamps per-artifact versions as an in-DB jsonb MERGE (never clobbering sibling keys)', async () => {
    const machine = await insertMachine(machineValues('artifact-stamp'))
    // Fresh row: the column defaults to an empty object.
    expect(machine.artifactVersions).toEqual({})

    await stampArtifactVersion(machine.id, 'server', 'v1')
    expect((await getMachine(machine.id))?.artifactVersions).toEqual({ server: 'v1' })

    // Load-bearing: stamping a SECOND artifact must merge against the current
    // row, not clobber the just-written 'server' entry. ensureMachineArtifacts
    // ensures artifacts sequentially against ONE stale in-memory machine, so an
    // in-memory spread here would lose the first stamp.
    await stampArtifactVersion(machine.id, 'cli', 'v2')
    expect((await getMachine(machine.id))?.artifactVersions).toEqual({ server: 'v1', cli: 'v2' })

    // Re-stamping an existing artifact updates only that key.
    await stampArtifactVersion(machine.id, 'server', 'v3')
    expect((await getMachine(machine.id))?.artifactVersions).toEqual({ server: 'v3', cli: 'v2' })
  })
})

describe('stampBoxSyncedHash / clearBoxSyncedHashes', () => {
  it('stamps per-asset hashes as an in-DB jsonb MERGE (never clobbering sibling keys)', async () => {
    const machine = await insertMachine(readyMachineValues('box-stamp'))
    const sandboxId = `${prefix}-stamp-sb`
    const box = await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    // Fresh row: the column defaults to an empty object.
    expect(box.syncedHashes).toEqual({})

    await stampBoxSyncedHash(machine.id, sandboxId, 'skills', 'h1')
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({ skills: 'h1' })

    // Load-bearing: stamping a SECOND asset against the SAME stale in-memory box
    // snapshot must merge against the current row, not clobber the just-written
    // 'skills' entry — the machine-artifacts clobber regression, per box.
    await stampBoxSyncedHash(machine.id, sandboxId, 'identity', 'h2')
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({ skills: 'h1', identity: 'h2' })

    await stampBoxSyncedHash(machine.id, sandboxId, 'squad-ssh', 'h-ssh', ['config', 'ficus_remote_prod'])
    expect((await getMachineBox(sandboxId))?.syncedHashes?.['squad-ssh']).toEqual({
      hash: 'h-ssh',
      files: ['config', 'ficus_remote_prod'],
    })

    // Re-stamping an existing asset updates only that key.
    await stampBoxSyncedHash(machine.id, sandboxId, 'skills', 'h3')
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({
      skills: 'h3',
      identity: 'h2',
      'squad-ssh': { hash: 'h-ssh', files: ['config', 'ficus_remote_prod'] },
    })
  })

  it('stamp is machine-guarded: a stamp for a DIFFERENT machine is a no-op (does not resurrect a stale hash)', async () => {
    const machineA = await insertMachine(readyMachineValues('box-stamp-guard-a'))
    const machineB = await insertMachine(readyMachineValues('box-stamp-guard-b'))
    const sandboxId = `${prefix}-stamp-guard-sb`
    await bindMachineBox({ sandboxId, machineId: machineA.id, unixUser: 'box' })

    // The box lives on A; a stamp naming B (a migrate that repointed away) must
    // not land — file-sync's files never reached B.
    await stampBoxSyncedHash(machineB.id, sandboxId, 'skills', 'stale')
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({})

    await stampBoxSyncedHash(machineA.id, sandboxId, 'skills', 'real')
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({ skills: 'real' })
  })

  it('clearBoxSyncedHashes resets the map to {} on the primary key alone (machine-agnostic)', async () => {
    const machine = await insertMachine(readyMachineValues('box-clear'))
    const sandboxId = `${prefix}-clear-sb`
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    await stampBoxSyncedHash(machine.id, sandboxId, 'skills', 'h1')
    await stampBoxSyncedHash(machine.id, sandboxId, 'squad-ssh', 'h2')
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({ skills: 'h1', 'squad-ssh': 'h2' })

    await clearBoxSyncedHashes(sandboxId)
    expect((await getMachineBox(sandboxId))?.syncedHashes).toEqual({})
  })
})
