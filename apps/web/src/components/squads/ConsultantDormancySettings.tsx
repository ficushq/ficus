import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS, updateSquadSchema } from '@ficus/shared'
import { updateSquad } from '../../api/squads'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'

interface Props {
  squadId: string
  /** Saved threshold in days (every squad starts at the default); null = turned off. */
  consultantIdleDormancyDays: number | null
}

function daysError(value: number | null): string | null {
  const parsed = updateSquadSchema.safeParse({ consultantIdleDormancyDays: value })
  return parsed.success ? null : 'Enter a whole number of days from 1 to 3650.'
}

/** Squad Settings → Workspace: make consultants dormant after a period without messages. */
export function ConsultantDormancySettings({ squadId, consultantIdleDormancyDays }: Props) {
  const [enabled, setEnabled] = useState(consultantIdleDormancyDays !== null)
  const [raw, setRaw] = useState(String(consultantIdleDormancyDays ?? DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS))
  const [saved, setSaved] = useState(false)
  const { can, isLoading } = usePermissions(squadId)
  const canUpdate = !isLoading && can('squads:update')
  const queryClient = useQueryClient()

  useEffect(() => {
    setEnabled(consultantIdleDormancyDays !== null)
    setRaw(String(consultantIdleDormancyDays ?? DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS))
  }, [consultantIdleDormancyDays])

  const value = enabled ? (raw.trim() === '' ? Number.NaN : Number(raw)) : null
  const error = value === null ? null : daysError(value)
  const dirty = value !== consultantIdleDormancyDays

  const mutation = useMutation({
    mutationFn: (days: number | null) => updateSquad(squadId, { consultantIdleDormancyDays: days }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
      setSaved(true)
    },
  })

  return (
    <section aria-labelledby="squad-consultant-idle-dormancy-heading">
      <div className="mb-4">
        <h3 id="squad-consultant-idle-dormancy-heading" className="text-sm font-medium text-primary">
          Idle consultants
        </h3>
        <p className="mt-1 text-xs text-muted">
          Ficus makes consultant conversations dormant once they have been idle for a while (
          {DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS} days by default). Turn this off to keep them live until someone ends
          them.
        </p>
      </div>
      <label
        data-setting-target="consultant-idle-dormancy"
        className="flex items-start gap-3 rounded-lg p-3 hover:bg-surface-hover"
      >
        <input
          id="squad-consultant-idle-dormancy"
          type="checkbox"
          className="mt-1"
          checked={enabled}
          disabled={!canUpdate}
          onChange={(event) => {
            setSaved(false)
            setEnabled(event.target.checked)
            // Turning it on always starts from the default threshold.
            if (event.target.checked) setRaw(String(DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS))
          }}
        />
        <span>
          <span className="block text-sm font-medium text-primary">
            Make consultants dormant after they&apos;ve been idle
          </span>
          <span className="block text-xs text-muted">
            A consultant is idle when it has had no message for this many days, or was never messaged and was created
            that long ago. Dormant consultants keep their files and wake on a new message; they are removed after the
            instance&apos;s dormant retention period.
          </span>
        </span>
      </label>
      {enabled && (
        <div className="mt-2 pl-3">
          <label htmlFor="squad-consultant-idle-dormancy-days" className="mb-1 block text-sm font-medium text-primary">
            Idle days
          </label>
          <input
            id="squad-consultant-idle-dormancy-days"
            type="number"
            min={1}
            max={3650}
            step={1}
            value={raw}
            disabled={!canUpdate}
            aria-invalid={error !== null}
            onChange={(event) => {
              setSaved(false)
              setRaw(event.target.value)
            }}
            className={clsx(
              'ficus-field',
              'w-32 rounded-lg border bg-surface px-3 py-2 text-sm text-primary',
              'focus:border-accent focus:ring-2 focus:ring-accent/50',
              error ? 'border-status-danger-500' : 'border-th-border'
            )}
          />
          {error && <p className="mt-1 text-xs text-status-danger-500">{error}</p>}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : saved ? '✓ Saved' : ''}</span>
        <button
          type="button"
          onClick={() => mutation.mutate(value)}
          disabled={!dirty || error !== null || mutation.isPending || !canUpdate}
          className="ficus-button ficus-button-primary rounded-md px-4 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
      {mutation.isError && (
        <p className="mt-2 text-xs text-status-danger-500">Failed to save: {String(mutation.error)}</p>
      )}
    </section>
  )
}
