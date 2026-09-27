import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { useActionsApi } from './ActionsApiProvider'
import { refreshAfterPause } from './cache'
import { usePermissions } from './permissions'
import { ErrorNote, VerbButton } from './ui'

type PauseCommand = 'pause' | 'resume' | 'park'

/**
 * The cloche: pause a plot's work (optional reason, optional auto-park delay),
 * lift it (resume), or park it (release the slot while paused). Mirrors the
 * web's WorkStreamPauseControls, gated on `workstreams:update`.
 */
export function PauseControls({ stream }: { stream: WorkStream }) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const { can } = usePermissions(stream.squadId)
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const [minutes, setMinutes] = useState('')
  const fieldId = useId()
  const command = useMutation({
    mutationFn: (kind: PauseCommand) =>
      kind === 'pause'
        ? api.pauseWorkStream(stream.id, { reason, ...(minutes ? { parkAfterMinutes: Number(minutes) } : {}) })
        : kind === 'resume'
          ? api.resumeWorkStream(stream.id)
          : api.parkWorkStream(stream.id),
    onSuccess: async () => {
      setEditing(false)
      await refreshAfterPause(queryClient)
    },
  })
  if (stream.status === 'done' || stream.status === 'canceled') return null
  const busy = (kind: PauseCommand) => command.isPending && command.variables === kind

  return (
    <section className="g-action g-cloche" aria-label="Pause controls">
      {stream.pause && (
        <p className="g-action-note">
          Under the cloche (paused) · {stream.status === 'queued' ? 'Parked; no slot held' : 'Holding its slot'}
          {stream.pause.reason ? ` · ${stream.pause.reason}` : ''}
          {stream.pause.parkAt && stream.status === 'active'
            ? ` · Parks itself at ${new Date(stream.pause.parkAt).toLocaleString()}`
            : ''}
        </p>
      )}
      {can('workstreams:update') && (
        <>
          <div className="g-action-row">
            {stream.pause ? (
              <>
                <VerbButton
                  verb="Lift the cloche"
                  busyVerb="Lifting…"
                  help="Resume work"
                  tone="primary"
                  busy={busy('resume')}
                  disabled={command.isPending}
                  onClick={() => command.mutate('resume')}
                />
                {stream.status === 'active' && (
                  <VerbButton
                    verb="Park"
                    busyVerb="Parking…"
                    help="Release the slot while paused"
                    busy={busy('park')}
                    disabled={command.isPending}
                    onClick={() => command.mutate('park')}
                  />
                )}
              </>
            ) : (
              <VerbButton
                verb={editing ? 'Keep growing' : 'Cover with cloche'}
                help={editing ? 'Close without pausing' : 'Pause work'}
                tone={editing ? 'quiet' : 'plain'}
                onClick={() => setEditing(!editing)}
              />
            )}
          </div>
          {editing && !stream.pause && (
            <form
              className="g-action"
              onSubmit={(event) => {
                event.preventDefault()
                command.mutate('pause')
              }}
            >
              <p className="g-action-note">
                Stops the robots on this plot until you lift the cloche. It keeps its slot, or can release it after a
                delay.
              </p>
              <label className="g-field" htmlFor={`${fieldId}-reason`}>
                Reason (optional)
              </label>
              <input
                id={`${fieldId}-reason`}
                className="g-input"
                value={reason}
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
              />
              <label className="g-field" htmlFor={`${fieldId}-minutes`}>
                Park after minutes (optional)
              </label>
              <input
                id={`${fieldId}-minutes`}
                className="g-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={10080}
                placeholder="Keep the slot until I park it"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
              <div className="g-action-row">
                <VerbButton
                  type="submit"
                  verb="Pause now"
                  busyVerb="Pausing…"
                  help="Stop work until resumed"
                  tone="primary"
                  busy={busy('pause')}
                  disabled={command.isPending}
                />
              </div>
            </form>
          )}
        </>
      )}
      <ErrorNote error={command.error} />
    </section>
  )
}
