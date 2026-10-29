import { describe, expect, test } from 'bun:test'
import { evaluateHostCapacity, boxCpuQuota } from './host-capacity-policy'

describe('machine-wide quota admission', () => {
  test('counts every box at its full unchanged CPU quota, including agents', () => {
    expect(boxCpuQuota(8)).toBe(4)
    expect(boxCpuQuota(3)).toBe(1.5)
    expect(boxCpuQuota(1)).toBe(1)
    expect(evaluateHostCapacity(8, ['squad_a', 'agent_a'], ['agent_b'])).toMatchObject({
      budgetCpus: 12,
      activeQuotaCpus: 8,
      projectedQuotaCpus: 12,
      allowed: true,
    })
    expect(evaluateHostCapacity(8, ['squad_a', 'agent_a', 'agent_b'], ['agent_c'])).toMatchObject({
      projectedQuotaCpus: 16,
      allowed: false,
      reason: 'quota',
    })
  })

  test('shared squad boxes and duplicate requests consume quota only once', () => {
    expect(evaluateHostCapacity(8, ['squad_a', 'agent_a', 'squad_a'], ['squad_a', 'agent_b', 'agent_b'])).toMatchObject(
      { activeQuotaCpus: 8, projectedQuotaCpus: 12, allowed: true }
    )
  })

  test('does not evict or block existing activity when a host is already oversubscribed', () => {
    const active = ['squad_a', 'agent_a', 'agent_b', 'agent_c']
    expect(evaluateHostCapacity(8, active, ['agent_b'])).toMatchObject({
      activeQuotaCpus: 16,
      allowed: true,
      reason: 'already-accounted',
    })
    expect(evaluateHostCapacity(8, active, ['agent_d']).allowed).toBe(false)
  })

  test('missing or invalid host CPU facts cannot silently grant capacity', () => {
    for (const cpus of [undefined, 0, -1, NaN, Infinity, 2.5]) {
      expect(evaluateHostCapacity(cpus, [], ['agent_a'])).toMatchObject({ allowed: false, reason: 'unknown' })
    }
  })

  test('a one-core host admits one box, not two minimum-one-core boxes', () => {
    expect(evaluateHostCapacity(1, [], ['agent_a']).allowed).toBe(true)
    expect(evaluateHostCapacity(1, ['agent_a'], ['agent_b']).allowed).toBe(false)
  })
})

test('an empty one-CPU host admits one minimal private-plus-shared owner set, but no further demand', () => {
  expect(evaluateHostCapacity(1, [], ['agent_a', 'squad_a'])).toMatchObject({
    allowed: true,
    budgetCpus: 1.5,
    projectedQuotaCpus: 2,
  })
  expect(evaluateHostCapacity(1, ['agent_a', 'squad_a'], ['agent_b']).allowed).toBe(false)
})

test('already-accounted demand survives temporarily missing host CPU facts', () => {
  expect(evaluateHostCapacity(undefined, ['agent_a'], ['agent_a'])).toMatchObject({ allowed: true, reason: 'unknown' })
  expect(evaluateHostCapacity(undefined, ['agent_a'], ['agent_b']).allowed).toBe(false)
})
