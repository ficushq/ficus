import { describe, expect, test } from 'bun:test'
import { LEGACY_ENTITY_REFERENCE_SCHEME } from '@ficus/shared'
import { bubbleText, refFromUrl, tokenize } from './messageTokens'

const WS = '11111111-2222-4333-8444-555555555555'
const AGENT = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const SQUAD = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const PEOPLE = [{ id: 'rosa', name: 'Rosa Díaz' }]
// References stored before the rename keep their old scheme (Task 36c migrates them).
const LEGACY_AGENT_REF = `${LEGACY_ENTITY_REFERENCE_SCHEME}:agent:${AGENT}`

describe('chat message tokens', () => {
  test('split text, mentions, farm references and links', () => {
    const body = `@Rosa look at ficus:ws:${WS} and ${LEGACY_AGENT_REF}, docs at https://example.com/guide.`
    expect(tokenize(body, PEOPLE)).toEqual([
      { kind: 'mention', text: '@Rosa', userId: 'rosa' },
      { kind: 'text', text: ' look at ' },
      { kind: 'ref', text: `ficus:ws:${WS}`, ref: { kind: 'ws', id: WS } },
      { kind: 'text', text: ' and ' },
      { kind: 'ref', text: LEGACY_AGENT_REF, ref: { kind: 'agent', id: AGENT } },
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
  })

  test('turn web-app links into farm references', () => {
    expect(refFromUrl(`https://acme.ficus.sh/squads/${SQUAD}/work?ws=${WS}`)).toEqual({ kind: 'ws', id: WS })
    expect(refFromUrl(`https://acme.ficus.sh/app/squads/${SQUAD}`)).toEqual({ kind: 'squad', id: SQUAD })
    expect(refFromUrl(`https://acme.ficus.sh/chat/${AGENT}`)).toEqual({ kind: 'agent', id: AGENT })
    expect(refFromUrl('https://acme.ficus.sh/settings')).toBeNull()
    const link = `https://acme.ficus.sh/chat/${AGENT}`
    expect(tokenize(link, [])).toEqual([{ kind: 'ref', text: link, ref: { kind: 'agent', id: AGENT }, href: link }])
  })

  test('become plain text for a speech bubble', () => {
    expect(bubbleText(`ship ficus:ws:${WS} today, see https://example.com`)).toBe('ship 🔗 today, see 🔗')
  })
})
