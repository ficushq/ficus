import { expect, test } from 'bun:test'
import { resolveVoiceSquadId, squadReferenceFromPath } from './squadReferences'

test('voice uses router collision ordering and rejects ambiguous ID prefixes', () => {
  const squads = [
    { id: '11111111-second', name: 'Ficus', createdAt: '2026-02-01' },
    { id: '11111111-first', name: 'Ficus', createdAt: '2026-01-01' },
  ]
  expect(resolveVoiceSquadId('ficus', squads)).toBe('11111111-first')
  expect(resolveVoiceSquadId('ficus-2', squads)).toBe('11111111-second')
  expect(resolveVoiceSquadId('11111111', squads)).toBeUndefined()
  expect(resolveVoiceSquadId('11111111-second', squads)).toBe('11111111-second')
  expect(squadReferenceFromPath('/squads/ficus-2/home?agent=x')).toBe('ficus-2')
  expect(squadReferenceFromPath('/squads/%')).toBeUndefined()
})
