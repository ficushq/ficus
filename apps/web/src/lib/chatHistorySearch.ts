import type { MessageSearchResult } from '@ficus/shared'

/** Is this the chat history search shortcut (Cmd/Ctrl+Shift+F)? Cmd/Ctrl+F stays the browser's find. */
export function isChatHistorySearchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>
) {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f'
}

/** The shortcut's modifier as this platform names it. */
export function shortcutModifierLabel(): string {
  return typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'
}

export function senderLabel(result: MessageSearchResult): string {
  if (result.isSystem) return 'System'
  if (result.role === 'assistant') return 'Agent'
  if (result.sender) return result.sender.name
  if (result.source === 'inbox') return 'Inbox delivery'
  if (result.source === 'monitor') return 'Monitor'
  return 'Message'
}
