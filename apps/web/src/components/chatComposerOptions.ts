import { createContext, useContext } from 'react'

/**
 * Set while a chat composer renders its controls as rows of its options popup (the menu a narrow
 * composer folds its actions into, or the options sheet on phones). A `composerControls` button reads
 * it to draw itself as a labelled row in that list instead of an icon button in the action row.
 */
export interface ChatComposerOptionRow {
  /** The row's classes, matching the popup's other rows. */
  rowClass: string
  /** The row icon's classes. */
  iconClass: string
}

export const ChatComposerOptionsContext = createContext<ChatComposerOptionRow | null>(null)

/** The composer options popup's row styling while rendering inside it, else null. */
export function useChatComposerOptionRow(): ChatComposerOptionRow | null {
  return useContext(ChatComposerOptionsContext)
}
