import { deriveSchema, respondWithVoiceDerivation } from './voice-derivation'
import { z } from 'zod'
import type { Identity } from '../services/rbac'
import {
  resolveInstanceGitHubConnection,
  listPublicVoiceGitHubAccounts,
} from '../services/integrations/github/resolve-connection'
import { derivationOwners } from '../services/public-voice/operation'
import { Hono } from 'hono'
import {
  DEFAULT_PUBLIC_VOICE_ID,
  PUBLIC_VOICE_MAX_BYTES,
  publicVoiceBytes,
  publicVoiceInstanceDefaultInputSchema,
  publicVoiceProfileInputSchema,
  publicVoiceProfileUpdateSchema,
  renderProfileAlone,
  type PublicVoiceInstanceDefaultSetting,
  type PublicVoiceProfile,
} from '@ficus/shared'
import { publicErrorMessage } from '../db/errors'
import { PublicVoice } from '../entities/PublicVoice'
import { zValidator } from '../lib/zod-validator'
import { requirePermission } from '../middleware'
import { publicVoiceSync } from '../services/config-sync'
import { describeProfiles, instanceDefaultSquadCount, overCapSquadCount } from '../services/public-voice/profiles'
import { describeInstanceDefault, resolveInstanceDefaultVoice } from '../lib/prompts/public-voice-prompt'

/**
 * Voice profiles: named, instance-level public voices that squads are
 * assigned to. Read with `agent-types:read`, managed with `agent-types:update`
 * (the permission that already covers instance-wide prompt text), including
 * which profile is the instance default. Assigning a profile to a squad is a
 * squad route under `squads:update`.
 */
export const publicVoicesRoutes = new Hono()

function tooLong(profile: PublicVoiceProfile) {
  const bytes = publicVoiceBytes(renderProfileAlone(profile))
  return bytes > PUBLIC_VOICE_MAX_BYTES
    ? { error: 'public_voice_too_long', bytes, maxBytes: PUBLIC_VOICE_MAX_BYTES }
    : null
}

/** The instance default and how many squads use it (`PublicVoiceInstanceDefaultSetting`). */
async function describeInstanceDefaultSetting(): Promise<PublicVoiceInstanceDefaultSetting> {
  const [instance, squadCount] = await Promise.all([resolveInstanceDefaultVoice(), instanceDefaultSquadCount()])
  return { ...describeInstanceDefault(instance), squadCount }
}

async function describeOne(id: string) {
  const profile = await PublicVoice.find(id)
  return profile ? (await describeProfiles([profile]))[0]! : null
}

publicVoicesRoutes.get('/', requirePermission('agent-types:read'), async (c) => {
  return c.json(await describeProfiles(await PublicVoice.list({ includeDisabled: true })))
})

publicVoicesRoutes.post(
  '/derive',
  requirePermission('agent-types:update'),
  requirePermission('integrations:use'),
  zValidator('json', deriveSchema.extend({ connectionId: z.string().min(1).max(200) }).strict()),
  async (c) => {
    const identity = c.get('identity') as Identity | undefined
    if (identity?.type !== 'user') return c.json({ error: 'derivation_requires_person' }, 403)
    const body = c.req.valid('json')
    // Connection ids are UUIDs in storage. Unknown/malformed selections are an application
    // error, not a database cast failure; normalize equivalent UUIDs for lock ownership.
    const connectionId = body.connectionId.toLowerCase()
    if (!z.uuid().safeParse(connectionId).success) return c.json({ error: 'github_connection_unavailable' }, 422)
    if (derivationOwners.has(`connection:${connectionId}`)) return c.json({ error: 'derivation_in_progress' }, 429)
    if (!(await resolveInstanceGitHubConnection(connectionId)))
      return c.json({ error: 'github_connection_unavailable' }, 422)
    // Resolution is asynchronous: another caller may have acquired ownership while it ran.
    if (derivationOwners.has(`connection:${connectionId}`)) return c.json({ error: 'derivation_in_progress' }, 429)
    return respondWithVoiceDerivation(c, { kind: 'connection', connectionId }, identity.userId ?? null, body)
  }
)

// Selection is part of deriving, not integration administration. Keep the pool's read gate unchanged.
// Use a multi-segment path so every existing profile id remains available to GET /:id.
publicVoicesRoutes.get(
  '/derive/github-accounts',
  requirePermission('agent-types:update'),
  requirePermission('integrations:use'),
  async (c) => {
    const identity = c.get('identity') as Identity | undefined
    if (identity?.type !== 'user') return c.json({ error: 'derivation_requires_person' }, 403)
    c.header('Cache-Control', 'no-store')
    return c.json(await listPublicVoiceGitHubAccounts())
  }
)

// The instance default: the profile every squad without an assignment uses, and how many squads use
// it. A multi-segment path, so `settings` stays a valid profile id for GET /:id.
publicVoicesRoutes.get('/settings/instance-default', requirePermission('agent-types:read'), async (c) => {
  return c.json(await describeInstanceDefaultSetting())
})

publicVoicesRoutes.put(
  '/settings/instance-default',
  requirePermission('agent-types:update'),
  zValidator('json', publicVoiceInstanceDefaultInputSchema),
  async (c) => {
    const { voiceId } = c.req.valid('json')
    const profile = await PublicVoice.find(voiceId)
    if (!profile || profile.disabled) return c.json({ error: 'unknown_voice' }, 400)
    const identity = c.get('identity') as Identity | undefined
    await PublicVoice.setInstanceDefaultId(voiceId, identity?.type === 'user' ? (identity.userId ?? null) : null)
    // Squads on the instance default now render with this profile; report those over the cap.
    const overCap = await overCapSquadCount(profile.toProfile(), { asInstanceDefault: true })
    return c.json({ ...(await describeInstanceDefaultSetting()), overCapSquadCount: overCap })
  }
)

publicVoicesRoutes.get('/:id', requirePermission('agent-types:read'), async (c) => {
  const profile = await describeOne(c.req.param('id'))
  return profile ? c.json(profile) : c.json({ error: 'Voice profile not found' }, 404)
})

publicVoicesRoutes.get('/:id/template-diff', requirePermission('agent-types:read'), async (c) => {
  try {
    return c.json(await publicVoiceSync.getTemplateDiff(c.req.param('id')))
  } catch (error) {
    return c.json({ error: publicErrorMessage(error) }, 404)
  }
})

publicVoicesRoutes.post(
  '/',
  requirePermission('agent-types:update'),
  zValidator('json', publicVoiceProfileInputSchema),
  async (c) => {
    const input = c.req.valid('json')
    if (await PublicVoice.find(input.id)) return c.json({ error: `Voice profile "${input.id}" already exists` }, 409)
    const candidate = {
      ...input,
      description: input.description ?? null,
      surfaces: input.surfaces ?? {},
      disabled: false,
    }
    const over = tooLong(candidate)
    if (over) return c.json(over, 400)
    if (!(await PublicVoice.create(input))) return c.json({ error: `Voice profile "${input.id}" already exists` }, 409)
    return c.json(await describeOne(input.id), 201)
  }
)

publicVoicesRoutes.put(
  '/:id',
  requirePermission('agent-types:update'),
  zValidator('json', publicVoiceProfileUpdateSchema),
  async (c) => {
    const id = c.req.param('id')
    const existing = await PublicVoice.find(id)
    if (!existing) return c.json({ error: 'Voice profile not found' }, 404)
    const input = c.req.valid('json')
    const candidate = {
      id,
      name: input.name,
      description: Object.hasOwn(input, 'description') ? (input.description ?? null) : existing.description,
      base: input.base,
      surfaces: input.surfaces ?? {},
      disabled: existing.disabled,
    }
    const over = tooLong(candidate)
    if (over) return c.json(over, 400)
    await PublicVoice.upsert({ ...candidate })
    await publicVoiceSync.recomputeFieldOverrides(id)
    PublicVoice.invalidateCache()
    return c.json({ ...(await describeOne(id))!, overCapSquadCount: await overCapSquadCount(candidate) })
  }
)

publicVoicesRoutes.delete('/:id', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (id === DEFAULT_PUBLIC_VOICE_ID) return c.json({ error: 'default_profile_cannot_be_deleted' }, 409)
  const profile = await describeOne(id)
  if (!profile) return c.json({ error: 'Voice profile not found' }, 404)
  if (profile.hasTemplate)
    return c.json({ error: 'Cannot delete a profile shipped in config/public-voices; disable it instead' }, 400)
  await PublicVoice.delete(id)
  // Assigned squads fall back to the instance default through the foreign key; deleting the chosen
  // instance default clears that choice, so the shipped `default` applies again.
  return c.json({
    ok: true,
    unassignedSquads: profile.assignedSquadCount ?? 0,
    clearedInstanceDefault: Boolean(profile.isInstanceDefault),
  })
})

publicVoicesRoutes.post('/:id/disable', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (!(await PublicVoice.find(id))) return c.json({ error: 'Voice profile not found' }, 404)
  const wasInstanceDefault = (await PublicVoice.instanceDefaultId()) === id
  await publicVoiceSync.setDisabled(id, true)
  PublicVoice.invalidateCache()
  // The choice is kept: while it is disabled the shipped `default` applies, and enabling restores it.
  return c.json({ ok: true, ...(wasInstanceDefault ? { instanceDefaultFallback: true } : {}) })
})

publicVoicesRoutes.post('/:id/enable', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (!(await PublicVoice.find(id))) return c.json({ error: 'Voice profile not found' }, 404)
  await publicVoiceSync.setDisabled(id, false)
  PublicVoice.invalidateCache()
  return c.json({ ok: true })
})

publicVoicesRoutes.post('/:id/revert-to-template', requirePermission('agent-types:update'), async (c) => {
  try {
    await publicVoiceSync.revertToTemplate(c.req.param('id'))
    PublicVoice.invalidateCache()
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: publicErrorMessage(error) }, 400)
  }
})
