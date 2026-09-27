import { useCallback, useEffect, useRef } from 'react'
import { useAccountSettings } from '../settings/useAccountSettings'
import type { SkinId } from './types'

/**
 * The style saved on the signed-in account (see settings/useAccountSettings.ts):
 * adopted through `adopt` when it loads or changes on another device, and saved
 * when you pick one.
 *
 * `linked` is a style that arrived by ?style= link this visit: that counts as a
 * choice, so it's written to the account rather than overridden by it.
 */
export function useAccountStyle(adopt: (style: SkinId) => void, linked: SkinId | null): (style: SkinId) => void {
  const { saved, userId, save } = useAccountSettings()
  const style = saved?.style ?? null

  const saveStyle = useCallback((next: SkinId) => void save({ style: next }), [save])

  // A ?style= link is saved to the account once we know whose it is.
  const pendingLink = useRef(linked)
  useEffect(() => {
    if (!userId || !pendingLink.current) return
    const next = pendingLink.current
    pendingLink.current = null
    saveStyle(next)
  }, [userId, saveStyle])

  useEffect(() => {
    if (style && !pendingLink.current) adopt(style)
  }, [style, adopt])

  return saveStyle
}
