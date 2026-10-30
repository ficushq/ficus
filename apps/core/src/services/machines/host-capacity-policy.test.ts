import { describe, expect, test } from 'bun:test'
import { evaluateHostCapacity, hostStartupLimit, withHostStartupCapacity } from './host-capacity-policy'

describe('shared host admission', () => {
  test('many squads and private agents can share a host regardless of summed CPU ceilings', () => {
    for (const cpus of [1, 2, 8, 16, 32]) {
      const active = Array.from({ length: 20 }, (_, i) => `squad_${i}`)
      expect(evaluateHostCapacity(cpus, active, ['squad_new', 'agent_new'])).toMatchObject({
        allowed: true,
        activeBoxes: 20,
        projectedBoxes: 22,
      })
    }
  })

  test('deduplicates shared boxes and preserves logical demand during reconnects', () => {
    expect(evaluateHostCapacity(8, ['squad_a', 'agent_a', 'squad_a'], ['squad_a', 'agent_b', 'agent_b'])).toMatchObject(
      {
        allowed: true,
        activeBoxes: 2,
        projectedBoxes: 3,
      }
    )
    expect(evaluateHostCapacity(8, ['squad_a', 'agent_a'], ['agent_a'])).toMatchObject({
      allowed: true,
      reason: 'already-accounted',
    })
  })

  test('unknown host CPU facts allow shared work but serialize startup conservatively', () => {
    for (const cpus of [undefined, 0, -1, NaN, Infinity, 2.5]) {
      const capacity = evaluateHostCapacity(cpus, [], ['agent_a'])
      expect(capacity).toMatchObject({ allowed: true, reason: 'unknown', startupLimit: 1 })
      expect(capacity.cpus).toBeUndefined()
      expect(withHostStartupCapacity(capacity, ['agent_b'], ['agent_a'])).toMatchObject({
        allowed: false,
        reason: 'starting',
      })
    }
  })

  test('bounds expensive physical startups independently of running work', () => {
    for (const cpus of [1, 2, 3, 4, 8, 64]) {
      const capacity = evaluateHostCapacity(cpus, [], ['agent_a'])
      const limit = hostStartupLimit(cpus)
      expect(limit).toBe(cpus < 4 ? 1 : 2)
      const starting = Array.from({ length: limit }, (_, i) => `agent_${i}`)
      expect(withHostStartupCapacity(capacity, starting, ['agent_next']).allowed).toBe(false)
      expect(withHostStartupCapacity(capacity, starting.slice(1), ['agent_next']).allowed).toBe(true)
      expect(withHostStartupCapacity(capacity, starting, [starting[0]!]).allowed).toBe(true)
    }
  })
})
