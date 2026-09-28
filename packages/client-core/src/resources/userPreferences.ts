import type { MyThemePreferences, ThemePreference } from '@ficus/shared'
import type { Transport } from '../transport'

export function userPreferencesResource(t: Transport) {
  return {
    getMine: (signal?: AbortSignal): Promise<MyThemePreferences> => t.request('/user-preferences/me', { signal }),
    updateMine: (
      input: { expectedUserId: string; theme: ThemePreference },
      signal?: AbortSignal
    ): Promise<MyThemePreferences> => t.request('/user-preferences/me', { method: 'PUT', body: input, signal }),
  }
}
