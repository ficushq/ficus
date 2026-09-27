import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { client } from '../api/clientInstance'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'

export function WorkStreamPauseControls({ stream }: { stream: WorkStream }) {
  const { can } = usePermissions(stream.squadId)
  const cache = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const [minutes, setMinutes] = useState('')
  const action = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'park') =>
      action === 'pause'
        ? client.workStreams.pause(stream.id, { reason, ...(minutes ? { parkAfterMinutes: Number(minutes) } : {}) })
        : client.workStreams[action](stream.id),
    onSuccess: () => {
      setEditing(false)
      cache.invalidateQueries({ queryKey: queryKeys.squads.all })
      cache.invalidateQueries({ queryKey: queryKeys.workflows.all })
      cache.invalidateQueries({ queryKey: queryKeys.agents.all })
    },
  })
  if (['done', 'canceled'].includes(stream.status)) return null
  return (
    <section className="space-y-2">
      {stream.pause && (
        <p className="text-sm text-secondary">
          Paused · {stream.status === 'queued' ? 'Parked; no slot held' : 'Holding its slot'}
          {stream.pause.reason ? ` · ${stream.pause.reason}` : ''}
          {stream.pause.parkAt && stream.status === 'active'
            ? ` · Auto-park at ${new Date(stream.pause.parkAt).toLocaleString()}`
            : ''}
        </p>
      )}
      {can('workstreams:update') && (
        <>
          <div className="flex gap-3">
            {stream.pause ? (
              <>
                <button
                  type="button"
                  className="ficus-button rounded-md px-3 py-1.5 text-xs font-medium text-accent"
                  disabled={action.isPending}
                  onClick={() => action.mutate('resume')}
                >
                  Resume work
                </button>
                {stream.status === 'active' && (
                  <button
                    type="button"
                    className="ficus-button rounded-md px-3 py-1.5 text-xs font-medium text-secondary"
                    disabled={action.isPending}
                    onClick={() => action.mutate('park')}
                  >
                    Park while paused
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="ficus-button rounded-md border border-th-border px-3 py-1.5 text-xs font-medium text-secondary"
                onClick={() => setEditing(!editing)}
              >
                Pause work
              </button>
            )}
          </div>
          {editing && !stream.pause && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                action.mutate('pause')
              }}
            >
              <p className="text-xs text-secondary">
                Stop assigned agents and wait for explicit resume. Keep the slot, or optionally release it after a
                delay.
              </p>
              <label className="block text-sm">
                Reason
                <input
                  className="ficus-field w-full p-2 border border-th-border rounded-md"
                  value={reason}
                  maxLength={2000}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <label className="block text-sm">
                Auto-park after minutes (optional)
                <input
                  className="ficus-field w-full p-2 border border-th-border rounded-md"
                  type="number"
                  min={1}
                  max={10080}
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                  placeholder="Keep the slot until I park it"
                />
              </label>
              <button
                type="submit"
                className="ficus-button rounded-md px-3 py-1.5 text-xs font-medium text-accent"
                disabled={action.isPending}
              >
                Pause now
              </button>
            </form>
          )}
        </>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-status-danger-400">
          {action.error.message}
        </p>
      )}
    </section>
  )
}
