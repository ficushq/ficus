import { describe, it, expect } from 'bun:test'
import { evaluateGrantRisks } from './grantRisks'
import type { GrantPolicy } from '@ficus/shared'

describe('evaluateGrantRisks', () => {
  it('returns no risks for a tightly scoped grant', () => {
    const policy: GrantPolicy = {
      read: { sourceTypes: ['memory_file'], paths: ['/memory/company/policies/**'], sensitivity: 'internal' },
    }
    expect(evaluateGrantRisks(policy)).toEqual([])
  })

  it('warns when no read or write policy is set', () => {
    const risks = evaluateGrantRisks({})
    expect(risks.map((r) => r.code)).toContain('empty_policy')
  })

  it('warns when read paths are missing (unbounded path scope)', () => {
    const risks = evaluateGrantRisks({ read: { sourceTypes: ['memory_file'] } })
    expect(risks.map((r) => r.code)).toContain('read_no_path_filter')
    expect(risks.find((r) => r.code === 'read_no_path_filter')?.severity).toBe('high')
  })

  it('warns when read sourceTypes are missing', () => {
    const risks = evaluateGrantRisks({ read: { paths: ['/memory/**'] } })
    expect(risks.map((r) => r.code)).toContain('read_no_source_type_filter')
  })

  it('warns when read sensitivity ceiling is confidential', () => {
    const risks = evaluateGrantRisks({
      read: { sourceTypes: ['memory_file'], paths: ['/memory/**'], sensitivity: 'confidential' },
    })
    expect(risks.map((r) => r.code)).toContain('read_high_sensitivity')
  })

  it('warns when read paths include broad globs like /memory/**', () => {
    const risks = evaluateGrantRisks({ read: { sourceTypes: ['memory_file'], paths: ['/memory/**'] } })
    expect(risks.map((r) => r.code)).toContain('read_broad_path_glob')
  })

  it('warns when write paths are missing', () => {
    const risks = evaluateGrantRisks({ write: { sourceTypes: ['memory_file'] } })
    expect(risks.map((r) => r.code)).toContain('write_no_path_filter')
  })

  it('warns when write paths include broad globs', () => {
    const risks = evaluateGrantRisks({ write: { sourceTypes: ['memory_file'], paths: ['/memory/**'] } })
    expect(risks.map((r) => r.code)).toContain('write_broad_path_glob')
  })
})
