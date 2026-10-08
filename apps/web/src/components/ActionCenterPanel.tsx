import { ActionCenterContent } from './ActionCenterContent'
import { CloseIcon } from './icons'
import type { PendingAction } from '@ficus/shared'

interface ActionCenterPanelProps {
  isOpen: boolean
  onClose: () => void
  actions: PendingAction[]
  isLoading: boolean
  isError?: boolean
  error?: unknown
  onRetry?: () => void
}

export function ActionCenterPanel({
  isOpen,
  onClose,
  actions,
  isLoading,
  isError,
  error,
  onRetry,
}: ActionCenterPanelProps) {
  if (!isOpen) return null

  return (
    <>
      {/* Invisible backdrop to close on outside click */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Popover dropdown */}
      <div className="ficus-overlay fixed top-14 right-3 w-[calc(100vw-1.5rem)] sm:right-4 sm:w-[26rem] max-h-[calc(100dvh-5rem)] bg-surface rounded-lg shadow-theme-lg border border-th-border z-50 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-th-border rounded-t-lg">
          <h2 className="font-semibold text-primary">Action Center</h2>
          <button onClick={onClose} aria-label="Close Action Center" className="ficus-button ficus-button-ghost p-2">
            <CloseIcon />
          </button>
        </div>
        <div className="overflow-y-auto p-4 flex-1">
          <ActionCenterContent
            actions={actions}
            isLoading={isLoading}
            isError={isError}
            error={error}
            onRetry={onRetry}
            onClose={onClose}
          />
        </div>
      </div>
    </>
  )
}
