import { open } from 'node:fs/promises'
import type { PersistedDeliveryEntry } from './pending-delivery'

/** Read only complete, on-disk user receipts, retaining no transcript content.
 * Async bounded reads let other sessions run while a long history is scanned.
 * Never repair an incomplete tail or trust the SDK's mutable in-memory entries.
 */
export async function readSessionDeliveryReceipts(
  file: string | undefined,
  deliveryIds: ReadonlySet<string>
): Promise<PersistedDeliveryEntry[]> {
  if (!file || deliveryIds.size === 0) return []
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if (['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return []
    throw error
  }
  try {
    const info = await handle.stat()
    if (info.isDirectory()) return []
    if (!info.isFile()) throw new Error('Cannot read SDK receipts from a non-regular session file')
    const receipts = new Map<string, PersistedDeliveryEntry>()
    let headerSeen = false
    let pending = ''
    const stream = handle.createReadStream({ encoding: 'utf8', highWaterMark: 64 * 1024, autoClose: false })
    for await (const chunk of stream) {
      pending += chunk
      let start = 0
      let end: number
      while ((end = pending.indexOf('\n', start)) !== -1) {
        const line = pending.slice(start, end)
        start = end + 1
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue // Match the SDK's treatment of blank/malformed lines.
        }
        if (!entry) continue
        if (!headerSeen) {
          if (entry?.type !== 'session' || typeof entry.id !== 'string') return []
          headerSeen = true
          continue
        }
        if (
          entry?.type === 'message' &&
          entry.message?.role === 'user' &&
          typeof entry.id === 'string' &&
          deliveryIds.has(entry.deliveryId)
        ) {
          receipts.set(entry.deliveryId, {
            type: 'message',
            id: entry.id,
            deliveryId: entry.deliveryId,
            message: { role: 'user' },
          })
        }
      }
      pending = pending.slice(start)
    }
    return [...receipts.values()]
  } finally {
    await handle.close()
  }
}
