import { useState, useEffect } from 'react'
import { usePendingActions } from '../hooks/usePendingActions'
import { ActionCenterPanel } from './ActionCenterPanel'

export function ActionCenter() {
  const [isOpen, setIsOpen] = useState(false)
  const { data: actions, isLoading, isError, error, refetch } = usePendingActions()

  // Broadcast open state changes so other components (e.g. bell icon) can react
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('action-center-state', { detail: { isOpen } }))
  }, [isOpen])

  // Listen for external open trigger (e.g. from mobile bottom nav)
  useEffect(() => {
    const handler = () => setIsOpen(true)
    window.addEventListener('open-action-center', handler)
    return () => window.removeEventListener('open-action-center', handler)
  }, [])

  // Keyboard shortcut: 'A' to toggle. Escape is the panel's own (Popover) dismissal.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const tag = (e.target as HTMLElement).tagName
      const inputFocused =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable

      if ((e.key === 'a' || e.key === 'A') && !inputFocused) {
        e.preventDefault()
        setIsOpen((prev) => !prev)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <>
      <ActionCenterPanel
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        actions={actions ?? []}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
      />
    </>
  )
}
