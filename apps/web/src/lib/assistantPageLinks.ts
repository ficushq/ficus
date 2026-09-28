import type { RenderItem } from '@ficus/client-core'
import { navItems } from '../components/navModel'
import { ALL_SECTIONS } from '../components/settings/settingsSections'
import { SQUAD_SETTINGS_SECTIONS, SQUAD_TABS } from './squadNavigation'

export type AppPathKind = 'page' | 'squad' | 'work-stream' | 'settings' | 'conversation'
export interface AppPathDescription {
  kind: AppPathKind
  title: string
  /** Where the destination lives when it isn't obvious from the title, e.g. "Settings". */
  context?: string
  squadId?: string
}

/**
 * Pages the Assistant offered with `navigate` (`prompt: true`). Offers are links the user chooses to
 * follow; `prompt: false` navigations already happened and are not repeated. Only app-relative
 * paths are accepted.
 */
export function durableAssistantPageLinks(item: Extract<RenderItem, { kind: 'persisted' }>): string[] {
  const paths = new Set<string>()
  for (const block of item.blocks) {
    if (block.type !== 'tool_use' || block.toolCall.toolName !== 'navigate' || block.toolCall.isError) continue
    try {
      const args = JSON.parse(block.toolCall.args) as { path?: unknown; prompt?: unknown }
      if (args.prompt === true && typeof args.path === 'string' && /^\/(?!\/)/.test(args.path)) paths.add(args.path)
    } catch {
      /* Malformed arguments never become links. */
    }
  }
  return [...paths]
}

/** A readable name for an app route, from the same definitions that render navigation. */
export function describeAppPath(path: string): AppPathDescription {
  const url = new URL(path, 'http://tau.invalid')
  const parts = url.pathname.split('/').filter(Boolean)
  const params = url.searchParams
  if (parts[0] === 'settings') {
    const section = ALL_SECTIONS.find((item) => item.id === params.get('section'))
    return section
      ? { kind: 'settings', title: section.label, context: 'Settings' }
      : { kind: 'settings', title: 'Settings' }
  }
  if (parts[0] === 'squads' && parts[1]) {
    const squadId = parts[1]
    const tab = parts[2] ?? 'home'
    const ws = params.get('ws')
    if (ws) return { kind: 'work-stream', title: /^\d+$/.test(ws) ? `Work stream #${ws}` : 'Work stream', squadId }
    if (tab === 'agents' && params.get('agent')) return { kind: 'conversation', title: 'Agent conversation', squadId }
    if (tab === 'settings') {
      const section = SQUAD_SETTINGS_SECTIONS.find((item) => item.id === params.get('section'))
      return { kind: 'settings', title: section ? `${section.label} settings` : 'Squad settings', squadId }
    }
    return { kind: 'squad', title: SQUAD_TABS.find((item) => item.path === tab)?.label ?? 'Squad', squadId }
  }
  if (parts[0] === 'chat' && parts[1]) return { kind: 'conversation', title: 'Conversation' }
  const top = `/${parts[0] ?? ''}`
  const nav = navItems.find((item) => item.to === top)
  return { kind: 'page', title: nav?.label ?? url.pathname }
}
