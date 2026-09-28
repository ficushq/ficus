import { useEffect, useRef } from 'react'
import type { AssistantEntry, AssistantMailbox, AssistantMailboxUpdate } from '@ficus/shared'
import { buildAssistantCatchUpBatch, type AssistantCatchUpBatch } from '../voice/assistantCatchUp'
import { useStableRef } from './useStableRef'

export interface AssistantInboxConsumerApi {
  inbox: (conversationId: string, consumerId: string) => Promise<AssistantMailbox>
  acknowledge: (
    conversationId: string,
    consumerId: string,
    messageIds: string[],
    responseEntryId: string
  ) => Promise<unknown>
  release: (conversationId: string, consumerId: string) => Promise<unknown>
}

export interface AssistantInboxScheduler {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface AssistantInboxConsumerOptions {
  conversationId: string
  /** Claim the mailbox only while this presentation surface is genuinely active and visible. */
  enabled: boolean
  /** Realtime presents catch-up batches; the text assistant appends each update as a reply. */
  realtime: boolean
  api: AssistantInboxConsumerApi
  /** Persist durable entries; resolves once saved. Presentation and acknowledgment wait for it. */
  append: (entries: AssistantEntry[]) => Promise<void>
  /** Realtime presentation of one batch; resolves when the response completed or was interrupted. */
  present: (batch: AssistantCatchUpBatch, entry: AssistantEntry) => Promise<void>
  onMailbox?: (mailbox: { pending: number; unavailable: boolean }) => void
  onError?: (failed: boolean) => void
  scheduler?: AssistantInboxScheduler
  pollIntervalMs?: number
}

export const ASSISTANT_INBOX_POLL_MS = 3000

/** Durable ID for the entry that presents a batch; a retry of the same batch reuses it. */
export function assistantBatchEntryId(messageIds: string[]): string {
  return `inbox:${messageIds[0]}`
}

/**
 * Owns one conversation's mailbox consumption: lease polling, serial catch-up presentation, and
 * durable completion. Nothing is acknowledged before a final entry referencing the exact update IDs
 * is saved; a failed acknowledgment retries on later polls without presenting again. Losing the
 * lease stops new presentation; closing releases the lease and never stops delegated work.
 */
export function useAssistantInboxConsumer(options: AssistantInboxConsumerOptions): { consumerId: string } {
  const consumerId = useRef(crypto.randomUUID())
  const received = useRef(new Set<string>())
  const pendingAcks = useRef<Array<{ messageIds: string[]; entryId: string }>>([])
  const inFlight = useRef(false)
  const latest = useStableRef(options)
  const { conversationId, enabled, realtime } = options
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let timer: unknown
    const consumer = consumerId.current
    const scheduler = latest.current.scheduler ?? {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    const acknowledge = async (messageIds: string[], entryId: string) => {
      try {
        await latest.current.api.acknowledge(conversationId, consumer, messageIds, entryId)
        latest.current.onError?.(false)
      } catch {
        pendingAcks.current.push({ messageIds, entryId })
        latest.current.onError?.(true)
      }
    }
    const retryAcks = async () => {
      const retries = pendingAcks.current.splice(0)
      for (const retry of retries) await acknowledge(retry.messageIds, retry.entryId)
    }
    const presentBatch = async (fresh: AssistantMailboxUpdate[]) => {
      const batch = buildAssistantCatchUpBatch(fresh)
      if (!batch) return
      inFlight.current = true
      for (const id of batch.messageIds) received.current.add(id)
      const entry: AssistantEntry = {
        id: assistantBatchEntryId(batch.messageIds),
        role: 'tool',
        final: true,
        text: batch.messageIds.length > 1 ? 'Task updates' : 'Task update',
        toolName: 'assistant_inbox',
        toolResult: JSON.stringify(batch.summary),
        assistantUpdateIds: batch.messageIds,
      }
      try {
        await latest.current.append([entry])
      } catch {
        // Not saved: these updates must be presented again later rather than consumed.
        for (const id of batch.messageIds) received.current.delete(id)
        inFlight.current = false
        latest.current.onError?.(true)
        return
      }
      if (stopped) {
        // The surface closed before presentation started; the next consumer presents this batch.
        for (const id of batch.messageIds) received.current.delete(id)
        inFlight.current = false
        return
      }
      void (async () => {
        try {
          await latest.current.present(batch, entry)
          await acknowledge(batch.messageIds, entry.id)
        } catch {
          latest.current.onError?.(true)
        } finally {
          inFlight.current = false
        }
      })()
    }
    const appendReplies = async (fresh: AssistantMailboxUpdate[]) => {
      for (const update of fresh) {
        if (stopped) return
        received.current.add(update.messageId)
        const entry: AssistantEntry = {
          id: `inbox:${update.messageId}`,
          role: 'assistant',
          final: true,
          channel: 'text',
          text: update.content,
          assistantUpdateIds: [update.messageId],
        }
        try {
          await latest.current.append([entry])
        } catch {
          received.current.delete(update.messageId)
          latest.current.onError?.(true)
          return
        }
        await acknowledge([update.messageId], entry.id)
      }
    }
    const poll = async () => {
      try {
        const mailbox = await latest.current.api.inbox(conversationId, consumer)
        if (stopped) return
        latest.current.onError?.(false)
        latest.current.onMailbox?.({ pending: mailbox.pending, unavailable: mailbox.unavailable })
        if (mailbox.acquired) {
          await retryAcks()
          const fresh = mailbox.messages.filter((update) => !received.current.has(update.messageId))
          if (fresh.length && !inFlight.current) {
            if (realtime) await presentBatch(fresh)
            else await appendReplies(fresh)
          }
        }
      } catch {
        if (!stopped) latest.current.onError?.(true)
      } finally {
        if (!stopped)
          timer = scheduler.setTimeout(() => void poll(), latest.current.pollIntervalMs ?? ASSISTANT_INBOX_POLL_MS)
      }
    }
    void poll()
    return () => {
      stopped = true
      scheduler.clearTimeout(timer)
      void latest.current.api.release(conversationId, consumer).catch(() => {})
    }
  }, [conversationId, enabled, realtime, latest])
  return { consumerId: consumerId.current }
}
