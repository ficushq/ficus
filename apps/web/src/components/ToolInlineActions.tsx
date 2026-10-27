import type { MessageToolCall } from '@ficus/shared'
import { getToolInlineActions, type ToolInlineAction } from '../lib/tool-inline-actions'

/**
 * A row of inline action links, lined up with the label of the tool row or group header above it.
 * Each button shows its action's own label, so new action kinds render here without changes.
 */
export function InlineActionRow({
  actions,
  onOpen,
}: {
  actions: ReadonlyArray<ToolInlineAction>
  onOpen?: (action: ToolInlineAction) => void
}) {
  if (!onOpen || actions.length === 0) return null
  return (
    <div data-tool-inline-actions className="ml-[18px] flex flex-wrap gap-x-3 gap-y-1 py-0.5">
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          aria-label={action.label}
          onClick={() => onOpen(action)}
          className="ficus-button ficus-button-link truncate text-left text-[11px] font-medium"
        >
          {action.label} →
        </button>
      ))}
    </div>
  )
}

/** The inline actions of one tool call, under its row. */
export function ToolInlineActions({
  toolCall,
  completed,
  onOpen,
}: {
  toolCall: MessageToolCall
  completed: boolean
  onOpen?: (action: ToolInlineAction) => void
}) {
  return <InlineActionRow actions={getToolInlineActions({ toolCall, completed })} onOpen={onOpen} />
}
