import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { localDeployments, squads } from '../../db/schema'
import { Squad } from '../../entities/Squad'
import {
  ASSIGNED_PORT_MAX,
  ASSIGNED_PORT_MIN,
  LocalDeploymentPortInUseError,
  LocalDeploymentPortReservedError,
  isLocalDeploymentPortTaken,
  resolveLocalDeploymentPort,
} from './local-deployment-ports'
import { FIRST_BOX_PORT, LAST_BOX_PORT, MACHINE_CALLBACK_PORT } from '../machines/box-ports'

/**
 * The invariant these pin: on the VM runtime every box on a machine shares one
 * loopback, so a port is a machine-wide claim. Without it a tokenized
 * deployment URL could forward to a DIFFERENT squad's app.
 */
describe('local deployment port assignment', () => {
  let squad: Squad

  const seed = async (port: number, portScope: string, archived = false) => {
    await db.insert(localDeployments).values({
      id: crypto.randomUUID(),
      squadId: squad.id,
      sandboxId: Squad.getSandboxId(squad.id),
      name: `dep-${port}-${portScope}`,
      port,
      portScope,
      targetHost: '127.0.0.1',
      browserAccessToken: crypto.randomUUID(),
      visibility: 'private',
      mode: 'managed',
      status: 'running',
      keepSandboxAlive: true,
      restartPolicy: 'never',
      ...(archived ? { archivedAt: new Date() } : {}),
    })
  }

  beforeEach(async () => {
    squad = await Squad.create({ name: `ports-${crypto.randomUUID().slice(0, 8)}`, purpose: 'port tests' })
  })

  afterEach(async () => {
    await db.delete(localDeployments).where(eq(localDeployments.squadId, squad.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  it('assigns a port from the assigned range when none is requested', async () => {
    const port = await resolveLocalDeploymentPort('machine:m1')
    expect(port).toBeGreaterThanOrEqual(ASSIGNED_PORT_MIN)
    expect(port).toBeLessThanOrEqual(ASSIGNED_PORT_MAX)
  })

  it('never assigns a port already held in the same scope', async () => {
    await seed(ASSIGNED_PORT_MIN, 'machine:m1')
    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect(await resolveLocalDeploymentPort('machine:m1')).not.toBe(ASSIGNED_PORT_MIN)
    }
  })

  it('rejects an explicit port another live deployment holds in the same scope', async () => {
    await seed(3000, 'machine:m1')
    await expect(resolveLocalDeploymentPort('machine:m1', 3000)).rejects.toBeInstanceOf(LocalDeploymentPortInUseError)
  })

  it('allows the same port in a DIFFERENT scope — docker/k8s namespaces stay legal', async () => {
    await seed(3000, 'sandbox:a')
    // Two squads on docker both using 3000 is legitimate and must keep working.
    await expect(resolveLocalDeploymentPort('sandbox:b', 3000)).resolves.toBe(3000)
  })

  it('frees a port once its deployment is archived', async () => {
    await seed(3000, 'machine:m1', true)
    expect(await isLocalDeploymentPortTaken(3000, 'machine:m1')).toBe(false)
    await expect(resolveLocalDeploymentPort('machine:m1', 3000)).resolves.toBe(3000)
  })

  it('keeps a stopped-but-unarchived deployment holding its port', async () => {
    // It can be restarted; handing the port away makes that restart fail in a
    // way nobody would trace back to this decision.
    await seed(3000, 'machine:m1')
    expect(await isLocalDeploymentPortTaken(3000, 'machine:m1')).toBe(true)
  })

  it('the database refuses two live deployments on one port in one scope', async () => {
    await seed(4100, 'machine:m1')
    // The service checks first; the index is what makes two CONCURRENT creates
    // race to one answer rather than both succeeding.
    await expect(seed(4100, 'machine:m1')).rejects.toThrow()
  })

  // A VM box's socket and Core's callback tunnel listen on these ports on the
  // machine's shared loopback. A deployment holding one could stop a box from
  // starting, or receive traffic meant for another box.
  it.each([MACHINE_CALLBACK_PORT, FIRST_BOX_PORT, 51276, LAST_BOX_PORT])(
    'refuses Ficus-reserved port %d on a shared machine',
    async (port) => {
      await expect(resolveLocalDeploymentPort('machine:m1', port)).rejects.toBeInstanceOf(
        LocalDeploymentPortReservedError
      )
    }
  )

  it.each([FIRST_BOX_PORT - 1, LAST_BOX_PORT + 1, MACHINE_CALLBACK_PORT + 1])(
    'accepts neighbouring port %d on a shared machine',
    async (port) => {
      await expect(resolveLocalDeploymentPort('machine:m1', port)).resolves.toBe(port)
    }
  )

  it('keeps the box range legal in a sandbox scope with its own network namespace', async () => {
    await expect(resolveLocalDeploymentPort('sandbox:a', FIRST_BOX_PORT)).resolves.toBe(FIRST_BOX_PORT)
  })

  it('never assigns a reserved port by itself', () => {
    expect(ASSIGNED_PORT_MAX).toBeLessThan(MACHINE_CALLBACK_PORT)
  })
})
