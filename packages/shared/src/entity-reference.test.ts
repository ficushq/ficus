import { expect, test } from 'bun:test'
import {
  ENTITY_REFERENCE_SCHEME,
  LEGACY_ENTITY_REFERENCE_SCHEME,
  entityReferenceHref,
  parseEntityReference,
} from './entity-reference'

test('references are written as ficus: links', () => {
  expect(ENTITY_REFERENCE_SCHEME).toBe('ficus')
  expect(entityReferenceHref('ws', '42')).toBe('ficus:ws:42')
  expect(entityReferenceHref('agent', 'deadbeef')).toBe('ficus:agent:deadbeef')
  expect(parseEntityReference('ficus:ws:42')).toEqual({ kind: 'ws', id: '42' })
  expect(parseEntityReference('FICUS:WS:42')).toEqual({ kind: 'ws', id: '42' })
  expect(parseEntityReference('ficus:agent:DEADBEEF')).toEqual({ kind: 'agent', id: 'deadbeef' })
})

test('links stored before the rename (chat messages, activity previews) still parse', () => {
  const legacy = (rest: string) => `${LEGACY_ENTITY_REFERENCE_SCHEME}:${rest}`
  expect(parseEntityReference(legacy('ws:241'))).toEqual({ kind: 'ws', id: '241' })
  expect(parseEntityReference(legacy('agent:deadbeef'))).toEqual({ kind: 'agent', id: 'deadbeef' })
  expect(parseEntityReference(legacy('ws:abc-def'))).toBeNull()
})

test('other schemes, kinds and malformed ids do not parse', () => {
  for (const href of [
    'other:ws:42',
    'ficus:other:42',
    'ficus:ws:abc-def',
    'ficusx:ws:42',
    'xficus:ws:42',
    'ficus:ws:42/x',
  ])
    expect(parseEntityReference(href)).toBeNull()
  expect(parseEntityReference(undefined)).toBeNull()
})
