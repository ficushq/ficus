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

  test('unknown host CPU facts allow shared work and keep the floor of two startups', () => {
    for (const cpus of [undefined, 0, -1, NaN, Infinity, 2.5]) {
      const capacity = evaluateHostCapacity(cpus, [], ['agent_a'])
      expect(capacity).toMatchObject({ allowed: true, reason: 'unknown', startupLimit: 2 })
      expect(capacity.cpus).toBeUndefined()
      expect(withHostStartupCapacity(capacity, ['agent_b'], ['agent_a']).allowed).toBe(true)
      expect(withHostStartupCapacity(capacity, ['agent_b', 'agent_c'], ['agent_a'])).toMatchObject({
        allowed: false,
        reason: 'starting',
      })
    }
  })

  // 2026-10-30: two concurrent startups on an 8-CPU host queued a deploy's
  // re-provision wave for minutes. Startups are now mostly short (devbox in
  // seconds), so the limit scales with the host: half its CPUs, floor 2, cap 8.
  test('the startup limit is half the CPUs, at least two and at most eight', () => {
    expect([1, 2, 3, 4, 5, 8, 12, 16, 64].map(hostStartupLimit)).toEqual([2, 2, 2, 2, 2, 4, 6, 8, 8])
  })

  test('bounds expensive physical startups independently of running work', () => {
    for (const cpus of [1, 2, 3, 4, 8, 64]) {
      const capacity = evaluateHostCapacity(cpus, [], ['agent_a'])
      const limit = hostStartupLimit(cpus)
      const starting = Array.from({ length: limit }, (_, i) => `agent_${i}`)
      expect(withHostStartupCapacity(capacity, starting, ['agent_next']).allowed).toBe(false)
      expect(withHostStartupCapacity(capacity, starting.slice(1), ['agent_next']).allowed).toBe(true)
      expect(withHostStartupCapacity(capacity, starting, [starting[0]!]).allowed).toBe(true)
    }
  })

  // A queued turn waited minutes for a box while the slots went to background
  // warmups. Background starts (no waiting execution) never take the LAST free
  // slot; it stays for a box someone is waiting on.
  test('background startups leave the last free slot to a box with waiting work', () => {
    for (const cpus of [2, 8]) {
      const capacity = evaluateHostCapacity(cpus, [], ['agent_a'])
      const limit = hostStartupLimit(cpus)
      const almostFull = Array.from({ length: limit - 1 }, (_, i) => `squad_${i}`)
      expect(withHostStartupCapacity(capacity, almostFull, ['agent_bg'], { background: true })).toMatchObject({
        allowed: false,
        reason: 'starting',
      })
      expect(withHostStartupCapacity(capacity, almostFull, ['agent_waiting']).allowed).toBe(true)
      expect(withHostStartupCapacity(capacity, almostFull.slice(1), ['agent_bg'], { background: true }).allowed).toBe(
        true
      )
      // A background box already holding a slot keeps it across retries.
      expect(withHostStartupCapacity(capacity, almostFull, [almostFull[0]!], { background: true }).allowed).toBe(true)
    }
  })
})
