import type { GardenStyle, MyGardenPreferences } from '@ficus/shared'
import type { Transport } from '../transport'

/** The caller's own garden preferences (the garden UI's visual style). */
export function gardenPreferencesResource(t: Transport) {
  return {
    getMine: (signal?: AbortSignal): Promise<MyGardenPreferences> => t.request('/garden-preferences/me', { signal }),
    updateMine: (
      input: { expectedUserId: string; style: GardenStyle },
      signal?: AbortSignal
    ): Promise<MyGardenPreferences> => t.request('/garden-preferences/me', { method: 'PUT', body: input, signal }),
  }
}
