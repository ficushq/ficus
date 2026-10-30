import { createContext, useContext, useEffect } from 'react'
import type { MessageToolCall } from '@ficus/shared'
import { usePermissions } from '../hooks/usePermissions'
import { getToolInlineActions, type ToolInlineAction } from '../lib/tool-inline-actions'

/** The chat the actions belong to: the agent and squad their targets open through. */
export interface ToolInlineActionScope {
  agentId?: string
  squadId?: string
}

const ToolInlineActionScopeContext = createContext<ToolInlineActionScope | null>(null)

/**
 * Enables access checks for the inline actions inside: each action shows only when the viewer can open it (its
 * permission in its squad, and the chat's agent or squad when it opens through them). Without a provider every
 * action shows, for transcripts rendered outside a chat.
 */
export const ToolInlineActionScopeProvider = ToolInlineActionScopeContext.Provider

function InlineActionButton({
  action,
  onOpen,
}: {
  action: ToolInlineAction
  onOpen: (action: ToolInlineAction) => void
}) {
  return (
    <button
      type="button"
      aria-label={action.label}
      onClick={() => onOpen(action)}
      className="ficus-button ficus-button-link truncate text-left text-[11px] font-medium"
    >
      {action.label} →
    </button>
  )
}

/** An action button that renders only when the viewer can open the action in this chat's scope. */
function ScopedInlineActionButton({
  action,
  onOpen,
  scope,
}: {
  action: ToolInlineAction
  onOpen: (action: ToolInlineAction) => void
  scope: ToolInlineActionScope
}) {
  const access = action.access
  // Permissions are cached per squad, so every button in a squad shares one request; while they load, hide.
  const { can, isLoading } = usePermissions(access?.squadId ?? scope.squadId)
  if (access?.needs === 'agent' && !scope.agentId) return null
  if (access?.needs === 'squad' && !(access.squadId ?? scope.squadId)) return null
  if (access?.permission && (isLoading || !can(access.permission))) return null
  return <InlineActionButton action={action} onOpen={onOpen} />
}

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
  const scope = useContext(ToolInlineActionScopeContext)
  if (!onOpen || actions.length === 0) return null
  return (
    // `empty:hidden` collapses the row when the viewer can open none of its actions.
    <div data-tool-inline-actions className="ml-[18px] flex flex-wrap gap-x-3 gap-y-1 py-0.5 empty:hidden">
      {actions.map((action) =>
        scope ? (
          <ScopedInlineActionButton key={action.key} action={action} onOpen={onOpen} scope={scope} />
        ) : (
          <InlineActionButton key={action.key} action={action} onOpen={onOpen} />
        )
      )}
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

/** How long an inline action notice stays up before clearing itself. */
const INLINE_ACTION_NOTICE_MS = 5000

/**
 * A short, non-blocking notice for an inline action that couldn't open (its target is gone). It floats above
 * the chat and any modal, announces itself politely, and clears after a few seconds or when dismissed.
 * `id` changes with every notice, so repeating the same message restarts the timer.
 */
export function InlineActionNotice({
  id,
  message,
  onDismiss,
  durationMs = INLINE_ACTION_NOTICE_MS,
}: {
  id: number
  message: string
  onDismiss: () => void
  durationMs?: number
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs)
    return () => clearTimeout(timer)
  }, [id, durationMs, onDismiss])
  return (
    <div
      role="status"
      aria-live="polite"
      data-inline-action-notice
      className="fixed bottom-6 left-1/2 z-[70] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-th-border bg-surface px-3 py-2 text-sm shadow-theme-lg"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ficus-button ficus-button-ghost -my-1 px-2 py-1 text-xs font-medium"
      >
        Dismiss
      </button>
    </div>
  )
}
