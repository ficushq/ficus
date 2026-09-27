import type { GardenSettings, MyGardenPreferences } from '@ficus/shared'
import type { Transport } from '../transport'

/** The caller's own garden settings (the garden UI's durable per-account state). */
export function gardenPreferencesResource(t: Transport) {
  return {
    getMine: (signal?: AbortSignal): Promise<MyGardenPreferences> => t.request('/garden-preferences/me', { signal }),
    /** Changes only the settings given; the rest stay as they are. */
    updateMine: (
      input: { expectedUserId: string; settings: GardenSettings },
      signal?: AbortSignal
    ): Promise<MyGardenPreferences> => t.request('/garden-preferences/me', { method: 'PATCH', body: input, signal }),
  }
}
