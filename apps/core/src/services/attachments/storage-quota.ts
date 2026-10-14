import { sql } from 'drizzle-orm'
import { agentFileAttachments, db, inboxAttachments, workflowAttemptAttachments } from '../../db'
import { getSettingsStore } from '../settings'

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Bytes held by every kind of stored attachment: inbox deliveries, agent chat files and workflow
 * handoff files. All of them share INBOX_MAX_TOTAL_STORAGE_BYTES, so every check sums all three here.
 */
export async function totalAttachmentStorageBytes(executor: DbExecutor = db): Promise<number> {
  const totals = await Promise.all(
    [inboxAttachments, agentFileAttachments, workflowAttemptAttachments].map((table) =>
      executor.select({ total: sql<number>`coalesce(sum(${table.byteSize}), 0)` }).from(table)
    )
  )
  return totals.reduce((sum, [row]) => sum + Number(row?.total ?? 0), 0)
}

/**
 * Serialize quota accounting and refuse `additionalBytes` that would exceed the instance quota.
 * Call inside the transaction that stores the bytes; the lock is held until it ends.
 */
export async function reserveAttachmentStorage(tx: DbExecutor, additionalBytes: number): Promise<void> {
  // Instance-global quota is correct only while each deployment serves one tenant.
  // Replace this with a tenant-scoped lock/accounting key before multi-tenant hosting.
  await lockAttachmentStorage(tx)
  const limit = Number(getSettingsStore().getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES'))
  if ((await totalAttachmentStorageBytes(tx)) + additionalBytes > limit) throw new Error('INBOX_STORAGE_QUOTA_EXCEEDED')
}

/** The advisory lock every attachment writer holds while it checks and changes stored bytes. */
export async function lockAttachmentStorage(tx: DbExecutor): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('attachment-storage-quota'))`)
}
