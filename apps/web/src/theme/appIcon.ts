import {
  BRAND_MARK_FILLS,
  recolorMark,
  THEME_ICON_TOKENS,
  themeIconColors,
  type ThemeIconColors,
} from '@ficus/shared/theme-icon'
import type { EffectiveAppearance } from '@ficus/shared/theme-schema'
import { desktopAppIcon, type DesktopAppIcon } from '../lib/desktop'

/** public/icons/favicon.svg (brand/ficus-favicon-16.svg), recolored per theme. A test keeps the two identical. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <g transform="translate(32 38) scale(1.2)"><path d="M0 0 C9 -5 12.5 -16 7 -22.5 C4.8 -25.2 2.4 -27.6 0 -30 C-2.4 -27.6 -4.8 -25.2 -7 -22.5 C-12.5 -16 -9 -5 0 0 Z" fill="${BRAND_MARK_FILLS.leaf}"/></g>
  <rect x="12" y="36" width="40" height="9" rx="3" fill="${BRAND_MARK_FILLS.pot}"/>
  <path d="M15 44.25 H49 L45 62 H19 Z" fill="${BRAND_MARK_FILLS.pot}"/>
</svg>`

/** Marks the favicon link this module owns. */
const THEMED_FAVICON_ATTRIBUTE = 'data-theme-icon'

export interface ActiveTheme {
  themeId: string
  appearance: EffectiveAppearance
  custom: boolean
}

/** The icon colors for the theme painted on `root`, or null when a token is missing. */
export function readThemeIconColors(root: HTMLElement, theme: ActiveTheme): ThemeIconColors | null {
  const style = window.getComputedStyle(root)
  const tokens = Object.fromEntries(
    Object.entries(THEME_ICON_TOKENS).map(([role, token]) => [role, style.getPropertyValue(token).trim()])
  )
  return themeIconColors(tokens, theme.custom ? undefined : { themeId: theme.themeId, appearance: theme.appearance })
}

export function themedFaviconHref(colors: ThemeIconColors): string {
  return `data:image/svg+xml,${encodeURIComponent(recolorMark(FAVICON_SVG, colors))}`
}

/** Replaces index.html's scheme-matched PNG favicons with one SVG in the theme's colors. */
function applyFavicon(colors: ThemeIconColors) {
  const href = themedFaviconHref(colors)
  let link = document.head.querySelector<HTMLLinkElement>(`link[${THEMED_FAVICON_ATTRIBUTE}]`)
  if (!link) {
    for (const stale of document.head.querySelectorAll('link[rel="icon"]')) stale.remove()
    link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    link.setAttribute(THEMED_FAVICON_ATTRIBUTE, '')
    document.head.appendChild(link)
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
}

let lastDesktopIcon = ''

/**
 * Points the favicon, and Desktop's Dock icon when this window is in Ficus Desktop, at the theme just painted on
 * `root`. Call after each real repaint, never for a preview. Leaves both alone when the theme's tokens can't be read.
 */
export function publishThemeIcon(root: HTMLElement, theme: ActiveTheme) {
  const colors = readThemeIconColors(root, theme)
  if (!colors) return
  applyFavicon(colors)
  const setAppIcon = desktopAppIcon()
  if (!setAppIcon) return
  const icon: DesktopAppIcon = { ...theme, colors: { ...colors } }
  const key = JSON.stringify(icon)
  if (key === lastDesktopIcon) return
  lastDesktopIcon = key
  Promise.resolve()
    .then(() => setAppIcon(icon))
    .catch(() => {
      // Desktop keeps its current icon; send again on the next change.
      if (lastDesktopIcon === key) lastDesktopIcon = ''
    })
}

/** Test seam: forget the last icon sent to Desktop. */
export function resetPublishedThemeIcon() {
  lastDesktopIcon = ''
}
