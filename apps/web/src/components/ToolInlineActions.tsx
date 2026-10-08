import type { MessageToolCall } from '@ficus/shared'
import { getToolInlineActions, type ToolInlineAction } from '../lib/tool-inline-actions'

export function ToolInlineActions({
  toolCall,
  completed,
  onOpen,
}: {
  toolCall: MessageToolCall
  completed: boolean
  onOpen?: (action: ToolInlineAction) => void
}) {
  const actions = getToolInlineActions({ toolCall, completed })
  if (!onOpen || actions.length === 0) return null
  return (
    <div data-tool-inline-actions className="ml-[18px] flex flex-wrap gap-x-3 gap-y-1 py-0.5">
      {actions.map((action) => {
        const accessibleLabel = action.kind === 'monitor' ? 'Open monitor' : `Open ${action.label} chat`
        return (
          <button
            key={action.key}
            type="button"
            aria-label={accessibleLabel}
            onClick={() => onOpen(action)}
            className="ficus-button ficus-button-link truncate text-left text-[11px] font-medium"
          >
            {accessibleLabel} →
          </button>
        )
      })}
    </div>
  )
}
