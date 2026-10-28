import { z } from 'zod'
import { validateCustomTheme, type CustomThemeDocument, type CustomThemeValidation } from './custom-theme'
import { SYNC_THEME_DESCRIPTORS } from './theme-preferences'

/**
 * Every user gets a library of saved theme presets, private by default.
 * Phase 2 adds instance-wide sharing: a preset with `visibility: 'instance'`
 * is readable (and its document live-linkable) by every other signed-in user
 * on the instance via `GET /theme-presets/:id`, in addition to its owner via
 * `scope=mine`. Mutating the document, deleting, or changing visibility
 * remains owner-only; an admin/operator with `theme-presets:moderate` may
 * additionally unshare (never delete) another user's preset.
 */
export type ThemePresetVisibility = 'private' | 'instance'

export function isThemePresetVisibility(value: unknown): value is ThemePresetVisibility {
  return value === 'private' || value === 'instance'
}

export const themePresetVisibilitySchema = z.enum(['private', 'instance'])

/** `GET /theme-presets` list scope. 'mine' (default, Phase 1 behavior) is the
 * caller's own library regardless of visibility; 'shared' is every OTHER
 * user's instance-visible preset; 'all' is the union of both. */
export type ThemePresetScope = 'mine' | 'shared' | 'all'

export function isThemePresetScope(value: unknown): value is ThemePresetScope {
  return value === 'mine' || value === 'shared' || value === 'all'
}

/** Phase 2: public attribution for a preset shown to users other than its
 * owner. `displayName` is already the display-name-or-email fallback (the
 * same convention `formatRequestingUser`/chat sender attribution use
 * elsewhere in Core) — never a raw separate `email` field, matching how
 * those existing attributions expose one computed name, not two fields. */
export interface ThemePresetOwner {
  id: string
  displayName: string
}

/** Per-user library size cap, enforced by the create route (409/422 on overflow). */
export const THEME_PRESET_MAX_PER_USER = 50

/** The wire/API shape. Name lives at `document.name` (single source — renaming
 * a preset is a document name change, there is no separate name field to drift). */
export interface ThemePreset {
  id: string
  document: CustomThemeDocument
  visibility: ThemePresetVisibility
  ownerUserId: string
  /** Phase 2: attribution, always present (even for the caller's own presets —
   * one DTO shape, no conditional client-side branching on scope). */
  owner: ThemePresetOwner
  revision: number
  createdAt: string
  updatedAt: string
}

/** Accepts either a parsed document object or a raw JSON string, and validates/
 * normalizes it exactly like a directly-imported custom theme document (v1 or v2). */
export function validateThemePresetDocument(
  raw: unknown,
  builtins: readonly {
    readonly id: string
    readonly label: string
    readonly kind: 'dual' | 'unified'
  }[] = SYNC_THEME_DESCRIPTORS
): CustomThemeValidation {
  if (raw === null || raw === undefined) return { ok: false, error: 'Theme document is required.' }
  let json: string
  try {
    json = typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    return { ok: false, error: 'Theme document must be JSON-serializable.' }
  }
  return validateCustomTheme(json, builtins)
}

const requiredDocument = z.unknown().refine((value) => value !== undefined, { message: 'document is required' })

/** Creating a preset never takes `visibility` — a new preset always starts
 * private; sharing is a deliberate, separate action via the visibility route. */
export const createThemePresetRequestSchema = z.strictObject({ document: requiredDocument })
export const updateThemePresetRequestSchema = z.strictObject({
  revision: z.int().nonnegative(),
  document: requiredDocument,
})
export const deleteThemePresetRequestSchema = z.strictObject({ revision: z.int().nonnegative() })
/** `PUT /theme-presets/:id/visibility` — owner-only, revision-checked, like the
 * document update route. Sharing/unsharing never touches the document. */
export const updateThemePresetVisibilityRequestSchema = z.strictObject({
  revision: z.int().nonnegative(),
  visibility: themePresetVisibilitySchema,
})

export type CreateThemePresetRequest = z.infer<typeof createThemePresetRequestSchema>
export type UpdateThemePresetRequest = z.infer<typeof updateThemePresetRequestSchema>
export type DeleteThemePresetRequest = z.infer<typeof deleteThemePresetRequestSchema>
export type UpdateThemePresetVisibilityRequest = z.infer<typeof updateThemePresetVisibilityRequestSchema>
