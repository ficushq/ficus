import { resumeSurface } from '@ficus/shared/app-surface'
import { webAppUrl } from '../api/base'

/** Running as an installed home-screen app (not a browser tab, not Ficus Desktop). */
export function isInstalledApp(): boolean {
  const w = window as Window & { ficusDesktopApp?: unknown; tauDesktopApp?: unknown }
  if (w.ficusDesktopApp || w.tauDesktopApp) return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true
}

/**
 * On a fresh launch of the installed app, reopen the web app if that is where
 * it was left (see @ficus/shared/app-surface). Returns true when the page is
 * leaving for the web app, so the caller skips booting the farm.
 */
export function resumeLastApp(
  farmBase: string = import.meta.env.BASE_URL || '/farm/',
  go: (url: string) => void = (url) => window.location.replace(url)
): boolean {
  try {
    const target = resumeSurface({
      current: 'farm',
      standalone: isInstalledApp(),
      atStartUrl: window.location.pathname === farmBase && !window.location.search,
      session: window.sessionStorage,
      local: window.localStorage,
    })
    if (target !== 'web') return false
    go(webAppUrl('/', farmBase))
    return true
  } catch {
    // Storage unavailable (private mode, blocked): just open where we are.
    return false
  }
}
