import { afterEach, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, machineEvacuationBoxes, machineEvacuations, machines } from '../../db'
import {
  authorizeEvacuationSourceDeletion,
  beginMachineEvacuation,
  recordEvacuationBoxProof,
  settleEvacuationSourceTerminated,
  verifyMachineEvacuation,
} from './machine-evacuation'
import { deleteMachineBox, insertMachine, upsertMachineBox } from './queries'

const ids: string[] = []
async function machine(name: string) {
  const row = await insertMachine({
    name: `evac-${name}-${crypto.randomUUID()}`,
    provider: 'ssh',
    sshHost: '127.0.0.1',
    sshPort: 22,
    sshUser: 'ficus',
    sshKeyId: 'key',
    sshPublicKey: 'key',
    status: 'ready',
    capabilities: { forwarding: 'yes' },
    scope: 'shared',
  })
  ids.push(row.id)
  return row
}

afterEach(async () => {
  if (ids.length) await db.delete(machines).where(inArray(machines.id, ids.splice(0)))
})

describe('machine evacuation proof', () => {
  it('atomically drains the source and freezes active, idle, stopped, and retained box rows', async () => {
    const source = await machine('source')
    const target = await machine('target')
    for (const [index, status] of ['ready', 'ready', 'stopped', 'orphaned'].entries()) {
      await upsertMachineBox({
        sandboxId: `agent_${index}`,
        machineId: source.id,
        unixUser: `box_00000000000${index}`,
        port: 50100 + index,
        status,
      })
    }

    const operation = await beginMachineEvacuation({
      operationId: crypto.randomUUID(),
      sourceMachineId: source.id,
      targetMachineId: target.id,
      sourceGeneration: 7,
      targetGeneration: 8,
      hostUnixUsers: ['box_000000000000', 'box_000000000001', 'box_000000000002', 'box_000000000003'],
    })

    expect(operation.roster.map((box) => box.sandboxId)).toEqual(['agent_0', 'agent_1', 'agent_2', 'agent_3'])
    expect((await db.select().from(machines).where(eq(machines.id, source.id)))[0].status).toBe('draining')
    expect(
      (await db.select().from(machineEvacuationBoxes).where(eq(machineEvacuationBoxes.evacuationId, operation.id)))
        .length
    ).toBe(4)
  })

  it('rejects a source host user missing from or extra to the database roster', async () => {
    const source = await machine('host-truth-source')
    const target = await machine('host-truth-target')
    await upsertMachineBox({
      sandboxId: 'agent_db',
      machineId: source.id,
      unixUser: 'box_cccccccccccc',
      port: 50100,
      status: 'ready',
    })
    await expect(
      beginMachineEvacuation({
        operationId: crypto.randomUUID(),
        sourceMachineId: source.id,
        targetMachineId: target.id,
        sourceGeneration: 1,
        targetGeneration: 2,
        hostUnixUsers: ['box_dddddddddddd'],
      })
    ).rejects.toThrow(/inventory-mismatch/)
  })

  it('fails verification until every frozen child has exact proof and returns a generation-bound receipt', async () => {
    const source = await machine('proof-source')
    const target = await machine('proof-target')
    await upsertMachineBox({
      sandboxId: 'agent_a',
      machineId: source.id,
      unixUser: 'box_aaaaaaaaaaaa',
      port: 50100,
      status: 'ready',
    })
    const operationId = crypto.randomUUID()
    const operation = await beginMachineEvacuation({
      operationId,
      sourceMachineId: source.id,
      targetMachineId: target.id,
      sourceGeneration: 10,
      targetGeneration: 11,
      hostUnixUsers: ['box_aaaaaaaaaaaa'],
    })

    await expect(verifyMachineEvacuation(operation.id, { listHostUsers: async () => [] })).rejects.toThrow(
      /incomplete/i
    )
    await upsertMachineBox({
      sandboxId: 'agent_a',
      machineId: target.id,
      unixUser: 'box_aaaaaaaaaaaa',
      port: 50100,
      status: 'ready',
    })
    const proof = {
      evacuationId: operation.id,
      sandboxId: 'agent_a',
      manifestDigest: 'a'.repeat(64),
      files: 2,
      bytes: '9',
    }
    await recordEvacuationBoxProof(proof)
    await recordEvacuationBoxProof(proof)
    await expect(recordEvacuationBoxProof({ ...proof, manifestDigest: 'b'.repeat(64) })).rejects.toThrow(/immutable/i)
    const receipt = await verifyMachineEvacuation(operation.id, { listHostUsers: async () => [] })

    expect(receipt).toMatchObject({
      operationId,
      sourceMachineId: source.id,
      targetMachineId: target.id,
      sourceGeneration: 10,
      targetGeneration: 11,
    })
    expect(receipt.manifestDigest).toMatch(/^[a-f0-9]{64}$/)
    await expect(
      verifyMachineEvacuation(operation.id, { listHostUsers: async () => ['box_deadbeefdead'] })
    ).rejects.toThrow(/inventory-mismatch/)
    expect((await db.select().from(machineEvacuations).where(eq(machineEvacuations.id, operation.id)))[0].state).toBe(
      'verified'
    )
  })

  it('rejects complete DB and scoped host roster additions made after inventory', async () => {
    const source = await machine('concurrent-source')
    const target = await machine('concurrent-target')
    await upsertMachineBox({
      sandboxId: 'agent_frozen',
      machineId: source.id,
      unixUser: 'box_eeeeeeeeeeee',
      port: 50100,
      status: 'ready',
    })
    const operation = await beginMachineEvacuation({
      operationId: crypto.randomUUID(),
      sourceMachineId: source.id,
      targetMachineId: target.id,
      sourceGeneration: 1,
      targetGeneration: 2,
      hostUnixUsers: ['box_eeeeeeeeeeee'],
    })
    await upsertMachineBox({
      sandboxId: 'agent_frozen',
      machineId: target.id,
      unixUser: 'box_eeeeeeeeeeee',
      port: 50100,
      status: 'ready',
    })
    await recordEvacuationBoxProof({
      evacuationId: operation.id,
      sandboxId: 'agent_frozen',
      manifestDigest: 'e'.repeat(64),
      files: 1,
      bytes: '1',
    })
    await upsertMachineBox({
      sandboxId: 'agent_new',
      machineId: target.id,
      unixUser: 'box_ffffffffffff',
      port: 50101,
      status: 'ready',
    })
    await expect(verifyMachineEvacuation(operation.id, { listHostUsers: async () => [] })).rejects.toThrow(
      /roster changed/
    )
    await deleteMachineBox('agent_new')
    await expect(
      verifyMachineEvacuation(operation.id, { listHostUsers: async () => ['box_ffffffffffff'] })
    ).rejects.toThrow(/inventory-mismatch/)
    // The inventory callback is machine-scoped: a neighboring host's user is
    // deliberately absent and therefore cannot poison this operation.
    await expect(verifyMachineEvacuation(operation.id, { listHostUsers: async () => [] })).resolves.toMatchObject({
      operationId: operation.id,
    })
  })

  it('rejects changed or swapped generations and receipt replay for different machine IDs', async () => {
    const source = await machine('receipt-source')
    const target = await machine('receipt-target')
    await upsertMachineBox({
      sandboxId: 'agent_receipt',
      machineId: source.id,
      unixUser: 'box_bbbbbbbbbbbb',
      port: 50100,
      status: 'ready',
    })
    const operation = await beginMachineEvacuation({
      operationId: crypto.randomUUID(),
      sourceMachineId: source.id,
      targetMachineId: target.id,
      sourceGeneration: 20,
      targetGeneration: 21,
      hostUnixUsers: ['box_bbbbbbbbbbbb'],
    })
    await upsertMachineBox({
      sandboxId: 'agent_receipt',
      machineId: target.id,
      unixUser: 'box_bbbbbbbbbbbb',
      port: 50100,
      status: 'ready',
    })
    await recordEvacuationBoxProof({
      evacuationId: operation.id,
      sandboxId: 'agent_receipt',
      manifestDigest: 'c'.repeat(64),
      files: 1,
      bytes: '1',
    })
    const receipt = await verifyMachineEvacuation(operation.id, { listHostUsers: async () => [] })
    await deleteMachineBox('agent_receipt')

    await expect(
      authorizeEvacuationSourceDeletion(
        { ...receipt, sourceGeneration: 21, targetGeneration: 20 },
        { listHostUsers: async () => [] }
      )
    ).rejects.toThrow(/stale/i)
    await expect(
      authorizeEvacuationSourceDeletion({ ...receipt, sourceGeneration: 999 }, { listHostUsers: async () => [] })
    ).rejects.toThrow(/stale/i)
    await expect(
      authorizeEvacuationSourceDeletion(
        { ...receipt, sourceMachineId: target.id, targetMachineId: source.id },
        { listHostUsers: async () => [] }
      )
    ).rejects.toThrow(/stale/i)
    await expect(
      authorizeEvacuationSourceDeletion(receipt, { listHostUsers: async () => ['box_deadbeefdead'] })
    ).rejects.toThrow(/inventory-mismatch/)
    const concurrentClaims = await Promise.all([
      authorizeEvacuationSourceDeletion(receipt, { listHostUsers: async () => [] }),
      authorizeEvacuationSourceDeletion(receipt, { listHostUsers: async () => [] }),
    ])
    expect(concurrentClaims.filter((claim) => claim.providerTerminationRequired)).toHaveLength(1)
    expect(concurrentClaims.filter((claim) => claim.reconciliationRequired)).toHaveLength(1)
    // Crash immediately after the single-owner claim: retry reconciles provider
    // truth and never receives permission for a duplicate destructive call.
    expect(await authorizeEvacuationSourceDeletion(receipt, { listHostUsers: async () => [] })).toEqual({
      providerTerminationRequired: false,
      reconciliationRequired: true,
    })
    await settleEvacuationSourceTerminated(operation.id)
    // Crash after provider termination: retry skips the destructive provider call.
    expect(await authorizeEvacuationSourceDeletion(receipt, { listHostUsers: async () => [] })).toEqual({
      providerTerminationRequired: false,
    })
    await expect(
      authorizeEvacuationSourceDeletion({ ...receipt, targetGeneration: 99 }, { listHostUsers: async () => [] })
    ).rejects.toThrow(/stale/)
  })

  it('uses nullable generations for a manual one-box operation', async () => {
    const source = await machine('manual-source')
    const target = await machine('manual-target')
    const operation = await beginMachineEvacuation({
      operationId: crypto.randomUUID(),
      sourceMachineId: source.id,
      targetMachineId: target.id,
      sourceGeneration: null,
      targetGeneration: null,
      hostUnixUsers: [],
    })
    expect(operation.sourceGeneration).toBeNull()
    expect(operation.targetGeneration).toBeNull()
  })
})
