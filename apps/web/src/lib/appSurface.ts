import { resumeSurface } from '@ficus/shared/app-surface'
import { farmHref } from '../components/navModel'

/** Running as an installed home-screen app (not a browser tab, not Ficus Desktop). */
export function isInstalledApp(): boolean {
  const w = window as Window & { ficusDesktopApp?: unknown; tauDesktopApp?: unknown }
  if (w.ficusDesktopApp || w.tauDesktopApp) return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true
}

/**
 * On a fresh launch of the installed app, reopen the farm if that is where it
 * was left (see @ficus/shared/app-surface). Returns true when the page is
 * leaving for the farm, so the caller skips booting the web app.
 */
export function resumeLastApp(
  base: string = import.meta.env.BASE_URL || '/',
  go: (url: string) => void = (url) => window.location.replace(url)
): boolean {
  try {
    // The farm has no offline copy (the web app's worker keeps only this app):
    // offline, open here rather than on an error page.
    if (navigator.onLine === false) return false
    const target = resumeSurface({
      current: 'web',
      standalone: isInstalledApp(),
      atStartUrl: window.location.pathname === base.replace(/\/?$/, '/') && !window.location.search,
      session: window.sessionStorage,
      local: window.localStorage,
    })
    if (target !== 'farm') return false
    go(farmHref(base))
    return true
  } catch {
    // Storage unavailable (private mode, blocked): just open where we are.
    return false
  }
}
