/**
 * Public voice: how agents sound in text read outside Ficus (commits, pull
 * requests, review replies, issue comments, channel messages).
 *
 * The fixed rules (speak as Ficus, no internals, no secrets, no skipped check
 * described as passed, no Ficus link syntax) live in the `public-text` shared
 * prompt and are not configurable. This module owns the configurable part: the
 * types, the validation schemas, the three-layer resolution (squad layer,
 * assigned profile, instance default profile) and the rendering of the
 * generated "### Voice" section. Server, CLI and web share it so the byte cap
 * is computed identically everywhere. See docs/wiki/public-voice.md.
 */
import { z } from 'zod'

/** Safe selection DTO for person-initiated public-voice derivation, not an integration administration view. */
export interface PublicVoiceGitHubAccount {
  id: string
  login: string
  /** Included only when the label differs from the login. */
  displayName?: string
}

export const PUBLIC_SURFACES = ['commits', 'pullRequests', 'reviewReplies', 'issueComments', 'channels'] as const
export type PublicSurface = (typeof PUBLIC_SURFACES)[number]

export const PUBLIC_SURFACE_LABELS: Record<PublicSurface, string> = {
  commits: 'Commits',
  pullRequests: 'Pull requests',
  reviewReplies: 'Review replies',
  issueComments: 'Issue comments',
  channels: 'Channel messages',
}

/** Kebab-case names used on the CLI. */
export const PUBLIC_SURFACE_CLI_NAMES: Record<PublicSurface, string> = {
  commits: 'commits',
  pullRequests: 'pull-requests',
  reviewReplies: 'review-replies',
  issueComments: 'issue-comments',
  channels: 'channels',
}

export function publicSurfaceFromCliName(name: string): PublicSurface | null {
  const match = PUBLIC_SURFACES.find((s) => PUBLIC_SURFACE_CLI_NAMES[s] === name || s === name)
  return match ?? null
}

/** Cap on the rendered voice section, in UTF-8 bytes. */
export const PUBLIC_VOICE_MAX_BYTES = 2000
/** The shipped profile every squad uses until it is assigned another or sets its own. */
export const DEFAULT_PUBLIC_VOICE_ID = 'default'
/** Shared prompt carrying the fixed public-text rules and the voice token. */
export const PUBLIC_TEXT_SHARED_PROMPT_ID = 'public-text'
export const PUBLIC_VOICE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type PublicVoiceSurfaceMode = 'override' | 'add'
export interface PublicVoiceSurfaceEntry {
  mode: PublicVoiceSurfaceMode
  text: string
}
export type PublicVoiceSurfaces = Partial<Record<PublicSurface, PublicVoiceSurfaceEntry>>
export interface PublicVoiceLayer {
  base: string | null
  surfaces: PublicVoiceSurfaces
}
/** A squad's own layer, stored on `squads.public_voice`. */
export type SquadPublicVoice = PublicVoiceLayer
export interface PublicVoiceProfile {
  id: string
  name: string
  description: string | null
  base: string
  surfaces: PublicVoiceSurfaces
  disabled: boolean
}

// Counted in UTF-8 bytes, like the cap on the rendered section.
const voiceText = z
  .string()
  .trim()
  .min(1)
  .refine((text) => publicVoiceBytes(text) <= PUBLIC_VOICE_MAX_BYTES, {
    message: `At most ${PUBLIC_VOICE_MAX_BYTES} bytes`,
  })
export const publicVoiceSurfaceEntrySchema = z.object({ mode: z.enum(['override', 'add']), text: voiceText })

export const publicVoiceSurfacesSchema = z
  .object({
    commits: publicVoiceSurfaceEntrySchema.optional(),
    pullRequests: publicVoiceSurfaceEntrySchema.optional(),
    reviewReplies: publicVoiceSurfaceEntrySchema.optional(),
    issueComments: publicVoiceSurfaceEntrySchema.optional(),
    channels: publicVoiceSurfaceEntrySchema.optional(),
  })
  .strict()

/** Patch form: `null` deletes the squad's entry for that surface. */
export const publicVoiceSurfacesPatchSchema = z
  .object({
    commits: publicVoiceSurfaceEntrySchema.nullable().optional(),
    pullRequests: publicVoiceSurfaceEntrySchema.nullable().optional(),
    reviewReplies: publicVoiceSurfaceEntrySchema.nullable().optional(),
    issueComments: publicVoiceSurfaceEntrySchema.nullable().optional(),
    channels: publicVoiceSurfaceEntrySchema.nullable().optional(),
  })
  .strict()

export const publicVoiceIdSchema = z.string().max(100).regex(PUBLIC_VOICE_ID_PATTERN)

export const publicVoiceProfileInputSchema = z.object({
  id: publicVoiceIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  base: voiceText,
  surfaces: publicVoiceSurfacesSchema.optional(),
})
export type PublicVoiceProfileInput = z.infer<typeof publicVoiceProfileInputSchema>

/** Body of `PUT /api/public-voices/:id`; the id comes from the path. */
export const publicVoiceProfileUpdateSchema = publicVoiceProfileInputSchema.omit({ id: true })
export type PublicVoiceProfileUpdate = z.infer<typeof publicVoiceProfileUpdateSchema>

export const squadPublicVoicePatchSchema = z
  .object({
    voiceId: publicVoiceIdSchema.nullable().optional(),
    // Instance assignment controls must not silently replace the squad's custom base.
    preserveCustomBase: z.boolean().optional(),
    base: voiceText.nullable().optional(),
    surfaces: publicVoiceSurfacesPatchSchema.optional(),
  })
  .strict()
  .refine((p) => !(p.base && p.voiceId), { message: 'public_voice_base_conflict' })
export type SquadPublicVoicePatch = z.infer<typeof squadPublicVoicePatchSchema>

/** An unsaved squad layer sent to the preview route. */
export const publicVoiceLayerSchema = z.object({
  base: voiceText.nullable(),
  surfaces: publicVoiceSurfacesSchema,
})

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const repositoryName = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use owner/name')

/** Where derivation samples a GitHub user's writing. */
export const DERIVATION_SURFACES = ['pull-requests', 'issue-comments', 'reviews', 'commits'] as const
export type DerivationSurface = (typeof DERIVATION_SURFACES)[number]

export const derivationFiltersSchema = z
  .object({
    /** Only items created before this date (for example, when Ficus started posting from the account). */
    before: isoDate.optional(),
    /** Only items created on or after this date. */
    after: isoDate.optional(),
    repositories: z.array(repositoryName).max(50).optional(),
    excludeRepositories: z.array(repositoryName).max(50).optional(),
    surfaces: z.array(z.enum(DERIVATION_SURFACES)).min(1).optional(),
    /** Drop items that look written by an assistant or a bot. Default true. */
    excludeToolAuthored: z.boolean().optional(),
  })
  .strict()
  .refine((filters) => !filters.before || !filters.after || filters.after < filters.before, {
    message: 'after must be earlier than before',
    path: ['after'],
  })
export type DerivationFilters = z.infer<typeof derivationFiltersSchema>

export type PublicVoiceBaseSource = 'squad' | 'profile' | 'instance' | 'none'
export type PublicVoiceFallback = 'assigned_disabled' | 'assigned_missing'

export interface ResolvedPublicVoice {
  base: string
  baseSource: PublicVoiceBaseSource
  /** The profile that supplied the base and inherited entries, or null. */
  profileId: string | null
  entries: PublicVoiceSurfaces
  entrySources: Partial<Record<PublicSurface, 'squad' | 'profile'>>
  /** The full voice an agent applies to each surface. */
  perSurface: Record<PublicSurface, string>
}

export interface ResolvePublicVoiceInput {
  squad: SquadPublicVoice | null
  assigned: PublicVoiceProfile | null
  instanceDefault: PublicVoiceProfile | null
}

function usableProfile(profile: PublicVoiceProfile | null): PublicVoiceProfile | null {
  return profile && !profile.disabled ? profile : null
}

/**
 * Resolve the three layers. The base comes from exactly one place: the
 * squad's custom base, else the assigned profile, else the instance default.
 * A squad with a custom base ignores every profile. Per surface, the squad's
 * entry shadows the profile's; an entry either overrides the base or adds to it.
 */
export function resolvePublicVoice({ squad, assigned, instanceDefault }: ResolvePublicVoiceInput): ResolvedPublicVoice {
  const squadBase = squad?.base?.trim() ?? ''
  const assignedProfile = usableProfile(assigned)
  const profile = squadBase ? null : (assignedProfile ?? usableProfile(instanceDefault))
  const base = squadBase || profile?.base.trim() || ''
  const baseSource: PublicVoiceBaseSource = squadBase
    ? 'squad'
    : profile
      ? profile === assignedProfile
        ? 'profile'
        : 'instance'
      : 'none'

  const entries: PublicVoiceSurfaces = {}
  const entrySources: ResolvedPublicVoice['entrySources'] = {}
  for (const surface of PUBLIC_SURFACES) {
    const own = squad?.surfaces?.[surface]
    const inherited = profile?.surfaces?.[surface]
    if (own) {
      entries[surface] = own
      entrySources[surface] = 'squad'
    } else if (inherited) {
      entries[surface] = inherited
      entrySources[surface] = 'profile'
    }
  }

  return {
    base,
    baseSource,
    profileId: profile?.id ?? null,
    entries,
    entrySources,
    perSurface: perSurfaceVoice(base, entries),
  }
}

function perSurfaceVoice(base: string, entries: PublicVoiceSurfaces): Record<PublicSurface, string> {
  const result = {} as Record<PublicSurface, string>
  for (const surface of PUBLIC_SURFACES) {
    const entry = entries[surface]
    result[surface] = !entry
      ? base
      : entry.mode === 'override'
        ? entry.text
        : [base, entry.text].filter(Boolean).join('\n\n')
  }
  return result
}

/**
 * Render the generated section an agent reads once per turn: the base, then
 * only the surfaces with an effective entry, in fixed order. Returns '' when
 * there is no voice at all.
 */
export function renderPublicVoicePrompt(resolved: Pick<ResolvedPublicVoice, 'base' | 'entries'>): string {
  const lines: string[] = []
  for (const surface of PUBLIC_SURFACES) {
    const entry = resolved.entries[surface]
    if (!entry) continue
    const marker = resolved.base && entry.mode === 'override' ? ' (instead of the voice above)' : ''
    lines.push(`- ${PUBLIC_SURFACE_LABELS[surface]}${marker}: ${entry.text.trim()}`)
  }
  if (!resolved.base && lines.length === 0) return ''
  return ['### Voice', '', ...(resolved.base ? [resolved.base, ''] : []), ...lines].join('\n').trimEnd()
}

/** UTF-8 byte length. `TextEncoder`, not `Buffer`: the web app imports this file. */
export function publicVoiceBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Drop effective surface entries from the end of the fixed order (channels
 * first) until the rendered section fits. A last resort for a profile edited
 * after a squad saved its own layer; saves are checked before they land.
 */
export function fitPublicVoiceToCap(
  resolved: ResolvedPublicVoice,
  maxBytes: number = PUBLIC_VOICE_MAX_BYTES
): { resolved: ResolvedPublicVoice; dropped: PublicSurface[] } {
  let current = resolved
  const dropped: PublicSurface[] = []
  for (const surface of [...PUBLIC_SURFACES].reverse()) {
    if (publicVoiceBytes(renderPublicVoicePrompt(current)) <= maxBytes) break
    if (!current.entries[surface]) continue
    const entries = { ...current.entries }
    delete entries[surface]
    const entrySources = { ...current.entrySources }
    delete entrySources[surface]
    current = { ...current, entries, entrySources, perSurface: { ...current.perSurface, [surface]: current.base } }
    dropped.unshift(surface)
  }
  return { resolved: current, dropped }
}

/** Render a profile by itself, ignoring `disabled` (the profile-alone cap check and the list's byte count). */
export function renderProfileAlone(profile: PublicVoiceProfile): string {
  return renderPublicVoicePrompt(
    resolvePublicVoice({ squad: null, assigned: { ...profile, disabled: false }, instanceDefault: null })
  )
}

/** True when the layer carries nothing. */
export function isEmptyPublicVoiceLayer(layer: SquadPublicVoice | null | undefined): boolean {
  return !layer || (!layer.base?.trim() && Object.keys(layer.surfaces ?? {}).length === 0)
}

/** API shape of a voice profile (`/api/public-voices`). */
export interface PublicVoiceProfileJson extends PublicVoiceProfile {
  hasTemplate: boolean
  yamlFieldOverrides: string[]
  /** UTF-8 bytes of the profile rendered by itself. */
  bytes: number
  assignedSquadCount?: number
  createdAt: string | Date
  updatedAt: string | Date
}

/** A profile a squad may be assigned, as listed to anyone who can read the squad. */
export interface PublicVoiceOption {
  id: string
  name: string
  description: string | null
}

/** `GET /api/squads/:id/voice`. */
export interface SquadPublicVoiceState {
  /** The assigned profile id; null means the instance default. */
  voiceId: string | null
  /** The squad's own layer. */
  local: SquadPublicVoice
  /** The effective profile (assigned, else the instance default), or null with a custom base or no usable profile. */
  profile: PublicVoiceProfile | null
  fallback: PublicVoiceFallback | null
  availableVoices: PublicVoiceOption[]
  resolved: ResolvedPublicVoice & {
    rendered: string
    bytes: number
    maxBytes: number
    overCap: boolean
    dropped: PublicSurface[]
  }
  /** The caller's linked GitHub login, used to prefill derivation. */
  linkedGitHubLogin: string | null
}
