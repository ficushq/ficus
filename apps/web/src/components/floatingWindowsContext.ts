import { createContext, useContext } from 'react'
import type { AgentWindow, ChatWindowsAction } from '../lib/chatWindows'

export interface FloatingWindowsApi {
  /** Floating windows can show here (a wide enough screen, and a signed-in identity to store them for). */
  available: boolean
  windows: AgentWindow[]
  /** Agents with unseen activity in a window that is not frontmost. */
  unread: ReadonlySet<string>
  /** Opens an agent's chat in a window, or brings its existing window forward (restoring it if minimized). */
  open: (agentIdOrPrefix: string) => void
  /** Brings an agent's existing window forward and returns true; false (doing nothing) when it has none. */
  focusIfFloating: (agentId: string) => boolean
  isFloating: (agentId: string) => boolean
  /** Brings a window (or the assistant, by `assistant`) to the front of the shared stack. */
  bringToFront: (key: string) => void
  /** A window's (or the assistant's) rank in the shared stack, back to front; -1 when it is not in it. */
  rankOf: (key: string) => number
  /** The CSS z-index of a window (or the assistant) in the shared stack. */
  zIndexFor: (key: string) => number
  /** Whether this window is the frontmost one, the assistant included when it is open. */
  isFront: (key: string) => boolean
  setAssistantShown: (shown: boolean) => void
  dispatch: (action: ChatWindowsAction) => void
  markUnread: (agentId: string) => void
}

export const FloatingWindowsContext = createContext<FloatingWindowsApi | null>(null)

/** The floating window manager, or null outside the app shell (tests, the voice page). */
export function useFloatingWindows(): FloatingWindowsApi | null {
  return useContext(FloatingWindowsContext)
}

/** The agent whose floating window contains this component, if any. */
export const FloatingWindowAgentContext = createContext<string | null>(null)
