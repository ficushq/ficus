import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { gardenQueries } from '../api/queries'
import { client } from '../api/client'
import { isDemo } from '../app/demo'
import type { SkinId } from './types'

/**
 * The style saved on the signed-in account, so it follows you between devices
 * and browsers (like the web app's theme). The account's choice wins when it
 * loads — or changes elsewhere — and is adopted through `adopt`. Only an
 * explicit choice writes to the account: an account with no style yet is not
 * an instruction to upload this browser's. Demo mode never touches it.
 *
 * `linked` is a style that arrived by ?style= link this visit: that counts as a
 * choice, so it's written to the account rather than overridden by it.
 */
export function useAccountStyle(adopt: (style: SkinId) => void, linked: SkinId | null): (style: SkinId) => void {
  const queryClient = useQueryClient()
  const session = useQuery({ ...gardenQueries.session(), enabled: !isDemo })
  const userId = session.data?.id
  const account = useQuery({ ...gardenQueries.gardenPreference(), enabled: !!userId })
  const saved = account.data && account.data.userId === userId ? account.data.style : null

  const save = useCallback(
    async (style: SkinId) => {
      if (!userId) return
      const { queryKey } = gardenQueries.gardenPreference()
      // Show the choice as the account's straight away, so a refetch in flight can't bounce it back.
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, { userId, style })
      try {
        queryClient.setQueryData(queryKey, await client.gardenPreferences.updateMine({ expectedUserId: userId, style }))
      } catch {
        // Couldn't save (offline, or the session changed): this browser still remembers it, and the
        // account's own choice comes back on the next refetch.
      }
    },
    [queryClient, userId]
  )

  // A ?style= link is saved to the account once we know whose it is.
  const pendingLink = useRef(linked)
  useEffect(() => {
    if (!userId || !pendingLink.current) return
    const style = pendingLink.current
    pendingLink.current = null
    void save(style)
  }, [userId, save])

  useEffect(() => {
    if (saved && !pendingLink.current) adopt(saved)
  }, [saved, adopt])

  return save
}
