import type { GrantPolicy, GrantPolicyReadScope, GrantPolicyWriteScope, MemorySourceType } from '@ficus/shared'
import { MEMORY_SOURCE_TYPE_LABELS } from '@ficus/shared'

interface Props {
  policy: GrantPolicy
}

function formatSourceTypes(sourceTypes: string[] | undefined): string {
  if (!sourceTypes?.length) return 'any'
  return sourceTypes
    .map((sourceType) => MEMORY_SOURCE_TYPE_LABELS[sourceType as MemorySourceType] ?? sourceType)
    .join(', ')
}

function ScopeRow({
  label,
  scope,
}: {
  label: string
  scope: GrantPolicyReadScope | GrantPolicyWriteScope | undefined
}) {
  if (!scope) {
    return (
      <div className="text-xs text-muted italic">
        {label}: <span>not granted</span>
      </div>
    )
  }

  const sensitivity = 'sensitivity' in scope ? scope.sensitivity : undefined

  return (
    <div className="text-xs text-secondary space-y-0.5">
      <div className="font-medium text-primary">{label}</div>
      <div>
        <span className="text-muted">source types:</span> {formatSourceTypes(scope.sourceTypes)}
      </div>
      <div>
        <span className="text-muted">paths:</span>{' '}
        {scope.paths && scope.paths.length > 0 ? <code className="text-[11px]">{scope.paths.join(', ')}</code> : 'any'}
      </div>
      {sensitivity && (
        <div>
          <span className="text-muted">max sensitivity:</span> {sensitivity}
        </div>
      )}
    </div>
  )
}

export function GrantPolicySummary({ policy }: Props) {
  return (
    <div className="space-y-2">
      <ScopeRow label="Read" scope={policy.read} />
      <ScopeRow label="Write" scope={policy.write} />
    </div>
  )
}
