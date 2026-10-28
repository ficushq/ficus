import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import * as queries from './queries'

const machines: string[] = []
afterEach(async () => {
  for (const id of machines.splice(0)) await queries.deleteMachine(id)
})

async function fixture() {
  const machine = await queries.insertMachine({
    name: `restart-${randomUUID()}`,
    provider: 'ssh',
    sshHost: '127.0.0.1',
    sshUser: 'test',
    sshKeyId: 'test',
    sshPublicKey: 'test',
    status: 'ready',
  })
  machines.push(machine.id)
  return queries.upsertMachineBox({
    sandboxId: `squad_${randomUUID()}`,
    machineId: machine.id,
    unixUser: 'box_test',
    port: 50100,
    status: 'ready',
    authToken: 'preserve',
    reconcilableSpecHash: 'spec',
    lastListeningAt: new Date(),
  })
}

test('one restart wins atomically; migration cannot claim a restarting box', async () => {
  const box = await fixture()
  expect(await Promise.all([queries.beginBoxRestart(box), queries.beginBoxRestart(box)])).toEqual(
    expect.arrayContaining([true, false])
  )
  expect(await queries.fenceBoxForMigration(box.sandboxId, async () => false)).toBe(false)
  const pending = await queries.getMachineBox(box.sandboxId)
  expect(pending?.status).toBe('restarting')
  expect(pending?.lastListeningAt).toBeNull()
  expect(pending?.authToken).toBe('preserve')
  expect(pending?.reconcilableSpecHash).toBe('spec')
  expect(await queries.finishBoxRestart(box, 'ready')).toBe(true)
  expect((await queries.getMachineBox(box.sandboxId))?.status).toBe('ready')
})

test('restart refuses a migrating box or a replaced identity; completion cannot overwrite a stop', async () => {
  const box = await fixture()
  expect(await queries.fenceBoxForMigration(box.sandboxId, async () => false)).toBe(true)
  expect(await queries.beginBoxRestart(box)).toBe(false)
  await queries.clearBoxMigrating(box.sandboxId)
  expect(await queries.beginBoxRestart({ ...box, authToken: 'stale-token' })).toBe(false)
  expect(await queries.beginBoxRestart({ ...box, port: box.port + 1 })).toBe(false)
  expect(await queries.beginBoxRestart(box)).toBe(true)
  await queries.upsertMachineBox({ ...box, status: 'stopped' })
  expect(await queries.finishBoxRestart(box, 'ready')).toBe(false)
  expect((await queries.getMachineBox(box.sandboxId))?.status).toBe('stopped')
})

test('an interrupted restart becomes retryable after its bounded recovery window', async () => {
  const box = await fixture()
  expect(await queries.beginBoxRestart(box)).toBe(true)
  const { db, machineBoxes } = await import('../../db')
  const { eq } = await import('drizzle-orm')
  await db
    .update(machineBoxes)
    .set({ updatedAt: new Date(Date.now() - 121_000) })
    .where(eq(machineBoxes.sandboxId, box.sandboxId))
  const stale = (await queries.getMachineBox(box.sandboxId))!
  expect(await queries.beginBoxRestart(stale)).toBe(true)
})
