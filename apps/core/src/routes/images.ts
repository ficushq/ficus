import { Hono } from 'hono'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { Image, type ImageContent } from '../entities/Image'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { buildSignedImageUrlPath, verifyImageUrlSignature } from '../services/images/signing'
import { hasPermission, identityUserId, type Identity } from '../services/rbac'
import { IMAGE_ATTACHMENT_MIME_TYPES, MAX_IMAGE_ATTACHMENTS_PER_MESSAGE } from '@ficus/shared'

// Image access folds into the owning agent's conversation: read uses agents:read,
// write (upload) uses agents:write, scoped to the agent's squad. Squad-less /
// deleted-agent images are admin/legacy only — a squad-bound agent token is
// excluded (ROOT's own-squad fallback would otherwise leak them).
async function canAccessSquadlessImage(identity: Identity, perm: 'agents:read' | 'agents:write'): Promise<boolean> {
  if (identity.type === 'agent' && !identity.userId) return false
  return hasPermission(identity, perm)
}

export const imagesRouter = new Hono()
  .get('/:id', async (c) => {
    c.set('publicRoute', true)
    const id = c.req.param('id')
    if (!verifyImageUrlSignature(id, c.req.query('exp'), c.req.query('sig'))) {
      return c.json({ error: 'Invalid or expired image signature' }, 403)
    }

    // Get image
    const image = await Image.find(id)
    if (!image) {
      return c.json({ error: 'Image not found' }, 404)
    }

    // Load image data
    const content = await image.loadContent()

    // Return as binary with proper content type
    const buffer = Buffer.from(content.data, 'base64')
    // Image bytes are content-addressed (a new upload gets a new id), so they're immutable for the
    // life of a signed URL. Cache per-user in the browser (`private` keeps shared/proxy caches out;
    // the HMAC signature still gates access) up to the signature's expiry — this stops the avatar /
    // attachment re-download on every page load. After expiry a fresh signed URL is issued.
    const expSec = Number(c.req.query('exp'))
    const maxAge = Number.isFinite(expSec) ? Math.max(0, expSec - Math.floor(Date.now() / 1000)) : 0
    const cacheControl = `private, max-age=${maxAge}, immutable`

    return new Response(buffer, {
      headers: {
        'Content-Type': image.mimeType,
        'Content-Length': buffer.length.toString(),
        'Cache-Control': cacheControl,
      },
    })
  })
  .post('/sign-urls', async (c) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)

    const body = await parseOptionalJsonObjectBody(c, {} as { ids?: string[] })
    const ids = Array.isArray(body.ids) ? body.ids : []

    if (ids.length === 0) return c.json({ urls: {} })
    if (ids.length > 100) return c.json({ error: 'Too many ids (max 100)' }, 400)

    // An image belongs to an agent conversation: only sign ids for real images
    // the caller can read via agents:read on the owning agent's squad (squad-less
    // / deleted-agent images are admin/legacy only). Unknown ids are never signed.
    const found = await Image.findMany(ids)
    const urls: Record<string, string> = {}
    for (const img of found) {
      let allowed: boolean
      if (img.agentId) {
        const agent = await Agent.find(img.agentId)
        const squadId = agent?.squadId ?? null
        allowed = squadId
          ? await hasPermission(identity, 'agents:read', squadId)
          : await canAccessSquadlessImage(identity, 'agents:read')
      } else if (img.squadId) {
        const actorUserId = identityUserId(identity)
        const stagedUpload = img.status === 'pending' && img.uploadedByUserId !== null
        allowed =
          ((!stagedUpload || actorUserId === img.uploadedByUserId) &&
            (await hasPermission(identity, 'agents:read', img.squadId))) ||
          (await canAccessSquadlessImage(identity, 'agents:read'))
      } else {
        allowed = await canAccessSquadlessImage(identity, 'agents:read')
      }
      if (allowed) urls[img.id] = buildSignedImageUrlPath(img.id)
    }

    return c.json({ urls })
  })
  .post('/', async (c) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)

    const body = await c.req.json<{
      images: ImageContent[]
      agentId?: string
      squadId?: string
    }>()

    if (body.agentId && body.squadId) {
      return c.json({ error: 'Specify either agentId or squadId, not both' }, 400)
    }

    // Uploading attaches images to a real agent conversation or stages them for
    // an actor within a specific squad. Untargeted uploads remain admin/system only.
    let allowed: boolean
    let targetSquadId: string | undefined
    if (body.agentId) {
      const agent = await Agent.find(body.agentId)
      if (!agent) return c.json({ error: 'Agent not found' }, 404)
      targetSquadId = agent.squadId ?? undefined
      allowed = targetSquadId
        ? await hasPermission(identity, 'agents:write', targetSquadId)
        : await canAccessSquadlessImage(identity, 'agents:write')
    } else if (body.squadId) {
      const squad = await Squad.find(body.squadId)
      if (!squad) return c.json({ error: 'Squad not found' }, 404)
      targetSquadId = squad.id
      allowed = identityUserId(identity) !== null && (await hasPermission(identity, 'agents:write', squad.id))
    } else {
      allowed = await canAccessSquadlessImage(identity, 'agents:write')
    }
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)

    if (!body.images?.length) {
      return c.json({ error: 'No images provided' }, 400)
    }
    if (body.images.length > MAX_IMAGE_ATTACHMENTS_PER_MESSAGE) {
      return c.json({ error: `At most ${MAX_IMAGE_ATTACHMENTS_PER_MESSAGE} images may be uploaded at once` }, 400)
    }

    // Validate image formats
    for (const img of body.images) {
      if (img.type !== 'image') {
        return c.json({ error: 'Invalid image type' }, 400)
      }
      if (!(IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(img.mimeType)) {
        return c.json({ error: `Unsupported image format: ${img.mimeType}` }, 400)
      }
      if (!img.data) {
        return c.json({ error: 'Image data is required' }, 400)
      }
    }

    try {
      const images = await Image.createMany(body.images, {
        agentId: body.agentId,
        squadId: targetSquadId,
        uploadedByUserId: identityUserId(identity) ?? undefined,
      })

      return c.json({ imageIds: images.map((img) => img.id) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed'
      return c.json({ error: message }, 400)
    }
  })
