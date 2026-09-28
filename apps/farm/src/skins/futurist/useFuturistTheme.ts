import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { farmQueries } from '../../api/queries'
import { tripleFor } from './themeTriples'

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

/** While the Futurist style is on, paint it in the user's web-app theme's three colours. */
export function useFuturistTheme(active: boolean) {
  const preference = useQuery({ ...farmQueries.themePreference(), enabled: active })
  const prefersDark = usePrefersDark()
  const theme = preference.data?.theme
  const triple = tripleFor(theme, prefersDark)
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
