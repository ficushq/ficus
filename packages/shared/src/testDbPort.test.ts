import { describe, test, expect } from 'bun:test'
import { findFreeTestDbPort, testDbPortFile, testDbProjectName } from './testDbPort'

describe('testDbProjectName', () => {
  test('is deterministic for the same repoRoot', () => {
    const root = '/repo/main'
    expect(testDbProjectName(root)).toBe(testDbProjectName(root))
  })

  test('two different worktree paths derive different project names', () => {
    const a = testDbProjectName('/repo/main/.claude/worktrees/agent-a')
    const b = testDbProjectName('/repo/main/.claude/worktrees/agent-b')
    expect(a).not.toBe(b)
  })

  test('is prefixed ficus-test- so it is recognizable as a test-db project', () => {
    expect(testDbProjectName('/repo/main')).toMatch(/^ficus-test-[0-9a-f]{8}$/)
  })
})

describe('testDbPortFile', () => {
  test('lives inside the given repoRoot', () => {
    expect(testDbPortFile('/repo/main')).toBe('/repo/main/.test-db-port')
  })

  test('two different worktree paths derive different port-file paths', () => {
    const a = testDbPortFile('/repo/main/.claude/worktrees/agent-a')
    const b = testDbPortFile('/repo/main/.claude/worktrees/agent-b')
    expect(a).not.toBe(b)
  })
})

describe('findFreeTestDbPort', () => {
  test('returns a valid, non-production port', () => {
    const port = findFreeTestDbPort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).not.toBe(5432)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })

  test('successive calls can allocate distinct ports (no hardcoded fallback)', () => {
    const ports = new Set(Array.from({ length: 5 }, () => findFreeTestDbPort()))
    // Not strictly guaranteed distinct under OS port reuse, but with 5 draws
    // in a tight loop it always is in practice — this guards against a
    // regression to a single hardcoded port.
    expect(ports.size).toBeGreaterThan(1)
  })
})
