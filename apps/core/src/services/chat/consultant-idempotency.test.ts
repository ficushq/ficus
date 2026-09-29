import { describe, expect, it } from 'bun:test'
import { consultantAgentId } from './consultant-idempotency'

const input = {
  actorUserId: '11111111-1111-4111-8111-111111111111',
  squadId: '22222222-2222-4222-8222-222222222222',
  clientId: 'mobile-draft-1',
}

describe('consultantAgentId', () => {
  it('derives the same valid UUID for the same actor, squad, and client ID', () => {
    const first = consultantAgentId(input)
    const second = consultantAgentId(input)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('pins the Ficus derivation label, so the identity only changes deliberately', () => {
    expect(consultantAgentId(input)).toBe('bdfeaf18-da3e-5371-b207-552d5a8afc44')
  })

  it('changes when any identity dimension changes', () => {
    const base = consultantAgentId(input)
    expect(consultantAgentId({ ...input, actorUserId: '33333333-3333-4333-8333-333333333333' })).not.toBe(base)
    expect(consultantAgentId({ ...input, squadId: '44444444-4444-4444-8444-444444444444' })).not.toBe(base)
    expect(consultantAgentId({ ...input, clientId: 'mobile-draft-2' })).not.toBe(base)
  })
})
