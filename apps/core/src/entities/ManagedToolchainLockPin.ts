import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { managedToolchainLockPins } from '../db/schema'

/**
 * The pinned `devbox.lock` for one squad's managed toolchain fingerprint. See
 * services/sandbox/toolchain/lock-pin.ts for what the pin means and how it is
 * validated; this class only stores it.
 */
export class ManagedToolchainLockPin {
  /** The pinned lock for this squad and fingerprint, or null. */
  static async get(squadId: string, fingerprint: string): Promise<string | null> {
    const [row] = await db
      .select({ lockContent: managedToolchainLockPins.lockContent })
      .from(managedToolchainLockPins)
      .where(and(eq(managedToolchainLockPins.squadId, squadId), eq(managedToolchainLockPins.fingerprint, fingerprint)))
      .limit(1)
    return row?.lockContent ?? null
  }

  /**
   * Store a freshly resolved lock. Without `replacing` the first writer wins,
   * so a later box can never move an established pin. With `replacing`, the
   * stored pin is swapped only while it still equals that (corrupt or
   * unrealizable) value; a concurrent replacement that landed first wins.
   */
  static async store(squadId: string, fingerprint: string, lockContent: string, replacing?: string): Promise<void> {
    const insert = db.insert(managedToolchainLockPins).values({ squadId, fingerprint, lockContent })
    if (replacing === undefined) {
      await insert.onConflictDoNothing()
      return
    }
    await insert.onConflictDoUpdate({
      target: [managedToolchainLockPins.squadId, managedToolchainLockPins.fingerprint],
      set: { lockContent, createdAt: new Date() },
      setWhere: eq(managedToolchainLockPins.lockContent, replacing),
    })
  }
}
