import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { assistantNavigationPath } from '../lib/assistantNavigationPath'
import { useStableRef } from './useStableRef'

/** Change the underlying page without dismissing the active Assistant conversation. */
export function useAssistantPageNavigation() {
  const locationRef = useStableRef(useLocation())
  const navigateRef = useStableRef(useNavigate())
  return useCallback(
    (path: string) => {
      navigateRef.current(assistantNavigationPath(path, `${locationRef.current.pathname}${locationRef.current.search}`))
    },
    [locationRef, navigateRef]
  )
}
