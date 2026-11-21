import { expect, test } from 'bun:test'
import { assistantAgentChatPath } from '@ficus/shared'
import { universeNodePath } from './universeNodePath'

const slugFor = (id: string) => (id === 'squad-1' ? 'ficus' : id)

test('a squad node opens the squad page', () => {
  expect(universeNodePath({ id: 'squad-1', type: 'squad' }, slugFor)).toBe('/squads/ficus')
})

test('an agent node opens its squad Chats tab, never the legacy chat page', () => {
  expect(universeNodePath({ id: 'agent-1', type: 'agent', squadId: 'squad-1' }, slugFor)).toBe(
    '/squads/ficus/agents?agent=agent-1'
  )
  expect(universeNodePath({ id: 'agent-1', type: 'agent' }, slugFor)).toBe(assistantAgentChatPath('agent-1'))
})

test('other nodes go nowhere', () => {
  expect(universeNodePath({ id: 'x', type: 'other' }, slugFor)).toBeNull()
})
