import type { ThemePreset, ThemePresetScope, ThemePresetVisibility } from '@ficus/shared'
import type { Transport } from '../transport'

export function themePresetsResource(t: Transport) {
  const path = (id: string) => `/theme-presets/${encodeURIComponent(id)}`
  return {
    /** No scope defaults to the server's own default ('mine' — Phase 1
     * behavior, unchanged wire shape for existing callers). */
    list: (scope?: ThemePresetScope, signal?: AbortSignal) =>
      t.request<ThemePreset[]>(`/theme-presets${scope ? `?scope=${scope}` : ''}`, { signal }),
    /** Any of the caller's own presets OR any instance-shared preset — the
     * live-link read. */
    get: (id: string, signal?: AbortSignal) => t.request<ThemePreset>(path(id), { signal }),
    create: (document: unknown, signal?: AbortSignal) =>
      t.request<ThemePreset>('/theme-presets', { method: 'POST', body: { document }, signal }),
    update: (id: string, revision: number, document: unknown, signal?: AbortSignal) =>
      t.request<ThemePreset>(path(id), { method: 'PUT', body: { revision, document }, signal }),
    delete: (id: string, revision: number, signal?: AbortSignal) =>
      t.request<{ ok: true }>(path(id), { method: 'DELETE', body: { revision }, signal }),
    /** Owner-only: share or unshare one of the caller's own presets. */
    setVisibility: (id: string, revision: number, visibility: ThemePresetVisibility, signal?: AbortSignal) =>
      t.request<ThemePreset>(`${path(id)}/visibility`, { method: 'PUT', body: { revision, visibility }, signal }),
    /** Admin/operator moderation (`theme-presets:moderate`): unshares ANY
     * user's preset without deleting it. */
    removeShare: (id: string, signal?: AbortSignal) =>
      t.request<ThemePreset>(`${path(id)}/share`, { method: 'DELETE', signal }),
    /** Copies a preset the caller can read (their own, or any instance-shared
     * preset) into a new, independent, private preset in the caller's own
     * library. */
    duplicate: (id: string, signal?: AbortSignal) =>
      t.request<ThemePreset>(`${path(id)}/duplicate`, { method: 'POST', signal }),
  }
}
