import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { assistantNavigationPath } from '../lib/assistantNavigationPath'

/**
 * Navigation state marking a page change that deliberately dismisses the
 * Assistant (the command center's "go to page" jump).
 */
export const CLOSE_ASSISTANT_STATE = { closeAssistant: true } as const

function closesAssistant(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { closeAssistant?: unknown }).closeAssistant === true
}

/**
 * Keep an open Assistant open when the page behind it changes. Its open state
 * and conversation stack live in the URL, so any ordinary link to another page
 * (the app nav, a squad card) used to drop them and close it. When the path
 * changes while it was open, carry its parameters onto the new page with the
 * same rule the Assistant's own navigation uses (assistantNavigationPath).
 * Changes within one page — including closing the Assistant — are left alone.
 */
export function useKeepAssistantAcrossPages(): void {
  const location = useLocation()
  const navigate = useNavigate()
  const previous = useRef<string | null>(null)
  useLayoutEffect(() => {
    const here = `${location.pathname}${location.search}${location.hash}`
    const last = previous.current
    previous.current = here
    if (last === null || closesAssistant(location.state)) return
    if (new URL(last, 'https://ficus.invalid').pathname === location.pathname) return
    const carried = assistantNavigationPath(here, last)
    if (carried === here) return
    previous.current = carried
    navigate(carried, { replace: true, state: location.state })
  }, [location, navigate])
}
