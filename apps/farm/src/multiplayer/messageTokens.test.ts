import { describe, expect, test } from 'bun:test'
import { bubbleText, refFromUrl, tokenize } from './messageTokens'

const WS = '11111111-2222-4333-8444-555555555555'
const AGENT = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const SQUAD = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const PEOPLE = [{ id: 'rosa', name: 'Rosa Díaz' }]

describe('chat message tokens', () => {
  test('split text, mentions, farm references and links', () => {
    const body = `@Rosa look at ficus:ws:${WS} and ficus:agent:${AGENT}, docs at https://example.com/guide.`
    expect(tokenize(body, PEOPLE)).toEqual([
      { kind: 'mention', text: '@Rosa', userId: 'rosa' },
      { kind: 'text', text: ' look at ' },
      { kind: 'ref', text: `ficus:ws:${WS}`, ref: { kind: 'ws', id: WS } },
      { kind: 'text', text: ' and ' },
      { kind: 'ref', text: `ficus:agent:${AGENT}`, ref: { kind: 'agent', id: AGENT } },
      { kind: 'text', text: ', docs at ' },
      { kind: 'link', text: 'https://example.com/guide', href: 'https://example.com/guide' },
      { kind: 'text', text: '.' },
    ])
  })

  test('read work stream numbers, and ignore malformed references', () => {
    expect(tokenize('see ficus:ws:42', [])).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'ref', text: 'ficus:ws:42', ref: { kind: 'ws', id: '42' } },
    ])
    expect(tokenize('ficus:agent:nope', [])).toEqual([{ kind: 'text', text: 'ficus:agent:nope' }])
    // The pre-rename scheme: Core's migration 0196 rewrote stored messages, so it is plain text (Task 36c).
    expect(tokenize('tau:ws:42', [])).toEqual([{ kind: 'text', text: 'tau:ws:42' }]) // ficus-negative-test
  })

  test('turn web-app links into farm references', () => {
    expect(refFromUrl(`https://acme.ficus.sh/squads/${SQUAD}/work?ws=${WS}`)).toEqual({ kind: 'ws', id: WS })
    expect(refFromUrl(`https://acme.ficus.sh/app/squads/${SQUAD}`)).toEqual({ kind: 'squad', id: SQUAD })
    expect(refFromUrl(`https://acme.ficus.sh/chat/${AGENT}`)).toEqual({ kind: 'agent', id: AGENT })
    expect(refFromUrl('https://acme.ficus.sh/settings')).toBeNull()
    const link = `https://acme.ficus.sh/chat/${AGENT}`
    expect(tokenize(link, [])).toEqual([{ kind: 'ref', text: link, ref: { kind: 'agent', id: AGENT }, href: link }])
  })

  test('turn every agent chat link the web app writes into an agent reference', () => {
    const stack = (rows: unknown) => encodeURIComponent(JSON.stringify(rows))
    for (const link of [
      // A squad agent's Chats tab, by squad id or slug, with or without the agents tab.
      `https://acme.ficus.sh/squads/${SQUAD}/agents?agent=${AGENT}`,
      `https://acme.ficus.sh/squads/ficus/agents?agent=${AGENT}&view=chat`,
      `https://acme.ficus.sh/squads/ficus?agent=${AGENT}`,
      // A squadless agent's stable Assistant route, also under a base path.
      `https://acme.ficus.sh/assistant/agents/${AGENT}`,
      `https://acme.ficus.sh/app/assistant/agents/${AGENT}/`,
      // Squadless links written before that route: the Assistant's URL state ending in the agent's chat.
      `https://acme.ficus.sh/?chat=open&commandStack=${stack([['chat', AGENT, '', AGENT, '']])}`,
      `https://acme.ficus.sh/settings?chat=open&commandStack=${stack([
        ['squad', SQUAD],
        ['chat', AGENT, '', AGENT, ''],
      ])}`,
      // The retired chat page, in older messages.
      `https://acme.ficus.sh/chat/${AGENT}`,
      `https://acme.ficus.sh/app/chat/${AGENT}?scope=all`,
    ])
      expect(refFromUrl(link)).toEqual({ kind: 'agent', id: AGENT })
    const link = `https://acme.ficus.sh/assistant/agents/${AGENT}`
    expect(tokenize(`ask ${link}.`, [])).toEqual([
      { kind: 'text', text: 'ask ' },
      { kind: 'ref', text: link, ref: { kind: 'agent', id: AGENT }, href: link },
      { kind: 'text', text: '.' },
    ])
  })

  test('leave links that are not an agent chat alone', () => {
    const stack = (rows: unknown) => encodeURIComponent(JSON.stringify(rows))
    // Squad pages other than its Chats tab stay squad and work stream references.
    expect(refFromUrl(`https://acme.ficus.sh/squads/${SQUAD}/work?ws=${WS}&agent=${AGENT}`)).toEqual({
      kind: 'ws',
      id: WS,
    })
    expect(refFromUrl(`https://acme.ficus.sh/squads/${SQUAD}/agents`)).toEqual({ kind: 'squad', id: SQUAD })
    // An Assistant open over a squad page is still that squad.
    expect(
      refFromUrl(
        `https://acme.ficus.sh/squads/${SQUAD}?chat=open&commandStack=${stack([['chat', AGENT, '', AGENT, '']])}`
      )
    ).toEqual({ kind: 'squad', id: SQUAD })
    for (const link of [
      'https://acme.ficus.sh/squads/ficus/agents?agent=not-an-id',
      'https://acme.ficus.sh/assistant/agents/not-an-id',
      `https://acme.ficus.sh/assistant/agents/${AGENT}/more`,
      'https://acme.ficus.sh/assistant',
      `https://acme.ficus.sh/?chat=open&commandStack=${stack([['assistant', 'conversation-1', '']])}`,
      'https://acme.ficus.sh/?chat=open&commandStack=not-json',
      'https://acme.ficus.sh/chat',
      `https://acme.ficus.sh/settings?agent=${AGENT}`,
    ])
      expect(refFromUrl(link)).toBeNull()
  })

  test('become plain text for a speech bubble', () => {
    expect(bubbleText(`ship ficus:ws:${WS} today, see https://example.com`)).toBe('ship 🔗 today, see 🔗')
  })
})
