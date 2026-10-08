import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSquad } from '../../api/squads'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'
import { FormSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

function readPolicy(
  metadata: Record<string, unknown> | undefined,
  key: 'allowDirectMerge' | 'allowAutoMerge'
): boolean {
  const policies = (metadata?.policies as Record<string, unknown> | undefined) ?? {}
  return policies[key] === true
}

export function DirectMergePolicySettings({ squadId }: Props) {
  const queryClient = useQueryClient()
  const { data: squad, isLoading } = useQuery(queries.squads.basic(squadId))

  const [allowDirectMerge, setAllowDirectMerge] = useState(false)
  const [allowAutoMerge, setAllowAutoMerge] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (squad) {
      setAllowDirectMerge(readPolicy(squad.metadata, 'allowDirectMerge'))
      setAllowAutoMerge(readPolicy(squad.metadata, 'allowAutoMerge'))
      setDirty(false)
    }
  }, [squad])

  const mutation = useMutation({
    mutationFn: (value: { allowDirectMerge: boolean; allowAutoMerge: boolean }) =>
      // Squad.update deep-merges metadata, so passing only the policies subtree
      // is safe — other metadata keys (sandbox, memory, github, etc.) are
      // preserved.
      updateSquad(squadId, { metadata: { policies: value } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
      setDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const updateDirty = (nextDirect: boolean, nextAuto: boolean) => {
    setDirty(
      squad
        ? readPolicy(squad.metadata, 'allowDirectMerge') !== nextDirect ||
            readPolicy(squad.metadata, 'allowAutoMerge') !== nextAuto
        : nextDirect || nextAuto
    )
  }

  const handleDirectToggle = (value: boolean) => {
    setAllowDirectMerge(value)
    updateDirty(value, allowAutoMerge)
  }

  const handleAutoToggle = (value: boolean) => {
    setAllowAutoMerge(value)
    updateDirty(allowDirectMerge, value)
  }

  const handleSave = () => mutation.mutate({ allowDirectMerge, allowAutoMerge })

  if (isLoading) {
    return <FormSkeleton label="Loading policy settings" sections={2} />
  }

  return (
    <div>
      <div className="mb-3">
        <h3 data-setting-target="merge-policies" className="text-sm font-medium text-primary">
          Merge Policies
        </h3>
        <p className="text-xs text-muted mt-1">
          Control opt-in merge automation for this squad. Both policies default off unless explicitly enabled.
        </p>
      </div>

      <div className="space-y-3">
        <label className="rounded-lg hover:bg-surface-hover flex items-start gap-3 p-3">
          <input
            type="checkbox"
            checked={allowDirectMerge}
            onChange={(e) => handleDirectToggle(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-primary">Allow direct merge</span>
            <span className="block text-xs text-muted">
              When enabled, work streams created with <code>--completion-mode direct-merge</code> will merge and push
              automatically once the reviewer approves. When disabled, those work streams fall back to the standard PR
              flow.
            </span>
          </span>
        </label>

        <label className="rounded-lg hover:bg-surface-hover flex items-start gap-3 p-3">
          <input
            type="checkbox"
            checked={allowAutoMerge}
            onChange={(e) => handleAutoToggle(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-primary">Allow PR auto-merge</span>
            <span className="block text-xs text-muted">
              When enabled, reviewers may enable GitHub-native auto-merge for work streams created with{' '}
              <code>--completion-mode pr-auto-merge</code>. GitHub still enforces branch protection, required checks,
              and required approvals. When disabled, those work streams fall back to the standard human-merged PR flow.
            </span>
          </span>
        </label>
      </div>

      <div className="flex items-center justify-between mt-4">
        <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : saved ? '✓ Saved' : ''}</span>
        <button
          onClick={handleSave}
          disabled={!dirty || mutation.isPending}
          className={clsx(
            'ficus-button ficus-button-primary',
            'px-4 py-1.5 text-sm rounded-md font-medium transition-colors',
            !dirty && 'opacity-50 cursor-not-allowed'
          )}
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>

      {mutation.isError && (
        <p className="text-xs text-status-danger-500 mt-2">Failed to save: {String(mutation.error)}</p>
      )}
    </div>
  )
}
