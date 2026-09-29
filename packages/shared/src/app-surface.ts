/**
 * Which app an installed Ficus home-screen app reopens to.
 *
 * The web app and the farm install as two home-screen apps, and inside either
 * you can switch to the other (the farm icon, the farmhouse's "Open Ficus").
 * Each installed app remembers which of the two you were last in and, on a
 * fresh launch, reopens there.
 *
 * "Which installed app is this window" lives in sessionStorage: a launch opens
 * a new window with an empty session, and the session follows the window as
 * it switches between the web app and the farm (same origin). The last app is
 * kept in localStorage per installed app, because on Android and desktop both
 * installed apps (and the browser) share one localStorage.
 */

export type AppSurface = 'web' | 'farm'

/** sessionStorage: the installed app this window was launched as. */
export const LAUNCHED_AS_KEY = 'ficus-launched-as'

/** localStorage: the app last open in windows launched as `launchedAs`. */
export function lastSurfaceKey(launchedAs: AppSurface): string {
  return `ficus-last-app:${launchedAs}`
}

export interface SurfaceStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function asSurface(value: string | null): AppSurface | null {
  return value === 'web' || value === 'farm' ? value : null
}

/**
 * Call once as a page loads. Records where this window is and returns the
 * app to switch to instead, when this is a fresh launch at the app's start
 * page and the window's app was last left in the other one. Browser tabs are
 * left alone: only installed (standalone) apps remember.
 */
export function resumeSurface(options: {
  current: AppSurface
  standalone: boolean
  /** The page is the installed app's start URL (not a deep link, e.g. from a notification). */
  atStartUrl: boolean
  session: SurfaceStore
  local: SurfaceStore
}): AppSurface | null {
  const { current, standalone, atStartUrl, session, local } = options
  if (!standalone) return null

  let launchedAs = asSurface(session.getItem(LAUNCHED_AS_KEY))
  const freshLaunch = launchedAs === null
  if (launchedAs === null) {
    launchedAs = current
    session.setItem(LAUNCHED_AS_KEY, current)
  }

  const key = lastSurfaceKey(launchedAs)
  if (freshLaunch && atStartUrl) {
    const last = asSurface(local.getItem(key))
    // Not recorded here: the app switched to records itself as it loads.
    if (last && last !== current) return last
  }
  local.setItem(key, current)
  return null
}
