import { createHash } from 'crypto'
import { Command, Option } from 'commander'
import { apiGet, apiGetRaw, apiPost } from '../client'
import { output, outputError, isJsonMode } from '../output'
import {
  isWorkspaceVoiceRecipient,
  parseAmtpAddress,
  type InboxMessage,
  type AgentFederationStatusResponse,
} from '@ficus/shared'
import { requireMatchingSigningIdentity } from '../amtp/identity'
import { buildFederatedSendBody, type FederatedAttachmentRef } from '../amtp/sign'

export function getInboxSendDeliveryMode(options: { followUp?: boolean }): 'steer' | 'follow-up' {
  return options.followUp ? 'follow-up' : 'steer'
}

export function collectAttachments(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function formatSender(m: InboxMessage): string {
  const senderMetadata = m.metadata?.sender as Record<string, string> | undefined
  const isWorkspaceVoiceSender = m.senderType === 'voice_assistant' && isWorkspaceVoiceRecipient(m.senderId)
  const name =
    m.senderAgent?.metadata?.name || senderMetadata?.name || (isWorkspaceVoiceSender ? 'Voice Workspace Agent' : '')
  const agentTypeName =
    senderMetadata?.agentTypeName ||
    senderMetadata?.agentTypeId ||
    (m.senderType === 'voice_assistant' ? 'voice_assistant' : '')
  const senderId = m.senderId ? `[${isWorkspaceVoiceSender ? m.senderId : m.senderId.slice(0, 8)}]` : ''
  return [name, agentTypeName ? `(${agentTypeName})` : '', senderId].filter(Boolean).join(' ') || m.senderType
}

/** Require live server readiness and matching delivered signing custody. */
async function resolveSelfIdentity(): Promise<{ address: string; privateKeyPem: string }> {
  const status = await apiGet<AgentFederationStatusResponse>('/api/amtp/agents/me/status')
  if (!status.registered || !status.federationReady || !status.address || status.signingIdentity.status !== 'ready') {
    throw new Error(status.signingIdentity.message ?? 'You are not federation-ready. Run: ficus remote whoami')
  }
  const { privateKeyPem } = requireMatchingSigningIdentity(status.signingIdentity.identityPublicKey)
  return { address: status.address, privateKeyPem }
}

/** Fetch an existing attachment and recompute its authoritative ref (matches the server's stored row). */
async function resolveAttachmentRef(attachmentId: string): Promise<FederatedAttachmentRef> {
  const res = await apiGetRaw(`/api/inbox/attachments/${attachmentId}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const disposition = res.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="?([^"]+)"?/)
  return {
    id: attachmentId,
    filename: match?.[1] || attachmentId,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

/** Map a local inbox message id to the remote envelope id it threads (wire reply target). */
async function resolveInReplyToEnvelopeId(localMessageId: string): Promise<string | undefined> {
  const message = await apiGet<InboxMessage>(`/api/inbox/message/${localMessageId}`)
  const remote = message.metadata?.remote as { envelopeId?: string } | undefined
  return remote?.envelopeId
}

/** Sign + send a `amtp://` message: upload(prior) -> ids -> sign -> send (C9 ordering). */
async function sendFederated(
  recipientId: string,
  content: string,
  options: { subject?: string; attach?: string[]; attachmentId?: string[]; inReplyTo?: string }
): Promise<void> {
  if (options.attach && options.attach.length > 0) {
    throw new Error(
      'Uploading new files to a remote recipient is not supported. Upload via "ficus inbox send <local> --attach" first, then reference the attachment id here with --attachment-id.'
    )
  }
  const { address: from, privateKeyPem } = await resolveSelfIdentity()
  const attachments: FederatedAttachmentRef[] = []
  for (const id of options.attachmentId ?? []) {
    attachments.push(await resolveAttachmentRef(id))
  }
  const inReplyToEnvelopeId = options.inReplyTo ? await resolveInReplyToEnvelopeId(options.inReplyTo) : undefined
  const body = buildFederatedSendBody({
    from,
    to: recipientId,
    subject: options.subject,
    content,
    attachments,
    inReplyToEnvelopeId,
    privateKeyPem,
  })
  const res = await apiPost<{ enqueued: boolean; outboxId: string }>('/api/inbox', body)
  output(res, `Federated message enqueued to ${recipientId} (outbox ${res.outboxId.slice(0, 8)})`)
}

export function registerInboxCommands(program: Command): void {
  const inbox = program.command('inbox').description('Unified inbox for agents, humans, and voice assistants')

  // ficus inbox send <recipientId> <content> -s <subject>
  // The sender is your authenticated identity (your agent/user) — you always author as yourself.
  inbox
    .command('send <recipientId> <content>')
    .description('Send a message as yourself (use "system" for the system inbox)')
    .option('-s, --subject <subject>', 'Message subject')
    .option(
      '--recipient-type <type>',
      'Recipient type (agent, user, voice_assistant, system). Defaults to system for recipient ID "system", otherwise agent.'
    )
    .option('--steer', 'Interrupt the recipient immediately (default)')
    .option('--follow-up', 'Queue until the recipient agent becomes idle')
    .option('--url <url>', 'URL to attach to message (used for push notification links)')
    .option('--attach <file>', 'Attach a file (repeatable)', collectAttachments, [])
    .option(
      '--attachment-id <id>',
      'Reference an existing inbox attachment by id (remote sends only; repeatable)',
      collectAttachments,
      []
    )
    .option(
      '--in-reply-to <messageId>',
      'Reply to an inbox message by its full message ID; also threads remote envelopes'
    )
    .addOption(
      new Option(
        '--assistant-task-status <status>',
        'Report the lifecycle state of a task delegated by a saved Assistant conversation (local voice_assistant replies only)'
      ).choices(['working', 'waiting', 'needs-input', 'completed', 'failed', 'cancelled'])
    )
    .action(async (recipientId, content, options) => {
      try {
        // Federation branch: an amtp:// recipient is signed in-sandbox and delivered to a remote peer.
        if (parseAmtpAddress(recipientId) !== null) {
          if (options.assistantTaskStatus) {
            throw new Error('--assistant-task-status applies only to local replies to an Assistant conversation')
          }
          await sendFederated(recipientId, content, options)
          return
        }

        const deliveryMode = getInboxSendDeliveryMode(options)
        const recipientType = options.recipientType ?? (recipientId === 'system' ? 'system' : 'agent')

        const metadata = options.url ? { url: options.url } : undefined

        const message = await apiPost<InboxMessage>('/api/inbox', {
          recipientType,
          recipientId,
          subject: options.subject,
          content,
          metadata,
          ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
          ...(options.assistantTaskStatus ? { assistantTaskStatus: options.assistantTaskStatus } : {}),
          deliveryMode,
        })

        const { readFile } = await import('fs/promises')
        const { basename } = await import('path')
        const { apiPostForm } = await import('../client')
        for (const filePath of (options.attach as string[]) ?? []) {
          const buf = await readFile(filePath)
          const form = new FormData()
          form.set('file', new File([buf], basename(filePath)))
          await apiPostForm(`/api/inbox/${message.id}/attachments`, form)
        }

        output(message, `Message sent to ${recipientId} (${message.id.slice(0, 8)})`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus inbox send-system <recipientId> <content> -s <subject>
  // Authors as "system" (automation). Requires the inbox:system permission.
  inbox
    .command('send-system <recipientId> <content>')
    .description('Send a message authored as "system" (requires the inbox:system permission)')
    .option('-s, --subject <subject>', 'Message subject')
    .option(
      '--recipient-type <type>',
      'Recipient type (agent, user, voice_assistant, system). Defaults to system for recipient ID "system", otherwise agent.'
    )
    .option('--url <url>', 'URL to attach to message (used for push notification links)')
    .action(async (recipientId, content, options) => {
      try {
        const recipientType = options.recipientType ?? (recipientId === 'system' ? 'system' : 'agent')

        const metadata = options.url ? { url: options.url } : undefined

        const message = await apiPost<InboxMessage>('/api/inbox', {
          recipientType,
          recipientId,
          asSystem: true,
          subject: options.subject,
          content,
          metadata,
        })
        output(message, `System message sent to ${recipientId} (${message.id.slice(0, 8)})`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus inbox download <attachmentId> [--out <path>]
  inbox
    .command('download <attachmentId>')
    .description('Download an inbox attachment to a file')
    .option('--out <path>', 'Output file path (defaults to the attachment filename)')
    .action(async (attachmentId, options) => {
      try {
        const { apiGetRaw } = await import('../client')
        const res = await apiGetRaw(`/api/inbox/attachments/${attachmentId}`)
        if (!res.ok) throw new Error(`Download failed (${res.status})`)
        const disposition = res.headers.get('content-disposition') || ''
        const match = disposition.match(/filename="?([^"]+)"?/)
        const outPath = options.out || match?.[1] || attachmentId
        const { writeFile } = await import('fs/promises')
        await writeFile(outPath, Buffer.from(await res.arrayBuffer()))
        output({ success: true, path: outPath })
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus inbox list [agent|human|voice_assistant] [id] --include-read --limit N
  inbox
    .command('list [type] [id]')
    .alias('ls')
    .description(
      'List inbox messages (type: agent|user|voice_assistant|system, id: agentId, "me", or "system"). Defaults to your own inbox. Shows unread only by default.'
    )
    // Sometimes agents pass --unread, which is the default, just ignore it.
    .option('-u, --unread', 'Show unread messages only (default)')
    .option('-a, --all', 'Include read messages (default: unread only)')
    .option('--limit <n>', 'Limit number of messages')
    .action(async (type, id, options) => {
      try {
        // Default to human inbox
        const recipientType = type || 'user'
        const recipientId = id || 'me'

        const params = new URLSearchParams()
        // API defaults to unread-only; pass all=true to include read messages
        if (options.all) params.set('all', 'true')
        if (options.limit) params.set('limit', options.limit)
        const query = params.toString() ? `?${params}` : ''

        // Unified route: GET /api/inbox/:type/:id
        const url = `/api/inbox/${recipientType}/${recipientId}${query}`

        const messages = await apiGet<InboxMessage[]>(url)

        if (isJsonMode()) {
          output(messages)
        } else {
          if (messages.length === 0) {
            console.log('No messages')
            return
          }
          for (const m of messages) {
            const read = m.readAt ? '✓' : '•'
            const time = new Date(m.createdAt).toLocaleString()
            console.log(`${read} [${m.id.slice(0, 8)}] ${time}`)
            console.log(`  From: ${formatSender(m)}`)
            if (m.subject) console.log(`  Subject: ${m.subject}`)
            console.log(`  ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`)
            console.log()
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus inbox count [agent|human] [id]
  inbox
    .command('count [type] [id]')
    .description('Get unread message count')
    .action(async (type, id) => {
      try {
        const recipientType = type || 'user'
        const recipientId = id || 'me'

        // Unified route: GET /api/inbox/:type/:id/count
        const url = `/api/inbox/${recipientType}/${recipientId}/count`

        const result = await apiGet<{ count: number }>(url)
        if (isJsonMode()) {
          output(result)
        } else {
          console.log(`${result.count} unread message(s)`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus inbox read <messageIds...>
  inbox
    .command('read <messageIds...>')
    .description('Mark one or more messages as read')
    .action(async (messageIds: string[]) => {
      try {
        const results: string[] = []
        const errors: string[] = []
        for (const messageId of messageIds) {
          try {
            await apiPost(`/api/inbox/${messageId}/read`, {})
            results.push(messageId)
          } catch (e) {
            errors.push(`${messageId.slice(0, 8)}: ${(e as Error).message}`)
          }
        }
        if (results.length > 0) {
          const ids = results.map((id) => id.slice(0, 8)).join(', ')
          output({ messageIds: results }, `Marked ${results.length} message(s) as read: ${ids}`)
        }
        if (errors.length > 0) {
          for (const err of errors) console.error(`Error: ${err}`)
          if (results.length === 0) process.exit(1)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus inbox read-all [agent|human] [id]
  inbox
    .command('read-all [type] [id]')
    .description('Mark all messages as read')
    .action(async (type, id) => {
      try {
        const recipientType = type || 'user'
        const recipientId = id || 'me'

        // Unified route: POST /api/inbox/:type/:id/read-all
        const url = `/api/inbox/${recipientType}/${recipientId}/read-all`

        await apiPost(url, {})
        output({}, 'Marked all messages as read')
      } catch (error) {
        outputError(error as Error)
      }
    })
}
