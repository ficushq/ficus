import { describe, expect, test } from 'bun:test'
import { getVisibleAgentContext, getVisibleAgentContexts } from './pageContext'

function docWithDrawerAgent(agentId: string | null): Pick<Document, 'querySelector'> {
  return {
    querySelector() {
      if (!agentId) return null
      return {
        getAttribute(name: string) {
          return name === 'data-voice-current-agent-id' ? agentId : null
        },
      } as Element
    },
  }
}

describe('getVisibleAgentContext', () => {
  test('detects the open system manager chat drawer before URL agent context', () => {
    expect(getVisibleAgentContext('/chat/url-agent', docWithDrawerAgent('drawer-agent'))).toEqual({
      id: 'drawer-agent',
      source: 'system-manager-chat-drawer',
    })
  })

  test('returns drawer before URL agent when both are visible', () => {
    expect(getVisibleAgentContexts('/chat/url-agent', docWithDrawerAgent('drawer-agent'))).toEqual([
      { id: 'drawer-agent', source: 'system-manager-chat-drawer' },
      { id: 'url-agent', source: 'url' },
    ])
  })

  test('falls back to chat URL agent when no drawer is open', () => {
    expect(getVisibleAgentContext('/chat/url-agent', docWithDrawerAgent(null))).toEqual({
      id: 'url-agent',
      source: 'url',
    })
  })
})

test('a persisted agent selection on another squad tab is not an open conversation', () => {
  expect(getVisibleAgentContexts('/squads/ficus/work?agent=agent-1', docWithDrawerAgent(null))).toEqual([])
  expect(getVisibleAgentContexts('/squads/ficus/home?agent=agent-1', docWithDrawerAgent(null))).toEqual([])
  expect(getVisibleAgentContexts('/squads/ficus/agents?agent=agent-1', docWithDrawerAgent(null))).toEqual([
    { id: 'agent-1', source: 'url' },
  ])
})

test('the selected nested agent is primary context, without confusing a hidden parent chat for the recipient', () => {
  const params = new URLSearchParams({
    chat: 'open',
    commandStack: JSON.stringify([
      ['assistant', 'conversation'],
      ['chat', 'manager', 'squad', 'manager'],
    ]),
  })
  expect(getVisibleAgentContexts(`/chat/page-agent?${params}`, docWithDrawerAgent(null))).toEqual([
    { id: 'manager', source: 'command-bar-chat' },
    { id: 'page-agent', source: 'url' },
  ])
  params.set('chat', 'closed')
  expect(getVisibleAgentContexts(`/chat/page-agent?${params}`, docWithDrawerAgent(null))).toEqual([
    { id: 'page-agent', source: 'url' },
  ])
})
