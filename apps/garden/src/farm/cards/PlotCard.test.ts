import { describe, expect, it } from 'bun:test'
import { crewFor } from './PlotCard'

const manager = (id: string) => id === 'mgr'
const stream = (o: Partial<Parameters<typeof crewFor>[0]>) => ({
  agentIds: ['w1'],
  assigneeAgentId: null,
  ownerAgentId: null,
  creatorAgentId: null,
  ...o,
})

describe('crewFor', () => {
  it('leaves out an owner or creator who is the squad manager', () => {
    expect(crewFor(stream({ ownerAgentId: 'mgr', creatorAgentId: 'mgr' }), manager)).toEqual({ ids: ['w1'], notes: {} })
  })

  it('labels an owner and a creator who are not the manager', () => {
    const crew = crewFor(stream({ ownerAgentId: 'c1', creatorAgentId: 'c2' }), manager)
    expect(crew.ids).toEqual(['w1', 'c1', 'c2'])
    expect(crew.notes).toEqual({ c1: 'Owner', c2: 'Creator' })
  })

  it('lists one agent that is both owner and creator once, with both labels', () => {
    const crew = crewFor(stream({ ownerAgentId: 'c1', creatorAgentId: 'c1' }), manager)
    expect(crew.ids).toEqual(['w1', 'c1'])
    expect(crew.notes).toEqual({ c1: 'Owner · creator' })
  })

  it('labels a worker who also owns the stream without listing it twice', () => {
    const crew = crewFor(stream({ ownerAgentId: 'w1' }), manager)
    expect(crew.ids).toEqual(['w1'])
    expect(crew.notes).toEqual({ w1: 'Owner' })
  })
})
