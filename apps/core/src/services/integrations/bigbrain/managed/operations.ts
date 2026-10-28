/**
 * Immutable owner-link windows. An owner device link is minted on the host at a fixed `issuedAt`
 * that Core records once per request ID; a retry of the same request sends the same window (the
 * host's own replay cache then returns the same link, never a fresh one). A window that has
 * expired is refused: a new link needs a new human request.
 */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS } from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainOperations } from '../../../../db'

export type InviteWindow =
  { status: 'current'; issuedAt: string; expiresAt: string } | { status: 'expired' } | { status: 'conflict' }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export const managedVaultOperations = {
  async openInviteWindow(
    requestId: string,
    vaultId: string,
    expectedGeneration: number,
    now = new Date()
  ): Promise<InviteWindow> {
    const inputHash = hash([vaultId, 'owner-invite', expectedGeneration])
    // Whole milliseconds dropped: the host contract carries second-precision ISO timestamps.
    const issued = new Date(Math.floor(now.getTime() / 1000) * 1000)
    await db
      .insert(managedBigbrainOperations)
      .values({
        requestId,
        vaultId,
        action: 'owner-invite',
        inputHash,
        expectedGeneration,
        generation: expectedGeneration,
        issuedAt: issued,
        expiresAt: new Date(issued.getTime() + MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS),
      })
      .onConflictDoNothing({ target: managedBigbrainOperations.requestId })
    const [row] = await db
      .select()
      .from(managedBigbrainOperations)
      .where(eq(managedBigbrainOperations.requestId, requestId))
    if (!row || row.inputHash !== inputHash || row.action !== 'owner-invite' || !row.expiresAt)
      return { status: 'conflict' }
    if (row.expiresAt.getTime() <= now.getTime()) return { status: 'expired' }
    return {
      status: 'current',
      issuedAt: row.issuedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      expiresAt: row.expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }
  },
}
