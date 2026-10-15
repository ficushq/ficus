import type { Message } from '@ficus/shared'
import { getSettingsStore } from '../settings'
import { REPLY_SUGGESTIONS_SETTING } from './service'

/** Whether the instance switch for reply suggestions is on. */
export function replySuggestionsEnabled(): boolean {
  return getSettingsStore().getTyped(REPLY_SUGGESTIONS_SETTING) === true
}

/**
 * Messages as clients may see them: while the switch is off, saved replies are left out, so every
 * client (web and mobile) stops showing chips without a check of its own. The rows keep them, so
 * turning the switch back on shows them again.
 */
export function withVisibleReplySuggestions<T extends Pick<Message, 'metadata'>>(messages: T[], enabled: boolean): T[] {
  if (enabled) return messages
  return messages.map((message) => {
    if (!message.metadata || !('replySuggestions' in message.metadata)) return message
    const { replySuggestions: _hidden, ...metadata } = message.metadata
    return { ...message, metadata }
  })
}
