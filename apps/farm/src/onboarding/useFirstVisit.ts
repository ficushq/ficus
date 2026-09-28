import { useCallback, useState } from 'react'
import { isDemo } from '../app/demo'
import { useAccountSettings } from '../settings/useAccountSettings'

const WELCOMED_PREFIX = 'ficus-farm:welcomed:'

function readWelcomed(userId: string): boolean {
  try {
    return localStorage.getItem(WELCOMED_PREFIX + userId) === 'yes'
  } catch {
    return false
  }
}

function writeWelcomed(userId: string) {
  try {
    localStorage.setItem(WELCOMED_PREFIX + userId, 'yes')
  } catch {
    // Storage unavailable: the account still remembers.
  }
}

/**
 * Whether this is someone's first time on the farm, so it should welcome them
 * (pick a style, make your farmer). Decided only once their account's settings
 * are known, so nobody sees it flash up and vanish: it shows until the account
 * (or, if the account can't be saved to, this browser) says they've been
 * welcomed. Demo mode shows it only with `?demo=welcome`.
 */
export function useFirstVisit(): { firstVisit: boolean; welcomed: () => void } {
  const { saved, userId, ready, save } = useAccountSettings()
  const [done, setDone] = useState(false)
  const demoWelcome = isDemo && new URLSearchParams(window.location.search).get('demo') === 'welcome'
  const firstVisit = !done && (isDemo ? demoWelcome : ready && !!userId && !saved?.welcomed && !readWelcomed(userId))
  const welcomed = useCallback(() => {
    setDone(true)
    if (!userId) return
    writeWelcomed(userId)
    void save({ welcomed: true })
  }, [save, userId])
  return { firstVisit, welcomed }
}
