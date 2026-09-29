import type { SkinId } from './types'

/*
 * Where the chosen style lives: this browser's storage, under the farm's own
 * prefix. A ?style= link picks a style once — it's saved as the choice and
 * dropped from the address — so the saved choice is what every later visit
 * (and reload) uses.
 */
export const STORAGE_KEY = 'ficus-farm:skin'

/** Earlier names for the styles, so a saved choice or old link still works. */
const ALIASES: Record<string, SkinId> = { farm: 'nostalgic', grid: 'futurist' }

export function knownSkin(value: string | null | undefined, ids: readonly SkinId[]): SkinId | null {
  const id = value ? (ALIASES[value] ?? value) : null
  return id && (ids as readonly string[]).includes(id) ? (id as SkinId) : null
}

/** The style to start with: a ?style= link first, then the saved choice, then the default. */
export function initialSkin(search: string, saved: string | null, ids: readonly SkinId[], fallback: SkinId): SkinId {
  return knownSkin(new URLSearchParams(search).get('style'), ids) ?? knownSkin(saved, ids) ?? fallback
}

/** A query string without its style parameter, leaving every other parameter exactly as written. */
export function withoutStyle(search: string): string {
  const kept = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part && decodeURIComponent(part.split('=')[0]!) !== 'style')
  return kept.length ? `?${kept.join('&')}` : ''
}
