import { validateCustomTheme, type CustomThemeDocument } from './custom-theme'
import { isAppearanceSetting, type AppearanceSetting } from './theme-schema'
import { SYNC_THEME_DESCRIPTORS } from './theme-preferences'

/**
 * The contract between the farm and a native app that embeds it in a web view
 * (Ficus Mobile's Farm tab). Kept small and versioned so a fuller native
 * bridge can build on it: every message is JSON with `source` and `v`, and a
 * receiver ignores a version or a type it does not know.
 *
 * Farm → app, via `window.ReactNativeWebView.postMessage(json)`:
 * - `ready`: the farm is up and signed in.
 * - `auth-required`: the farm has no session; send it a `handoff`.
 * - `haptic`: a moment worth a light tap (`harvest`, `wave`, `message`, `answer`).
 *
 * App → farm, as a `message` event (or `window.__FICUS_EMBED__` before load):
 * - `handoff`: a web handoff code (Core's `POST /api/auth/web-handoff`), which
 *   the farm trades for a session. Never put one in a URL.
 * - `theme`: the app's active theme; the Futurist style follows it.
 */
export const FARM_EMBED_VERSION = 1

/**
 * A CSS length the app sets on the page's root element (e.g. `83px`) when its
 * dock floats over the bottom of the web view; the farm keeps its bottom
 * controls clear of it as well as the device's safe area.
 */
export const FARM_EMBED_INSET_BOTTOM_VAR = '--g-embed-inset-bottom'

export const FARM_HAPTICS = ['harvest', 'wave', 'message', 'answer'] as const
export type FarmHaptic = (typeof FARM_HAPTICS)[number]

export type FarmToAppMessage = { type: 'ready' } | { type: 'auth-required' } | { type: 'haptic'; kind: FarmHaptic }

export interface EmbedTheme {
  themeId: string
  appearance: AppearanceSetting
  customTheme: CustomThemeDocument | null
}

export type AppToFarmMessage = { type: 'handoff'; code: string } | { type: 'theme'; theme: EmbedTheme }

/** What the app may set on `window.__FICUS_EMBED__` before the farm loads. */
export interface FarmEmbedBootstrap {
  v: typeof FARM_EMBED_VERSION
  handoff?: string
  theme?: EmbedTheme
}

const FARM_SOURCE = 'ficus-farm'
const APP_SOURCE = 'ficus-app'
const MAX_CODE_LENGTH = 256

function envelope(data: unknown, source: string): Record<string, unknown> | null {
  let value = data
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return record.source === source && record.v === FARM_EMBED_VERSION ? record : null
}

/** A message for the app, as the JSON string `postMessage` takes. */
export function farmToAppMessage(message: FarmToAppMessage): string {
  return JSON.stringify({ source: FARM_SOURCE, v: FARM_EMBED_VERSION, ...message })
}

/** A message for the farm, as the JSON string the app posts or dispatches. */
export function appToFarmMessage(message: AppToFarmMessage): string {
  return JSON.stringify({ source: APP_SOURCE, v: FARM_EMBED_VERSION, ...message })
}

export function parseFarmToAppMessage(data: unknown): FarmToAppMessage | null {
  const record = envelope(data, FARM_SOURCE)
  if (!record) return null
  if (record.type === 'ready' || record.type === 'auth-required') return { type: record.type }
  if (record.type === 'haptic' && (FARM_HAPTICS as readonly unknown[]).includes(record.kind))
    return { type: 'haptic', kind: record.kind as FarmHaptic }
  return null
}

function asCode(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CODE_LENGTH ? value : null
}

/** An app theme the farm can use, or null when it isn't one. An invalid custom theme is dropped, not the theme. */
export function parseEmbedTheme(value: unknown): EmbedTheme | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { themeId, appearance, customTheme } = value as Record<string, unknown>
  if (typeof themeId !== 'string' || themeId.length === 0 || themeId.length > 64) return null
  if (!isAppearanceSetting(appearance)) return null
  let custom: CustomThemeDocument | null = null
  if (customTheme != null) {
    const checked = validateCustomTheme(JSON.stringify(customTheme), SYNC_THEME_DESCRIPTORS)
    if (checked.ok) custom = checked.document
  }
  return { themeId, appearance, customTheme: custom }
}

export function parseAppToFarmMessage(data: unknown): AppToFarmMessage | null {
  const record = envelope(data, APP_SOURCE)
  if (!record) return null
  if (record.type === 'handoff') {
    const code = asCode(record.code)
    return code ? { type: 'handoff', code } : null
  }
  if (record.type === 'theme') {
    const theme = parseEmbedTheme(record.theme)
    return theme ? { type: 'theme', theme } : null
  }
  return null
}

export function parseFarmEmbedBootstrap(value: unknown): FarmEmbedBootstrap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.v !== FARM_EMBED_VERSION) return null
  const handoff = asCode(record.handoff) ?? undefined
  const theme = parseEmbedTheme(record.theme) ?? undefined
  return { v: FARM_EMBED_VERSION, ...(handoff ? { handoff } : {}), ...(theme ? { theme } : {}) }
}
