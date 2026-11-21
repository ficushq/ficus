import { expect, test } from 'bun:test'
import { agentChatPath, assistantAgentChatPath } from './agent-chat-path'

const agentId = '11111111-2222-4333-8444-555555555555'
const squadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

test('a squad agent opens in its squad Chats tab', () => {
  expect(agentChatPath({ id: agentId, squadId })).toBe(`/squads/${squadId}/agents?agent=${agentId}`)
})

test('the squad segment and agent id are encoded', () => {
  expect(agentChatPath({ id: 'a/b', squadId: 'my squad' })).toBe('/squads/my%20squad/agents?agent=a%2Fb')
})

test('a squadless agent opens in the Assistant conversation view, never the legacy chat page', () => {
  for (const squad of [null, undefined, '']) {
    const path = agentChatPath({ id: agentId, squadId: squad })
    expect(path).toBe(assistantAgentChatPath(agentId))
    expect(path).not.toContain('/chat/')
    const url = new URL(path, 'https://ficus.invalid')
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('chat')).toBe('open')
    expect(JSON.parse(url.searchParams.get('commandStack')!)).toEqual([['chat', agentId, '', agentId, '']])
  }
})
