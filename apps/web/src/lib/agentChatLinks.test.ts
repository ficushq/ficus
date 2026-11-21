import { expect, test } from 'bun:test'
import { agentIdFromHref, isFloatingWindowClick } from './agentChatLinks'
import { agentChatPath } from './entityReference'
import { assistantAgentDestination } from './assistantAgentDestination'

const origin = 'https://ficus.example'
const id = '11111111-1111-4111-8111-111111111111'
// The query squadless agent links carried before the Assistant route; already-sent notifications still do.
const oldStack = encodeURIComponent(JSON.stringify([['chat', id, '', id, '']]))

test('agent chat links are recognized in every form the app writes them', () => {
  expect(agentIdFromHref(`/squads/ficus/agents?agent=${id}`, origin)).toBe(id)
  expect(agentIdFromHref(`/squads/ficus/agents?agent=${id}&view=chat`, origin)).toBe(id)
  // Activity rows and the work stream modal link to the squad page with ?agent=.
  expect(agentIdFromHref(`/squads/ficus?agent=${id}&view=inbox`, origin)).toBe(id)
  expect(agentIdFromHref(`/chat/${id}`, origin)).toBe(id)
  // Served under a base path.
  expect(agentIdFromHref(`/ficus/squads/ficus/agents?agent=${id}`, origin)).toBe(id)
  expect(agentIdFromHref(`${origin}/chat/${id}`, origin)).toBe(id)
  // Markdown references, whose id may be a unique prefix.
  expect(agentIdFromHref(`ficus:agent:${id}`, origin)).toBe(id)
  expect(agentIdFromHref('ficus:agent:1111abcd', origin)).toBe('1111abcd')
  // A squadless agent's link: the stable Assistant route.
  expect(agentChatPath({ id, squadId: null })).toBe(`/assistant/agents/${id}`)
  expect(agentIdFromHref(agentChatPath({ id, squadId: null }), origin)).toBe(id)
  expect(agentIdFromHref(`${origin}/ficus${agentChatPath({ id, squadId: null })}`, origin)).toBe(id)
  // Squadless links written before that route: the Assistant's own URL state, ending in the agent's chat.
  expect(agentIdFromHref(assistantAgentDestination(id), origin)).toBe(id)
  expect(agentIdFromHref(`/?chat=open&commandStack=${oldStack}`, origin)).toBe(id)
  expect(agentIdFromHref(`${origin}/ficus/?chat=open&commandStack=${oldStack}`, origin)).toBe(id)
})

test('other links are not agent chats', () => {
  for (const href of [
    '/squads/ficus/work?ws=42',
    '/squads/ficus/agents',
    '/squads/ficus/agents?newConsultant=1',
    '/chat',
    '/assistant',
    '/assistant/agents',
    `/assistant/agents/${id}/extra`,
    `https://elsewhere.example/assistant/agents/${id}`,
    '/settings?agent=x',
    // The Assistant open on a saved conversation or a squad, not an agent chat.
    '/?chat=open&commandStack=' + encodeURIComponent(JSON.stringify([['assistant', 'conversation-1', '']])),
    '/?chat=open&commandStack=' + encodeURIComponent(JSON.stringify([['squad', 'squad-1']])),
    '/?chat=open&commandStack=not-json',
    'ficus:ws:42',
    `https://elsewhere.example/chat/${id}`,
    'https://github.com/ficushq/ficus/pull/1',
    '',
    null,
  ])
    expect(agentIdFromHref(href, origin)).toBeNull()
})

test('only Shift or Alt/Option with the main button opens a floating window; Cmd/Ctrl and other buttons do not', () => {
  const click = (extra: Partial<MouseEvent>) => ({
    button: 0,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...extra,
  })
  expect(isFloatingWindowClick(click({ shiftKey: true }))).toBe(true)
  expect(isFloatingWindowClick(click({ altKey: true }))).toBe(true)
  expect(isFloatingWindowClick(click({}))).toBe(false)
  expect(isFloatingWindowClick(click({ shiftKey: true, metaKey: true }))).toBe(false)
  expect(isFloatingWindowClick(click({ altKey: true, ctrlKey: true }))).toBe(false)
  expect(isFloatingWindowClick(click({ shiftKey: true, button: 1 }))).toBe(false)
})
