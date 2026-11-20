import { ActionCenterContent } from './ActionCenterContent'
import { HEADER_DROPDOWN_PLACEMENT } from './headerDropdown'
import { CloseIcon } from './icons'
import { Panel } from './popover'
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

/**
 * The Action Center dropdown under the header. A `Panel` on the popover layer, so it draws above floating
 * windows and the Assistant; an outside press, Escape or its close button closes it. Opening it leaves focus
 * where it was.
 */
export function ActionCenterPanel({
  isOpen,
  onClose,
  actions,
  isLoading,
  isError,
  error,
  onRetry,
}: ActionCenterPanelProps) {
  return (
    <Panel
      {...HEADER_DROPDOWN_PLACEMENT}
      label="Action Center"
      open={isOpen}
      onDismiss={onClose}
      initialFocus="none"
      scroll={false}
      className="ficus-overlay w-[calc(100vw-1.5rem)] sm:w-104 bg-surface rounded-lg shadow-theme-lg border border-th-border flex flex-col origin-top-right"
    >
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
    </Panel>
  )
}
