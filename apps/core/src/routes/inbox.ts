import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import {
  sendInboxMessageSchema,
  SYSTEM_RECIPIENT_ID,
  isSelfRecipientShorthand,
  workspaceVoiceRecipientId,
  parseWorkspaceVoiceUserId,
  parseAssistantInboxConversationId,
  canonicalAgentSigBytes,
  formatAmtpAddress,
  Permissions,
  type InboxRecipientType,
  type InboxMessageSenderType,
  type AmtpAttachmentRef,
} from '@ficus/shared'
import { assistantInboxOwner } from '../services/assistant-inbox'
import { InboxMessage } from '../entities/InboxMessage'
import { InboxAttachment } from '../entities/InboxAttachment'
import { readAttachmentFile as readAttachmentBytes } from '../services/inbox/attachment-storage'
import { Agent, AgentTargetUnavailableError } from '../entities/Agent'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { hasAgentResourcePermission, hasPermission, resolveActingUser } from '../services/rbac'
import type { Identity } from '../services/rbac'
import { parseAmtpAddress } from '../services/amtp/address'
import { verifyEnvelope } from '../services/amtp/crypto'
import { enqueueFederatedSend } from '../services/amtp/send'

// Helper to validate recipient type
function isValidRecipientType(type: string): type is InboxRecipientType {
  return type === 'agent' || type === 'user' || type === 'voice_assistant' || type === 'system'
}

// Resolve the path/body recipient id to the concrete recipient the request is scoped to.
// - user: 'me'/'user' shorthand → the authenticated user's own id (per-user inbox).
// - voice_assistant: 'me'/'user'/'workspace' shorthand → workspace:<userId> for the caller.
// - system: always the reserved SYSTEM_RECIPIENT_ID.
// Returns null when a shorthand has no verified acting user.
async function resolveRecipientId(
  type: InboxRecipientType,
  id: string,
  identity: Identity | undefined
): Promise<string | null> {
  const user = await resolveActingUser(identity)
  if (type === 'system') return SYSTEM_RECIPIENT_ID
  if (type === 'user') {
    if (isSelfRecipientShorthand(id)) return user?.userId ?? null
    return id
  }
  if (type === 'voice_assistant') {
    if (isSelfRecipientShorthand(id) || id === 'workspace') {
      return user ? workspaceVoiceRecipientId(user.userId) : null
    }
    return id
  }
  return id
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
}

// System managers share their owner’s per-user read state. Identities without a
// verified user fall back to null (read state is a no-op).
async function systemReaderUserId(identity: Identity | undefined): Promise<string | null> {
  return (await resolveActingUser(identity))?.userId ?? null
}

async function canAccessRecipientInbox(
  identity: Identity | undefined,
  type: InboxRecipientType,
  recipientId: string,
  permission: 'inbox:read' | 'inbox:write'
): Promise<Response | null> {
  if (!identity) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })

  if (identity.type === 'agent' && type === 'agent') {
    const targetAgent = await Agent.find(recipientId)
    if (!targetAgent) return forbidden()
    if (!targetAgent.squadId) {
      return (await hasAgentResourcePermission(identity, targetAgent, permission)) ? null : forbidden()
    }
    // Squad-scoped agents may touch their own inbox. Cross-agent reads require
    // the dedicated squad permission; cross-agent writes remain forbidden.
    if (identity.agentId === recipientId) return null
    if (permission === Permissions.INBOX_WRITE) return forbidden()
    return (await hasPermission(identity, Permissions.INBOX_READ_SQUAD, targetAgent.squadId)) ? null : forbidden()
  }

  const user = await resolveActingUser(identity)
  if (identity.type === 'agent' && type !== 'agent' && !user) {
    return forbidden()
  }

  if (type === 'agent') {
    const agent = await Agent.find(recipientId)
    if (!agent) return forbidden()
    return (await hasAgentResourcePermission(identity, agent, permission)) ? null : forbidden()
  }

  // A user may only access their own personal inbox.
  if (type === 'user') {
    return user?.userId === recipientId ? null : forbidden()
  }

  // A user may only access their own per-user voice (workspace:<userId>) inbox.
  if (type === 'voice_assistant') {
    if (parseAssistantInboxConversationId(recipientId))
      return user && (await assistantInboxOwner(recipientId)) === user.userId ? null : forbidden()
    return user && parseWorkspaceVoiceUserId(recipientId) === user.userId ? null : forbidden()
  }

  // The shared system inbox requires the inbox:system permission.
  if (type === 'system') {
    return (await hasPermission(identity, 'inbox:system')) ? null : forbidden()
  }

  return forbidden()
}

async function canAccessAttachment(
  identity: Identity | undefined,
  attachmentId: string,
  permission: 'inbox:read' | 'inbox:write'
) {
  if (!identity) return { response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
  const attachment = await InboxAttachment.findById(attachmentId)
  if (!attachment) return { response: forbidden() }
  const message = await InboxMessage.find(attachment.messageId)
  if (!message) return { response: forbidden() }
  const response = await canAccessRecipientInbox(identity, message.recipientType, message.recipientId, permission)
  return response ? { response, attachment, message } : { attachment, message }
}

async function canAccessMessage(
  identity: Identity | undefined,
  messageId: string,
  permission: 'inbox:read' | 'inbox:write' = 'inbox:write'
) {
  if (!identity) return { response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
  const message = await InboxMessage.find(messageId)
  if (!message) return { response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) }
  const response = await canAccessRecipientInbox(identity, message.recipientType, message.recipientId, permission)
  return response ? { response } : { message }
}

// Unified inbox router (mounted at /api/inbox)
export const inboxRouter = new Hono()

  // === Unified routes for both agents and humans ===

  // GET /api/inbox/message/:messageId — fetch one message (with its real content) by id.
  // Registered before /:type/:id so the static "message" segment wins.
  .get('/message/:messageId', async (c) => {
    const messageId = c.req.param('messageId')
    const result = await canAccessMessage(c.get('identity'), messageId, 'inbox:read')
    if (result.response) return result.response
    const message = result.message
    c.set('authzChecked', true)
    await InboxAttachment.attachTo([message])
    return c.json(message.toJson())
  })

  // GET /api/inbox/attachments/:attachmentId — stream attachment bytes.
  // Registered before /:type/:id so "attachments" is not captured as :type.
  .get('/attachments/:attachmentId', async (c) => {
    const result = await canAccessAttachment(c.get('identity'), c.req.param('attachmentId'), 'inbox:read')
    if (result.response) return result.response
    const att = result.attachment
    c.set('authzChecked', true)
    let bytes: Buffer
    try {
      bytes = await readAttachmentBytes(att.storagePath)
    } catch {
      return c.json({ error: 'Attachment not found' }, 404)
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': att.contentType,
        'Content-Disposition': `attachment; filename="${att.filename.replace(/"/g, '')}"`,
        'Content-Length': String(att.byteSize),
      },
    })
  })

  // DELETE /api/inbox/attachments/:attachmentId — author/operator (inbox:write) removes it.
  .delete('/attachments/:attachmentId', async (c) => {
    const identity: Identity | undefined = c.get('identity')
    const result = await canAccessAttachment(identity, c.req.param('attachmentId'), 'inbox:write')
    if (result.response) {
      const override =
        result.attachment &&
        identity &&
        (identity.type !== 'agent' || (await resolveActingUser(identity))) &&
        (await hasPermission(identity, 'inbox:write'))
      if (!override) return result.response
    }
    const att = result.attachment!
    c.set('authzChecked', true)
    await att.delete()
    return c.json({ success: true })
  })

  // GET /api/inbox/:type/:id — list messages (defaults to unread-only)
  .get('/:type/:id', async (c) => {
    const type = c.req.param('type')
    const id = c.req.param('id')

    if (!isValidRecipientType(type)) {
      return c.json({ error: 'Invalid recipient type. Must be "agent", "user", "voice_assistant", or "system"' }, 400)
    }

    const recipientId = await resolveRecipientId(type, id, c.get('identity'))
    if (recipientId === null) return c.json({ error: 'Forbidden' }, 403)
    const denial = await canAccessRecipientInbox(c.get('identity'), type, recipientId, 'inbox:read')
    if (denial) return denial
    c.set('authzChecked', true)

    const includeRead = c.req.query('includeRead') === 'true' || c.req.query('all') === 'true'
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined
    const offset = c.req.query('offset') ? parseInt(c.req.query('offset')!) : undefined
    const cursor = c.req.query('cursor')
    const readStateParam = c.req.query('readState')
    const readState =
      readStateParam === 'read' || readStateParam === 'unread' || readStateParam === 'all'
        ? readStateParam
        : includeRead
          ? 'all'
          : 'unread'

    if (limit !== undefined) {
      const pageLimit = Math.min(Math.max(limit || 50, 1), 200)
      const search = c.req.query('search') || undefined
      const uid = type === 'system' ? await systemReaderUserId(c.get('identity')) : null
      const page =
        type === 'system' && uid
          ? await InboxMessage.listSystemPageForUser(uid, {
              limit: pageLimit,
              cursorId: cursor,
              readState,
              search,
            })
          : await InboxMessage.listPageForRecipient(type, recipientId, {
              limit: pageLimit,
              cursorId: cursor,
              readState,
              search,
            })
      await InboxAttachment.attachTo(page.items)
      return c.json({
        items: page.items.map((m) => m.toJson()),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        totalCount: page.totalCount,
      })
    }

    if (type === 'system') {
      const uid = await systemReaderUserId(c.get('identity'))
      const messages = uid
        ? await InboxMessage.listSystemForUser(uid, { limit, offset, includeRead })
        : await InboxMessage.listForRecipient(type, recipientId, { limit, offset, includeRead: true })
      await InboxAttachment.attachTo(messages)
      return c.json(messages.map((m) => m.toJson()))
    }

    const messages = await InboxMessage.listForRecipient(type, recipientId, { limit, offset, includeRead })
    await InboxAttachment.attachTo(messages)
    return c.json(messages.map((m) => m.toJson()))
  })

  // GET /api/inbox/:type/:id/count — get unread count
  .get('/:type/:id/count', async (c) => {
    const type = c.req.param('type')
    const id = c.req.param('id')

    if (!isValidRecipientType(type)) {
      return c.json({ error: 'Invalid recipient type. Must be "agent", "user", "voice_assistant", or "system"' }, 400)
    }

    const recipientId = await resolveRecipientId(type, id, c.get('identity'))
    if (recipientId === null) return c.json({ error: 'Forbidden' }, 403)
    const denial = await canAccessRecipientInbox(c.get('identity'), type, recipientId, 'inbox:read')
    if (denial) return denial
    c.set('authzChecked', true)

    if (type === 'system') {
      const uid = await systemReaderUserId(c.get('identity'))
      return c.json({ count: uid ? await InboxMessage.getSystemUnreadCount(uid) : 0 })
    }

    const count = await InboxMessage.getUnreadCount(type, recipientId)
    return c.json({ count })
  })

  // POST /api/inbox/:type/:id/read-all — mark all messages as read
  .post('/:type/:id/read-all', async (c) => {
    const type = c.req.param('type')
    const id = c.req.param('id')

    if (!isValidRecipientType(type)) {
      return c.json({ error: 'Invalid recipient type. Must be "agent", "user", "voice_assistant", or "system"' }, 400)
    }

    const recipientId = await resolveRecipientId(type, id, c.get('identity'))
    if (recipientId === null) return c.json({ error: 'Forbidden' }, 403)
    const denial = await canAccessRecipientInbox(c.get('identity'), type, recipientId, 'inbox:write')
    if (denial) return denial
    c.set('authzChecked', true)

    if (type === 'system') {
      const uid = await systemReaderUserId(c.get('identity'))
      if (uid) await InboxMessage.markAllSystemRead(uid)
      return c.json({ success: true })
    }

    await InboxMessage.markAllAsRead(type, recipientId)
    return c.json({ success: true })
  })

  // === Send and single-message routes ===

  // POST /api/inbox — send message (any-to-any)
  // Squad membership rules for agent-to-agent communication are enforced in the service
  .post('/', zValidator('json', sendInboxMessageSchema), async (c) => {
    const body = c.req.valid('json')
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)

    // Task lifecycle facts are server-owned metadata; a client may report status only through the
    // validated top-level field, and only for a local reply to a saved Assistant conversation.
    if (body.metadata && ('assistantTaskStatus' in body.metadata || 'assistantTaskId' in body.metadata)) {
      return c.json({ error: 'metadata.assistantTaskStatus and metadata.assistantTaskId are server-owned' }, 400)
    }
    if (
      body.assistantTaskStatus !== undefined &&
      (parseAmtpAddress(body.recipientId) !== null ||
        body.recipientType !== 'voice_assistant' ||
        !parseAssistantInboxConversationId(body.recipientId))
    ) {
      return c.json(
        { error: 'assistantTaskStatus applies only to local replies sent to a saved Assistant conversation' },
        400
      )
    }

    // FIX 3: reject a `amtp://`-prefixed recipient that is not a valid federation address early,
    // before falling through to the local path (which would surface a confusing Postgres uuid error).
    if (body.recipientId.startsWith('amtp://') && parseAmtpAddress(body.recipientId) === null) {
      return c.json({ error: 'invalid federation address' }, 400)
    }

    // Outbound federation branch: a `amtp://<instanceId>/<handle>` recipient is delivered to a
    // remote peer via the outbox rather than the local inbox. The sender is the authenticated
    // agent; its `amtpHandle` is the envelope `from`. Local sends fall through unchanged.
    if (parseAmtpAddress(body.recipientId) !== null) {
      const agent = identity.type === 'agent' ? await Agent.find(identity.agentId) : null
      // Permission gate first (amtp:send is role-granted — default-manager/default-manager —
      // plus optional per-agent-type scopes: top-ups or per-agent grants; admin '*' also passes).
      if (!(await hasPermission(identity, 'amtp:send', agent?.squadId ?? undefined))) {
        return c.json({ error: 'Forbidden' }, 403)
      }
      // The from-handle is the sending agent's federation handle.
      if (!agent?.amtpHandle) {
        return c.json({ error: 'sender not federation-registered' }, 400)
      }

      // Resolve attachment refs (shared by signed + unsigned paths). Bind agentSig to sha256+metadata.
      let attachments: AmtpAttachmentRef[] | undefined
      if (body.attachmentIds && body.attachmentIds.length > 0) {
        const refs: AmtpAttachmentRef[] = []
        for (const attId of body.attachmentIds) {
          const att = await InboxAttachment.findById(attId)
          if (!att) return c.json({ error: 'Unknown attachment' }, 400)
          const parent = await InboxMessage.find(att.messageId)
          if (!parent) return c.json({ error: 'Attachment not accessible' }, 400)
          // null = allowed, Response = denied. Use the denial pattern — NEVER `!(...)`.
          const denial = await canAccessRecipientInbox(identity, parent.recipientType, parent.recipientId, 'inbox:read')
          if (denial) return c.json({ error: 'Attachment not accessible' }, 400)
          refs.push({
            id: att.id,
            filename: att.filename,
            contentType: att.contentType,
            byteSize: att.byteSize,
            sha256: att.sha256,
          })
        }
        attachments = refs
      }

      let toAddress = body.recipientId
      let inReplyToEnvelopeId: string | undefined
      let sendId: string | undefined

      if (body.agentSig) {
        // --- Signed path (D7): enforce authorship; use the CLI-resolved `to` verbatim;
        //     thread via inReplyToEnvelopeId; SKIP the remote-origin rewrite below. ---
        if (!agent.identityPublicKey) return c.json({ error: 'agent identity not provisioned' }, 400)
        if (body.agentKey !== agent.identityPublicKey)
          return c.json({ error: 'agentKey does not match agent identity' }, 400)

        const { instanceId } = await InstanceIdentity.getPublic()
        const subjectTrim = body.subject?.trim()
        const sigBytes = canonicalAgentSigBytes({
          v: 1,
          id: body.id ?? '',
          from: formatAmtpAddress(instanceId, agent.amtpHandle),
          to: body.recipientId,
          subject: subjectTrim || undefined,
          content: body.content,
          attachments: (attachments ?? []).map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            byteSize: a.byteSize,
            sha256: a.sha256,
          })),
        })
        if (!body.id || !verifyEnvelope(agent.identityPublicKey, sigBytes, body.agentSig)) {
          return c.json({ error: 'agentSig verification failed' }, 400)
        }
        inReplyToEnvelopeId = body.inReplyToEnvelopeId
        sendId = body.id
      } else if (body.inReplyTo) {
        // --- Unsigned path: legacy remote-origin threading rewrite (unchanged behavior). ---
        try {
          const original = await InboxMessage.find(body.inReplyTo)
          // FIX 1+2: only honor the remote-origin override when ALL of:
          //   - the original exists (not-found → degrade to plain send)
          //   - it was addressed TO the SENDING agent (ownership guard)
          //   - it is a remote-origin message (senderType === 'remote' with metadata.remote)
          // Any other case — local message, wrong recipient, or bad reference — falls through
          // to the explicit `to` address with no threading.
          if (
            original &&
            original.recipientType === 'agent' &&
            original.recipientId === agent.id &&
            original.senderType === 'remote'
          ) {
            const remote = original.metadata?.remote as { fromAddress?: string; envelopeId?: string } | undefined
            if (remote) {
              if (remote.fromAddress) toAddress = remote.fromAddress
              inReplyToEnvelopeId = remote.envelopeId
            }
          }
        } catch {
          // FIX 1: any error (e.g. malformed UUID → Postgres 22P02) or not-found:
          // treat as "no original" — degrade gracefully, do NOT 500.
        }
      }

      c.set('authzChecked', true)
      const outboxRow = await enqueueFederatedSend({
        fromHandle: agent.amtpHandle,
        toAddress,
        subject: body.subject,
        content: body.content,
        inReplyTo: inReplyToEnvelopeId,
        attachments,
        id: sendId,
        agentKey: body.agentSig ? body.agentKey : undefined,
        agentSig: body.agentSig,
      })
      return c.json({ enqueued: true, outboxId: outboxRow.id }, 202)
    }

    // Local-path guard (M3): attachmentIds is valid only for federated sends.
    if (body.attachmentIds && body.attachmentIds.length > 0) {
      return c.json({ error: 'attachments on local sends use POST /:messageId/attachments' }, 400)
    }

    // Resolve recipient self-shorthands ('me'/'user'/'workspace') against the caller's identity.
    const recipientType = body.recipientType
    let recipientId = body.recipientId
    const recipientUser = await resolveActingUser(identity)
    if (recipientUser) {
      if (recipientType === 'user' && isSelfRecipientShorthand(recipientId)) {
        recipientId = recipientUser.userId
      }
      if (
        recipientType === 'voice_assistant' &&
        (isSelfRecipientShorthand(recipientId) || recipientId === 'workspace')
      ) {
        recipientId = workspaceVoiceRecipientId(recipientUser.userId)
      }
    }
    if (recipientType === 'system') recipientId = SYSTEM_RECIPIENT_ID

    // Reject unresolved self-shorthands ('me'/'user') for non-user callers.
    // These are self-reference shorthands that only resolve for authenticated user
    // identities and their verified system managers.
    if (recipientType === 'user' && isSelfRecipientShorthand(recipientId) && !recipientUser) {
      return c.json(
        {
          error:
            "'me'/'user' is a self-reference shorthand for authenticated users and their system managers. Use a concrete user ID (with --recipient-type user) or 'system' for the shared system inbox.",
        },
        403
      )
    }

    // The sender is derived from the authenticated identity — a caller can only ever author as
    // themselves (their user, their agent, or their own voice assistant), never as another agent or
    // another user. inbox:write grants authoring-as-yourself; authoring as "system" (automation,
    // e.g. webhooks) is a separate capability gated by the stronger inbox:system permission.
    let senderType: InboxMessageSenderType
    let senderId: string | undefined
    if (body.asSystem) {
      if (!(await hasPermission(identity, 'inbox:system'))) return c.json({ error: 'Forbidden' }, 403)
      senderType = 'system'
      senderId = undefined
    } else if (identity.type === 'agent') {
      senderType = 'agent'
      senderId = identity.agentId
    } else if (identity.type === 'user') {
      if (!(await hasPermission(identity, 'inbox:write'))) return c.json({ error: 'Forbidden' }, 403)
      if (body.asVoiceAssistant) {
        senderType = 'voice_assistant'
        senderId = workspaceVoiceRecipientId(identity.userId)
      } else {
        senderType = 'user'
        senderId = identity.userId
      }
    } else {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Posting to the shared system inbox requires inbox:system.
    if (recipientType === 'system' && !(await hasPermission(identity, 'inbox:system'))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    c.set('authzChecked', true)
    try {
      const message = await InboxMessage.send({
        recipientType,
        recipientId,
        senderType,
        senderId,
        subject: body.subject,
        content: body.content,
        metadata: { ...body.metadata, ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}) },
        deliveryMode: body.deliveryMode,
        assistantTaskStatus: body.assistantTaskStatus,
      })
      return c.json(message.toJson(), 201)
    } catch (error) {
      if (error instanceof AgentTargetUnavailableError) return c.json({ error: error.message, code: error.code }, 409)
      const msg = error instanceof Error ? error.message : 'Failed to send message'
      // Map error messages to appropriate HTTP status codes
      let status: 400 | 403 | 404 = 400
      if (msg.includes('not found')) {
        status = 404
      } else if (
        msg.includes('must belong to squads') ||
        msg.includes('Only squad managers') ||
        msg.includes('can only be sent to') ||
        msg.includes('not connected')
      ) {
        status = 403
      }
      return c.json({ error: msg }, status)
    }
  })

  // POST /api/inbox/:messageId/read — mark single message as read
  .post('/:messageId/read', async (c) => {
    const messageId = c.req.param('messageId')
    const result = await canAccessMessage(c.get('identity'), messageId)
    if (result.response) return result.response
    c.set('authzChecked', true)
    // Shared system messages track read state per-reader, not on the shared row.
    if (result.message.recipientType === 'system') {
      const uid = await systemReaderUserId(c.get('identity'))
      if (uid) await InboxMessage.markSystemMessageRead(result.message.id, uid)
      return c.json({ success: true })
    }
    await result.message.markAsRead()
    return c.json({ success: true })
  })

  // POST /api/inbox/:messageId/attachments — multipart upload of one file (field "file").
  .post('/:messageId/attachments', async (c) => {
    const messageId = c.req.param('messageId')
    const result = await canAccessMessage(c.get('identity'), messageId)
    if (result.response) return result.response
    c.set('authzChecked', true)

    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return c.json({ error: 'Missing "file" upload' }, 400)
    const bytes = new Uint8Array(await file.arrayBuffer())

    try {
      const att = await InboxAttachment.create({
        messageId,
        filename: file.name || 'attachment',
        contentType: file.type || 'application/octet-stream',
        bytes,
      })
      return c.json(att.toJson(), 201)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      if (msg === 'ATTACHMENT_TOO_LARGE' || msg === 'INBOX_STORAGE_QUOTA_EXCEEDED') {
        return c.json({ error: msg }, 413)
      }
      return c.json({ error: msg }, 400)
    }
  })
