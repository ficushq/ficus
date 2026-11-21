import { parseEntityReference } from '@ficus/shared'
import { readAssistantNavigation } from '../hooks/useAssistantNavigation'

/**
 * Recognizing controls that open an agent chat, so Shift+click or Alt/Option+click on any of them can
 * open the chat in a floating window instead (see FloatingWindowsProvider). Links are recognized by
 * their href; buttons and other non-anchor controls carry the agent id in this attribute.
 */
export const AGENT_CHAT_ATTRIBUTE = 'data-agent-chat-id'

/** Props marking a non-anchor control as opening this agent's chat. */
export function agentChatTarget(agentId: string | null | undefined): { 'data-agent-chat-id'?: string } {
  return agentId ? { [AGENT_CHAT_ATTRIBUTE]: agentId } : {}
}

const SQUAD_CHAT_PATH = /(?:^|\/)squads\/[^/]+(?:\/agents)?\/?$/
const CHAT_PATH = /(?:^|\/)chat\/([^/]+)\/?$/

/**
 * The agent an href opens a chat with: `/squads/:squad/agents?agent=:id`, `/squads/:squad?agent=:id`
 * (activity rows), the Assistant's view of an agent (`?commandStack=` ending in that agent's chat, which
 * is where squadless agents open), `/chat/:id` (old links, which redirect), or a `ficus:agent:`
 * reference (whose id may be a unique prefix). Only same-origin links count; the app's base path may
 * precede the route.
 */
export function agentIdFromHref(href: string | null | undefined, origin: string): string | null {
  if (!href) return null
  const reference = parseEntityReference(href)
  if (reference) return reference.kind === 'agent' ? reference.id : null
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  if (SQUAD_CHAT_PATH.test(url.pathname)) return url.searchParams.get('agent') || null
  if (url.searchParams.has('commandStack')) {
    const top = readAssistantNavigation(url.searchParams).at(-1)
    return top?.kind === 'chat' && top.agentId ? top.agentId : null
  }
  const chat = url.pathname.match(CHAT_PATH)?.[1]
  if (!chat) return null
  try {
    return decodeURIComponent(chat)
  } catch {
    return null
  }
}

/** The agent chat the clicked element opens, if it is (or sits inside) a control that opens one. */
export function agentChatTargetOf(target: EventTarget | null, origin: string): string | null {
  const element = target as Element | null
  if (!element || typeof element.closest !== 'function') return null
  const control = element.closest(`[${AGENT_CHAT_ATTRIBUTE}], a[href]`)
  if (!control || control.closest('[aria-disabled="true"], :disabled')) return null
  const id = control.getAttribute(AGENT_CHAT_ATTRIBUTE)
  if (id) return id
  return agentIdFromHref(control.getAttribute('href'), origin)
}

/** Shift+click or Alt/Option+click with the main button, and no Cmd/Ctrl (those keep opening a new tab). */
export function isFloatingWindowClick(
  event: Pick<MouseEvent, 'button' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>
): boolean {
  return event.button === 0 && (event.shiftKey || event.altKey) && !event.metaKey && !event.ctrlKey
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** The hint shown with the pop-out button. */
export const FLOATING_WINDOW_CLICK_HINT = MAC
  ? 'Shift-click or Option-click an agent link to open it in a floating window'
  : 'Shift-click or Alt-click an agent link to open it in a floating window'
