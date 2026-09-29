import type { FarmSettings, MyFarmPreferences } from '@ficus/shared'
import type { Transport } from '../transport'

/** The caller's own farm settings (the farm UI's durable per-account state). */
export function farmPreferencesResource(t: Transport) {
  return {
    getMine: (signal?: AbortSignal): Promise<MyFarmPreferences> => t.request('/farm-preferences/me', { signal }),
    /** Changes only the settings given; the rest stay as they are. */
    updateMine: (
      input: { expectedUserId: string; settings: FarmSettings },
      signal?: AbortSignal
    ): Promise<MyFarmPreferences> => t.request('/farm-preferences/me', { method: 'PATCH', body: input, signal }),
  }
}
