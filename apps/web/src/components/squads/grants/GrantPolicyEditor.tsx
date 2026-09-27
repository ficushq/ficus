import { useMemo } from 'react'
import type { GrantPolicy, SensitivityTier } from '@ficus/shared'
import { MEMORY_SOURCE_TYPE_METADATA, SENSITIVITY_TIERS } from '@ficus/shared'
import { evaluateGrantRisks } from './grantRisks'
import { GrantRiskBadge } from './GrantRiskBadge'

interface Props {
  policy: GrantPolicy
  onChange: (policy: GrantPolicy) => void
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function GrantPolicyEditor({ policy, onChange }: Props) {
  const risks = useMemo(() => evaluateGrantRisks(policy), [policy])

  const updateRead = (patch: Partial<NonNullable<GrantPolicy['read']>>) => {
    onChange({ ...policy, read: { ...(policy.read ?? {}), ...patch } })
  }
  const updateWrite = (patch: Partial<NonNullable<GrantPolicy['write']>>) => {
    onChange({ ...policy, write: { ...(policy.write ?? {}), ...patch } })
  }

  const toggleReadSourceType = (sourceType: string) => {
    const current = new Set(policy.read?.sourceTypes ?? [])
    if (current.has(sourceType)) current.delete(sourceType)
    else current.add(sourceType)
    updateRead({ sourceTypes: Array.from(current) })
  }

  const toggleWriteSourceType = (sourceType: string) => {
    const current = new Set(policy.write?.sourceTypes ?? [])
    if (current.has(sourceType)) current.delete(sourceType)
    else current.add(sourceType)
    updateWrite({ sourceTypes: Array.from(current) })
  }

  return (
    <div className="space-y-4">
      <section className="border border-th-border rounded-lg p-4 bg-surface">
        <label className="flex items-center gap-2 mb-3">
          <input
            type="checkbox"
            checked={!!policy.read}
            onChange={(event) => onChange({ ...policy, read: event.target.checked ? (policy.read ?? {}) : undefined })}
          />
          <span className="font-medium text-primary">Grant read</span>
        </label>
        {!!policy.read && (
          <div className="space-y-3 pl-6">
            <div>
              <div className="text-xs font-medium text-secondary mb-1">Source types</div>
              <div className="flex gap-3 flex-wrap">
                {MEMORY_SOURCE_TYPE_METADATA.map((sourceType) => (
                  <label key={sourceType.value} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={policy.read?.sourceTypes?.includes(sourceType.value) ?? false}
                      onChange={() => toggleReadSourceType(sourceType.value)}
                    />
                    {sourceType.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Paths (one per line)</label>
              <textarea
                value={(policy.read.paths ?? []).join('\n')}
                onChange={(event) => updateRead({ paths: splitLines(event.target.value) })}
                rows={3}
                placeholder="/memory/company/**"
                className="ficus-field w-full px-2 py-1 text-xs font-mono border border-th-border bg-surface text-primary rounded"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Max sensitivity</label>
              <select
                value={policy.read.sensitivity ?? ''}
                onChange={(event) =>
                  updateRead({ sensitivity: (event.target.value || undefined) as SensitivityTier | undefined })
                }
                className="ficus-field px-2 py-1 text-xs border border-th-border bg-surface text-primary rounded"
              >
                <option value="">unrestricted</option>
                {SENSITIVITY_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </section>

      <section className="border border-th-border rounded-lg p-4 bg-surface">
        <label className="flex items-center gap-2 mb-3">
          <input
            type="checkbox"
            checked={!!policy.write}
            onChange={(event) =>
              onChange({ ...policy, write: event.target.checked ? (policy.write ?? {}) : undefined })
            }
          />
          <span className="font-medium text-primary">Grant write</span>
        </label>
        {!!policy.write && (
          <div className="space-y-3 pl-6">
            <div>
              <div className="text-xs font-medium text-secondary mb-1">Source types</div>
              <div className="flex gap-3 flex-wrap">
                {MEMORY_SOURCE_TYPE_METADATA.map((sourceType) => (
                  <label key={sourceType.value} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={policy.write?.sourceTypes?.includes(sourceType.value) ?? false}
                      onChange={() => toggleWriteSourceType(sourceType.value)}
                    />
                    {sourceType.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Paths (one per line)</label>
              <textarea
                value={(policy.write.paths ?? []).join('\n')}
                onChange={(event) => updateWrite({ paths: splitLines(event.target.value) })}
                rows={3}
                placeholder="/memory/contributions/**"
                className="ficus-field w-full px-2 py-1 text-xs font-mono border border-th-border bg-surface text-primary rounded"
              />
            </div>
          </div>
        )}
      </section>

      <GrantRiskBadge risks={risks} />
    </div>
  )
}
