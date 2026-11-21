import { expect, test } from 'bun:test'
import {
  ASSISTANT_AGENT_ROUTE,
  agentChatPath,
  agentIdFromAssistantAgentPath,
  assistantAgentChatPath,
} from './agent-chat-path'

const agentId = '11111111-2222-4333-8444-555555555555'
const squadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

test('a squad agent opens in its squad Chats tab', () => {
  expect(agentChatPath({ id: agentId, squadId })).toBe(`/squads/${squadId}/agents?agent=${agentId}`)
})

test('the squad segment and agent id are encoded', () => {
  expect(agentChatPath({ id: 'a/b', squadId: 'my squad' })).toBe('/squads/my%20squad/agents?agent=a%2Fb')
})

test('a squadless agent opens through the stable Assistant route, never the legacy chat page', () => {
  for (const squad of [null, undefined, '']) {
    const path = agentChatPath({ id: agentId, squadId: squad })
    expect(path).toBe(`/assistant/agents/${agentId}`)
    expect(path).toBe(assistantAgentChatPath(agentId))
    expect(path).toBe(ASSISTANT_AGENT_ROUTE.replace(':agentId', agentId))
    // The Assistant's internal URL state stays out of persisted links.
    expect(path).not.toContain('commandStack')
    expect(path).not.toContain('/chat/')
  }
})

test('the Assistant route encodes the agent id', () => {
  expect(assistantAgentChatPath('a/b c')).toBe('/assistant/agents/a%2Fb%20c')
})

test('reads the agent back from an Assistant route, with or without a base path', () => {
  expect(agentIdFromAssistantAgentPath(assistantAgentChatPath(agentId))).toBe(agentId)
  expect(agentIdFromAssistantAgentPath(`/ficus${assistantAgentChatPath(agentId)}/`)).toBe(agentId)
  expect(agentIdFromAssistantAgentPath(assistantAgentChatPath('a/b c'))).toBe('a/b c')
})

test('other paths are not Assistant agent routes', () => {
  for (const path of [
    '/',
    '/assistant',
    '/assistant/agents',
    '/assistant/agents/',
    `/assistant/agents/${agentId}/more`,
    `/chat/${agentId}`,
    `/squads/${squadId}/agents`,
    '/assistant/agents/%E0%A4%A',
  ])
    expect(agentIdFromAssistantAgentPath(path)).toBeNull()
})
