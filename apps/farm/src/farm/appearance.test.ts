import { describe, expect, it } from 'bun:test'
import { hash, pick, roleFor } from './appearance'
import { makeAgent, makeSquad } from './testFixtures'

describe('hash and pick', () => {
  it('is FNV-1a 32-bit', () => {
    expect(hash('')).toBe(0x811c9dc5)
    expect(hash('a')).toBe(0xe40c292c)
    expect(hash('foobar')).toBe(0xbf9cf968)
  })

  it('picks stably and in range', () => {
    expect(pick(['a', 'b', 'c'], 4)).toBe('b')
    expect(pick(['a', 'b', 'c'], -1)).toBe(pick(['a', 'b', 'c'], 0xffffffff))
  })
})

describe('roleFor', () => {
  it('finds managers by type or by the squad pointer', () => {
    expect(roleFor(makeAgent({ agentTypeId: 'manager' }))).toBe('manager')
    expect(roleFor(makeAgent({ id: 'boss', agentTypeId: 'coder' }), makeSquad({ managerAgentId: 'boss' }))).toBe(
      'manager'
    )
    expect(roleFor(makeAgent({ agentTypeId: 'consultant' }))).toBe('consultant')
    expect(roleFor(makeAgent({ agentTypeId: 'coder' }), makeSquad({ managerAgentId: 'boss' }))).toBe('worker')
  })
})
