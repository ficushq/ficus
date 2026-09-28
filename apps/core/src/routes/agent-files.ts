import { Hono } from 'hono'
import { isReferencableAgentAttachmentPath } from '@ficus/shared'
import { Agent } from '../entities/Agent'
import { AgentFileAttachment, agentVisibleAttachmentPath } from '../entities/AgentFileAttachment'
import { requireEntityPermission } from '../middleware/require-entity-permission'
import type { Identity } from '../services/rbac'
import { InvalidAttachmentError, resolveAttachmentScope } from '../services/attachments/agent-scope'
import { deleteMaterializedAttachment, materializeAttachmentBytes } from '../services/attachments/materialize'
import { deleteAgentAttachmentBlob } from '../services/attachments/blob-storage'
import { getSettingsStore } from '../services/settings'
import { getAgentPrivateStoragePath } from '../services/sandbox/ensure'
import { ensureAgentSandbox } from '../services/sandbox/agent-warmup'
import { getSandboxManager, isVmRuntime } from '../services/sandbox'
import type { VmSandboxManager } from '../services/sandbox/vm/manager'

async function agentSquadId(id: string) {
  return (await Agent.find(id))?.squadId ?? null
}
async function agentOwnerUserId(id: string) {
  return (await Agent.find(id))?.ownerUserId ?? null
}
const sendPermission = requireEntityPermission('chat:send', (c) => agentSquadId(c.req.param('agentId')), {
  loadOwnerUserId: (c) => agentOwnerUserId(c.req.param('agentId')),
})
const readPermission = requireEntityPermission('agents:read', (c) => agentSquadId(c.req.param('agentId')), {
  loadOwnerUserId: (c) => agentOwnerUserId(c.req.param('agentId')),
})

async function deleteMaterializedForTarget(target: Agent, attachment: AgentFileAttachment): Promise<void> {
  if (!isVmRuntime()) {
    await deleteMaterializedAttachment(
      getAgentPrivateStoragePath(attachment.sandboxId),
      attachment.id,
      attachment.storedName
    )
    return
  }
  const manager = getSandboxManager() as VmSandboxManager
  const client = await manager.getOrAttachClient(attachment.sandboxId)
  if (!client) return
  await client.deleteMaterializedAttachment({
    privateRoot: '/private',
    attachmentId: attachment.id,
    storedName: attachment.storedName,
  })
}

async function materializeForTarget(target: Agent, attachment: AgentFileAttachment): Promise<void> {
  const bytes = await attachment.readVerifiedBlob()
  if (!isVmRuntime()) {
    await materializeAttachmentBytes(
      getAgentPrivateStoragePath(attachment.sandboxId),
      attachment.id,
      attachment.storedName,
      bytes
    )
    return
  }
  const manager = getSandboxManager() as VmSandboxManager
  let client = await manager.getOrAttachClient(attachment.sandboxId)
  if (!client) {
    await ensureAgentSandbox(target)
    client = await manager.getOrAttachClient(attachment.sandboxId)
  }
  if (!client) throw new Error('Agent private workspace unavailable')
  await client.materializeAttachment({
    privateRoot: '/private',
    attachmentId: attachment.id,
    storedName: attachment.storedName,
    content: bytes.toString('base64'),
  })
}

async function readBoundedMultipart(request: Request, maxBytes: number): Promise<FormData> {
  if (!request.body) throw new Error('Missing multipart body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('ATTACHMENT_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData()
}

function downloadDisposition(filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'attachment'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

async function findAuthorized(agentId: string, attachmentId: string) {
  const target = await Agent.find(agentId)
  if (!target) return null
  const attachment = await AgentFileAttachment.findById(attachmentId)
  if (!attachment || attachment.status === 'uploading') return null
  const scope = await resolveAttachmentScope(target)
  if (!scope.ownerAgentIds.includes(attachment.agentId)) throw new InvalidAttachmentError()
  return { target, attachment, scope }
}

/** Reported when the runtime's private mount cannot be named by an `@token`. */
const NOT_REFERENCABLE =
  'Attachment path is not referencable on this host (path contains characters the reference syntax cannot express)'

export const agentFilesRouter = new Hono()
  .post('/:agentId/files', sendPermission, async (c) => {
    const maxBytes = Number(getSettingsStore().getTyped('INBOX_MAX_ATTACHMENT_BYTES'))
    const contentLength = Number(c.req.header('content-length') ?? 0)
    if (contentLength > maxBytes + 64 * 1024) return c.json({ error: 'ATTACHMENT_TOO_LARGE' }, 413)
    const target = await Agent.find(c.req.param('agentId'))
    if (!target) return c.json({ error: 'Agent not found' }, 404)
    let form: FormData
    try {
      form = await readBoundedMultipart(c.req.raw, maxBytes + 64 * 1024)
    } catch (error) {
      if (error instanceof Error && error.message === 'ATTACHMENT_TOO_LARGE') {
        return c.json({ error: 'ATTACHMENT_TOO_LARGE' }, 413)
      }
      return c.json({ error: 'Invalid multipart body' }, 400)
    }
    const fields = [...form.keys()]
    if (fields.some((key) => key !== 'file' && key !== 'attachmentId')) {
      return c.json({ error: 'Invalid multipart fields' }, 400)
    }
    const files = form.getAll('file')
    const ids = form.getAll('attachmentId')
    if (files.length !== 1 || !(files[0] instanceof File) || ids.length !== 1 || typeof ids[0] !== 'string') {
      return c.json({ error: 'Exactly one file and attachmentId are required' }, 400)
    }
    const identity = c.get('identity') as Identity
    const file = files[0]
    if (file.size > maxBytes) return c.json({ error: 'ATTACHMENT_TOO_LARGE' }, 413)
    let attachment: AgentFileAttachment | undefined
    let createdByRequest = false
    let materializedByRequest = false
    try {
      const sandboxId = await target.getSandboxId()
      // Refuse BEFORE storing anything: a path the reference syntax cannot
      // express (a space, quote or `@` in the private mount) would upload
      // "successfully" and hand the composer a token that can never be linked
      // back to this row, so the attachment would silently do nothing.
      if (!isReferencableAgentAttachmentPath(agentVisibleAttachmentPath(sandboxId, ids[0], file.name))) {
        // 422: the request cannot be processed as sent (this deployment's
        // paths cannot name the file), not a core fault to retry.
        return c.json({ error: NOT_REFERENCABLE }, 422)
      }
      const result = await AgentFileAttachment.createWithDisposition(
        {
          id: ids[0],
          agentId: target.id,
          sandboxId,
          uploadedByType: identity.type,
          uploadedById:
            'userId' in identity && identity.userId
              ? identity.userId
              : 'agentId' in identity
                ? identity.agentId
                : identity.type,
          originalName: file.name,
          contentType: file.type || 'application/octet-stream',
          bytes: new Uint8Array(await file.arrayBuffer()),
        },
        async (disposition) => {
          attachment = disposition.attachment
          createdByRequest = disposition.created
          if ((await target.getSandboxId()) !== disposition.attachment.sandboxId) throw new InvalidAttachmentError()
          if (disposition.recovered) {
            await deleteMaterializedForTarget(target, disposition.attachment).catch(() => {})
          }
          await materializeForTarget(target, disposition.attachment)
          materializedByRequest = true
        }
      )
      return c.json(result.attachment.toJson())
    } catch (error) {
      if (attachment && createdByRequest) {
        if (materializedByRequest) await deleteMaterializedForTarget(target, attachment).catch(() => {})
        await attachment.deletePending().catch(() => {})
        await deleteAgentAttachmentBlob(attachment.agentId, attachment.id).catch(() => {})
      }
      const message = error instanceof Error ? error.message : ''
      if (message === 'ATTACHMENT_ID_CONFLICT') return c.json({ error: message }, 409)
      if (error instanceof InvalidAttachmentError) return c.json({ error: 'Attachment unavailable' }, 409)
      if (
        message === 'ATTACHMENT_TOO_LARGE' ||
        message === 'INBOX_STORAGE_QUOTA_EXCEEDED' ||
        message === 'Invalid attachment id'
      ) {
        return c.json({ error: message }, 400)
      }
      return c.json({ error: 'Upload failed' }, 500)
    }
  })
  .get('/:agentId/files/:attachmentId', readPermission, async (c) => {
    try {
      const result = await findAuthorized(c.req.param('agentId'), c.req.param('attachmentId'))
      if (!result) return c.json({ error: 'Attachment not found' }, 404)
      if ((await result.target.getSandboxId()) !== result.attachment.sandboxId) {
        return c.json({ error: 'Attachment belongs to a previous private workspace' }, 409)
      }
      const bytes = await result.attachment.readVerifiedBlob()
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': result.attachment.contentType,
          'Content-Disposition': downloadDisposition(result.attachment.originalName),
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      if (error instanceof InvalidAttachmentError) return c.json({ error: 'Attachment not found' }, 404)
      return c.json({ error: 'Attachment unavailable' }, 409)
    }
  })
  .delete('/:agentId/files/:attachmentId', sendPermission, async (c) => {
    try {
      const result = await findAuthorized(c.req.param('agentId'), c.req.param('attachmentId'))
      if (!result || result.attachment.agentId !== result.target.id) {
        return c.json({ error: 'Attachment not found' }, 404)
      }
      if ((await result.target.getSandboxId()) !== result.attachment.sandboxId) {
        return c.json({ error: 'Attachment belongs to a previous private workspace' }, 409)
      }
      if (!(await result.attachment.deletePending())) return c.json({ error: 'Attachment cannot be deleted' }, 409)
      await deleteMaterializedForTarget(result.target, result.attachment).catch(() => {})
      return c.body(null, 204)
    } catch (error) {
      if (error instanceof InvalidAttachmentError) return c.json({ error: 'Attachment not found' }, 404)
      throw error
    }
  })
