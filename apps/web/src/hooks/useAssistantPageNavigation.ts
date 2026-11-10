import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { assistantNavigationPath } from '../lib/assistantNavigationPath'
import { useStableRef } from './useStableRef'

/** Change the underlying page without dismissing the active Assistant conversation. */
export function useAssistantPageNavigation() {
  const location = useStableRef(useLocation())
  const navigate = useStableRef(useNavigate())
  return useCallback(
    (path: string) => {
      navigate.current(assistantNavigationPath(path, `${location.current.pathname}${location.current.search}`))
    },
    [location, navigate]
  )
}
