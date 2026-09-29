import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { farmQueries } from '../../api/queries'
import { tripleFor } from './themeTriples'
import { embedTheme, subscribeEmbedTheme } from '../../embed/embed'

function usePrefersDark(): boolean {
  const query = typeof window === 'undefined' ? null : window.matchMedia?.('(prefers-color-scheme: dark)')
  const [dark, setDark] = useState(() => query?.matches ?? false)
  useEffect(() => {
    if (!query) return
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [query])
  return dark
}

/**
 * While the Futurist style is on, paint it in the user's theme's three
 * colours: the theme Ficus Mobile sends (live, as it changes in Settings) when
 * the farm is in its web view, else the account's web-app theme. A custom
 * theme's palette primary is its accent.
 */
export function useFuturistTheme(active: boolean) {
  const appTheme = useSyncExternalStore(subscribeEmbedTheme, embedTheme, () => null)
  const preference = useQuery({ ...farmQueries.themePreference(), enabled: active && !appTheme })
  const prefersDark = usePrefersDark()
  const theme = appTheme ?? preference.data?.theme
  const base = tripleFor(theme, prefersDark)
  const triple = { ...base, accent: theme?.customTheme?.palette?.primary ?? base.accent }
  // Native controls (scrollbars, pickers) match the theme's appearance; Futurist's own palette is dark.
  const scheme = !theme ? 'dark' : theme.appearance === 'system' ? (prefersDark ? 'dark' : 'light') : theme.appearance
  useEffect(() => {
    if (!active) return
    const root = document.documentElement.style
    root.setProperty('--fu-theme-bg', triple.background)
    root.setProperty('--fu-theme-fg', triple.foreground)
    root.setProperty('--fu-theme-accent', triple.accent)
    root.setProperty('color-scheme', scheme)
    return () => {
      root.removeProperty('color-scheme')
      root.removeProperty('--fu-theme-bg')
      root.removeProperty('--fu-theme-fg')
      root.removeProperty('--fu-theme-accent')
    }
  }, [active, triple.background, triple.foreground, triple.accent, scheme])
}
