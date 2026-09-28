import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FarmSettings, MyFarmPreferences } from '@ficus/shared'
import { farmQueries } from '../api/queries'
import { client } from '../api/client'
import { isDemo } from '../app/demo'

export interface AccountSettings {
  /** The signed-in account's settings; null until known, when signed out, in demo mode or if Ficus can't say. */
  saved: FarmSettings | null
  /** Whose account a save would go to (null: saves are skipped and the browser's copy is all there is). */
  userId: string | null
  /** Saves the settings given, leaving the rest as they are. */
  save: (patch: FarmSettings) => Promise<void>
}

/**
 * The farm's durable per-account settings (style, sound, …), so they follow
 * you between devices and browsers. Each setting also lives in this browser for
 * an instant start and for signed-out or offline visits; callers adopt a saved
 * value when it arrives, and save only on an explicit choice, so an account with
 * no value yet is never filled from a browser. Demo mode never touches it.
 */
export function useAccountSettings(): AccountSettings {
  const queryClient = useQueryClient()
  const session = useQuery({ ...farmQueries.session(), enabled: !isDemo })
  const userId = session.data?.id ?? null
  const account = useQuery({ ...farmQueries.farmPreference(), enabled: !!userId })
  const saved = account.data && account.data.userId === userId ? account.data.settings : null

  const save = useCallback(
    async (patch: FarmSettings) => {
      if (!userId) return
      const { queryKey } = farmQueries.farmPreference()
      // Show the change as the account's straight away, so a refetch in flight can't bounce it back.
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData<MyFarmPreferences>(queryKey, (old) => ({
        userId,
        settings: { ...(old?.userId === userId ? old.settings : {}), ...patch },
      }))
      try {
        queryClient.setQueryData(
          queryKey,
          await client.farmPreferences.updateMine({ expectedUserId: userId, settings: patch })
        )
      } catch {
        // Couldn't save (offline, or the session changed): this browser still remembers it, and the
        // account's own settings come back on the next refetch.
      }
    },
    [queryClient, userId]
  )

  return { saved, userId, save }
}
