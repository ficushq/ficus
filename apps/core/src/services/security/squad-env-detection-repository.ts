import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, squadEnvDetections, squads } from '../../db'

export const MAX_SQUAD_ENV_BYTES = 256 * 1024

export type SquadEnvSnapshot = {
  contentHash: string | null
  entries: Array<{ key: string; value: string }>
  reason: 'oversized' | 'unreadable' | null
}
export type SquadEnvDetectionRecord = { squadId: string; snapshot?: SquadEnvSnapshot }

export interface SquadEnvDetectionRepository {
  pendingSquads(): Promise<string[]>
  bootstrap(squadId: string, snapshot: SquadEnvSnapshot): Promise<void>
  save(squadId: string, snapshot: SquadEnvSnapshot, write?: () => void): Promise<void>
  list(): Promise<SquadEnvDetectionRecord[]>
}

const snapshotSchema = z.object({
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  entries: z.array(
    z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(MAX_SQUAD_ENV_BYTES) })
  ),
  reason: z.enum(['oversized', 'unreadable']).nullable(),
})

/** Dedicated DB authority: no dependency on the optional Secret Store encryption key. */
export class DbSquadEnvDetectionRepository implements SquadEnvDetectionRepository {
  async pendingSquads(): Promise<string[]> {
    const rows = await db.select({ id: squads.id }).from(squads).where(eq(squads.envDetectionBootstrapped, false))
    return rows.map(({ id }) => id)
  }

  async bootstrap(squadId: string, snapshot: SquadEnvSnapshot): Promise<void> {
    await this.persist(squadId, snapshot, true)
  }

  async save(squadId: string, snapshot: SquadEnvSnapshot, write?: () => void): Promise<void> {
    await this.persist(squadId, snapshot, false, write)
  }

  private async persist(
    squadId: string,
    snapshot: SquadEnvSnapshot,
    bootstrapOnly: boolean,
    write?: () => void
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [squad] = await tx
        .select({ bootstrapped: squads.envDetectionBootstrapped })
        .from(squads)
        .where(eq(squads.id, squadId))
        .for('update')
      if (!squad) {
        if (bootstrapOnly) return // Concurrent squad deletion needs no legacy snapshot.
        throw new Error('Squad not found')
      }
      // The marker is separate from the record: deleting/corrupting that record
      // never grants another opportunity to bless attacker-writable disk bytes.
      if (bootstrapOnly && squad.bootstrapped) return
      // Serialize API file writes with their trusted record across processes.
      write?.()
      const record = { ...snapshot, updatedAt: new Date() }
      await tx
        .insert(squadEnvDetections)
        .values({ squadId, ...record })
        .onConflictDoUpdate({ target: squadEnvDetections.squadId, set: record })
      await tx.update(squads).set({ envDetectionBootstrapped: true }).where(eq(squads.id, squadId))
    })
  }

  async list(): Promise<SquadEnvDetectionRecord[]> {
    const rows = await db
      .select({
        squadId: squads.id,
        rowId: squadEnvDetections.squadId,
        contentHash: squadEnvDetections.contentHash,
        entries: squadEnvDetections.entries,
        reason: squadEnvDetections.reason,
      })
      .from(squads)
      .leftJoin(squadEnvDetections, eq(squads.id, squadEnvDetections.squadId))
    return rows.map(({ squadId, rowId, ...raw }) => {
      const parsed = rowId ? snapshotSchema.safeParse(raw) : undefined
      return { squadId, snapshot: parsed?.success ? parsed.data : undefined }
    })
  }
}
