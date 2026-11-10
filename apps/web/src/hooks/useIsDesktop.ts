import { useMediaQuery } from './useMediaQuery'

const DESKTOP_QUERY = '(min-width: 768px)'

/** Whether the viewport is at least the desktop breakpoint; true without matchMedia. */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY, true)
}
