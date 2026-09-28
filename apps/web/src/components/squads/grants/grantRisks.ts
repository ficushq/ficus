import type { GrantPolicy } from '@ficus/shared'

export type GrantRiskSeverity = 'low' | 'medium' | 'high'

export interface GrantRisk {
  code:
    | 'empty_policy'
    | 'read_no_path_filter'
    | 'read_no_source_type_filter'
    | 'read_high_sensitivity'
    | 'read_broad_path_glob'
    | 'write_no_path_filter'
    | 'write_no_source_type_filter'
    | 'write_broad_path_glob'
  severity: GrantRiskSeverity
  message: string
}

const BROAD_GLOBS = new Set(['/memory/**', '/memory', '**'])

function isBroadPath(path: string): boolean {
  return BROAD_GLOBS.has(path)
}

export function evaluateGrantRisks(policy: GrantPolicy): GrantRisk[] {
  const risks: GrantRisk[] = []

  if (!policy.read && !policy.write) {
    risks.push({
      code: 'empty_policy',
      severity: 'medium',
      message: 'Policy grants no read or write access — the grant is a no-op.',
    })
    return risks
  }

  if (policy.read) {
    if (!policy.read.paths || policy.read.paths.length === 0) {
      risks.push({
        code: 'read_no_path_filter',
        severity: 'high',
        message: 'Read scope has no path filter — the grantee can read every document in the source squad.',
      })
    } else if (policy.read.paths.some(isBroadPath)) {
      risks.push({
        code: 'read_broad_path_glob',
        severity: 'medium',
        message: 'Read scope uses a top-level glob (e.g. /memory/**) — consider narrowing.',
      })
    }

    if (!policy.read.sourceTypes || policy.read.sourceTypes.length === 0) {
      risks.push({
        code: 'read_no_source_type_filter',
        severity: 'medium',
        message: 'Read scope has no source-type filter — the grantee sees every indexed source.',
      })
    }

    if (policy.read.sensitivity === 'confidential') {
      risks.push({
        code: 'read_high_sensitivity',
        severity: 'high',
        message: 'Read scope allows confidential documents — confirm this is intentional.',
      })
    }
  }

  if (policy.write) {
    if (!policy.write.paths || policy.write.paths.length === 0) {
      risks.push({
        code: 'write_no_path_filter',
        severity: 'high',
        message: 'Write scope has no path filter — the grantee can write anywhere in the source squad.',
      })
    } else if (policy.write.paths.some(isBroadPath)) {
      risks.push({
        code: 'write_broad_path_glob',
        severity: 'high',
        message: 'Write scope uses a top-level glob — consider narrowing to a contributions path.',
      })
    }

    if (!policy.write.sourceTypes || policy.write.sourceTypes.length === 0) {
      risks.push({
        code: 'write_no_source_type_filter',
        severity: 'medium',
        message: 'Write scope has no source-type filter.',
      })
    }
  }

  return risks
}
