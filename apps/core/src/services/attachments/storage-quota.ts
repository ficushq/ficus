import { sql } from 'drizzle-orm'
import {
  agentFileAttachments,
  db,
  images,
  inboxAttachments,
  retainedAssets,
  workflowAttemptAttachments,
} from '../../db'
import { getSettingsStore } from '../settings'

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Bytes held by every kind of stored attachment: inbox deliveries, agent chat files, workflow
 * handoff files, and chat files a work stream still retains after their chat row was deleted (counted
 * once, however many streams share them). All of them share INBOX_MAX_TOTAL_STORAGE_BYTES.
 */
export async function totalAttachmentStorageBytes(executor: DbExecutor = db): Promise<number> {
  const totals = await Promise.all([
    ...[inboxAttachments, agentFileAttachments, workflowAttemptAttachments].map((table) =>
      executor.select({ total: sql<number>`coalesce(sum(${table.byteSize}), 0)` }).from(table)
    ),
    executor
      .select({ total: sql<number>`coalesce(sum(${retainedAssets.byteSize}), 0)` })
      .from(retainedAssets)
      .where(retainedChatFileWithoutSource),
  ])
  return totals.reduce((sum, [row]) => sum + Number(row?.total ?? 0), 0)
}

/** A retained chat file whose own row is gone: its bytes are no longer counted as a chat file. */
export const retainedChatFileWithoutSource = sql`${retainedAssets.sourceKind} = 'agent-file' and not exists (select 1 from ${agentFileAttachments} where ${agentFileAttachments.id} = ${retainedAssets.sourceId})`

/** A retained image whose own row is gone (images are reported, not counted toward the quota). */
export const retainedImageWithoutSource = sql`${retainedAssets.sourceKind} = 'image' and not exists (select 1 from ${images} where ${images.id} = ${retainedAssets.sourceId})`

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
