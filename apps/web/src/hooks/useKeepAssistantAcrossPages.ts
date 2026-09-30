import { useLayoutEffect, useState } from 'react'
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
 * Return the carried parameters during render: repairing the URL in a layout
 * effect alone still commits a closed panel and an empty conversation stack.
 */
export function useKeepAssistantAcrossPages(): URLSearchParams {
  const location = useLocation()
  const navigate = useNavigate()
  const here = `${location.pathname}${location.search}${location.hash}`
  const [snapshot, setSnapshot] = useState({ location, path: here })
  let current = snapshot
  if (snapshot.location !== location) {
    const changedPage = snapshot.location.pathname !== location.pathname
    current = {
      location,
      path: changedPage && !closesAssistant(location.state) ? assistantNavigationPath(here, snapshot.path) : here,
    }
    // Adjust only when the router location changes. React retries this render
    // before committing children; unrelated renders retain the carried path
    // even if the router's replacement has not committed yet.
    setSnapshot(current)
  }
  const carried = current.path
  useLayoutEffect(() => {
    if (carried === here) return
    navigate(carried, { replace: true, state: location.state })
  }, [carried, here, location.state, navigate])
  return new URL(carried, 'https://ficus.invalid').searchParams
}
