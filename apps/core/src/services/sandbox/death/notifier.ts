import { SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import { withDedicatedDbTransaction } from '../../../db'
import { inbox } from '../../../db/schema'
import { createLogger } from '../../../lib/infra/logger'
import { getSquadIdFromSandbox } from '../types'
import { classifySandboxDeath } from './classifier'
import type { SandboxDeathClassification, SandboxDeathObservation } from './types'
import type { SendInboxMessageInput } from '../../../entities/InboxMessage'

const log = createLogger('sandbox-death-notifier')

class PersistentSandboxDeathNotificationDedupe implements SandboxDeathNotificationDedupe {
  constructor(private readonly lookbackMs = 30 * 60_000) {}

  async claim(key: string, notify: () => Promise<void>): Promise<boolean> {
    const separator = key.indexOf('|')
    const sandboxId = separator === -1 ? key : key.slice(0, separator)
    const signature = separator === -1 ? '' : key.slice(separator + 1)
    const cutoff = new Date(Date.now() - this.lookbackMs)

    // Dedicated connection, NOT the shared pool: `notify()` runs inside this
    // transaction and sends through InboxMessage.send on the pool — holding a
    // pool slot while waiting for another self-deadlocks under a burst of
    // sandbox deaths (the exact moment this code runs).
    return withDedicatedDbTransaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sandbox-death:${key}`}))`)

      const existing = await tx
        .select({ id: inbox.id })
        .from(inbox)
        .where(
          and(
            eq(inbox.recipientType, 'system'),
            eq(inbox.recipientId, SYSTEM_RECIPIENT_ID),
            eq(inbox.senderType, 'system'),
            gte(inbox.createdAt, cutoff),
            sql`${inbox.metadata}->>'source' = 'sandbox-death'`,
            sql`${inbox.metadata}->>'sandboxId' = ${sandboxId}`,
            sql`${inbox.metadata}->>'signature' = ${signature}`
          )
        )
        .limit(1)

      if (existing.length > 0) return false
      await notify()
      return true
    })
  }
}

export interface SandboxDeathNotificationDedupe {
  claim(key: string, notify: () => Promise<void>): Promise<boolean>
}

export interface SandboxDeathNotifierOptions {
  classify?: (obs: SandboxDeathObservation) => SandboxDeathClassification
  send?: (message: SendInboxMessageInput) => Promise<unknown>
  resolveSquadName?: (squadId: string) => Promise<string>
  throttleMs?: number
  dedupe?: SandboxDeathNotificationDedupe
}

export class SandboxDeathNotifier {
  private readonly notified = new Map<string, { signature: string; at: number }>()
  private readonly classify: (obs: SandboxDeathObservation) => SandboxDeathClassification
  private readonly send: (message: SendInboxMessageInput) => Promise<unknown>
  private readonly resolveSquadName: (squadId: string) => Promise<string>
  private readonly dedupe: SandboxDeathNotificationDedupe | null

  constructor(opts: SandboxDeathNotifierOptions = {}) {
    this.classify = opts.classify ?? classifySandboxDeath
    this.send =
      opts.send ??
      (async (message) => {
        const { InboxMessage } = await import('../../../entities/InboxMessage')
        return InboxMessage.send(message)
      })
    this.resolveSquadName =
      opts.resolveSquadName ??
      (async (squadId) => {
        const { Squad } = await import('../../../entities/Squad')
        return (await Squad.find(squadId))?.name ?? squadId
      })
    this.dedupe = opts.dedupe ?? (opts.send ? null : new PersistentSandboxDeathNotificationDedupe(opts.throttleMs))
  }

  clear(sandboxId: string): void {
    this.notified.delete(sandboxId)
  }

  async maybeNotify(obs: SandboxDeathObservation): Promise<{ notified: boolean }> {
    try {
      const classification = this.classify(obs)
      if (classification !== 'unexpected' && classification !== 'oom') return { notified: false }
      const squadId = getSquadIdFromSandbox(obs.sandboxId)
      if (!squadId) return { notified: false }

      const signature = `${classification}|${obs.signal}|${obs.reason ?? ''}|${obs.message ?? ''}|${
        obs.startedAt ?? obs.exitCode ?? ''
      }`
      const now = Date.now()
      const existing = this.notified.get(obs.sandboxId)
      if (existing?.signature === signature) {
        return { notified: false }
      }

      this.notified.set(obs.sandboxId, { signature, at: now })
      const dedupeKey = `${obs.sandboxId}|${signature}`
      const notify = async () => {
        const squadName = await this.resolveSquadName(squadId)
        const message = buildSandboxDeathMessage({ obs, squadId, squadName, classification })

        await this.send({
          recipientType: 'system',
          recipientId: SYSTEM_RECIPIENT_ID,
          senderType: 'system',
          wakeEligible: false,
          ...message,
          metadata: {
            source: 'sandbox-death',
            classification,
            squadId,
            sandboxId: obs.sandboxId,
            runtime: obs.runtime,
            signal: obs.signal,
            reason: obs.reason,
            message: obs.message,
            exitCode: obs.exitCode,
            memoryLimit: obs.memoryLimit,
            signature,
          },
        })
      }

      const notified = this.dedupe ? await this.dedupe.claim(dedupeKey, notify) : (await notify(), true)
      return { notified }
    } catch (err) {
      log.warn(`Failed to notify about sandbox death for ${obs.sandboxId}:`, err)
      return { notified: false }
    }
  }
}

function buildSandboxDeathMessage(args: {
  obs: SandboxDeathObservation
  squadId: string
  squadName: string
  classification: Extract<SandboxDeathClassification, 'unexpected' | 'oom'>
}): Pick<SendInboxMessageInput, 'subject' | 'content'> {
  const { obs, squadId, squadName, classification } = args
  const exitCodeLine = obs.exitCode === undefined ? '' : `\n- Exit code: ${obs.exitCode}`
  const messageLine = obs.message === undefined ? '' : `\n- Message: ${obs.message}`

  if (classification === 'oom') {
    const memoryLimitLine = obs.memoryLimit === undefined ? '' : `\n- Configured memory limit: ${obs.memoryLimit}`

    return {
      subject: `⚠️ Squad sandbox OOM-killed: ${squadName}`,
      content:
        `The sandbox for squad **${squadName}** (\`${squadId}\`) exceeded its memory limit and was OOM-killed.\n\n` +
        `- Runtime: ${obs.runtime}\n` +
        `- Sandbox: \`${obs.sandboxId}\`\n` +
        `- Signal: ${obs.signal}\n` +
        `- Reason: ${obs.reason ?? 'unknown'}${exitCodeLine}${messageLine}${memoryLimitLine}\n\n` +
        'This often happens after a heavy command such as full-repo linting, building, or testing. ' +
        'Try to reduce the command scope (for example, run the linter or tests on the affected package/files first) ' +
        'or, if the workload really needs more memory, consider requesting a higher memory limit.',
    }
  }

  return {
    subject: `⚠️ Squad sandbox stopped unexpectedly: ${squadName}`,
    content:
      `The sandbox for squad **${squadName}** (\`${squadId}\`) stopped unexpectedly.\n\n` +
      `- Runtime: ${obs.runtime}\n` +
      `- Sandbox: \`${obs.sandboxId}\`\n` +
      `- Signal: ${obs.signal}\n` +
      `- Reason: ${obs.reason ?? 'unknown'}${exitCodeLine}${messageLine}\n\n` +
      'This usually indicates a host/device issue (eviction or node failure) rather than a normal stop. ' +
      'Ficus will automatically recreate the sandbox on the next agent activity (always-on squads are restored within ~60s by the reconciliation loop). No action is required unless the problem repeats.',
  }
}

export const sandboxDeathNotifier = new SandboxDeathNotifier()
