import { readAssistantNavigation } from '../hooks/useAssistantNavigation'

export type VisibleAgentSource = 'url' | 'system-manager-chat-drawer' | 'command-bar-chat'

export interface VisibleAgentContext {
  id: string
  source: VisibleAgentSource
}

function getUrlAgentId(path: string): string | null {
  const agentMatch = path.match(/\/chat\/([^/?]+)/)
  const url = new URL(path, 'https://ficus.local')
  const tab = url.pathname.split('/')[3] ?? url.searchParams.get('tab')
  const agentParam = !tab || tab === 'agents' ? path.match(/[?&]agent=([^&]+)/) : null
  const agentId = agentMatch?.[1] ?? agentParam?.[1]
  return agentId ? decodeURIComponent(agentId) : null
}

function getDrawerAgentId(doc: Pick<Document, 'querySelector'>): string | null {
  try {
    return (
      doc
        .querySelector('[data-voice-current-agent-source="system-manager-chat-drawer"][data-voice-current-agent-id]')
        ?.getAttribute('data-voice-current-agent-id')
        ?.trim() || null
    )
  } catch {
    return null
  }
}

export function getVisibleAgentContexts(
  path: string,
  doc: Pick<Document, 'querySelector'> = document
): VisibleAgentContext[] {
  const drawerAgentId = getDrawerAgentId(doc)
  const urlAgentId = getUrlAgentId(path)

  const context: VisibleAgentContext[] = []

  const params = new URL(path, 'https://ficus.local').searchParams
  const selected = readAssistantNavigation(params).at(-1)
  if (params.get('chat') !== 'closed' && params.has('chat') && selected?.kind === 'chat' && selected.agentId)
    context.push({ id: selected.agentId, source: 'command-bar-chat' })

  // The selected command bar chat is primary, followed by any older drawer.
  if (drawerAgentId && !context.some((agent) => agent.id === drawerAgentId)) {
    context.push({ id: drawerAgentId, source: 'system-manager-chat-drawer' })
  }

  // URL agent is secondary
  if (urlAgentId && !context.some((agent) => agent.id === urlAgentId)) {
    context.push({ id: urlAgentId, source: 'url' })
  }

  return context
}

export function getVisibleAgentContext(
  path: string,
  doc: Pick<Document, 'querySelector'> = document
): VisibleAgentContext | null {
  return getVisibleAgentContexts(path, doc)[0] ?? null
}
