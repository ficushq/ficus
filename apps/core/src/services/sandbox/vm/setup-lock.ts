import { sql, type SQL } from 'drizzle-orm'

const VM_SETUP_LOCK_PREFIX = 'vm-box-setup:'

export function vmSetupLockKey(sandboxId: string): string {
  return `${VM_SETUP_LOCK_PREFIX}${sandboxId}`
}

/** Read the actual session lock, not a process-local flag or an expiring guess.
 * PostgreSQL represents a bigint advisory key as unsigned high/low OIDs with
 * objsubid=1. Restrict the probe to this database and granted exclusive locks. */
export function vmSetupLeaseIsHeld(sandboxId: SQL): SQL {
  const hash = sql`hashtextextended(${VM_SETUP_LOCK_PREFIX} || ${sandboxId}, 0)`
  return sql`EXISTS (SELECT 1 FROM pg_locks held
    WHERE held.locktype = 'advisory' AND held.granted AND held.mode = 'ExclusiveLock'
      AND held.objsubid = 1
      AND held.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND held.classid = ((${hash} >> 32) & 4294967295)::oid
      AND held.objid = (${hash} & 4294967295)::oid)`
}
