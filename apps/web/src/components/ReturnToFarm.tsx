import { useEffect } from 'react'
import { farmHref, farmNavigation } from './navModel'

/**
 * Rendered at FARM_SIGN_IN_PATH (navModel) once signed in (signed out, the path
 * shows the login page like any other). Replaces itself with the farm, so an
 * installed farm app that had to sign in lands back on the farm, not the feed.
 */
export function ReturnToFarm() {
  useEffect(() => {
    farmNavigation.go(farmHref())
  }, [])
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted" role="status">
      Opening the farm…
    </div>
  )
}
